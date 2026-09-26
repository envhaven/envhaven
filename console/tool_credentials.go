package main

// Tool and Environment credential HTTP orchestration. Durable state changes run
// inside the explicit transaction supplied by credential_store.go; vendor file
// and CLI cleanup lives in tool_credential_cleanup.go.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

const toolCommandTimeout = 10 * time.Second

type toolMutationRequest struct {
	Action string `json:"action"`
	ToolID string `json:"toolId"`
	EnvVar string `json:"envVar"`
	Key    string `json:"key"`
}

type toolMutationResponse struct {
	OK          bool   `json:"ok"`
	Instruction string `json:"instruction,omitempty"`
}

type toolAuthConflict struct {
	Source        string   `json:"source"`
	EnvVar        string   `json:"envVar"`
	AffectedTools []string `json:"affectedTools"`
}

type toolMutationConflictResponse struct {
	Error       string             `json:"error"`
	Instruction string             `json:"instruction"`
	Conflicts   []toolAuthConflict `json:"conflicts"`
}

func handleToolMutation(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxActionBody)
	var request toolMutationRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid body")
		return
	}
	catalog, err := loadCatalog()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "tool definitions unavailable")
		return
	}
	var tool *toolDef
	for i := range catalog.Tools {
		if catalog.Tools[i].ID == request.ToolID {
			tool = &catalog.Tools[i]
			break
		}
	}
	if tool == nil {
		writeAPIError(w, http.StatusBadRequest, "unknown tool")
		return
	}

	switch request.Action {
	case "set-key":
		if !toolDeclaresEnvVar(tool, request.EnvVar) {
			writeAPIError(w, http.StatusBadRequest, "unknown env var for tool")
			return
		}
		key, ok := cleanCredentialValue(request.Key)
		if !ok {
			writeAPIError(w, http.StatusBadRequest, "invalid key")
			return
		}
		if err := setToolCredential(r.Context(), homeDir(), tool, request.EnvVar, key); err != nil {
			writeAPIError(w, http.StatusInternalServerError, credentialErrorMessage(err, "tool credential setup failed"))
			return
		}
		invalidateAuthProbe(tool.ID)
		writeOK(w)

	case "sign-out":
		instruction, conflicts, err := signOutTool(r.Context(), homeDir(), tool, catalog.Tools)
		if len(conflicts) > 0 {
			message := signOutConflictInstruction(conflicts)
			writeJSON(w, http.StatusConflict, toolMutationConflictResponse{
				Error: message, Instruction: message, Conflicts: conflicts,
			})
			return
		}
		if err != nil {
			if instruction != "" {
				writeJSON(w, http.StatusInternalServerError, map[string]string{
					"error": "tool sign-out incomplete", "instruction": instruction,
				})
			} else {
				writeAPIError(w, http.StatusInternalServerError, credentialErrorMessage(err, "tool sign-out failed"))
			}
			return
		}
		invalidateAuthProbe(tool.ID)
		writeJSON(w, http.StatusOK, toolMutationResponse{OK: true, Instruction: instruction})

	default:
		writeAPIError(w, http.StatusBadRequest, "unknown action")
	}
}

func toolDeclaresEnvVar(tool *toolDef, envVar string) bool {
	for _, declared := range tool.EnvVars {
		if declared == envVar {
			return true
		}
	}
	return false
}

func toolUsesEnvVar(tool *toolDef, envVar string) bool {
	if toolDeclaresEnvVar(tool, envVar) {
		return true
	}
	for _, declared := range tool.AuthEnvVars {
		if declared == envVar {
			return true
		}
	}
	return false
}

func setToolCredential(ctx context.Context, home string, tool *toolDef, name, value string) error {
	return credentialStoreState.transaction(home, func(tx *credentialTransaction) error {
		before, err := snapshotOptionalFile(credentialStorePath(home))
		if err != nil {
			return err
		}
		if err := tx.set(name, value); err != nil {
			return err
		}
		if len(tool.SetKeyCommand) == 0 {
			return nil
		}
		output, commandErr := runBoundedArgv(ctx, toolCommandTimeout, tool.SetKeyCommand, value, nil)
		if commandErr == nil {
			return nil
		}
		rollbackErr := restoreFileSnapshot(before)
		if rollbackErr != nil {
			return fmt.Errorf("%s failed and credential rollback failed: %v: %w", tool.SetKeyCommand[0], rollbackErr, commandErr)
		}
		return fmt.Errorf("%s failed: %w: %s", tool.SetKeyCommand[0], commandErr, strings.TrimSpace(string(output)))
	})
}

// signOutTool keeps conflict detection, vendor logout, and local cleanup in one
// store transaction. Direct vendor logout completes before local cleanup;
// interactive logout opens its exact tmux window before cleanup.
func signOutTool(ctx context.Context, home string, tool *toolDef, tools []toolDef) (instruction string, conflicts []toolAuthConflict, resultErr error) {
	err := credentialStoreState.transaction(home, func(tx *credentialTransaction) error {
		envVars, err := toolCredentialEnvVars(home, tool)
		if err != nil {
			return err
		}
		conflicts, err = signOutConflicts(tx, tool, tools, envVars)
		if err != nil || len(conflicts) > 0 {
			return err
		}

		directLogout := len(tool.LogoutCommand) > 0 && tool.LogoutInstruction == ""
		interactiveLogout := len(tool.LogoutCommand) > 0 && tool.LogoutInstruction != ""
		if directLogout {
			output, commandErr := runBoundedArgv(ctx, toolCommandTimeout, tool.LogoutCommand, "", nil)
			if commandErr != nil {
				return fmt.Errorf("%s failed: %w: %s", tool.LogoutCommand[0], commandErr, strings.TrimSpace(string(output)))
			}
			invalidateAuthProbe(tool.ID)
		}
		if interactiveLogout {
			if err := openCommandWindow(ctx, strings.Join(tool.LogoutCommand, " ")); err != nil {
				return err
			}
			invalidateAuthProbe(tool.ID)
		}

		cleanupInstruction, cleanupErr := cleanupToolCredentials(ctx, tx, tool, envVars)
		if cleanupErr != nil {
			switch {
			case directLogout:
				instruction = "Vendor logout completed, but managed credential cleanup did not finish. Retry sign-out."
			case interactiveLogout:
				instruction = "The logout session opened, but managed credential cleanup did not finish. Finish the vendor logout, then retry sign-out."
			default:
				instruction = "Managed credential cleanup did not finish. Retry sign-out."
			}
			return cleanupErr
		}
		if cleanupInstruction != "" {
			instruction = cleanupInstruction
		} else {
			instruction = tool.LogoutInstruction
		}
		return nil
	})
	return instruction, conflicts, err
}

func signOutConflicts(tx *credentialTransaction, tool *toolDef, tools []toolDef, envVars []string) ([]toolAuthConflict, error) {
	sources, err := tx.readCredentialSources()
	if err != nil {
		return nil, err
	}
	var conflicts []toolAuthConflict
	for _, name := range envVars {
		affected := toolsUsingEnvVar(tools, name)
		if !containsString(affected, tool.Name) {
			affected = append(affected, tool.Name)
		}
		if os.Getenv(name) != "" {
			conflicts = append(conflicts, toolAuthConflict{Source: authSourceProcessEnv, EnvVar: name, AffectedTools: affected})
		}
		if sources[name].manual {
			conflicts = append(conflicts, toolAuthConflict{Source: authSourceManualRC, EnvVar: name, AffectedTools: affected})
		}
		if sources[name].managed && len(affected) > 1 {
			conflicts = append(conflicts, toolAuthConflict{Source: authSourceManagedRC, EnvVar: name, AffectedTools: affected})
		}
	}
	return conflicts, nil
}

func toolCredentialEnvVars(home string, tool *toolDef) ([]string, error) {
	envVars := append(append([]string{}, tool.EnvVars...), tool.AuthEnvVars...)
	if tool.AuthCheck != "qwen" {
		return envVars, nil
	}
	path, ok, err := mutableHomeFile(home, ".qwen/settings.json")
	if err != nil || !ok {
		return envVars, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return envVars, err
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return envVars, fmt.Errorf("invalid Qwen settings: %w", err)
	}
	if qwenSelectedAuthType(settings) == "" {
		return nil, nil
	}
	selection, ok := qwenSelectedCredential(settings)
	if !ok {
		return nil, errors.New("cannot resolve Qwen credential for the selected provider and model")
	}
	return []string{selection.envKey}, nil
}

func toolsUsingEnvVar(tools []toolDef, name string) []string {
	var names []string
	for i := range tools {
		if toolUsesEnvVar(&tools[i], name) {
			names = append(names, tools[i].Name)
		}
	}
	return names
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func signOutConflictInstruction(conflicts []toolAuthConflict) string {
	parts := make([]string, 0, len(conflicts))
	for _, conflict := range conflicts {
		var part string
		switch conflict.Source {
		case authSourceProcessEnv:
			part = conflict.EnvVar + " is set by the workspace process environment. Remove it from the workspace configuration and restart the workspace."
		case authSourceManualRC:
			part = conflict.EnvVar + " is manually exported in .zshrc or .bashrc. Remove that export manually."
		case authSourceManagedRC:
			part = conflict.EnvVar + " is managed by EnvHaven and shared by " + strings.Join(conflict.AffectedTools, ", ") + ". Remove it from Environment to disconnect those tools."
		}
		if conflict.Source != authSourceManagedRC && len(conflict.AffectedTools) > 1 {
			part += " It affects " + strings.Join(conflict.AffectedTools, ", ") + "."
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, " ")
}

func setEnvironmentCredential(home, name, value string) error {
	return credentialStoreState.transaction(home, func(tx *credentialTransaction) error {
		return tx.set(name, value)
	})
}

// deleteEnvironmentCredential removes the managed value and its owned vendor
// state under one store transaction. Cleanup runs first so a cleanup failure
// leaves a still-usable key; a later launcher repairs provider mode if the final
// atomic store write fails.
func deleteEnvironmentCredential(home, name string) error {
	return credentialStoreState.transaction(home, func(tx *credentialTransaction) error {
		if name == "GEMINI_API_KEY" && os.Getenv(name) == "" {
			sources, err := tx.readCredentialSources()
			if err != nil {
				return err
			}
			source := sources[name]
			if source.managed && !source.manual {
				if err := removeAntigravityProvider(home); err != nil {
					return err
				}
			}
		}
		return tx.remove([]string{name})
	})
}

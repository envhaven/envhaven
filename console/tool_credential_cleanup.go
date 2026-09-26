package main

// Vendor-specific credential cleanup. The caller owns the explicit store
// transaction and passes it here; this layer never acquires a shared lock.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

const (
	antigravityProviderMarkerRel = ".gemini/antigravity-cli/.model-provider.envhaven"
	antigravitySettingsRel       = ".gemini/antigravity-cli/settings.json"
)

func cleanupToolCredentials(ctx context.Context, tx *credentialTransaction, tool *toolDef, envVars []string) (string, error) {
	instruction := ""
	if tool.AuthCheck == "openclaw" {
		var err error
		instruction, err = signOutOpenClaw(ctx, tx.home)
		if err != nil {
			return "", err
		}
	}
	if err := tx.remove(envVars); err != nil {
		return "", err
	}
	for _, rel := range tool.AuthFiles {
		path, ok, err := safeRegularHomeFile(tx.home, rel)
		if err != nil {
			return "", err
		}
		if ok {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return "", err
			}
		}
	}
	if tool.AuthCheck == "qwen" {
		return "", removeQwenCredentials(tx.home, envVars)
	}
	if tool.ID == "antigravity" {
		return "", removeAntigravityProvider(tx.home)
	}
	return instruction, nil
}

type openClawAuthListPayload struct {
	AgentID  string `json:"agentId"`
	Profiles []struct {
		ID string `json:"id"`
	} `json:"profiles"`
}

func signOutOpenClaw(ctx context.Context, home string) (string, error) {
	result, err := runBoundedArgvCapture(
		ctx,
		toolCommandTimeout,
		[]string{"openclaw", "models", "auth", "list", "--json"},
		"",
		environmentWithHome(home),
	)
	if err != nil {
		return "", fmt.Errorf("openclaw auth list failed: %w: %s", err, strings.TrimSpace(string(result.stderr)))
	}
	var auth openClawAuthListPayload
	if err := json.Unmarshal(result.stdout, &auth); err != nil {
		return "", fmt.Errorf("invalid OpenClaw auth-list JSON: %w", err)
	}
	seen := map[string]bool{}
	for _, profile := range auth.Profiles {
		if profile.ID == "" || seen[profile.ID] {
			continue
		}
		seen[profile.ID] = true
		argv := []string{"openclaw", "models", "auth"}
		if auth.AgentID != "" {
			argv = append(argv, "--agent", auth.AgentID)
		}
		argv = append(argv, "logout", profile.ID, "--yes")
		logout, err := runBoundedArgvCapture(ctx, toolCommandTimeout, argv, "", environmentWithHome(home))
		if err != nil {
			return "", fmt.Errorf("openclaw profile logout failed: %w: %s", err, strings.TrimSpace(string(logout.stderr)))
		}
		invalidateAuthProbe("openclaw")
	}

	details, err := inspectOpenClawAuth(ctx, home, toolCommandTimeout)
	if err != nil {
		return "", err
	}
	if details.usableProfiles > 0 {
		return "", errors.New("OpenClaw profiles remain after logout")
	}
	if len(details.processProviders) > 0 {
		return "OpenClaw still uses provider credentials from the process environment. Remove them from the workspace configuration and restart the workspace.", nil
	}
	if len(details.configuredProviders) > 0 {
		return "OpenClaw still uses provider credentials from its configuration. Remove them in OpenClaw Settings > Models.", nil
	}
	return "", nil
}

func removeQwenCredentials(home string, envVars []string) error {
	path, ok, err := mutableHomeFile(home, ".qwen/settings.json")
	if err != nil {
		return err
	}
	if !ok {
		return removeEnvFileVars(home, ".qwen/.env", envVars)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return fmt.Errorf("invalid Qwen settings: %w", err)
	}
	selection, selected := qwenSelectedCredential(settings)
	if qwenSelectedAuthType(settings) != "" && !selected {
		return errors.New("cannot resolve Qwen credential for the selected provider and model")
	}
	if selected && (len(envVars) != 1 || envVars[0] != selection.envKey) {
		return errors.New("Qwen credential selection changed during sign-out")
	}
	if err := removeEnvFileVars(home, ".qwen/.env", envVars); err != nil {
		return err
	}
	changed := false
	security, _ := settings["security"].(map[string]any)
	if auth, ok := security["auth"].(map[string]any); ok {
		if _, exists := auth["apiKey"]; selected && selection.allowSettingsAPIKey && exists {
			delete(auth, "apiKey")
			changed = true
		}
	}
	if values, ok := settings["env"].(map[string]any); ok {
		for _, name := range envVars {
			if _, exists := values[name]; exists {
				delete(values, name)
				changed = true
			}
		}
	}
	if !changed {
		return nil
	}
	updated, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return atomicRewrite(path, append(updated, '\n'))
}

func removeAntigravityProvider(home string) error {
	marker, ok, err := safeRegularHomeFile(home, antigravityProviderMarkerRel)
	if err != nil || !ok {
		return err
	}
	data, err := os.ReadFile(marker)
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(data)) != "gemini" {
		return errors.New("invalid EnvHaven Antigravity provider marker")
	}

	settingsPath, exists, err := mutableHomeFile(home, antigravitySettingsRel)
	if err != nil {
		return err
	}
	if exists {
		data, err := os.ReadFile(settingsPath)
		if err != nil {
			return err
		}
		var settings map[string]any
		if err := json.Unmarshal(data, &settings); err != nil {
			return fmt.Errorf("invalid Antigravity settings: %w", err)
		}
		if provider, _ := settings["modelProvider"].(string); provider == "gemini" {
			delete(settings, "modelProvider")
			updated, err := json.MarshalIndent(settings, "", "  ")
			if err != nil {
				return err
			}
			if err := atomicRewrite(settingsPath, append(updated, '\n')); err != nil {
				return err
			}
		}
	}
	if err := os.Remove(marker); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func removeEnvFileVars(home, rel string, names []string) error {
	path, ok, err := mutableHomeFile(home, rel)
	if err != nil || !ok {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	nameSet := make(map[string]bool, len(names))
	for _, name := range names {
		nameSet[name] = true
	}
	lines := strings.Split(string(data), "\n")
	kept := make([]string, 0, len(lines))
	changed := false
	for _, line := range lines {
		name, _, assignment := parseEnvAssignment(line)
		if assignment && nameSet[name] {
			changed = true
			continue
		}
		kept = append(kept, line)
	}
	if !changed {
		return nil
	}
	return atomicRewrite(path, []byte(strings.Join(kept, "\n")))
}

func parseEnvAssignment(line string) (string, string, bool) {
	trimmed := strings.TrimSpace(line)
	if strings.HasPrefix(trimmed, "export ") {
		trimmed = strings.TrimSpace(strings.TrimPrefix(trimmed, "export "))
	}
	equals := strings.IndexByte(trimmed, '=')
	if equals <= 0 {
		return "", "", false
	}
	name := strings.TrimSpace(trimmed[:equals])
	if !envNameRe.MatchString(name) {
		return "", "", false
	}
	value := strings.TrimSpace(trimmed[equals+1:])
	if len(value) >= 2 && ((value[0] == '\'' && value[len(value)-1] == '\'') ||
		(value[0] == '"' && value[len(value)-1] == '"')) {
		value = value[1 : len(value)-1]
	}
	return name, strings.TrimSpace(value), true
}

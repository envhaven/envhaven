package main

// Authentication state, native probes, and the one bounded argv execution
// primitive used by tool setup, logout, and probing.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	commandWaitDelay       = 100 * time.Millisecond
	commandOutputLimit     = 64 * 1024
	processGroupExitBudget = time.Second
)

var (
	errCommandOutputTruncated = errors.New("command output truncated after 65536 bytes")
	gooseProviderRe           = regexp.MustCompile(`GOOSE_PROVIDER:\s*["']?(\w+)`)
)

type boundedCommandOutput struct {
	sync.Mutex
	stdout    bytes.Buffer
	stderr    bytes.Buffer
	combined  bytes.Buffer
	truncated bool
}

type boundedCommandWriter struct {
	output *boundedCommandOutput
	stderr bool
}

func (writer boundedCommandWriter) Write(data []byte) (int, error) {
	writer.output.Lock()
	defer writer.output.Unlock()

	written := len(data)
	remaining := commandOutputLimit - writer.output.combined.Len()
	if remaining <= 0 {
		writer.output.truncated = true
		return written, nil
	}
	if len(data) > remaining {
		data = data[:remaining]
		writer.output.truncated = true
	}
	if writer.stderr {
		_, _ = writer.output.stderr.Write(data)
	} else {
		_, _ = writer.output.stdout.Write(data)
	}
	_, _ = writer.output.combined.Write(data)
	return written, nil
}

type boundedCommandResult struct {
	stdout   []byte
	stderr   []byte
	combined []byte
}

func (output *boundedCommandOutput) result() (boundedCommandResult, bool) {
	output.Lock()
	defer output.Unlock()
	return boundedCommandResult{
		stdout:   append([]byte(nil), output.stdout.Bytes()...),
		stderr:   append([]byte(nil), output.stderr.Bytes()...),
		combined: append([]byte(nil), output.combined.Bytes()...),
	}, output.truncated
}

// runBoundedArgvCapture runs a trusted argv vector without a shell. The process
// starts in its own group so cancellation terminates descendants as well as the
// direct child. Once the direct child is reaped, anything left in its group has
// outlived the command, so the group is killed after every run whatever the exit
// status: os/exec reports a descendant holding a pipe as ErrWaitDelay only after a
// successful exit.
func runBoundedArgvCapture(parent context.Context, timeout time.Duration, argv []string, stdin string, env []string) (boundedCommandResult, error) {
	if len(argv) == 0 {
		return boundedCommandResult{}, nil
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return killProcessGroup(cmd.Process.Pid) }
	cmd.WaitDelay = commandWaitDelay
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin + "\n")
	}
	if env != nil {
		cmd.Env = env
	}
	var output boundedCommandOutput
	cmd.Stdout = boundedCommandWriter{output: &output}
	cmd.Stderr = boundedCommandWriter{output: &output, stderr: true}
	commandErr := cmd.Run()
	if cmd.Process != nil {
		killErr := killProcessGroup(cmd.Process.Pid)
		if killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
			commandErr = errors.Join(commandErr, killErr)
		} else if killErr == nil {
			if exitErr := waitForProcessGroupExit(cmd.Process.Pid); exitErr != nil {
				commandErr = errors.Join(commandErr, exitErr)
			}
		}
	}
	result, truncated := output.result()
	if truncated {
		commandErr = errors.Join(commandErr, errCommandOutputTruncated)
	}
	return result, commandErr
}

func killProcessGroup(pid int) error {
	err := syscall.Kill(-pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	return err
}

func waitForProcessGroupExit(pgid int) error {
	deadline := time.Now().Add(processGroupExitBudget)
	for {
		err := syscall.Kill(-pgid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		if err != nil {
			return err
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("process group %d was not reaped", pgid)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func runBoundedArgv(parent context.Context, timeout time.Duration, argv []string, stdin string, env []string) ([]byte, error) {
	result, err := runBoundedArgvCapture(parent, timeout, argv, stdin, env)
	return result.combined, err
}

const (
	authSourceProcessEnv = "process-env"
	authSourceManagedRC  = "envhaven-rc" // Stable wire value; storage is the EnvHaven credential file.
	authSourceManualRC   = "manual-rc"
	authSourceNative     = "native"
)

type authResult struct {
	status string
	via    *string
	source *string
}

func readyAuth(via, source string) authResult {
	return authResult{status: "ready", via: &via, source: &source}
}

var (
	authProbeTTL     = 10 * time.Second
	authProbeTimeout = 3 * time.Second
)

type cachedAuthProbe struct {
	result    authResult
	expiresAt time.Time
}

var authProbes = struct {
	sync.Mutex
	results map[string]cachedAuthProbe
	flights map[string]chan struct{}
}{
	results: map[string]cachedAuthProbe{},
	flights: map[string]chan struct{}{},
}

func checkAuth(definition toolDef, home string, sources credentialSources) authResult {
	// Qwen needs a selected auth type before any key source is meaningful.
	if definition.AuthCheck == "qwen" {
		return checkQwenAuth(home, sources)
	}
	if name, source := firstEnvCredential(definition.EnvVars, sources); name != "" {
		return readyAuth(name, source)
	}
	authEnvName, authEnvSource := firstEnvCredential(definition.AuthEnvVars, sources)
	if authEnvName != "" && authEnvSource != authSourceProcessEnv {
		return readyAuth(authEnvName, authEnvSource)
	}
	if definition.AuthCheck == "goose" {
		return checkGooseAuth(home)
	}
	if definition.AuthCheck == "openclaw" {
		return checkOpenClawAuth(definition, home)
	}
	if definition.AuthProbe != nil {
		result := checkNativeAuth(definition, home)
		if result.status == "ready" && authEnvName != "" {
			return readyAuth(authEnvName, authEnvSource)
		}
		return result
	}
	if len(definition.AuthFiles) > 0 {
		for _, rel := range definition.AuthFiles {
			if ok, label := checkAuthFile(home, rel); ok {
				return readyAuth(label, authSourceNative)
			}
		}
		return authResult{status: "needs-auth"}
	}
	if len(definition.EnvVars) > 0 {
		return authResult{status: "needs-auth"}
	}
	return authResult{status: "unknown"}
}

func checkNativeAuth(definition toolDef, home string) authResult {
	probe := definition.AuthProbe
	if probe == nil || len(probe.Command) == 0 || probe.UnauthenticatedOutput == "" {
		return authResult{status: "unknown"}
	}
	cacheKey := definition.ID + "\x00" + home + "\x00" + strings.Join(probe.Command, "\x00")
	return cachedNativeAuth(cacheKey, func() authResult {
		return runNativeAuthProbe(probe, home)
	})
}

func cachedNativeAuth(cacheKey string, resolve func() authResult) authResult {
	for {
		now := time.Now()
		authProbes.Lock()
		if cached, ok := authProbes.results[cacheKey]; ok && now.Before(cached.expiresAt) {
			authProbes.Unlock()
			return cached.result
		}
		if flight, ok := authProbes.flights[cacheKey]; ok {
			authProbes.Unlock()
			<-flight
			continue
		}
		flight := make(chan struct{})
		authProbes.flights[cacheKey] = flight
		authProbes.Unlock()

		result := resolve()
		completedAt := time.Now()

		authProbes.Lock()
		// Removing a flight invalidates its result without cancelling its waiters.
		// Only the channel still registered for this key may publish a result.
		current := authProbes.flights[cacheKey] == flight
		if current {
			authProbes.results[cacheKey] = cachedAuthProbe{result: result, expiresAt: completedAt.Add(authProbeTTL)}
			delete(authProbes.flights, cacheKey)
		}
		close(flight)
		authProbes.Unlock()
		if current {
			return result
		}
	}
}

type openClawProviderStatus struct {
	Provider  string `json:"provider"`
	Effective struct {
		Kind   string `json:"kind"`
		Detail string `json:"detail"`
	} `json:"effective"`
	Profiles struct {
		Count int `json:"count"`
	} `json:"profiles"`
}

type openClawAuthDetails struct {
	result              authResult
	configuredProviders []string
	processProviders    []string
	usableProfiles      int
}

type openClawStatusPayload struct {
	Auth struct {
		Providers        []openClawProviderStatus `json:"providers"`
		UnusableProfiles []struct {
			ProfileID string `json:"profileId"`
			Provider  string `json:"provider"`
		} `json:"unusableProfiles"`
		ModelRouteIssues []struct {
			Provider string `json:"provider"`
		} `json:"modelRouteIssues"`
	} `json:"auth"`
}

func checkOpenClawAuth(definition toolDef, home string) authResult {
	cacheKey := definition.ID + "\x00" + home + "\x00openclaw-models-status-json-v1"
	return cachedNativeAuth(cacheKey, func() authResult {
		details, err := inspectOpenClawAuth(context.Background(), home, authProbeTimeout)
		if err != nil {
			return authResult{status: "unknown"}
		}
		return details.result
	})
}

func inspectOpenClawAuth(ctx context.Context, home string, timeout time.Duration) (openClawAuthDetails, error) {
	result, err := runBoundedArgvCapture(
		ctx,
		timeout,
		[]string{"openclaw", "models", "status", "--json"},
		"",
		environmentWithHome(home),
	)
	if err != nil {
		return openClawAuthDetails{}, fmt.Errorf("openclaw models status failed: %w: %s", err, strings.TrimSpace(string(result.stderr)))
	}
	return parseOpenClawAuthStatus(result.stdout)
}

func parseOpenClawAuthStatus(data []byte) (openClawAuthDetails, error) {
	var payload openClawStatusPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return openClawAuthDetails{}, fmt.Errorf("invalid OpenClaw status JSON: %w", err)
	}
	unusable := map[string]int{}
	for _, profile := range payload.Auth.UnusableProfiles {
		unusable[profile.Provider]++
	}
	routeIssue := map[string]bool{}
	for _, issue := range payload.Auth.ModelRouteIssues {
		routeIssue[issue.Provider] = true
	}

	details := openClawAuthDetails{result: authResult{status: "needs-auth"}}
	for _, provider := range payload.Auth.Providers {
		if provider.Profiles.Count > unusable[provider.Provider] {
			details.usableProfiles += provider.Profiles.Count - unusable[provider.Provider]
			if details.result.status != "ready" {
				details.result = readyAuth("OpenClaw "+provider.Provider+" profile", authSourceNative)
			}
		}
	}
	for _, provider := range payload.Auth.Providers {
		kind := strings.ToLower(strings.TrimSpace(provider.Effective.Kind))
		switch kind {
		case "config", "api_key", "token", "oauth":
			if !routeIssue[provider.Provider] && strings.TrimSpace(provider.Effective.Detail) != "" {
				details.configuredProviders = append(details.configuredProviders, provider.Provider)
				if details.result.status != "ready" {
					details.result = readyAuth("OpenClaw "+provider.Provider+" config", authSourceNative)
				}
			}
		case "env":
			details.processProviders = append(details.processProviders, provider.Provider)
			if details.result.status != "ready" {
				details.result = readyAuth("OpenClaw "+provider.Provider+" environment", authSourceProcessEnv)
			}
		}
	}
	return details, nil
}

func runNativeAuthProbe(probe *authProbe, home string) authResult {
	output, err := runBoundedArgv(context.Background(), authProbeTimeout, probe.Command, "", environmentWithHome(home))
	if strings.Contains(strings.ToLower(string(output)), strings.ToLower(probe.UnauthenticatedOutput)) {
		return authResult{status: "needs-auth"}
	}
	if err != nil {
		return authResult{status: "unknown"}
	}
	return readyAuth(probe.ConnectedVia, authSourceNative)
}

func invalidateAuthProbe(toolID string) {
	authProbes.Lock()
	defer authProbes.Unlock()
	for key := range authProbes.results {
		if strings.HasPrefix(key, toolID+"\x00") {
			delete(authProbes.results, key)
		}
	}
	for key := range authProbes.flights {
		if strings.HasPrefix(key, toolID+"\x00") {
			delete(authProbes.flights, key)
		}
	}
}

func resetAuthProbeCache() {
	authProbes.Lock()
	defer authProbes.Unlock()
	authProbes.results = map[string]cachedAuthProbe{}
	authProbes.flights = map[string]chan struct{}{}
}

func environmentWithHome(home string) []string {
	env := make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "HOME=") {
			env = append(env, entry)
		}
	}
	return append(env, "HOME="+home)
}

func toolInstalled(command string) bool {
	_, err := exec.LookPath(command)
	return err == nil
}

func firstEnvCredential(names []string, sources credentialSources) (string, string) {
	for _, name := range names {
		if os.Getenv(name) != "" {
			return name, authSourceProcessEnv
		}
		if sources[name].manual {
			return name, authSourceManualRC
		}
		if sources[name].managed {
			return name, authSourceManagedRC
		}
	}
	return "", ""
}

func checkGooseAuth(home string) authResult {
	data, err := os.ReadFile(filepath.Join(home, ".config/goose/config.yaml"))
	if err != nil || !strings.Contains(string(data), "GOOSE_PROVIDER:") {
		return authResult{status: "needs-auth"}
	}
	provider := "configured"
	if match := gooseProviderRe.FindStringSubmatch(string(data)); match != nil {
		provider = match[1]
	}
	return readyAuth("goose ("+provider+")", authSourceNative)
}

func checkQwenAuth(home string, sources credentialSources) authResult {
	settingsPath, ok, _ := mutableHomeFile(home, ".qwen/settings.json")
	if !ok {
		return authResult{status: "needs-auth"}
	}
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return authResult{status: "needs-auth"}
	}
	var settings map[string]any
	if json.Unmarshal(data, &settings) != nil || qwenSelectedAuthType(settings) == "" {
		return authResult{status: "needs-auth"}
	}

	selection, ok := qwenSelectedCredential(settings)
	if !ok {
		return authResult{status: "needs-auth"}
	}
	if name, source := firstEnvCredential([]string{selection.envKey}, sources); name != "" {
		return readyAuth(name, source)
	}
	if qwenSettingsHasCredential(settings, selection) {
		return readyAuth("qwen/settings.json", authSourceNative)
	}
	if envPath, exists, _ := mutableHomeFile(home, ".qwen/.env"); exists {
		if data, err := os.ReadFile(envPath); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				name, value, assignment := parseEnvAssignment(line)
				if assignment && name == selection.envKey && value != "" {
					return readyAuth("qwen/.env", authSourceNative)
				}
			}
		}
	}
	return authResult{status: "needs-auth"}
}

var qwenDefaultCredentialEnvKeys = map[string]string{
	"openai":           "OPENAI_API_KEY",
	"openai-responses": "OPENAI_API_KEY",
	"anthropic":        "ANTHROPIC_API_KEY",
	"gemini":           "GEMINI_API_KEY",
	"vertex-ai":        "GOOGLE_API_KEY",
}

type qwenCredentialSelection struct {
	envKey              string
	allowSettingsAPIKey bool
}

func qwenSelectedCredential(settings map[string]any) (qwenCredentialSelection, bool) {
	selectedType := qwenSelectedAuthType(settings)
	defaultKey, knownType := qwenDefaultCredentialEnvKeys[selectedType]
	if !knownType {
		return qwenCredentialSelection{}, false
	}

	modelName, modelBaseURL, hasSelectedModel, validModel := qwenSelectedModel(settings)
	if !validModel {
		return qwenCredentialSelection{}, false
	}
	providersValue, hasProviders := settings["modelProviders"]
	if !hasProviders {
		return qwenCredentialSelection{envKey: defaultKey, allowSettingsAPIKey: true}, true
	}
	providers, validProviders := providersValue.(map[string]any)
	if !validProviders {
		return qwenCredentialSelection{}, false
	}
	if !hasSelectedModel {
		for providerID, value := range providers {
			protocol, routed := qwenProviderProtocol(settings, providerID)
			if !routed || protocol != selectedType {
				continue
			}
			entries, valid := value.([]any)
			if !valid || len(entries) > 0 {
				return qwenCredentialSelection{}, false
			}
		}
		return qwenCredentialSelection{envKey: defaultKey, allowSettingsAPIKey: true}, true
	}

	var matches []map[string]any
	hasSelectedTypeProviders := false
	for providerID, value := range providers {
		protocol, routed := qwenProviderProtocol(settings, providerID)
		if !routed {
			if qwenProviderContainsModel(value, modelName, modelBaseURL) {
				return qwenCredentialSelection{}, false
			}
			continue
		}
		if protocol != selectedType {
			continue
		}
		entries, valid := value.([]any)
		if !valid {
			return qwenCredentialSelection{}, false
		}
		if len(entries) > 0 {
			hasSelectedTypeProviders = true
		}
		for _, entry := range entries {
			provider, valid := entry.(map[string]any)
			if !valid {
				continue
			}
			id, _ := provider["id"].(string)
			if id != modelName {
				continue
			}
			if modelBaseURL != "" {
				baseURL, _ := provider["baseUrl"].(string)
				if baseURL != modelBaseURL {
					continue
				}
			}
			matches = append(matches, provider)
		}
	}

	if len(matches) == 0 {
		if hasSelectedTypeProviders {
			return qwenCredentialSelection{}, false
		}
		return qwenCredentialSelection{envKey: defaultKey, allowSettingsAPIKey: true}, true
	}
	if len(matches) != 1 {
		return qwenCredentialSelection{}, false
	}
	envKeyValue, explicit := matches[0]["envKey"]
	if !explicit {
		return qwenCredentialSelection{envKey: defaultKey, allowSettingsAPIKey: true}, true
	}
	envKey, valid := envKeyValue.(string)
	if !valid || !envNameRe.MatchString(envKey) {
		return qwenCredentialSelection{}, false
	}
	return qwenCredentialSelection{envKey: envKey}, true
}

func qwenProviderContainsModel(value any, modelName, modelBaseURL string) bool {
	entries, valid := value.([]any)
	if !valid {
		return true
	}
	for _, entry := range entries {
		provider, valid := entry.(map[string]any)
		if !valid {
			continue
		}
		id, _ := provider["id"].(string)
		if id != modelName {
			continue
		}
		if modelBaseURL == "" {
			return true
		}
		baseURL, _ := provider["baseUrl"].(string)
		if baseURL == modelBaseURL {
			return true
		}
	}
	return false
}

func qwenSelectedModel(settings map[string]any) (string, string, bool, bool) {
	value, exists := settings["model"]
	if !exists {
		return "", "", false, true
	}
	model, valid := value.(map[string]any)
	if !valid {
		return "", "", false, false
	}
	nameValue, exists := model["name"]
	if !exists {
		if _, hasBaseURL := model["baseUrl"]; hasBaseURL {
			return "", "", false, false
		}
		return "", "", false, true
	}
	name, valid := nameValue.(string)
	name = strings.TrimSpace(name)
	if !valid || name == "" {
		return "", "", false, false
	}
	baseURL := ""
	if value, exists := model["baseUrl"]; exists {
		baseURL, valid = value.(string)
		if !valid {
			return "", "", false, false
		}
	}
	return name, baseURL, true, true
}

func qwenProviderProtocol(settings map[string]any, providerID string) (string, bool) {
	if value, exists := settings["providerProtocol"]; exists {
		mappings, valid := value.(map[string]any)
		if !valid {
			return "", false
		}
		if value, exists := mappings[providerID]; exists {
			protocol, valid := value.(string)
			if !valid {
				return "", false
			}
			_, known := qwenDefaultCredentialEnvKeys[protocol]
			return protocol, known
		}
	}
	_, known := qwenDefaultCredentialEnvKeys[providerID]
	return providerID, known
}

func qwenSelectedAuthType(settings map[string]any) string {
	security, _ := settings["security"].(map[string]any)
	auth, _ := security["auth"].(map[string]any)
	selected, _ := auth["selectedType"].(string)
	return strings.TrimSpace(selected)
}

func qwenSettingsHasCredential(settings map[string]any, selection qwenCredentialSelection) bool {
	security, _ := settings["security"].(map[string]any)
	auth, _ := security["auth"].(map[string]any)
	if key, ok := auth["apiKey"].(string); selection.allowSettingsAPIKey && ok && strings.TrimSpace(key) != "" {
		return true
	}
	values, _ := settings["env"].(map[string]any)
	if value, ok := values[selection.envKey].(string); ok && strings.TrimSpace(value) != "" {
		return true
	}
	return false
}

func checkAuthFile(home, rel string) (bool, string) {
	full := filepath.Join(home, rel)
	if strings.HasSuffix(full, ".json") {
		data, err := os.ReadFile(full)
		if err != nil {
			return false, ""
		}
		trimmed := strings.TrimSpace(string(data))
		if trimmed == "" || trimmed == "{}" || trimmed == "[]" {
			return false, ""
		}
		return true, authFileLabel(rel)
	}
	if !fileExists(full) {
		return false, ""
	}
	return true, authFileLabel(rel)
}

func authFileLabel(rel string) string {
	label := filepath.Base(filepath.Dir(rel)) + "/" + filepath.Base(rel)
	return strings.TrimPrefix(label, ".")
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestAuthProbeReplacementOutlivesInvalidatedFlight(t *testing.T) {
	for _, invalidate := range []struct {
		name string
		run  func()
	}{
		{"tool mutation", func() { invalidateAuthProbe("replaced") }},
		{"cache reset", resetAuthProbeCache},
	} {
		t.Run(invalidate.name, func(t *testing.T) {
			resetAuthProbeCache()
			t.Cleanup(resetAuthProbeCache)
			const key = "replaced\x00home"
			started, release := make(chan struct{}), make(chan struct{})
			result := make(chan authResult, 1)
			calls := 0
			go func() {
				result <- cachedNativeAuth(key, func() authResult {
					calls++
					if calls == 1 {
						close(started)
					}
					<-release
					return readyAuth("old login", authSourceNative)
				})
			}()
			<-started
			invalidate.run()
			fresh := cachedNativeAuth(key, func() authResult { return authResult{status: "needs-auth"} })
			close(release)
			select {
			case stale := <-result:
				if fresh.status != "needs-auth" || stale.status != fresh.status || calls != 1 {
					t.Fatalf("old flight replaced fresh result: fresh=%+v old=%+v calls=%d", fresh, stale, calls)
				}
			case <-time.After(time.Second):
				t.Fatal("invalidated probe did not join its replacement")
			}
		})
	}
}

func TestQwenRequiresSelectedTypeForEveryCredentialSource(t *testing.T) {
	const key = "QWEN_TEST_API_KEY"
	t.Setenv(key, "")
	definition := toolDef{EnvVars: []string{key}, AuthCheck: "qwen"}
	tests := []struct {
		name     string
		settings string
		dotenv   string
		process  string
		sources  credentialSources
	}{
		{name: "process environment", settings: `{}`, process: "secret"},
		{name: "managed store", settings: `{}`, sources: credentialSources{key: {managed: true}}},
		{name: "manual rc", settings: `{}`, sources: credentialSources{key: {manual: true}}},
		{name: "settings env", settings: `{"env":{"QWEN_TEST_API_KEY":"secret"}}`},
		{name: "legacy settings apiKey", settings: `{"security":{"auth":{"apiKey":"secret"}}}`},
		{name: "qwen dotenv", settings: `{}`, dotenv: "QWEN_TEST_API_KEY=secret\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			home := t.TempDir()
			qwenDir := filepath.Join(home, ".qwen")
			if err := os.MkdirAll(qwenDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(qwenDir, "settings.json"), []byte(test.settings), 0o600); err != nil {
				t.Fatal(err)
			}
			if test.dotenv != "" {
				if err := os.WriteFile(filepath.Join(qwenDir, ".env"), []byte(test.dotenv), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv(key, test.process)
			if got := checkAuth(definition, home, test.sources); got.status != "needs-auth" {
				t.Fatalf("status = %q, want needs-auth without selectedType", got.status)
			}
		})
	}
}

func TestQwenRequiresTheSelectedProviderAndModelCredential(t *testing.T) {
	tests := []struct {
		name     string
		settings string
		env      map[string]string
		status   string
		via      string
	}{
		{
			name:     "known provider default",
			settings: `{"security":{"auth":{"selectedType":"openai"}}}`,
			env:      map[string]string{"OPENAI_API_KEY": "secret"},
			status:   "ready",
			via:      "OPENAI_API_KEY",
		},
		{
			name:     "wrong provider default",
			settings: `{"security":{"auth":{"selectedType":"gemini"}}}`,
			env:      map[string]string{"OPENAI_API_KEY": "wrong"},
			status:   "needs-auth",
		},
		{
			name: "other model key",
			settings: `{"security":{"auth":{"selectedType":"openai"}},"model":{"name":"selected"},` +
				`"modelProviders":{"openai":[{"id":"other","envKey":"OTHER_PROVIDER_KEY"},{"id":"selected","envKey":"SELECTED_PROVIDER_KEY"}]}}`,
			env:    map[string]string{"OTHER_PROVIDER_KEY": "wrong"},
			status: "needs-auth",
		},
		{
			name: "selected model key",
			settings: `{"security":{"auth":{"selectedType":"openai"}},"model":{"name":"selected"},` +
				`"modelProviders":{"openai":[{"id":"other","envKey":"OTHER_PROVIDER_KEY"},{"id":"selected","envKey":"SELECTED_PROVIDER_KEY"}]}}`,
			env:    map[string]string{"SELECTED_PROVIDER_KEY": "secret"},
			status: "ready",
			via:    "SELECTED_PROVIDER_KEY",
		},
		{
			name: "base URL disambiguates duplicate model ids",
			settings: `{"security":{"auth":{"selectedType":"openai"}},"model":{"name":"shared","baseUrl":"https://two.example"},` +
				`"modelProviders":{"openai":[{"id":"shared","baseUrl":"https://one.example","envKey":"FIRST_PROVIDER_KEY"},` +
				`{"id":"shared","baseUrl":"https://two.example","envKey":"SECOND_PROVIDER_KEY"}]}}`,
			env:    map[string]string{"SECOND_PROVIDER_KEY": "secret"},
			status: "ready",
			via:    "SECOND_PROVIDER_KEY",
		},
		{
			name: "custom provider protocol",
			settings: `{"security":{"auth":{"selectedType":"openai"}},"model":{"name":"custom"},` +
				`"providerProtocol":{"idealab":"openai"},"modelProviders":{"idealab":[{"id":"custom","envKey":"IDEALAB_API_KEY"}]}}`,
			env:    map[string]string{"IDEALAB_API_KEY": "secret"},
			status: "ready",
			via:    "IDEALAB_API_KEY",
		},
		{
			name: "unmapped custom provider",
			settings: `{"security":{"auth":{"selectedType":"openai"}},"model":{"name":"custom"},` +
				`"modelProviders":{"idealab":[{"id":"custom","envKey":"IDEALAB_API_KEY"}]}}`,
			env:    map[string]string{"OPENAI_API_KEY": "wrong", "IDEALAB_API_KEY": "wrong"},
			status: "needs-auth",
		},
		{
			name:     "unknown auth type",
			settings: `{"security":{"auth":{"selectedType":"typo"}}}`,
			env:      map[string]string{"OPENAI_API_KEY": "wrong"},
			status:   "needs-auth",
		},
		{
			name: "provider models without a selected model",
			settings: `{"security":{"auth":{"selectedType":"openai"}},` +
				`"modelProviders":{"openai":[{"id":"one","envKey":"ONE_PROVIDER_KEY"}]}}`,
			env:    map[string]string{"ONE_PROVIDER_KEY": "wrong"},
			status: "needs-auth",
		},
		{
			name: "unselected provider models do not override the auth default",
			settings: `{"security":{"auth":{"selectedType":"openai"}},` +
				`"modelProviders":{"gemini":[{"id":"one","envKey":"ONE_PROVIDER_KEY"}]}}`,
			env:    map[string]string{"OPENAI_API_KEY": "secret", "ONE_PROVIDER_KEY": "wrong"},
			status: "ready",
			via:    "OPENAI_API_KEY",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			home := t.TempDir()
			qwenDir := filepath.Join(home, ".qwen")
			if err := os.MkdirAll(qwenDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(qwenDir, "settings.json"), []byte(test.settings), 0o600); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"OPENAI_API_KEY", "GEMINI_API_KEY", "OTHER_PROVIDER_KEY", "SELECTED_PROVIDER_KEY", "FIRST_PROVIDER_KEY", "SECOND_PROVIDER_KEY", "IDEALAB_API_KEY", "ONE_PROVIDER_KEY"} {
				t.Setenv(name, "")
			}
			for name, value := range test.env {
				t.Setenv(name, value)
			}
			got := checkAuth(toolDef{AuthCheck: "qwen"}, home, credentialSources{})
			if got.status != test.status {
				t.Fatalf("status = %q, want %q", got.status, test.status)
			}
			if test.via != "" && (got.via == nil || *got.via != test.via || got.source == nil || *got.source != authSourceProcessEnv) {
				t.Fatalf("auth = %+v, want process credential %s", got, test.via)
			}
		})
	}
}

func TestBoundedArgvKillsDescendantsWithinDeadline(t *testing.T) {
	for _, test := range []struct {
		name   string
		script string
	}{
		{name: "running child", script: "sleep 2; printf unreachable"},
		{name: "background child holding pipes", script: "sleep 2 &"},
	} {
		t.Run(test.name, func(t *testing.T) {
			started := time.Now()
			_, err := runBoundedArgv(
				context.Background(),
				25*time.Millisecond,
				[]string{"sh", "-c", test.script},
				"",
				nil,
			)
			if err == nil {
				t.Fatal("command completed despite a descendant retaining its pipes")
			}
			if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
				t.Fatalf("descendant-held pipes delayed return for %s, want under 500ms", elapsed)
			}
		})
	}
}

func TestBoundedArgvKillsErrWaitDelayDescendantPID(t *testing.T) {
	pidPath := filepath.Join(t.TempDir(), "child.pid")
	_, err := runBoundedArgv(
		context.Background(),
		5*time.Second,
		[]string{"sh", "-c", `sleep 30 & child=$!; printf %s "$child" >"$1"`, "sh", pidPath},
		"",
		nil,
	)
	if !errors.Is(err, exec.ErrWaitDelay) {
		t.Fatalf("error = %v, want exec.ErrWaitDelay", err)
	}
	data, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil {
		t.Fatalf("child pid = %q: %v", data, err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("background descendant PID %d remained after ErrWaitDelay", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestBoundedArgvKillsDescendantAfterNonZeroExit(t *testing.T) {
	pidPath := filepath.Join(t.TempDir(), "child.pid")
	_, err := runBoundedArgv(
		context.Background(),
		5*time.Second,
		[]string{"sh", "-c", `sleep 30 & child=$!; printf %s "$child" >"$1"; exit 3`, "sh", pidPath},
		"",
		nil,
	)
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 3 {
		t.Fatalf("error = %v, want exit status 3", err)
	}
	data, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil {
		t.Fatalf("child pid = %q: %v", data, err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			break
		}
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("background descendant PID %d remained after a non-zero exit", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestParseOpenClawAuthStatus(t *testing.T) {
	tests := []struct {
		name, payload, status, source string
	}{
		{
			name:    "usable profile",
			payload: `{"auth":{"providers":[{"provider":"anthropic","effective":{"kind":"profiles","detail":"store"},"profiles":{"count":1}}],"unusableProfiles":[],"modelRouteIssues":[]}}`,
			status:  "ready",
			source:  authSourceNative,
		},
		{
			name:    "only unusable profile",
			payload: `{"auth":{"providers":[{"provider":"anthropic","effective":{"kind":"profiles","detail":"store"},"profiles":{"count":1}}],"unusableProfiles":[{"profileId":"anthropic:manual","provider":"anthropic"}],"modelRouteIssues":[]}}`,
			status:  "needs-auth",
		},
		{
			name:    "resolved config",
			payload: `{"auth":{"providers":[{"provider":"local","effective":{"kind":"config","detail":"models.json"},"profiles":{"count":0}}],"unusableProfiles":[],"modelRouteIssues":[]}}`,
			status:  "ready",
			source:  authSourceNative,
		},
		{
			name:    "config route issue",
			payload: `{"auth":{"providers":[{"provider":"local","effective":{"kind":"config","detail":"models.json"},"profiles":{"count":0}}],"unusableProfiles":[],"modelRouteIssues":[{"provider":"local"}]}}`,
			status:  "needs-auth",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			details, err := parseOpenClawAuthStatus([]byte(test.payload))
			if err != nil {
				t.Fatal(err)
			}
			if details.result.status != test.status {
				t.Fatalf("status = %q, want %q", details.result.status, test.status)
			}
			if test.source != "" && (details.result.source == nil || *details.result.source != test.source) {
				t.Fatalf("source = %v, want %q", details.result.source, test.source)
			}
		})
	}
}

func TestOpenClawUsesJSONStdoutAndSupportedLogout(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "commands.log")
	statePath := filepath.Join(dir, "logged-out")
	script := `#!/bin/sh
printf '%s\n' "$*" >>"$OPENCLAW_TEST_LOG"
printf '%s\n' 'diagnostic on stderr' >&2
case "$*" in
  'models auth list --json')
    if [ "$OPENCLAW_TEST_MODE" = config ]; then
      printf '%s\n' '{"agentId":"main","profiles":[]}'
    else
      printf '%s\n' '{"agentId":"main","profiles":[{"id":"anthropic:manual"}]}'
    fi
    ;;
  'models auth --agent main logout anthropic:manual --yes')
    : >"$OPENCLAW_TEST_STATE"
    ;;
  'models status --json')
    if [ "$OPENCLAW_TEST_MODE" = config ]; then
      printf '%s\n' '{"auth":{"providers":[{"provider":"local","effective":{"kind":"config","detail":"models.json"},"profiles":{"count":0}}],"unusableProfiles":[],"modelRouteIssues":[]}}'
    elif [ -e "$OPENCLAW_TEST_STATE" ]; then
      printf '%s\n' '{"auth":{"providers":[],"unusableProfiles":[],"modelRouteIssues":[]}}'
    else
      printf '%s\n' '{"auth":{"providers":[{"provider":"anthropic","effective":{"kind":"profiles","detail":"store"},"profiles":{"count":1}}],"unusableProfiles":[],"modelRouteIssues":[]}}'
    fi
    ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "openclaw"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("OPENCLAW_TEST_LOG", logPath)
	t.Setenv("OPENCLAW_TEST_STATE", statePath)
	t.Setenv("OPENCLAW_TEST_MODE", "profiles")

	details, err := inspectOpenClawAuth(context.Background(), dir, time.Second)
	if err != nil || details.result.status != "ready" {
		t.Fatalf("status with stderr diagnostic = (%+v, %v), want ready", details, err)
	}
	instruction, err := signOutOpenClaw(context.Background(), dir)
	if err != nil || instruction != "" {
		t.Fatalf("profile logout = (%q, %v), want success", instruction, err)
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(commands), "models auth --agent main logout anthropic:manual --yes") {
		t.Fatalf("commands =\n%s\nwant supported profile logout", commands)
	}

	t.Setenv("OPENCLAW_TEST_MODE", "config")
	instruction, err = signOutOpenClaw(context.Background(), dir)
	if err != nil || !strings.Contains(instruction, "Settings > Models") {
		t.Fatalf("config logout = (%q, %v), want source-aware instruction", instruction, err)
	}
}

func TestBoundedArgvCapsHighOutput(t *testing.T) {
	output, err := runBoundedArgv(
		context.Background(),
		5*time.Second,
		[]string{"sh", "-c", "printf stderr >&2; dd if=/dev/zero bs=1M count=32 status=none"},
		"",
		nil,
	)
	if !errors.Is(err, errCommandOutputTruncated) {
		t.Fatalf("error = %v, want output truncation", err)
	}
	if len(output) != commandOutputLimit {
		t.Fatalf("captured %d bytes, want %d", len(output), commandOutputLimit)
	}
	if !bytes.HasPrefix(output, []byte("stderr")) {
		t.Fatalf("combined output prefix = %q, want stderr", output[:16])
	}
}

func TestReadyToolNamesMatchHTTPAuthModel(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte("export ALPHA_KEY='manual'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	qwenDir := filepath.Join(home, ".qwen")
	if err := os.MkdirAll(qwenDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(qwenDir, "settings.json"), []byte(`{"security":{"auth":{}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	nativeDir := filepath.Join(home, ".native")
	if err := os.MkdirAll(nativeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nativeDir, "auth.json"), []byte(`{"token":"ready"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := `{"tools":[
		{"id":"alpha","name":"Alpha","command":"sh","authCommand":null,"envVars":["ALPHA_KEY"],"authFiles":[]},
		{"id":"qwen","name":"Qwen","command":"sh","authCommand":"qwen","envVars":["QWEN_KEY"],"authFiles":[],"authCheck":"qwen"},
		{"id":"missing","name":"Missing","command":"envhaven-absent-command-xyz","authCommand":null,"envVars":["MISSING_KEY"],"authFiles":[]},
		{"id":"native","name":"Native","command":"sh","authCommand":"native login","envVars":[],"authFiles":[".native/auth.json"]}
	]}`
	definitions := filepath.Join(t.TempDir(), "tools.json")
	if err := os.WriteFile(definitions, []byte(catalog), 0o600); err != nil {
		t.Fatal(err)
	}
	previous := toolDefsPath
	toolDefsPath = definitions
	t.Cleanup(func() { toolDefsPath = previous })
	t.Setenv("HOME", home)
	t.Setenv("ALPHA_KEY", "")
	t.Setenv("QWEN_KEY", "secret")
	t.Setenv("MISSING_KEY", "secret")

	var ready bytes.Buffer
	if err := writeReadyToolNames(&ready); err != nil {
		t.Fatal(err)
	}
	if got, want := ready.String(), "Alpha\nNative\n"; got != want {
		t.Fatalf("ready names = %q, want %q", got, want)
	}

	recorder := httptest.NewRecorder()
	handleTools(recorder, httptest.NewRequest(http.MethodGet, "/__console/tools", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET /tools = %d: %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Tools []toolResponse `json:"tools"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	var httpReady []string
	for _, tool := range response.Tools {
		if tool.Installed && tool.AuthStatus == "ready" {
			httpReady = append(httpReady, tool.Name)
		}
	}
	if !reflect.DeepEqual(httpReady, strings.Fields(ready.String())) {
		t.Fatalf("HTTP ready tools = %v, CLI ready tools = %q", httpReady, ready.String())
	}
}

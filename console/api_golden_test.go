package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestHandleToolsGolden locks the /tools wire shape. It reproduces a fixed fixture
// (a two-tool catalog + an rc file granting one of them a key) and asserts handleTools
// emits testdata/tools.golden.json. The SAME golden is validated against the TypeScript
// AITool type by extension/src/__tests__/console-conformance.test.ts, so a field added,
// renamed, or retyped on either side of the Go↔TS boundary breaks a test on that side.
//
// The fixture is deterministic on any unix builder: `sh` is always on PATH (installed:true),
// `envhaven-absent-cmd-xyz` never is (installed:false, which gates its auth to needs-auth),
// and ALPHA_KEY is granted only through a manual rc export, not the process env.
func TestHandleToolsGolden(t *testing.T) {
	dir := t.TempDir()
	defs := filepath.Join(dir, "tool-definitions.json")
	catalog := `{"tools":[
		{"id":"alpha","name":"Alpha","command":"sh","authCommand":null,"description":"Alpha tool","docsUrl":"https://example.com/alpha","envVars":["ALPHA_KEY"],"authFiles":[],"setupSteps":[]},
		{"id":"beta","name":"Beta","command":"envhaven-absent-cmd-xyz","authCommand":"beta login","description":"Beta tool","docsUrl":"https://example.com/beta","envVars":["BETA_KEY"],"authFiles":[],"setupSteps":[{"instruction":"Run beta init","command":"beta init"}]}
	],"envVarMeta":{
		"ALPHA_KEY":{"placeholder":"alpha-...","hint":"Alpha key hint","url":"https://example.com/alpha-key"},
		"BETA_KEY":{"placeholder":"beta-...","hint":"Beta key hint","url":null}
	}}`
	if err := os.WriteFile(defs, []byte(catalog), 0o600); err != nil {
		t.Fatal(err)
	}
	prev := toolDefsPath
	toolDefsPath = defs
	t.Cleanup(func() { toolDefsPath = prev })

	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte("export ALPHA_KEY=\"secret\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	// The golden's auth must come from the rc file, not an ambient env var.
	// firstEnvCredential treats empty as unset, so t.Setenv("...", "") both blanks
	// the variable here and restores any pre-test value on cleanup (os.Unsetenv
	// would leak the blanking into later tests).
	t.Setenv("ALPHA_KEY", "")
	t.Setenv("BETA_KEY", "")

	rec := httptest.NewRecorder()
	handleTools(rec, httptest.NewRequest(http.MethodGet, "/__console/tools", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}

	golden, err := os.ReadFile("testdata/tools.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if err := json.Unmarshal(golden, &want); err != nil {
		t.Fatalf("unmarshal golden: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("response does not match testdata/tools.golden.json.\n got: %s\nwant: %s", rec.Body.Bytes(), golden)
	}
}

// TestSkillsGolden locks the /skills wire shapes — the installed-list entry and the
// merged search result — against testdata/skills.golden.json, the same Go↔TS drift
// guard TestHandleToolsGolden gives /tools (the TS side asserts this golden against
// InstalledSkill + SkillsShResult in extension/src/__tests__/console-conformance.test.ts).
//
// The search half runs through handleSkills against the skillsFixture: the first-party
// "deploy" (null install count) merges ahead of a community hit that keeps its counter.
// The installed half has no hermetic path through the handler (listInstalledSkills
// shells out to `skills`), so fixture values marshal directly — writeJSON emits
// exactly this encoding, so the struct tags ARE the wire.
func TestSkillsGolden(t *testing.T) {
	f := newSkillsFixture(t)
	f.setSh("deploy",
		skillResult{ID: "acme/skills/react-deploy", SkillID: "react-deploy", Name: "react-deploy", Installs: installs(12), Source: "acme/skills"},
	)

	rec := httptest.NewRecorder()
	handleSkills(rec, httptest.NewRequest(http.MethodGet, "/__console/skills?q=deploy", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var search struct {
		Results json.RawMessage `json:"results"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &search); err != nil {
		t.Fatalf("unmarshal search response: %v", err)
	}

	source := "envhaven/envhaven"
	installed, err := json.Marshal([]installedSkill{
		{Name: "deploy", Description: "Deploy things", Source: &source, Path: "/config/.claude/skills/deploy", Agents: []string{"claude-code", "codex"}},
		{Name: "scratch", Description: "", Source: nil, Path: "/config/.claude/skills/scratch", Agents: []string{}},
	})
	if err != nil {
		t.Fatal(err)
	}

	composed, err := json.Marshal(map[string]json.RawMessage{
		"installed": installed,
		"results":   search.Results,
	})
	if err != nil {
		t.Fatal(err)
	}

	golden, err := os.ReadFile("testdata/skills.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(composed, &got); err != nil {
		t.Fatalf("unmarshal composed document: %v", err)
	}
	if err := json.Unmarshal(golden, &want); err != nil {
		t.Fatalf("unmarshal golden: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("skills wire does not match testdata/skills.golden.json.\n got: %s\nwant: %s", composed, golden)
	}
}

// TestShippedCatalog validates the REAL repo-root tool-definitions.json — the file the
// Dockerfile installs at toolDefsPath — where the goldens above use synthetic fixtures.
// It decodes the catalog through loadToolDefs (the production path, via the seam) and
// again strictly with DisallowUnknownFields against structs modeling every field in
// the file, so a key the console does not understand can never ship silently. Then it
// asserts the catalog invariants every consumer assumes: the expected tool count,
// unique ids, a non-empty command per tool (installed-detection would silently break),
// and an envVarMeta entry for every declared env var (the API-key input renders blind
// without one).
func TestShippedCatalog(t *testing.T) {
	prev := toolDefsPath
	toolDefsPath = "../tool-definitions.json"
	t.Cleanup(func() { toolDefsPath = prev })

	tools, err := loadToolDefs()
	if err != nil {
		t.Fatalf("loadToolDefs on the shipped catalog: %v", err)
	}

	data, err := os.ReadFile(toolDefsPath)
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Description string `json:"description"`
		Tools       []struct {
			toolDef
			AuthSummary string `json:"authSummary"`
			Icon        struct {
				ViewBox    string            `json:"viewBox"`
				Fill       string            `json:"fill"`
				FillRule   string            `json:"fillRule"`
				Gradient   json.RawMessage   `json:"gradient"`
				Primitives []json.RawMessage `json:"primitives"`
			} `json:"icon"`
			LaunchArgs     []string `json:"launchArgs"`
			LaunchArgsWhen string   `json:"launchArgsWhen"`
			PrepareCommand []string `json:"prepareCommand"`
		} `json:"tools"`
		EnvVarMeta map[string]struct {
			Placeholder string  `json:"placeholder"`
			Hint        string  `json:"hint"`
			URL         *string `json:"url"`
		} `json:"envVarMeta"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&catalog); err != nil {
		t.Fatalf("strict decode of the shipped catalog: %v", err)
	}

	if len(tools) != 17 {
		t.Fatalf("catalog has %d tools, want 17 (adding a tool? update this count)", len(tools))
	}
	seen := map[string]bool{}
	byID := map[string]toolDef{}
	for index, d := range tools {
		metadata := catalog.Tools[index]
		if d.ID == "" || seen[d.ID] {
			t.Errorf("tool id %q is empty or duplicated", d.ID)
		}
		seen[d.ID] = true
		byID[d.ID] = d
		if d.Command == "" {
			t.Errorf("tool %q has an empty command", d.ID)
		}
		if metadata.AuthSummary == "" {
			t.Errorf("tool %q has an empty auth summary", d.ID)
		}
		if metadata.Icon.ViewBox == "" || metadata.Icon.Fill == "" || len(metadata.Icon.Primitives) == 0 {
			t.Errorf("tool %q has an incomplete icon", d.ID)
		}
		if d.AuthProbe != nil && (len(d.AuthProbe.Command) == 0 || d.AuthProbe.UnauthenticatedOutput == "" || d.AuthProbe.ConnectedVia == "") {
			t.Errorf("tool %q has an incomplete auth probe", d.ID)
		}
		if d.LogoutInstruction != "" && len(d.LogoutCommand) == 0 {
			t.Errorf("tool %q has a logout instruction without a command", d.ID)
		}
		if metadata.LaunchArgsWhen != "" && metadata.LaunchArgsWhen != "always" && metadata.LaunchArgsWhen != "bare" {
			t.Errorf("tool %q has invalid launchArgsWhen %q", d.ID, metadata.LaunchArgsWhen)
		}
		for _, rel := range d.AuthFiles {
			if rel == ".qwen/settings.json" || rel == ".openclaw/openclaw.json" || rel == ".openclaw/.env" {
				t.Errorf("tool %q must not treat general configuration %q as a credential file", d.ID, rel)
			}
		}
		for _, v := range d.EnvVars {
			if _, ok := catalog.EnvVarMeta[v]; !ok {
				t.Errorf("tool %q envVar %q has no envVarMeta entry", d.ID, v)
			}
		}
		for _, v := range d.AuthEnvVars {
			if toolDeclaresEnvVar(&d, v) {
				t.Errorf("tool %q duplicates authEnvVar %q in envVars", d.ID, v)
			}
			if d.AuthProbe == nil {
				t.Errorf("tool %q authEnvVar %q has no validating auth probe", d.ID, v)
			}
		}
	}

	assertProbe := func(id string, command []string, needle string) {
		t.Helper()
		probe := byID[id].AuthProbe
		if probe == nil || !reflect.DeepEqual(probe.Command, command) || probe.UnauthenticatedOutput != needle {
			t.Errorf("tool %q auth probe = %+v, want %v / %q", id, probe, command, needle)
		}
	}
	codex := byID["codex"]
	if len(codex.EnvVars) != 0 || len(codex.SetKeyCommand) != 0 || !reflect.DeepEqual(codex.AuthEnvVars, []string{"CODEX_ACCESS_TOKEN"}) {
		t.Errorf("Codex must persist API-key login natively, not claim ambient env auth: %+v", codex)
	}
	if len(byID["kiro"].EnvVars) != 0 {
		t.Errorf("Kiro's API key is headless-only and must not mark its interactive TUI ready")
	}
	assertProbe("codex", []string{"codex", "login", "status"}, "Not logged in")
	assertProbe("kiro", []string{"kiro-cli", "whoami", "--format", "json"}, `"account":null`)
	assertProbe("amp", []string{"amp", "usage"}, "Invalid or missing API key")
	assertProbe("antigravity", []string{"agy", "models"}, "Please sign in to view available models")
	assertProbe("factory", []string{"droid", "doctor", "--auth", "--json", "--timeout", "2000"}, "not logged in")
	if byID["qwen"].AuthCheck != "qwen" {
		t.Errorf("Qwen must use its structural current-settings auth check")
	}
	if byID["openclaw"].AuthCheck != "openclaw" {
		t.Errorf("OpenClaw must use its canonical JSON auth check")
	}
}

func TestNativeAuthProbe(t *testing.T) {
	originalTTL, originalTimeout := authProbeTTL, authProbeTimeout
	t.Cleanup(func() {
		authProbeTTL = originalTTL
		authProbeTimeout = originalTimeout
		resetAuthProbeCache()
	})

	probeDef := func(id, script string) toolDef {
		return toolDef{
			ID: id,
			AuthProbe: &authProbe{
				Command:               []string{"sh", "-c", script},
				UnauthenticatedOutput: "not logged in",
				ConnectedVia:          "native login",
			},
		}
	}

	t.Run("caches a completed native result", func(t *testing.T) {
		resetAuthProbeCache()
		home := t.TempDir()
		def := probeDef("native", `printf x >>"$HOME/probe-count"; printf authenticated`)
		for range 2 {
			got := checkAuth(def, home, credentialSources{})
			if got.status != "ready" || got.via == nil || *got.via != "native login" || got.source == nil || *got.source != authSourceNative {
				t.Fatalf("checkAuth() = %+v, want native ready", got)
			}
		}
		data, err := os.ReadFile(filepath.Join(home, "probe-count"))
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "x" {
			t.Fatalf("probe ran %d times, want one cached execution", len(data))
		}
	})

	t.Run("known unauthenticated output wins over exit status", func(t *testing.T) {
		resetAuthProbeCache()
		def := probeDef("logged-out", `printf 'Not Logged In'; exit 7`)
		if got := checkAuth(def, t.TempDir(), credentialSources{}); got.status != "needs-auth" {
			t.Fatalf("unauthenticated probe status = %q, want needs-auth", got.status)
		}
	})

	t.Run("operational failures are unknown", func(t *testing.T) {
		resetAuthProbeCache()
		def := probeDef("failed", `printf unavailable >&2; exit 7`)
		if got := checkAuth(def, t.TempDir(), credentialSources{}); got.status != "unknown" {
			t.Fatalf("failed probe status = %q, want unknown", got.status)
		}
	})

	t.Run("validates process auth env before attributing it", func(t *testing.T) {
		resetAuthProbeCache()
		t.Setenv("NATIVE_TOKEN", "process-secret")
		def := probeDef("process-auth", `printf authenticated`)
		def.AuthEnvVars = []string{"NATIVE_TOKEN"}
		got := checkAuth(def, t.TempDir(), credentialSources{})
		if got.status != "ready" || got.via == nil || *got.via != "NATIVE_TOKEN" || got.source == nil || *got.source != authSourceProcessEnv {
			t.Fatalf("process auth result = %+v, want validated process-env ready", got)
		}
	})

	t.Run("does not trust process auth env when its probe fails", func(t *testing.T) {
		resetAuthProbeCache()
		t.Setenv("NATIVE_TOKEN", "invalid-secret")
		def := probeDef("invalid-process-auth", `printf invalid >&2; exit 7`)
		def.AuthEnvVars = []string{"NATIVE_TOKEN"}
		if got := checkAuth(def, t.TempDir(), credentialSources{}); got.status != "unknown" {
			t.Fatalf("invalid process auth status = %q, want unknown", got.status)
		}
	})

	t.Run("timeouts are unknown", func(t *testing.T) {
		resetAuthProbeCache()
		authProbeTimeout = 20 * time.Millisecond
		t.Cleanup(func() { authProbeTimeout = originalTimeout })
		def := probeDef("timeout", `sleep 1; printf authenticated`)
		if got := checkAuth(def, t.TempDir(), credentialSources{}); got.status != "unknown" {
			t.Fatalf("timed-out probe status = %q, want unknown", got.status)
		}
	})

	t.Run("concurrent misses share one execution", func(t *testing.T) {
		resetAuthProbeCache()
		home := t.TempDir()
		def := probeDef("single-flight", `printf x >>"$HOME/probe-count"; sleep 0.1; printf authenticated`)
		const callers = 16
		start := make(chan struct{})
		results := make(chan authResult, callers)
		var wg sync.WaitGroup
		for range callers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				results <- checkAuth(def, home, credentialSources{})
			}()
		}
		close(start)
		wg.Wait()
		close(results)
		for result := range results {
			if result.status != "ready" {
				t.Fatalf("concurrent result = %q, want ready", result.status)
			}
		}
		data, err := os.ReadFile(filepath.Join(home, "probe-count"))
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "x" {
			t.Fatalf("probe ran %d times, want one single-flight execution", len(data))
		}
	})

	t.Run("ttl starts after completion", func(t *testing.T) {
		resetAuthProbeCache()
		authProbeTTL = 50 * time.Millisecond
		t.Cleanup(func() { authProbeTTL = originalTTL })
		home := t.TempDir()
		def := probeDef("completion-ttl", `printf x >>"$HOME/probe-count"; sleep 0.08; printf authenticated`)
		if got := checkAuth(def, home, credentialSources{}); got.status != "ready" {
			t.Fatalf("first probe = %q, want ready", got.status)
		}
		if got := checkAuth(def, home, credentialSources{}); got.status != "ready" {
			t.Fatalf("cached probe = %q, want ready", got.status)
		}
		data, err := os.ReadFile(filepath.Join(home, "probe-count"))
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "x" {
			t.Fatalf("probe ran %d times immediately after completion, want one", len(data))
		}
	})

	t.Run("mutation cannot publish an older flight", func(t *testing.T) {
		resetAuthProbeCache()
		authProbeTTL = originalTTL
		authProbeTimeout = originalTimeout
		home := t.TempDir()
		def := probeDef("mutated", `printf x >>"$HOME/probe-count"; if [ ! -e "$HOME/released" ]; then : >"$HOME/started"; while [ ! -e "$HOME/released" ]; do sleep 0.01; done; printf authenticated; else printf 'not logged in'; fi`)
		result := make(chan authResult, 1)
		go func() { result <- checkAuth(def, home, credentialSources{}) }()
		deadline := time.Now().Add(time.Second)
		for !fileExists(filepath.Join(home, "started")) {
			if time.Now().After(deadline) {
				t.Fatal("probe did not start")
			}
			time.Sleep(5 * time.Millisecond)
		}
		invalidateAuthProbe(def.ID)
		if err := os.WriteFile(filepath.Join(home, "released"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := <-result; got.status != "needs-auth" {
			t.Fatalf("result after mutation = %q, want re-probed needs-auth", got.status)
		}
		if got := checkAuth(def, home, credentialSources{}); got.status != "needs-auth" {
			t.Fatalf("cached result after mutation = %q, want needs-auth", got.status)
		}
		data, err := os.ReadFile(filepath.Join(home, "probe-count"))
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "xx" {
			t.Fatalf("probe executions = %d, want old flight plus one new generation", len(data))
		}
	})
}

func TestQwenCredentialCleanupPreservesSettings(t *testing.T) {
	home := t.TempDir()
	qwen := filepath.Join(home, ".qwen")
	if err := os.MkdirAll(qwen, 0o700); err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(qwen, "settings.json")
	settings := `{
  "model": {"name": "qwen3-coder-plus"},
  "modelProviders": {
    "openai": [{"id": "qwen3-coder-plus", "envKey": "DASHSCOPE_API_KEY"}]
  },
  "env": {"DASHSCOPE_API_KEY": "current-secret", "OTHER_KEY": "keep"},
  "security": {
    "auth": {"selectedType": "openai", "apiKey": "legacy-secret"},
    "disableYoloMode": true
  }
}`
	if err := os.WriteFile(settingsPath, []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(qwen, ".env"), []byte("OPENAI_API_KEY=secret\nDASHSCOPE_API_KEY=secret\nOTHER=value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	oauth := filepath.Join(qwen, "oauth_creds.json")
	if err := os.WriteFile(oauth, []byte(`{"access_token":"secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	def := &toolDef{
		ID:        "qwen",
		EnvVars:   []string{"OPENAI_API_KEY"},
		AuthFiles: []string{".qwen/oauth_creds.json"},
		AuthCheck: "qwen",
	}
	if err := setEnvironmentCredential(home, "DASHSCOPE_API_KEY", "managed-secret"); err != nil {
		t.Fatalf("seed managed Qwen provider key: %v", err)
	}
	if got := checkAuth(*def, home, credentialSources{}); got.status != "ready" || got.source == nil || *got.source != authSourceNative {
		t.Fatalf("Qwen current settings auth = %+v, want native ready", got)
	}
	if _, _, err := signOutTool(context.Background(), home, def, []toolDef{*def}); err != nil {
		t.Fatal(err)
	}
	if fileExists(oauth) {
		t.Fatal("Qwen OAuth credentials still exist")
	}
	updated, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("Qwen settings were deleted: %v", err)
	}
	if strings.Contains(string(updated), "current-secret") || !strings.Contains(string(updated), "legacy-secret") || !strings.Contains(string(updated), "qwen3-coder-plus") || !strings.Contains(string(updated), "selectedType") || !strings.Contains(string(updated), "OTHER_KEY") {
		t.Fatalf("Qwen settings were not selectively cleaned:\n%s", updated)
	}
	env, err := os.ReadFile(filepath.Join(qwen, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(env), "OPENAI_API_KEY=secret") || strings.Contains(string(env), "DASHSCOPE_API_KEY") || !strings.Contains(string(env), "OTHER=value") {
		t.Fatalf("Qwen .env was not selectively cleaned:\n%s", env)
	}
	managed, err := os.ReadFile(credentialStorePath(home))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(managed), "DASHSCOPE_API_KEY") {
		t.Fatalf("Qwen managed provider key remains:\n%s", managed)
	}
	sources, err := readCredentialSources(home)
	if err != nil {
		t.Fatal(err)
	}
	if got := checkAuth(*def, home, sources); got.status != "needs-auth" {
		t.Fatalf("Qwen auth after cleanup = %q, want needs-auth", got.status)
	}
}

func TestQwenCurrentAndLegacyAuthSources(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("DASHSCOPE_API_KEY", "")
	def := toolDef{EnvVars: []string{"OPENAI_API_KEY"}, AuthCheck: "qwen"}
	tests := []struct {
		name     string
		settings string
		dotenv   string
		status   string
		via      string
	}{
		{
			name:     "current settings env",
			settings: `{"security":{"auth":{"selectedType":"openai"}},"model":{"name":"qwen"},"modelProviders":{"openai":[{"id":"qwen","envKey":"DASHSCOPE_API_KEY"}]},"env":{"DASHSCOPE_API_KEY":"secret"}}`,
			status:   "ready",
			via:      "qwen/settings.json",
		},
		{
			name:     "dynamic provider dotenv",
			settings: `{"security":{"auth":{"selectedType":"openai"}},"model":{"name":"qwen"},"modelProviders":{"openai":[{"id":"qwen","envKey":"DASHSCOPE_API_KEY"}]}}`,
			dotenv:   "DASHSCOPE_API_KEY=secret\n",
			status:   "ready",
			via:      "qwen/.env",
		},
		{
			name:     "deprecated API key with selected type",
			settings: `{"security":{"auth":{"selectedType":"openai","apiKey":"legacy-secret"}}}`,
			status:   "ready",
			via:      "qwen/settings.json",
		},
		{
			name:     "API key without selected type",
			settings: `{"security":{"auth":{"apiKey":"legacy-secret"}}}`,
			status:   "needs-auth",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			qwen := filepath.Join(home, ".qwen")
			if err := os.MkdirAll(qwen, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(qwen, "settings.json"), []byte(tt.settings), 0o600); err != nil {
				t.Fatal(err)
			}
			if tt.dotenv != "" {
				if err := os.WriteFile(filepath.Join(qwen, ".env"), []byte(tt.dotenv), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			got := checkAuth(def, home, credentialSources{})
			if got.status != tt.status {
				t.Fatalf("status = %q, want %q", got.status, tt.status)
			}
			if tt.via != "" && (got.via == nil || *got.via != tt.via || got.source == nil || *got.source != authSourceNative) {
				t.Fatalf("auth result = %+v, want native %q", got, tt.via)
			}
		})
	}
}

func TestQwenDiscontinuedOAuthCacheIsNotReady(t *testing.T) {
	home := t.TempDir()
	qwen := filepath.Join(home, ".qwen")
	if err := os.MkdirAll(qwen, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(qwen, "oauth_creds.json"), []byte(`{"access_token":"stale"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	def := toolDef{
		EnvVars:   []string{"OPENAI_API_KEY"},
		AuthFiles: []string{".qwen/oauth_creds.json"},
		AuthCheck: "qwen",
	}
	t.Setenv("OPENAI_API_KEY", "")
	if got := checkAuth(def, home, credentialSources{}); got.status != "needs-auth" {
		t.Fatalf("stale Qwen OAuth cache status = %q, want needs-auth", got.status)
	}
}

func TestCatalogCommandReceivesKeyOnStdin(t *testing.T) {
	home := t.TempDir()
	script := filepath.Join(home, "persist-key")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nIFS= read -r key\nprintf %s \"$key\" >\"$HOME/native-key\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	secret := `key with spaces and ' quotes`
	if _, err := runBoundedArgv(context.Background(), toolCommandTimeout, []string{script}, secret, nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(home, "native-key"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != secret {
		t.Fatalf("native key = %q, want exact stdin value", data)
	}
}

func TestCredentialCleanupRefusesPathThroughSymlink(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	credential := filepath.Join(outside, "credentials.json")
	if err := os.WriteFile(credential, []byte(`{"token":"keep"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(home, ".vendor")); err != nil {
		t.Fatal(err)
	}
	def := &toolDef{AuthFiles: []string{".vendor/credentials.json"}}
	if _, _, err := signOutTool(context.Background(), home, def, []toolDef{*def}); err == nil {
		t.Fatal("signOutTool followed a credential path through a symlink outside HOME")
	}
	if !fileExists(credential) {
		t.Fatal("credential outside HOME was deleted")
	}
}

// TestCheckAuth covers the auth-priority ladder that moved here from the extension's
// environment.ts (checkAuth is now the sole owner). It exercises checkAuth directly —
// no PATH/LookPath — so it is deterministic from just a fixture HOME and rc map.
func TestCheckAuth(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PROCESS_KEY", "secret")
	// A goose provider config and a non-empty JSON credential for the file cases.
	if err := os.MkdirAll(filepath.Join(home, ".config/goose"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".config/goose/config.yaml"), []byte("GOOSE_PROVIDER: openai\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".acme"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".acme/creds.json"), []byte(`{"token":"t"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".acme/empty.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		def  toolDef
		rc   credentialSources
		want authResult
	}{
		{
			name: "process env remains distinguishable",
			def:  toolDef{EnvVars: []string{"PROCESS_KEY"}},
			want: readyAuth("PROCESS_KEY", authSourceProcessEnv),
		},
		{
			name: "managed rc env var wins over auth file",
			def:  toolDef{EnvVars: []string{"ACME_KEY"}, AuthFiles: []string{".acme/creds.json"}},
			rc:   credentialSources{"ACME_KEY": {managed: true}},
			want: readyAuth("ACME_KEY", authSourceManagedRC),
		},
		{
			name: "manual rc env var remains distinguishable",
			def:  toolDef{EnvVars: []string{"MANUAL_KEY"}},
			rc:   credentialSources{"MANUAL_KEY": {manual: true}},
			want: readyAuth("MANUAL_KEY", authSourceManualRC),
		},
		{
			name: "goose provider config",
			def:  toolDef{AuthCheck: "goose"},
			want: readyAuth("goose (openai)", authSourceNative),
		},
		{
			name: "non-empty json auth file",
			def:  toolDef{AuthFiles: []string{".acme/creds.json"}},
			want: readyAuth("acme/creds.json", authSourceNative),
		},
		{
			name: "empty json auth file is not proof",
			def:  toolDef{AuthFiles: []string{".acme/empty.json"}},
			want: authResult{status: "needs-auth"},
		},
		{
			name: "env vars declared but none set",
			def:  toolDef{EnvVars: []string{"UNSET_KEY"}},
			want: authResult{status: "needs-auth"},
		},
		{
			name: "no detection method",
			def:  toolDef{},
			want: authResult{status: "unknown"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := checkAuth(tc.def, home, tc.rc)
			if got.status != tc.want.status {
				t.Errorf("status = %q, want %q", got.status, tc.want.status)
			}
			if (got.via == nil) != (tc.want.via == nil) || (got.via != nil && *got.via != *tc.want.via) {
				gotVia, wantVia := "<nil>", "<nil>"
				if got.via != nil {
					gotVia = *got.via
				}
				if tc.want.via != nil {
					wantVia = *tc.want.via
				}
				t.Errorf("connectedVia = %q, want %q", gotVia, wantVia)
			}
			if (got.source == nil) != (tc.want.source == nil) || (got.source != nil && *got.source != *tc.want.source) {
				gotSource, wantSource := "<nil>", "<nil>"
				if got.source != nil {
					gotSource = *got.source
				}
				if tc.want.source != nil {
					wantSource = *tc.want.source
				}
				t.Errorf("authSource = %q, want %q", gotSource, wantSource)
			}
		})
	}
}

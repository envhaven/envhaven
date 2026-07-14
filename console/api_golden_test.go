package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// TestHandleToolsGolden locks the /tools wire shape. It reproduces a fixed fixture
// (a two-tool catalog + an rc file granting one of them a key) and asserts handleTools
// emits testdata/tools.golden.json. The SAME golden is validated against the TypeScript
// AITool type by extension/src/__tests__/console-conformance.test.ts, so a field added,
// renamed, or retyped on either side of the Go↔TS boundary breaks a test on that side.
//
// The fixture is deterministic on any unix builder: `sh` is always on PATH (installed:true),
// `envhaven-absent-cmd-xyz` never is (installed:false, which gates its auth to needs-auth),
// and ALPHA_KEY is granted only through the rc file (exercising parseRcEnvVars, not the env).
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
	// firstSetEnvVar treats empty as unset, so t.Setenv("...", "") both blanks
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
// shells out to `npx skills`), so fixture values marshal directly — writeJSON emits
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
		Description string    `json:"description"`
		Tools       []toolDef `json:"tools"`
		EnvVarMeta  map[string]struct {
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

	if len(tools) != 15 {
		t.Fatalf("catalog has %d tools, want 15 (adding a tool? update this count)", len(tools))
	}
	seen := map[string]bool{}
	for _, d := range tools {
		if d.ID == "" || seen[d.ID] {
			t.Errorf("tool id %q is empty or duplicated", d.ID)
		}
		seen[d.ID] = true
		if d.Command == "" {
			t.Errorf("tool %q has an empty command", d.ID)
		}
		for _, v := range d.EnvVars {
			if _, ok := catalog.EnvVarMeta[v]; !ok {
				t.Errorf("tool %q envVar %q has no envVarMeta entry", d.ID, v)
			}
		}
	}
}

// TestCheckAuth covers the auth-priority ladder that moved here from the extension's
// environment.ts (checkAuth is now the sole owner). It exercises checkAuth directly —
// no PATH/LookPath — so it is deterministic from just a fixture HOME and rc map.
func TestCheckAuth(t *testing.T) {
	home := t.TempDir()
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

	via := func(s string) *string { return &s }
	cases := []struct {
		name string
		def  toolDef
		rc   map[string]bool
		want authResult
	}{
		{
			name: "env var wins over auth file",
			def:  toolDef{EnvVars: []string{"ACME_KEY"}, AuthFiles: []string{".acme/creds.json"}},
			rc:   map[string]bool{"ACME_KEY": true},
			want: authResult{"ready", via("ACME_KEY")},
		},
		{
			name: "goose provider config",
			def:  toolDef{AuthCheck: "goose"},
			want: authResult{"ready", via("goose (openai)")},
		},
		{
			name: "non-empty json auth file",
			def:  toolDef{AuthFiles: []string{".acme/creds.json"}},
			want: authResult{"ready", via("acme/creds.json")},
		},
		{
			name: "empty json auth file is not proof",
			def:  toolDef{AuthFiles: []string{".acme/empty.json"}},
			want: authResult{"needs-auth", nil},
		},
		{
			name: "env vars declared but none set",
			def:  toolDef{EnvVars: []string{"UNSET_KEY"}},
			want: authResult{"needs-auth", nil},
		},
		{
			name: "no detection method",
			def:  toolDef{},
			want: authResult{"unknown", nil},
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
		})
	}
}

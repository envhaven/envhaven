package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestHandleEnv covers the env-var resource: GET lists credential names annotated with
// the catalog tools that use each (and never a value), POST upserts a credential in the
// managed store behind the name/value/reserved gates, and DELETE removes one.
func TestHandleEnv(t *testing.T) {
	dir := t.TempDir()
	defs := filepath.Join(dir, "tool-definitions.json")
	if err := os.WriteFile(defs, []byte(`{"tools":[
		{"id":"claude","name":"Claude Code","command":"sh","authCommand":"x","envVars":["ANTHROPIC_API_KEY"],"authFiles":[]},
		{"id":"opencode","name":"OpenCode","command":"sh","authCommand":"y","envVars":["ANTHROPIC_API_KEY","OPENAI_API_KEY"],"authFiles":[]}
	]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	prev := toolDefsPath
	toolDefsPath = defs
	t.Cleanup(func() { toolDefsPath = prev })

	home := t.TempDir()
	t.Setenv("HOME", home)
	// ZSH is a framework export and must never be listed. The marked exports are
	// legacy EnvHaven credentials with distinctive values so a leak is visible.
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte(
		"export ZSH='/config/.oh-my-zsh'\n"+
			"export MANUAL_TOKEN='keep'\n"+
			"export ANTHROPIC_API_KEY='sekret-anthropic' # envhaven\n"+
			"export MY_APP_TOKEN='sekret-token' # envhaven\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}

	post := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		handleEnv(w, httptest.NewRequest(http.MethodPost, "/__console/env", strings.NewReader(body)))
		return w
	}
	del := func(name string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		handleEnv(w, httptest.NewRequest(http.MethodDelete, "/__console/env?name="+name, nil))
		return w
	}
	list := func() (*httptest.ResponseRecorder, []envVarView) {
		t.Helper()
		w := httptest.NewRecorder()
		handleEnv(w, httptest.NewRequest(http.MethodGet, "/__console/env", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("GET /env status = %d", w.Code)
		}
		var resp struct {
			Vars []envVarView `json:"vars"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal /env: %v", err)
		}
		return w, resp.Vars
	}

	t.Run("list is names + catalog tools, sorted, never values", func(t *testing.T) {
		w, vars := list()
		if strings.Contains(w.Body.String(), "sekret") {
			t.Fatalf("GET /env leaked a value:\n%s", w.Body.String())
		}
		if slicesHasName(vars, "ZSH") {
			t.Error("framework export ZSH must never be listed")
		}
		if len(vars) != 2 || vars[0].Name != "ANTHROPIC_API_KEY" || vars[1].Name != "MY_APP_TOKEN" {
			t.Fatalf("vars = %+v, want [ANTHROPIC_API_KEY MY_APP_TOKEN]", vars)
		}
		if len(vars[0].Tools) != 2 || vars[0].Tools[0] != "Claude Code" || vars[0].Tools[1] != "OpenCode" {
			t.Errorf("ANTHROPIC_API_KEY tools = %v, want [Claude Code OpenCode]", vars[0].Tools)
		}
		if len(vars[1].Tools) != 0 {
			t.Errorf("MY_APP_TOKEN tools = %v, want []", vars[1].Tools)
		}
	})

	t.Run("set migrates legacy exports and writes the managed store", func(t *testing.T) {
		if w := post(`{"name":"NEW_VAR","value":"hello"}`); w.Code != http.StatusOK {
			t.Fatalf("set status = %d (%s)", w.Code, w.Body.String())
		}
		data, err := os.ReadFile(credentialStorePath(home))
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range []string{
			`export ANTHROPIC_API_KEY='sekret-anthropic'`,
			`export MY_APP_TOKEN='sekret-token'`,
			`export NEW_VAR='hello'`,
		} {
			if !strings.Contains(string(data), line) {
				t.Errorf("managed store missing %q:\n%s", line, data)
			}
		}
		rcData, err := os.ReadFile(filepath.Join(home, ".zshrc"))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(rcData), "# envhaven") || !strings.Contains(string(rcData), "MANUAL_TOKEN") {
			t.Fatalf("legacy migration changed manual exports or kept owned lines:\n%s", rcData)
		}
		if _, vars := list(); !slicesHasName(vars, "NEW_VAR") {
			t.Error("NEW_VAR not listed after set")
		}
	})

	t.Run("validation gate", func(t *testing.T) {
		cases := []struct {
			name, body string
			want       int
		}{
			{"invalid body", `nope`, http.StatusBadRequest},
			{"bad name", `{"name":"1BAD","value":"x"}`, http.StatusBadRequest},
			{"name with space", `{"name":"A B","value":"x"}`, http.StatusBadRequest},
			{"reserved shell var", `{"name":"PATH","value":"/x"}`, http.StatusBadRequest},
			{"reserved managed namespace", `{"name":"ENVHAVEN_FOO","value":"x"}`, http.StatusBadRequest},
			{"empty value", `{"name":"OK_NAME","value":"   "}`, http.StatusBadRequest},
			{"newline value", `{"name":"OK_NAME","value":"a\nb"}`, http.StatusBadRequest},
		}
		for _, c := range cases {
			t.Run(c.name, func(t *testing.T) {
				if w := post(c.body); w.Code != c.want {
					t.Fatalf("status = %d, want %d (%s)", w.Code, c.want, w.Body.String())
				}
			})
		}
	})

	t.Run("delete removes the credential and is idempotent", func(t *testing.T) {
		if w := del("MY_APP_TOKEN"); w.Code != http.StatusOK {
			t.Fatalf("delete status = %d", w.Code)
		}
		data, _ := os.ReadFile(credentialStorePath(home))
		if strings.Contains(string(data), "MY_APP_TOKEN") {
			t.Errorf("managed store still has MY_APP_TOKEN:\n%s", data)
		}
		if _, vars := list(); slicesHasName(vars, "MY_APP_TOKEN") {
			t.Error("MY_APP_TOKEN still listed after delete")
		}
		if w := del("MY_APP_TOKEN"); w.Code != http.StatusOK {
			t.Errorf("second delete status = %d, want 200 (idempotent)", w.Code)
		}
		if w := del("1BAD"); w.Code != http.StatusBadRequest {
			t.Errorf("delete of invalid name = %d, want 400", w.Code)
		}
	})

	t.Run("delete never removes a manual export", func(t *testing.T) {
		if w := del("MANUAL_TOKEN"); w.Code != http.StatusOK {
			t.Fatalf("delete status = %d", w.Code)
		}
		data, err := os.ReadFile(filepath.Join(home, ".zshrc"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "export MANUAL_TOKEN='keep'") {
			t.Fatalf("manual export was removed:\n%s", data)
		}
	})

	t.Run("set overlays a manual export without taking ownership", func(t *testing.T) {
		if w := post(`{"name":"MANUAL_TOKEN","value":"managed-value"}`); w.Code != http.StatusOK {
			t.Fatalf("set status = %d (%s)", w.Code, w.Body.String())
		}
		data, err := os.ReadFile(filepath.Join(home, ".zshrc"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "export MANUAL_TOKEN='keep'") || strings.Contains(string(data), "managed-value") {
			t.Fatalf("manual rc export changed:\n%s", data)
		}
		managed, err := os.ReadFile(credentialStorePath(home))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(managed), "export MANUAL_TOKEN='managed-value'") {
			t.Fatalf("managed overlay missing:\n%s", managed)
		}
		if w := del("MANUAL_TOKEN"); w.Code != http.StatusOK {
			t.Fatalf("delete status = %d", w.Code)
		}
		data, err = os.ReadFile(filepath.Join(home, ".zshrc"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "export MANUAL_TOKEN='keep'") {
			t.Fatalf("delete did not preserve the manual export:\n%s", data)
		}
		managed, err = os.ReadFile(credentialStorePath(home))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(managed), "MANUAL_TOKEN") {
			t.Fatalf("delete kept the managed overlay:\n%s", managed)
		}
	})

	t.Run("non-GET/POST/DELETE is 405", func(t *testing.T) {
		w := httptest.NewRecorder()
		handleEnv(w, httptest.NewRequest(http.MethodPut, "/__console/env", nil))
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", w.Code)
		}
	})
}

func slicesHasName(vars []envVarView, name string) bool {
	for _, v := range vars {
		if v.Name == name {
			return true
		}
	}
	return false
}

// TestCredentialHandlersReportStoreProblems: a store line EnvHaven never writes fails
// every credential request, and the 500 names the file and the line so the user can
// fix it, never the value.
func TestCredentialHandlersReportStoreProblems(t *testing.T) {
	defs := filepath.Join(t.TempDir(), "tool-definitions.json")
	if err := os.WriteFile(defs, []byte(`{"tools":[{"id":"alpha","name":"Alpha","command":"sh","envVars":["ALPHA_KEY"],"authFiles":[]}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	prev := toolDefsPath
	toolDefsPath = defs
	t.Cleanup(func() { toolDefsPath = prev })
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeManagedStore(t, home, "OPENAI_API_KEY='sk-bare-secret'\n")

	const want = "~/.config/envhaven/environment: line 2 is not a comment or an export NAME=value line"
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/__console/env", nil),
		httptest.NewRequest(http.MethodPost, "/__console/env", strings.NewReader(`{"name":"OTHER_KEY","value":"x"}`)),
		httptest.NewRequest(http.MethodDelete, "/__console/env?name=OPENAI_API_KEY", nil),
		httptest.NewRequest(http.MethodGet, "/__console/tools", nil),
		httptest.NewRequest(http.MethodPost, "/__console/tools", strings.NewReader(`{"action":"set-key","toolId":"alpha","envVar":"ALPHA_KEY","key":"x"}`)),
	} {
		t.Run(request.Method+" "+request.URL.Path, func(t *testing.T) {
			w := httptest.NewRecorder()
			if request.URL.Path == "/__console/env" {
				handleEnv(w, request)
			} else {
				handleTools(w, request)
			}
			var body struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if w.Code != http.StatusInternalServerError || body.Error != want {
				t.Fatalf("status = %d, error = %q; want 500 %q", w.Code, body.Error, want)
			}
			if strings.Contains(w.Body.String(), "sk-bare-secret") {
				t.Fatalf("response leaked the value: %s", w.Body.String())
			}
		})
	}
}

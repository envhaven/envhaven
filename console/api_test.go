package main

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// okHandler records whether it was reached and returns 200; the shared handler
// stub for the guard tests.
func okHandler(reached *bool) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		*reached = true
		w.WriteHeader(http.StatusOK)
	}
}

// TestWithAPIGuard pins the shared API guard: the OPTIONS preflight answers 204
// with CORS headers and never runs auth or the handler; the Allow-Origin header
// appears ONLY for an allowlisted Origin; a missing or invalid bearer is a 401
// that never reaches the handler; and a valid bearer passes through.
func TestWithAPIGuard(t *testing.T) {
	allowed := []string{"https://envhaven.com"}
	pass := func(string) error { return nil }
	fail := func(string) error { return errUnauthorized }

	t.Run("OPTIONS preflight allowed origin", func(t *testing.T) {
		var reached bool
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodOptions, "/__console/stats", nil)
		r.Header.Set("Origin", "https://envhaven.com")
		withAPI(pass, allowed, okHandler(&reached))(w, r)

		if w.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", w.Code)
		}
		if reached {
			t.Fatal("OPTIONS must not reach the handler")
		}
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://envhaven.com" {
			t.Fatalf("Allow-Origin = %q, want the echoed origin", got)
		}
		if got := w.Header().Get("Vary"); got != "Origin" {
			t.Fatalf("Vary = %q, want Origin", got)
		}
		if got := w.Header().Get("Access-Control-Allow-Methods"); got != "GET, POST, DELETE, OPTIONS" {
			t.Fatalf("Allow-Methods = %q", got)
		}
		if got := w.Header().Get("Access-Control-Allow-Headers"); got != "authorization, content-type" {
			t.Fatalf("Allow-Headers = %q", got)
		}
	})

	t.Run("OPTIONS disallowed origin gets no Allow-Origin", func(t *testing.T) {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodOptions, "/__console/stats", nil)
		r.Header.Set("Origin", "https://ws-abc.envhaven.com") // the never-widen invariant
		withAPI(pass, allowed, okHandler(new(bool)))(w, r)

		if w.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", w.Code)
		}
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("Allow-Origin = %q, want empty for a disallowed origin", got)
		}
	})

	t.Run("missing bearer is 401", func(t *testing.T) {
		var reached bool
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/__console/stats", nil)
		withAPI(pass, allowed, okHandler(&reached))(w, r)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
		if reached {
			t.Fatal("handler reached without a bearer")
		}
	})

	t.Run("invalid bearer is 401", func(t *testing.T) {
		var reached bool
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/__console/stats", nil)
		r.Header.Set("Authorization", "Bearer nope")
		withAPI(fail, allowed, okHandler(&reached))(w, r)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
		if reached {
			t.Fatal("handler reached on an invalid token")
		}
	})

	t.Run("valid bearer reaches the handler", func(t *testing.T) {
		var reached bool
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/__console/stats", nil)
		r.Header.Set("Authorization", "Bearer good")
		r.Header.Set("Origin", "https://envhaven.com")
		withAPI(pass, allowed, okHandler(&reached))(w, r)

		if !reached {
			t.Fatalf("valid token did not reach the handler (status %d)", w.Code)
		}
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://envhaven.com" {
			t.Fatalf("Allow-Origin = %q on the real response", got)
		}
	})
}

// TestWithAPINilOrigins pins the self-host CORS posture: with a nil (or empty)
// allowlist — what the self-host newHandler branch passes — Access-Control-
// Allow-Origin is NEVER emitted, not on the preflight and not on an authorized
// response, so the API stays same-origin only, at parity with the socket.
func TestWithAPINilOrigins(t *testing.T) {
	pass := func(string) error { return nil }
	for _, origins := range [][]string{nil, {}} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodOptions, "/__console/stats", nil)
		r.Header.Set("Origin", "https://envhaven.com")
		withAPI(pass, origins, okHandler(new(bool)))(w, r)
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("preflight Allow-Origin = %q with allowlist %v, want never emitted", got, origins)
		}

		w = httptest.NewRecorder()
		r = httptest.NewRequest(http.MethodGet, "/__console/stats", nil)
		r.Header.Set("Origin", "https://envhaven.com")
		r.Header.Set("Authorization", "Bearer good")
		withAPI(pass, origins, okHandler(new(bool)))(w, r)
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("response Allow-Origin = %q with allowlist %v, want never emitted", got, origins)
		}
	}
}

// TestWithAPIManagedToken exercises the guard against the REAL factored
// jwtAuth.verify (via the JWKS fixture in main_test.go): a valid managed token
// reaches the handler, and a token for the wrong workspace is mapped to a flat
// 401 by the guard (verify's own 403 is not propagated to the API surface).
func TestWithAPIManagedToken(t *testing.T) {
	jwks, _, signEdDSA := newJWTFixture(t)
	auth := &jwtAuth{jwks: jwks, workspaceID: "ws_test"}
	origins := []string{"https://envhaven.com"}

	t.Run("valid managed token reaches handler", func(t *testing.T) {
		var reached bool
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/__console/stats", nil)
		r.Header.Set("Authorization", "Bearer "+signEdDSA(validClaims("ws_test")))
		withAPI(auth.verify, origins, okHandler(&reached))(w, r)
		if !reached {
			t.Fatalf("valid managed token rejected (status %d)", w.Code)
		}
	})

	t.Run("wrong workspace is 401", func(t *testing.T) {
		var reached bool
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/__console/stats", nil)
		r.Header.Set("Authorization", "Bearer "+signEdDSA(validClaims("ws_other")))
		withAPI(auth.verify, origins, okHandler(&reached))(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
		if reached {
			t.Fatal("wrong-workspace token reached the handler")
		}
	})
}

// TestHandleActionValidation pins the action allowlist: only the six known
// actions are accepted, an unknown or auth-less tool is rejected, the window
// index must be present and non-negative, and an artifact name that escapes the
// drop folder is refused — all BEFORE any tmux process is spawned.
func TestHandleActionValidation(t *testing.T) {
	dir := t.TempDir()
	defs := filepath.Join(dir, "tool-definitions.json")
	if err := os.WriteFile(defs, []byte(`{"tools":[
		{"id":"claude","name":"Claude Code","command":"claude","authCommand":"claude-auth-helper"},
		{"id":"aider","name":"Aider","command":"aider","authCommand":null}
	]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	prev := toolDefsPath
	toolDefsPath = defs
	t.Cleanup(func() { toolDefsPath = prev })

	cases := []struct {
		name, body string
		want       int
	}{
		{"unknown action", `{"action":"frobnicate"}`, http.StatusBadRequest},
		{"unknown tool", `{"action":"launch","toolId":"ghost"}`, http.StatusBadRequest},
		{"connect null authCommand", `{"action":"connect","toolId":"aider"}`, http.StatusBadRequest},
		{"select negative index", `{"action":"select-window","index":-1}`, http.StatusBadRequest},
		{"select missing index", `{"action":"select-window"}`, http.StatusBadRequest},
		{"kill missing index", `{"action":"kill-window"}`, http.StatusBadRequest},
		{"insert-path traversal", `{"action":"insert-path","name":"../etc/passwd"}`, http.StatusBadRequest},
		{"insert-path absent file", `{"action":"insert-path","name":"definitely-absent-xyz.bin"}`, http.StatusBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/__console/action", strings.NewReader(c.body))
			handleAction(w, r)
			if w.Code != c.want {
				t.Fatalf("status = %d, want %d (body %q)", w.Code, c.want, w.Body.String())
			}
		})
	}

	t.Run("non-POST is 405", func(t *testing.T) {
		w := httptest.NewRecorder()
		handleAction(w, httptest.NewRequest(http.MethodGet, "/__console/action", nil))
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", w.Code)
		}
	})
}

// TestHandleToolMutation covers POST /__console/tools: the set-key upsert (both rc
// files, replace-in-place, safe quoting) and sign-out (strip exports + delete auth
// files), the validation gate, and the round trip back through GET /tools — the tool
// that starts needs-auth reads ready after set-key and needs-auth again after sign-out,
// proving the write twin agrees with the checkAuth read ladder. `sh` stands in for every
// tool command so both are installed:true and reach checkAuth.
func TestHandleToolMutation(t *testing.T) {
	dir := t.TempDir()
	defs := filepath.Join(dir, "tool-definitions.json")
	if err := os.WriteFile(defs, []byte(`{"tools":[
		{"id":"claude","name":"Claude Code","command":"sh","authCommand":"claude-auth-helper","envVars":["ANTHROPIC_API_KEY"],"authFiles":[".claude/.credentials.json"]},
		{"id":"aider","name":"Aider","command":"sh","authCommand":null,"envVars":["OPENAI_API_KEY"],"authFiles":[]}
	]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	prev := toolDefsPath
	toolDefsPath = defs
	t.Cleanup(func() { toolDefsPath = prev })

	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, rc := range []string{".zshrc", ".bashrc"} {
		if err := os.WriteFile(filepath.Join(home, rc), []byte("# rc\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Auth must come from the rc file we write, never an ambient env var.
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")

	post := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		handleTools(w, httptest.NewRequest(http.MethodPost, "/__console/tools", strings.NewReader(body)))
		return w
	}
	connectedVia := func(id string) *string {
		t.Helper()
		w := httptest.NewRecorder()
		handleTools(w, httptest.NewRequest(http.MethodGet, "/__console/tools", nil))
		var resp struct {
			Tools []struct {
				ID           string  `json:"id"`
				ConnectedVia *string `json:"connectedVia"`
			} `json:"tools"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal /tools: %v", err)
		}
		for _, tl := range resp.Tools {
			if tl.ID == id {
				return tl.ConnectedVia
			}
		}
		t.Fatalf("tool %q absent from /tools", id)
		return nil
	}

	invalid := []struct {
		name, body string
		want       int
	}{
		{"invalid body", `not json`, http.StatusBadRequest},
		{"unknown action", `{"action":"frobnicate","toolId":"claude"}`, http.StatusBadRequest},
		{"unknown tool", `{"action":"set-key","toolId":"ghost","envVar":"ANTHROPIC_API_KEY","key":"x"}`, http.StatusBadRequest},
		{"env var not declared by tool", `{"action":"set-key","toolId":"claude","envVar":"OPENAI_API_KEY","key":"x"}`, http.StatusBadRequest},
		{"empty key", `{"action":"set-key","toolId":"claude","envVar":"ANTHROPIC_API_KEY","key":"   "}`, http.StatusBadRequest},
		{"newline in key", `{"action":"set-key","toolId":"claude","envVar":"ANTHROPIC_API_KEY","key":"a\nb"}`, http.StatusBadRequest},
		{"sign-out unknown tool", `{"action":"sign-out","toolId":"ghost"}`, http.StatusBadRequest},
	}
	for _, c := range invalid {
		t.Run(c.name, func(t *testing.T) {
			if w := post(c.body); w.Code != c.want {
				t.Fatalf("status = %d, want %d (body %q)", w.Code, c.want, w.Body.String())
			}
		})
	}

	t.Run("non-GET/POST is 405", func(t *testing.T) {
		w := httptest.NewRecorder()
		handleTools(w, httptest.NewRequest(http.MethodDelete, "/__console/tools", nil))
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", w.Code)
		}
	})

	t.Run("set-key writes both rc files and flips the tool ready", func(t *testing.T) {
		if w := post(`{"action":"set-key","toolId":"claude","envVar":"ANTHROPIC_API_KEY","key":"sk-ant-secret"}`); w.Code != http.StatusOK {
			t.Fatalf("set-key status = %d, want 200 (%s)", w.Code, w.Body.String())
		}
		for _, rc := range []string{".zshrc", ".bashrc"} {
			data, _ := os.ReadFile(filepath.Join(home, rc))
			if !strings.Contains(string(data), `export ANTHROPIC_API_KEY='sk-ant-secret'`) {
				t.Errorf("%s missing the export line, got:\n%s", rc, data)
			}
		}
		if via := connectedVia("claude"); via == nil || *via != "ANTHROPIC_API_KEY" {
			t.Errorf("connectedVia = %v, want ANTHROPIC_API_KEY", via)
		}
	})

	t.Run("set-key upserts in place and quotes safely", func(t *testing.T) {
		// A key with a single quote must survive verbatim on one line, and a second
		// set-key must replace the existing export rather than append a duplicate.
		if w := post(`{"action":"set-key","toolId":"claude","envVar":"ANTHROPIC_API_KEY","key":"a'b-rotated"}`); w.Code != http.StatusOK {
			t.Fatalf("rotate status = %d", w.Code)
		}
		data, _ := os.ReadFile(filepath.Join(home, ".zshrc"))
		if n := strings.Count(string(data), "export ANTHROPIC_API_KEY="); n != 1 {
			t.Fatalf("want exactly one export line after upsert, got %d:\n%s", n, data)
		}
		if !strings.Contains(string(data), `export ANTHROPIC_API_KEY='a'\''b-rotated'`) {
			t.Errorf("quote not escaped as close-escape-reopen:\n%s", data)
		}
	})

	t.Run("sign-out strips exports, deletes auth files, and clears ready", func(t *testing.T) {
		credDir := filepath.Join(home, ".claude")
		if err := os.MkdirAll(credDir, 0o755); err != nil {
			t.Fatal(err)
		}
		cred := filepath.Join(credDir, ".credentials.json")
		if err := os.WriteFile(cred, []byte(`{"t":"x"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if w := post(`{"action":"sign-out","toolId":"claude"}`); w.Code != http.StatusOK {
			t.Fatalf("sign-out status = %d (%s)", w.Code, w.Body.String())
		}
		for _, rc := range []string{".zshrc", ".bashrc"} {
			data, _ := os.ReadFile(filepath.Join(home, rc))
			if strings.Contains(string(data), "ANTHROPIC_API_KEY") {
				t.Errorf("%s still carries the export after sign-out:\n%s", rc, data)
			}
		}
		if fileExists(cred) {
			t.Errorf("sign-out did not delete the auth file %s", cred)
		}
		if via := connectedVia("claude"); via != nil {
			t.Errorf("connectedVia = %q after sign-out, want nil", *via)
		}
	})
}

// TestHandleEnv covers the env-var resource: GET lists exported names annotated with
// the catalog tools that use each (and NEVER a value), POST upserts an export into both
// rc files behind the name/value/reserved gates, and DELETE strips one. It shares the
// toolDefsPath + HOME fixture seams with the other handler tests.
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
	// A framework export (oh-my-zsh's ZSH — must NEVER be listed), plus one vendor and one custom
	// managed export carrying the marker, with distinctive values so a leak is visible.
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte(
		"export ZSH='/config/.oh-my-zsh'\n"+
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

	t.Run("set writes a marked export into both rc files and lists it", func(t *testing.T) {
		if w := post(`{"name":"NEW_VAR","value":"hello"}`); w.Code != http.StatusOK {
			t.Fatalf("set status = %d (%s)", w.Code, w.Body.String())
		}
		for _, rc := range []string{".zshrc", ".bashrc"} {
			data, _ := os.ReadFile(filepath.Join(home, rc))
			if !strings.Contains(string(data), `export NEW_VAR='hello' # envhaven`) {
				t.Errorf("%s missing marked NEW_VAR:\n%s", rc, data)
			}
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

	t.Run("delete strips the export and is idempotent", func(t *testing.T) {
		if w := del("MY_APP_TOKEN"); w.Code != http.StatusOK {
			t.Fatalf("delete status = %d", w.Code)
		}
		data, _ := os.ReadFile(filepath.Join(home, ".zshrc"))
		if strings.Contains(string(data), "MY_APP_TOKEN") {
			t.Errorf(".zshrc still has MY_APP_TOKEN:\n%s", data)
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

// TestSanitizeArtifactName pins the filename gate shared by insert-path, upload,
// and raw download: only a bare filename inside the drop folder is accepted, and
// every traversal / separator / control-char / header-breaking form is refused.
func TestSanitizeArtifactName(t *testing.T) {
	reject := []string{
		"", ".", "..", "../etc/passwd", "a/b", "x/../y", "foo..bar",
		"nul\x00byte", "ctrl\x01char", `quote"name`, `back\slash`,
	}
	for _, n := range reject {
		if _, ok := sanitizeArtifactName(n); ok {
			t.Fatalf("sanitizeArtifactName(%q) accepted, want reject", n)
		}
	}
	accept := []string{"report.pdf", "notes.txt", "image (2).png", ".hidden", "a.b.c"}
	for _, n := range accept {
		if got, ok := sanitizeArtifactName(n); !ok || got != n {
			t.Fatalf("sanitizeArtifactName(%q) = (%q, %v), want (%q, true)", n, got, ok, n)
		}
	}
}

// TestParseCPUSample pins the /proc/stat aggregate parser: idle is the idle
// column, total sums user..steal (fields 1..8, guest columns excluded — the
// extension's resource-monitor arithmetic), and every malformed shape reports
// !ok rather than a half-parsed sample.
func TestParseCPUSample(t *testing.T) {
	cases := []struct {
		name, data  string
		idle, total uint64
		ok          bool
	}{
		// 90 is the guest column: present, but never summed into total.
		{"canonical", "cpu  10 20 30 40 50 60 70 80 90\ncpu0 1 2 3 4 5 6 7 8 9\n", 40, 360, true},
		{"single line no newline", "cpu 1 2 3 4 5 6 7 8", 4, 36, true},
		{"too few fields", "cpu 1 2 3", 0, 0, false},
		{"wrong prefix", "intr 1 2 3 4 5 6 7 8 9", 0, 0, false},
		{"junk jiffies", "cpu 1 2 x 4 5 6 7 8", 0, 0, false},
		{"empty", "", 0, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			idle, total, ok := parseCPUSample(c.data)
			if idle != c.idle || total != c.total || ok != c.ok {
				t.Fatalf("parseCPUSample = (%d, %d, %v), want (%d, %d, %v)", idle, total, ok, c.idle, c.total, c.ok)
			}
		})
	}
}

// TestParseMemInfo pins the /proc/meminfo parser: MemTotal/MemAvailable in kB,
// with an absent or malformed row reading as zero (which ramSnapshot maps to
// an empty gauge rather than a fabricated one).
func TestParseMemInfo(t *testing.T) {
	cases := []struct {
		name, data       string
		totalKb, availKb uint64
	}{
		{"canonical", "MemTotal:       16384 kB\nMemFree:        1024 kB\nMemAvailable:    8192 kB\n", 16384, 8192},
		{"missing MemAvailable", "MemTotal: 16384 kB\n", 16384, 0},
		{"short row skipped", "MemTotal:\nMemAvailable: 512 kB\n", 0, 512},
		{"empty", "", 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			total, avail := parseMemInfo(strings.NewReader(c.data))
			if total != c.totalKb || avail != c.availKb {
				t.Fatalf("parseMemInfo = (%d, %d), want (%d, %d)", total, avail, c.totalKb, c.availKb)
			}
		})
	}
}

// withArtifactsDir points artifactsDir at a fixture directory for one test
// (the toolDefsPath seam pattern).
func withArtifactsDir(t *testing.T, dir string) {
	t.Helper()
	prev := artifactsDir
	artifactsDir = dir
	t.Cleanup(func() { artifactsDir = prev })
}

// uploadRequest builds a multipart POST carrying one file field — the shape
// the dashboard's upload form sends.
func uploadRequest(t *testing.T, filename, content string) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(fw, content); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/__console/artifacts", &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	return r
}

// assertJSONError requires the response body to be the {"error": msg} shape —
// the pin that no handler regresses to a text/plain http.Error.
func assertJSONError(t *testing.T, w *httptest.ResponseRecorder, msg string) {
	t.Helper()
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("error content-type = %q, want application/json", ct)
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("error body %q is not JSON: %v", w.Body.String(), err)
	}
	if resp["error"] != msg {
		t.Fatalf("error = %q, want %q", resp["error"], msg)
	}
}

// TestArtifactUpload drives the real multipart handler over a fixture dir: a
// fresh name lands verbatim with its exact bytes, and a colliding name gets
// the " (2)" suffix instead of clobbering the existing file.
func TestArtifactUpload(t *testing.T) {
	dir := t.TempDir()
	withArtifactsDir(t, dir)

	w := httptest.NewRecorder()
	handleArtifacts(w, uploadRequest(t, "report.pdf", "first"))
	if w.Code != http.StatusOK {
		t.Fatalf("upload = %d (body %q)", w.Code, w.Body.String())
	}
	var resp struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp.Name != "report.pdf" {
		t.Fatalf("upload name = %q (err %v), want report.pdf", resp.Name, err)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "report.pdf")); err != nil || string(data) != "first" {
		t.Fatalf("stored bytes = %q (err %v), want %q", data, err, "first")
	}

	// Same filename again: the upload must land beside, never over, the first.
	w = httptest.NewRecorder()
	handleArtifacts(w, uploadRequest(t, "report.pdf", "second"))
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp.Name != "report (2).pdf" {
		t.Fatalf("collision name = %q (err %v), want report (2).pdf", resp.Name, err)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "report.pdf")); string(data) != "first" {
		t.Fatalf("original clobbered: %q", data)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "report (2).pdf")); string(data) != "second" {
		t.Fatalf("suffixed bytes = %q, want %q", data, "second")
	}
}

// TestArtifactList pins the listing contract: newest mtime first, directories
// skipped, and a missing drop folder reads as an empty list, never an error.
func TestArtifactList(t *testing.T) {
	dir := t.TempDir()
	withArtifactsDir(t, dir)
	write := func(name string, age time.Duration) {
		t.Helper()
		full := filepath.Join(dir, name)
		if err := os.WriteFile(full, []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
		mtime := time.Now().Add(-age)
		if err := os.Chtimes(full, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	write("old.txt", time.Hour)
	write("new.txt", 0)
	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0o755); err != nil {
		t.Fatal(err)
	}

	list := func() []artifact {
		t.Helper()
		w := httptest.NewRecorder()
		handleArtifacts(w, httptest.NewRequest(http.MethodGet, "/__console/artifacts", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("list = %d", w.Code)
		}
		var resp struct {
			Artifacts []artifact `json:"artifacts"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if resp.Artifacts == nil {
			t.Fatal("artifacts is null, want []")
		}
		return resp.Artifacts
	}

	got := list()
	if len(got) != 2 || got[0].Name != "new.txt" || got[1].Name != "old.txt" {
		t.Fatalf("list = %+v, want [new.txt old.txt] (mtime-desc, files only)", got)
	}

	withArtifactsDir(t, filepath.Join(dir, "absent"))
	if got := list(); len(got) != 0 {
		t.Fatalf("missing dir list = %+v, want empty", got)
	}
}

// TestArtifactDelete: deleting an existing file succeeds and removes it; a
// second delete of the same name is a 404 — and, like every artifacts miss, a
// JSON 404, so the API error surface stays uniform.
func TestArtifactDelete(t *testing.T) {
	dir := t.TempDir()
	withArtifactsDir(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "doomed.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	handleArtifacts(w, httptest.NewRequest(http.MethodDelete, "/__console/artifacts?name=doomed.txt", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("delete = %d (body %q)", w.Code, w.Body.String())
	}
	if fileExists(filepath.Join(dir, "doomed.txt")) {
		t.Fatal("file still exists after delete")
	}

	w = httptest.NewRecorder()
	handleArtifacts(w, httptest.NewRequest(http.MethodDelete, "/__console/artifacts?name=doomed.txt", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("second delete = %d, want 404", w.Code)
	}
	assertJSONError(t, w, "not found")
}

// TestArtifactRaw pins the download route: an existing artifact streams back
// with an attachment Content-Disposition, and a missing one is a JSON 404.
func TestArtifactRaw(t *testing.T) {
	dir := t.TempDir()
	withArtifactsDir(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	handleArtifactRaw(w, httptest.NewRequest(http.MethodGet, "/__console/artifacts/raw?name=notes.txt", nil))
	if w.Code != http.StatusOK || w.Body.String() != "hello" {
		t.Fatalf("raw = %d body %q, want 200 %q", w.Code, w.Body.String(), "hello")
	}
	if got := w.Header().Get("Content-Disposition"); got != `attachment; filename="notes.txt"` {
		t.Fatalf("Content-Disposition = %q", got)
	}

	w = httptest.NewRecorder()
	handleArtifactRaw(w, httptest.NewRequest(http.MethodGet, "/__console/artifacts/raw?name=absent.txt", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing raw = %d, want 404", w.Code)
	}
	assertJSONError(t, w, "not found")
}

func TestParseWindows(t *testing.T) {
	// The name is the last field, so a '|' inside a renamed window stays whole;
	// malformed lines (too few fields, non-integer index) are skipped, not half-read.
	got := parseWindows("0|1|zsh\n1|0|my|piped|name\n2|0|\nonlyone\nx|0|badidx\n3|0|tail")
	want := []window{
		{Index: 0, Name: "zsh", Active: true},
		{Index: 1, Name: "my|piped|name", Active: false},
		{Index: 2, Name: "", Active: false},
		{Index: 3, Name: "tail", Active: false},
	}
	if len(got) != len(want) {
		t.Fatalf("parseWindows len = %d, want %d (%+v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("window[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
	// An absent session (empty output) is an empty, non-nil slice so the JSON is [].
	if ws := parseWindows(""); ws == nil || len(ws) != 0 {
		t.Errorf("parseWindows(empty) = %#v, want non-nil empty", ws)
	}
}

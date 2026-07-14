package main

// The Cockpit HUD's tools domain: everything behind GET /__console/tools. The
// catalog (tool-definitions.json) supplies the static fields; installed and
// auth status are derived live from this container (PATH lookup, env vars,
// rc-file exports, goose config, auth files). registerAPI (api.go) mounts the
// route behind the same withAPI guard as the rest of the Cockpit, and the
// action handler resolves its launch/connect commands through lookupTool here.

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// toolDefsPath is the runtime location of the tool catalog (Dockerfile COPYs it
// there). A var, not a const, so tests can point it at a fixture.
var toolDefsPath = "/opt/envhaven/tool-definitions.json"

// ---------------------------------------------------------------------------
// GET /__console/tools — the AI-tool grid with per-tool auth status.
// ---------------------------------------------------------------------------

// setupStep mirrors a tool-definitions.json setupSteps entry (both fields
// optional), passed through verbatim so a client never re-derives the catalog.
type setupStep struct {
	Instruction string `json:"instruction,omitempty"`
	Command     string `json:"command,omitempty"`
}

// toolDef is the subset of a tool-definitions.json entry the API consumes. A
// null authCommand (aider/vibe/factory) decodes to a nil pointer, which the
// connect action rejects.
type toolDef struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Command     string      `json:"command"`
	AuthCommand *string     `json:"authCommand"`
	Description string      `json:"description"`
	DocsURL     string      `json:"docsUrl"`
	EnvVars     []string    `json:"envVars"`
	AuthFiles   []string    `json:"authFiles"`
	AuthCheck   string      `json:"authCheck"`
	SkillsAgent string      `json:"skillsAgent"`
	SetupSteps  []setupStep `json:"setupSteps"`
}

// toolResponse is the complete per-tool view /tools serves. It is the SINGLE
// source both clients render: the managed dashboard (which bundles no catalog)
// and the extension (which now builds its grid from this instead of a local
// checkAuth). Static fields come straight from the catalog; installed/authStatus/
// connectedVia are the dynamic result of reading this container.
type toolResponse struct {
	ID           string      `json:"id"`
	Name         string      `json:"name"`
	Command      string      `json:"command"`
	AuthCommand  *string     `json:"authCommand"`
	Description  string      `json:"description"`
	DocsURL      string      `json:"docsUrl"`
	EnvVars      []string    `json:"envVars"`
	SetupSteps   []setupStep `json:"setupSteps"`
	Installed    bool        `json:"installed"`
	AuthStatus   string      `json:"authStatus"`
	ConnectedVia *string     `json:"connectedVia"`
}

// envVarMeta is a tool-definitions.json envVarMeta entry: the per-env-var UI copy
// (placeholder, hint, signup url) both clients render beside an API-key field.
// Passed through verbatim so neither the dashboard nor the extension re-derives it;
// a null url stays null.
type envVarMeta struct {
	Placeholder string  `json:"placeholder"`
	Hint        string  `json:"hint"`
	URL         *string `json:"url"`
}

// toolCatalog is the whole tool-definitions.json: the tool list plus the shared
// envVarMeta map keyed by env-var name.
type toolCatalog struct {
	Tools      []toolDef             `json:"tools"`
	EnvVarMeta map[string]envVarMeta `json:"envVarMeta"`
}

func loadCatalog() (toolCatalog, error) {
	var c toolCatalog
	data, err := os.ReadFile(toolDefsPath)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, err
	}
	return c, nil
}

func loadToolDefs() ([]toolDef, error) {
	c, err := loadCatalog()
	return c.Tools, err
}

// lookupTool returns the catalog entry for id, or (nil, nil) when no such id
// exists — the caller's "unknown tool" 400.
func lookupTool(id string) (*toolDef, error) {
	tools, err := loadToolDefs()
	if err != nil {
		return nil, err
	}
	for i := range tools {
		if tools[i].ID == id {
			return &tools[i], nil
		}
	}
	return nil, nil
}

// handleTools serves the tool grid (GET) and the two auth mutations the dashboard
// and sidebar drive (POST): set an API key, or sign a tool out. GET lists, POST
// mutates — the same split as /skills.
func handleTools(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		handleToolsList(w, r)
	case http.MethodPost:
		handleToolMutation(w, r)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func handleToolsList(w http.ResponseWriter, r *http.Request) {
	cat, err := loadCatalog()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "tool definitions unavailable")
		return
	}
	home := homeDir()
	rc := parseRcEnvVars(home)
	out := make([]toolResponse, 0, len(cat.Tools))
	for _, d := range cat.Tools {
		// Gate auth on presence exactly like environment.ts (installed ? checkAuth
		// : needs-auth): a tool that isn't on PATH reports needs-auth regardless of
		// a stray env var, so the grid never shows an absent tool as connected.
		installed := toolInstalled(d.Command)
		res := authResult{"needs-auth", nil}
		if installed {
			res = checkAuth(d, home, rc)
		}
		// tool-definitions.json always carries these as arrays; normalize nil → []
		// so an absent key can never marshal as JSON null and crash a client's map.
		envVars := d.EnvVars
		if envVars == nil {
			envVars = []string{}
		}
		steps := d.SetupSteps
		if steps == nil {
			steps = []setupStep{}
		}
		out = append(out, toolResponse{
			ID:           d.ID,
			Name:         d.Name,
			Command:      d.Command,
			AuthCommand:  d.AuthCommand,
			Description:  d.Description,
			DocsURL:      d.DocsURL,
			EnvVars:      envVars,
			SetupSteps:   steps,
			Installed:    installed,
			AuthStatus:   res.status,
			ConnectedVia: res.via,
		})
	}
	// Normalize a nil map to {} so a client always gets an object, never JSON null.
	meta := cat.EnvVarMeta
	if meta == nil {
		meta = map[string]envVarMeta{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tools": out, "envVarMeta": meta})
}

// ---------------------------------------------------------------------------
// POST /__console/tools — set an API key, or sign a tool out. This is the write
// twin of the checkAuth ladder above: set-key upserts an `export VAR='value'`
// line into the rc files firstSetEnvVar reads, and sign-out strips those lines
// and deletes the tool's auth files. It mirrors the extension host's _setApiKey /
// _signOutTool (sidebar-provider.ts) byte-for-byte in behavior — keep the two in
// lockstep so the dashboard and the sidebar disconnect a tool the same way.
// ---------------------------------------------------------------------------

type toolMutationRequest struct {
	Action string `json:"action"`
	ToolID string `json:"toolId"`
	EnvVar string `json:"envVar"`
	Key    string `json:"key"`
}

func handleToolMutation(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxActionBody)
	var req toolMutationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid body")
		return
	}
	tool, err := lookupTool(req.ToolID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "tool definitions unavailable")
		return
	}
	if tool == nil {
		writeAPIError(w, http.StatusBadRequest, "unknown tool")
		return
	}

	switch req.Action {
	case "set-key":
		// The env var must be one the tool actually declares, so a request can only
		// write a credential the catalog ties to this tool — never an arbitrary export.
		if !toolDeclaresEnvVar(tool, req.EnvVar) {
			writeAPIError(w, http.StatusBadRequest, "unknown env var for tool")
			return
		}
		key, ok := cleanRcValue(req.Key)
		if !ok {
			writeAPIError(w, http.StatusBadRequest, "invalid key")
			return
		}
		if len(setRcExport(homeDir(), req.EnvVar, key)) == 0 {
			writeAPIError(w, http.StatusInternalServerError, "could not write rc files")
			return
		}

	case "sign-out":
		signOutTool(homeDir(), tool)

	default:
		writeAPIError(w, http.StatusBadRequest, "unknown action")
		return
	}

	writeOK(w)
}

func toolDeclaresEnvVar(tool *toolDef, envVar string) bool {
	for _, v := range tool.EnvVars {
		if v == envVar {
			return true
		}
	}
	return false
}

// cleanRcValue trims an rc-export value and rejects the two shapes a single
// `export NAME='value'` line cannot hold: empty, or a value spanning newlines. One
// rule behind every rc mutation — set-key here and setEnv in env.go.
func cleanRcValue(s string) (string, bool) {
	v := strings.TrimSpace(s)
	if v == "" || strings.ContainsAny(v, "\r\n") {
		return "", false
	}
	return v, true
}

// rcManagedMarker tags an export line as written from the dashboard, so listManagedVars
// can tell user-managed vars apart from the shell framework's own exports (oh-my-zsh's
// ZSH, and the like). It sits after the closing quote, so the auth regex — which reads
// every export — ignores it, and a value can never masquerade as the marker.
const rcManagedMarker = " # envhaven"

// rcFiles are the shell rc files the console scans and writes for tool auth env
// vars; every rc-reading and rc-writing helper ranges over exactly these two.
var rcFiles = []string{".zshrc", ".bashrc"}

// setRcExport upserts `export <envVar>=<quoted value> # envhaven` into ~/.zshrc and
// ~/.bashrc, replacing an existing line for that var in place, else appending (the
// shape of the extension's _setApiKey updateRcFile, plus the marker). The marker scopes
// the env pane's listing to dashboard-managed vars; the auth ladder ignores it. Returns
// the rc basenames it wrote, so the caller can 500 when neither took the write.
func setRcExport(home, envVar, value string) []string {
	line := "export " + envVar + "=" + shellSingleQuote(value) + rcManagedMarker
	marker := "export " + envVar + "="
	var written []string
	for _, rc := range rcFiles {
		path := filepath.Join(home, rc)
		data, _ := os.ReadFile(path) // a missing rc reads as empty; we create it
		content := string(data)
		lines := strings.Split(content, "\n")
		replaced := false
		for i, l := range lines {
			if strings.HasPrefix(l, marker) {
				lines[i] = line
				replaced = true
				break
			}
		}
		if !replaced {
			if len(content) > 0 && !strings.HasSuffix(content, "\n") {
				lines = append(lines, "")
			}
			lines = append(lines, line)
		}
		if os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644) == nil {
			written = append(written, rc)
		}
	}
	return written
}

// signOutTool reverses set-key: it removes every `export <envVar>=` line the tool
// declares from both rc files, and deletes each auth file the tool lists (path-
// guarded to stay under home, so a malformed `..` entry can't unlink outside it).
// A key baked into the container's own environment can't be cleared from here —
// that is a deployment setting, not a UI sign-out — matching _signOutTool.
func signOutTool(home string, tool *toolDef) {
	for _, envVar := range tool.EnvVars {
		removeRcExport(home, envVar)
	}
	for _, rel := range tool.AuthFiles {
		full := filepath.Join(home, rel)
		if !pathWithin(home, full) {
			continue
		}
		_ = os.Remove(full) // a missing file is already signed out
	}
}

// removeRcExport strips every `export <name>=` line from ~/.zshrc and ~/.bashrc,
// returning the rc basenames it rewrote. The reverse of setRcExport, shared by the
// per-tool sign-out and the env resource's delete (env.go).
func removeRcExport(home, name string) []string {
	marker := "export " + name + "="
	var changed []string
	for _, rc := range rcFiles {
		path := filepath.Join(home, rc)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		lines := strings.Split(string(data), "\n")
		kept := make([]string, 0, len(lines))
		for _, l := range lines {
			if !strings.HasPrefix(l, marker) {
				kept = append(kept, l)
			}
		}
		if len(kept) != len(lines) {
			if os.WriteFile(path, []byte(strings.Join(kept, "\n")), 0o644) == nil {
				changed = append(changed, rc)
			}
		}
	}
	return changed
}

// listManagedVars returns the names of every dashboard-managed export — the ones
// carrying rcManagedMarker — across both rc files. Where parseRcEnvVars reads EVERY
// export for auth detection, this is the env pane's scope, so a framework export like
// oh-my-zsh's ZSH never appears.
func listManagedVars(home string) map[string]bool {
	set := map[string]bool{}
	for _, rc := range rcFiles {
		data, err := os.ReadFile(filepath.Join(home, rc))
		if err != nil {
			continue
		}
		for _, l := range strings.Split(string(data), "\n") {
			if !strings.HasSuffix(l, rcManagedMarker) || !strings.HasPrefix(l, "export ") {
				continue
			}
			rest := l[len("export "):]
			if eq := strings.IndexByte(rest, '='); eq > 0 {
				set[rest[:eq]] = true
			}
		}
	}
	return set
}

// shellSingleQuote wraps s in single quotes, rewriting each embedded single quote
// as the close-escape-reopen shell idiom, so any value — a JSON session blob, a
// token with symbols — survives verbatim on one rc line. The read side
// (parseRcEnvVars) captures only the name, so the quoting style never affects auth
// detection; it just keeps the file valid.
func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// pathWithin reports whether full resolves to home or a descendant of it, after
// cleaning any `..` segments — the boundary check _signOutTool applies before an
// unlink.
func pathWithin(home, full string) bool {
	rel, err := filepath.Rel(home, full)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// toolInstalled reports whether the tool's command resolves on the console's
// PATH — the same signal environment.ts derived from `which`. svc-console-run is
// a with-contenv service, so the console inherits the container PATH and mise
// shims + /opt/envhaven/bin resolve here exactly as they do for the extension host.
func toolInstalled(command string) bool {
	_, err := exec.LookPath(command)
	return err == nil
}

type authResult struct {
	status string
	via    *string
}

// checkAuth's priority ladder, mirrored by check_tool_auth in
// runtime/scripts/envhaven-status (which cites this file back — keep the two in
// lockstep so the shell banner and the tool grid agree): (1) any set env var
// (process env OR ~/.zshrc/.bashrc export) wins; (2) goose reads its
// config.yaml provider; (3) an existing auth file (non-empty/non-`{}` for JSON)
// wins; (4) has env vars but none set → needs-auth; (5) otherwise unknown.
func checkAuth(def toolDef, home string, rc map[string]bool) authResult {
	if len(def.EnvVars) > 0 {
		if v := firstSetEnvVar(def.EnvVars, rc); v != "" {
			return authResult{"ready", &v}
		}
	}
	if def.AuthCheck == "goose" {
		return checkGooseAuth(home)
	}
	if len(def.AuthFiles) > 0 {
		for _, rel := range def.AuthFiles {
			if ok, label := checkAuthFile(home, rel); ok {
				return authResult{"ready", &label}
			}
		}
		return authResult{"needs-auth", nil}
	}
	if len(def.EnvVars) > 0 {
		return authResult{"needs-auth", nil}
	}
	return authResult{"unknown", nil}
}

func homeDir() string {
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	return "/config"
}

// firstSetEnvVar returns the first of names set in the process environment or in
// a parsed rc-file assignment, checking each name's env before its rc entry
// (environment.ts getSetEnvVar order).
func firstSetEnvVar(names []string, rc map[string]bool) string {
	for _, n := range names {
		if os.Getenv(n) != "" {
			return n
		}
		if rc[n] {
			return n
		}
	}
	return ""
}

// rcAssignRe matches an `export VAR=value` assignment at the start of a line
// with a non-empty value (rc_has_var in runtime/scripts/envhaven-status is the
// grep twin of this regex; it cites this file back). Export-only on purpose: a
// bare `VAR=value` is shell-local and invisible to launched tools, so it
// proves nothing about a tool's auth. Only the name is captured.
var rcAssignRe = regexp.MustCompile(`(?m)^\s*export\s+(\w+)=["']?[^"'\n]+`)

func parseRcEnvVars(home string) map[string]bool {
	set := map[string]bool{}
	for _, rc := range rcFiles {
		data, err := os.ReadFile(filepath.Join(home, rc))
		if err != nil {
			continue
		}
		for _, m := range rcAssignRe.FindAllStringSubmatch(string(data), -1) {
			set[m[1]] = true
		}
	}
	return set
}

var gooseProviderRe = regexp.MustCompile(`GOOSE_PROVIDER:\s*["']?(\w+)`)

func checkGooseAuth(home string) authResult {
	data, err := os.ReadFile(filepath.Join(home, ".config/goose/config.yaml"))
	if err != nil || !strings.Contains(string(data), "GOOSE_PROVIDER:") {
		return authResult{"needs-auth", nil}
	}
	provider := "configured"
	if m := gooseProviderRe.FindStringSubmatch(string(data)); m != nil {
		provider = m[1]
	}
	via := "goose (" + provider + ")"
	return authResult{"ready", &via}
}

// checkAuthFile reports whether the rel auth file (under home) proves the tool
// is authenticated, and its display label. A `.json` credential must be present
// and be neither empty nor an empty object/array; any other file need only exist.
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

// authFileLabel renders `<parent-dir>/<file>` with a single leading dot stripped
// (getAuthFileLabel), e.g. ".claude/.credentials.json" -> "claude/.credentials.json".
func authFileLabel(rel string) string {
	label := filepath.Base(filepath.Dir(rel)) + "/" + filepath.Base(rel)
	return strings.TrimPrefix(label, ".")
}

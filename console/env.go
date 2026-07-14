package main

// The Cockpit HUD's environment-variable resource: GET/POST/DELETE /__console/env.
// It is the general view of the rc-file exports that tools.go's auth ladder reads —
// the same store the per-tool set-key writes, so a vendor key set from the Launch
// menu shows up here too. Values are WRITE-ONLY: the list returns names (each
// annotated with the catalog tools that use it), never a secret's value, matching
// the password-field posture of the Launch menu's key inputs. Set upserts through
// setRcExport and delete strips through removeRcExport (both in tools.go), so there
// is one rc-mutation implementation behind every surface.

import (
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

// envNameRe is a POSIX shell identifier: a letter or underscore, then letters,
// digits, or underscores. It gates both set and delete so a request name can never
// carry a metacharacter into a rc line.
var envNameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// envNameReserved blocks the shell-critical and internal names whose rc export would
// break the console/shell or shadow a managed value. It gates set only: a user can
// still set these deliberately from the terminal, but not fat-finger them through the
// UI. Delete is ungated — removing a rc export the user added is always allowed.
func envNameReserved(name string) bool {
	switch name {
	case "PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "IFS",
		"LD_PRELOAD", "LD_LIBRARY_PATH", "PS1", "PROMPT_COMMAND", "BASH_ENV", "ENV":
		return true
	}
	// The managed namespace: _ENVHAVEN_* internals and the ENVHAVEN_* deployment knobs.
	return strings.HasPrefix(name, "_ENVHAVEN") || strings.HasPrefix(name, "ENVHAVEN_")
}

// envVarView is one row of the env pane: the variable name and the catalog tools that
// declare it (empty for a custom var the user set that no tool references).
type envVarView struct {
	Name  string   `json:"name"`
	Tools []string `json:"tools"`
}

func handleEnv(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		listEnv(w)
	case http.MethodPost:
		setEnv(w, r)
	case http.MethodDelete:
		deleteEnv(w, r)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// listEnv returns every dashboard-managed exported name (never a framework export
// like ZSH), each tagged with the catalog tools that use it. Only names, never values.
func listEnv(w http.ResponseWriter) {
	home := homeDir()
	exported := listManagedVars(home) // dashboard-managed export names → true
	usedBy := map[string][]string{}
	if cat, err := loadCatalog(); err == nil {
		for _, d := range cat.Tools {
			for _, v := range d.EnvVars {
				usedBy[v] = append(usedBy[v], d.Name)
			}
		}
	}
	out := make([]envVarView, 0, len(exported))
	for name := range exported {
		tools := usedBy[name]
		if tools == nil {
			tools = []string{}
		}
		out = append(out, envVarView{Name: name, Tools: tools})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	writeJSON(w, http.StatusOK, map[string]any{"vars": out})
}

type envMutationRequest struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// setEnv upserts one `export NAME='value'` into both rc files. The name must be a
// shell identifier and not reserved; the value must be present and single-line (one
// export line holds one value).
func setEnv(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxActionBody)
	var req envMutationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !envNameRe.MatchString(req.Name) {
		writeAPIError(w, http.StatusBadRequest, "invalid name")
		return
	}
	if envNameReserved(req.Name) {
		writeAPIError(w, http.StatusBadRequest, "name is reserved")
		return
	}
	value, ok := cleanRcValue(req.Value)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid value")
		return
	}
	if len(setRcExport(homeDir(), req.Name, value)) == 0 {
		writeAPIError(w, http.StatusInternalServerError, "could not write rc files")
		return
	}
	writeOK(w)
}

// deleteEnv strips one exported name from both rc files. A missing name is a no-op,
// so a double-delete is idempotent to the client.
func deleteEnv(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if !envNameRe.MatchString(name) {
		writeAPIError(w, http.StatusBadRequest, "invalid name")
		return
	}
	removeRcExport(homeDir(), name)
	writeOK(w)
}

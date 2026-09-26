package main

// The tools HTTP view and catalog boundary. Credential persistence and mutations
// live in tool_credentials.go; authentication and vendor probes live in
// tool_auth.go.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
)

// toolDefsPath is the runtime catalog installed by the Dockerfile. Tests replace
// it with a fixture.
var toolDefsPath = "/opt/envhaven/tool-definitions.json"

type setupStep struct {
	Instruction string `json:"instruction,omitempty"`
	Command     string `json:"command,omitempty"`
}

type authProbe struct {
	Command               []string `json:"command"`
	UnauthenticatedOutput string   `json:"unauthenticatedOutput"`
	ConnectedVia          string   `json:"connectedVia"`
}

// Decode only the fields the console owns. Artwork and shell-launch defaults
// belong to their catalog consumers, not to every live authentication read.
type toolDef struct {
	ID                string      `json:"id"`
	Name              string      `json:"name"`
	Command           string      `json:"command"`
	AuthCommand       *string     `json:"authCommand"`
	Description       string      `json:"description"`
	DocsURL           string      `json:"docsUrl"`
	EnvVars           []string    `json:"envVars"`
	AuthEnvVars       []string    `json:"authEnvVars"`
	AuthFiles         []string    `json:"authFiles"`
	AuthCheck         string      `json:"authCheck"`
	AuthProbe         *authProbe  `json:"authProbe"`
	SkillsAgent       string      `json:"skillsAgent"`
	SetupSteps        []setupStep `json:"setupSteps"`
	SetKeyCommand     []string    `json:"setKeyCommand"`
	LogoutCommand     []string    `json:"logoutCommand"`
	LogoutInstruction string      `json:"logoutInstruction"`
}

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
	AuthSource   *string     `json:"authSource"`
}

type envVarMeta struct {
	Placeholder string  `json:"placeholder"`
	Hint        string  `json:"hint"`
	URL         *string `json:"url"`
}

type toolCatalog struct {
	Tools      []toolDef             `json:"tools"`
	EnvVarMeta map[string]envVarMeta `json:"envVarMeta"`
}

func loadCatalog() (toolCatalog, error) {
	var catalog toolCatalog
	data, err := os.ReadFile(toolDefsPath)
	if err != nil {
		return catalog, err
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		return catalog, err
	}
	return catalog, nil
}

func loadToolDefs() ([]toolDef, error) {
	catalog, err := loadCatalog()
	return catalog.Tools, err
}

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

func handleTools(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		handleToolsList(w)
	case http.MethodPost:
		handleToolMutation(w, r)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func handleToolsList(w http.ResponseWriter) {
	catalog, err := loadCatalog()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "tool definitions unavailable")
		return
	}
	tools, err := resolveToolViews(catalog.Tools, homeDir())
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, credentialErrorMessage(err, "tool credentials unavailable"))
		return
	}
	if catalog.EnvVarMeta == nil {
		catalog.EnvVarMeta = map[string]envVarMeta{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tools": tools, "envVarMeta": catalog.EnvVarMeta})
}

// resolveToolViews is the sole installed/auth computation used by the HTTP API
// and the envhaven-console --ready-tools CLI mode.
func resolveToolViews(defs []toolDef, home string) ([]toolResponse, error) {
	sources, err := readCredentialSources(home)
	if err != nil {
		return nil, err
	}
	tools := make([]toolResponse, len(defs))
	var wg sync.WaitGroup
	for i, definition := range defs {
		i, definition := i, definition
		wg.Add(1)
		go func() {
			defer wg.Done()
			installed := toolInstalled(definition.Command)
			auth := authResult{status: "needs-auth"}
			if installed {
				auth = checkAuth(definition, home, sources)
			}
			envVars := definition.EnvVars
			if envVars == nil {
				envVars = []string{}
			}
			steps := definition.SetupSteps
			if steps == nil {
				steps = []setupStep{}
			}
			tools[i] = toolResponse{
				ID:           definition.ID,
				Name:         definition.Name,
				Command:      definition.Command,
				AuthCommand:  definition.AuthCommand,
				Description:  definition.Description,
				DocsURL:      definition.DocsURL,
				EnvVars:      envVars,
				SetupSteps:   steps,
				Installed:    installed,
				AuthStatus:   auth.status,
				ConnectedVia: auth.via,
				AuthSource:   auth.source,
			}
		}()
	}
	wg.Wait()
	return tools, nil
}

func writeReadyToolNames(w io.Writer) error {
	catalog, err := loadCatalog()
	if err != nil {
		return err
	}
	tools, err := resolveToolViews(catalog.Tools, homeDir())
	if err != nil {
		return err
	}
	for _, tool := range tools {
		if tool.Installed && tool.AuthStatus == "ready" {
			if _, err := fmt.Fprintln(w, tool.Name); err != nil {
				return err
			}
		}
	}
	return nil
}

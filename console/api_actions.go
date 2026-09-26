package main

// The sole owner of out-of-band tmux mutations. Callers name a fixed action and,
// where needed, a catalog tool id or visible window index. Commands come only
// from tool-definitions.json, and mutable indices are resolved to immutable tmux
// ids before a mutation runs.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// Every tmux call is bounded so a wedged server socket cannot hang an HTTP
	// handler or an interactive vendor logout.
	tmuxCmdTimeout = 2 * time.Second
	maxActionBody  = 4 << 10 // 4 KiB
)

type actionRequest struct {
	Action string `json:"action"`
	ToolID string `json:"toolId"`
	Index  *int   `json:"index"`
	Name   string `json:"name"`
}

type actionFailure struct {
	status  int
	message string
}

type actionCLIResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// handleAction exposes the fixed action contract used by the dashboard and the
// extension. Anything outside this allowlist is rejected before tmux is reached.
func handleAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxActionBody)
	req, err := decodeActionRequest(r.Body)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if failure := executeAction(r.Context(), req); failure != nil {
		writeAPIError(w, failure.status, failure.message)
		return
	}
	writeOK(w)
}

func decodeActionRequest(r io.Reader) (actionRequest, error) {
	var req actionRequest
	decoder := json.NewDecoder(r)
	if err := decoder.Decode(&req); err != nil {
		return actionRequest{}, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return actionRequest{}, errors.New("trailing JSON")
	}
	return req, nil
}

func executeAction(ctx context.Context, req actionRequest) *actionFailure {
	switch req.Action {
	case "launch", "connect":
		tool, err := lookupTool(req.ToolID)
		if err != nil {
			return &actionFailure{http.StatusInternalServerError, "tool definitions unavailable"}
		}
		if tool == nil {
			return &actionFailure{http.StatusBadRequest, "unknown tool"}
		}
		command := tool.Command
		if req.Action == "connect" {
			if tool.AuthCommand == nil {
				return &actionFailure{http.StatusBadRequest, "tool has no auth command"}
			}
			command = *tool.AuthCommand
		}
		// command is a trusted catalog string passed to tmux verbatim as one argv
		// value. No client-provided command or shell parsing is involved.
		if err := openCommandWindow(ctx, command); err != nil {
			return &actionFailure{http.StatusInternalServerError, "tmux failed"}
		}

	case "new-window":
		if _, err := ensureWindow(ctx); err != nil {
			return &actionFailure{http.StatusInternalServerError, "tmux failed"}
		}

	case "select-window", "kill-window":
		idx, ok := validIndex(req.Index)
		if !ok {
			return &actionFailure{http.StatusBadRequest, "invalid index"}
		}
		windowID, err := windowIDForIndex(ctx, idx)
		if errors.Is(err, errWindowNotFound) {
			// A stale index (closed since the client listed it) names no window at all.
			return &actionFailure{http.StatusNotFound, "window not found"}
		}
		if err != nil {
			return &actionFailure{http.StatusInternalServerError, "tmux failed"}
		}
		// req.Action is the tmux subcommand verbatim; the case label is the allowlist.
		if err := tmuxRun(ctx, req.Action, "-t", windowTarget(windowID)); err != nil {
			return &actionFailure{http.StatusInternalServerError, "tmux failed"}
		}

	case "insert-path":
		name, ok := sanitizeArtifactName(req.Name)
		if !ok {
			return &actionFailure{http.StatusBadRequest, "invalid name"}
		}
		if !fileExists(filepath.Join(artifactsDir, name)) {
			return &actionFailure{http.StatusBadRequest, "artifact not found"}
		}
		windowID, err := activeWindowID(ctx)
		if err != nil {
			return &actionFailure{http.StatusInternalServerError, "tmux failed"}
		}
		// -l sends the path literally, with a trailing space and no Enter. The name came
		// from an upload, so it is typed as one shell word: the Enter the user presses
		// next must neither run `x$(id).png` nor split `a b (2).png`.
		if err := tmuxRun(ctx, "send-keys", "-t", windowTarget(windowID), "-l", shellWord(artifactsDir+"/"+name)+" "); err != nil {
			return &actionFailure{http.StatusInternalServerError, "tmux failed"}
		}

	default:
		return &actionFailure{http.StatusBadRequest, "unknown action"}
	}

	return nil
}

// runActionJSON is the local extension fallback. It accepts exactly the HTTP
// action JSON contract, executes the same validator, and emits one small JSON
// envelope. The extension passes the payload as one argv value without a shell.
func runActionJSON(ctx context.Context, raw string, out io.Writer) int {
	response := actionCLIResponse{}
	if len(raw) > maxActionBody {
		response.Error = "invalid body"
	} else if req, err := decodeActionRequest(strings.NewReader(raw)); err != nil {
		response.Error = "invalid body"
	} else if failure := executeAction(ctx, req); failure != nil {
		response.Error = failure.message
	} else {
		response.OK = true
	}
	_ = json.NewEncoder(out).Encode(response)
	if response.OK {
		return 0
	}
	return 1
}

func validIndex(p *int) (int, bool) {
	if p == nil || *p < 0 {
		return 0, false
	}
	return *p, true
}

var tmuxCreateMu sync.Mutex

// ensureWindow opens a fresh window and returns its immutable tmux window id.
// Creation is serialized so concurrent first launches cannot all observe an
// absent session. If another process wins the session race, retry as new-window.
func ensureWindow(ctx context.Context) (string, error) {
	tmuxCreateMu.Lock()
	defer tmuxCreateMu.Unlock()

	if hasSession(ctx) {
		return createTmuxWindow(ctx, "new-window", "-t", sessionTarget(tmuxSession), "-c", "/config/workspace", "-P", "-F", "#{window_id}")
	}
	id, err := createTmuxWindow(ctx, "new-session", "-d", "-s", tmuxSession, "-c", "/config/workspace", "-P", "-F", "#{window_id}")
	if err == nil || !hasSession(ctx) {
		return id, err
	}
	return createTmuxWindow(ctx, "new-window", "-t", sessionTarget(tmuxSession), "-c", "/config/workspace", "-P", "-F", "#{window_id}")
}

func hasSession(ctx context.Context) bool {
	return tmuxRun(ctx, "has-session", "-t", sessionTarget(tmuxSession)) == nil
}

func createTmuxWindow(ctx context.Context, args ...string) (string, error) {
	out, err := tmuxOutput(ctx, args...)
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(out)
	if !validWindowID(id) {
		return "", fmt.Errorf("tmux returned invalid window id %q", id)
	}
	return id, nil
}

// windowTarget pins an immutable window id to the base session. For a bare @id tmux
// picks the most recently active session holding that window, often a grouped view
// (console-view, ssh-*), so select-window moved that view instead of the base
// session the managed console and the IDE terminal render.
func windowTarget(windowID string) string { return sessionTarget(tmuxSession) + windowID }

var errWindowNotFound = errors.New("window not found")

func windowIDForIndex(ctx context.Context, index int) (string, error) {
	return baseWindowID(ctx, func(i int, _ bool) bool { return i == index })
}

func activeWindowID(ctx context.Context) (string, error) {
	return baseWindowID(ctx, func(_ int, active bool) bool { return active })
}

// baseWindowID resolves one window of the base session from list-windows, which
// lists that exact session or fails. display-message cannot do this job: asked for
// a missing index it answers with the session's current window and exits 0 (tmux
// 3.4), so a stale kill-window closed whatever window the user was looking at.
func baseWindowID(ctx context.Context, match func(index int, active bool) bool) (string, error) {
	out, err := tmuxOutput(ctx, "list-windows", "-t", sessionTarget(tmuxSession), "-F", "#{window_index} #{window_active} #{window_id}")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || !validWindowID(fields[2]) {
			continue
		}
		index, err := strconv.Atoi(fields[0])
		if err == nil && match(index, fields[1] == "1") {
			return fields[2], nil
		}
	}
	return "", errWindowNotFound
}

func validWindowID(id string) bool {
	if len(id) < 2 || id[0] != '@' {
		return false
	}
	_, err := strconv.ParseUint(id[1:], 10, 64)
	return err == nil
}

// openCommandWindow is shared with tool logout policy. The command still comes
// from the validated catalog and uses this file's one tmux mutation path.
func openCommandWindow(ctx context.Context, command string) error {
	windowID, err := ensureWindow(ctx)
	if err != nil {
		return err
	}
	return tmuxRun(ctx, "send-keys", "-t", windowTarget(windowID), command, "Enter")
}

// plainShellWord is the alphabet a POSIX shell reads literally, the same set
// Python's shlex.quote leaves unquoted.
var plainShellWord = regexp.MustCompile(`^[A-Za-z0-9@%+=:,./_-]+$`)

// shellWord renders s as a single word a shell reads literally: unchanged when
// every byte is plain, single-quoted otherwise.
func shellWord(s string) string {
	if plainShellWord.MatchString(s) {
		return s
	}
	return shellSingleQuote(s)
}

var executeTmux = func(ctx context.Context, args ...string) (string, error) {
	c, cancel := context.WithTimeout(ctx, tmuxCmdTimeout)
	defer cancel()
	out, err := exec.CommandContext(c, "tmux", args...).Output()
	return string(out), err
}

func tmuxRun(ctx context.Context, args ...string) error {
	_, err := executeTmux(ctx, args...)
	return err
}

func tmuxOutput(ctx context.Context, args ...string) (string, error) {
	return executeTmux(ctx, args...)
}

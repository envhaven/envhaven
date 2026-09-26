package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestHandleActionValidation(t *testing.T) {
	dir := t.TempDir()
	defs := filepath.Join(dir, "tool-definitions.json")
	if err := os.WriteFile(defs, []byte(`{"tools":[
		{"id":"claude","name":"Claude Code","command":"claude","authCommand":"claude-auth-helper"},
		{"id":"noauth","name":"No Auth","command":"noauth","authCommand":null}
	]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	previous := toolDefsPath
	toolDefsPath = defs
	t.Cleanup(func() { toolDefsPath = previous })

	tests := []struct {
		name, body string
		want       int
	}{
		{"unknown action", `{"action":"frobnicate"}`, http.StatusBadRequest},
		{"unknown tool", `{"action":"launch","toolId":"ghost"}`, http.StatusBadRequest},
		{"connect null authCommand", `{"action":"connect","toolId":"noauth"}`, http.StatusBadRequest},
		{"select negative index", `{"action":"select-window","index":-1}`, http.StatusBadRequest},
		{"select missing index", `{"action":"select-window"}`, http.StatusBadRequest},
		{"kill missing index", `{"action":"kill-window"}`, http.StatusBadRequest},
		{"insert-path traversal", `{"action":"insert-path","name":"../etc/passwd"}`, http.StatusBadRequest},
		{"insert-path absent file", `{"action":"insert-path","name":"definitely-absent-xyz.bin"}`, http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			handleAction(w, httptest.NewRequest(http.MethodPost, "/__console/action", strings.NewReader(test.body)))
			if w.Code != test.want {
				t.Fatalf("status = %d, want %d (body %q)", w.Code, test.want, w.Body.String())
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

func TestRunActionJSONRejectsInvalidInputWithBoundedJSON(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{"malformed", `{`, `{"ok":false,"error":"invalid body"}`},
		{"trailing JSON", `{"action":"new-window"}{}`, `{"ok":false,"error":"invalid body"}`},
		{"oversized", strings.Repeat("x", maxActionBody+1), `{"ok":false,"error":"invalid body"}`},
		{"unknown action", `{"action":"frobnicate"}`, `{"ok":false,"error":"unknown action"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var out bytes.Buffer
			if code := runActionJSON(context.Background(), test.raw, &out); code != 1 {
				t.Fatalf("exit = %d, want 1", code)
			}
			if got := strings.TrimSpace(out.String()); got != test.want {
				t.Fatalf("response = %q, want %q", got, test.want)
			}
			if out.Len() > maxActionBody {
				t.Fatalf("response length = %d, want <= %d", out.Len(), maxActionBody)
			}
		})
	}
}

func TestConcurrentActionsUseExactWindowIDs(t *testing.T) {
	dir := t.TempDir()
	defs := filepath.Join(dir, "tool-definitions.json")
	if err := os.WriteFile(defs, []byte(`{"tools":[{"id":"fx","name":"fx","command":"fx","authCommand":"fx login"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	previousDefs := toolDefsPath
	toolDefsPath = defs
	t.Cleanup(func() { toolDefsPath = previousDefs })

	type fakeState struct {
		sync.Mutex
		session       bool
		next          int
		windows       map[string]bool
		windowByIndex map[int]string
		sent          map[string]struct {
			count   int
			command string
		}
		selectionTarget string
		kills           []string
	}
	state := fakeState{
		windows:       map[string]bool{},
		windowByIndex: map[int]string{},
		sent: map[string]struct {
			count   int
			command string
		}{},
	}
	// Every target must name the base session exactly. A bare session name is first
	// tried as a window name, and a bare @id lets tmux pick a grouped view instead.
	const base = "=envhaven:"
	liveWindow := func(target string) (string, bool) {
		id, pinned := strings.CutPrefix(target, base)
		return id, pinned && validWindowID(id) && state.windows[id]
	}
	previousExecute := executeTmux
	executeTmux = func(_ context.Context, args ...string) (string, error) {
		state.Lock()
		defer state.Unlock()
		if len(args) < 3 {
			return "", fmt.Errorf("unexpected tmux call %q", args)
		}
		switch args[0] {
		case "has-session":
			if args[2] != base {
				return "", fmt.Errorf("inexact session target %q", args[2])
			}
			if !state.session {
				return "", fmt.Errorf("no session")
			}
			return "", nil
		case "new-session", "new-window":
			if args[0] == "new-session" {
				// -s names the session to create, so it keeps the bare name: tmux
				// would turn "=envhaven:" into a separate session called =envhaven_.
				if len(args) < 4 || args[2] != "-s" || args[3] != "envhaven" {
					return "", fmt.Errorf("unexpected new-session call %q", args)
				}
				if state.session {
					return "", fmt.Errorf("duplicate session")
				}
				state.session = true
			} else if args[2] != base {
				return "", fmt.Errorf("inexact new-window target %q", args[2])
			} else if !state.session {
				return "", fmt.Errorf("no session")
			}
			id := fmt.Sprintf("@%d", state.next)
			state.windowByIndex[state.next] = id
			state.next++
			state.windows[id] = true
			return id + "\n", nil
		case "send-keys":
			id, ok := liveWindow(args[2])
			if len(args) < 4 || !ok {
				return "", fmt.Errorf("invalid send target %q", args[2])
			}
			sent := state.sent[id]
			sent.count++
			sent.command = args[3]
			state.sent[id] = sent
			return "", nil
		case "list-windows":
			// Real tmux lists live windows only, so a missing index is simply absent.
			// (display-message answered one with the current window and exit 0.)
			if args[2] != base || len(args) != 5 || args[4] != "#{window_index} #{window_active} #{window_id}" {
				return "", fmt.Errorf("unexpected list-windows call %q", args)
			}
			var out strings.Builder
			for index := 0; index < state.next; index++ {
				if id := state.windowByIndex[index]; state.windows[id] {
					fmt.Fprintf(&out, "%d 0 %s\n", index, id)
				}
			}
			return out.String(), nil
		case "select-window":
			if _, ok := liveWindow(args[2]); len(args) != 3 || !ok {
				return "", fmt.Errorf("invalid selection target %q", args[2])
			}
			state.selectionTarget = args[2]
			return "", nil
		case "kill-window":
			id, ok := liveWindow(args[2])
			if len(args) != 3 || !ok {
				return "", fmt.Errorf("invalid kill target %q", args[2])
			}
			state.kills = append(state.kills, args[2])
			delete(state.windows, id)
			return "", nil
		default:
			return "", fmt.Errorf("unexpected tmux command %q", args[0])
		}
	}
	t.Cleanup(func() { executeTmux = previousExecute })

	const launches = 40
	statuses := make(chan int, launches)
	var requests sync.WaitGroup
	for i := range launches {
		requests.Add(1)
		go func() {
			defer requests.Done()
			if i%2 == 0 {
				w := httptest.NewRecorder()
				handleAction(w, httptest.NewRequest(http.MethodPost, "/__console/action", strings.NewReader(`{"action":"launch","toolId":"fx"}`)))
				statuses <- w.Code
				return
			}
			var out bytes.Buffer
			if code := runActionJSON(context.Background(), `{"action":"launch","toolId":"fx"}`, &out); code == 0 && strings.TrimSpace(out.String()) == `{"ok":true}` {
				statuses <- http.StatusOK
				return
			}
			statuses <- http.StatusInternalServerError
		}()
	}
	requests.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Fatalf("concurrent launch status = %d, want 200", status)
		}
	}
	state.Lock()
	if state.next != launches || len(state.sent) != launches {
		state.Unlock()
		t.Fatalf("created/sent = %d/%d, want %d/%d", state.next, len(state.sent), launches, launches)
	}
	for i := 0; i < launches; i++ {
		id := fmt.Sprintf("@%d", i)
		sent, ok := state.sent[id]
		if !ok || sent.count != 1 || sent.command != "fx" {
			state.Unlock()
			t.Fatalf("window %s received %+v, want one catalog command fx", id, sent)
		}
	}
	state.Unlock()

	// Even when a caller supplies an extra command field, connect resolves the
	// command from the catalog and sends it to the exact newly-created window id.
	var out bytes.Buffer
	if code := runActionJSON(context.Background(), `{"action":"connect","toolId":"fx","command":"evil"}`, &out); code != 0 {
		t.Fatalf("connect exit = %d: %s", code, out.String())
	}
	state.Lock()
	if got := state.sent["@40"]; got.count != 1 || got.command != "fx login" {
		state.Unlock()
		t.Fatalf("connect target @40 received %+v, want catalog command fx login", got)
	}
	state.Unlock()

	w := httptest.NewRecorder()
	handleAction(w, httptest.NewRequest(http.MethodPost, "/__console/action", strings.NewReader(`{"action":"select-window","index":7}`)))
	if w.Code != http.StatusOK {
		t.Fatalf("select status = %d: %s", w.Code, w.Body.String())
	}
	state.Lock()
	if state.selectionTarget != "=envhaven:@7" {
		state.Unlock()
		t.Fatalf("selection target = %q, want immutable id @7 in the base session", state.selectionTarget)
	}
	state.Unlock()

	w = httptest.NewRecorder()
	handleAction(w, httptest.NewRequest(http.MethodPost, "/__console/action", strings.NewReader(`{"action":"kill-window","index":7}`)))
	if w.Code != http.StatusOK {
		t.Fatalf("kill status = %d: %s", w.Code, w.Body.String())
	}

	// A stale index (7 again, as a double click sends it) and one that never existed
	// are refused on both surfaces and never reach kill-window.
	w = httptest.NewRecorder()
	handleAction(w, httptest.NewRequest(http.MethodPost, "/__console/action", strings.NewReader(`{"action":"kill-window","index":7}`)))
	if w.Code != http.StatusNotFound || strings.TrimSpace(w.Body.String()) != `{"error":"window not found"}` {
		t.Fatalf("stale kill = %d %s, want 404 window not found", w.Code, w.Body.String())
	}
	out.Reset()
	if code := runActionJSON(context.Background(), `{"action":"kill-window","index":99}`, &out); code != 1 || strings.TrimSpace(out.String()) != `{"ok":false,"error":"window not found"}` {
		t.Fatalf("missing kill = exit %d %s, want the window not found envelope", code, out.String())
	}
	state.Lock()
	defer state.Unlock()
	if !slices.Equal(state.kills, []string{"=envhaven:@7"}) {
		t.Fatalf("kill-window calls = %q, want exactly one, for =envhaven:@7", state.kills)
	}
}

// TestInsertPathTypesOneShellWord pins what insert-path types onto a command line.
// Artifact names come from uploads, and uniqueName itself adds " (2)", so the path
// must reach the Enter the user presses next as one literal word: unchanged when
// plain, single-quoted otherwise. It goes to the base session's active window.
func TestInsertPathTypesOneShellWord(t *testing.T) {
	dir := t.TempDir()
	previousDir := artifactsDir
	artifactsDir = dir
	t.Cleanup(func() { artifactsDir = previousDir })

	var typed []string
	previousExecute := executeTmux
	executeTmux = func(_ context.Context, args ...string) (string, error) {
		switch {
		case len(args) == 5 && args[0] == "list-windows" && args[2] == "=envhaven:":
			return "0 0 @0\n1 1 @3\n", nil
		case len(args) == 5 && args[0] == "send-keys" && args[2] == "=envhaven:@3" && args[3] == "-l":
			typed = append(typed, args[4])
			return "", nil
		}
		return "", fmt.Errorf("unexpected tmux call %q", args)
	}
	t.Cleanup(func() { executeTmux = previousExecute })

	for _, tc := range []struct{ name, want string }{
		{"report.txt", dir + "/report.txt "},
		{"a b (2).png", "'" + dir + "/a b (2).png' "},
		{"x$(id).png", "'" + dir + "/x$(id).png' "},
		{"it's.png", "'" + dir + `/it'\''s.png' `},
	} {
		if err := os.WriteFile(filepath.Join(dir, tc.name), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		body, err := json.Marshal(map[string]string{"action": "insert-path", "name": tc.name})
		if err != nil {
			t.Fatal(err)
		}
		typed = nil
		w := httptest.NewRecorder()
		handleAction(w, httptest.NewRequest(http.MethodPost, "/__console/action", bytes.NewReader(body)))
		if w.Code != http.StatusOK || len(typed) != 1 || typed[0] != tc.want {
			t.Errorf("insert-path %q = %d, typed %q, want %q", tc.name, w.Code, typed, tc.want)
		}
	}
}

// realTmux puts a `tmux` on PATH that sends every call, the production code's too, to
// a private server owned by this test. Fakes model tmux, and target resolution failed
// exactly where the model and tmux disagreed: asked for a missing index, display-message
// answers with the current window and exits 0.
func realTmux(t *testing.T) func(args ...string) string {
	t.Helper()
	path, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux is not installed")
	}
	dir := t.TempDir()
	wrapper := filepath.Join(dir, "tmux")
	script := "#!/bin/sh\nunset TMUX TMUX_PANE\nexport SHELL=/bin/sh\nexec '" + path + "' -S '" + dir + "/socket' -f /dev/null \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Cleanup(func() { _ = exec.Command(wrapper, "kill-server").Run() })
	return func(args ...string) string {
		t.Helper()
		out, err := exec.Command(wrapper, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("tmux %q: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
}

// TestTmuxTargetsOnARealServer drives the actions and the gate in the shape that broke
// them: a window named like the base session, and a grouped view that was used more
// recently than the base and keeps its own current window.
func TestTmuxTargetsOnARealServer(t *testing.T) {
	tmux := realTmux(t)
	ctx := context.Background()
	index := func(i int) *int { return &i }
	current := func() string {
		return tmux("display-message", "-p", "-t", "=envhaven:", "#{window_index}") + " " +
			tmux("display-message", "-p", "-t", "=console-view:", "#{window_index}")
	}

	// Commands go as argv so tmux execs them directly and each pane names its command.
	tmux("new-session", "-d", "-s", "envhaven", "-x", "80", "-y", "24", "sleep", "60")
	tmux("set-option", "-g", "default-command", "sleep 60")
	if pane := paneState(ctx, selfhostGateSession); pane != (paneSnapshot{}) {
		t.Fatalf("grouped view read as %+v before it exists, want unreadable", pane)
	}
	tmux("new-window", "-d", "-t", "=envhaven:", "-n", "envhaven-dev", "sh", "-c", "sleep 60; :")
	tmux("new-session", "-d", "-t", "=envhaven:", "-s", "console-view")
	tmux("select-window", "-t", "=console-view:1")
	if pane := paneState(ctx, tmuxSession); pane.App != "sleep" {
		t.Fatalf("base session read as %+v, want its current window's sleep", pane)
	}
	if pane := paneState(ctx, selfhostGateSession); pane.App != "sh" {
		t.Fatalf("grouped view read as %+v, want its current window's sh", pane)
	}

	if failure := executeAction(ctx, actionRequest{Action: "new-window"}); failure != nil {
		t.Fatalf("new-window beside a window named envhaven-dev = %+v", failure)
	}
	if failure := executeAction(ctx, actionRequest{Action: "select-window", Index: index(0)}); failure != nil {
		t.Fatalf("select-window 0 = %+v", failure)
	}
	if got := current(); got != "0 1" {
		t.Fatalf("current windows (base, view) = %s, want 0 1: the view must not move", got)
	}

	// The second kill of index 2 is stale, and must not fall through to window 0.
	if failure := executeAction(ctx, actionRequest{Action: "kill-window", Index: index(2)}); failure != nil {
		t.Fatalf("kill-window 2 = %+v", failure)
	}
	if failure := executeAction(ctx, actionRequest{Action: "kill-window", Index: index(2)}); failure == nil || failure.status != http.StatusNotFound {
		t.Fatalf("stale kill-window 2 = %+v, want 404", failure)
	}
	if got := tmux("list-windows", "-t", "=envhaven:", "-F", "#{window_index}"); got != "0\n1" {
		t.Fatalf("windows after a stale kill = %q, want 0 and 1", got)
	}

	dir := t.TempDir()
	previousDir := artifactsDir
	artifactsDir = dir
	t.Cleanup(func() { artifactsDir = previousDir })
	if err := os.WriteFile(filepath.Join(dir, "a b.txt"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if failure := executeAction(ctx, actionRequest{Action: "insert-path", Name: "a b.txt"}); failure != nil {
		t.Fatalf("insert-path = %+v", failure)
	}
	want := "'" + dir + "/a b.txt'"
	for deadline := time.Now().Add(2 * time.Second); !strings.Contains(tmux("capture-pane", "-p", "-J", "-t", "=envhaven:0"), want); {
		if time.Now().After(deadline) {
			t.Fatalf("the base session's current window never showed %q", want)
		}
		time.Sleep(20 * time.Millisecond)
	}

	// With the base gone, a session whose name merely starts with it stands in for
	// nothing: Cockpit lists none of its windows, and new-window rebuilds the base.
	tmux("kill-session", "-t", "=envhaven:")
	tmux("new-session", "-d", "-s", "envhaven-work", "sleep", "60")
	if windows := listWindows(ctx); len(windows) != 0 {
		t.Fatalf("listWindows without a base session = %+v, want none", windows)
	}
	if failure := executeAction(ctx, actionRequest{Action: "new-window"}); failure != nil {
		t.Fatalf("new-window without a base session = %+v", failure)
	}
	if got := tmux("list-windows", "-t", "=envhaven-work:", "-F", "#{window_index}"); got != "0" {
		t.Fatalf("new-window reached envhaven-work, whose windows are now %q", got)
	}
}

package main

// The Cockpit HUD's HTTP API. These endpoints are OUT-OF-BAND siblings of the
// terminal WebSocket: the managed dashboard reads them to render live workspace
// stats, the AI-tool grid, the skills catalog (skills.go), and the artifacts
// drawer, and to drive tmux (launch/connect a tool, switch/kill/new window,
// insert an artifact path) without keystrokes on the wire. They share the
// console's ONE port and ONE credential wall with the socket — a bearer that
// fails `verify` never reaches a handler. This file owns the guard and route
// table plus the action, stats, and artifacts domains; the tools domain lives
// in tools.go, the skills domain in skills.go, the env-var domain in env.go.
//
// Two rules make this file safe to read top to bottom:
//   1. Every route is wrapped by withAPI: exact-origin CORS, an OPTIONS 204
//      short-circuit, then the bearer check. There is no unauthenticated path.
//   2. No raw client string is ever handed to a shell. tmux runs through
//      exec.Command argv (no `sh -c`), so command bytes are passed verbatim with
//      no metacharacter interpretation; the only client-derived value that
//      reaches a terminal is a strictly-sanitized artifact filename.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	// tmuxCmdTimeout bounds every out-of-band tmux call so a wedged server socket
	// cannot hang an HTTP handler (mirrors gate.go's short display-message budget).
	tmuxCmdTimeout = 2 * time.Second

	// maxActionBody caps the tiny JSON action/skill bodies; maxArtifactUpload caps
	// a multipart file. Both keep a single request from buffering unboundedly.
	maxActionBody     = 4 << 10   // 4 KiB
	maxArtifactUpload = 100 << 20 // 100 MiB
)

// artifactsDir is the shared drop folder the dashboard uploads into and the
// terminal reads from. insert-path types a path under here into the pane. A
// var, not a const, so tests can point it at a fixture (the toolDefsPath seam).
var artifactsDir = "/config/artifacts"

// errUnauthorized is the self-host guard's failure sentinel; the managed guard
// returns *authError. withAPI maps any non-nil verify error to a 401.
var errUnauthorized = errors.New("unauthorized")

// registerAPI mounts every Cockpit endpoint on mux behind withAPI. Called from
// BOTH newHandler branches — managed passes jwtAuth.verify plus the dashboard
// CORS origins, self-host passes an HMAC-token closure plus nil origins. The
// routes are registered without a method so the OPTIONS preflight reaches
// withAPI (a method-qualified pattern would 405 it); each handler enforces its
// own verbs.
func registerAPI(mux *http.ServeMux, verify func(string) error, allowedOrigins []string) {
	guard := func(h http.HandlerFunc) http.HandlerFunc { return withAPI(verify, allowedOrigins, h) }
	mux.HandleFunc("/__console/action", guard(handleAction))
	mux.HandleFunc("/__console/stats", guard(handleStats))
	mux.HandleFunc("/__console/tools", guard(handleTools))
	mux.HandleFunc("/__console/env", guard(handleEnv))
	mux.HandleFunc("/__console/skills", guard(handleSkills))
	mux.HandleFunc("/__console/skills/markdown", guard(handleSkillMarkdown))
	mux.HandleFunc("/__console/skills/local", guard(handleSkillLocal))
	mux.HandleFunc("/__console/artifacts", guard(handleArtifacts))
	mux.HandleFunc("/__console/artifacts/raw", guard(handleArtifactRaw))
}

// withAPI is the shared guard: it sets exact-origin CORS (echoing the request
// Origin only when it is in allowedOrigins), answers an OPTIONS preflight with
// 204 and NO auth, then requires a valid `Authorization: Bearer` token. Any
// verify failure — missing, malformed, wrong key/issuer/audience/expiry, or
// (managed) wrong workspace — is a flat 401; the token is the wall, CORS only
// decides which browser origin may read the body.
func withAPI(verify func(string) error, allowedOrigins []string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && originAllowed(origin, allowedOrigins) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "authorization, content-type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		// Let the browser cache the preflight: the dashboard polls every 5s, and
		// Chrome's 5s default would bolt a second round trip onto nearly every poll.
		w.Header().Set("Access-Control-Max-Age", "600")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		token := extractBearer(r.Header.Get("Authorization"))
		if token == "" {
			writeAPIError(w, http.StatusUnauthorized, "missing token")
			return
		}
		if err := verify(token); err != nil {
			writeAPIError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		h(w, r)
	}
}

// originAllowed reports whether the request Origin exactly matches one of the
// scheme-qualified allowlist entries. Exact match only: no wildcards, no suffix
// logic, so a user-controlled workspace subdomain can never match.
func originAllowed(origin string, allowed []string) bool {
	for _, a := range allowed {
		if origin == a {
			return true
		}
	}
	return false
}

// extractBearer pulls the token from an `Authorization: Bearer <token>` header,
// returning "" when the scheme is absent or the value is empty.
func extractBearer(header string) string {
	const prefix = "Bearer "
	if len(header) > len(prefix) && strings.EqualFold(header[:len(prefix)], prefix) {
		return strings.TrimSpace(header[len(prefix):])
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeAPIError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeOK sends the standard success envelope shared by the mutation endpoints.
func writeOK(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------------------------------------------------------------------------
// POST /__console/action — out-of-band tmux, fixed 6-action allowlist.
// ---------------------------------------------------------------------------

type actionRequest struct {
	Action string `json:"action"`
	ToolID string `json:"toolId"`
	Index  *int   `json:"index"`
	Name   string `json:"name"`
}

// handleAction mirrors the extension's tmux sequence (sidebar-provider.ts) so
// the dashboard's shortcuts behave exactly like the sidebar's. Every window is
// born under the base `envhaven` session at /config/workspace. Only these six
// actions exist; anything else is a 400.
func handleAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxActionBody)
	var req actionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid body")
		return
	}
	ctx := r.Context()

	switch req.Action {
	case "launch", "connect":
		tool, err := lookupTool(req.ToolID)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "tool definitions unavailable")
			return
		}
		if tool == nil {
			writeAPIError(w, http.StatusBadRequest, "unknown tool")
			return
		}
		command := tool.Command
		if req.Action == "connect" {
			if tool.AuthCommand == nil {
				writeAPIError(w, http.StatusBadRequest, "tool has no auth command")
				return
			}
			command = *tool.AuthCommand
		}
		if err := ensureWindow(ctx); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "tmux failed")
			return
		}
		// argv passing: `command` is a trusted catalog string sent to tmux
		// verbatim as one argument, so no shell parsing and no quote-escaping is
		// involved (there is no shell to escape for).
		if err := tmuxRun(ctx, "send-keys", "-t", tmuxSession, command, "Enter"); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "tmux failed")
			return
		}

	case "new-window":
		if err := ensureWindow(ctx); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "tmux failed")
			return
		}

	case "select-window", "kill-window":
		idx, ok := validIndex(req.Index)
		if !ok {
			writeAPIError(w, http.StatusBadRequest, "invalid index")
			return
		}
		// req.Action is the tmux subcommand verbatim; the case label is the allowlist.
		if err := tmuxRun(ctx, req.Action, "-t", tmuxSession+":"+strconv.Itoa(idx)); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "tmux failed")
			return
		}

	case "insert-path":
		name, ok := sanitizeArtifactName(req.Name)
		if !ok {
			writeAPIError(w, http.StatusBadRequest, "invalid name")
			return
		}
		if !fileExists(filepath.Join(artifactsDir, name)) {
			writeAPIError(w, http.StatusBadRequest, "artifact not found")
			return
		}
		// -l sends the string literally (never interpreted as key names), with a
		// trailing space and NO Enter, so the path lands at the cursor ready to use.
		if err := tmuxRun(ctx, "send-keys", "-t", tmuxSession, "-l", artifactsDir+"/"+name+" "); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "tmux failed")
			return
		}

	default:
		writeAPIError(w, http.StatusBadRequest, "unknown action")
		return
	}

	writeOK(w)
}

// validIndex requires a present, non-negative window index.
func validIndex(p *int) (int, bool) {
	if p == nil || *p < 0 {
		return 0, false
	}
	return *p, true
}

// ensureWindow opens a fresh window in the base session, creating the session
// (detached) if it does not exist yet — the extension's exact has-session dance.
func ensureWindow(ctx context.Context) error {
	if hasSession(ctx) {
		return tmuxRun(ctx, "new-window", "-t", tmuxSession, "-c", "/config/workspace")
	}
	return tmuxRun(ctx, "new-session", "-d", "-s", tmuxSession, "-c", "/config/workspace")
}

func hasSession(ctx context.Context) bool {
	return tmuxRun(ctx, "has-session", "-t", tmuxSession) == nil
}

func tmuxRun(ctx context.Context, args ...string) error {
	c, cancel := context.WithTimeout(ctx, tmuxCmdTimeout)
	defer cancel()
	return exec.CommandContext(c, "tmux", args...).Run()
}

func tmuxOutput(ctx context.Context, args ...string) (string, error) {
	c, cancel := context.WithTimeout(ctx, tmuxCmdTimeout)
	defer cancel()
	out, err := exec.CommandContext(c, "tmux", args...).Output()
	return string(out), err
}

// ---------------------------------------------------------------------------
// GET /__console/stats — live resource + window snapshot.
// ---------------------------------------------------------------------------

type cpuStats struct {
	Pct   float64 `json:"pct"`
	NCpus int     `json:"nCpus"`
}

type ramStats struct {
	UsedMb  int     `json:"usedMb"`
	TotalMb int     `json:"totalMb"`
	Pct     float64 `json:"pct"`
}

type diskStats struct {
	UsedGb  float64 `json:"usedGb"`
	TotalGb float64 `json:"totalGb"`
	Pct     float64 `json:"pct"`
}

type window struct {
	Index  int    `json:"index"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
}

type previewStats struct {
	PortOpen bool `json:"portOpen"`
	Port     int  `json:"port"`
}

type statsResponse struct {
	CPU        cpuStats     `json:"cpu"`
	RAM        ramStats     `json:"ram"`
	Disk       diskStats    `json:"disk"`
	Windows    []window     `json:"windows"`
	Preview    previewStats `json:"preview"`
	CapturedAt int64        `json:"capturedAt"`
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, statsResponse{
		CPU:        cpuStats{Pct: cpuPercent(), NCpus: runtime.NumCPU()},
		RAM:        ramSnapshot(),
		Disk:       diskSnapshot(),
		Windows:    listWindows(r.Context()),
		Preview:    previewSnapshot(),
		CapturedAt: time.Now().UnixMilli(),
	})
}

// cpuPercent samples the aggregate /proc/stat jiffies twice ~100ms apart and
// reports busy% = 100*(1 - idleΔ/totalΔ), clamped to [0,100].
func cpuPercent() float64 {
	idle1, total1, ok1 := readCPUSample()
	if !ok1 {
		return 0
	}
	time.Sleep(100 * time.Millisecond)
	idle2, total2, ok2 := readCPUSample()
	if !ok2 || total2 <= total1 {
		return 0
	}
	if idle2 < idle1 {
		idle2 = idle1
	}
	pct := 100 * (1 - float64(idle2-idle1)/float64(total2-total1))
	return math.Max(0, math.Min(100, pct))
}

// readCPUSample returns idle jiffies and total jiffies from /proc/stat.
func readCPUSample() (idle, total uint64, ok bool) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	return parseCPUSample(string(data))
}

// parseCPUSample extracts idle and total jiffies from the first ("cpu ") line
// of /proc/stat content. total sums user..steal (fields 1..8), matching the
// extension's resource monitor; idle is the idle column. Any malformed first
// line reports !ok rather than a half-parsed sample.
func parseCPUSample(data string) (idle, total uint64, ok bool) {
	line := data
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	fields := strings.Fields(line)
	if len(fields) < 9 || fields[0] != "cpu" {
		return 0, 0, false
	}
	for i := 1; i <= 8; i++ {
		v, err := strconv.ParseUint(fields[i], 10, 64)
		if err != nil {
			return 0, 0, false
		}
		total += v
	}
	idle, _ = strconv.ParseUint(fields[4], 10, 64)
	return idle, total, true
}

func ramSnapshot() ramStats {
	totalKb, availKb := readMemInfo()
	if totalKb == 0 {
		return ramStats{}
	}
	if availKb > totalKb {
		availKb = totalKb
	}
	usedKb := totalKb - availKb
	return ramStats{
		UsedMb:  int(math.Round(float64(usedKb) / 1024)),
		TotalMb: int(math.Round(float64(totalKb) / 1024)),
		Pct:     float64(usedKb) / float64(totalKb) * 100,
	}
}

func readMemInfo() (totalKb, availKb uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	return parseMemInfo(f)
}

// parseMemInfo scans /proc/meminfo content for the MemTotal/MemAvailable rows
// (kB values); a row that is absent or malformed leaves its value zero.
func parseMemInfo(r io.Reader) (totalKb, availKb uint64) {
	s := bufio.NewScanner(r)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			totalKb, _ = strconv.ParseUint(fields[1], 10, 64)
		case "MemAvailable:":
			availKb, _ = strconv.ParseUint(fields[1], 10, 64)
		}
	}
	return totalKb, availKb
}

func diskSnapshot() diskStats {
	var st unix.Statfs_t
	if err := unix.Statfs("/", &st); err != nil || st.Bsize <= 0 {
		return diskStats{}
	}
	bsize := uint64(st.Bsize)
	total := st.Blocks * bsize
	free := st.Bavail * bsize
	if total == 0 {
		return diskStats{}
	}
	if free > total {
		free = total
	}
	used := total - free
	const gb = float64(1 << 30)
	return diskStats{
		UsedGb:  math.Round(float64(used)/gb*10) / 10,
		TotalGb: math.Round(float64(total)/gb*10) / 10,
		Pct:     float64(used) / float64(total) * 100,
	}
}

// listWindows returns the base session's windows, or an empty slice when the
// session does not exist yet (so the JSON is [] rather than null).
func listWindows(ctx context.Context) []window {
	out, err := tmuxOutput(ctx, "list-windows", "-t", tmuxSession, "-F", "#{window_index}|#{window_active}|#{window_name}")
	if err != nil {
		return []window{}
	}
	return parseWindows(out)
}

// parseWindows turns tmux `index|active|name` lines into windows. The free-text
// name is LAST so SplitN(_, "|", 3) keeps any '|' inside a renamed window in the
// final field — a rename can never corrupt index/active parsing. A line whose index
// is not an integer is skipped rather than half-parsed.
func parseWindows(out string) []window {
	ws := []window{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 3)
		if len(parts) != 3 {
			continue
		}
		idx, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		ws = append(ws, window{Index: idx, Name: parts[2], Active: parts[1] == "1"})
	}
	return ws
}

func previewSnapshot() previewStats {
	port := 3000
	if v := os.Getenv("ENVHAVEN_EXPOSED_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 65535 {
			port = n
		}
	}
	return previewStats{PortOpen: tcpOpen(port), Port: port}
}

func tcpOpen(port int) bool {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// ---------------------------------------------------------------------------
// GET/POST /__console/artifacts + GET /__console/artifacts/raw — the drop folder.
// ---------------------------------------------------------------------------

type artifact struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

func handleArtifacts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		listArtifacts(w)
	case http.MethodPost:
		uploadArtifact(w, r)
	case http.MethodDelete:
		deleteArtifact(w, r)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func listArtifacts(w http.ResponseWriter) {
	arts := []artifact{}
	entries, err := os.ReadDir(artifactsDir)
	if err != nil {
		// An absent drop folder is simply an empty list; any other read error
		// (permissions, IO) is surfaced rather than masquerading as "no artifacts".
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusOK, map[string]any{"artifacts": arts})
			return
		}
		writeAPIError(w, http.StatusInternalServerError, "could not read artifacts")
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		arts = append(arts, artifact{Name: e.Name(), Size: info.Size(), Mtime: info.ModTime().Unix()})
	}
	sort.Slice(arts, func(i, j int) bool { return arts[i].Mtime > arts[j].Mtime })
	writeJSON(w, http.StatusOK, map[string]any{"artifacts": arts})
}

func uploadArtifact(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxArtifactUpload)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid upload")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "missing file")
		return
	}
	defer file.Close()
	name, ok := sanitizeArtifactName(header.Filename)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid filename")
		return
	}
	if err := os.MkdirAll(artifactsDir, 0o755); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "write failed")
		return
	}
	final := uniqueName(name)
	full := filepath.Join(artifactsDir, final)
	// O_EXCL so we never clobber: uniqueName already resolved a free name, and
	// the exclusive create closes the tiny race between the check and the write.
	dst, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "write failed")
		return
	}
	// Close explicitly on every path and never reply success past a failure: a
	// failed copy — or a Close surfacing a deferred write error — removes the
	// partial file first, so the drop folder only ever lists complete uploads.
	if _, err := io.Copy(dst, file); err != nil {
		_ = dst.Close()
		_ = os.Remove(full)
		writeAPIError(w, http.StatusInternalServerError, "write failed")
		return
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(full)
		writeAPIError(w, http.StatusInternalServerError, "write failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": final})
}

// resolveArtifact turns the ?name= query into an existing regular file inside
// artifactsDir. It owns the one name guard (a bare filename, no traversal) and the
// existence contract the raw download and delete share: a bad name is 400, a missing
// file or a directory is 404 — both written here, so callers handle only the happy
// path. info.Name() is the sanitized filename, reused for the download header.
func resolveArtifact(w http.ResponseWriter, r *http.Request) (full string, info os.FileInfo, ok bool) {
	name, valid := sanitizeArtifactName(r.URL.Query().Get("name"))
	if !valid {
		writeAPIError(w, http.StatusBadRequest, "invalid name")
		return "", nil, false
	}
	full = filepath.Join(artifactsDir, name)
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		writeAPIError(w, http.StatusNotFound, "not found")
		return "", nil, false
	}
	return full, info, true
}

// deleteArtifact removes a single file from artifactsDir. A missing file reads as
// 404, so a double-delete is idempotent to the client.
func deleteArtifact(w http.ResponseWriter, r *http.Request) {
	full, _, ok := resolveArtifact(w, r)
	if !ok {
		return
	}
	if err := os.Remove(full); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	writeOK(w)
}

func handleArtifactRaw(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	full, info, ok := resolveArtifact(w, r)
	if !ok {
		return
	}
	f, err := os.Open(full)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "not found")
		return
	}
	defer f.Close()
	// info.Name() is the sanitized filename (no quotes/backslash/control chars), so
	// it is safe inside the quoted Content-Disposition value. ServeContent sniffs the
	// type and handles range requests.
	name := info.Name()
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	http.ServeContent(w, r, name, info.ModTime(), f)
}

// sanitizeArtifactName accepts only a bare filename inside artifactsDir. It
// rejects empty, `.`/`..`, any path separator (via the Base identity check), any
// `..` substring, NUL/control characters, and the quote/backslash that would
// break the Content-Disposition header. The traversal `../etc/passwd` is
// rejected outright rather than silently reduced to its basename.
func sanitizeArtifactName(name string) (string, bool) {
	if name == "" || name == "." || name == ".." {
		return "", false
	}
	if strings.Contains(name, "..") || name != filepath.Base(name) {
		return "", false
	}
	for _, ch := range name {
		if ch < 0x20 || ch == '"' || ch == '\\' {
			return "", false
		}
	}
	return name, true
}

// uniqueName returns name, or `stem (2)ext`, `stem (3)ext`, … when earlier
// candidates already exist in artifactsDir.
func uniqueName(name string) string {
	if !fileExists(filepath.Join(artifactsDir, name)) {
		return name
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 2; ; i++ {
		cand := fmt.Sprintf("%s (%d)%s", stem, i, ext)
		if !fileExists(filepath.Join(artifactsDir, cand)) {
			return cand
		}
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

package main

// The Cockpit HUD's skills domain: everything behind /__console/skills. The
// installed list and install/remove ride the image-baked `skills` CLI; search merges
// EnvHaven's first-party skills (GitHub) with the skills.sh registry; the
// detail view fetches SKILL.md from the skill's upstream repo. registerAPI
// (api.go) mounts every route here behind the same withAPI guard as the rest
// of the Cockpit, so nothing in this file is reachable without the bearer.
//
// Three properties hold throughout:
//  1. The CLI runs through bounded exec argv (no `sh -c` or runtime npx resolution),
//     and every client-supplied argument passes its shape check (validSkillSource,
//     validSkillID) and safeArg first, so a request string can never become a
//     flag, a shell word, or a source other than a GitHub owner/repo.
//  2. Every remote read (search, the first-party listing, skill markdown) is
//     cached for skillsCacheTTL (the same 5 minutes the extension's
//     skillsService cached before this logic moved server-side), in caches with
//     fixed entry and byte bounds.
//  3. No remote body is read past a fixed size (maxRemoteJSON, maxSkillFile).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// skillsCLITimeout bounds the skills CLI. `ls` returns instantly; `add`
	// fetches over the network and can be slow, so this is generous.
	skillsCLITimeout = 120 * time.Second
	// skillsListLimit bounds the output of `skills ls -g --json`, which an install's
	// or a remove's commandOutputLimit would cut short: the listing prints a few
	// hundred bytes per installed skill, so 64 KiB is about 150 skills, and one bulk
	// install of a large collection brings several hundred. It is the user's own
	// skills listed by the image's own CLI, not a remote body, so the bound only has
	// to stop a runaway process: 16 MiB is about three times the listing of the
	// largest public collection (8,589 skills, about 5 MB).
	skillsListLimit = 16 << 20

	// skillsCacheTTL is how long each remote read is reused before re-fetching.
	skillsCacheTTL = 5 * time.Minute
	// skillsCacheEntries and skillsCacheBytes bound each of the caches below. Their
	// keys come from clients (raw search queries, any owner/repo), so the bounds,
	// not the TTL, are what keep them small.
	skillsCacheEntries = 256
	skillsCacheBytes   = 4 << 20

	// maxRemoteJSON bounds a GitHub tree listing or a skills.sh response. GitHub
	// stops a recursive tree at 7 MB and marks it truncated, so a real one fits.
	maxRemoteJSON = 8 << 20
	// maxSkillFile bounds one SKILL.md: fetchSkillMarkdown reads up to
	// maxSkillMdCandidates of them at once, and the one it returns is cached.
	maxSkillFile = 1 << 20
)

// Remote endpoints. Vars, not consts, so tests can point them at an httptest
// server (the toolDefsPath seam pattern).
var (
	skillsShAPI   = "https://skills.sh/api/search"
	githubAPIBase = "https://api.github.com"
	githubRawBase = "https://raw.githubusercontent.com"
)

// ttlCache is the smallest expiring cache that stays bounded: one mutex, one map,
// entries valid for skillsCacheTTL. An expired entry reads as a miss and is deleted
// on that read. Every put first drops all expired entries, then, while the new value
// would break either bound, the entry closest to expiry, so neither a churning key set
// (the per-keystroke search cache) nor a few large values can grow it past maxEntries
// or maxBytes.
type ttlCache[V any] struct {
	mu                   sync.Mutex
	entries              map[string]ttlEntry[V]
	maxEntries, maxBytes int
	bytes                int // sum of the entries' sizes
}

type ttlEntry[V any] struct {
	val  V
	exp  time.Time
	size int
}

func newTTLCache[V any](maxEntries, maxBytes int) *ttlCache[V] {
	return &ttlCache[V]{entries: map[string]ttlEntry[V]{}, maxEntries: maxEntries, maxBytes: maxBytes}
}

func (c *ttlCache[V]) get(key string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Now().After(e.exp) {
		c.drop(key) // reap the expired entry; a no-op on a plain miss
		var zero V
		return zero, false
	}
	return e.val, true
}

// put caches val under key. size is what the value costs to keep, in bytes; the key
// is added to it. A value that could never fit is not cached at all.
func (c *ttlCache[V]) put(key string, val V, size int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	size += len(key)
	c.drop(key)
	if c.maxEntries < 1 || size > c.maxBytes {
		return
	}
	now := time.Now()
	for k, e := range c.entries {
		if now.After(e.exp) {
			c.drop(k)
		}
	}
	for len(c.entries) >= c.maxEntries || c.bytes+size > c.maxBytes {
		c.drop(c.soonestToExpire())
	}
	c.entries[key] = ttlEntry[V]{val: val, exp: now.Add(skillsCacheTTL), size: size}
	c.bytes += size
}

func (c *ttlCache[V]) drop(key string) {
	if e, ok := c.entries[key]; ok {
		c.bytes -= e.size
		delete(c.entries, key)
	}
}

func (c *ttlCache[V]) soonestToExpire() string {
	var key string
	var exp time.Time
	found := false
	for k, e := range c.entries {
		if !found || e.exp.Before(exp) {
			key, exp, found = k, e.exp, true
		}
	}
	return key
}

// resultsSize approximates what a result list costs to keep: its strings, plus a
// fixed allowance per result for the struct around them.
func resultsSize(rs []skillResult) int {
	n := 0
	for _, r := range rs {
		n += 64 + len(r.ID) + len(r.SkillID) + len(r.Name) + len(r.Source)
	}
	return n
}

// The three caches the extension's skillsService kept and the TS→Go port
// initially dropped: skills.sh results by query, the first-party listing (one
// entry), and skill markdown by source/skillId. Pointers so a test can swap
// in a fresh cache without copying a mutex.
var (
	searchCache    = newTTLCache[[]skillResult](skillsCacheEntries, skillsCacheBytes)
	envSkillsCache = newTTLCache[[]skillResult](skillsCacheEntries, skillsCacheBytes)
	markdownCache  = newTTLCache[string](skillsCacheEntries, skillsCacheBytes)
)

// ---------------------------------------------------------------------------
// GET/POST /__console/skills — installed list, registry search, install/remove.
// ---------------------------------------------------------------------------

type installedSkill struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Source      *string  `json:"source"`
	Path        string   `json:"path"`
	Agents      []string `json:"agents"`
}

type skillResult struct {
	ID       string   `json:"id"`
	SkillID  string   `json:"skillId"`
	Name     string   `json:"name"`
	Installs *float64 `json:"installs"`
	Source   string   `json:"source"`
}

func handleSkills(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		if q := r.URL.Query().Get("q"); q != "" {
			results, err := searchSkills(r.Context(), q)
			if err != nil {
				writeAPIError(w, http.StatusBadGateway, "skill search failed: "+errDetail(err))
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"results": results})
			return
		}
		installed, err := listInstalledSkills(r.Context())
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "skills unavailable: "+errDetail(err))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"installed": installed})
	case http.MethodPost:
		handleSkillAction(w, r)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

type skillActionRequest struct {
	Action  string `json:"action"`
	Source  string `json:"source"`
	SkillID string `json:"skillId"`
	Dir     string `json:"dir"`
}

func handleSkillAction(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxActionBody)
	var req skillActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid body")
		return
	}
	switch req.Action {
	case "install":
		// The markdown route's shape checks, plus safeArg because the CLI parses both
		// as argv. A source is a GitHub owner/repo, the form every installable registry
		// result has; `skills add` would also take a URL, a path, or a git remote, none
		// of which a registry install sends. skills.sh does list a few bare domains as sources,
		// but `skills add` reads a bare name as a git URL and fails on it, so
		// refusing them here loses nothing that worked.
		if !validSkillSource(req.Source) || !validSkillID(req.SkillID) || !safeArg(req.Source) || !safeArg(req.SkillID) {
			writeAPIError(w, http.StatusBadRequest, "invalid source or skillId")
			return
		}
		agents, err := connectedAgents()
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, credentialErrorMessage(err, "tool definitions unavailable"))
			return
		}
		if len(agents) == 0 {
			writeAPIError(w, http.StatusBadRequest, "no connected tools support skills")
			return
		}
		args := []string{"add", req.Source, "--skill", req.SkillID, "--full-depth", "-g", "-y"}
		for _, a := range agents {
			args = append(args, "-a", a)
		}
		if _, err := runSkillsCLI(r.Context(), commandOutputLimit, args...); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "install failed: "+errDetail(err))
			return
		}
		writeOK(w)
	case "remove":
		dir := filepath.Base(strings.TrimRight(req.Dir, "/"))
		if dir == "" || dir == "." || dir == ".." || !safeArg(dir) {
			writeAPIError(w, http.StatusBadRequest, "invalid dir")
			return
		}
		if _, err := runSkillsCLI(r.Context(), commandOutputLimit, "remove", dir, "-g", "-y"); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "remove failed: "+errDetail(err))
			return
		}
		writeOK(w)
	default:
		writeAPIError(w, http.StatusBadRequest, "unknown action")
	}
}

// safeArg rejects empty values and values that would be parsed as a CLI flag,
// so a client string cannot inject an option into the skills invocation.
func safeArg(s string) bool {
	return s != "" && !strings.HasPrefix(s, "-")
}

// errDetail flattens err to a short single-line tail — an *exec.ExitError's
// captured stderr when present, else the error text; last non-empty line only,
// capped at 200 bytes — so a fixed API error string still names the actual
// cause without ever pushing a multi-line dump through the JSON body.
func errDetail(err error) string {
	msg := err.Error()
	var xe *exec.ExitError
	if errors.As(err, &xe) {
		if s := strings.TrimSpace(string(xe.Stderr)); s != "" {
			msg = s
		}
	}
	lines := strings.Split(strings.TrimSpace(msg), "\n")
	tail := strings.TrimSpace(lines[len(lines)-1])
	if len(tail) > 200 {
		tail = tail[:200]
	}
	return tail
}

// connectedAgents returns the skills-agent id of every tool that is wired to
// skills.sh (has a skillsAgent), installed on PATH, and currently authenticated
// (checkAuth ready). The installed gate matches /tools (tools.go): a tool that
// isn't on PATH reports needs-auth regardless of a stray env var, so it is
// never offered as a skill-install target either.
func connectedAgents() ([]string, error) {
	defs, err := loadToolDefs()
	if err != nil {
		return nil, err
	}
	home := homeDir()
	sources, err := readCredentialSources(home)
	if err != nil {
		return nil, err
	}
	var agents []string
	for _, d := range defs {
		if d.SkillsAgent == "" || !toolInstalled(d.Command) {
			continue
		}
		if checkAuth(d, home, sources).status == "ready" {
			agents = append(agents, d.SkillsAgent)
		}
	}
	return agents, nil
}

// runSkillsCLI runs the image's skills CLI, keeping at most limit bytes of its output.
// DISABLE_TELEMETRY turns off the CLI's reports to skills.sh: every install and remove,
// and an audit query naming each skill it adds (skills 1.7.4, src/telemetry.ts). Nothing
// the image runs phones home, so it is set last, over any inherited value.
func runSkillsCLI(ctx context.Context, limit int, args ...string) ([]byte, error) {
	result, err := runBoundedArgvCapture(
		ctx,
		skillsCLITimeout,
		limit,
		append([]string{"skills"}, args...),
		"",
		append(os.Environ(), "NO_COLOR=1", "DISABLE_TELEMETRY=1"),
	)
	if err != nil && len(result.stderr) > 0 {
		return result.stdout, fmt.Errorf("%w: %s", err, result.stderr)
	}
	return result.stdout, err
}

func listInstalledSkills(ctx context.Context) ([]installedSkill, error) {
	out, err := runSkillsCLI(ctx, skillsListLimit, "ls", "-g", "--json")
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Name   string   `json:"name"`
		Path   string   `json:"path"`
		Agents []string `json:"agents"`
	}
	if err := json.Unmarshal(out, &rows); err != nil {
		return nil, err
	}
	skills := make([]installedSkill, 0, len(rows))
	for _, row := range rows {
		description := ""
		var source *string
		if md, err := os.ReadFile(filepath.Join(row.Path, "SKILL.md")); err == nil {
			fm := parseFrontmatter(string(md))
			description = fm["description"]
			if s := fm["source"]; s != "" {
				sc := s
				source = &sc
			}
		}
		agents := row.Agents
		if agents == nil {
			agents = []string{}
		}
		skills = append(skills, installedSkill{
			Name:        row.Name,
			Description: description,
			Source:      source,
			Path:        row.Path,
			Agents:      agents,
		})
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i].Name < skills[j].Name })
	return skills, nil
}

// searchSkills merges EnvHaven's first-party skills (GitHub, listed first, no
// install count) with skills.sh results, deduped by source+skillId. The two
// sources are independent, so they are fetched in parallel. It tolerates one
// source failing; only a double failure is an error (searchAllSkills parity).
func searchSkills(ctx context.Context, q string) ([]skillResult, error) {
	q = strings.TrimSpace(q)
	if len(q) < 2 {
		return []skillResult{}, nil
	}
	lq := strings.ToLower(q)

	var (
		wg            sync.WaitGroup
		env, sh       []skillResult
		envErr, shErr error
	)
	wg.Add(2)
	go func() { defer wg.Done(); env, envErr = fetchEnvhavenSkills(ctx) }()
	go func() { defer wg.Done(); sh, shErr = searchSkillsSh(ctx, q) }()
	wg.Wait()
	if envErr != nil && shErr != nil {
		return nil, fmt.Errorf("skills.sh: %v; envhaven: %v", shErr, envErr)
	}

	var envFiltered []skillResult
	if lq == "envhaven" {
		envFiltered = env
	} else {
		for _, s := range env {
			if strings.Contains(strings.ToLower(s.Name), lq) {
				envFiltered = append(envFiltered, s)
			}
		}
	}

	seen := map[string]bool{}
	merged := []skillResult{}
	for _, s := range append(envFiltered, sh...) {
		key := s.Source + "/" + s.SkillID
		if seen[key] {
			continue
		}
		seen[key] = true
		merged = append(merged, s)
	}
	return merged, nil
}

const envhavenSkillsSource = "envhaven/envhaven"

var (
	envhavenSkillPathRe = regexp.MustCompile(`^skills/[^/]+/SKILL\.md$`)
	skillsHTTPClient    = &http.Client{Timeout: 10 * time.Second}
)

// fetchEnvhavenSkills enumerates skills/*/SKILL.md in the envhaven/envhaven repo
// (one tree API call) and reads each frontmatter via the raw host, mapping to the
// skills.sh result shape with a null install count.
func fetchEnvhavenSkills(ctx context.Context) ([]skillResult, error) {
	if cached, ok := envSkillsCache.get(envhavenSkillsSource); ok {
		return cached, nil
	}
	var tree struct {
		Tree []struct {
			Path string `json:"path"`
			Type string `json:"type"`
		} `json:"tree"`
	}
	if err := httpGetJSON(ctx, githubAPIBase+"/repos/"+envhavenSkillsSource+"/git/trees/HEAD?recursive=1", githubHeaders(), &tree); err != nil {
		return nil, err
	}
	var results []skillResult
	for _, e := range tree.Tree {
		if e.Type != "blob" || !envhavenSkillPathRe.MatchString(e.Path) {
			continue
		}
		raw, err := httpGetText(ctx, githubRawBase+"/"+envhavenSkillsSource+"/HEAD/"+encodePath(e.Path), nil, maxSkillFile)
		if err != nil {
			continue
		}
		name := parseFrontmatter(raw)["name"]
		if name == "" {
			if parts := strings.Split(e.Path, "/"); len(parts) >= 2 {
				name = parts[1]
			}
		}
		if name == "" {
			continue
		}
		results = append(results, skillResult{
			ID:      envhavenSkillsSource + "/" + name,
			SkillID: name,
			Name:    name,
			Source:  envhavenSkillsSource,
		})
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Name < results[j].Name })
	envSkillsCache.put(envhavenSkillsSource, results, resultsSize(results))
	return results, nil
}

func searchSkillsSh(ctx context.Context, q string) ([]skillResult, error) {
	if cached, ok := searchCache.get(q); ok {
		return cached, nil
	}
	var body struct {
		Skills []struct {
			ID       string   `json:"id"`
			SkillID  string   `json:"skillId"`
			Name     string   `json:"name"`
			Installs *float64 `json:"installs"`
			Source   string   `json:"source"`
		} `json:"skills"`
	}
	if err := httpGetJSON(ctx, skillsShAPI+"?q="+url.QueryEscape(q), nil, &body); err != nil {
		return nil, err
	}
	out := make([]skillResult, 0, len(body.Skills))
	for _, s := range body.Skills {
		out = append(out, skillResult{ID: s.ID, SkillID: s.SkillID, Name: s.Name, Installs: s.Installs, Source: s.Source})
	}
	searchCache.put(q, out, resultsSize(out))
	return out, nil
}

func githubHeaders() map[string]string {
	h := map[string]string{
		"Accept":               "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	}
	if token := os.Getenv("GITHUB_TOKEN"); token != "" {
		h["Authorization"] = "Bearer " + token
	}
	return h
}

// encodePath percent-escapes each path segment, leaving the slashes, so a
// SKILL.md path is safe in a raw.githubusercontent.com URL.
func encodePath(p string) string {
	parts := strings.Split(p, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return strings.Join(parts, "/")
}

// httpGetText GETs u (with optional headers) and returns the body on 200 OK;
// any other status is an error, and so is a body longer than limit bytes, which is
// never read past the limit: the remote is skills.sh or GitHub, or whoever stands
// in for them on the path, and a body without a bound could fill the container's
// memory within the client timeout. This is the ONE request/do/status path every
// remote skills read goes through; httpGetJSON wraps it.
func httpGetText(ctx context.Context, u string, headers map[string]string, limit int64) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	for k, val := range headers {
		req.Header.Set(k, val)
	}
	resp, err := skillsHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s: HTTP %d", u, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return "", err
	}
	if int64(len(data)) > limit {
		return "", fmt.Errorf("GET %s: response larger than %d bytes", u, limit)
	}
	return string(data), nil
}

func httpGetJSON(ctx context.Context, u string, headers map[string]string, v any) error {
	body, err := httpGetText(ctx, u, headers, maxRemoteJSON)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(body), v)
}

var (
	frontmatterBodyRe = regexp.MustCompile(`(?s)^---\s*\n(.*?)\n---`)
	frontmatterLineRe = regexp.MustCompile(`^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$`)
)

// parseFrontmatter reads the leading `---`…`---` YAML block and returns the
// name/description/source/license scalars, stripping matched surrounding quotes
// (parseSkillFrontmatter parity).
func parseFrontmatter(md string) map[string]string {
	out := map[string]string{}
	m := frontmatterBodyRe.FindStringSubmatch(md)
	if m == nil {
		return out
	}
	for _, line := range strings.Split(m[1], "\n") {
		kv := frontmatterLineRe.FindStringSubmatch(line)
		if kv == nil {
			continue
		}
		key, val := kv[1], strings.TrimSpace(kv[2])
		if len(val) >= 2 && (val[0] == '"' && val[len(val)-1] == '"' || val[0] == '\'' && val[len(val)-1] == '\'') {
			val = val[1 : len(val)-1]
		}
		switch key {
		case "name", "description", "source", "license":
			out[key] = val
		}
	}
	return out
}

const maxSkillMdCandidates = 30

var (
	frontmatterBlockRe = regexp.MustCompile(`(?s)^---\s*\n.*?\n---[ \t]*(\r?\n)?`)
	skillSourceRe      = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
)

// stripFrontmatter removes the leading `---`…`---` block so the rendered body is just the
// markdown. The console is the sole owner of skill-markdown parsing; clients render what
// it returns (the extension's consoleClient and the dashboard's cockpit both fetch here).
func stripFrontmatter(md string) string {
	return frontmatterBlockRe.ReplaceAllString(md, "")
}

func validSkillSource(s string) bool {
	return skillSourceRe.MatchString(s) && !strings.Contains(s, "..")
}

func validSkillID(s string) bool {
	if s == "" || len(s) > 128 || strings.Contains(s, "..") || strings.ContainsAny(s, "/\\") {
		return false
	}
	for _, ch := range s {
		if ch < 0x20 {
			return false
		}
	}
	return true
}

// fetchSkillMarkdown resolves a skill's SKILL.md from GitHub (fetchSkillMarkdown parity):
// one tree call, a fast path on `<skillId>/SKILL.md`, else fetch up to N candidates and match
// by frontmatter name. Returns the raw file (frontmatter intact) for the caller to split.
func fetchSkillMarkdown(ctx context.Context, source, skillID string) (string, error) {
	key := source + "/" + skillID
	if cached, ok := markdownCache.get(key); ok {
		return cached, nil
	}
	var tree struct {
		Tree []struct {
			Path string `json:"path"`
			Type string `json:"type"`
		} `json:"tree"`
		Truncated bool `json:"truncated"`
	}
	if err := httpGetJSON(ctx, githubAPIBase+"/repos/"+source+"/git/trees/HEAD?recursive=1", githubHeaders(), &tree); err != nil {
		return "", err
	}
	rawURL := func(p string) string { return githubRawBase + "/" + source + "/HEAD/" + encodePath(p) }
	var candidates []string
	for _, e := range tree.Tree {
		if e.Type != "blob" || !strings.HasSuffix(e.Path, "SKILL.md") {
			continue
		}
		if e.Path == skillID+"/SKILL.md" || strings.HasSuffix(e.Path, "/"+skillID+"/SKILL.md") {
			raw, err := httpGetText(ctx, rawURL(e.Path), nil, maxSkillFile) // fast path: a dir named exactly skillId
			if err != nil {
				return "", err
			}
			markdownCache.put(key, raw, len(raw))
			return raw, nil
		}
		candidates = append(candidates, e.Path)
	}
	if tree.Truncated {
		return "", fmt.Errorf("repository tree too large to search")
	}
	// Search the first N candidates in parallel and take the first match in tree
	// order (skillsService parity: bounded fan-out, never an error for big repos).
	if len(candidates) > maxSkillMdCandidates {
		candidates = candidates[:maxSkillMdCandidates]
	}
	raws := make([]string, len(candidates))
	var wg sync.WaitGroup
	for i, p := range candidates {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if raw, err := httpGetText(ctx, rawURL(p), nil, maxSkillFile); err == nil {
				raws[i] = raw
			}
		}()
	}
	wg.Wait()
	for _, raw := range raws {
		if raw != "" && parseFrontmatter(raw)["name"] == skillID {
			markdownCache.put(key, raw, len(raw))
			return raw, nil
		}
	}
	return "", fmt.Errorf("SKILL.md not found for %q in %s", skillID, source)
}

// GET /__console/skills/markdown?source=&skillId= — the registry SKILL.md for the detail
// view. Returns the rendered body (frontmatter stripped) plus the parsed frontmatter scalars.
func handleSkillMarkdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	source := r.URL.Query().Get("source")
	skillID := r.URL.Query().Get("skillId")
	if !validSkillSource(source) || !validSkillID(skillID) {
		writeAPIError(w, http.StatusBadRequest, "invalid source or skillId")
		return
	}
	md, err := fetchSkillMarkdown(r.Context(), source, skillID)
	if err != nil {
		writeAPIError(w, http.StatusBadGateway, "could not load SKILL.md: "+errDetail(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"markdown": stripFrontmatter(md), "frontmatter": parseFrontmatter(md)})
}

// GET /__console/skills/local?path= — the SKILL.md of an installed skill (the "view" action).
// The path must belong to a currently-installed skill; no arbitrary reads.
func handleSkillLocal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeAPIError(w, http.StatusBadRequest, "missing path")
		return
	}
	installed, err := listInstalledSkills(r.Context())
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "skills unavailable: "+errDetail(err))
		return
	}
	known := false
	for _, s := range installed {
		if s.Path == path {
			known = true
			break
		}
	}
	if !known {
		writeAPIError(w, http.StatusBadRequest, "unknown skill path")
		return
	}
	raw, err := os.ReadFile(filepath.Join(path, "SKILL.md"))
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"markdown": stripFrontmatter(string(raw)), "frontmatter": parseFrontmatter(string(raw))})
}

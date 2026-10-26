package main

// Tests for the skills domain (skills.go) — the extension skillsService matrix,
// ported to the Go owner of the logic. skillsFixture serves all three remote
// hosts (skills.sh, the GitHub API, the raw host) from ONE httptest server
// through the base-URL seams and counts requests per host, so merge order,
// failure tolerance, and cache behavior are all observable without the
// network. Every fixture starts with fresh caches, so no test depends on
// another's fetches (the old TS suite ran in declaration order for exactly
// that reason).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
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

type skillsFixture struct {
	mu        sync.Mutex
	shFail    bool
	treeFail  bool
	shByQuery map[string][]skillResult
	tree      string            // GitHub tree JSON, served for every repo
	raw       map[string]string // repo-relative path -> SKILL.md body; absent -> 500
	counts    struct{ sh, tree, raw int }
}

// newSkillsFixture wires the seams to a routed test server and seeds the
// default first-party repo: deploy and verify resolve, zeta's SKILL.md 500s
// (dropped), and the tree also carries a non-blob, a too-deep path, and a
// README that the skills/<dir>/SKILL.md filter must ignore.
func newSkillsFixture(t *testing.T) *skillsFixture {
	t.Helper()
	f := &skillsFixture{
		shByQuery: map[string][]skillResult{},
		tree: `{"tree":[
			{"path":"skills/deploy/SKILL.md","type":"blob"},
			{"path":"skills/verify/SKILL.md","type":"blob"},
			{"path":"skills/zeta/SKILL.md","type":"blob"},
			{"path":"skills/deploy","type":"tree"},
			{"path":"skills/nested/sub/SKILL.md","type":"blob"},
			{"path":"README.md","type":"blob"}
		]}`,
		raw: map[string]string{
			"skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploy things\n---\nbody",
			"skills/verify/SKILL.md": "---\nname: verify\ndescription: Verify things\n---\nbody",
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/search", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.counts.sh++
		if f.shFail {
			http.Error(w, "down", http.StatusInternalServerError)
			return
		}
		skills := f.shByQuery[r.URL.Query().Get("q")]
		if skills == nil {
			skills = []skillResult{}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"skills": skills})
	})
	mux.HandleFunc("/gh/repos/", func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.counts.tree++
		if f.treeFail {
			http.Error(w, "down", http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(w, f.tree)
	})
	mux.HandleFunc("/raw/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.counts.raw++
		_, rel, ok := strings.Cut(r.URL.Path, "/HEAD/")
		body, present := f.raw[rel]
		if !ok || !present {
			http.Error(w, "missing", http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(w, body)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prevSh, prevAPI, prevRaw := skillsShAPI, githubAPIBase, githubRawBase
	skillsShAPI, githubAPIBase, githubRawBase = srv.URL+"/api/search", srv.URL+"/gh", srv.URL+"/raw"
	t.Cleanup(func() { skillsShAPI, githubAPIBase, githubRawBase = prevSh, prevAPI, prevRaw })

	prevSearch, prevEnv, prevMd := searchCache, envSkillsCache, markdownCache
	searchCache = newTTLCache[[]skillResult](skillsCacheEntries, skillsCacheBytes)
	envSkillsCache = newTTLCache[[]skillResult](skillsCacheEntries, skillsCacheBytes)
	markdownCache = newTTLCache[string](skillsCacheEntries, skillsCacheBytes)
	t.Cleanup(func() { searchCache, envSkillsCache, markdownCache = prevSearch, prevEnv, prevMd })

	return f
}

func (f *skillsFixture) setSh(q string, results ...skillResult) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.shByQuery[q] = results
}

func (f *skillsFixture) fail(sh, tree bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.shFail, f.treeFail = sh, tree
}

func (f *skillsFixture) requestCounts() (sh, tree, raw int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.counts.sh, f.counts.tree, f.counts.raw
}

func installs(n float64) *float64 { return &n }

func names(rs []skillResult) []string {
	out := make([]string, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.Name)
	}
	return out
}

// TestFetchEnvhavenSkills pins the first-party listing: only blob entries at
// skills/<dir>/SKILL.md count, an unfetchable SKILL.md drops its skill, the
// result is name-sorted with a null install count — and a second call inside
// the TTL is served from cache without another tree fetch.
func TestFetchEnvhavenSkills(t *testing.T) {
	f := newSkillsFixture(t)
	got, err := fetchEnvhavenSkills(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(names(got), []string{"deploy", "verify"}) { // zeta dropped, sorted
		t.Fatalf("names = %v, want [deploy verify]", names(got))
	}
	want := skillResult{ID: "envhaven/envhaven/deploy", SkillID: "deploy", Name: "deploy", Source: "envhaven/envhaven"}
	if got[0] != want {
		t.Fatalf("first = %+v, want %+v", got[0], want)
	}

	if _, err := fetchEnvhavenSkills(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, tree, _ := f.requestCounts(); tree != 1 {
		t.Fatalf("tree fetches = %d, want 1 (second call must hit the cache)", tree)
	}
}

// TestSearchSkillsMergeAndOrder pins the merged search result: first-party
// matches lead, community results follow, and a skill surfaced by both sources
// (same source+skillId) appears once, with the first-party entry winning the
// dedup (null installs) while community entries keep their counter.
func TestSearchSkillsMergeAndOrder(t *testing.T) {
	f := newSkillsFixture(t)
	f.setSh("deploy",
		skillResult{ID: "d1", SkillID: "deploy", Name: "deploy", Installs: installs(12), Source: "envhaven/envhaven"},
		skillResult{ID: "d2", SkillID: "react-deploy", Name: "react-deploy", Installs: installs(5), Source: "acme/skills"},
	)
	got, err := searchSkills(context.Background(), "deploy")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(names(got), []string{"deploy", "react-deploy"}) {
		t.Fatalf("names = %v, want [deploy react-deploy]", names(got))
	}
	if got[0].Installs != nil {
		t.Fatalf("dedup winner installs = %v, want nil (the first-party entry)", *got[0].Installs)
	}
	if got[1].Installs == nil || *got[1].Installs != 5 {
		t.Fatalf("community installs = %v, want 5", got[1].Installs)
	}
}

// TestSearchSkillsEnvhavenQuery: the literal query "envhaven" lists EVERY
// first-party skill (not just name matches), still ahead of community results.
func TestSearchSkillsEnvhavenQuery(t *testing.T) {
	f := newSkillsFixture(t)
	f.setSh("envhaven",
		skillResult{ID: "c1", SkillID: "envhaven-tips", Name: "envhaven-tips", Installs: installs(3), Source: "acme/skills"},
	)
	got, err := searchSkills(context.Background(), "envhaven")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(names(got), []string{"deploy", "verify", "envhaven-tips"}) {
		t.Fatalf("names = %v, want [deploy verify envhaven-tips]", names(got))
	}
}

// TestSearchSkillsToleratesOneFailure pins the availability contract: either
// source may fail alone and the other still answers; only a double failure is
// an error, and that error names both causes.
func TestSearchSkillsToleratesOneFailure(t *testing.T) {
	t.Run("skills.sh down", func(t *testing.T) {
		f := newSkillsFixture(t)
		f.fail(true, false)
		got, err := searchSkills(context.Background(), "ver")
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(names(got), []string{"verify"}) {
			t.Fatalf("names = %v, want [verify]", names(got))
		}
	})
	t.Run("envhaven down", func(t *testing.T) {
		f := newSkillsFixture(t)
		f.fail(false, true)
		f.setSh("zz", skillResult{ID: "z1", SkillID: "zzz", Name: "zzz", Installs: installs(1), Source: "acme/skills"})
		got, err := searchSkills(context.Background(), "zz")
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(names(got), []string{"zzz"}) {
			t.Fatalf("names = %v, want [zzz]", names(got))
		}
	})
	t.Run("both down", func(t *testing.T) {
		f := newSkillsFixture(t)
		f.fail(true, true)
		_, err := searchSkills(context.Background(), "boom")
		if err == nil {
			t.Fatal("want error when both sources fail")
		}
		if msg := err.Error(); !strings.Contains(msg, "skills.sh:") || !strings.Contains(msg, "envhaven:") {
			t.Fatalf("error %q must name both sources", msg)
		}
	})
}

// TestSearchSkillsShortQuery: under 2 trimmed characters returns empty without
// touching the network (the dashboard fires this on every keystroke).
func TestSearchSkillsShortQuery(t *testing.T) {
	f := newSkillsFixture(t)
	for _, q := range []string{"a", "  ", ""} {
		got, err := searchSkills(context.Background(), q)
		if err != nil || len(got) != 0 {
			t.Fatalf("searchSkills(%q) = (%v, %v), want empty", q, got, err)
		}
	}
	if sh, tree, raw := f.requestCounts(); sh+tree+raw != 0 {
		t.Fatalf("short queries hit the network: sh=%d tree=%d raw=%d", sh, tree, raw)
	}
}

// TestSearchSkillsShCache pins the per-query cache: the same query twice is
// one request; a different query is a fresh one.
func TestSearchSkillsShCache(t *testing.T) {
	f := newSkillsFixture(t)
	f.setSh("cachetest", skillResult{ID: "q1", SkillID: "q", Name: "q", Installs: installs(1), Source: "acme/skills"})
	for range 2 {
		if _, err := searchSkillsSh(context.Background(), "cachetest"); err != nil {
			t.Fatal(err)
		}
	}
	if sh, _, _ := f.requestCounts(); sh != 1 {
		t.Fatalf("skills.sh fetches = %d, want 1 (second call must hit the cache)", sh)
	}
	if _, err := searchSkillsSh(context.Background(), "other"); err != nil {
		t.Fatal(err)
	}
	if sh, _, _ := f.requestCounts(); sh != 2 {
		t.Fatalf("skills.sh fetches = %d, want 2 after a new query", sh)
	}
}

// TestSearchSkillsShError: a non-OK response is an error naming the status,
// and a failure is never cached.
func TestSearchSkillsShError(t *testing.T) {
	f := newSkillsFixture(t)
	f.fail(true, false)
	if _, err := searchSkillsSh(context.Background(), "failing"); err == nil || !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("err = %v, want HTTP 500", err)
	}
	f.fail(false, false)
	if _, err := searchSkillsSh(context.Background(), "failing"); err != nil {
		t.Fatalf("recovered query failed: %v (the error must not have been cached)", err)
	}
}

// TestFetchSkillMarkdownCache: the markdown fetch (fast path: a directory
// named exactly skillId) returns the raw file with frontmatter intact and is
// cached by source+skillId, so reopening the detail view inside the TTL costs
// zero remote calls.
func TestFetchSkillMarkdownCache(t *testing.T) {
	f := newSkillsFixture(t)
	md, err := fetchSkillMarkdown(context.Background(), "envhaven/envhaven", "deploy")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(md, "name: deploy") {
		t.Fatalf("markdown = %q, want the raw file with frontmatter intact", md)
	}
	if _, err := fetchSkillMarkdown(context.Background(), "envhaven/envhaven", "deploy"); err != nil {
		t.Fatal(err)
	}
	if _, tree, raw := f.requestCounts(); tree != 1 || raw != 1 {
		t.Fatalf("fetches = tree %d raw %d, want 1/1 (second call must hit the cache)", tree, raw)
	}
}

// TestParseFrontmatter pins the scalar extraction the skills views depend on:
// known keys only, values unquoted when the surrounding quotes match, and no
// leading block parses to an empty map.
func TestParseFrontmatter(t *testing.T) {
	md := "---\nname: \"quoted\"\ndescription: plain text\nlicense: 'MIT'\nignored: field\n---\n# Body\n"
	want := map[string]string{"name": "quoted", "description": "plain text", "license": "MIT"}
	if got := parseFrontmatter(md); !maps.Equal(got, want) {
		t.Fatalf("parseFrontmatter = %v, want %v", got, want)
	}
	if got := parseFrontmatter("no frontmatter"); len(got) != 0 {
		t.Fatalf("no-frontmatter = %v, want empty", got)
	}
}

// TestStripFrontmatter: only the leading block is removed; a body without one
// passes through untouched.
func TestStripFrontmatter(t *testing.T) {
	md := "---\nname: \"quoted\"\ndescription: plain text\n---\n# Body\n"
	if got := stripFrontmatter(md); got != "# Body\n" {
		t.Fatalf("stripFrontmatter = %q, want %q", got, "# Body\n")
	}
	if got := stripFrontmatter("no frontmatter"); got != "no frontmatter" {
		t.Fatalf("no-frontmatter = %q, want unchanged", got)
	}
}

// TestValidSkillSource pins the source gate for the registry markdown fetch:
// exactly owner/repo in the GitHub charset, no traversal (a peer of the
// sanitizeArtifactName test).
func TestValidSkillSource(t *testing.T) {
	reject := []string{
		"", "noslash", "a/b/c", "../etc", "a../b", "a/..", "a b/c", "a/b?x", "/b", "a/",
	}
	for _, s := range reject {
		if validSkillSource(s) {
			t.Fatalf("validSkillSource(%q) accepted, want reject", s)
		}
	}
	accept := []string{"envhaven/envhaven", "vercel-labs/skills", "A.b-1/c_d.2"}
	for _, s := range accept {
		if !validSkillSource(s) {
			t.Fatalf("validSkillSource(%q) rejected, want accept", s)
		}
	}
}

// TestValidSkillID pins the skillId gate: non-empty, at most 128 chars, no
// traversal, no path separators, no control bytes.
func TestValidSkillID(t *testing.T) {
	reject := []string{
		"", "..", "a..b", "a/b", `a\b`, "ctrl\x01char", "nul\x00byte", strings.Repeat("x", 129),
	}
	for _, s := range reject {
		if validSkillID(s) {
			t.Fatalf("validSkillID(%q) accepted, want reject", s)
		}
	}
	accept := []string{"deploy", "react-best-practices", "a.b", "UPPER_case-1", strings.Repeat("x", 128)}
	for _, s := range accept {
		if !validSkillID(s) {
			t.Fatalf("validSkillID(%q) rejected, want accept", s)
		}
	}
}

// TestConnectedAgentsInstalledGate pins the installed gate on the skill-install
// agent set: a tool whose env var is satisfied but whose command is not on PATH
// is NOT a connected agent (the /tools contract in tools.go: a tool that isn't
// on PATH reports needs-auth regardless of a stray env var), and a tool with no
// skillsAgent never appears however healthy it is.
func TestConnectedAgentsInstalledGate(t *testing.T) {
	dir := t.TempDir()
	defs := filepath.Join(dir, "tool-definitions.json")
	catalog := `{"tools":[
		{"id":"present","name":"Present","command":"sh","envVars":["AGENT_GATE_KEY"],"skillsAgent":"present-agent"},
		{"id":"absent","name":"Absent","command":"envhaven-absent-cmd-xyz","envVars":["AGENT_GATE_KEY"],"skillsAgent":"absent-agent"},
		{"id":"noskills","name":"NoSkills","command":"sh","envVars":["AGENT_GATE_KEY"]}
	]}`
	if err := os.WriteFile(defs, []byte(catalog), 0o600); err != nil {
		t.Fatal(err)
	}
	prev := toolDefsPath
	toolDefsPath = defs
	t.Cleanup(func() { toolDefsPath = prev })
	t.Setenv("HOME", t.TempDir()) // no rc files
	t.Setenv("AGENT_GATE_KEY", "set")

	agents, err := connectedAgents()
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(agents, []string{"present-agent"}) {
		t.Fatalf("agents = %v, want [present-agent] (installed + skillsAgent only)", agents)
	}
}

// TestHandleSkillActionValidation pins the skill action input gates, all of
// which run before the skills CLI does (so nothing here spawns a process): an unknown
// action is a 400, an install source is exactly a GitHub owner/repo and its skill id
// a plain name (the markdown route's gates), neither can become a CLI option, and a
// remove target must reduce to a plain directory name.
func TestHandleSkillActionValidation(t *testing.T) {
	cases := []struct {
		name, body string
	}{
		{"unknown action", `{"action":"frobnicate"}`},
		{"install flag source", `{"action":"install","source":"--rm-rf","skillId":"deploy"}`},
		{"install flag-shaped owner", `{"action":"install","source":"-x/skills","skillId":"deploy"}`},
		{"install flag skillId", `{"action":"install","source":"acme/skills","skillId":"-g"}`},
		{"install empty source", `{"action":"install","source":"","skillId":"deploy"}`},
		{"install URL source", `{"action":"install","source":"https://evil.example/skills.tar.gz","skillId":"deploy"}`},
		{"install git remote source", `{"action":"install","source":"git@github.com:acme/skills.git","skillId":"deploy"}`},
		{"install path source", `{"action":"install","source":"../../etc","skillId":"deploy"}`},
		{"install repo subpath source", `{"action":"install","source":"acme/skills/deep","skillId":"deploy"}`},
		{"install traversal source", `{"action":"install","source":"acme/..","skillId":"deploy"}`},
		{"install spaced source", `{"action":"install","source":"acme /skills","skillId":"deploy"}`},
		{"install bare domain source", `{"action":"install","source":"open.feishu.cn","skillId":"lark-event"}`},
		{"install empty skillId", `{"action":"install","source":"acme/skills","skillId":""}`},
		{"install path skillId", `{"action":"install","source":"acme/skills","skillId":"../x"}`},
		{"install control skillId", `{"action":"install","source":"acme/skills","skillId":"de\u0001ploy"}`},
		{"remove empty dir", `{"action":"remove","dir":""}`},
		{"remove root dir", `{"action":"remove","dir":"/"}`},
		{"remove parent dir", `{"action":"remove","dir":".."}`},
		{"remove flag dir", `{"action":"remove","dir":"-g"}`},
	}
	emptyToolCatalog(t) // were a gate to let a case through, it stops at "no connected tools", before the CLI
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/__console/skills", strings.NewReader(c.body))
			handleSkillAction(w, r)
			if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), "no connected tools") {
				t.Fatalf("status = %d (body %q), want 400 from the input gate", w.Code, w.Body.String())
			}
		})
	}
}

// emptyToolCatalog points the catalog at one with no tools and HOME at an empty
// directory, so an install that passes its gates stops at "no connected tools"
// instead of running the skills CLI.
func emptyToolCatalog(t *testing.T) {
	t.Helper()
	defs := filepath.Join(t.TempDir(), "tool-definitions.json")
	if err := os.WriteFile(defs, []byte(`{"tools":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	prev := toolDefsPath
	toolDefsPath = defs
	t.Cleanup(func() { toolDefsPath = prev })
	t.Setenv("HOME", t.TempDir())
}

// TestHandleSkillActionInstallAccepts: registry-shaped installs pass every input gate
// (a stricter gate must not refuse what the registry offers) and reach the
// connected-agent check, where the empty catalog stops them before the CLI.
func TestHandleSkillActionInstallAccepts(t *testing.T) {
	emptyToolCatalog(t)
	for _, c := range []struct{ source, skillID string }{
		{"vercel-labs/agent-skills", "react-best-practices"},
		{"envhaven/envhaven", "deploy"},
		{"A.b-1/c_d.2", "Convex Best Practices"},
	} {
		body, _ := json.Marshal(map[string]string{"action": "install", "source": c.source, "skillId": c.skillID})
		w := httptest.NewRecorder()
		handleSkillAction(w, httptest.NewRequest(http.MethodPost, "/__console/skills", strings.NewReader(string(body))))
		if !strings.Contains(w.Body.String(), "no connected tools") {
			t.Fatalf("install %s --skill %q = %d %q, want it past the input gates", c.source, c.skillID, w.Code, w.Body.String())
		}
	}
}

// TestTTLCacheBounds pins the cache bounds that keep client-chosen keys from growing
// memory: the entry and byte caps hold, the entries closest to expiry go first,
// expired entries are swept on every write, and a value that could never fit is not
// kept at all.
func TestTTLCacheBounds(t *testing.T) {
	c := newTTLCache[string](3, 100)
	for _, k := range []string{"a", "b", "c", "d"} {
		c.put(k, "v", 1)
	}
	if len(c.entries) != 3 {
		t.Fatalf("%d entries, want the cap of 3", len(c.entries))
	}
	if _, ok := c.get("a"); ok {
		t.Fatal("the entry closest to expiry survived an over-cap put")
	}

	big := strings.Repeat("x", 60)
	c.put("big", big, len(big))
	if c.bytes > c.maxBytes {
		t.Fatalf("%d bytes held, want at most %d", c.bytes, c.maxBytes)
	}
	if got, ok := c.get("big"); !ok || got != big {
		t.Fatal("a value within the byte budget was not kept")
	}
	c.put("huge", strings.Repeat("y", 200), 200)
	if _, ok := c.get("huge"); ok {
		t.Fatal("a value larger than the whole budget was kept")
	}

	sum := 0
	for _, e := range c.entries {
		sum += e.size
	}
	if sum != c.bytes {
		t.Fatalf("byte count %d drifted from the entries' sum %d", c.bytes, sum)
	}

	for k, e := range c.entries {
		e.exp = time.Now().Add(-time.Second)
		c.entries[k] = e
	}
	c.put("fresh", "v", 1)
	if len(c.entries) != 1 || c.bytes != len("fresh")+1 {
		t.Fatalf("expired entries not swept on write: %d entries, %d bytes", len(c.entries), c.bytes)
	}
}

// TestHTTPGetTextLimit: a remote body is never read past its limit, and one that
// runs over is an error rather than a truncated document.
func TestHTTPGetTextLimit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("a", 64))
	}))
	t.Cleanup(srv.Close)
	if got, err := httpGetText(context.Background(), srv.URL, nil, 64); err != nil || len(got) != 64 {
		t.Fatalf("a body exactly at the limit: %d bytes, err %v", len(got), err)
	}
	if _, err := httpGetText(context.Background(), srv.URL, nil, 63); err == nil || !strings.Contains(err.Error(), "larger than 63 bytes") {
		t.Fatalf("a body over the limit: err %v, want the size error", err)
	}
}

func fakeSkillsCLI(t *testing.T, script string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "skills"), []byte("#!/bin/sh\n"+script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestSkillsCLICapsCapturedOutput(t *testing.T) {
	fakeSkillsCLI(t, "dd if=/dev/zero bs=1M count=32 status=none\n")
	out, err := runSkillsCLI(context.Background(), commandOutputLimit, "add")
	if !errors.Is(err, errCommandOutputTruncated) {
		t.Fatalf("error = %v, want output truncation", err)
	}
	if len(out) != commandOutputLimit {
		t.Fatalf("captured %d bytes, want %d", len(out), commandOutputLimit)
	}
}

func TestSkillsCLITerminatesDescendantsHoldingOutputPipes(t *testing.T) {
	fakeSkillsCLI(t, "sleep 1000 &\nprintf ok\n")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	out, err := runSkillsCLI(ctx, commandOutputLimit, "add")
	if !errors.Is(err, exec.ErrWaitDelay) || string(out) != "ok" {
		t.Fatalf("run = (%q, %v), want output and a bounded pipe wait", out, err)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("command waited %s for a descendant's pipes", elapsed)
	}
}

// TestListInstalledSkillsReadsALargeListing: `skills ls -g --json` prints a few hundred
// bytes per installed skill, so a single bulk install (`skills add github/awesome-copilot
// --all -g` brings 460) lists far past the 64 KiB an install's or a remove's output gets.
// The listing has a bound of its own, and a listing past even that is still an error.
func TestListInstalledSkillsReadsALargeListing(t *testing.T) {
	const n = 600
	fakeSkillsCLI(t, fmt.Sprintf(`i=0
printf '['
while [ $i -lt %d ]; do
  [ $i -gt 0 ] && printf ','
  printf '{"name":"skill-%%03d","path":"/nonexistent/skills/skill-%%03d","agents":["Claude Code","Codex","OpenCode","Gemini CLI","Amp","Goose","Qwen Code","Kimi Code CLI"]}' $i $i
  i=$((i+1))
done
printf ']'
`, n))
	skills, err := listInstalledSkills(context.Background())
	if err != nil {
		t.Fatalf("a %d-skill listing: %v", n, err)
	}
	if len(skills) != n {
		t.Fatalf("listed %d skills, want %d", len(skills), n)
	}

	fakeSkillsCLI(t, fmt.Sprintf("dd if=/dev/zero bs=1M count=%d status=none\n", skillsListLimit>>20+1))
	if _, err := listInstalledSkills(context.Background()); !errors.Is(err, errCommandOutputTruncated) {
		t.Fatalf("a listing past its bound: %v, want output truncation", err)
	}
}

// TestSkillsCLIRunsWithoutTelemetry: unless DISABLE_TELEMETRY is set, the skills CLI reports
// every install and remove to skills.sh and asks its audit API about each skill it adds
// (skills 1.7.4, src/telemetry.ts isEnabled). Nothing the image runs phones home, so the
// console sets it for every run, over whatever value it inherited.
func TestSkillsCLIRunsWithoutTelemetry(t *testing.T) {
	t.Setenv("DISABLE_TELEMETRY", "")
	fakeSkillsCLI(t, `printf '%s' "$DISABLE_TELEMETRY"`)
	out, err := runSkillsCLI(context.Background(), commandOutputLimit, "add")
	if err != nil || string(out) != "1" {
		t.Fatalf("DISABLE_TELEMETRY = %q (err %v), want 1", out, err)
	}
}

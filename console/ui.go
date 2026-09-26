package main

// The embedded terminal page and its assets. Both modes serve them the same way (see
// newHandler in main.go): the managed console and the self-host console register the
// same two routes, and the one thing that differs between them, who may frame the page,
// is serveUI's argument. Everything here is fixed when the binary is built, which is what
// lets a content hash stand in for a version.

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
)

// assetsPrefix is the URL path the page loads the assets from and the mux routes here.
const assetsPrefix = "/__console/assets/"

//go:embed ui/terminal.html
var terminalHTML []byte

//go:embed ui/assets
var assetsFS embed.FS

// assets is the embedded ui/assets tree: the vendored xterm bundles and fonts, plus
// the console model, predictor modules and browser adapter, which together are the terminal client.
var assets = func() fs.FS {
	sub, err := fs.Sub(assetsFS, "ui/assets")
	if err != nil {
		fatal("embed ui/assets: " + err.Error())
	}
	return sub
}()

// assetHashes maps each embedded asset's path to the hex digest of its contents. The
// bytes are baked into this binary, so one pass at startup is exact for its whole life.
// Two things read it: the ETag on every asset response, and the version stamped into
// each asset URL the page loads.
var assetHashes = func() map[string]string {
	sums := map[string]string{}
	if err := fs.WalkDir(assets, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(assets, p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		sums[p] = hex.EncodeToString(sum[:16])
		return nil
	}); err != nil {
		fatal("hash ui/assets: " + err.Error())
	}
	return sums
}()

// assetRef matches an asset URL in the page: the assets prefix and a path under it.
var assetRef = regexp.MustCompile(regexp.QuoteMeta(assetsPrefix) + `[\w./-]+`)

// terminalPage is the embedded page with every asset URL stamped with that asset's
// content hash. `no-cache` and an ETag make the EDGE correct, and they were enough to
// stop it serving one build's page beside another build's runtime, but only for the edge.
// Cloudflare rewrites the response it passes on (measured: our `no-cache` reaches the
// browser as `max-age=14400`), so a viewer who loaded the console before an update keeps
// old runtime assets for four hours without asking anyone, while the page is new.
// A distinct URL per build is the one version of this that no intermediary can rewrite: a
// cached copy under an old version string is simply never requested again. The paths are
// untouched, so the files still resolve and still validate by ETag. The page, runtime
// modules and vendored bundles are one program split across requests, so every asset is
// stamped, not only the engine, and a reference to a file that is not embedded is a
// broken page and fails here rather than in a browser.
var terminalPage = func() []byte {
	page := assetRef.ReplaceAllFunc(terminalHTML, func(ref []byte) []byte {
		name := strings.TrimPrefix(string(ref), assetsPrefix)
		sum, ok := assetHashes[name]
		if !ok {
			fatal("ui/terminal.html loads " + name + ", which is not embedded under ui/assets")
		}
		return []byte(string(ref) + "?v=" + sum)
	})
	for _, name := range []string{
		"eh-model.js",
		"eh-predict-input.js",
		"eh-predict-layout.js",
		"eh-predict-navigation.js",
		"eh-predict-actions.js",
		"eh-predict-style.js",
		"eh-predict-renderer.js",
		"eh-predict-reconcile.js",
		"eh-predict-session.js",
		"eh-status.js",
		"eh-auth.js",
		"eh-clipboard.js",
		"eh-transport.js",
		"eh-predictor.js",
		"eh-engine.js",
	} {
		if !bytes.Contains(page, []byte(assetsPrefix+name+"?v=")) {
			fatal("ui/terminal.html no longer loads " + name)
		}
	}
	return page
}()

// serveUI writes the embedded terminal page. The page holds no secret: self-host
// fetches a token and prompts for the password only if that returns 401; managed
// receives a platform JWT from the embedding dashboard over postMessage. The SAME
// page serves both modes, and the only difference is who may frame it. frameAncestors
// is empty for self-host (opened top-level, so framing is denied outright) and the
// CSP frame-ancestors origin list for managed (only the dashboard may embed the
// live terminal). This is the whole anti-clickjacking gate for the page.
func serveUI(w http.ResponseWriter, frameAncestors []string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store") // changes with every build; never serve a stale one
	if len(frameAncestors) == 0 {
		w.Header().Set("X-Frame-Options", "DENY")
	} else {
		w.Header().Set("Content-Security-Policy", "frame-ancestors "+strings.Join(frameAncestors, " "))
	}
	_, _ = w.Write(terminalPage)
}

// serveAsset serves one embedded asset from under assetsPrefix, with its content type
// inferred from its extension, a content-hash ETag and an explicit caching rule. Only
// the hashed files are served: anything else under the prefix, the bare directory
// included, is a 404.
//
// Both are load-bearing, and their absence shipped a real fault. The handler used to send
// neither, so an intermediary was free to invent a policy, and one did: measured against
// a managed workspace, Cloudflare applied its own default TTL for .js
// (`cache-control: max-age=14400`, `cf-cache-status: HIT`) and kept serving the PREVIOUS
// image's runtime for four hours after the workspace updated, while terminal.html, which is
// not under this path, came from the new one. The page and its assets are one program split
// across two requests, so that skew is not a stale asset, it is two halves of different
// builds. A client-side hard reload does not clear it either: the edge answered HIT to a
// request carrying `Cache-Control: no-cache`.
//
// The assets are embedded in this binary, so their bytes cannot change while it runs and a
// new image is a new binary. That makes a content hash an exact validator. `no-cache` then
// means what it says, keep a copy but ask before using it, and the ask is answered by the
// ETag with a 304, so the cost of being correct is a round trip rather than the file.
func serveAsset(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, assetsPrefix)
	sum, ok := assetHashes[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	// An unstamped request remains valid for direct users and old callers. Once a
	// version key is present it must name these exact bytes; otherwise an intermediary
	// could cache the current file under a stale build's supposedly immutable URL.
	if versions, present := r.URL.Query()["v"]; present && (len(versions) != 1 || versions[0] != sum) {
		http.NotFound(w, r)
		return
	}
	// ServeFileFS does the conditional-request handling itself, but only against
	// headers already on the response, so both are set before delegating.
	w.Header().Set("Etag", `"`+sum+`"`)
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFileFS(w, r, assets, name)
}

package main

// The Cockpit HUD's HTTP API. These endpoints are OUT-OF-BAND siblings of the
// terminal WebSocket: the managed dashboard reads them to render live workspace
// state and drive actions without keystrokes on the wire. They share the
// console's ONE port and ONE credential wall with the socket: a bearer that
// fails verify never reaches a handler.
//
// This file owns route registration, the shared HTTP guard, origin policy, and
// response primitives. Each endpoint domain owns its handler and implementation
// in api_actions.go, api_stats.go, api_artifacts.go, tools.go, skills.go, or env.go.

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// errUnauthorized is the self-host guard's failure sentinel; the managed guard
// returns *authError. withAPI maps any non-nil verify error to a 401.
var errUnauthorized = errors.New("unauthorized")

// registerAPI mounts every Cockpit endpoint on mux behind withAPI. Called from
// BOTH newHandler branches: managed passes jwtAuth.verify plus the dashboard
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

// withAPI is the shared guard: it echoes a request Origin only when the shared
// full-origin policy admits it, answers an OPTIONS preflight with
// 204 and NO auth, then requires a valid `Authorization: Bearer` token. Any
// verify failure: missing, malformed, wrong key/issuer/audience/expiry, or
// (managed) wrong workspace, is a flat 401; the token is the wall, CORS only
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

type originPattern struct {
	source   string
	scheme   string
	hostname string
	port     string
	wildcard bool
}

// parseOrigin accepts browser origins and CSP host-sources. A configured wildcard
// must be one complete leftmost DNS label; request origins never permit one.
func parseOrigin(raw string, allowWildcard bool) (originPattern, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return originPattern{}, false
	}
	scheme := strings.ToLower(u.Scheme)
	hostname := strings.ToLower(u.Hostname())
	if (scheme != "http" && scheme != "https") || hostname == "" {
		return originPattern{}, false
	}
	wildcard := strings.HasPrefix(hostname, "*.")
	if strings.Contains(hostname, "*") && (!allowWildcard || !wildcard || strings.Contains(hostname[2:], "*")) {
		return originPattern{}, false
	}
	if wildcard && (len(hostname) == 2 || net.ParseIP(hostname[2:]) != nil) {
		return originPattern{}, false
	}
	host := hostname
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port := u.Port(); port != "" {
		host += ":" + port
	}
	return originPattern{
		source:   scheme + "://" + host,
		scheme:   scheme,
		hostname: hostname,
		port:     u.Port(),
		wildcard: wildcard,
	}, true
}

// configuredOrigins returns only canonical scheme-qualified origins. Invalid
// entries are omitted, which can only narrow access and keeps raw configuration
// bytes out of the CSP header.
func configuredOrigins(value string) []string {
	var out []string
	seen := map[string]bool{}
	for _, raw := range strings.Split(value, ",") {
		pattern, ok := parseOrigin(strings.TrimSpace(raw), true)
		if ok && !seen[pattern.source] {
			seen[pattern.source] = true
			out = append(out, pattern.source)
		}
	}
	return out
}

// originAllowed matches a request Origin against exact entries by default. An
// explicit scheme-qualified `*.` entry admits subdomains only; scheme and port
// always remain exact, and the bare suffix never matches the wildcard.
func originAllowed(origin string, allowed []string) bool {
	request, ok := parseOrigin(origin, false)
	if !ok {
		return false
	}
	for _, raw := range allowed {
		pattern, valid := parseOrigin(raw, true)
		if !valid || request.scheme != pattern.scheme || request.port != pattern.port {
			continue
		}
		if (!pattern.wildcard && request.hostname == pattern.hostname) ||
			(pattern.wildcard && strings.HasSuffix(request.hostname, pattern.hostname[1:])) {
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

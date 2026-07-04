package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/coder/websocket"
	"github.com/golang-jwt/jwt/v5"
)

func TestExtractToken(t *testing.T) {
	cases := []struct{ name, header, want string }{
		{"token after protocol", "envhaven.console, eyJa.bC.dE", "eyJa.bC.dE"},
		{"only protocol", "envhaven.console", ""},
		{"empty header", "", ""},
		{"token only", "eyJa.bC.dE", "eyJa.bC.dE"},
		{"whitespace trimmed", "  envhaven.console ,  tok  ", "tok"},
		{"protocol second", "tok, envhaven.console", "tok"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := extractToken(c.header); got != c.want {
				t.Fatalf("extractToken(%q) = %q, want %q", c.header, got, c.want)
			}
		})
	}
}

func TestOriginHosts(t *testing.T) {
	cases := []struct {
		name, in string
		want     []string
	}{
		{"url with scheme", "https://envhaven.com", []string{"envhaven.com"}},
		{"bare host", "envhaven.com", []string{"envhaven.com"}},
		{"multiple", "https://envhaven.com, https://app.envhaven.com", []string{"envhaven.com", "app.envhaven.com"}},
		{"empty entries skipped", "https://envhaven.com,, ", []string{"envhaven.com"}},
		{"wildcard passthrough", "*.envhaven.com", []string{"*.envhaven.com"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := originHosts(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("originHosts(%q) = %v, want %v", c.in, got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("originHosts(%q) = %v, want %v", c.in, got, c.want)
				}
			}
		})
	}
}

func TestInitialWinsize(t *testing.T) {
	cases := []struct {
		name, query string
		cols, rows  uint16
	}{
		{"valid", "cols=120&rows=40", 120, 40},
		{"absent", "", 80, 24},
		{"junk", "cols=abc&rows=40", 80, 24},
		{"too small", "cols=1&rows=40", 80, 24},
		{"too big", "cols=120&rows=9999", 80, 24},
		{"negative", "cols=-5&rows=40", 80, 24},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/__console?"+c.query, nil)
			got := initialWinsize(r)
			if got.Cols != c.cols || got.Rows != c.rows {
				t.Fatalf("initialWinsize(%q) = %dx%d, want %dx%d", c.query, got.Cols, got.Rows, c.cols, c.rows)
			}
		})
	}
}

func TestIsCleanEnd(t *testing.T) {
	clean := []error{nil, io.EOF, context.Canceled, context.DeadlineExceeded,
		websocket.CloseError{Code: websocket.StatusNormalClosure},
		websocket.CloseError{Code: websocket.StatusGoingAway}}
	for _, err := range clean {
		if !isCleanEnd(err) {
			t.Fatalf("isCleanEnd(%v) = false, want true", err)
		}
	}
	dirty := []error{errors.New("boom"),
		websocket.CloseError{Code: websocket.StatusPolicyViolation}}
	for _, err := range dirty {
		if isCleanEnd(err) {
			t.Fatalf("isCleanEnd(%v) = true, want false", err)
		}
	}
}

// validClaims returns the canonical fully valid console claims for wid — the
// single source for what "a valid token" means across the auth tests.
func validClaims(wid string) *claims {
	return &claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "envhaven",
			Audience:  jwt.ClaimStrings{"console"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
		Wid: wid,
	}
}

// newJWTFixture spins a throwaway Ed25519 key + JWKS server and returns the
// keyfunc bound to it, the public key (for algorithm-confusion attack tokens),
// and a kid-tagged EdDSA signer.
func newJWTFixture(t *testing.T) (keyfunc.Keyfunc, ed25519.PublicKey, func(c *claims) string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ts := jwksServer(t, pub)
	t.Cleanup(ts.Close)
	jwks, err := keyfunc.NewDefaultCtx(context.Background(), []string{ts.URL})
	if err != nil {
		t.Fatalf("build keyfunc: %v", err)
	}
	sign := func(c *claims) string {
		tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, c)
		tok.Header["kid"] = "test"
		s, err := tok.SignedString(priv)
		if err != nil {
			t.Fatalf("sign EdDSA: %v", err)
		}
		return s
	}
	return jwks, pub, sign
}

// jwksServer serves a JWKS containing one Ed25519 public key under kid "test".
func jwksServer(t *testing.T, pub ed25519.PublicKey) *httptest.Server {
	t.Helper()
	body, err := json.Marshal(map[string]any{"keys": []any{map[string]any{
		"kty": "OKP",
		"crv": "Ed25519",
		"x":   base64.RawURLEncoding.EncodeToString(pub),
		"alg": "EdDSA",
		"use": "sig",
		"kid": "test",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
}

// TestHandleConsoleAuth locks the authentication boundary: every rejection path
// must return its exact status BEFORE the WebSocket upgrade, and a fully valid
// token must pass auth. The required-expiry, issuer, audience, and
// workspace-binding options are mutation-detected: removing any of them turns
// a case red. The alg-none and HS256-confusion cases pin that the layered
// stack (keyfunc key typing plus JWK alg matching) rejects the classic
// attacks; the WithValidMethods allowlist is defense in depth on top of that,
// and its removal is not, by itself, observable through these statuses.
func TestHandleConsoleAuth(t *testing.T) {
	jwks, pub, signEdDSA := newJWTFixture(t)

	ctx := context.Background()
	const wsID = "ws_test"
	origins := []string{"envhaven.com"}

	base := func() *claims { return validClaims(wsID) }
	algNone := func() string {
		tok := jwt.NewWithClaims(jwt.SigningMethodNone, base())
		s, _ := tok.SignedString(jwt.UnsafeAllowNoneSignatureType)
		return s
	}
	algHS256 := func() string {
		// Attacker tries to sign with HS256 using the (public) Ed25519 key bytes
		// as the HMAC secret — the classic algorithm-confusion attack.
		tok := jwt.NewWithClaims(jwt.SigningMethodHS256, base())
		s, _ := tok.SignedString([]byte(pub))
		return s
	}
	with := func(mut func(*claims)) string { c := base(); mut(c); return signEdDSA(c) }
	wrongKey := func() string {
		// Fully valid claims, correct alg, the JWKS kid — signed by a key the
		// platform never published. The plainest forgery must still be a 401.
		_, badPriv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, base())
		tok.Header["kid"] = "test"
		s, err := tok.SignedString(badPriv)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}

	cases := []struct {
		name  string
		proto string // Sec-WebSocket-Protocol value; "" means header absent
		want  int
	}{
		{"missing token", "envhaven.console", http.StatusUnauthorized},
		{"no header", "", http.StatusUnauthorized},
		{"malformed token", "envhaven.console, not.a.jwt", http.StatusUnauthorized},
		{"alg none", "envhaven.console, " + algNone(), http.StatusUnauthorized},
		{"alg confusion HS256", "envhaven.console, " + algHS256(), http.StatusUnauthorized},
		{"wrong signing key", "envhaven.console, " + wrongKey(), http.StatusUnauthorized},
		{"expired", "envhaven.console, " + with(func(c *claims) { c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Hour)) }), http.StatusUnauthorized},
		{"no expiry", "envhaven.console, " + with(func(c *claims) { c.ExpiresAt = nil }), http.StatusUnauthorized},
		{"wrong issuer", "envhaven.console, " + with(func(c *claims) { c.Issuer = "evil" }), http.StatusUnauthorized},
		{"wrong audience", "envhaven.console, " + with(func(c *claims) { c.Audience = jwt.ClaimStrings{"web"} }), http.StatusUnauthorized},
		{"wrong workspace", "envhaven.console, " + with(func(c *claims) { c.Wid = "ws_other" }), http.StatusForbidden},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/__console", nil)
			if c.proto != "" {
				r.Header.Set("Sec-WebSocket-Protocol", c.proto)
			}
			w := httptest.NewRecorder()
			serveConsole(ctx, w, r, &jwtAuth{jwks: jwks, workspaceID: wsID}, origins)
			if w.Code != c.want {
				t.Fatalf("status = %d, want %d (body %q)", w.Code, c.want, w.Body.String())
			}
		})
	}

	// A valid token must PASS auth. It then attempts a WebSocket upgrade on a
	// plain (non-WS) request, which fails for a different reason — but it must
	// never be rejected with our auth statuses.
	t.Run("valid token passes auth", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/__console", nil)
		r.Header.Set("Sec-WebSocket-Protocol", "envhaven.console, "+signEdDSA(base()))
		w := httptest.NewRecorder()
		serveConsole(ctx, w, r, &jwtAuth{jwks: jwks, workspaceID: wsID}, origins)
		if w.Code == http.StatusUnauthorized || w.Code == http.StatusForbidden {
			t.Fatalf("valid token rejected at auth: status %d (body %q)", w.Code, w.Body.String())
		}
	})
}

// TestPredictAllowed pins the two-part predicate deciding whether a session may
// run the predictive-echo gate: the browser must opt in with ?echo=1, and
// ENVHAVEN_SKIP_WELCOME=1 vetoes it outright (without the tmux auto-attach the
// gate could vouch for a pane the console does not render — fail closed).
func TestPredictAllowed(t *testing.T) {
	cases := []struct {
		name, query, skip string
		want              bool
	}{
		{"opted in", "echo=1", "", true},
		{"no param", "", "", false},
		{"echo=0", "echo=0", "", false},
		{"opted in but skip-welcome", "echo=1", "1", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("ENVHAVEN_SKIP_WELCOME", c.skip)
			r := httptest.NewRequest(http.MethodGet, "/__console?"+c.query, nil)
			if got := predictAllowed(r); got != c.want {
				t.Fatalf("predictAllowed(%q, skip=%q) = %v, want %v", c.query, c.skip, got, c.want)
			}
		})
	}
}

// wsUpgradeRequest builds a real WebSocket upgrade request, so websocket.Accept
// gets past header verification to the Origin check.
func wsUpgradeRequest(proto, origin string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/__console", nil)
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Sec-WebSocket-Version", "13")
	r.Header.Set("Sec-WebSocket-Key", base64.StdEncoding.EncodeToString([]byte("0123456789abcdef")))
	r.Header.Set("Sec-WebSocket-Protocol", proto)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return r
}

// TestOriginEnforcement pins the cross-site backstop in serveConsole's Accept
// plumbing: with patterns ["envhaven.com"], a disallowed browser Origin is
// rejected 403 BEFORE the upgrade even with a valid bearer, and dropping
// OriginPatterns or adding InsecureSkipVerify turns a case red. The exact
// allowed host and a non-browser request (no Origin) proceed past the Origin
// check to the hijack, which fails on a recorder with a non-auth status. Both
// modes ride the same path; TestManagedOriginDefault pins the production
// allowlist itself.
func TestOriginEnforcement(t *testing.T) {
	jwks, _, signEdDSA := newJWTFixture(t)

	sh := newTestSelfHost(t)
	sh.origins = []string{"envhaven.com"}

	auths := []struct {
		name    string
		auth    authenticator
		bearer  string
		origins []string
	}{
		{"managed", &jwtAuth{jwks: jwks, workspaceID: "ws_test"}, signEdDSA(validClaims("ws_test")), []string{"envhaven.com"}},
		{"self-host", sh.wsAuth(), mintToken(sh.secret, ctxWS, time.Now(), wsTokenTTL), sh.origins},
	}
	cases := []struct {
		name          string
		origin        string
		wantForbidden bool
	}{
		{"workspace subdomain", "https://ws-abc.envhaven.com", true}, // the never-widen invariant
		{"third party", "https://evil.example", true},
		{"exact allowed host", "https://envhaven.com", false},
		{"no origin (non-browser)", "", false},
	}
	for _, a := range auths {
		for _, c := range cases {
			t.Run(a.name+"/"+c.name, func(t *testing.T) {
				w := httptest.NewRecorder()
				serveConsole(context.Background(), w, wsUpgradeRequest(subprotocol+", "+a.bearer, c.origin), a.auth, a.origins)
				if c.wantForbidden {
					if w.Code != http.StatusForbidden {
						t.Fatalf("origin %q = %d, want 403 (body %q)", c.origin, w.Code, w.Body.String())
					}
					return
				}
				if w.Code == http.StatusForbidden || w.Code == http.StatusUnauthorized {
					t.Fatalf("allowed origin %q rejected: %d (body %q)", c.origin, w.Code, w.Body.String())
				}
			})
		}
	}
}

// TestManagedOriginDefault pins the production Origin allowlist at its source.
// The SECURITY comment in newManagedAuth forbids widening it into the
// user-subdomain namespace; this goes red if the default gains a wildcard or
// extra hosts. _ENVHAVEN_CONSOLE_ORIGINS overrides it for dev, parsed through
// originHosts.
func TestManagedOriginDefault(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ts := jwksServer(t, pub)
	defer ts.Close()
	t.Setenv("_ENVHAVEN_WORKSPACE_ID", "ws_test")
	t.Setenv("_ENVHAVEN_API_URL", ts.URL)

	_, origins := newManagedAuth(context.Background())
	if len(origins) != 1 || origins[0] != "envhaven.com" {
		t.Fatalf("default origin patterns = %v, want exactly [envhaven.com]", origins)
	}

	t.Setenv("_ENVHAVEN_CONSOLE_ORIGINS", "https://dev.envhaven.com, http://localhost:3000")
	_, origins = newManagedAuth(context.Background())
	if len(origins) != 2 || origins[0] != "dev.envhaven.com" || origins[1] != "localhost:3000" {
		t.Fatalf("override origin patterns = %v, want [dev.envhaven.com localhost:3000]", origins)
	}
}

// TestNewHandlerModes pins the ENVHAVEN_MANAGED mode switch — the one check
// that decides which authenticator guards the shell. Managed must bind
// loopback and register ONLY the WebSocket route (no login surface); without
// the marker, password auth serves the full self-host surface. This matters
// because managed containers also carry HASHED_PASSWORD for code-server: a
// regressed marker check would silently fall through to password mode on all
// interfaces, and nothing else would go red.
func TestNewHandlerModes(t *testing.T) {
	t.Run("managed", func(t *testing.T) {
		pub, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		ts := jwksServer(t, pub)
		defer ts.Close()
		t.Setenv("ENVHAVEN_MANAGED", "true")
		t.Setenv("_ENVHAVEN_WORKSPACE_ID", "ws_test")
		t.Setenv("_ENVHAVEN_API_URL", ts.URL)

		addr, mux := newHandler(context.Background())
		if addr != managedAddr {
			t.Fatalf("managed addr = %q, want %q", addr, managedAddr)
		}
		// The WebSocket route exists and is guarded; the self-host surface does not.
		checks := []struct {
			method, path string
			want         int
		}{
			{http.MethodGet, "/__console", http.StatusUnauthorized},
			{http.MethodPost, "/__console/login", http.StatusNotFound},
			{http.MethodGet, "/__console/token", http.StatusNotFound},
			{http.MethodGet, "/__console/ui", http.StatusNotFound},
			{http.MethodGet, "/", http.StatusNotFound},
		}
		for _, c := range checks {
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest(c.method, c.path, nil))
			if w.Code != c.want {
				t.Fatalf("%s %s = %d, want %d", c.method, c.path, w.Code, c.want)
			}
		}
	})

	t.Run("self-host", func(t *testing.T) {
		t.Setenv("ENVHAVEN_MANAGED", "")
		t.Setenv("HASHED_PASSWORD", "")
		t.Setenv("PASSWORD", "hunter2")

		addr, mux := newHandler(context.Background())
		if addr != selfHostAddr {
			t.Fatalf("self-host addr = %q, want %q", addr, selfHostAddr)
		}
		checks := []struct {
			method, path string
			want         int
		}{
			{http.MethodGet, "/", http.StatusFound},
			{http.MethodGet, "/__console/login", http.StatusMethodNotAllowed}, // POST-only
			{http.MethodGet, "/__console/token", http.StatusUnauthorized},     // no cookie
			{http.MethodGet, "/__console/ui", http.StatusOK},
			{http.MethodGet, "/__console/assets/xterm.js", http.StatusOK},
			{http.MethodGet, "/__console", http.StatusUnauthorized}, // no bearer
		}
		for _, c := range checks {
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest(c.method, c.path, nil))
			if w.Code != c.want {
				t.Fatalf("%s %s = %d, want %d", c.method, c.path, w.Code, c.want)
			}
		}
	})
}

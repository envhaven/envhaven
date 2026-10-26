package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/coder/websocket"
	"github.com/golang-jwt/jwt/v5"
)

type allowTestAuth struct{}

func (allowTestAuth) authorize(*http.Request) error { return nil }

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

func TestConfiguredOrigins(t *testing.T) {
	cases := []struct {
		name, in string
		want     []string
	}{
		{"exact origin", "https://envhaven.com", []string{"https://envhaven.com"}},
		{"bare host rejected", "envhaven.com", nil},
		{"multiple", "https://envhaven.com, http://localhost:3000", []string{"https://envhaven.com", "http://localhost:3000"}},
		{"empty and invalid entries skipped", "https://envhaven.com,, javascript:alert(1)", []string{"https://envhaven.com"}},
		{"scheme-qualified wildcard", "https://*.envhaven.dev", []string{"https://*.envhaven.dev"}},
		{"wildcard with explicit port", "https://*.envhaven.dev:8443", []string{"https://*.envhaven.dev:8443"}},
		{"wildcard must be leftmost", "https://app.*.envhaven.dev", nil},
		{"unsupported scheme", "ftp://envhaven.com", nil},
		{"userinfo rejected", "https://user@envhaven.com", nil},
		{"path rejected", "https://envhaven.com/console", nil},
		{"canonical and deduplicated", "HTTPS://APP.EnvHaven.Dev,https://app.envhaven.dev", []string{"https://app.envhaven.dev"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := configuredOrigins(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("configuredOrigins(%q) = %v, want %v", c.in, got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("configuredOrigins(%q) = %v, want %v", c.in, got, c.want)
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
	origins := []string{"https://envhaven.com"}

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
			serveConsole(ctx, w, r, &jwtAuth{jwks: jwks, workspaceID: wsID}, origins, true)
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
		serveConsole(ctx, w, r, &jwtAuth{jwks: jwks, workspaceID: wsID}, origins, true)
		if w.Code == http.StatusUnauthorized || w.Code == http.StatusForbidden {
			t.Fatalf("valid token rejected at auth: status %d (body %q)", w.Code, w.Body.String())
		}
	})
}

// TestPredictProtocolFor pins the only shipped protocols, clear rejection, and the safety veto.
func TestPredictProtocolFor(t *testing.T) {
	cases := []struct {
		name, query, skip, wantErr string
		want                       predictProtocol
	}{
		{"old tab negotiates implicit v1", "echo=1", "", "", predictV1},
		{"explicit v1 remains compatible", "echo=1&echoProtocol=1", "", "", predictV1},
		{"current page negotiates v4", "echo=1&echoProtocol=4", "", "", predictV4},
		{"protocol 2 is rejected", "echo=1&echoProtocol=2", "", `unsupported predictive protocol "2"; supported versions are 1 and 4`, predictOff},
		{"protocol 3 is rejected", "echo=1&echoProtocol=3", "", `unsupported predictive protocol "3"; supported versions are 1 and 4`, predictOff},
		{"future protocol is rejected", "echo=1&echoProtocol=5", "", `unsupported predictive protocol "5"; supported versions are 1 and 4`, predictOff},
		{"malformed protocol is rejected", "echo=1&echoProtocol=wat", "", `unsupported predictive protocol "wat"; supported versions are 1 and 4`, predictOff},
		{"empty protocol is rejected", "echo=1&echoProtocol=", "", `unsupported predictive protocol ""; supported versions are 1 and 4`, predictOff},
		{"duplicate protocol is rejected", "echo=1&echoProtocol=1&echoProtocol=4", "", `predictive protocol must be specified once; supported versions are 1 and 4`, predictOff},
		{"protocol without feature flag", "echoProtocol=2", "", "", predictOff},
		{"old provisional feature value", "echo=2", "", "", predictOff},
		{"no param", "", "", "", predictOff},
		{"echo=0", "echo=0", "", "", predictOff},
		// Skip-welcome leaves the negotiation alone and vetoes the gate in the pump: a
		// socket negotiated off would get no gate frame, and the browser admits input on
		// an echo socket only after one, so every keystroke would be refused.
		{"v1 still negotiated under skip-welcome", "echo=1", "1", "", predictV1},
		{"unsupported version rejected under skip-welcome", "echo=1&echoProtocol=2", "1", `unsupported predictive protocol "2"; supported versions are 1 and 4`, predictOff},
		{"v4 still negotiated under skip-welcome", "echo=1&echoProtocol=4", "1", "", predictV4},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("ENVHAVEN_SKIP_WELCOME", c.skip)
			r := httptest.NewRequest(http.MethodGet, "/__console?"+c.query, nil)
			got, err := predictProtocolFor(r)
			if got != c.want || (err == nil && c.wantErr != "") || (err != nil && err.Error() != c.wantErr) {
				t.Fatalf("predictProtocolFor(%q, skip=%q) = (%v, %v), want (%v, %q)", c.query, c.skip, got, err, c.want, c.wantErr)
			}
		})
	}
}

func TestServeConsoleRejectsUnsupportedPredictProtocol(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/__console?echo=1&echoProtocol=2", nil)
	w := httptest.NewRecorder()
	serveConsole(context.Background(), w, r, allowTestAuth{}, nil, false)
	want := "unsupported predictive protocol \"2\"; supported versions are 1 and 4\n"
	if w.Code != http.StatusBadRequest || w.Body.String() != want {
		t.Fatalf("unsupported protocol response = (%d, %q), want (400, %q)", w.Code, w.Body.String(), want)
	}
}

func TestProbeSessionFor(t *testing.T) {
	valid := "ehtest-ab-mmmmmmmm-0123456789ab"
	cases := []struct {
		name, query string
		managed, ok bool
		want        string
	}{
		{"absent", "echo=1", true, true, ""},
		{"managed v4 probe", "echo=1&echoProtocol=4&probe=1&probeSession=" + valid, true, true, valid},
		{"self-host rejected", "echo=1&echoProtocol=4&probe=1&probeSession=" + valid, false, false, ""},
		{"probe flag required", "echo=1&echoProtocol=4&probeSession=" + valid, true, false, ""},
		{"predictive flag required", "echoProtocol=4&probe=1&probeSession=" + valid, true, false, ""},
		{"v4 required", "echo=1&echoProtocol=1&probe=1&probeSession=" + valid, true, false, ""},
		{"empty rejected", "echo=1&echoProtocol=4&probe=1&probeSession=", true, false, ""},
		{"duplicate rejected", "echo=1&echoProtocol=4&probe=1&probeSession=" + valid + "&probeSession=" + valid, true, false, ""},
		{"base session rejected", "echo=1&echoProtocol=4&probe=1&probeSession=envhaven", true, false, ""},
		{"punctuation rejected", "echo=1&echoProtocol=4&probe=1&probeSession=ehtest-ab-mmmmmmmm-0123456789ab%3A1", true, false, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/__console?"+c.query, nil)
			got, err := probeSessionFor(r, c.managed)
			if (err == nil) != c.ok || got != c.want {
				t.Fatalf("probeSessionFor(%q, managed=%v) = (%q, %v), want (%q, ok=%v)", c.query, c.managed, got, err, c.want, c.ok)
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

// TestOriginEnforcement pins the full-origin check before websocket.Accept. Exact
// entries do not widen to subdomains; explicit wildcards retain their scheme and
// port; and non-browser requests still proceed to the upgrade.
func TestOriginEnforcement(t *testing.T) {
	jwks, _, signEdDSA := newJWTFixture(t)

	sh := newTestSelfHost(t)
	sh.origins = []string{"https://envhaven.com", "https://*.envhaven.dev"}

	auths := []struct {
		name    string
		auth    authenticator
		bearer  string
		origins []string
		managed bool
	}{
		{"managed", &jwtAuth{jwks: jwks, workspaceID: "ws_test"}, signEdDSA(validClaims("ws_test")), sh.origins, true},
		{"self-host", sh.wsAuth(), mintToken(sh.secret, ctxWS, time.Now(), wsTokenTTL), sh.origins, false},
	}
	cases := []struct {
		name          string
		origin        string
		wantForbidden bool
	}{
		{"workspace subdomain", "https://ws-abc.envhaven.com", true}, // the never-widen invariant
		{"third party", "https://evil.example", true},
		{"wrong scheme", "http://envhaven.com", true},
		{"wildcard apex", "https://envhaven.dev", true},
		{"wildcard wrong scheme", "http://app-a.envhaven.dev", true},
		{"exact allowed origin", "https://envhaven.com", false},
		{"wildcard child", "https://app-a.envhaven.dev", false},
		{"wildcard nested child", "https://preview.app-a.envhaven.dev", false},
		{"no origin (non-browser)", "", false},
	}
	for _, a := range auths {
		for _, c := range cases {
			t.Run(a.name+"/"+c.name, func(t *testing.T) {
				w := httptest.NewRecorder()
				serveConsole(context.Background(), w, wsUpgradeRequest(subprotocol+", "+a.bearer, c.origin), a.auth, a.origins, a.managed)
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
// extra hosts. _ENVHAVEN_CONSOLE_ORIGINS overrides it for development through
// the same parser used by CORS, WebSockets, and frame-ancestors.
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
	if !slices.Equal(origins, []string{"https://envhaven.com"}) {
		t.Fatalf("default origins = %v, want exactly [https://envhaven.com]", origins)
	}

	t.Setenv("_ENVHAVEN_CONSOLE_ORIGINS", "https://dev.envhaven.com, http://localhost:3000")
	_, origins = newManagedAuth(context.Background())
	if !slices.Equal(origins, []string{"https://dev.envhaven.com", "http://localhost:3000"}) {
		t.Fatalf("override origins = %v, want full origins", origins)
	}
}

// TestNewHandlerModes pins the ENVHAVEN_MANAGED mode switch — the one check
// that decides which authenticator guards the shell. Managed binds loopback and
// serves the WebSocket plus the static terminal page + assets (the dashboard
// embeds that one page), but NO password/login surface; without the marker,
// password auth serves the full self-host surface. This matters because managed
// containers also carry HASHED_PASSWORD for code-server: a regressed marker check
// would silently fall through to password mode on all interfaces, and nothing
// else would go red. Both modes must also mount the Cockpit API: /__console/stats
// answering 401 (guarded), never 404 (unmounted), pins the registerAPI call in
// each newHandler branch.
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

		// A managed container carries HASHED_PASSWORD for code-server; the marker still wins.
		addr, mux := newHandler(context.Background(), webPassword{hashed: fixtureSHA256})
		if addr != managedAddr {
			t.Fatalf("managed addr = %q, want %q", addr, managedAddr)
		}
		// The WebSocket route exists and is guarded; the self-host surface does not.
		checks := []struct {
			method, path string
			want         int
		}{
			{http.MethodGet, "/__console", http.StatusUnauthorized},
			{http.MethodGet, "/__console/stats", http.StatusUnauthorized}, // Cockpit API mounted, guarded
			{http.MethodPost, "/__console/login", http.StatusNotFound},    // no password surface in managed
			{http.MethodGet, "/__console/token", http.StatusNotFound},     // tokens are platform-minted
			{http.MethodGet, "/__console/ui", http.StatusOK},              // the ONE client, embedded by the dashboard
			{http.MethodGet, "/__console/assets/xterm.js", http.StatusOK}, // served alongside the page
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
		t.Setenv("HOME", t.TempDir()) // the token salt is written under HOME

		addr, mux := newHandler(context.Background(), webPassword{plain: "hunter2"})
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
			{http.MethodGet, "/__console", http.StatusUnauthorized},       // no bearer
			{http.MethodGet, "/__console/stats", http.StatusUnauthorized}, // Cockpit API mounted, guarded
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

// TestFrameAncestors pins the origin list derived from the console-origins env:
// the scheme-qualified origins allowed to embed the managed terminal (and, as
// the same list, to pass the API CORS check), defaulting to the production
// dashboard.
func TestFrameAncestors(t *testing.T) {
	if got := frameAncestors(""); !slices.Equal(got, []string{"https://envhaven.com"}) {
		t.Fatalf("empty = %v, want default [https://envhaven.com]", got)
	}
	if got := frameAncestors("https://app-x.envhaven.dev, https://envhaven.com"); !slices.Equal(got, []string{"https://app-x.envhaven.dev", "https://envhaven.com"}) {
		t.Fatalf("list = %v, want both origins in order", got)
	}
	if got := frameAncestors("https://*.envhaven.dev"); !slices.Equal(got, []string{"https://*.envhaven.dev"}) {
		t.Fatalf("wildcard list = %v, want the scheme-qualified wildcard", got)
	}
	if got := frameAncestors("not-an-origin"); !slices.Equal(got, []string{"https://envhaven.com"}) {
		t.Fatalf("invalid list = %v, want fail-closed production default", got)
	}
}

// TestServeUIFraming pins the anti-clickjacking header split that lets the dashboard
// embed the managed terminal while denying every other framer, and forbids framing
// the self-host page outright. The page is the SAME bytes in both modes; only the
// framing headers differ, and they are the whole gate.
func TestServeUIFraming(t *testing.T) {
	// Self-host (no frameAncestors): opened top-level, so deny all framing, in CSP and
	// in X-Frame-Options for browsers that predate frame-ancestors.
	w := httptest.NewRecorder()
	serveUI(w, nil)
	if got := w.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("self-host X-Frame-Options = %q, want DENY", got)
	}
	if got, want := w.Header().Get("Content-Security-Policy"), pagePolicy+"; frame-ancestors 'none'"; got != want {
		t.Fatalf("self-host CSP = %q, want %q", got, want)
	}
	// Managed: only the given dashboard origins may frame; no XFO (CSP supersedes it,
	// and XFO cannot express an allowed origin).
	w = httptest.NewRecorder()
	serveUI(w, []string{"https://envhaven.com", "https://*.envhaven.dev"})
	if got, want := w.Header().Get("Content-Security-Policy"), pagePolicy+"; frame-ancestors https://envhaven.com https://*.envhaven.dev"; got != want {
		t.Fatalf("managed CSP = %q, want %q", got, want)
	}
	if got := w.Header().Get("X-Frame-Options"); got != "" {
		t.Fatalf("managed must set no X-Frame-Options, got %q", got)
	}
	if got := w.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}
}

// TestServeUIPolicy pins the page's script and connection policy: the console page is
// a remote shell, so the policy is what keeps an injection on its origin from running.
// Each directive below is load-bearing; the live check that the page still works under
// it is the headless-browser run (no CSP violation, socket attached).
func TestServeUIPolicy(t *testing.T) {
	for _, frameAncestors := range [][]string{nil, {"https://envhaven.com"}} {
		w := httptest.NewRecorder()
		serveUI(w, frameAncestors)
		directives := map[string]string{}
		for _, d := range strings.Split(w.Header().Get("Content-Security-Policy"), ";") {
			name, value, _ := strings.Cut(strings.TrimSpace(d), " ")
			if _, dup := directives[name]; dup {
				t.Fatalf("directive %s appears twice", name)
			}
			directives[name] = value
		}
		for name, want := range map[string]string{
			"default-src": "'self'",
			"script-src":  "'self'",
			"connect-src": "'self'",
			"object-src":  "'none'",
			"base-uri":    "'none'",
			"form-action": "'self'",
		} {
			if got := directives[name]; got != want {
				t.Errorf("%s = %q, want %q", name, got, want)
			}
		}
		// xterm needs inline styles; nothing may ever loosen scripts the same way.
		for name, value := range directives {
			if strings.Contains(value, "unsafe-eval") || (strings.Contains(value, "unsafe-inline") && name != "style-src") {
				t.Errorf("%s = %q relaxes script execution", name, value)
			}
		}
		if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
		}
		if got := w.Header().Get("Referrer-Policy"); got != "no-referrer" {
			t.Errorf("Referrer-Policy = %q, want no-referrer", got)
		}
	}
	// The policy forbids inline script, so the page must carry none.
	for _, m := range regexp.MustCompile(`(?s)<script([^>]*)>(.*?)</script>`).FindAllSubmatch(terminalPage, -1) {
		if !regexp.MustCompile(`\bsrc\s*=`).Match(m[1]) || len(bytes.TrimSpace(m[2])) > 0 {
			t.Fatalf("terminal.html carries an inline script (%.80q), which script-src 'self' blocks", m[0])
		}
	}
	if regexp.MustCompile(`\son[a-z]+\s*=`).Match(terminalPage) {
		t.Fatal("terminal.html carries an inline event handler, which script-src 'self' blocks")
	}
}

// TestNewServerShape pins the listener settings: request shaping is on, and there is no
// server-wide Read or WriteTimeout. Bodies are bounded per request instead
// (limitBodyReads), so an authenticated upload can take longer than a login form, and
// a WriteTimeout would cut off responses that rightly take minutes (a skills install,
// a large artifact download).
func TestNewServerShape(t *testing.T) {
	srv := newServer(selfHostAddr, http.NotFoundHandler())
	if srv.ReadTimeout != 0 || srv.WriteTimeout != 0 {
		t.Fatalf("ReadTimeout %v, WriteTimeout %v: bodies are bounded per request, and a write timeout cuts off long responses", srv.ReadTimeout, srv.WriteTimeout)
	}
	if srv.ReadHeaderTimeout <= 0 || srv.IdleTimeout <= 0 || srv.MaxHeaderBytes <= 0 {
		t.Fatalf("request shaping missing: %+v", srv)
	}
	if srv.Addr != selfHostAddr {
		t.Fatalf("Addr = %q", srv.Addr)
	}
}

// dribble sends a request whose declared body arrives one byte per interval for as
// long as the connection stays open, the way a client trying to pin a handler would.
func dribble(t *testing.T, addr, path string, interval time.Duration) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	head := "POST " + path + " HTTP/1.1\r\nHost: console\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 4096\r\n\r\n"
	if _, err := io.WriteString(conn, head); err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			time.Sleep(interval)
			if _, err := conn.Write([]byte("a")); err != nil {
				return
			}
		}
	}()
	return conn
}

// TestLimitBodyReads pins the body deadline that keeps the published self-host port
// from being held open by slow clients: a dribbled body ends at the deadline whether
// the handler reads it or answers without reading it, and the deadline never reaches
// a handler that keeps working after its body arrived, nor a request with no body.
func TestLimitBodyReads(t *testing.T) {
	const timeout = 300 * time.Millisecond
	type outcome struct{ readErr, ctxErr error }
	results := make(chan outcome, 4)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /read", func(w http.ResponseWriter, r *http.Request) {
		_, err := io.ReadAll(r.Body)
		results <- outcome{readErr: err}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /ignore", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized) // any refusal sent before the body is read
	})
	mux.HandleFunc("POST /slow", func(w http.ResponseWriter, r *http.Request) {
		_, err := io.ReadAll(r.Body)
		time.Sleep(3 * timeout) // work long past the deadline, as a skills install does
		results <- outcome{readErr: err, ctxErr: r.Context().Err()}
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(limitBodyReads(mux, timeout))
	t.Cleanup(srv.Close)
	addr := strings.TrimPrefix(srv.URL, "http://")

	t.Run("a dribbled body is cut off", func(t *testing.T) {
		start := time.Now()
		dribble(t, addr, "/read", 50*time.Millisecond)
		select {
		case got := <-results:
			if got.readErr == nil {
				t.Fatal("a dribbled body was read to the end; want the deadline to end it")
			}
			if elapsed := time.Since(start); elapsed > 10*timeout {
				t.Fatalf("the read ended after %v, want about %v", elapsed, timeout)
			}
		case <-time.After(20 * timeout):
			t.Fatal("reading a dribbled body never ended")
		}
	})

	t.Run("an unread body does not hold the connection", func(t *testing.T) {
		// Without a deadline, net/http's drain of the unread body would wait on the
		// client before sending the 401, for the 200 seconds this body takes to arrive.
		conn := dribble(t, addr, "/ignore", 50*time.Millisecond)
		_ = conn.SetReadDeadline(time.Now().Add(20 * timeout))
		br := bufio.NewReader(conn)
		resp, err := http.ReadResponse(br, nil)
		if err != nil {
			t.Fatalf("no response while the body dribbled: %v", err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("status %d, want 401", resp.StatusCode)
		}
		// Then the server closes the connection instead of reading on: EOF, or a reset
		// when its close finds more dribbled bytes unread. Only a timeout means it stayed.
		var netErr net.Error
		if _, err := br.ReadByte(); err == nil || (errors.As(err, &netErr) && netErr.Timeout()) {
			t.Fatalf("connection after the response: %v, want it closed", err)
		}
	})

	t.Run("a handler working past the deadline keeps its context", func(t *testing.T) {
		for _, body := range []string{"password=x", ""} {
			resp, err := srv.Client().Post(srv.URL+"/slow", "application/x-www-form-urlencoded", strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if got := <-results; got.readErr != nil || got.ctxErr != nil {
				t.Fatalf("body %q: read error %v, context error %v; want neither", body, got.readErr, got.ctxErr)
			}
		}
	})
}

// TestSessionLimit pins the session cap's eviction order: a new session always gets
// in, the oldest makes room, and a session that ended frees its place without
// disturbing the others.
func TestSessionLimit(t *testing.T) {
	l := &sessionLimit{max: 2}
	a, releaseA := l.admit(context.Background())
	b, releaseB := l.admit(context.Background())
	if a.Err() != nil || b.Err() != nil {
		t.Fatal("sessions within the limit were cancelled")
	}

	c, releaseC := l.admit(context.Background())
	if a.Err() == nil {
		t.Fatal("a third session at a limit of two left the oldest running")
	}
	if b.Err() != nil || c.Err() != nil {
		t.Fatal("eviction cancelled a session other than the oldest")
	}

	releaseB()
	if b.Err() == nil {
		t.Fatal("an ended session's context is still live")
	}
	d, releaseD := l.admit(context.Background())
	if c.Err() != nil || d.Err() != nil {
		t.Fatal("admitting into a freed place evicted a live session")
	}

	releaseA() // the evicted session ending late must not remove anyone else
	if len(l.live) != 2 {
		t.Fatalf("%d live sessions, want 2", len(l.live))
	}
	releaseC()
	releaseD()
	if len(l.live) != 0 {
		t.Fatalf("%d live sessions after every release, want 0", len(l.live))
	}
	if consoleSessions.max != maxSessions {
		t.Fatalf("the console's limit is %d, want maxSessions (%d)", consoleSessions.max, maxSessions)
	}
}

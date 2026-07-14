// Command envhaven-console is the per-container terminal server. It runs in
// every workspace and attaches a pty running the login shell (which auto-joins
// the shared tmux windows: the base `envhaven` session when managed, a grouped
// `console-view` session when self-hosted). The browser connects directly to the
// container; there is no central proxy. Two authentication modes, chosen once
// at startup: managed workspaces validate a short-lived platform-minted EdDSA
// JWT against the platform JWKS (this file), self-hosted containers validate
// the operator's own web password (selfhost.go).
//
// Every check in the managed path here is load-bearing: a missing signature,
// issuer, audience, expiry, or workspace binding check has no platform-side
// fallback. The session pump lives in pump.go; the predictive-echo safety
// gate in gate.go.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/coder/websocket"
	"github.com/creack/pty"
	"github.com/golang-jwt/jwt/v5"
)

// version is reported by --version so the Dockerfile verification block can
// assert the binary runs.
const version = "1.0.0"

const (
	managedAddr = "127.0.0.1:7681" // loopback; the Cloudflare tunnel routes /__console here
	subprotocol = "envhaven.console"
	tokenLeeway = 5 * time.Second
)

// claims is the JWT payload. Wid binds the token to a single workspace; the
// registered claims carry iss/aud/exp which the parser options enforce.
type claims struct {
	jwt.RegisteredClaims
	Wid string `json:"wid"`
}

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	// Shut down background goroutines (JWKS refresh, the HTTP server) on signal.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	addr, mux := newHandler(ctx)

	// Request-shaping for the directly-exposed self-host front door (and benign on
	// the managed loopback): ReadHeaderTimeout closes slowloris header-dribblers,
	// IdleTimeout reaps idle keep-alives, MaxHeaderBytes caps header size. We do
	// NOT set Read/WriteTimeout: those would sever the long-lived console
	// WebSocket, which manages its own deadlines after the upgrade.
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 16,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal("listen on " + addr + ": " + err.Error())
	}
}

// newHandler picks the mode ONCE, explicitly, on the marker the rest of the
// image uses (ENVHAVEN_MANAGED); the decision threads to serveConsole and
// pumpSession as `managed`, so no later code re-reads the marker. Managed
// validates a platform-minted EdDSA JWT against the platform JWKS; self-hosted
// validates the operator's own web password. Exactly one authenticator is ever
// built; if neither can be configured the process refuses to start
// (newManagedAuth / newSelfHost fatal). There is no unauthenticated path: auth
// and the pty share one port, so nothing on the network or in the container
// can reach a shell without a credential.
func newHandler(ctx context.Context) (string, *http.ServeMux) {
	mux := http.NewServeMux()
	if os.Getenv("ENVHAVEN_MANAGED") == "true" {
		auth, origins := newManagedAuth(ctx)
		// Serve the SAME terminal page self-host serves, so the managed dashboard
		// embeds the one client instead of reimplementing it. The dashboard injects
		// the platform JWT over postMessage (the page has ?parent set); there is no
		// login/token route here because managed tokens are platform-minted. The WS
		// Origin allowlist (origins) is untouched: the iframe is served from the
		// workspace's own tunnel host, so its socket is same-host and auto-authorized.
		fa := frameAncestors(os.Getenv("_ENVHAVEN_CONSOLE_ORIGINS"))
		mux.HandleFunc("GET /__console/ui", func(w http.ResponseWriter, _ *http.Request) { serveUI(w, fa) })
		mux.Handle("GET /__console/assets/", assetsHandler())
		// The Cockpit HUD's out-of-band HTTP API (stats, tools, skills, artifacts,
		// tmux actions). It rides the SAME EdDSA JWT wall as the socket; CORS echoes
		// only the dashboard origins (the scheme-qualified frameAncestors list), so a
		// cross-site page holding no token still cannot read a response.
		registerAPI(mux, auth.verify, fa)
		mux.HandleFunc("/__console", func(w http.ResponseWriter, r *http.Request) {
			serveConsole(r.Context(), w, r, auth, origins, true)
		})
		return managedAddr, mux
	}
	sh := newSelfHost()
	mux.HandleFunc("GET /{$}", sh.handleRoot)
	mux.HandleFunc("POST /__console/login", sh.handleLogin)
	mux.HandleFunc("GET /__console/token", sh.handleToken)
	mux.HandleFunc("GET /__console/ui", func(w http.ResponseWriter, _ *http.Request) { serveUI(w, nil) })
	mux.Handle("GET /__console/assets/", assetsHandler())
	// The SAME Cockpit HTTP API, guarded by the self-host 60s HMAC bearer. No CORS
	// allowlist (nil origins) → no Access-Control-Allow-Origin is ever emitted, so
	// the API is same-origin only, at parity with the socket.
	registerAPI(mux, func(token string) error {
		if !verifyToken(sh.secret, ctxWS, token, time.Now()) {
			return errUnauthorized
		}
		return nil
	}, nil)
	mux.HandleFunc("/__console", func(w http.ResponseWriter, r *http.Request) {
		serveConsole(r.Context(), w, r, sh.wsAuth(), sh.origins, false)
	})
	return selfHostAddr, mux
}

// authenticator authorizes a console WebSocket request before the upgrade.
// Managed and self-hosted differ ONLY in this check: both present a short-lived
// bearer in the subprotocol; managed verifies an EdDSA JWT, self-hosted an HMAC
// token. Everything past the check is identical.
type authenticator interface {
	authorize(r *http.Request) error
}

// authError carries the HTTP status to send when authorization fails.
type authError struct {
	status int
	msg    string
}

func (e *authError) Error() string { return e.msg }

// newManagedAuth builds the platform-JWT authenticator and its Origin allowlist,
// failing closed if the workspace id is missing or the JWKS is unreachable. It
// returns the concrete *jwtAuth because registerAPI wants its verify method;
// serveConsole consumes it through the authenticator interface.
func newManagedAuth(ctx context.Context) (*jwtAuth, []string) {
	workspaceID := os.Getenv("_ENVHAVEN_WORKSPACE_ID")
	if workspaceID == "" {
		fatal("_ENVHAVEN_WORKSPACE_ID is not set")
	}

	apiURL := os.Getenv("_ENVHAVEN_API_URL")
	if apiURL == "" {
		apiURL = "https://api.envhaven.com"
	}
	jwksURL := strings.TrimRight(apiURL, "/") + "/v1/console/jwks"

	// coder/websocket matches OriginPatterns against the Origin header HOST, so
	// patterns are bare hosts. Default to the production dashboard host; dev
	// injects _ENVHAVEN_CONSOLE_ORIGINS.
	//
	// SECURITY: keep these EXACT hosts. Workspaces get user-controlled
	// subdomains, so a wildcard like "*.envhaven.com" would let a workspace page
	// open a cross-site console socket. The JWT (carried in the subprotocol, not
	// a cookie) is still required, but this allowlist is the cross-site backstop;
	// never widen it to overlap the user-subdomain namespace.
	originPatterns := []string{"envhaven.com"}
	if v := os.Getenv("_ENVHAVEN_CONSOLE_ORIGINS"); v != "" {
		originPatterns = originHosts(v)
	}

	// Fail closed on the first JWKS fetch: if the platform's keys are
	// unreachable at boot we refuse every connection rather than accept
	// unverifiable tokens. keyfunc defaults to fail-open here, so we override
	// NoErrorReturnFirstHTTPReq to false.
	noFailOpen := false
	jwks, err := keyfunc.NewDefaultOverrideCtx(ctx, []string{jwksURL}, keyfunc.Override{
		NoErrorReturnFirstHTTPReq: &noFailOpen,
	})
	if err != nil {
		fatal("fetch JWKS from " + jwksURL + ": " + err.Error())
	}
	return &jwtAuth{jwks: jwks, workspaceID: workspaceID}, originPatterns
}

// jwtAuth authorizes managed connections by validating the platform's EdDSA JWT.
type jwtAuth struct {
	jwks        keyfunc.Keyfunc
	workspaceID string
}

func (a *jwtAuth) authorize(r *http.Request) error {
	token := extractToken(r.Header.Get("Sec-WebSocket-Protocol"))
	if token == "" {
		return &authError{http.StatusUnauthorized, "missing token"}
	}
	return a.verify(token)
}

// verify validates a presented platform JWT: EdDSA signature against the JWKS,
// issuer, audience, required expiry, and the workspace binding. It is shared by
// the WebSocket authorizer (authorize) and the Cockpit HTTP API guard (api.go),
// so the managed console has exactly ONE token-validation path. Every option
// here is load-bearing: there is no platform-side fallback.
func (a *jwtAuth) verify(token string) error {
	var c claims
	_, err := jwt.ParseWithClaims(token, &c, a.jwks.Keyfunc,
		jwt.WithValidMethods([]string{"EdDSA"}),
		jwt.WithIssuer("envhaven"),
		jwt.WithAudience("console"),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(tokenLeeway),
	)
	if err != nil {
		return &authError{http.StatusUnauthorized, "invalid token"}
	}
	if c.Wid != a.workspaceID {
		return &authError{http.StatusForbidden, "token not valid for this workspace"}
	}
	return nil
}

// serveConsole authorizes the request, upgrades to WebSocket, and pumps the pty.
// Authorization happens BEFORE Accept: a bad credential never reaches the
// upgrade, so unauthenticated callers get a plain HTTP rejection. managed is
// newHandler's once-read mode marker, passed through to pumpSession.
func serveConsole(ctx context.Context, w http.ResponseWriter, r *http.Request, auth authenticator, originPatterns []string, managed bool) {
	if err := auth.authorize(r); err != nil {
		var ae *authError
		if errors.As(err, &ae) {
			http.Error(w, ae.msg, ae.status)
		} else {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		}
		return
	}

	// Offer ONLY our protocol so the negotiated subprotocol never echoes the
	// bearer back to the client. Origin is enforced by OriginPatterns; we never
	// set InsecureSkipVerify.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:   []string{subprotocol},
		OriginPatterns: originPatterns,
	})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20) // 1 MiB: large pastes, well above the 32 KiB default

	if err := pumpSession(ctx, conn, initialWinsize(r), managed, predictAllowed(r)); err != nil {
		conn.Close(websocket.StatusInternalError, "session ended")
		return
	}
	conn.Close(websocket.StatusNormalClosure, "")
}

// predictAllowed reports whether this session may run the predictive-echo
// gate. It is a per-session opt-in the browser forwards on the socket URL
// (?echo=1, mirroring the page parameter); a default session (or the managed
// dashboard client, which never predicts) spawns no gate and sees no 0x02
// frames. ENVHAVEN_SKIP_WELCOME=1 disables it outright: the gate inspects the
// shared tmux session's active pane (gate.go), and skipping the auto-attach
// breaks the link between that pane and what the console actually renders, so
// the gate could vouch for the wrong terminal. Fail closed instead.
func predictAllowed(r *http.Request) bool {
	return r.URL.Query().Get("echo") == "1" && os.Getenv("ENVHAVEN_SKIP_WELCOME") != "1"
}

// initialWinsize reads the browser's ?cols=&rows= query so the pty is born at
// the terminal's real geometry and the tmux attach paints exactly once. The old
// fixed 80x24 start made every (re)connect snap the shared session to 80x24 and
// back — a visible double repaint here and a spurious resize for every other
// attached client. Absent or absurd values fall back to 80x24; the resize frame
// sent on socket open then corrects.
func initialWinsize(r *http.Request) *pty.Winsize {
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
	if cols < 2 || cols > 4096 || rows < 2 || rows > 4096 {
		return &pty.Winsize{Rows: 24, Cols: 80}
	}
	return &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}
}

// extractToken pulls the JWT from the WebSocket subprotocol header. The browser
// sends ['envhaven.console', token]; we take the entry that is not our protocol
// name. Returns "" when no token entry is present.
func extractToken(header string) string {
	for _, p := range strings.Split(header, ",") {
		p = strings.TrimSpace(p)
		if p != "" && p != subprotocol {
			return p
		}
	}
	return ""
}

// originHosts parses a comma-separated origin list into the bare host patterns
// coder/websocket matches the Origin header against. Both "https://envhaven.com"
// and "envhaven.com" yield "envhaven.com"; wildcard host patterns pass through.
func originHosts(v string) []string {
	var out []string
	for _, o := range strings.Split(v, ",") {
		o = strings.TrimSpace(o)
		if o == "" {
			continue
		}
		if u, err := url.Parse(o); err == nil && u.Host != "" {
			out = append(out, u.Host)
		} else {
			out = append(out, o)
		}
	}
	return out
}

// frameAncestors parses the console-origins env into the list of origins
// allowed to embed the managed terminal page. Unlike originHosts (which strips
// to bare hosts for the WebSocket Origin check), this keeps the scheme, because
// CSP host-sources are scheme-qualified. Empty falls back to the production
// dashboard. Same env var (_ENVHAVEN_CONSOLE_ORIGINS), two parsers. The one
// parse feeds both consumers: registerAPI takes the list as its CORS allowlist,
// serveUI joins it into the CSP `frame-ancestors` header value.
func frameAncestors(v string) []string {
	var out []string
	for _, o := range strings.Split(v, ",") {
		if o = strings.TrimSpace(o); o != "" {
			out = append(out, o)
		}
	}
	if len(out) == 0 {
		return []string{"https://envhaven.com"}
	}
	return out
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, "envhaven-console: "+msg)
	os.Exit(1)
}

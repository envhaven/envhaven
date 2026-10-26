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
	"os"
	"os/signal"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
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
	// Before any mode can start a child process, read the web password and remove it
	// from this process's environment (takeWebPassword). Only the self-hosted server
	// below uses it.
	password := takeWebPassword()

	showVersion := flag.Bool("version", false, "print version and exit")
	showReadyTools := flag.Bool("ready-tools", false, "print ready tool names and exit")
	migrateCredentials := flag.Bool("migrate-credentials", false, "migrate legacy managed credentials and exit")
	actionJSON := flag.String("action-json", "", "execute one typed console action and exit")
	flag.Parse()
	actionMode := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "action-json" {
			actionMode = true
		}
	})
	if actionMode && (*showVersion || *showReadyTools || *migrateCredentials) {
		fatal("choose only one CLI mode")
	}
	if *showVersion {
		fmt.Println(version)
		return
	}
	if *showReadyTools && *migrateCredentials {
		fatal("choose only one CLI mode")
	}
	if *showReadyTools {
		if err := writeReadyToolNames(os.Stdout); err != nil {
			fatal("resolve ready tools: " + err.Error())
		}
		return
	}
	if *migrateCredentials {
		if err := migrateLegacyCredentials(homeDir()); err != nil {
			fatal("migrate credentials: " + err.Error())
		}
		return
	}
	if actionMode {
		os.Exit(runActionJSON(context.Background(), *actionJSON, os.Stdout))
	}

	// Shut down background goroutines (JWKS refresh, the HTTP server) on signal.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	srv := newServer(newHandler(ctx, password))
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal("listen on " + srv.Addr + ": " + err.Error())
	}
}

// bodyReadTimeout is how long a request that carries a body has to deliver it. Every
// body the console reads is a few kilobytes (a login form, an API action), apart from
// an artifact upload, which extends its own deadline once its bearer has verified
// (uploadArtifact).
const bodyReadTimeout = 10 * time.Second

// newServer shapes requests for the directly-exposed self-host front door (and is
// benign on the managed loopback): ReadHeaderTimeout closes slowloris header-dribblers,
// IdleTimeout reaps idle keep-alives, MaxHeaderBytes caps header size, and
// limitBodyReads bounds the time a body may take. There is no server ReadTimeout or
// WriteTimeout. A ReadTimeout is one bound for every body, and the console needs a
// short one for a login form and a long one for an authenticated upload. A
// WriteTimeout would cut off responses that rightly take minutes: a skills install
// runs for up to skillsCLITimeout before it answers, and an artifact download can be
// 100 MiB. Neither would touch the console WebSocket, whose connection deadlines
// net/http clears when the upgrade hijacks it.
func newServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           limitBodyReads(h, bodyReadTimeout),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 16,
	}
}

// limitBodyReads gives every request that carries a body timeout to deliver it, so a
// client that dribbles a login POST, or a body nothing will read, cannot hold a
// connection open for as long as it cares to. Bodies are not only read by handlers:
// net/http also drains up to 256 KiB of an unread body when a handler responds, and
// without a deadline that drain waits on the client too.
//
// The deadline is per request, set through http.ResponseController, so a handler that
// expects a large body can extend it once it has authenticated the request
// (uploadArtifact). An upgrade request carries no body, so it never gets one. Nor
// does a long handler lose its context to it: net/http clears the read deadline the
// moment a body reaches EOF, before it starts the background read that watches for
// the client going away.
func limitBodyReads(next http.Handler, timeout time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength != 0 { // a declared length, or -1 for chunked
			_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(timeout))
		}
		next.ServeHTTP(w, r)
	})
}

// newHandler picks the mode ONCE, explicitly, on the marker the rest of the
// image uses (ENVHAVEN_MANAGED); the decision threads to serveConsole and
// pumpSession as `managed`, so no later code re-reads the marker. Managed
// validates a platform-minted EdDSA JWT against the platform JWKS; self-hosted
// validates the operator's own web password. Exactly one authenticator is ever
// built; if neither can be configured the process refuses to start
// (newManagedAuth / newSelfHost fatal). There is no unauthenticated path: auth
// and the pty share one port, so nothing on the network or in the container
// can reach a shell without a credential. password is the web password main took
// from the environment; only the self-hosted authenticator reads it.
func newHandler(ctx context.Context, password webPassword) (string, *http.ServeMux) {
	mux := http.NewServeMux()
	if os.Getenv("ENVHAVEN_MANAGED") == "true" {
		auth, origins := newManagedAuth(ctx)
		// Serve the SAME terminal page self-host serves, so the managed dashboard
		// embeds the one client instead of reimplementing it. The dashboard injects
		// the platform JWT over postMessage (the page has ?parent set); there is no
		// login/token route here because managed tokens are platform-minted. The WS
		// Origin allowlist (origins) is untouched: the iframe is served from the
		// workspace's own tunnel host, so its socket is same-host and auto-authorized.
		mux.HandleFunc("GET /__console/ui", func(w http.ResponseWriter, _ *http.Request) { serveUI(w, origins) })
		mux.HandleFunc("GET "+assetsPrefix, serveAsset)
		// The Cockpit HUD's out-of-band HTTP API (stats, tools, skills, artifacts,
		// tmux actions). It rides the SAME EdDSA JWT wall as the socket; CORS echoes
		// only the dashboard origins (the scheme-qualified frameAncestors list), so a
		// cross-site page holding no token still cannot read a response.
		registerAPI(mux, auth.verify, origins)
		mux.HandleFunc("/__console", func(w http.ResponseWriter, r *http.Request) {
			serveConsole(r.Context(), w, r, auth, origins, true)
		})
		return managedAddr, mux
	}
	sh := newSelfHost(password)
	mux.HandleFunc("GET /{$}", sh.handleRoot)
	mux.HandleFunc("POST /__console/login", sh.handleLogin)
	mux.HandleFunc("GET /__console/token", sh.handleToken)
	mux.HandleFunc("POST /__console/internal-token", sh.handleInternalToken)
	mux.HandleFunc("GET /__console/ui", func(w http.ResponseWriter, _ *http.Request) { serveUI(w, nil) })
	mux.HandleFunc("GET "+assetsPrefix, serveAsset)
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

	// The exact production dashboard origin is the default. Development can opt
	// into a scheme-qualified wildcard for its per-run hosts; the shared parser
	// keeps scheme and port exact and never widens this bare production origin.
	origins := frameAncestors(os.Getenv("_ENVHAVEN_CONSOLE_ORIGINS"))

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
	return &jwtAuth{jwks: jwks, workspaceID: workspaceID}, origins
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
func serveConsole(ctx context.Context, w http.ResponseWriter, r *http.Request, auth authenticator, allowedOrigins []string, managed bool) {
	if err := auth.authorize(r); err != nil {
		var ae *authError
		if errors.As(err, &ae) {
			http.Error(w, ae.msg, ae.status)
		} else {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		}
		return
	}
	if !websocketOriginAllowed(r, allowedOrigins) {
		http.Error(w, "request Origin not allowed", http.StatusForbidden)
		return
	}
	predict, err := predictProtocolFor(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	probeSession, err := probeSessionFor(r, managed)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Offer ONLY our protocol so the negotiated subprotocol never echoes the
	// bearer back to the client. Origin was enforced above against the full parsed
	// origin. coder/websocket's OriginPatterns cannot enforce schemes, so its
	// host-only verifier is deliberately bypassed only after that stronger check.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:       []string{subprotocol},
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20) // 1 MiB: large pastes, well above the 32 KiB default

	// Admitted only after the upgrade succeeded, so a failed handshake never costs a
	// live session its place.
	session, release := consoleSessions.admit(ctx)
	defer release()
	if err := pumpSession(session, conn, initialWinsize(r), managed, predict, probeSession); err != nil {
		conn.Close(websocket.StatusInternalError, "session ended")
		return
	}
	conn.Close(websocket.StatusNormalClosure, "")
}

// maxSessions bounds the terminal sessions one console serves at once. Each holds a
// login shell and a tmux client for as long as hardMaxLife, and one with predictive
// echo also runs a tmux poll every predictPoll (pump.go), so without a bound a client
// stuck in a reconnect loop, or anything holding a bearer, could keep opening them
// until the container ran out of processes. Eight is several more tabs than one
// person watches at once.
const maxSessions = 8

// sessionLimit admits console sessions up to max and, when full, closes the OLDEST to
// admit the new one rather than refusing it. The newest connection is the one a person
// has just opened; the oldest is the likeliest to be a forgotten tab, or a socket whose
// network vanished without a close, which the server only notices when the idle timeout
// runs out (pump.go). Refusing instead would lock the owner out behind sessions nobody
// can see. Eviction cancels the session's context, and coder/websocket drops a
// connection whose pending read is cancelled without sending a close frame, so the
// evicted page sees an abnormal close and shows its Reconnect button like any dropped
// session. A closed session stays closed: the page never reconnects by itself
// (ui/assets/eh-transport.js), so two tabs cannot evict each other in a loop.
type sessionLimit struct {
	mu   sync.Mutex
	max  int
	live []*liveSession // oldest first
}

type liveSession struct{ cancel context.CancelFunc }

var consoleSessions = &sessionLimit{max: maxSessions}

// admit registers a session and returns its context, cancelled if a newer session
// evicts it, plus the release func to call when the session ends.
func (l *sessionLimit) admit(parent context.Context) (context.Context, func()) {
	ctx, cancel := context.WithCancel(parent)
	s := &liveSession{cancel: cancel}
	l.mu.Lock()
	if len(l.live) >= l.max {
		l.live[0].cancel()
		l.live = slices.Delete(l.live, 0, 1)
	}
	l.live = append(l.live, s)
	l.mu.Unlock()
	return ctx, func() {
		l.mu.Lock()
		l.live = slices.DeleteFunc(l.live, func(o *liveSession) bool { return o == s })
		l.mu.Unlock()
		cancel()
	}
}

// probeSessionPattern is intentionally narrower than tmux's own session-name grammar.
// Only the browser echo harness emits these names, and accepting punctuation or an
// arbitrary target would turn a test-only isolation seam into a general tmux selector.
var probeSessionPattern = regexp.MustCompile(`^ehtest-[0-9a-z]{1,8}-[0-9a-z]{8,12}-[0-9a-f]{12}$`)

// probeSessionFor admits a connection-scoped grouped tmux view only for the managed
// predictive probe. A malformed or misplaced request fails instead of falling back to
// the shared base session, because that fallback would send test input to an operator.
func probeSessionFor(r *http.Request, managed bool) (string, error) {
	q := r.URL.Query()
	sessions, present := q["probeSession"]
	if !present {
		return "", nil
	}
	if len(sessions) != 1 || !managed || q.Get("probe") != "1" || q.Get("echo") != "1" || q.Get("echoProtocol") != "4" || !probeSessionPattern.MatchString(sessions[0]) {
		return "", errors.New("invalid console probe session")
	}
	return sessions[0], nil
}

// predictProtocolFor negotiates the predictive-gate wire format from the socket URL.
// echo=1 without a version retains the shipped v1 contract; current pages request v4.
// Any other active version is rejected before the WebSocket upgrade. A default session
// (or the managed dashboard client, which never predicts) spawns no gate.
// ENVHAVEN_SKIP_WELCOME=1 leaves the negotiation alone: the pump answers the socket in
// the negotiated version and vetoes the gate itself (pumpConfig.gateVetoed), because
// the browser admits input on an echo socket only after its first gate frame.
func predictProtocolFor(r *http.Request) (predictProtocol, error) {
	query := r.URL.Query()
	if query.Get("echo") != "1" {
		return predictOff, nil
	}
	versions := query["echoProtocol"]
	var protocol predictProtocol
	switch {
	case len(versions) == 0:
		protocol = predictV1
	case len(versions) == 1 && versions[0] == "1":
		protocol = predictV1
	case len(versions) == 1 && versions[0] == "4":
		protocol = predictV4
	case len(versions) != 1:
		return predictOff, errors.New("predictive protocol must be specified once; supported versions are 1 and 4")
	default:
		return predictOff, fmt.Errorf("unsupported predictive protocol %q; supported versions are 1 and 4", versions[0])
	}
	return protocol, nil
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

// websocketOriginAllowed mirrors coder/websocket's same-host allowance, then
// applies the full scheme-qualified policy to cross-origin browser requests.
// Requests without Origin are non-browser clients and remain allowed.
func websocketOriginAllowed(r *http.Request, allowed []string) bool {
	raw := r.Header.Get("Origin")
	if raw == "" {
		return true
	}
	origin, ok := parseOrigin(raw, false)
	if !ok {
		return false
	}
	requestHost := strings.ToLower(r.Host)
	originHost := origin.hostname
	if strings.Contains(originHost, ":") {
		originHost = "[" + originHost + "]"
	}
	if origin.port != "" {
		originHost += ":" + origin.port
	}
	return strings.EqualFold(originHost, requestHost) || originAllowed(raw, allowed)
}

// frameAncestors parses the one console-origin policy shared by CSP, CORS and
// WebSockets. Empty or wholly invalid configuration falls back to the exact
// production dashboard origin.
func frameAncestors(v string) []string {
	out := configuredOrigins(v)
	if len(out) == 0 {
		return []string{"https://envhaven.com"}
	}
	return out
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, "envhaven-console: "+msg)
	os.Exit(1)
}

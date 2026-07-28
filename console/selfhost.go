package main

// Self-hosted authentication. Managed instances mint short-lived EdDSA JWTs
// centrally; a self-hosted operator has no platform, so the console authenticates
// with the SAME web password the operator already gives code-server (PASSWORD or
// HASHED_PASSWORD). The browser logs in once (POST /__console/login), receives a
// signed session cookie, and exchanges it for a 60-second token (GET
// /__console/token) that it presents on the WebSocket — the IDENTICAL
// presented-bearer shape the managed JWT uses, so the WS auth path is one way.
//
// Why a token on the socket and not the cookie or the raw password: the console
// listens on a port reachable by the network and (in self-host) by anything in
// the container, so it must have NO ambient, unauthenticated surface, at parity
// with the IDE beside it. A short-lived bearer that only a logged-in browser can
// mint means a curious network client or a cross-site page can never reach a
// shell. It does NOT, and cannot, defend against code already running in the
// container as `abc`: that code can read the same PASSWORD/HASHED_PASSWORD the
// IDE uses and so can authenticate. The container itself is that trust boundary.
// The password never crosses the WebSocket; the durable secret never leaves the
// login POST body, which the operator runs behind TLS exactly as for the IDE.

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/hkdf"
	"golang.org/x/time/rate"
)

const (
	selfHostAddr  = ":7681" // all interfaces; the operator maps the port and fronts TLS
	wsTokenTTL    = 60 * time.Second
	sessionTTL    = 12 * time.Hour
	sessionCookie = "envhaven_console_session"

	// HMAC domain tags keep a session cookie value from being replayed as a WS
	// token and vice versa.
	ctxSession = "session"
	ctxWS      = "ws"

	// Login brute-force gate: a token bucket refilling at loginPerMin with this
	// burst. A legitimate operator logs in about once per sessionTTL, so this is
	// never hit in normal use; it caps online guessing.
	loginPerMin = 10
	loginBurst  = 10
)

// Password verification methods, mirroring code-server's getPasswordMethod:
// ARGON2 when HASHED_PASSWORD contains the literal "$argon", SHA256 for any
// other non-empty HASHED_PASSWORD (legacy hex), else PLAIN_TEXT from PASSWORD.
const (
	methodPlain = iota
	methodArgon2
	methodSHA256
)

//go:embed ui/terminal.html
var terminalHTML []byte

//go:embed ui/assets
var assetsFS embed.FS

// credential holds the operator's configured web password in the form code-server
// uses, so the console verifies against the exact same secret the IDE does.
type credential struct {
	method int
	plain  string // methodPlain
	hash   string // methodArgon2 (argon2 PHC) / methodSHA256 (lowercase hex)
}

// newCredential reads the web-password env code-server consumes, failing closed
// on a malformed HASHED_PASSWORD rather than degrading to a weaker check.
func newCredential() (*credential, error) {
	if h := os.Getenv("HASHED_PASSWORD"); h != "" {
		if strings.Contains(h, "$argon") {
			if _, err := parseArgon2(h); err != nil {
				return nil, fmt.Errorf("HASHED_PASSWORD: %w", err)
			}
			return &credential{method: methodArgon2, hash: h}, nil
		}
		if !isSHA256Hex(h) {
			return nil, errors.New("HASHED_PASSWORD is neither an argon2 PHC string nor a sha256 hex digest")
		}
		return &credential{method: methodSHA256, hash: strings.ToLower(h)}, nil
	}
	if p := os.Getenv("PASSWORD"); p != "" {
		return &credential{method: methodPlain, plain: p}, nil
	}
	return nil, errors.New("no web credential set (PASSWORD or HASHED_PASSWORD)")
}

// verify reports whether submitted matches the configured credential, in
// constant time for the method used.
func (c *credential) verify(submitted string) bool {
	switch c.method {
	case methodPlain:
		// Hash both sides to a fixed length so neither the comparison nor the
		// length leaks via timing.
		a := sha256.Sum256([]byte(submitted))
		b := sha256.Sum256([]byte(c.plain))
		return subtle.ConstantTimeCompare(a[:], b[:]) == 1
	case methodSHA256:
		sum := sha256.Sum256([]byte(submitted))
		return subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(c.hash)) == 1
	case methodArgon2:
		return verifyArgon2(c.hash, submitted)
	}
	return false
}

type argon2Params struct {
	variant    string
	m, t       uint32
	p          uint8
	salt, hash []byte
}

// parseArgon2 parses a code-server HASHED_PASSWORD PHC string
// ($argon2id$v=19$m=,t=,p=$saltb64$hashb64) and rejects anything malformed or
// unsupported (argon2d) so a bad config fails closed at startup.
func parseArgon2(phc string) (*argon2Params, error) {
	parts := strings.Split(phc, "$")
	if len(parts) != 6 || parts[0] != "" {
		return nil, errors.New("malformed argon2 PHC string")
	}
	variant := parts[1]
	if variant != "argon2id" && variant != "argon2i" {
		return nil, fmt.Errorf("unsupported argon2 variant %q", variant)
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return nil, errors.New("unsupported argon2 version")
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return nil, errors.New("malformed argon2 parameters")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) == 0 {
		return nil, errors.New("malformed argon2 salt")
	}
	hash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(hash) == 0 {
		return nil, errors.New("malformed argon2 hash")
	}
	return &argon2Params{variant, m, t, p, salt, hash}, nil
}

func verifyArgon2(phc, password string) bool {
	a, err := parseArgon2(phc)
	if err != nil {
		return false
	}
	var got []byte
	switch a.variant {
	case "argon2id":
		got = argon2.IDKey([]byte(password), a.salt, a.t, a.m, a.p, uint32(len(a.hash)))
	case "argon2i":
		got = argon2.Key([]byte(password), a.salt, a.t, a.m, a.p, uint32(len(a.hash)))
	default:
		return false
	}
	return subtle.ConstantTimeCompare(got, a.hash) == 1
}

func isSHA256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// deriveSecret derives the HMAC signing key from the password material via HKDF,
// so there is no new secret to configure and every issued cookie/token is
// invalidated the moment the operator rotates the password.
func deriveSecret(c *credential) []byte {
	material := c.hash
	if c.method == methodPlain {
		material = c.plain
	}
	r := hkdf.New(sha256.New, []byte(material), []byte("envhaven-console"), []byte("token-signing-key/v1"))
	key := make([]byte, 32)
	if _, err := io.ReadFull(r, key); err != nil {
		fatal("derive token key: " + err.Error())
	}
	return key
}

// sign computes HMAC-SHA256 over a domain tag and the expiry, so a value signed
// for one context (session) cannot be presented as another (ws).
func sign(secret []byte, ctxTag, expStr string) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(ctxTag))
	m.Write([]byte("|"))
	m.Write([]byte(expStr))
	return m.Sum(nil)
}

func mintToken(secret []byte, ctxTag string, now time.Time, ttl time.Duration) string {
	expStr := strconv.FormatInt(now.Add(ttl).Unix(), 10)
	return expStr + "." + base64.RawURLEncoding.EncodeToString(sign(secret, ctxTag, expStr))
}

func verifyToken(secret []byte, ctxTag, token string, now time.Time) bool {
	expStr, macB64, ok := strings.Cut(token, ".")
	if !ok {
		return false
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || now.Unix() > exp {
		return false
	}
	got, err := base64.RawURLEncoding.DecodeString(macB64)
	if err != nil {
		return false
	}
	return hmac.Equal(got, sign(secret, ctxTag, expStr))
}

// selfHost holds the self-hosted auth state and serves the login/token/UI routes.
type selfHost struct {
	cred    *credential
	secret  []byte
	origins []string
	limiter *rate.Limiter
}

func newSelfHost() *selfHost {
	cred, err := newCredential()
	if err != nil {
		fatal(err.Error())
	}
	return &selfHost{
		cred:    cred,
		secret:  deriveSecret(cred),
		origins: originHosts(os.Getenv("_ENVHAVEN_CONSOLE_ORIGINS")), // empty -> same-origin only
		limiter: rate.NewLimiter(rate.Limit(float64(loginPerMin)/60.0), loginBurst),
	}
}

// wsAuth is the WebSocket authenticator: it verifies the presented 60s token,
// the same presented-bearer shape the managed jwtAuth uses.
func (s *selfHost) wsAuth() authenticator { return tokenAuth{secret: s.secret} }

type tokenAuth struct{ secret []byte }

func (a tokenAuth) authorize(r *http.Request) error {
	token := extractToken(r.Header.Get("Sec-WebSocket-Protocol"))
	if token == "" {
		return &authError{http.StatusUnauthorized, "missing token"}
	}
	if !verifyToken(a.secret, ctxWS, token, time.Now()) {
		return &authError{http.StatusUnauthorized, "invalid token"}
	}
	return nil
}

// handleLogin verifies the web password and issues the session cookie. It is the
// ONLY place the durable credential is checked; everything downstream rides the
// signed cookie and the short token.
func (s *selfHost) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.Allow() {
		http.Error(w, "too many attempts", http.StatusTooManyRequests)
		return
	}
	// A password POST is tiny; cap the body so a large (or slow) one cannot buffer
	// unboundedly in this single-process server before it is even parsed.
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !s.cred.verify(r.PostFormValue("password")) {
		http.Error(w, "invalid password", http.StatusUnauthorized)
		return
	}
	// No Secure attribute: the documented flow is http://<host>:7681 with the
	// operator's own TLS in front, and browsers drop Secure cookies set from a
	// plain-HTTP non-localhost origin — the login would 204 yet never stick.
	// Wire confidentiality is the operator's TLS responsibility, at parity with
	// code-server; SameSite=Strict remains the cross-site gate.
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    mintToken(s.secret, ctxSession, time.Now(), sessionTTL),
		Path:     "/__console",
		MaxAge:   int(sessionTTL.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	w.WriteHeader(http.StatusNoContent)
}

// handleToken exchanges a valid session cookie for a 60s WebSocket token. The
// SameSite=Strict cookie already blocks cross-site delivery; the Sec-Fetch-Site
// check rejects any non-same-origin fetch as defense in depth.
func (s *selfHost) handleToken(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(sessionCookie)
	if err != nil || !verifyToken(s.secret, ctxSession, c.Value, time.Now()) {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, mintToken(s.secret, ctxWS, time.Now(), wsTokenTTL))
}

// handleRoot redirects the bare host root to the terminal page, so an operator
// who opens http://host:7681/ lands on the UI without knowing the /__console path.
func (s *selfHost) handleRoot(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/__console/ui", http.StatusFound)
}

// serveUI writes the embedded terminal page. The page holds no secret: self-host
// fetches a token and prompts for the password only if that returns 401; managed
// receives a platform JWT from the embedding dashboard over postMessage. The SAME
// page serves both modes — the only difference is who may frame it. frameAncestors
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
	_, _ = w.Write(terminalHTML)
}

// assetsHandler serves the embedded FS behind /__console/assets: the vendored xterm
// bundles and fonts, plus eh-engine.js, which is ours and is the terminal itself. With
// content types inferred from their extensions.
func assetsHandler() http.Handler {
	sub, err := fs.Sub(assetsFS, "ui/assets")
	if err != nil {
		fatal("embed ui/assets: " + err.Error())
	}
	return http.StripPrefix("/__console/assets/", http.FileServer(http.FS(sub)))
}

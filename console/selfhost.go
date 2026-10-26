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
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/hkdf"
	"golang.org/x/time/rate"
)

const (
	selfHostAddr        = ":7681" // all interfaces; the operator maps the port and fronts TLS
	wsTokenTTL          = 60 * time.Second
	sessionTTL          = 12 * time.Hour
	sessionCookie       = "envhaven_console_session"
	internalProofWindow = 30 * time.Second

	// HMAC domain tags keep a session cookie value from being replayed as a WS
	// token and vice versa.
	ctxSession  = "session"
	ctxWS       = "ws"
	ctxInternal = "extension-token"

	// Login brute-force gate (loginLimiter): a token bucket per client address
	// refilling at loginPerMin with loginBurst, under one shared bucket for all
	// addresses together. A legitimate operator logs in about once per sessionTTL,
	// so neither is hit in normal use. The shared bucket refills faster than any one
	// client's can, so a single flooding address can never empty it; it caps how
	// fast many addresses together can guess, and how many password hashes they can
	// make this process compute. Several addresses together can empty it, so an
	// address that has logged in within sessionTTL does not draw on it.
	loginPerMin       = 10
	loginBurst        = 10
	loginGlobalPerMin = 30
	loginGlobalBurst  = 20
	// maxLoginClients bounds the per-address table and the set of addresses that
	// have logged in, so a flood from many addresses costs memory in proportion to
	// this, not to the number of addresses.
	maxLoginClients = 1024

	// instanceSaltFile holds this install's token-key salt (instanceSalt), beside the
	// managed credential store in ~/.config/envhaven, on the volume.
	instanceSaltFile = "console-token-salt"
	instanceSaltLen  = 32
)

// Password verification methods, mirroring code-server's getPasswordMethod:
// ARGON2 when HASHED_PASSWORD contains the literal "$argon", SHA256 for any
// other non-empty HASHED_PASSWORD (legacy hex), else PLAIN_TEXT from PASSWORD.
const (
	methodPlain = iota
	methodArgon2
	methodSHA256
)

// credential holds the operator's configured web password in the form code-server
// uses, so the console verifies against the exact same secret the IDE does.
type credential struct {
	method int
	plain  string // methodPlain
	hash   string // methodArgon2 (argon2 PHC) / methodSHA256 (lowercase hex)
}

// webPassword is the operator's web password exactly as code-server receives it:
// HASHED_PASSWORD and PASSWORD, either of which may be empty.
type webPassword struct{ hashed, plain string }

// takeWebPassword reads the web password and removes both variables from this
// process's environment. Everything the console starts inherits that environment:
// the login shell behind every session (and through it any tmux server the shell
// starts, so every pane and every agent in it), `skills add` and whatever it
// installs, vendor CLIs. None of them needs the operator's password, and code-server
// deletes the same two variables from its own environment for the same reason. This
// stops inheritance only: code running as abc can still read the s6 copy of the
// container environment (see the trust boundary in docs/configuration.md).
func takeWebPassword() webPassword {
	p := webPassword{hashed: os.Getenv("HASHED_PASSWORD"), plain: os.Getenv("PASSWORD")}
	os.Unsetenv("HASHED_PASSWORD")
	os.Unsetenv("PASSWORD")
	return p
}

// newCredential builds the credential from the web password code-server consumes,
// failing closed on a malformed HASHED_PASSWORD rather than degrading to a weaker
// check.
func newCredential(p webPassword) (*credential, error) {
	if h := p.hashed; h != "" {
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
	if p.plain != "" {
		return &credential{method: methodPlain, plain: p.plain}, nil
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

// deriveSecret derives the key that signs this install's session cookies and
// WebSocket tokens: HKDF of the password material, salted with the install's own
// salt (instanceSalt). The password in the input means there is no new secret to
// configure and every issued cookie and token is invalidated the moment the operator
// rotates the password. The salt means a cookie or token taken from one install does
// not verify on another that happens to share the password.
func deriveSecret(c *credential, salt []byte) []byte {
	return deriveKey(c, salt, "token-signing-key/v2")
}

// deriveProofKey derives the key the in-container extension proves it holds
// HASHED_PASSWORD with (handleInternalToken). The extension computes the same bytes
// (extension/src/consoleClient.ts, and dev/scripts/test-image.ts in the image check),
// so this derivation is a contract: its fixed salt and info stay exactly as they are.
// It only ever checks that 30-second proof, never a cookie or a token, so the
// install binding deriveSecret adds would protect nothing here: anyone able to
// compute the proof already holds HASHED_PASSWORD.
func deriveProofKey(c *credential) []byte {
	return deriveKey(c, []byte("envhaven-console"), "token-signing-key/v1")
}

func deriveKey(c *credential, salt []byte, info string) []byte {
	material := c.hash
	if c.method == methodPlain {
		material = c.plain
	}
	r := hkdf.New(sha256.New, []byte(material), salt, []byte(info))
	key := make([]byte, 32)
	if _, err := io.ReadFull(r, key); err != nil {
		fatal("derive token key: " + err.Error())
	}
	return key
}

// instanceSalt returns this install's token-key salt, created on first start and kept
// in ~/.config/envhaven so that sessions survive restarts and image updates. When it
// cannot be stored (a read-only home, a planted symlink), the console runs on a salt
// that lives as long as the process, which is no less safe: every restart then signs
// the operator out.
func instanceSalt(home string) []byte {
	salt, err := loadInstanceSalt(home)
	if err == nil {
		return salt
	}
	fmt.Fprintln(os.Stderr, "envhaven-console: token salt not stored ("+err.Error()+"); sessions will end when the console restarts")
	salt = make([]byte, instanceSaltLen)
	if _, err := rand.Read(salt); err != nil {
		fatal("generate token salt: " + err.Error())
	}
	return salt
}

// loadInstanceSalt reads the stored salt, or writes a fresh one when there is none or
// the stored one is not 32 hex-encoded bytes (a truncated write, a hand edit), which
// signs everyone out once.
func loadInstanceSalt(home string) ([]byte, error) {
	dir, err := ensureCredentialStoreDirectory(home)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, instanceSaltFile)
	info, err := os.Lstat(path)
	switch {
	case err == nil && !info.Mode().IsRegular():
		return nil, fmt.Errorf("%s is not a regular file", path)
	case err == nil:
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if salt, err := hex.DecodeString(strings.TrimSpace(string(data))); err == nil && len(salt) == instanceSaltLen {
			return salt, nil
		}
	case !errors.Is(err, os.ErrNotExist):
		return nil, err
	}
	salt := make([]byte, instanceSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	if err := atomicReplaceFile(path, []byte(hex.EncodeToString(salt)+"\n"), 0o600); err != nil {
		return nil, err
	}
	return salt, nil
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
	cred     *credential
	secret   []byte // signs session cookies and WebSocket tokens (deriveSecret)
	proofKey []byte // checks the extension's hash proof (deriveProofKey)
	origins  []string
	logins   *loginLimiter
}

func newSelfHost(password webPassword) *selfHost {
	cred, err := newCredential(password)
	if err != nil {
		fatal(err.Error())
	}
	return &selfHost{
		cred:     cred,
		secret:   deriveSecret(cred, instanceSalt(homeDir())),
		proofKey: deriveProofKey(cred),
		origins:  configuredOrigins(os.Getenv("_ENVHAVEN_CONSOLE_ORIGINS")), // empty -> same-origin only
		logins:   newLoginLimiter(),
	}
}

// loginLimiter is the login brute-force gate: a token bucket per client address
// under one shared bucket. With a single shared bucket, as this once was, one client
// sending a wrong password every six seconds kept it empty and locked the operator out
// of the published port; now that client only ever drains its own. Three such
// clients would still keep the shared bucket empty, so an address that logged in
// successfully within sessionTTL skips it and answers to its own bucket alone: a
// coordinated flood cannot keep the operator out from an address they have used.
// A first login from a new address still waits on the shared bucket, which is what
// keeps guessing from many addresses bounded.
type loginLimiter struct {
	mu      sync.Mutex
	clients map[string]*rate.Limiter
	global  *rate.Limiter
	known   map[string]time.Time // address key -> its last successful login
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{
		clients: map[string]*rate.Limiter{},
		global:  rate.NewLimiter(rate.Limit(float64(loginGlobalPerMin)/60.0), loginGlobalBurst),
		known:   map[string]time.Time{},
	}
}

// allow reports whether a login attempt from remoteAddr may proceed at now. The
// client's own bucket is charged first, so an attempt it refuses never reaches the
// shared bucket, and an address with a recent successful login never reaches it.
func (l *loginLimiter) allow(remoteAddr string, now time.Time) bool {
	key := loginClientKey(remoteAddr)
	l.mu.Lock()
	defer l.mu.Unlock()
	client, ok := l.clients[key]
	if !ok {
		if len(l.clients) >= maxLoginClients {
			l.evict(now)
		}
		client = rate.NewLimiter(rate.Limit(float64(loginPerMin)/60.0), loginBurst)
		l.clients[key] = client
	}
	if !client.AllowN(now, 1) {
		return false
	}
	if at, ok := l.known[key]; ok {
		if now.Sub(at) < sessionTTL {
			return true
		}
		delete(l.known, key)
	}
	return l.global.AllowN(now, 1)
}

// succeeded records a login that passed verification, so its address skips the
// shared bucket for the next sessionTTL. Recording one takes the password, so the set
// stays small; when it is full, expired entries go first, then the oldest login.
func (l *loginLimiter) succeeded(remoteAddr string, now time.Time) {
	key := loginClientKey(remoteAddr)
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.known[key]; !ok && len(l.known) >= maxLoginClients {
		var oldest string
		var at time.Time
		found := false
		for k, t := range l.known {
			if now.Sub(t) >= sessionTTL {
				delete(l.known, k)
			} else if !found || t.Before(at) {
				oldest, at, found = k, t, true
			}
		}
		if len(l.known) >= maxLoginClients {
			delete(l.known, oldest)
		}
	}
	l.known[key] = now
}

// evict makes room in a full table. A client whose bucket has refilled carries nothing
// a fresh bucket would not, so all of those go; if none has, the one closest to full
// does. Forgetting a client can only hand it a fresh burst, and every attempt still
// pays into the shared bucket.
func (l *loginLimiter) evict(now time.Time) {
	fullest, most := "", -1.0
	for key, client := range l.clients {
		tokens := client.TokensAt(now)
		if tokens >= loginBurst {
			delete(l.clients, key)
		} else if tokens > most {
			fullest, most = key, tokens
		}
	}
	if len(l.clients) >= maxLoginClients {
		delete(l.clients, fullest)
	}
}

// loginClientKey is the address an attempt is charged to: the peer IP, with IPv6
// grouped by /64, the block one subscriber is normally given, so stepping through
// addresses inside it buys nothing. X-Forwarded-For is never read, because any
// client can set it; behind a reverse proxy every attempt therefore arrives from the
// proxy's address and shares its bucket, which is how the gate behaved before.
func loginClientKey(remoteAddr string) string {
	ap, err := netip.ParseAddrPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	addr := ap.Addr().Unmap().WithZone("")
	if addr.Is6() {
		return netip.PrefixFrom(addr, 64).Masked().String()
	}
	return addr.String()
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
	if !s.logins.allow(r.RemoteAddr, time.Now()) {
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
	s.logins.succeeded(r.RemoteAddr, time.Now())
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

// handleInternalToken gives the extension host a hash-only equivalent of the
// browser's login-cookie exchange. It accepts only a loopback request carrying
// a short-lived HMAC proof; HASHED_PASSWORD itself never crosses HTTP or enters
// the webview. Plaintext deployments continue to use handleLogin.
func (s *selfHost) handleInternalToken(w http.ResponseWriter, r *http.Request) {
	if !remoteIsLoopback(r.RemoteAddr) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if s.cred.method == methodPlain {
		http.NotFound(w, r)
		return
	}
	issued := r.Header.Get("X-EnvHaven-Issued")
	issuedUnix, err := strconv.ParseInt(issued, 10, 64)
	if err != nil || !withinProofWindow(time.Now().Unix(), issuedUnix) {
		http.Error(w, "invalid proof", http.StatusUnauthorized)
		return
	}
	proof, err := base64.RawURLEncoding.DecodeString(r.Header.Get("X-EnvHaven-Proof"))
	if err != nil || !hmac.Equal(proof, sign(s.proofKey, ctxInternal, issued)) {
		http.Error(w, "invalid proof", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, mintToken(s.secret, ctxWS, time.Now(), wsTokenTTL))
}

func remoteIsLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = strings.Trim(remoteAddr, "[]")
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func withinProofWindow(now, issued int64) bool {
	window := int64(internalProofWindow / time.Second)
	return issued >= now-window && issued <= now+window
}

// handleRoot redirects the bare host root to the terminal page, so an operator
// who opens http://host:7681/ lands on the UI without knowing the /__console path.
func (s *selfHost) handleRoot(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/__console/ui", http.StatusFound)
}

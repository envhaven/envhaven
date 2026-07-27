package main

import (
	"context"
	"io"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// fakeConn is an in-memory wireConn: `in` carries frames the browser would
// send, `out` collects frames the server writes. out is buffered so the pump
// never blocks waiting on an assertion-side reader.
type fakeConn struct {
	in  chan []byte
	out chan []byte
}

func newFakeConn() *fakeConn {
	return &fakeConn{in: make(chan []byte), out: make(chan []byte, 256)}
}

func (c *fakeConn) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	select {
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	case p, ok := <-c.in:
		if !ok {
			return 0, nil, io.EOF
		}
		return websocket.MessageBinary, p, nil
	}
}

func (c *fakeConn) Write(ctx context.Context, _ websocket.MessageType, p []byte) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case c.out <- append([]byte(nil), p...):
		return nil
	}
}

// testCfg is the baseline pump config for tests: predict off, a never-safe
// pane gate, and limits far beyond any test's runtime.
func testCfg() pumpConfig {
	return pumpConfig{
		paneState: func(context.Context) (bool, string) { return false, "" },
		idle:      time.Minute,
		maxLife:   time.Minute,
	}
}

// startPump opens a pty pair and runs pump against its master, letting the
// test play the shell on the pts side. The pts is set raw with echo off so
// bytes only move where the pump moves them.
func startPump(t *testing.T, cfg pumpConfig) (*fakeConn, *os.File, chan error) {
	t.Helper()
	ptmx, tts, err := pty.Open()
	if err != nil {
		t.Fatalf("open pty pair: %v", err)
	}
	t.Cleanup(func() { ptmx.Close(); tts.Close() })
	tio, err := unix.IoctlGetTermios(int(tts.Fd()), unix.TCGETS)
	if err != nil {
		t.Fatalf("TCGETS: %v", err)
	}
	tio.Lflag &^= unix.ICANON | unix.ECHO
	if err := unix.IoctlSetTermios(int(tts.Fd()), unix.TCSETS, tio); err != nil {
		t.Fatalf("TCSETS raw: %v", err)
	}
	conn := newFakeConn()
	done := make(chan error, 1)
	go func() { done <- pump(context.Background(), conn, ptmx, cfg) }()
	return conn, tts, done
}

// waitDone asserts the pump returns a clean nil within the deadline.
func waitDone(t *testing.T, done chan error, within time.Duration) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("pump returned %v, want nil", err)
		}
	case <-time.After(within):
		t.Fatalf("pump did not return within %v", within)
	}
}

// readFrame returns the next frame of the wanted type within 2s, skipping
// frames of other types (data frames interleave freely with gate frames).
func readFrame(t *testing.T, conn *fakeConn, want byte) []byte {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case f := <-conn.out:
			if len(f) > 0 && f[0] == want {
				return f
			}
		case <-deadline:
			t.Fatalf("no 0x%02x frame within 2s", want)
		}
	}
}

// readData accumulates 0x00 frame payloads until n bytes have arrived (a pty
// may split one write across reads).
func readData(t *testing.T, conn *fakeConn, n int) []byte {
	t.Helper()
	deadline := time.After(2 * time.Second)
	var buf []byte
	for len(buf) < n {
		select {
		case f := <-conn.out:
			if len(f) > 0 && f[0] == frameData {
				buf = append(buf, f[1:]...)
			}
		case <-deadline:
			t.Fatalf("got %d of %d data bytes within 2s", len(buf), n)
		}
	}
	return buf
}

// readPts reads exactly n bytes from the shell side within 2s.
func readPts(t *testing.T, tts *os.File, n int) []byte {
	t.Helper()
	got := make(chan []byte, 1)
	go func() {
		buf := make([]byte, 0, n)
		tmp := make([]byte, n)
		for len(buf) < n {
			k, err := tts.Read(tmp)
			if k > 0 {
				buf = append(buf, tmp[:k]...)
			}
			if err != nil {
				return
			}
		}
		got <- buf
	}()
	select {
	case b := <-got:
		return b
	case <-time.After(2 * time.Second):
		t.Fatalf("shell side did not receive %d bytes within 2s", n)
		return nil
	}
}

// TestPumpDataBothWays pins the 0x00 leg of the wire protocol: shell output
// becomes data frames, data frames become shell input, and a closed browser
// side is a clean end of session.
func TestPumpDataBothWays(t *testing.T) {
	conn, tts, done := startPump(t, testCfg())

	if _, err := tts.Write([]byte("hello")); err != nil {
		t.Fatalf("shell write: %v", err)
	}
	if got := string(readData(t, conn, 5)); got != "hello" {
		t.Fatalf("browser received %q, want %q", got, "hello")
	}

	conn.in <- append([]byte{frameData}, []byte("world")...)
	if got := string(readPts(t, tts, 5)); got != "world" {
		t.Fatalf("shell received %q, want %q", got, "world")
	}

	// Non-binary/empty frames are ignored, not fatal.
	conn.in <- nil

	close(conn.in) // browser goes away -> io.EOF -> clean end
	waitDone(t, done, 2*time.Second)
}

// TestPumpResize pins the 0x01 leg: a resize frame reaches the pty, and junk
// JSON is ignored without killing the session or the size.
func TestPumpResize(t *testing.T) {
	conn, tts, done := startPump(t, testCfg())

	conn.in <- append([]byte{frameResize}, []byte(`{"cols":101,"rows":41}`)...)
	deadline := time.Now().Add(2 * time.Second)
	for {
		sz, err := pty.GetsizeFull(tts)
		if err == nil && sz.Cols == 101 && sz.Rows == 41 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("pty size = %+v, want 101x41", sz)
		}
		time.Sleep(10 * time.Millisecond)
	}

	conn.in <- append([]byte{frameResize}, []byte(`not json`)...)
	time.Sleep(50 * time.Millisecond)
	if sz, err := pty.GetsizeFull(tts); err != nil || sz.Cols != 101 || sz.Rows != 41 {
		t.Fatalf("junk resize changed the pty: %+v (err %v)", sz, err)
	}

	close(conn.in)
	waitDone(t, done, 2*time.Second)
}

// TestPumpIdleTimeout: with no traffic in either direction the session closes
// cleanly once the idle limit elapses.
func TestPumpIdleTimeout(t *testing.T) {
	cfg := testCfg()
	cfg.idle = 150 * time.Millisecond
	start := time.Now()
	_, _, done := startPump(t, cfg)
	waitDone(t, done, 2*time.Second)
	if since := time.Since(start); since < cfg.idle {
		t.Fatalf("pump closed after %v, before the %v idle limit", since, cfg.idle)
	}
}

// TestPumpActivityExtendsIdle is the regression test for the idle timer: a
// session with traffic must outlive the idle limit and close only after the
// traffic stops. (The pre-fix stop-and-drain timer pattern would hang forever
// here under go >= 1.23 timer semantics when a fire raced an activity signal.)
func TestPumpActivityExtendsIdle(t *testing.T) {
	cfg := testCfg()
	cfg.idle = 400 * time.Millisecond
	_, tts, done := startPump(t, cfg)

	// 5 writes 150ms apart: 750ms of activity, well past the 400ms idle limit.
	for i := 0; i < 5; i++ {
		select {
		case err := <-done:
			t.Fatalf("pump ended during active traffic (write %d): %v", i, err)
		case <-time.After(150 * time.Millisecond):
		}
		if _, err := tts.Write([]byte("x")); err != nil {
			t.Fatalf("shell write: %v", err)
		}
	}
	waitDone(t, done, 3*time.Second) // silence -> idle close
}

// TestPumpMaxLife: the hard lifetime cap closes the session cleanly.
func TestPumpMaxLife(t *testing.T) {
	cfg := testCfg()
	cfg.maxLife = 200 * time.Millisecond
	start := time.Now()
	_, _, done := startPump(t, cfg)
	waitDone(t, done, 2*time.Second)
	if since := time.Since(start); since < cfg.maxLife {
		t.Fatalf("pump closed after %v, before the %v lifetime cap", since, cfg.maxLife)
	}
}

// TestPumpPredictGate pins the 0x02 leg end to end: the browser learns the
// initial state (safety AND pane app), sees safe/unsafe transitions (only
// transitions), sees a frame when the pane app changes even while safety does
// not, and a submitted newline forces unsafe for the full grace before
// re-arming — the transition that also re-arms the browser's own newline-disarm.
func TestPumpPredictGate(t *testing.T) {
	var safe atomic.Bool
	var app atomic.Value
	app.Store("zsh")
	cfg := testCfg()
	cfg.predict = true
	cfg.paneState = func(context.Context) (bool, string) { return safe.Load(), app.Load().(string) }
	conn, _, done := startPump(t, cfg)

	if f := readFrame(t, conn, framePredict); f[1] != 0 || string(f[2:]) != "zsh" {
		t.Fatalf("initial gate frame = %d %q, want 0 (fail closed) with app zsh", f[1], f[2:])
	}
	safe.Store(true)
	if f := readFrame(t, conn, framePredict); f[1] != 1 || string(f[2:]) != "zsh" {
		t.Fatalf("gate frame after pane became safe = %d %q, want 1 zsh", f[1], f[2:])
	}

	// The foreground app changes while safety does not: still a frame, so the
	// browser can swap its per-app prediction facts the moment the pane's
	// application does.
	app.Store("claude")
	if f := readFrame(t, conn, framePredict); f[1] != 1 || string(f[2:]) != "claude" {
		t.Fatalf("gate frame after app change = %d %q, want 1 claude", f[1], f[2:])
	}

	// Enter: unsafe within a poll, re-armed no sooner than the submit grace.
	before := time.Now()
	conn.in <- []byte{frameData, '\r'}
	if f := readFrame(t, conn, framePredict); f[1] != 0 {
		t.Fatalf("gate frame after newline = %d, want 0", f[1])
	}
	if f := readFrame(t, conn, framePredict); f[1] != 1 {
		t.Fatalf("gate frame after grace = %d, want 1 (re-arm)", f[1])
	}
	if since := time.Since(before); since < predictSubmitGrace {
		t.Fatalf("gate re-armed %v after newline, before the %v grace", since, predictSubmitGrace)
	}

	close(conn.in)
	waitDone(t, done, 2*time.Second)
}

// TestPumpPredictGateUnreadablePane pins what an empty app name MEANS. paneState
// reports one on every failure — no tmux, malformed output, the 500ms read timing
// out — and that is "no information", not "the app changed to nothing". The
// browser has no unknown case: an empty name reads as a real app change, so it
// would hand off to nothing and hand back again, and the second handoff lands
// exactly as the user resumes typing, which is the latency this feature exists to
// hide. So the last known name carries forward, and an unreadable pane may move
// only the safety byte, which already fails closed.
func TestPumpPredictGateUnreadablePane(t *testing.T) {
	var unreadable atomic.Bool
	cfg := testCfg()
	cfg.predict = true
	cfg.paneState = func(context.Context) (bool, string) {
		if unreadable.Load() {
			return false, "" // every paneState error path, verbatim
		}
		return true, "claude"
	}
	conn, _, done := startPump(t, cfg)

	if f := readFrame(t, conn, framePredict); f[1] != 1 || string(f[2:]) != "claude" {
		t.Fatalf("initial gate frame = %d %q, want 1 claude", f[1], f[2:])
	}

	// The pane goes unreadable. The safety flip must still be delivered — that is
	// the half that protects a secret — but it must carry the app the browser is
	// already set up for, not an empty name.
	unreadable.Store(true)
	if f := readFrame(t, conn, framePredict); f[1] != 0 || string(f[2:]) != "claude" {
		t.Fatalf("gate frame for an unreadable pane = %d %q, want 0 claude", f[1], f[2:])
	}

	// It stays unreadable for several more polls. Nothing has changed, so nothing
	// may be sent: each spurious frame here is a heavy handoff the user pays for.
	quiet := time.After(4 * predictPoll)
	for settled := false; !settled; {
		select {
		case f := <-conn.out:
			if len(f) > 0 && f[0] == framePredict {
				t.Fatalf("gate frame %d %q while the pane stayed unreadable and nothing changed", f[1], f[2:])
			}
		case <-quiet:
			settled = true
		}
	}

	// Readable again: one frame back to safe, still the same app throughout, so
	// the round trip cost the browser no handoff at all.
	unreadable.Store(false)
	if f := readFrame(t, conn, framePredict); f[1] != 1 || string(f[2:]) != "claude" {
		t.Fatalf("gate frame after the pane became readable = %d %q, want 1 claude", f[1], f[2:])
	}

	close(conn.in)
	waitDone(t, done, 2*time.Second)
}

// TestPumpNoPredictFrames: a session that did not opt in must never see a 0x02
// frame, even with a safe pane (the managed dashboard client relies on this).
func TestPumpNoPredictFrames(t *testing.T) {
	cfg := testCfg()
	cfg.paneState = func(context.Context) (bool, string) { return true, "zsh" }
	conn, tts, done := startPump(t, cfg)

	if _, err := tts.Write([]byte("ok")); err != nil {
		t.Fatalf("shell write: %v", err)
	}
	readData(t, conn, 2)
	time.Sleep(3 * predictPoll) // a few polls' worth of opportunity
	for {
		select {
		case f := <-conn.out:
			if len(f) > 0 && f[0] == framePredict {
				t.Fatal("predict frame sent on a session that did not opt in")
			}
		default:
			close(conn.in)
			waitDone(t, done, 2*time.Second)
			return
		}
	}
}

// TestGateSessionFor pins the mode->gate-session mapping (pump.go): managed watches
// the base envhaven session with no extra env; self-host watches its own grouped
// console-view and exports ENVHAVEN_CONSOLE_SESSION so envhaven-welcome.sh builds it.
func TestGateSessionFor(t *testing.T) {
	if s, env := gateSessionFor(true); s != tmuxSession || len(env) != 0 {
		t.Errorf("gateSessionFor(true) = (%q, %v), want (%q, [])", s, env, tmuxSession)
	}
	s, env := gateSessionFor(false)
	wantEnv := "ENVHAVEN_CONSOLE_SESSION=" + selfhostGateSession
	if s != selfhostGateSession || len(env) != 1 || env[0] != wantEnv {
		t.Errorf("gateSessionFor(false) = (%q, %v), want (%q, [%q])", s, env, selfhostGateSession, wantEnv)
	}
}

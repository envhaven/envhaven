package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"slices"
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
		paneState: func(context.Context) paneSnapshot { return paneSnapshot{} },
		idle:      time.Minute,
		maxLife:   time.Minute,
	}
}

func testPane(safe bool, app string, bottom uint16) paneSnapshot {
	return paneSnapshot{
		Safe: safe, App: app, Top: 0, Bottom: bottom,
		Left: 0, Right: 106, Geometry: true, Readable: true,
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

func readPredictFrame(t *testing.T, conn *fakeConn, protocol predictProtocol) paneSnapshot {
	t.Helper()
	var want byte
	switch protocol {
	case predictV1:
		want = framePredictV1
	case predictV4:
		want = framePredictV4
	default:
		t.Fatalf("cannot read disabled predict protocol")
		return paneSnapshot{}
	}
	f := readFrame(t, conn, want)
	switch protocol {
	case predictV1:
		if len(f) < 2 {
			t.Fatalf("short v1 predict frame: %v", f)
		}
		return paneSnapshot{Safe: f[1] == 1, App: string(f[2:]), Readable: true}
	case predictV4:
		if len(f) < 10 {
			t.Fatalf("short v4 predict frame: %v", f)
		}
		return paneSnapshot{
			Safe: f[1] == 1,
			Top:  uint16(f[2])<<8 | uint16(f[3]), Bottom: uint16(f[4])<<8 | uint16(f[5]),
			Left: uint16(f[6])<<8 | uint16(f[7]), Right: uint16(f[8])<<8 | uint16(f[9]),
			App: string(f[10:]), Readable: true,
		}
	default:
		t.Fatalf("cannot read disabled predict protocol")
		return paneSnapshot{}
	}
}

type predictFrameFixture struct {
	Name     string          `json:"name"`
	Protocol predictProtocol `json:"protocol"`
	PaneSafe bool            `json:"paneSafe"`
	Safe     bool            `json:"safe"`
	Top      uint16          `json:"top"`
	Bottom   uint16          `json:"bottom"`
	Left     uint16          `json:"left"`
	Right    uint16          `json:"right"`
	Geometry bool            `json:"geometry"`
	App      string          `json:"app"`
	Bytes    []byte          `json:"bytes"`
}

func predictFrameFixtures(t *testing.T) []predictFrameFixture {
	t.Helper()
	b, err := os.ReadFile("testdata/predict-frames.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []predictFrameFixture
	if err := json.Unmarshal(b, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) == 0 {
		t.Fatal("predict frame fixture is empty")
	}
	return fixtures
}

func TestPredictV1V4FrameCompatibility(t *testing.T) {
	for _, fixture := range predictFrameFixtures(t) {
		t.Run(fixture.Name, func(t *testing.T) {
			pane := paneSnapshot{
				Safe: fixture.PaneSafe, Top: fixture.Top, Bottom: fixture.Bottom,
				Left: fixture.Left, Right: fixture.Right, Geometry: fixture.Geometry,
				App: fixture.App, Readable: true,
			}
			if got := encodePredictFrame(fixture.Protocol, pane); !bytes.Equal(got, fixture.Bytes) {
				t.Fatalf("encodePredictFrame = %v, want %v", got, fixture.Bytes)
			}
		})
	}
	if got := encodePredictFrame(predictOff, paneSnapshot{Safe: true, App: "zsh"}); got != nil {
		t.Fatalf("disabled protocol encoded %v, want nil", got)
	}
}

func TestPredictSafeRequiresExactV4Geometry(t *testing.T) {
	full := testPane(true, "zsh", 38)
	lower := full
	lower.Top, lower.Bottom = 18, 38
	narrow := full
	narrow.Left, narrow.Right = 53, 106
	reversedRows := lower
	reversedRows.Bottom = reversedRows.Top
	reversedColumns := narrow
	reversedColumns.Right = reversedColumns.Left
	unreadableGeometry := full
	unreadableGeometry.Geometry = false

	for _, tc := range []struct {
		name     string
		protocol predictProtocol
		pane     paneSnapshot
		want     bool
	}{
		{"v1 has no geometry", predictV1, full, false},
		{"v4 represents a lower pane", predictV4, lower, true},
		{"v4 represents a horizontal split", predictV4, narrow, true},
		{"v4 refuses reversed rows", predictV4, reversedRows, false},
		{"v4 refuses reversed columns", predictV4, reversedColumns, false},
		{"v4 refuses inexact geometry", predictV4, unreadableGeometry, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := predictSafe(tc.protocol, tc.pane); got != tc.want {
				t.Fatalf("predictSafe(%v, %+v) = %v, want %v", tc.protocol, tc.pane, got, tc.want)
			}
		})
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

// TestPumpPredictV1Compatibility keeps the shipped geometry-free frame alive for
// an already-open page while refusing its historical safe bit.
func TestPumpPredictV1Compatibility(t *testing.T) {
	var app atomic.Value
	app.Store("zsh")
	cfg := testCfg()
	cfg.predict = predictV1
	cfg.paneState = func(context.Context) paneSnapshot {
		return testPane(true, app.Load().(string), 38)
	}
	conn, _, done := startPump(t, cfg)

	if pane := readPredictFrame(t, conn, predictV1); pane.Safe || pane.App != "zsh" || pane.Bottom != 0 {
		t.Fatalf("initial v1 gate frame = %+v, want conservative zsh without geometry", pane)
	}
	app.Store("claude")
	if pane := readPredictFrame(t, conn, predictV1); pane.Safe || pane.App != "claude" || pane.Bottom != 0 {
		t.Fatalf("v1 app-change frame = %+v, want conservative claude without geometry", pane)
	}

	close(conn.in)
	waitDone(t, done, 2*time.Second)
}

// TestPumpPredictGate pins the current v4 leg end to end: the browser learns the
// initial state (safety AND pane app), sees safe/unsafe transitions (only
// transitions), sees a frame when the pane app changes even while safety does
// not, and a submitted newline forces unsafe for the full grace before
// re-arming — the transition that also re-arms the browser's own newline-disarm.
func TestPumpPredictGate(t *testing.T) {
	var safe atomic.Bool
	var app atomic.Value
	app.Store("zsh")
	cfg := testCfg()
	cfg.predict = predictV4
	cfg.paneState = func(context.Context) paneSnapshot {
		return testPane(safe.Load(), app.Load().(string), 38)
	}
	conn, _, done := startPump(t, cfg)

	// Every frame carries the verdict, all pane bounds, and the app.
	if pane := readPredictFrame(t, conn, predictV4); pane.Safe || pane.Top != 0 || pane.Bottom != 38 || pane.Left != 0 || pane.Right != 106 || pane.App != "zsh" {
		t.Fatalf("initial gate frame = %+v, want unsafe full-pane zsh", pane)
	}
	safe.Store(true)
	if pane := readPredictFrame(t, conn, predictV4); !pane.Safe || pane.Bottom != 38 || pane.Right != 106 || pane.App != "zsh" {
		t.Fatalf("gate frame after pane became safe = %+v, want safe full-pane zsh", pane)
	}

	// The foreground app changes while safety does not: still a frame, so the
	// browser can swap its per-app prediction facts the moment the pane's
	// application does.
	app.Store("claude")
	if pane := readPredictFrame(t, conn, predictV4); !pane.Safe || pane.Bottom != 38 || pane.Right != 106 || pane.App != "claude" {
		t.Fatalf("gate frame after app change = %+v, want safe full-pane claude", pane)
	}

	// Enter: unsafe within a poll, re-armed no sooner than the submit grace.
	before := time.Now()
	conn.in <- []byte{frameData, '\r'}
	if pane := readPredictFrame(t, conn, predictV4); pane.Safe {
		t.Fatalf("gate frame after newline = %+v, want unsafe", pane)
	}
	if pane := readPredictFrame(t, conn, predictV4); !pane.Safe {
		t.Fatalf("gate frame after grace = %+v, want safe (re-arm)", pane)
	}
	if since := time.Since(before); since < predictSubmitGrace {
		t.Fatalf("gate re-armed %v after newline, before the %v grace", since, predictSubmitGrace)
	}

	close(conn.in)
	waitDone(t, done, 2*time.Second)
}

// TestPumpPredictGateNewlineAfterIdle pins sparse polling while the browser is already
// unsafe. Enter forces a fresh observation, and safe may return only after the submit grace.
func TestPumpPredictGateNewlineAfterIdle(t *testing.T) {
	var polls atomic.Int64
	var safe atomic.Bool
	cfg := testCfg()
	cfg.predict = predictV4
	cfg.paneState = func(context.Context) paneSnapshot {
		polls.Add(1)
		return testPane(safe.Load(), "zsh", 38)
	}
	start := time.Now()
	conn, _, done := startPump(t, cfg)

	if pane := readPredictFrame(t, conn, predictV4); pane.Safe {
		t.Fatalf("initial gate frame = %+v, want unsafe zsh", pane)
	}
	time.Sleep(4500*time.Millisecond - time.Since(start))
	silent := polls.Load()

	before := time.Now()
	safe.Store(true)
	conn.in <- []byte{frameData, '\r'}
	if pane := readPredictFrame(t, conn, predictV4); !pane.Safe {
		t.Fatalf("gate frame after grace = %+v, want safe (re-arm)", pane)
	}
	if since := time.Since(before); since < predictSubmitGrace {
		t.Fatalf("gate re-armed %v after idle newline, before the %v grace", since, predictSubmitGrace)
	}

	// And the silence itself cost next to nothing. Neither side wrote a byte, so
	// the pane cannot have changed: the poll that reported the initial state, the
	// one that confirmed it settled, and one safety look per second after that. A
	// flat cadence would have spent sixty.
	if silent > 10 {
		t.Fatalf("gate ran paneState %d times across 4.5s of silence, want a handful", silent)
	}

	close(conn.in)
	waitDone(t, done, 2*time.Second)
}

// TestPumpPredictGateSafeLeaseNeverSkips is the strict stale-lease regression. A safe
// pane is observed on every tick, so a silent safe-to-unsafe transition cannot hide in
// the sparse cadence reserved for panes the browser already knows are unsafe.
func TestPumpPredictGateSafeLeaseNeverSkips(t *testing.T) {
	var safe atomic.Bool
	safe.Store(true)
	var polls atomic.Int64
	polled := make(chan struct{}, 8)
	cfg := testCfg()
	cfg.predict = predictV4
	cfg.paneState = func(context.Context) paneSnapshot {
		polls.Add(1)
		isSafe := safe.Load()
		select {
		case polled <- struct{}{}:
		default:
		}
		return testPane(isSafe, "zsh", 38)
	}
	conn, _, done := startPump(t, cfg)

	if pane := readPredictFrame(t, conn, predictV4); !pane.Safe {
		t.Fatalf("initial gate frame = %+v, want safe", pane)
	}
	<-polled // initial observation
	<-polled // unchanged observation marks the pane settled
	before := polls.Load()
	safe.Store(false) // silent transition, after the settled observation
	// Leave scheduler slack, but less than two polls, then prove the refusal came from
	// a fresh pane observation rather than an uncorroborated idle revocation.
	onePollDeadline := predictPoll + 50*time.Millisecond
	select {
	case frame := <-conn.out:
		if len(frame) < 2 || frame[0] != framePredictV4 || frame[1] != 0 {
			t.Fatalf("gate frame after a silent flip = %v, want v4 unsafe", frame)
		}
	case <-time.After(onePollDeadline):
		t.Fatalf("safe lease survived one %v poll plus scheduler delivery", predictPoll)
	}
	if looked := polls.Load() - before; looked == 0 {
		t.Fatal("gate revoked safe without observing the pane")
	}

	close(conn.in)
	waitDone(t, done, 2*time.Second)
}

// While idle and unsafe, sparse observations still carry application changes so the
// browser has the right model ready when activity returns.
func TestPumpPredictGateIdleStillLooks(t *testing.T) {
	var app atomic.Value
	app.Store("zsh")
	cfg := testCfg()
	cfg.predict = predictV4
	cfg.paneState = func(context.Context) paneSnapshot {
		return testPane(false, app.Load().(string), 38)
	}
	conn, _, done := startPump(t, cfg)
	if pane := readPredictFrame(t, conn, predictV4); pane.Safe {
		t.Fatalf("initial gate frame = %+v, want unsafe", pane)
	}
	app.Store("claude")
	if pane := readPredictFrame(t, conn, predictV4); pane.Safe || pane.App != "claude" {
		t.Fatalf("idle app frame = %+v, want unsafe claude", pane)
	}
	close(conn.in)
	waitDone(t, done, 2*time.Second)
}

// TestPumpPredictGateUnreadablePane pins the explicit Readable contract. paneState
// reports false on every failure (no tmux, malformed output, the 500ms read timing
// out), and that is "no information", not "the app changed to nothing". The
// browser has no unknown case: an empty name reads as a real app change, so it
// would hand off to nothing and hand back again, and the second handoff lands
// exactly as the user resumes typing, which is the latency this feature exists to
// hide. So the last known name carries forward, and an unreadable pane may move
// only the safety byte, which already fails closed.
func TestPumpPredictGateUnreadablePane(t *testing.T) {
	var unreadable atomic.Bool
	cfg := testCfg()
	cfg.predict = predictV4
	cfg.paneState = func(context.Context) paneSnapshot {
		if unreadable.Load() {
			return paneSnapshot{} // every paneState error path, verbatim
		}
		return testPane(true, "claude", 38)
	}
	conn, _, done := startPump(t, cfg)

	if pane := readPredictFrame(t, conn, predictV4); !pane.Safe || pane.Bottom != 38 || pane.Right != 106 || pane.App != "claude" {
		t.Fatalf("initial gate frame = %+v, want safe full-pane claude", pane)
	}

	// The pane goes unreadable. The safety flip must still be delivered — that is
	// the half that protects a secret — but it must carry the app and geometry the
	// browser is already set up for, not an empty name and a zero.
	unreadable.Store(true)
	if pane := readPredictFrame(t, conn, predictV4); pane.Safe || pane.Bottom != 38 || pane.Right != 106 || pane.App != "claude" {
		t.Fatalf("gate frame for an unreadable pane = %+v, want unsafe full-pane claude", pane)
	}

	// It stays unreadable for several more polls. Nothing has changed, so nothing
	// may be sent: each spurious frame here is a heavy handoff the user pays for.
	quiet := time.After(4 * predictPoll)
	for settled := false; !settled; {
		select {
		case f := <-conn.out:
			if len(f) > 0 && (f[0] == framePredictV1 || f[0] == framePredictV4) {
				t.Fatalf("gate frame %v while the pane stayed unreadable and nothing changed", f)
			}
		case <-quiet:
			settled = true
		}
	}

	// Readable again: one frame back to safe, still the same app throughout, so
	// the round trip cost the browser no handoff at all.
	unreadable.Store(false)
	if pane := readPredictFrame(t, conn, predictV4); !pane.Safe || pane.Bottom != 38 || pane.Right != 106 || pane.App != "claude" {
		t.Fatalf("gate frame after the pane became readable = %+v, want safe full-pane claude", pane)
	}

	close(conn.in)
	waitDone(t, done, 2*time.Second)
}

// TestPumpVetoedGateSendsOneUnsafeFrame pins ENVHAVEN_SKIP_WELCOME on an echo socket.
// The console no longer renders the session the gate watches, so no pane may be read
// or vouched for, yet the browser admits input only after a gate frame. The socket
// gets exactly one unsafe frame in its negotiated version, and input flows after it.
func TestPumpVetoedGateSendsOneUnsafeFrame(t *testing.T) {
	for _, tc := range []struct {
		name     string
		protocol predictProtocol
	}{{"v1", predictV1}, {"v4", predictV4}} {
		t.Run(tc.name, func(t *testing.T) {
			var polls atomic.Int64
			cfg := testCfg()
			cfg.predict = tc.protocol
			cfg.gateVetoed = true
			cfg.paneState = func(context.Context) paneSnapshot {
				polls.Add(1)
				return testPane(true, "zsh", 38)
			}
			conn, tts, done := startPump(t, cfg)

			if pane := readPredictFrame(t, conn, tc.protocol); pane.Safe || pane.App != "" || pane.Bottom != 0 {
				t.Fatalf("vetoed gate frame = %+v, want unsafe with no pane in it", pane)
			}
			conn.in <- append([]byte{frameData}, "ok"...)
			if got := string(readPts(t, tts, 2)); got != "ok" {
				t.Fatalf("shell received %q after the vetoed frame, want %q", got, "ok")
			}
			quiet := time.After(4 * predictPoll)
			for settled := false; !settled; {
				select {
				case f := <-conn.out:
					if len(f) > 0 && (f[0] == framePredictV1 || f[0] == framePredictV4) {
						t.Fatalf("second predict frame %v on a vetoed gate", f)
					}
				case <-quiet:
					settled = true
				}
			}
			if n := polls.Load(); n != 0 {
				t.Fatalf("vetoed gate read the pane %d times, want never", n)
			}

			close(conn.in)
			waitDone(t, done, 2*time.Second)
		})
	}
}

// TestPumpNoPredictFrames: a session that did not opt in must never see a predictive
// frame, even with a safe pane (the managed dashboard client relies on this).
func TestPumpNoPredictFrames(t *testing.T) {
	cfg := testCfg()
	cfg.paneState = func(context.Context) paneSnapshot {
		return testPane(true, "zsh", 38)
	}
	conn, tts, done := startPump(t, cfg)

	if _, err := tts.Write([]byte("ok")); err != nil {
		t.Fatalf("shell write: %v", err)
	}
	readData(t, conn, 2)
	time.Sleep(3 * predictPoll) // a few polls' worth of opportunity
	for {
		select {
		case f := <-conn.out:
			if len(f) > 0 && (f[0] == framePredictV1 || f[0] == framePredictV4) {
				t.Fatal("predict frame sent on a session that did not opt in")
			}
		default:
			close(conn.in)
			waitDone(t, done, 2*time.Second)
			return
		}
	}
}

// TestGateSessionFor pins the mode->gate-session mapping (pump.go): ordinary managed
// watches the base envhaven session, a managed probe gets its own grouped view, and
// self-host watches its grouped console-view.
func TestGateSessionFor(t *testing.T) {
	if s, env := gateSessionFor(true, ""); s != tmuxSession || len(env) != 0 {
		t.Errorf("gateSessionFor(true, empty) = (%q, %v), want (%q, [])", s, env, tmuxSession)
	}
	probe := "ehtest-ab-mmmmmmmm-0123456789ab"
	s, env := gateSessionFor(true, probe)
	wantProbeEnv := []string{
		"ENVHAVEN_CONSOLE_SESSION=" + probe,
		"_ENVHAVEN_CONSOLE_STATUS=off",
		"_ENVHAVEN_CONSOLE_DESTROY_UNATTACHED=off",
	}
	if s != probe || !slices.Equal(env, wantProbeEnv) {
		t.Errorf("gateSessionFor(true, probe) = (%q, %v), want (%q, %v)", s, env, probe, wantProbeEnv)
	}
	s, env = gateSessionFor(false, "")
	wantEnv := "ENVHAVEN_CONSOLE_SESSION=" + selfhostGateSession
	if s != selfhostGateSession || len(env) != 1 || env[0] != wantEnv {
		t.Errorf("gateSessionFor(false, empty) = (%q, %v), want (%q, [%q])", s, env, selfhostGateSession, wantEnv)
	}
}

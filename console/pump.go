package main

// The session pump: everything between an authorized WebSocket and the login
// shell's pty. serveConsole (main.go) authorizes and upgrades; pumpSession owns
// the shell process; pump bridges the two with the wire protocol below and
// enforces the idle and lifetime limits. pump takes its collaborators through
// pumpConfig so the wire protocol is testable without a shell or a socket.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
)

const (
	idleTimeout = 10 * time.Minute
	hardMaxLife = 12 * time.Hour

	// Wire protocol frame types (first byte of every binary frame).
	frameData    = 0x00 // terminal bytes, both directions
	frameResize  = 0x01 // resize request, browser to server only
	framePredict = 0x02 // predictive-echo safety gate, server to browser only:
	// [safe byte (1=safe 0=unsafe), pane app name (valid UTF-8, at most
	// maxAppName bytes, may be empty)]. Sent whenever either part changes, so the
	// browser always knows both whether it may draw and WHICH application it
	// would be drawing into.

	// maxAppName bounds the name in a 0x02 frame so a hostile argv[0] cannot
	// bloat a frame the browser reads on every poll. The bound is declared with the
	// frame it protects and enforced where the name is produced (gate.go's clampApp),
	// so there is one clamp rather than two disagreeing ones. Production has exactly
	// one producer; a test injecting its own paneState is trusted to behave.
	maxAppName = 32

	// predictPoll is how often the gate re-inspects the active pane. It must beat
	// human reaction to a freshly-drawn password prompt (hundreds of ms) with
	// room for one network round trip, so a secret prompt is signalled unsafe
	// before the first key of the secret is typed.
	predictPoll = 75 * time.Millisecond

	// predictSubmitGrace withholds "safe" for this long after any newline in the
	// input. A password prompt appears only in response to a submitted command, so
	// the grace spans the gap between the Enter and the app flipping its tty to
	// no-echo: the gate cannot re-arm inside that gap, so a password typed ahead in
	// the same burst as its command is never predicted. It also forces a real
	// safe->unsafe->safe transition on every newline, which is what re-arms the
	// browser after its own newline-disarm. Note the browser must not treat just any
	// "safe" frame as that re-arm: the feed also emits one when only the pane's app
	// name changed, which can land mid-submit. The browser waits for the explicit
	// "unsafe" this grace guarantees (see localDisarm in terminal.html).
	predictSubmitGrace = 200 * time.Millisecond
)

// wireConn is the slice of *websocket.Conn the pump uses; tests substitute an
// in-memory implementation to exercise the wire protocol without a socket.
type wireConn interface {
	Read(ctx context.Context) (websocket.MessageType, []byte, error)
	Write(ctx context.Context, typ websocket.MessageType, p []byte) error
}

// pumpConfig carries the pump's collaborators and limits. pumpSession wires the
// production values; tests inject a fake pane gate and short timeouts.
type pumpConfig struct {
	predict   bool
	paneState func(context.Context) (safe bool, app string)
	idle      time.Duration
	maxLife   time.Duration
}

// pumpSession starts the login shell on a pty and hands it to pump. managed is
// the mode marker newHandler read ONCE at startup (main.go), threaded here so
// the gate session can never fork from the mode switch. On idle timeout or the
// hard maximum lifetime, the socket closes cleanly and the browser shows its
// manual reconnect button.
func pumpSession(parent context.Context, conn *websocket.Conn, size *pty.Winsize, managed, predict bool) error {
	// The shell inherits the abc user from s6-setuidgid; we never set uid/gid
	// here. `-l` makes it a login shell so it auto-attaches the tmux session,
	// at parity with SSH and the IDE terminal.
	// Plain xterm-256color (full alternate-screen, parity with SSH and the IDE
	// terminal); predictive echo draws a client-side overlay and needs no
	// custom terminfo.
	cmd := exec.Command("zsh", "-l")
	// gateSessionFor keeps the predict gate on the exact session the console
	// renders (base envhaven for managed, the grouped console-view for self-host).
	gateSession, extraEnv := gateSessionFor(managed)
	env := append(os.Environ(), "TERM=xterm-256color")
	env = append(env, extraEnv...)
	cmd.Env = env
	ptmx, err := pty.StartWithSize(cmd, size)
	if err != nil {
		return err
	}
	// Reap the shell on every exit path: close the pty (SIGHUP), kill as a
	// backstop (harmless if already gone), then Wait to collect the exit status.
	// Without the Wait, every session leaks an unreaped zombie because this
	// process is the shell's reaping parent (it is not PID 1 under s6).
	defer func() {
		_ = ptmx.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()
	return pump(parent, conn, ptmx, pumpConfig{
		predict:   predict,
		paneState: func(c context.Context) (bool, string) { return paneState(c, gateSession) },
		idle:      idleTimeout,
		maxLife:   hardMaxLife,
	})
}

// gateSessionFor returns the tmux session the predict gate must watch, plus any
// extra environment the login shell needs. The managed console attaches the base
// `envhaven` session, where tmux.conf leaves the status bar off (the dashboard
// Cockpit renders windows instead). The self-host console has no such UI, so it
// shows the bar via its OWN grouped session (selfhostGateSession); welcome.sh
// reads ENVHAVEN_CONSOLE_SESSION to build it. Either way the gate watches the
// exact session the console renders, so the two can never diverge.
func gateSessionFor(managed bool) (session string, extraEnv []string) {
	if managed {
		return tmuxSession, nil
	}
	return selfhostGateSession, []string{"ENVHAVEN_CONSOLE_SESSION=" + selfhostGateSession}
}

// pump bridges the pty and the WebSocket using the 0x00/0x01 wire protocol
// (plus the 0x02 predict gate when the session opted in). It returns nil on
// every ordinary end of session: idle timeout, lifetime cap, pty EOF, or a
// normal close from the browser.
func pump(parent context.Context, conn wireConn, ptmx *os.File, cfg pumpConfig) error {
	ctx, cancel := context.WithTimeout(parent, cfg.maxLife)
	defer cancel()

	// lastActivity (nanos since pump start, on the monotonic clock so an NTP
	// step or VM resume cannot mis-measure idleness) is stamped by both pumps
	// and read by the idle check; an atomic timestamp instead of a signal
	// channel keeps the timer logic to a single fire-check-reset site.
	start := time.Now()
	var lastActivity atomic.Int64
	touch := func() { lastActivity.Store(int64(time.Since(start))) }

	errc := make(chan error, 3)

	// armAfter (unix nanos) holds the wall-clock time before which the predict gate
	// must report unsafe, set on every newline in the input to enforce the submit
	// grace. Written by the input pump, read by the gate; atomic keeps them honest.
	var armAfter atomic.Int64

	// coder/websocket forbids concurrent Write; the pty read pump and the predict
	// gate both write frames, so serialize every write behind one mutex.
	var writeMu sync.Mutex
	writeFrame := func(f []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.Write(ctx, websocket.MessageBinary, f)
	}

	// pty -> browser: every chunk becomes one 0x00 frame.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				errc <- fmt.Errorf("pty read pump panic: %v", r)
			}
		}()
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				touch()
				if werr := writeFrame(append([]byte{frameData}, buf[:n]...)); werr != nil {
					errc <- werr
					return
				}
			}
			if err != nil {
				errc <- err
				return
			}
		}
	}()

	// Predictive-echo safety gate, started only for opted-in sessions: poll the
	// active pane and tell the browser the instant it becomes (un)safe to draw a
	// typed character (a secret prompt, a running command, a remote/nested
	// session, copy-mode). Only transitions are sent. This does NOT touch the
	// idle timer: the gate must not, by itself, keep an otherwise-idle session
	// alive.
	gate := func() {
		defer func() {
			if r := recover(); r != nil {
				errc <- fmt.Errorf("predict gate panic: %v", r)
			}
		}()
		tick := time.NewTicker(predictPoll)
		defer tick.Stop()
		lastSafe := int8(-1) // sentinel: force the first frame so the browser learns the initial state
		lastApp := ""
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				safe, app := cfg.paneState(ctx)
				if app == "" {
					// No information (no tmux, malformed output, the read timed
					// out), not "the app changed to nothing". The browser has no
					// unknown case: it would take the empty name as a real app
					// change and pay a heavy handoff out and another back, the
					// second landing exactly as the user resumes typing. Carry the
					// last known name so an unreadable pane can only flip SAFETY,
					// which already fails closed.
					app = lastApp
				}
				cur := int8(0)
				if safe && time.Now().UnixNano() >= armAfter.Load() {
					cur = 1
				}
				if cur != lastSafe || app != lastApp {
					lastSafe, lastApp = cur, app
					if werr := writeFrame(append([]byte{framePredict, byte(cur)}, app...)); werr != nil {
						errc <- werr
						return
					}
				}
			}
		}
	}
	if cfg.predict {
		go gate()
	}

	// browser -> pty: 0x00 frames are terminal input, 0x01 frames are resizes.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				errc <- fmt.Errorf("input pump panic: %v", r)
			}
		}()
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				errc <- err
				return
			}
			if typ != websocket.MessageBinary || len(data) == 0 {
				continue
			}
			touch()
			switch data[0] {
			case frameData:
				// A newline submits a line; hold the predict gate unsafe for the
				// grace so a password typed right after its command cannot re-arm.
				if cfg.predict && (bytes.IndexByte(data[1:], '\r') >= 0 || bytes.IndexByte(data[1:], '\n') >= 0) {
					armAfter.Store(time.Now().Add(predictSubmitGrace).UnixNano())
				}
				if _, werr := ptmx.Write(data[1:]); werr != nil {
					errc <- werr
					return
				}
			case frameResize:
				var sz struct {
					Cols uint16 `json:"cols"`
					Rows uint16 `json:"rows"`
				}
				if json.Unmarshal(data[1:], &sz) == nil {
					_ = pty.Setsize(ptmx, &pty.Winsize{Rows: sz.Rows, Cols: sz.Cols})
				}
			}
		}
	}()

	idle := time.NewTimer(cfg.idle)
	defer idle.Stop()
	for {
		select {
		case <-ctx.Done():
			// Hard-max lifetime reached (or parent shutdown). Clean close.
			return nil
		case <-idle.C:
			// The timer has fired, so Reset here is correct under both the pre-
			// and post-Go-1.23 timer semantics. Never reintroduce the classic
			// `if !idle.Stop() { <-idle.C }` drain: with go >= 1.23 in go.mod
			// that receive blocks forever when Stop races a fire, hanging the
			// session and leaking the shell.
			if d := cfg.idle - (time.Since(start) - time.Duration(lastActivity.Load())); d > 0 {
				idle.Reset(d)
				continue
			}
			// No traffic either direction for cfg.idle. Clean close.
			return nil
		case err := <-errc:
			// A normal close or pty EOF is an expected end of session.
			if isCleanEnd(err) {
				return nil
			}
			return err
		}
	}
}

// isCleanEnd reports whether err marks an ordinary end of session (pty EOF,
// context cancellation, or a normal/going-away WebSocket close) rather than a
// real error.
func isCleanEnd(err error) bool {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	switch websocket.CloseStatus(err) {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway:
		return true
	}
	return false
}

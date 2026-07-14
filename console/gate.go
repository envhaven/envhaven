package main

// Predictive-echo safety gate. The browser draws each typed character instantly,
// before the server echoes it, to hide network latency. That optimism must never
// paint a secret: a password, an SSH/GPG passphrase, a PIN. This file is the whole
// security boundary for that feature. It watches the pane the console actually
// renders and reports whether drawing a keystroke there is safe; the browser only
// predicts while this says yes, and starts and fails closed.
//
// The console renders whatever pane is active in the shared login tmux session, so
// the authoritative terminal mode lives on that inner pane's pts, not on the
// console's own (always-raw) outer pty. We read it directly.

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// tmuxSession is the shared login session every client (console, SSH, IDE)
// attaches; it must match runtime/scripts/envhaven-welcome.sh. Clients of one
// session share its active window, so this pane is exactly what the console shows.
const tmuxSession = "envhaven"

// selfhostGateSession is the self-host console's own grouped view of that
// session (pump.go exports it as ENVHAVEN_CONSOLE_SESSION and gates on it).
// envhaven-welcome.sh keys off this EXACT value to build the grouped session,
// so the value is frozen alongside tmuxSession.
const selfhostGateSession = "console-view"

// secretReaders is one coherent set: foreground commands whose keystroke echo we
// cannot vouch for, because the character is either deliberately hidden or handled
// on the far side of something we cannot see into. The ICANON test in isRawPane
// already catches every classic canonical no-echo prompt (sudo, su, ssh-keygen,
// getpass, read -s, passwd); this closes the two holes ICANON cannot see:
//
//   - raw-mode masked fields: pinentry is empirically -icanon -echo, byte-for-byte
//     indistinguishable from a normal editor by termios alone.
//   - can't-see-the-far-side sessions: a remote host (ssh), a container (docker), a
//     serial line (picocom), or a nested multiplexer (tmux inside tmux) keeps OUR
//     pane raw while the real prompt runs on an inner pts we never inspect.
//
// Matched against the bare command name tmux reports in pane_current_command; the
// console's own pane never reports these (it reports zsh, claude, vim, ...), so a
// normal session is unaffected — only these explicit forwarders block.
var secretReaders = map[string]bool{
	// raw-mode PIN / passphrase entry
	"pinentry": true, "pinentry-curses": true, "pinentry-tty": true,
	"pinentry-gtk-2": true, "pinentry-gnome3": true, "pinentry-qt": true, "pinentry-fltk": true,
	"gpg": true, "gpg2": true, "ssh-add": true, "ssh-keygen": true,
	// remote sessions
	"ssh": true, "sshpass": true, "slogin": true, "autossh": true,
	"mosh-client": true, "telnet": true, "et": true,
	// container / VM sessions
	"docker": true, "podman": true, "kubectl": true, "oc": true, "nerdctl": true,
	"lxc": true, "incus": true,
	// nested multiplexers and pty wrappers (their inner pts is invisible to us)
	"tmux": true, "screen": true, "zellij": true, "byobu": true,
	"dtach": true, "abduco": true, "script": true, "expect": true, "unbuffer": true,
	// raw network / serial forwarders
	"nc": true, "ncat": true, "socat": true, "minicom": true, "picocom": true, "cu": true, "kermit": true,
	// canonical prompts (already ICANON-blocked; listed as defense in depth)
	"su": true, "sudo": true, "doas": true, "passwd": true, "login": true,
}

// paneSafe reports whether the active pane of the login tmux session is a safe
// place to draw predicted keystrokes. It fails closed: any error (no tmux, no
// session, a dead pane, copy-mode, an unreadable tty, a secret reader in the
// foreground, or a canonical-mode prompt) yields false.
func paneSafe(ctx context.Context, session string) bool {
	c, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	// One field string, '|'-separated (no field can contain '|'): pts path,
	// foreground command name, in-copy-mode flag, dead flag. The session is the one
	// THIS console renders: base `envhaven` for the managed console, or the
	// self-host console's own grouped view (which has its own current window). The
	// safety logic below is identical regardless of which session we read.
	out, err := exec.CommandContext(c, "tmux", "display-message", "-p", "-t", session,
		"#{pane_tty}|#{pane_current_command}|#{pane_in_mode}|#{pane_dead}").Output()
	if err != nil {
		return false
	}
	f := strings.Split(strings.TrimSpace(string(out)), "|")
	if len(f) != 4 {
		return false
	}
	tty, cmd, inMode, dead := f[0], strings.ToLower(f[1]), f[2], f[3]
	if tty == "" || inMode == "1" || dead == "1" || secretReaders[cmd] {
		return false
	}
	return isRawPane(tty)
}

// isRawPane reports whether the pts is in non-canonical (raw) mode, the mode a
// self-echoing line editor or full-screen app uses (zsh's zle, vim, Claude Code).
// Canonical mode means either the kernel echoes for us — no need to predict — or a
// classic hidden password prompt — must not predict; either way we do not draw.
// The device is opened O_RDONLY|O_NOCTTY|O_NONBLOCK and only TCGETS'd, so it never
// steals input from the pane nor becomes our controlling terminal.
func isRawPane(tty string) bool {
	f, err := os.OpenFile(tty, os.O_RDONLY|syscall.O_NOCTTY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return false
	}
	defer f.Close()
	t, err := unix.IoctlGetTermios(int(f.Fd()), unix.TCGETS)
	if err != nil {
		return false
	}
	return t.Lflag&unix.ICANON == 0
}

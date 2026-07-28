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
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"strconv"
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

// paneState reports whether the active pane of the login tmux session is a safe
// place to draw predicted keystrokes, plus the name of the application running
// there (lowercased, e.g. "zsh", "claude"; empty when unreadable) — the pane's
// foreground command, or what that command was told to run when it is only a
// language runtime (see runtimeWrappers). Safety fails
// closed: any error (no tmux, no session, a dead pane, copy-mode, an unreadable
// tty, a secret reader in the foreground, or a canonical-mode prompt) yields
// false. The command name rides the same gate frame so the browser can scope
// per-application prediction facts (a line editor's wrap style) to the app that
// exhibited them — zsh and Claude Code wrap differently, and a style learned in
// one must never be applied to the other.
func paneState(ctx context.Context, session string) (bool, string) {
	c, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	// One field string, '|'-separated: pts path, foreground command name,
	// in-copy-mode flag, dead flag, the pane process's pid. A name may itself
	// contain '|' (tmux passes argv[0] through), which yields more than five
	// fields and is refused below: the safe direction, and unspoofable, since the
	// count is 5 plus the number of pipes. The session is the one
	// THIS console renders: base `envhaven` for the managed console, or the
	// self-host console's own grouped view (which has its own current window). The
	// safety logic below is identical regardless of which session we read.
	out, err := exec.CommandContext(c, "tmux", "display-message", "-p", "-t", session,
		"#{pane_tty}|#{pane_current_command}|#{pane_in_mode}|#{pane_dead}|#{pane_pid}").Output()
	if err != nil {
		return false, ""
	}
	f := strings.Split(strings.TrimSpace(string(out)), "|")
	if len(f) != 5 {
		return false, ""
	}
	tty, cmd, inMode, dead, panePID := f[0], strings.ToLower(f[1]), f[2], f[3], f[4]
	// A name outside the alphabet is one we decline to reason about, and declining has
	// to include declining to LABEL with it. The browser keys per-application
	// prediction facts by this string, so handing back a name we just rejected would
	// let a process pick its own argv[0] and earn a cache entry, and a heavy handoff,
	// for every invisible-character spelling of a real application's name. Empty is the
	// sentinel every other error path here already returns.
	if !plainName(cmd) {
		return false, ""
	}
	// The name a runtime was told to run, when tmux reported the runtime itself. LABEL
	// only, and resolved before the verdict below so a codex pane keeps reporting
	// `codex` through copy-mode instead of flipping to `node` and back. The browser
	// drops everything it has learned about an application when that label changes, and
	// copy-mode is entered and left constantly, so each scroll cost two full relearns.
	app := cmd
	if runtimeWrappers[cmd] {
		if inner := wrappedApp(panePID); inner != "" {
			app = inner
		}
	}
	// One refusal, and secretReaders is asked about BOTH names. The name tmux gave us,
	// so `sudo cat` keeps blocking on sudo rather than resolving past it to cat. And the
	// name that resolved to, so an npm-shimmed ssh blocks too. Resolving above can
	// therefore only ever ADD a disjunct here, which is exactly what makes it safe to
	// run before the verdict rather than after it: the answer is unchanged on every
	// input, and you can see that without holding the two branches in your head.
	if tty == "" || inMode == "1" || dead == "1" || secretReaders[cmd] || secretReaders[app] {
		return false, clampApp(app)
	}
	return isRawPane(tty), clampApp(app)
}

// runtimeWrappers are command names that name a language runtime rather than an
// application. An npm-installed CLI is often a shim that STAYS RUNNING as the
// parent of the real binary, and tmux reports the parent, so a pane running the
// tool reports the runtime. Measured on codex 0.145.0: `node .../bin/codex`
// holds the pane while the Rust binary runs as its child, and
// pane_current_command is "node" for the whole session — which is every codex
// session, so the browser could never scope anything to codex at all.
//
// This is the MEASURED set, not the plausible one. Every entry renames panes
// that are running something perfectly identifiable already: adding "python3"
// turned `python3 /tmp/composer.py` from "python3" into "composer.py", which is
// arguably more precise and is certainly a different name than everything
// downstream was written against. An entry earns its place by a pane observed
// reporting a runtime while a real application ran in it — bun, deno, python and
// ruby are all capable of it and none of them was caught doing it here. Add one
// when a pane is seen doing it, with the observation in the commit.
var runtimeWrappers = map[string]bool{
	"node": true,
}

// wrappedApp reports what the tty's foreground runtime was told to run: the
// basename of its first non-flag argument, so `node /opt/envhaven/bin/codex`
// is "codex". Empty whenever that cannot be established — an interactive
// runtime with no script, an unreadable /proc entry, a name that is not a plain
// command name — and the caller then keeps the runtime's own name.
// The pid comes from tmux, and it is about to be spliced into a /proc path, so
// it is checked for what it claims to be rather than trusted to be it.
func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func wrappedApp(panePID string) string {
	if !isDigits(panePID) {
		return ""
	}
	// The foreground process group leader IS the process tmux named, so its argv
	// answers the question. tcgetpgrp cannot ask: the ioctl is only valid on the
	// caller's OWN controlling terminal and returns ENOTTY on any other pts
	// (measured). The pane process's tpgid is the same number, and reading it
	// touches nothing.
	b, err := os.ReadFile("/proc/" + panePID + "/stat")
	if err != nil {
		return ""
	}
	tpgid := statTPGID(string(b))
	if tpgid <= 0 {
		return ""
	}
	// Bounded. This runs on every gate poll, and /proc/<pid>/cmdline hands back the
	// whole argument area, which the kernel lets grow into the megabytes. wrappedName
	// stops at the first argument carrying a path, so a few kilobytes is already far
	// more than the answer can need.
	fh, err := os.Open("/proc/" + strconv.Itoa(tpgid) + "/cmdline")
	if err != nil {
		return ""
	}
	defer fh.Close()
	var buf [4096]byte
	n, err := io.ReadFull(fh, buf[:])
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return ""
	}
	// A cut argument is worse than a missing one, because half a path still yields a
	// plausible basename. argv is NUL-separated, so on a full buffer anything past the
	// last NUL is a fragment and goes.
	if n == len(buf) {
		if i := bytes.LastIndexByte(buf[:n], 0); i >= 0 {
			n = i + 1
		} else {
			n = 0
		}
	}
	return wrappedName(string(buf[:n]))
}

// statTPGID pulls the foreground process group out of /proc/<pid>/stat, whose
// fields run: pid (comm) state ppid pgrp session tty_nr tpgid ... comm is the
// only one that can hold spaces or parentheses and it is the only parenthesised
// one, so everything after the LAST ')' splits on whitespace cleanly. Zero on
// anything unexpected, which the caller reads as "cannot tell".
func statTPGID(stat string) int {
	i := strings.LastIndexByte(stat, ')')
	if i < 0 {
		return 0
	}
	f := strings.Fields(stat[i+1:])
	if len(f) < 6 {
		return 0
	}
	n, err := strconv.Atoi(f[5])
	if err != nil {
		return 0
	}
	return n
}

// wrappedName picks the application out of a runtime's argv: the basename of the
// first argument that names a FILE, lowercased. /proc/<pid>/cmdline is the raw
// NUL-separated argv.
//
// "Names a file" means it carries a path separator, which is what separates the
// script a runtime was handed from a word it was given: `bun run dev` is not an
// application called "run", and `python3 -m http.server` is not one called
// "http.server". A launcher shim always passes an absolute path (measured:
// `node /mise/installs/node/22/bin/codex`), so the rule keeps every real case
// and drops the guesses. Anything left that is not a plain command name is
// refused outright rather than trimmed into one.
func wrappedName(cmdline string) string {
	argv := strings.Split(cmdline, "\x00")
	for _, a := range argv[1:] {
		if a == "" || strings.HasPrefix(a, "-") {
			continue // runtime flags: `node --enable-source-maps script`
		}
		slash := strings.LastIndexByte(a, '/')
		if slash < 0 {
			return "" // a word, not a script: nothing here names an application
		}
		name := strings.ToLower(a[slash+1:])
		if !plainName(name) {
			return ""
		}
		return name
	}
	return ""
}

// plainName reports whether the name looks like a command name we can reason
// about. tmux hands us argv[0] verbatim apart from a leading '-' or spaces, so a
// process is free to call itself "\tssh" or "​ssh": the secretReaders lookup
// then MISSES, and the pane falls through to isRawPane — which an ssh session
// passes, because ssh puts the tty in raw mode. That combination reports a live
// ssh session as a safe place to draw, and the next thing typed into it may be a
// passphrase. (Measured against tmux 3.4: `exec -a $'\tssh' ssh host` yields
// pane_current_command "\tssh".) Refusing the name outright is the fix rather
// than guessing what was meant: an unrecognisable name is one we decline to
// predict in, and the whole set of real names — zsh, node, python3, claude,
// opencode — is spelled from this alphabet. cmd is already lowercased.
func plainName(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
			c == '.' || c == '_' || c == '-' || c == '+' {
			continue
		}
		return false
	}
	return true
}

// clampApp bounds the pane's command name for the gate frame. A hostile argv[0]
// must not bloat the wire, and a byte-sliced name must not leave a split rune
// behind: the frame declares UTF-8. Applied only to the value that LEAVES
// paneState, never to the name the secretReaders decision is taken on — a wire
// size has no business shortening a name the security lookup is about to miss on.
// The scrub is what makes the truncation safe. What reaches here is already valid:
// paneState lowercases the name first, and strings.ToLower maps every invalid byte
// to U+FFFD. But that replacement is three bytes wide, so an argv[0] of invalid
// bytes expands past the bound and the cut can land inside a U+FFFD — which is
// exactly the split rune the frame's UTF-8 contract forbids. ToValidUTF8 returns an
// already-valid string unchanged, so the ordinary "zsh" case costs one scan.
func clampApp(cmd string) string {
	if len(cmd) > maxAppName {
		cmd = cmd[:maxAppName]
	}
	return strings.ToValidUTF8(cmd, "")
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

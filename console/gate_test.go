package main

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// TestIsRawPane pins the one general-case predicate deciding whether a
// keystroke may be painted while the pane might be reading a secret. The
// secretReaders map only backstops known commands; for read -s, getpass, and
// every other canonical hidden prompt this bit IS the boundary. Canonical
// (ICANON) must report unsafe, raw must report safe; inverting the predicate
// would paint passwords, and this test is what goes red. paneState's happy path
// is tmux-coupled and belongs to the image integration tests; its error path is
// hermetic and pinned below.
func TestIsRawPane(t *testing.T) {
	ptmx, tty, err := pty.Open()
	if err != nil {
		t.Fatalf("open pty pair: %v", err)
	}
	defer ptmx.Close()
	defer tty.Close()

	// A fresh pts starts canonical: the kernel echoes (or a hidden prompt
	// suppresses it) — either way, not a place to predict.
	if isRawPane(tty.Name()) {
		t.Fatal("canonical pty reported raw (safe to predict)")
	}

	tio, err := unix.IoctlGetTermios(int(tty.Fd()), unix.TCGETS)
	if err != nil {
		t.Fatalf("TCGETS: %v", err)
	}
	tio.Lflag &^= unix.ICANON
	if err := unix.IoctlSetTermios(int(tty.Fd()), unix.TCSETS, tio); err != nil {
		t.Fatalf("TCSETS raw: %v", err)
	}
	if !isRawPane(tty.Name()) {
		t.Fatal("raw pty reported canonical (unsafe)")
	}

	tio.Lflag |= unix.ICANON
	if err := unix.IoctlSetTermios(int(tty.Fd()), unix.TCSETS, tio); err != nil {
		t.Fatalf("TCSETS canonical: %v", err)
	}
	if isRawPane(tty.Name()) {
		t.Fatal("restored canonical pty reported raw")
	}
}

// TestIsRawPaneFailsClosed: an unopenable tty must never be safe.
func TestIsRawPaneFailsClosed(t *testing.T) {
	if isRawPane("/dev/does-not-exist") {
		t.Fatal("nonexistent tty reported raw (safe to predict)")
	}
}

// TestPaneStateFailsClosed pins the direction every paneState error must take.
// Hermetic: the session cannot exist, so tmux exits non-zero (or is absent and the
// exec itself fails) — both land on the same return. Without this, a change that
// made the error path report safe, or leak a name, would ship green.
func TestPaneStateFailsClosed(t *testing.T) {
	session := "envhaven-no-such-session-" + strconv.Itoa(os.Getpid())
	safe, app := paneState(context.Background(), session)
	if safe {
		t.Fatal("paneState reported safe for a session that does not exist")
	}
	if app != "" {
		t.Fatalf("paneState returned app %q with no pane to read it from", app)
	}
}

// fakeTmux puts a `tmux` on PATH that answers with `reply`, so paneState's own decision
// runs against a pane reading of our choosing. The reply is delivered from a file rather
// than interpolated into the script because the names worth testing carry tabs and escape
// bytes, and a shell would eat them on the way through.
func fakeTmux(t *testing.T, reply string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/reply", []byte(reply), 0o600); err != nil {
		t.Fatalf("write reply: %v", err)
	}
	if err := os.WriteFile(dir+"/tmux", []byte("#!/bin/sh\nexec cat '"+dir+"/reply'\n"), 0o700); err != nil {
		t.Fatalf("write fake tmux: %v", err)
	}
	// Prepended, not replaced: LookPath takes the first hit so ours still wins, and the
	// script keeps the `cat` it runs. Blanking PATH instead makes the fake fail to execute,
	// which lands on paneState's error return — every case then "passes" for the wrong
	// reason, and only the control case notices.
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestPaneStateRefuses drives the real decision rather than its helpers. Every other test
// here proves one predicate in isolation; this one proves paneState USES them, which is
// the only property that actually keeps a passphrase off the screen.
//
// The setup is what makes it bite. A refusal is evidence only if the same pane could have
// been ACCEPTED: against an unopenable tty every branch returns false and a deleted guard
// still ships green. So the pane here is a real pty in raw mode — the one shape isRawPane
// answers true for — and the control case proves the rig can reach "safe". Each refusal
// below therefore means a guard said no, and names which one.
func TestPaneStateRefuses(t *testing.T) {
	ptmx, tty, err := pty.Open()
	if err != nil {
		t.Fatalf("open pty pair: %v", err)
	}
	defer ptmx.Close()
	defer tty.Close()
	tio, err := unix.IoctlGetTermios(int(tty.Fd()), unix.TCGETS)
	if err != nil {
		t.Fatalf("TCGETS: %v", err)
	}
	tio.Lflag &^= unix.ICANON
	if err := unix.IoctlSetTermios(int(tty.Fd()), unix.TCSETS, tio); err != nil {
		t.Fatalf("TCSETS raw: %v", err)
	}

	for _, tc := range []struct {
		name string
		cmd  string
		mode string
		safe bool
	}{
		{"an editor on a raw pane is predictable", "nvim", "0", true},
		{"a known secret reader is refused", "ssh", "0", false},
		{"a secret reader wearing a tab is refused", "\tssh", "0", false},
		{"a secret reader wearing a zero-width space is refused", "​su", "0", false},
		{"a name carrying an escape sequence is refused", "\x1b[2Jzsh", "0", false},
		// A '|' in argv[0] splits into a sixth field. Refusing on an exact count is what
		// makes the separator unspoofable; accepting "at least five" would read the name's
		// first half as the command and the rest as the flags.
		{"a name carrying the field separator is refused", "ss|h", "0", false},
		{"a pane in copy mode is refused", "nvim", "1", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fakeTmux(t, tty.Name()+"|"+tc.cmd+"|"+tc.mode+"|0|1\n")
			safe, _ := paneState(context.Background(), "any-session")
			if safe != tc.safe {
				t.Fatalf("paneState safe=%v, want %v for pane_current_command %q in_mode %s",
					safe, tc.safe, tc.cmd, tc.mode)
			}
		})
	}
}

// TestPlainName pins the gate's answer to a hostile argv[0]. tmux hands
// pane_current_command through verbatim apart from a leading '-' or spaces, so a
// process can call itself "\tssh": secretReaders then misses, and without this
// predicate the pane falls through to isRawPane, which a live ssh session passes.
// The gate would report a remote passphrase prompt as a safe place to draw.
// Verified against tmux 3.4 — `exec -a $'\tssh' ssh host` yields "\tssh".
func TestPlainName(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want bool
	}{
		{"zsh", true},
		{"claude", true},
		{"python3", true},
		{"opencode", true},
		{"node-22", true},
		{"a.out", true},
		{"g++", true},
		{"_wrapper", true},
		{"", false}, // the sentinel every error path returns; never a real pane
		{"\tssh", false},
		{"\nssh", false},
		{"ssh\r", false},
		{"\x1b[2Jzsh", false},
		{" ssh", false},
		{"s sh", false},
		{"ssh\x00", false},
		{"​ssh", false}, // zero-width space: invisible, and not in the alphabet
		{"sudo�", false},
	} {
		t.Run(strconv.Quote(tc.in), func(t *testing.T) {
			if got := plainName(tc.in); got != tc.want {
				t.Fatalf("plainName(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestSecretReaderSpoofIsRefused walks the actual decision, not just the helper:
// every disguise of a secret-reading command must leave paneState's guard true (so
// the pane is refused) even though the secretReaders lookup itself misses.
func TestSecretReaderSpoofIsRefused(t *testing.T) {
	for _, name := range []string{"\tssh", "\nssh", " sudo", "ssh\x1b", "​su"} {
		if secretReaders[name] {
			t.Fatalf("test premise wrong: secretReaders[%q] hit, so this is not a spoof", name)
		}
		if plainName(name) {
			t.Fatalf("%q passed plainName, so paneState would fall through to isRawPane "+
				"and report a raw ssh/sudo pane as safe to predict in", name)
		}
	}
}

// TestClampApp pins the gate frame's name bound. The clamp is a wire concern — a
// hostile argv[0] must not bloat a frame the browser reads on every poll — so it runs
// on the way out only, never on the name secretReaders is looked up with. It must also
// leave valid UTF-8 behind, because the 0x02 frame declares the name UTF-8 and a byte
// slice happily cuts a rune in half.
func TestClampApp(t *testing.T) {
	// 31 ASCII bytes then a two-byte rune: the cut at maxAppName lands inside it.
	split := strings.Repeat("a", maxAppName-1) + "é"
	for _, tc := range []struct {
		name string
		in   string
		want string
	}{
		{"under the bound passes through", "zsh", "zsh"},
		{"exactly the bound passes through", strings.Repeat("a", maxAppName), strings.Repeat("a", maxAppName)},
		{"over the bound is bounded", strings.Repeat("b", maxAppName+40), strings.Repeat("b", maxAppName)},
		{"a cut through a rune drops the fragment", split, strings.Repeat("a", maxAppName-1)},
		// The scrub must not be conditional on truncating. paneState's own ToLower
		// happens to sanitise today, so nothing short reaches here malformed — which is
		// exactly why this case is pinned: "only scrub when we cut" is the obvious
		// simplification, and without this row the whole suite still passes after it.
		{"short but malformed is scrubbed", "zsh\xff", "zsh"},
		// A rune ENDING exactly on the bound must survive whole. Pins `>` against `>=`,
		// which would cut this one in half and then scrub the fragment away.
		{"a rune ending on the bound survives", strings.Repeat("a", maxAppName-2) + "é", strings.Repeat("a", maxAppName-2) + "é"},
		// A four-byte rune straddling the cut: the fragment is longer than the two-byte
		// case, so a scrub that only looked at the last byte would leave it behind.
		{"a cut through a four-byte rune drops it", strings.Repeat("a", maxAppName-1) + "\U0001D11E", strings.Repeat("a", maxAppName-1)},
		// The case the clamp's comment is entirely about: ToLower has already turned each
		// invalid byte into a three-byte U+FFFD, so the name arrives here EXPANDED past
		// the bound and the cut lands mid-replacement-char.
		{"U+FFFD expansion is cut cleanly", strings.Repeat("�", 11), strings.Repeat("�", 10)},
		{"the real path: ToLower of invalid bytes", strings.ToLower(strings.Repeat("\xff", 11)), strings.Repeat("�", 10)},
		{"empty stays empty", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := clampApp(tc.in)
			if got != tc.want {
				t.Fatalf("clampApp(%d bytes) = %q, want %q", len(tc.in), got, tc.want)
			}
			if len(got) > maxAppName {
				t.Fatalf("clampApp returned %d bytes, over the %d-byte bound", len(got), maxAppName)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("clampApp returned invalid UTF-8 onto a UTF-8 wire: %q", got)
			}
		})
	}
}

// A runtime that stays running as the parent of the real binary makes tmux report
// the runtime, so codex looked like "node" to the browser for its whole session
// and never got its measured composer geometry. wrappedName is what recovers the
// application; these are the argv shapes it has to survive.
func TestWrappedName(t *testing.T) {
	cases := []struct {
		name    string
		cmdline string
		want    string
	}{
		// The case this exists for, measured on codex 0.145.0.
		{"npm shim", "node\x00/mise/installs/node/22/bin/codex\x00", "codex"},
		{"a word is not a script", "node\x00codex\x00", ""},
		{"subcommand, not an app", "bun\x00run\x00dev\x00", ""},
		{"python module", "python3\x00-m\x00http.server\x00", ""},
		{"runtime flags first", "node\x00--enable-source-maps\x00/x/codex\x00", "codex"},
		{"short flag", "node\x00-r\x00/x/codex\x00", "codex"},
		{"uppercased path", "node\x00/x/CODEX\x00", "codex"},
		{"app args ignored", "node\x00/x/codex\x00--model\x00gpt-5\x00", "codex"},
		{"trailing NUL", "node\x00/x/codex\x00\x00", "codex"},

		// Nothing to name: the caller keeps the runtime's own name.
		{"interactive runtime", "node\x00", ""},
		{"no NUL at all", "node", ""},
		{"empty", "", ""},
		{"only flags", "node\x00--version\x00", ""},

		// Refused rather than guessed at.
		{"inline script", "node\x00-e\x00console.log(1)\x00", ""},
		{"space in name", "node\x00/x/co dex\x00", ""},
		{"quote in name", "node\x00/x/co'dex\x00", ""},
		{"control byte", "node\x00/x/\tcodex\x00", ""},
		{"directory only", "node\x00/x/\x00", ""},

		// A secret reader behind a runtime must survive intact for paneState to
		// refuse on it; wrappedName's job is only to report the name faithfully.
		{"wrapped ssh", "node\x00/x/ssh\x00", "ssh"},
	}
	for _, c := range cases {
		if got := wrappedName(c.cmdline); got != c.want {
			t.Errorf("%s: wrappedName(%q) = %q, want %q", c.name, c.cmdline, got, c.want)
		}
	}
}

// The wrapper list must never name something that is a real application on its
// own, and must never overlap the secret readers: an entry in both would resolve
// PAST the refusal that keeps a passphrase off the screen.
func TestRuntimeWrappersAreNotApplications(t *testing.T) {
	for name := range runtimeWrappers {
		if secretReaders[name] {
			t.Errorf("%q is both a runtime wrapper and a secret reader; resolving past it would unblock a secret prompt", name)
		}
		if !plainName(name) {
			t.Errorf("%q is not a plain command name, so tmux could never report it", name)
		}
	}
	for _, app := range []string{"zsh", "bash", "sh", "fish", "claude", "codex", "pi", "opencode", "vim"} {
		if runtimeWrappers[app] {
			t.Errorf("%q is an application, not a runtime: resolving it would report whatever file it was handed", app)
		}
	}
	// Runtimes that COULD wrap an application and are deliberately absent: no pane
	// was observed reporting them while something else ran. Adding one renames
	// every pane running it (python3 /tmp/x.py becomes "x.py"), so it needs an
	// observation behind it, not plausibility.
	for _, unmeasured := range []string{"python", "python3", "bun", "deno", "ruby", "perl"} {
		if runtimeWrappers[unmeasured] {
			t.Errorf("%q was added to runtimeWrappers without a measured pane; it renames every pane running it", unmeasured)
		}
	}
}

// /proc/<pid>/stat's comm field is attacker-influenced: a process can name itself
// ") 0 0 0 0 999999" and, parsed from the left, move every field after it. The
// last ')' is what makes that harmless.
func TestStatTPGID(t *testing.T) {
	cases := []struct {
		name string
		stat string
		want int
	}{
		{"ordinary", "1234 (zsh) S 1200 1234 1234 34816 5678 4194304 ...", 5678},
		{"space in comm", "1234 (Web Content) S 1200 1234 1234 34816 4242 4194304", 4242},
		{"paren in comm", "1234 (odd)name) S 1200 1234 1234 34816 4242 0", 4242},
		{"forged fields in comm", "1234 () 0 0 0 0 999999) S 1200 1234 1234 34816 4242 0", 4242},
		{"no foreground group", "1234 (zsh) S 1200 1234 1234 0 -1 0", -1},
		{"truncated", "1234 (zsh) S 1200", 0},
		{"no comm parens", "1234 zsh S 1200 1234 1234 34816 4242", 0},
		{"empty", "", 0},
		{"tpgid not a number", "1234 (zsh) S 1200 1234 1234 34816 x 0", 0},
	}
	for _, c := range cases {
		if got := statTPGID(c.stat); got != c.want {
			t.Errorf("%s: statTPGID(%q) = %d, want %d", c.name, c.stat, got, c.want)
		}
	}
}

// panePID is spliced into a /proc path, so it is checked rather than trusted.
func TestIsDigits(t *testing.T) {
	for _, ok := range []string{"1", "42", "323322"} {
		if !isDigits(ok) {
			t.Errorf("isDigits(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"", "-1", "1 2", "12a", "../../etc/passwd", "1/../2", "٣"} {
		if isDigits(bad) {
			t.Errorf("isDigits(%q) = true, want false", bad)
		}
	}
}

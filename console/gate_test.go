package main

import (
	"testing"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// TestIsRawPane pins the one general-case predicate deciding whether a
// keystroke may be painted while the pane might be reading a secret. The
// secretReaders map only backstops known commands; for read -s, getpass, and
// every other canonical hidden prompt this bit IS the boundary. Canonical
// (ICANON) must report unsafe, raw must report safe; inverting the predicate
// would paint passwords, and this test is what goes red. paneSafe itself is
// tmux-coupled and belongs to the image integration tests.
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

const ESC = '\x1b';

export const ANSI = {
  enterAlternateScreen: `${ESC}[?1049h`,
  exitAlternateScreen: `${ESC}[?1049l`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  clearScreen: `${ESC}[2J`,
  moveToTopLeft: `${ESC}[H`,
  enableLineWrap: `${ESC}[?7h`,
  disableMouseEvents: `${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l`,
};

let childOwnsTerminal = false;

export function enterFullscreen(): void {
  const stdout = process.stdout;
  if (!stdout.isTTY) return;

  stdout.write(ANSI.enterAlternateScreen);
  stdout.write(ANSI.hideCursor);
  stdout.write(ANSI.clearScreen);
  stdout.write(ANSI.moveToTopLeft);
  stdout.write(ANSI.disableMouseEvents);
}

export function exitFullscreen(): void {
  const stdout = process.stdout;
  if (!stdout.isTTY) return;

  stdout.write(ANSI.showCursor);
  stdout.write(ANSI.enableLineWrap);
  stdout.write(ANSI.exitAlternateScreen);
}

export function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

export function setupCleanupHandlers(cleanup: () => void): void {
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    // Ctrl-C is the child's to handle; the TUI comes back once it exits.
    if (childOwnsTerminal) return;
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error('Uncaught exception:', err);
    process.exit(1);
  });
}

/**
 * Hands the real terminal to an interactive command (SSH passphrase, GPG pinentry) and takes it
 * back for Ink when the command exits. Ink 6 cannot pause, so meanwhile its frames are dropped
 * and nothing in this process reads stdin.
 */
export async function runInteractive(cmd: string[], cwd: string): Promise<number> {
  const { stdin, stdout } = process;
  const write = stdout.write;
  const wasRaw = stdin.isRaw;
  const readers = stdin.listeners('readable') as Array<() => void>;

  childOwnsTerminal = true;
  try {
    exitFullscreen();
    stdout.write = () => true;
    stdin.setRawMode(false);
    // A 'readable' listener (Ink's) makes pause() a no-op, and the stream notices its removal
    // a tick later. Once paused, Bun stops reading the tty.
    stdin.removeAllListeners('readable');
    await new Promise((resolve) => process.nextTick(resolve));
    stdin.pause();

    // git runs gpg on pipes and gpg-agent starts pinentry, so GPG_TTY is how pinentry finds the terminal.
    const env = { ...process.env, GPG_TTY: terminalPath() ?? process.env.GPG_TTY };
    const child = Bun.spawn(cmd, { cwd, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    return await child.exited;
  } finally {
    stdout.write = write;
    enterFullscreen();
    stdin.setRawMode(wasRaw);
    // Re-adding Ink's listeners makes Bun read stdin again.
    for (const reader of readers) stdin.on('readable', reader);
    // Ink redraws a full-screen frame from scratch on resize.
    stdout.emit('resize');
    // Bun hands signals to listeners at the start of its next loop iteration, so the Ctrl-C that
    // ended the child may still be on its way to ours. setImmediate runs after that.
    await new Promise((resolve) => setImmediate(resolve));
    childOwnsTerminal = false;
  }
}

/** The terminal's device path, e.g. /dev/pts/3 or /dev/ttys003. `tty` resolves it on Linux and macOS. */
function terminalPath(): string | undefined {
  const tty = Bun.spawnSync(['tty'], { stdin: 'inherit' });
  return tty.success ? tty.stdout.toString().trim() : undefined;
}

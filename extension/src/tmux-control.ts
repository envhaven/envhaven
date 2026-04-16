import { spawn, type ChildProcess } from 'child_process';
import { execSafe } from './environment';

export type TmuxEvent = 'change' | 'disconnect';

const NOTIFY_PREFIXES = [
  '%window-add',
  '%window-close',
  '%window-renamed',
  '%unlinked-window-add',
  '%unlinked-window-close',
  '%unlinked-window-renamed',
  '%session-window-changed',
  '%client-session-changed',
  '%session-renamed',
  '%sessions-changed',
];

export class TmuxControl {
  private proc?: ChildProcess;
  private buf = '';
  private listeners = new Set<(e: TmuxEvent) => void>();
  private disposed = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly sessionName: string) {}

  async start(): Promise<void> {
    if (this.proc || this.disposed) return;
    try {
      await execSafe(
        `tmux has-session -t ${this.sessionName} 2>/dev/null || tmux new-session -d -s ${this.sessionName} -c /config/workspace`
      );
    } catch {
      /* fall through — attach will fail loudly if the session really isn't there */
    }
    const proc = spawn('tmux', ['-C', 'attach-session', '-t', this.sessionName], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (chunk: Buffer) => this._onData(chunk));
    proc.on('exit', () => this._onExit(proc));
    proc.on('error', () => this._onExit(proc));
    this.proc = proc;
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.proc) {
      try { this.proc.kill(); } catch { /* best effort */ }
      this.proc = undefined;
    }
    this.listeners.clear();
  }

  on(fn: (e: TmuxEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  static isChangeLine(line: string): boolean {
    for (const p of NOTIFY_PREFIXES) {
      if (line === p || line.startsWith(p + ' ') || line.startsWith(p + '\t')) return true;
    }
    return false;
  }

  private _onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (TmuxControl.isChangeLine(line)) this._emit('change');
    }
  }

  private _onExit(proc: ChildProcess): void {
    if (this.proc !== proc) return;
    this.proc = undefined;
    this.buf = '';
    this._emit('disconnect');
    if (!this.disposed) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        void this.start();
      }, 1000);
    }
  }

  private _emit(e: TmuxEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}

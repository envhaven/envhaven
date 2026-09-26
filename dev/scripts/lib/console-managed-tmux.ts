// Managed-console token minting and connection-scoped tmux isolation.
import { $ } from 'bun';

const BASE_SESSION = 'envhaven';
const TEST_SESSION_PREFIX = 'ehtest';
const RUN_ID = /^[0-9a-z]{1,8}-[0-9a-z]{8,12}-[0-9a-f]{12}$/;

interface ManagedView {
  name: string;
  ownedId: string;
  ownedIds: Set<string>;
}

export class ManagedConsole {
  private cachedToken: { token: string; at: number } | null = null;
  private inflightToken: Promise<string> | null = null;
  private view: ManagedView | null = null;
  private windowSerial = 0;
  // Set by release() before it waits its turn. A check loop still running after a signal
  // must not build a view or add a window once the release has been asked for.
  private closed = false;
  // One tmux mutation at a time. release() works from a snapshot of the owned windows, so
  // a reset interleaved with it adds a window the snapshot never saw, and that window
  // stays linked in the operator's shared session.
  private queue: Promise<unknown> = Promise.resolve();
  readonly probeSession: string;

  private constructor(
    readonly container: string,
    private readonly apiUrl: string,
    private readonly workspaceId: string,
    private readonly workspaceToken: string,
    runId: string,
  ) {
    if (!RUN_ID.test(runId)) throw new Error(`invalid console harness run id: ${JSON.stringify(runId)}`);
    this.probeSession = `${TEST_SESSION_PREFIX}-${runId}`;
  }

  static async detect(container: string, runId: string): Promise<ManagedConsole | null> {
    const out = await $`docker exec ${container} env`.quiet();
    const env = new Map<string, string>();
    for (const line of out.text().split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) env.set(line.slice(0, at), line.slice(at + 1));
    }
    if (env.get('ENVHAVEN_MANAGED') !== 'true') return null;

    const apiUrl = env.get('_ENVHAVEN_API_URL') || 'https://api.envhaven.com';
    const workspaceId = env.get('_ENVHAVEN_WORKSPACE_ID') || '';
    const workspaceToken = env.get('_ENVHAVEN_WORKSPACE_TOKEN') || '';
    const missing = [
      !workspaceId && '_ENVHAVEN_WORKSPACE_ID',
      !workspaceToken && '_ENVHAVEN_WORKSPACE_TOKEN',
    ].filter(Boolean);
    if (missing.length) throw new Error(`managed console is missing ${missing.join(', ')}`);
    return new ManagedConsole(container, apiUrl, workspaceId, workspaceToken, runId);
  }

  readonly mintToken = (): Promise<string> => {
    if (this.cachedToken && Date.now() - this.cachedToken.at < 45_000) {
      return Promise.resolve(this.cachedToken.token);
    }
    if (this.inflightToken) return this.inflightToken;
    this.inflightToken = (async () => {
      const response = await fetch(`${this.apiUrl}/v1/internal/workspace/${this.workspaceId}/console-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.workspaceToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`console token mint failed: HTTP ${response.status}`);
      const { token } = (await response.json()) as { token?: string };
      if (!token) throw new Error('console token mint returned no token');
      this.cachedToken = { token, at: Date.now() };
      return token;
    })().finally(() => { this.inflightToken = null; });
    return this.inflightToken;
  };

  /** Select the test window only inside this run's grouped view. */
  activateWindow(): Promise<void> {
    return this.whileOpen(() => this.activate());
  }

  /** Replace this run's test window without changing the base session's current window. */
  resetWindow(): Promise<void> {
    return this.whileOpen(() => this.reset());
  }

  /**
   * Remove only windows and the grouped view created by this run.
   *
   * Marked closed before it queues: an activation or reset landing behind it would build
   * a view or a window that nothing releases, so those are refused.
   */
  release(): Promise<void> {
    this.closed = true;
    return this.serial(() => this.releaseView());
  }

  /** Run after every earlier mutation has settled; a failed one never blocks the next. */
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private whileOpen<T>(op: () => Promise<T>): Promise<T> {
    return this.serial(() => {
      if (this.closed) throw new Error('managed console released');
      return op();
    });
  }

  // The bodies below call each other directly. Going through the public methods from
  // inside a queued mutation would wait on the queue that mutation is holding.
  private async activate(): Promise<void> {
    if (this.view) {
      await this.selectWindow(this.view, this.view.ownedId);
      return;
    }

    const state: ManagedView = { name: this.probeSession, ownedId: '', ownedIds: new Set() };
    await this.tmuxRequired('new-session', '-d', '-t', `=${BASE_SESSION}`, '-s', state.name);
    this.view = state;
    try {
      const ownedId = await this.createWindow(state);
      state.ownedId = ownedId;
      state.ownedIds.add(ownedId);
      await this.selectWindow(state, ownedId);
    } catch (error) {
      try {
        await this.releaseView();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'could not roll back managed tmux isolation');
      }
      throw error;
    }
  }

  private async reset(): Promise<void> {
    const hadView = this.view !== null;
    await this.activate();
    if (!hadView) return;

    const state = this.view!;
    const replacement = await this.createWindow(state);
    state.ownedIds.add(replacement);
    try {
      await this.selectWindow(state, replacement);
    } catch (error) {
      try {
        await this.tmuxRequired('kill-window', '-t', replacement);
        state.ownedIds.delete(replacement);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'could not roll back the managed tmux replacement');
      }
      throw error;
    }

    const previous = state.ownedId;
    state.ownedId = replacement;
    await this.tmuxRequired('kill-window', '-t', previous);
    state.ownedIds.delete(previous);
  }

  private async releaseView(): Promise<void> {
    const state = this.view;
    if (!state) return;

    const errors: unknown[] = [];
    let base: { active: string; ids: Set<string> } | null = null;
    try {
      base = await this.windows(BASE_SESSION);
    } catch (error) {
      errors.push(error);
    }

    let remaining = base?.ids.size ?? 0;
    for (const ownedId of [...state.ownedIds]) {
      if (!base) break;
      if (!base.ids.has(ownedId)) {
        state.ownedIds.delete(ownedId);
        continue;
      }
      if (remaining === 1) {
        errors.push(new Error(`refusing to kill the last window in shared session ${BASE_SESSION} (${ownedId})`));
        continue;
      }
      try {
        await this.tmuxRequired('kill-window', '-t', ownedId);
        state.ownedIds.delete(ownedId);
        remaining--;
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      if (await this.sessionExists(state.name)) {
        await this.tmuxRequired('kill-session', '-t', `=${state.name}`);
      }
    } catch (error) {
      errors.push(error);
    }

    if (errors.length) throw new AggregateError(errors, 'could not release the managed tmux view');
    this.view = null;
  }

  private tmux(...args: string[]) {
    return $`docker exec -u abc -e HOME=/config ${this.container} tmux ${args}`.quiet().nothrow();
  }

  private async tmuxRequired(...args: string[]) {
    const result = await this.tmux(...args);
    if (result.exitCode !== 0) {
      throw new Error(`tmux ${args.join(' ')} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`);
    }
    return result;
  }

  private async sessionExists(name: string): Promise<boolean> {
    return (await this.tmux('has-session', '-t', `=${name}`)).exitCode === 0;
  }

  private async windows(session: string): Promise<{ active: string; ids: Set<string> }> {
    const result = await this.tmuxRequired('list-windows', '-t', `=${session}`, '-F', '#{window_id} #{window_active}');
    const rows = result.text().split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/));
    if (rows.some(([id, active]) => !/^@\d+$/.test(id ?? '') || (active !== '0' && active !== '1'))) {
      throw new Error(`tmux returned malformed window ownership data: ${JSON.stringify(result.text().trim())}`);
    }
    const active = rows.filter((row) => row[1] === '1').map((row) => row[0]!);
    if (active.length !== 1) throw new Error(`tmux reported ${active.length} active windows in session ${session}`);
    return { active: active[0]!, ids: new Set(rows.map((row) => row[0]!)) };
  }

  private async createWindow(state: ManagedView): Promise<string> {
    const name = `${TEST_SESSION_PREFIX}-${this.windowSerial++ + 1}`;
    const result = await this.tmuxRequired(
      'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `=${state.name}`, '-n', name, '-c', '/config/workspace',
    );
    const id = result.text().trim();
    if (!/^@\d+$/.test(id)) throw new Error(`tmux did not return the new test window id: ${JSON.stringify(id)}`);
    return id;
  }

  private async selectWindow(state: ManagedView, id: string): Promise<void> {
    await this.tmuxRequired('select-window', '-t', `=${state.name}:${id}`);
    const { active } = await this.windows(state.name);
    if (active !== id) throw new Error(`tmux selected ${active}, expected owned test window ${id} in ${state.name}`);
  }
}

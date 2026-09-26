import { expect, test } from 'bun:test';
import { ManagedConsole } from './console-managed-tmux';

const turns = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};

// An in-memory tmux holding one session group. A grouped session shares the operator's
// windows, and killing it leaves every window it added linked in `envhaven`, which is the
// leak these tests look for. Each call takes a few event-loop turns and runs its command
// when it lands, like a docker exec. After exit() a command already sent still lands, and
// nobody hears back.
function fakeTmux(latency: () => number) {
  const windows = new Set(['@0']);
  const sessions = new Map([['envhaven', { active: '@0' }]]);
  let serial = 1;
  let exited = false;
  const out = (exitCode: number, text = '') => ({
    exitCode, text: () => text, stderr: Buffer.from(exitCode ? 'fake tmux refused' : ''),
  });
  const session = (target: string) => target.replace(/^=/, '');

  function run([command, ...rest]: string[]) {
    const flag = (name: string) => rest[rest.indexOf(name) + 1] ?? '';
    switch (command) {
      case 'new-session': {
        const from = sessions.get(session(flag('-t')));
        if (!from || sessions.has(flag('-s'))) return out(1);
        sessions.set(flag('-s'), { active: from.active });
        return out(0);
      }
      case 'new-window': {
        if (!sessions.has(session(flag('-t')))) return out(1);
        const id = `@${serial++}`;
        windows.add(id);
        return out(0, `${id}\n`);
      }
      case 'select-window': {
        const [name = '', id = ''] = session(flag('-t')).split(':');
        const target = sessions.get(name);
        if (!target || !windows.has(id)) return out(1);
        target.active = id;
        return out(0);
      }
      case 'list-windows': {
        const target = sessions.get(session(flag('-t')));
        if (!target) return out(1);
        return out(0, [...windows].map((id) => `${id} ${id === target.active ? 1 : 0}\n`).join(''));
      }
      case 'kill-window': {
        const id = flag('-t');
        if (!windows.delete(id)) return out(1);
        for (const s of sessions.values()) if (s.active === id) s.active = [...windows][0] ?? '';
        return out(0);
      }
      case 'has-session':
        return out(sessions.has(session(flag('-t'))) ? 0 : 1);
      case 'kill-session':
        return out(sessions.delete(session(flag('-t'))) ? 0 : 1);
    }
    throw new Error(`the fake tmux has no ${command}`);
  }

  return {
    tmux: (...args: string[]) => turns(latency()).then(() => {
      const result = run(args);
      return exited ? new Promise<never>(() => undefined) : result;
    }),
    exit: () => { exited = true; },
    /** What this run left in the operator's session group. */
    leftover: () => [
      ...[...windows].filter((id) => id !== '@0'),
      ...[...sessions.keys()].filter((name) => name !== 'envhaven'),
    ],
  };
}

function open(latency: () => number) {
  const tmux = fakeTmux(latency);
  // The constructor is private (detect() reads the container's env) and tmux() is a docker
  // exec; both are replaced here and nothing else is.
  const Construct = ManagedConsole as unknown as new (...args: string[]) => ManagedConsole;
  const managed = new Construct('envhaven-test', 'https://api.invalid', 'ws', 'ewt_test', 'abc-1234abcd-0123456789ab');
  (managed as unknown as { tmux: typeof tmux.tmux }).tmux = tmux.tmux;
  return { managed, tmux };
}

test('a released console refuses to open again and leaves nothing behind', async () => {
  const { managed, tmux } = open(() => 1);
  await managed.activateWindow();
  await managed.release();

  await expect(managed.activateWindow()).rejects.toThrow('managed console released');
  await expect(managed.resetWindow()).rejects.toThrow('managed console released');
  expect(tmux.leftover()).toEqual([]);
});

// The runner after a signal: cleanup releases the view while the check loop keeps resetting
// the pane and activating the window, and the process exits once the release succeeds.
test('a check loop still running after a signal leaves nothing in the shared session', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    let state = seed;
    const random = (n: number) => 1 + Math.floor(((state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32) * n);
    const { managed, tmux } = open(() => random(4));
    await managed.activateWindow();

    let stopped = false;
    void (async () => {
      while (!stopped) {
        await managed.resetWindow().catch(() => undefined);
        await turns(random(6));
        await managed.activateWindow().catch(() => undefined);
      }
    })();

    // closeOwned retries a failed release, then the process exits.
    await turns(random(8));
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await managed.release().then(() => true, () => false)) break;
    }
    stopped = true;
    tmux.exit();
    await turns(64);

    expect({ seed, leftover: tmux.leftover() }).toEqual({ seed, leftover: [] });
  }
});

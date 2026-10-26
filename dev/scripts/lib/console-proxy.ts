// Fixed-latency transport used by the browser console harness.
import { existsSync } from 'fs';
import { join } from 'path';
import { $, type Subprocess } from 'bun';
import { DEV_ROOT } from './config';

const FIXTURES = join(DEV_ROOT, 'fixtures');
const RUN_ID = /^[0-9a-z]{1,8}-[0-9a-z]{8,12}-[0-9a-f]{12}$/;

// The console's in-container port. Host publication is irrelevant because the rig
// reaches the container over its bridge or through a proxy running beside it.
export const CONSOLE_PORT = 7681;
export const CONSOLE_FIXTURE_USER = 'abc';
export const CONSOLE_FIXTURE_MODE = '700';

/** A fixed-latency TCP proxy in front of the console. */
export class LatencyProxy {
  private constructor(
    readonly host: string,
    readonly port: number,
    readonly stop: () => Promise<void>,
  ) {}

  static async start(target: string, targetPort: number, downMs: number, upMs: number): Promise<LatencyProxy> {
    const port = await freePort();
    const script = join(FIXTURES, 'latency-proxy.py');
    const proc = Bun.spawn(
      ['python3', script, String(port), target, String(targetPort), String(downMs), String(upMs)],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    const stop = retryableCleanup(() => stopLocalProcess(proc));
    try {
      await waitReachable('127.0.0.1', port);
    } catch (error) {
      try {
        await retryCleanup(stop);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'local latency proxy failed to start and clean up');
      }
      const stderr = await new Response(proc.stderr).text().then((text) => text.trim(), () => '');
      throw new Error(`${messageOf(error)}${stderr ? `\n${stderr}` : ''}`, { cause: error });
    }
    return new LatencyProxy('127.0.0.1', port, stop);
  }

  /** Run the proxy beside a managed console, which binds container loopback only. */
  static async startInContainer(
    container: string,
    ip: string,
    fixtureDir: string,
    downMs: number,
    upMs: number,
  ): Promise<LatencyProxy> {
    const id = `${process.pid}-${Date.now().toString(36)}-${Math.floor(Math.random() * 0x10000).toString(16)}`;
    const pidFile = `/tmp/eh-latency-proxy-${id}.pid`;
    const portFile = `/tmp/eh-latency-proxy-${id}.port`;
    const stopScript = `
i=0
while [ ! -e "$1" ] && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i + 1)); done
pid=$(cat "$1" 2>/dev/null) || { rm -f "$1" "$3" "$3.tmp"; exit 0; }
case "$pid" in ''|*[!0-9]*) rm -f "$1" "$3" "$3.tmp"; exit 1;; esac
cmd=$(tr '\\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
case "$cmd" in
  *"latency-proxy.py 0 "*"$2 "*) ;;
  '') rm -f "$1" "$3" "$3.tmp"; exit 0;;
  *) echo "pid $pid no longer owns this latency proxy" >&2; rm -f "$1" "$3" "$3.tmp"; exit 1;;
esac
kill "$pid" 2>/dev/null || true
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 10 ]; do sleep 0.1; i=$((i + 1)); done
if kill -0 "$pid" 2>/dev/null; then echo "latency proxy process $pid did not exit" >&2; exit 1; fi
rm -f "$1" "$3" "$3.tmp"`;
    const stop = retryableCleanup(async () => {
      await runBounded(
        ['docker', 'exec', container, 'sh', '-c', stopScript, 'eh-proxy-stop', pidFile, id, portFile],
        7000,
        'stop in-container latency proxy',
      );
    });
    try {
      const startScript = 'umask 077; echo $$ > "$1"; shift; exec "$@"';
      await runBounded([
        'docker', 'exec', '-d', container, 'sh', '-c', startScript, 'eh-proxy-start', pidFile,
        // as-abc gives python3 abc's tool PATH (root's PATH leaves it out); it execs, so the pid
        // recorded above is still the proxy's.
        '/usr/local/lib/envhaven/as-abc', 'env', `ENVHAVEN_LATENCY_PROXY_READY_FILE=${portFile}`,
        'python3', `${fixtureDir}/latency-proxy.py`, '0', '127.0.0.1', String(CONSOLE_PORT),
        String(downMs), String(upMs), '0.0.0.0', id,
      ], 7000, 'start in-container latency proxy');
      const readyScript = `
i=0
while [ "$i" -lt 60 ]; do
  port=$(cat "$1" 2>/dev/null || true)
  case "$port" in *[!0-9]*|'') ;;
    *) printf '%s' "$port"; exit 0;;
  esac
  pid=$(cat "$2" 2>/dev/null || true)
  case "$pid" in *[!0-9]*|'') ;;
    *) kill -0 "$pid" 2>/dev/null || { echo "in-container latency proxy exited before publishing its port" >&2; exit 1; };;
  esac
  sleep 0.1
  i=$((i + 1))
done
echo "in-container latency proxy did not publish its port" >&2
exit 1`;
      const published = (await runBounded(
        ['docker', 'exec', container, 'sh', '-c', readyScript, 'eh-proxy-ready', portFile, pidFile],
        7000,
        'read in-container latency proxy port',
      )).trim();
      const port = Number(published);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error(`in-container latency proxy published an invalid port: ${JSON.stringify(published)}`);
      }
      await waitReachable(ip, port);
      return new LatencyProxy(ip, port, stop);
    } catch (error) {
      try {
        await retryCleanup(stop);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'in-container latency proxy failed to start and clean up');
      }
      throw error;
    }
  }
}

export interface ConsoleFixtures {
  readonly path: string;
  readonly remove: () => Promise<void>;
}

export function consoleFixturePath(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`invalid console fixture run id: ${JSON.stringify(runId)}`);
  return `/tmp/eh-fixtures-${runId}`;
}

export async function deployConsoleFixtures(container: string, runId: string): Promise<ConsoleFixtures> {
  if (!existsSync(join(FIXTURES, 'composer.py'))) throw new Error(`missing fixtures at ${FIXTURES}`);
  const path = consoleFixturePath(runId);
  const remove = retryableCleanup(async () => {
    const result = await $`docker exec ${container} rm -rf -- ${path}`.quiet().nothrow();
    if (result.exitCode !== 0) throw new Error(`could not remove ${path}: ${result.stderr.toString().trim()}`);
  });
  await $`docker exec -u ${CONSOLE_FIXTURE_USER} ${container} mkdir -m ${CONSOLE_FIXTURE_MODE} ${path}`.quiet();
  try {
    await $`docker cp ${FIXTURES}/. ${container}:${path}/`.quiet();
  } catch (error) {
    try {
      await retryCleanup(remove);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `could not deploy or remove fixtures at ${path}`);
    }
    throw error;
  }
  return { path, remove };
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Share concurrent disposal, remember success, and allow another attempt after failure. */
export function retryableCleanup(action: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let done = false;
  return () => {
    if (done) return Promise.resolve();
    if (!running) {
      running = Promise.resolve().then(action).then(() => { done = true; }).finally(() => { running = null; });
    }
    return running;
  };
}

/** Own keyed resources until their awaited, retryable disposal succeeds. */
export class OwnedCleanups<T> {
  private readonly cleanups = new Map<T, () => Promise<void>>();

  constructor(private readonly failureMessage: string) {}

  add(key: T, action: () => Promise<void>): void {
    if (this.cleanups.has(key)) throw new Error('cleanup key is already owned');
    const cleanup = retryableCleanup(async () => {
      await action();
      this.cleanups.delete(key);
    });
    this.cleanups.set(key, cleanup);
  }

  async close(key: T): Promise<void> {
    await this.cleanups.get(key)?.();
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.cleanups.values()].map((cleanup) => cleanup()));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, this.failureMessage);
  }

  size(): number {
    return this.cleanups.size;
  }
}

/** Retry one disposal a bounded number of times; its owner decides what remains live. */
export async function retryCleanup(action: () => Promise<void>, attempts = 3): Promise<void> {
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await action();
      return;
    } catch (error) {
      failure = error;
      if (attempt < attempts) await Bun.sleep(100 * attempt);
    }
  }
  throw failure;
}

async function freePort(): Promise<number> {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function stopLocalProcess(proc: Subprocess<'ignore', 'ignore', 'pipe'>): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill();
  if (await Promise.race([proc.exited.then(() => true), Bun.sleep(3000).then(() => false)])) return;
  proc.kill(9);
  if (!(await Promise.race([proc.exited.then(() => true), Bun.sleep(2000).then(() => false)]))) {
    throw new Error('local latency proxy did not exit after SIGKILL');
  }
}

async function runBounded(args: string[], timeoutMs: number, action: string): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await Promise.race<number | null>([
    proc.exited,
    Bun.sleep(timeoutMs).then(() => null),
  ]);
  if (exitCode === null) {
    proc.kill();
    let stopped = await Promise.race([proc.exited.then(() => true), Bun.sleep(1000).then(() => false)]);
    if (!stopped) {
      proc.kill(9);
      stopped = await Promise.race([proc.exited.then(() => true), Bun.sleep(1000).then(() => false)]);
    }
    if (!stopped) throw new Error(`${action} timed out and its command did not exit after SIGKILL`);
    throw new Error(`${action} timed out after ${timeoutMs}ms`);
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${action} failed (${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
  return stdout;
}

async function waitReachable(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const response = await fetch(`http://${host}:${port}/__console/ui`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1500, remaining))),
      });
      if (response.ok) { await response.text(); return; }
    } catch {}
    if (Date.now() < deadline) await Bun.sleep(Math.min(200, deadline - Date.now()));
  }
  throw new Error(`latency proxy never reached the console via ${host}:${port} within 15s`);
}

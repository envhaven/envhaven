// Rig for driving the browser console end to end.
//
// console/ui/terminal.html predicts keystrokes optimistically and reconciles them
// against the real grid. That engine is only exercised when the round trip is
// visible, so everything here exists to put a real terminal, a real latency, and a
// real browser in front of it and then ask the page what it believes.
//
// Deliberately NOT re-exported from ./lib. The check modules import Playwright for
// types only, which erases at transpile; this is the one module that imports a runtime
// value from it. Folding it into the barrel would make every other dev script fail to
// load without the browser dependency, and CI's console job runs test-console-ui.ts
// (which imports ./lib) with no `bun install` at all. Import it by path.
import { existsSync } from 'fs';
import { join } from 'path';
import { $, type Subprocess } from 'bun';
import { chromium, type Browser, type Page } from '@playwright/test';
import { DEV_ROOT } from './config';
import { log } from './log';

const FIXTURES = join(DEV_ROOT, 'fixtures');
// Where the mimic applications land inside the workspace container. They used to
// live only in a container's /tmp, which meant the checks that need them were one
// restart away from being unrunnable by anyone.
const REMOTE_FIXTURES = '/tmp/eh-fixtures';

// Real enough to draw a composer, useless for anything else. Claude Code renders its
// input box before it ever authenticates, which is the only part these checks read.
const FAKE_ANTHROPIC_KEY = 'sk-ant-api03-fake0000000000';

// The port the console listens on INSIDE the container, which is fixed. Not
// ENVHAVEN_CONSOLE_PORT: that is the host publication, and the rig reaches the
// container over the bridge where the published mapping does not apply.
const CONSOLE_PORT = 7681;

/** A burst is the engine's optimistic model of one line, as `window.__ehPredict` vends it. */
export interface Burst {
  /** Absolute buffer row (baseY + screen row), not a screen row. */
  row: number;
  /** Content left of the MODEL's cursor. Its length IS the model's cursor column. */
  line: string;
  /** Content right of the model's cursor. */
  tail: string;
  floor: number;
  proven: boolean;
  dirty: boolean;
  draining: boolean;
  wrapped: boolean;
  offGrid: boolean;
  matched: boolean;
}

/** A learned wrap style: where a line breaks and what the continuation looks like. */
export interface WrapStyle {
  atLen: number;
  indent: number;
  pull: boolean;
  down: boolean;
}

export interface ConsoleProbe {
  readonly safe: boolean;
  readonly burst: Burst | null;
  readonly hold: { row: number; col: number; nav: boolean } | null;
  readonly app: string;
  readonly wrap: WrapStyle | null;
  readonly pend: { row: number; col: number; word: string } | null;
  /** Milliseconds since the last byte arrived from the server. */
  readonly quiet: number;
  readonly edge: { row: number; col: number; text: string } | null;
  readonly box: {
    from: number; to: number; delta: number;
    text: string; textRow: number; wipeRow: number;
  } | null;
  readonly inputLen: number;
  readonly fresh: boolean;
  readonly owning: boolean;
  readonly rtt: number;
  readonly col: number;
  readonly row: number;
  readonly baseY: number;
  readonly rows: number;
  text(row: number): string | null;
}

declare global {
  interface Window {
    __ehPredict: ConsoleProbe;
  }
}

/**
 * One geometry for every check that does not say otherwise.
 *
 * The engine's wrap predictions are width-dependent, so a check that quietly ran at a
 * width its constants were not measured at reports the width as an engine fault. The
 * original harness had one script on 830x660 and every other on this, which is the
 * kind of drift that costs an afternoon.
 */
export const VIEWPORT = { width: 1000, height: 640 };

/**
 * The same geometry at twice the device scale, for the checks that read pixels.
 *
 * Exported rather than restated, because a cell at scale 1 offers too few pixels to
 * sample a band inside and those checks' sample points were measured at scale 2.
 */
export const PIXEL_VIEWPORT = { ...VIEWPORT, deviceScaleFactor: 2 };

/**
 * Everything the probe vends except the grid reader, which is a function and cannot
 * cross the page boundary.
 *
 * Naming it is what makes `probe()` below checked. Without the annotation its shape is
 * inferred from a hand-written literal, so a field added to ConsoleProbe is simply
 * absent from every snapshot, the check that wanted it reads undefined, and the engine
 * gets blamed. That is the failure this harness exists to prevent.
 */
export type Snapshot = Omit<ConsoleProbe, 'text'>;

export interface Check {
  name: string;
  /** The user-visible behaviour this guards, in one line. */
  what: string;
  /** Restart the console and drop every tmux session before running. */
  needsFreshPane?: boolean;
  /** Returns a short note on success, throws on failure, calls inconclusive() to skip. */
  run(rig: ConsoleRig): Promise<string>;
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * A check that could not observe the thing it guards.
 *
 * Kept distinct from a failure on purpose. "The engine is correct" and "the engine
 * was never asked" are different answers, and a harness that reports them the same
 * way is how a check quietly stops testing anything while still printing green. The
 * runner counts these separately and still exits non-zero, because a guard that did
 * not run is not a guard.
 */
export class Inconclusive extends Error {}

export function inconclusive(reason: string): never {
  throw new Inconclusive(reason);
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

/**
 * A fixed-latency TCP proxy in front of the console.
 *
 * Predictive echo only exists because the round trip is visible. Straight at the
 * container the RTT is well under a millisecond, so the engine has nothing to
 * predict and every check passes by never entering the state it means to test.
 * This inserts a real round trip.
 *
 * It stays a small Python script rather than being rewritten against Bun's socket
 * API: it has run for days without dropping or reordering a byte, and a subtly
 * wrong proxy would corrupt the exact timing every check here depends on while
 * looking, from the outside, like an engine bug.
 */
export class LatencyProxy {
  private constructor(
    readonly port: number,
    // Spelled out rather than ReturnType<typeof Bun.spawn>, which erases the stream
    // generics to their defaults and then makes reading stderr look like it needs a cast.
    private readonly proc: Subprocess<'ignore', 'ignore', 'pipe'>,
  ) {}

  static async start(target: string, targetPort: number, downMs: number, upMs: number): Promise<LatencyProxy> {
    const port = await freePort();
    const script = join(FIXTURES, 'latency-proxy.py');
    const proc = Bun.spawn(
      ['python3', script, String(port), target, String(targetPort), String(downMs), String(upMs)],
      { stdout: 'ignore', stderr: 'pipe' },
    );

    // Ask through the proxy rather than trusting its banner: a listening socket that
    // cannot reach the container is the failure that would otherwise be reported as
    // "the console never became safe" twenty seconds later.
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/__console/ui`);
        if (r.ok) { await r.text(); break; }
      } catch {}
      if (Date.now() > deadline) {
        proc.kill();
        // Reap before reading. kill() does not wait, and reading a pipe whose owner is
        // still alive has no deadline of its own, so a wedged child would hang the
        // harness on the one path whose entire job is to produce a diagnosis.
        await proc.exited;
        const err = await new Response(proc.stderr).text();
        throw new Error(
          `latency proxy never reached ${target}:${targetPort}${err ? `\n${err.trim()}` : ''}`
        );
      }
      await Bun.sleep(200);
    }
    return new LatencyProxy(port, proc);
  }

  stop() {
    this.proc.kill();
  }
}

async function freePort(): Promise<number> {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

export interface RigOptions {
  container: string;
  password: string;
  downMs: number;
  upMs: number;
}

export interface PageOptions {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  /** Report macOS to the page, so the engine applies the mac keymap. */
  mac?: boolean;
  /** Extra query parameters beyond echo=1&probe=1. */
  params?: Record<string, string>;
}

export class ConsoleRig {
  private readonly pageErrors: string[] = [];

  private constructor(
    private readonly browser: Browser,
    private readonly proxy: LatencyProxy,
    private readonly password: string,
    readonly container: string,
  ) {}

  static async open(opts: RigOptions): Promise<ConsoleRig> {
    // Interpolated rather than written inline: the template contains a space, and
    // bun's $ splits an inline one into two arguments.
    const format = '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}';
    const ip = (
      await $`docker inspect ${opts.container} --format ${format}`.quiet()
    ).text().trim();
    if (!ip) throw new Error(`container '${opts.container}' has no IP address`);

    await deployFixtures(opts.container);
    const proxy = await LatencyProxy.start(ip, CONSOLE_PORT, opts.downMs, opts.upMs);
    log.info(`Console at ${ip}:${CONSOLE_PORT} via 127.0.0.1:${proxy.port} (${opts.downMs}ms down / ${opts.upMs}ms up)`);

    // `channel: 'chromium'` is load-bearing, not a preference. With plain
    // `headless: true` Playwright launches its headless shell instead of the full
    // browser, and the two lay out text differently enough to change how many columns
    // the terminal fits: measured at the same 1000px viewport, 125 against 128. Every
    // wrap constant in these checks is a column number, so that difference decides
    // whether they are measuring the engine or the browser. The predecessor to this
    // file got the full browser only by accident, through a hardcoded path to a symlink
    // that happened to point at one.
    // The proxy is already listening, so anything that throws from here on has to take
    // it down. A missing browser is the documented first-run failure, which makes this
    // exact path the one most likely to strand a detached python3 holding a port.
    try {
      const browser = await chromium.launch({ channel: 'chromium', headless: true });
      return new ConsoleRig(browser, proxy, opts.password, opts.container);
    } catch (e) {
      proxy.stop();
      throw e;
    }
  }

  /** A logged-in page with the engine armed and the probe installed. */
  async page(opts: PageOptions = {}): Promise<Page> {
    const context = await this.browser.newContext({
      viewport: { width: opts.width ?? 1000, height: opts.height ?? 640 },
      deviceScaleFactor: opts.deviceScaleFactor ?? 1,
    });
    if (opts.mac) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      });
    }
    const page = await context.newPage();
    // Closing a page does not close its context, and every check closes only its page.
    // Left alone that is 21 live browser profiles by the end of a run, each with its own
    // renderer processes, piling memory and scheduling pressure onto the exact timings
    // these checks exist to measure. A rig that perturbs its own measurements is worse
    // than no rig.
    page.once('close', () => void context.close().catch(() => undefined));
    // An exception thrown out of the engine is a failure of whatever check was
    // running, whether or not that check thought to look for one.
    page.on('pageerror', (e) => this.pageErrors.push(e.message));

    const params = new URLSearchParams({ echo: '1', probe: '1', ...(opts.params ?? {}) });
    await page.goto(`http://127.0.0.1:${this.proxy.port}/__console/ui?${params}`);
    await page.fill('#password', this.password);
    await page.click('button[type=submit]');
    await page.waitForFunction(
      () => window.__ehPredict && window.__ehPredict.safe === true,
      null,
      { timeout: 25000 },
    );
    // The rig holds itself to the rule it hands the checks. Every one of them starts
    // from this page, so a page returned mid-repaint makes the first reading of whatever
    // runs next untrustworthy, and silently.
    if (!(await quiet(page, 1200))) {
      inconclusive('the console never settled after connecting, so no first reading can be trusted');
    }
    return page;
  }

  /**
   * A mark in the engine-exception log, for pageErrorsSince.
   *
   * Deliberately not a destructive drain. A drain is only correct if every caller
   * remembers to empty the log before each check, and forgetting once attributes one
   * check's exception to the next one, silently. That is the worst thing a harness can
   * get wrong, so the shape makes it impossible rather than documenting it.
   */
  pageErrorCount(): number {
    return this.pageErrors.length;
  }

  /** Engine exceptions since a mark. Non-empty means the check that took the mark failed. */
  pageErrorsSince(mark: number): readonly string[] {
    return this.pageErrors.slice(mark);
  }

  /**
   * Drop every tmux session and restart the console.
   *
   * Checks share one long-lived pane, so a check that leaves an application running
   * hands the next one a terminal it does not expect. Used between the checks that
   * cannot tolerate that.
   */
  async resetPane() {
    await $`docker exec -u abc ${this.container} tmux kill-server`.quiet().nothrow();
    await $`docker exec ${this.container} s6-svc -r /run/service/svc-console`.quiet().nothrow();
    const deadline = Date.now() + 30000;
    for (;;) {
      const r = await $`docker exec ${this.container} curl -sf http://localhost:${CONSOLE_PORT}/__console/ui`
        .quiet().nothrow();
      if (r.exitCode === 0) return;
      if (Date.now() > deadline) throw new Error('console did not come back after reset');
      await Bun.sleep(500);
    }
  }

  /**
   * Restart the console service and return straight away.
   *
   * Deliberately neither of the things resetPane does. tmux is left alone, so the drop
   * is a transport failure and the pane's content survives it, which is the whole
   * claim the status surface makes. It also does not wait for the console to come
   * back: a caller watching the page while the server is down needs that window open,
   * and a call that returns only once the server has returned has already closed it.
   */
  async restartConsole() {
    await $`docker exec ${this.container} s6-svc -r /run/service/svc-console`.quiet().nothrow();
  }

  async close() {
    // finally, not a second statement: a browser that already crashed must not strand
    // the proxy. The runner calls this from its own finally, so a throw here would eat
    // the summary as well as leak the port.
    try {
      await this.browser.close();
    } finally {
      this.proxy.stop();
    }
  }
}

async function deployFixtures(container: string) {
  if (!existsSync(join(FIXTURES, 'composer.py'))) {
    throw new Error(`missing fixtures at ${FIXTURES}`);
  }
  await $`docker exec ${container} mkdir -p ${REMOTE_FIXTURES}`.quiet();
  await $`docker cp ${FIXTURES}/. ${container}:${REMOTE_FIXTURES}/`.quiet();
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** One read of everything the probe vends, except the grid reader. */
export async function probe(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const p = window.__ehPredict;
    return {
      safe: p.safe, app: p.app, row: p.row, col: p.col, rows: p.rows, baseY: p.baseY,
      quiet: p.quiet, inputLen: p.inputLen, fresh: p.fresh, owning: p.owning, rtt: p.rtt,
      burst: p.burst, wrap: p.wrap, box: p.box, hold: p.hold, edge: p.edge, pend: p.pend,
    };
  });
}

export function gridRow(page: Page, row: number): Promise<string | null> {
  return page.evaluate((r) => window.__ehPredict.text(r), row);
}

/**
 * Wait for the wire to fall silent for `ms`, and say whether it did.
 *
 * The leading sleep is load-bearing. `quiet` measures time since the last byte
 * ARRIVED, so polling it immediately after a keypress returns the idle time that
 * accumulated before the keypress, and the call returns instantly while the echo is
 * still in flight. Two checks in the original harness reported INCONCLUSIVE for a
 * whole session because of exactly this.
 *
 * Returns false on timeout rather than pretending. A wedged wire and a settled one
 * look identical to the poll, and the caller is the only thing that knows whether
 * the difference matters.
 */
export async function quiet(page: Page, ms = 600, timeoutMs = 20000): Promise<boolean> {
  await Bun.sleep(500);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await page.evaluate(() => window.__ehPredict.quiet)) >= ms) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(80);
  }
}

/** Wait until no burst and no hold are live, or the deadline passes. */
export async function settle(page: Page, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const p = await probe(page);
    if (!p.burst && !p.hold) return p;
    if (Date.now() > deadline) return p;
    await Bun.sleep(120);
  }
}

export interface AppSpec {
  /** Shell command that takes the pane. */
  command: string;
  /** What `probe.app` reads once it has the pane. */
  paneApp: string;
  /** Budget for a cold start to draw its composer. */
  bootMs: number;
  /**
   * How long after taking the pane before the first frame can be trusted.
   *
   * A column in the table rather than a branch in launchApp. This started life as a
   * ternary on one application's name, which is exactly the kind of fact that belongs
   * beside the others it describes and cannot be found by anyone reading the table.
   */
  settleMs: number;
}

/**
 * The applications a check can put in the pane.
 *
 * The four mimics are here because the real CLIs cannot be held in the states some
 * checks need: a controlled background, a self-drawn caret, a parked cursor that never
 * moves. They report as `python3`, since that is the process holding the pane, and the
 * engine has no row for them, so they also exercise the unlearned path.
 */
export const APPS = {
  claude: { command: `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY} claude`, paneApp: 'claude', bootMs: 60000, settleMs: 3000 },
  codex: { command: 'codex', paneApp: 'codex', bootMs: 60000, settleMs: 2500 },
  pi: { command: 'pi', paneApp: 'pi', bootMs: 60000, settleMs: 2500 },
  composer: { command: `python3 ${REMOTE_FIXTURES}/composer.py`, paneApp: 'python3', bootMs: 20000, settleMs: 2500 },
  boxcomposer: { command: `python3 ${REMOTE_FIXTURES}/boxcomposer.py`, paneApp: 'python3', bootMs: 20000, settleMs: 2500 },
  invcomposer: { command: `python3 ${REMOTE_FIXTURES}/invcomposer.py`, paneApp: 'python3', bootMs: 20000, settleMs: 2500 },
  blinkmimic: { command: `python3 ${REMOTE_FIXTURES}/blinkmimic.py`, paneApp: 'python3', bootMs: 20000, settleMs: 2500 },
} satisfies Record<string, AppSpec>;

export type AppName = keyof typeof APPS;

/** Put an application in the pane and wait until the engine agrees it is there. */
export async function launchApp(page: Page, name: AppName) {
  const spec = APPS[name];
  await page.keyboard.type(spec.command, { delay: 4 });
  await page.keyboard.press('Enter');
  try {
    await page.waitForFunction(
      (want) => window.__ehPredict.app === want,
      spec.paneApp,
      { timeout: spec.bootMs },
    );
  } catch {
    inconclusive(`${name} never took the pane within ${spec.bootMs / 1000}s`);
  }
  await Bun.sleep(spec.settleMs);
}

/** Return the pane to a shell. Two interrupts: the first leaves the composer, the second the app. */
export async function teardownApp(page: Page) {
  await page.keyboard.press('Control+u');
  await Bun.sleep(200);
  await page.keyboard.press('Escape');
  await Bun.sleep(200);
  for (const _ of [0, 1]) {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyC');
    await page.keyboard.up('Control');
    await Bun.sleep(500);
  }
  await page.waitForFunction(() => window.__ehPredict.app === 'zsh', null, { timeout: 15000 })
    .catch(() => undefined);
}

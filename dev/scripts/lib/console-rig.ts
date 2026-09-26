// Browser and page driver for the predictive-console checks.
//
// console/ui/assets/eh-predictor.js predicts keystrokes optimistically and reconciles them
// against the real grid. That engine is only exercised when the round trip is
// visible, so everything here exists to put a real terminal, a real latency, and a
// real browser in front of it and then ask the page what it believes.
//
// Deliberately NOT re-exported from ./lib. The check modules import Playwright for
// types only, which erases at transpile; this is the one module that imports a runtime
// value from it. Folding it into the barrel would make every other dev script fail to
// load without the browser dependency, and CI's console job runs test-console-ui.ts
// (which imports ./lib) with no `bun install` at all. Import it by path.
import { $ } from 'bun';
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  burstDeathLinesSince, type ProbeTrace, type ProbeTraceMark,
} from './engine';
import { log } from './log';
import { APPS, appCommand, type AppName } from './console-apps';
import { ManagedConsole } from './console-managed-tmux';
import {
  CONSOLE_PORT,
  LatencyProxy,
  OwnedCleanups,
  deployConsoleFixtures,
  retryCleanup,
  retryableCleanup,
  type ConsoleFixtures,
} from './console-proxy';

/** A burst is the engine's optimistic model of one line, as `window.__ehPredict` vends it. */
export interface Burst {
  /** Absolute buffer row (baseY + screen row), not a screen row. */
  row: number;
  /** Content left of the MODEL's cursor. Its length IS the model's cursor column. */
  line: string;
  /** Content right of the model's cursor. */
  tail: string;
  floor: number;
  /** The column past the row's last content cell as the model knows it: where End lands. */
  end: number;
  proven: boolean;
  dirty: boolean;
  draining: boolean;
  wrapped: boolean;
  offGrid: boolean;
  matched: boolean;
  /** What the row above a downward wrap holds if the app grew UP instead; null otherwise. */
  wrapKept: string | null;
  /** A lazy wrap's phase A is painted and its word pull waits on the next keystroke. */
  pullPend: boolean;
}

/** A learned wrap style: where a line breaks and what the continuation looks like. */
export interface WrapStyle {
  atLen: number;
  indent: number;
  pull: boolean;
  down: boolean | null;
  lazy: boolean;
  spacePull: boolean;
}

export interface ConsoleProbe {
  readonly safe: boolean;
  readonly burst: Burst | null;
  readonly reflow: readonly { row: number; text: string; clear: boolean; chrome: boolean; was: string }[] | null;
  readonly hold: { row: number; col: number; nav: boolean } | null;
  readonly app: string;
  /** The word rule in force for the pane app (the engine's WORD_APPS name; 'zsh' by default). */
  readonly words: string;
  readonly wrap: WrapStyle | null;
  readonly pend: { row: number; col: number; word: string; moved: string | null; trigger: string } | null;
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
  /** The terminal's width in cells. Not a row's string length: a combining mark makes that read one long. */
  readonly cols: number;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  /** Monotonic decision accounting plus a bounded diagnostic ring. */
  readonly trace: ProbeTrace;
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

const pageFixtures = new WeakMap<Page, string>();

/**
 * Everything the probe vends except the grid reader, which is a function and cannot
 * cross the page boundary.
 *
 * Naming it is what makes `probe()` below checked. Without the annotation its shape is
 * inferred from a hand-written literal, so a field added to ConsoleProbe is simply
 * absent from every snapshot, the check that wanted it reads undefined, and the engine
 * gets blamed. That is the failure this harness exists to prevent.
 */
export type Snapshot = Omit<ConsoleProbe, 'text' | 'trace'>;

/** The engine's decision ring (newest last): why bursts died, wraps rode, styles moved. */
async function readTraceState(page: Page): Promise<ProbeTrace> {
  return page.evaluate(() => window.__ehPredict.trace);
}

export async function readTrace(page: Page): Promise<string[]> {
  return (await readTraceState(page)).entries.map((entry) => `${entry.text} @${entry.at}`);
}

/**
 * The monotonic sequence and death counters at this instant. The ring is per PAGE and a
 * sweep shares one page across apps, so a check charges an app only with later deaths.
 */
export async function traceMark(page: Page): Promise<ProbeTraceMark> {
  const trace = await readTraceState(page);
  return { sequence: trace.sequence, deaths: trace.deaths };
}

/** Every burst death the engine traced after `mark`. */
export async function resetsSince(page: Page, mark: ProbeTraceMark): Promise<string[]> {
  return burstDeathLinesSince(await readTraceState(page), mark);
}

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

export interface PaneBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export class ConsoleRig {
  private readonly pageErrors: string[] = [];
  private readonly pageContexts = new OwnedCleanups<Page>('console page context cleanup failed');
  private browserClosed = false;
  private managedReleased = false;
  private proxyStopped = false;
  private fixturesRemoved = false;
  private closePromise: Promise<void> | null = null;

  private constructor(
    private readonly browser: Browser,
    private readonly proxy: LatencyProxy,
    private readonly password: string,
    readonly container: string,
    private readonly managed: ManagedConsole | null,
    private readonly fixtures: ConsoleFixtures,
  ) {}

  static async open(opts: RigOptions): Promise<ConsoleRig> {
    // Interpolated rather than written inline: the template contains a space, and
    // bun's $ splits an inline one into two arguments.
    const format = '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}';
    const ip = (
      await $`docker inspect ${opts.container} --format ${format}`.quiet()
    ).text().trim();
    if (!ip) throw new Error(`container '${opts.container}' has no IP address`);

    const runId = `${process.pid.toString(36)}-${Date.now().toString(36)}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const managed = await ManagedConsole.detect(opts.container, runId);
    const fixtures = await deployConsoleFixtures(opts.container, runId);
    // A managed console binds loopback (the tunnel is its only front door), so the
    // delay line runs inside the container; self-host binds the bridge and the proxy
    // runs here, as it always has.
    let proxy: LatencyProxy;
    try {
      proxy = managed
        ? await LatencyProxy.startInContainer(opts.container, ip, fixtures.path, opts.downMs, opts.upMs)
        : await LatencyProxy.start(ip, CONSOLE_PORT, opts.downMs, opts.upMs);
    } catch (error) {
      try {
        await retryCleanup(fixtures.remove);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'latency proxy failed to start and the fixtures were not removed');
      }
      throw error;
    }
    log.info(`Console at ${ip}:${CONSOLE_PORT} via ${proxy.host}:${proxy.port} (${opts.downMs}ms down / ${opts.upMs}ms up)${managed ? ' [managed]' : ''}`);

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
    //
    // Signals belong to test-console-echo.ts, whose handler closes this browser itself in
    // closeOwned and then releases the managed view, stops the proxy and removes the
    // fixtures. Playwright's own SIGINT handler exits the process the moment the browser
    // is gone, which skipped those last three. Its exit hook stays installed either way,
    // so a harness that exits without closing the browser still takes it down.
    try {
      const browser = await chromium.launch({
        channel: 'chromium', headless: true, handleSIGINT: false, handleSIGTERM: false,
      });
      return new ConsoleRig(browser, proxy, opts.password, opts.container, managed, fixtures);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      let proxyStopped = false;
      try { await retryCleanup(proxy.stop); proxyStopped = true; } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      if (proxyStopped) {
        try { await retryCleanup(fixtures.remove); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], 'browser failed to launch and run-owned resources did not clean up');
      }
      throw error;
    }
  }

  /** A logged-in page with the engine armed and the probe installed. */
  async page(opts: PageOptions = {}): Promise<Page> {
    if (this.managed) await this.managed.activateWindow();
    const context = await this.browser.newContext({
      viewport: { width: opts.width ?? VIEWPORT.width, height: opts.height ?? VIEWPORT.height },
      deviceScaleFactor: opts.deviceScaleFactor ?? 1,
    });
    const closeContext = retryableCleanup(() => context.close());
    let page: Page | null = null;
    try {
      if (opts.mac) {
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
        });
      }
      if (this.managed) {
        // Managed consoles verify a platform JWT and have no password form. The page's
        // embedded mode gets that token over postMessage from the framing dashboard; a
        // top-level page is its own window.parent, so with ?parent=<its own origin> the
        // channel loops back onto the page and this listener answers it. The mint itself
        // happens here, off-page (no CORS, no credential in the renderer).
        const mint = this.managed.mintToken;
        await context.exposeFunction('__ehMintConsoleToken', mint);
        await context.addInitScript(() => {
          window.addEventListener('message', (ev) => {
            if (ev.source !== window || !ev.data || ev.data.type !== 'envhaven-console:token-request') return;
            (window as unknown as { __ehMintConsoleToken: () => Promise<string> }).__ehMintConsoleToken()
              .then((token) => window.postMessage({ type: 'envhaven-console:token', token }, location.origin))
              .catch(() => undefined); // the engine re-asks every 300ms
          });
        });
      }
      page = await context.newPage();
      this.pageContexts.add(page, closeContext);
      pageFixtures.set(page, this.fixtures.path);
      // An exception thrown out of the engine is a failure of whatever check was
      // running, whether or not that check thought to look for one.
      page.on('pageerror', (e) => this.pageErrors.push(e.message));

      const params = new URLSearchParams({ ...(opts.params ?? {}), echo: '1', probe: '1' });
      const base = `http://${this.proxy.host}:${this.proxy.port}`;
      if (this.managed) {
        params.set('parent', base); // the token shim above answers on this origin
        params.set('probeSession', this.managed.probeSession);
      }
      await page.goto(`${base}/__console/ui?${params}`);
      if (this.managed) await this.managed.activateWindow();
      if (!this.managed) {
        await page.fill('#password', this.password);
        await page.click('button[type=submit]');
      }
      await page.waitForFunction(
        () => window.__ehPredict && window.__ehPredict.safe === true,
        null,
        { timeout: 25000 },
      );
      // A tmux selection is session state. An operator can move it while the browser is
      // starting, so verify the immutable ID again after the socket has attached and
      // before this method gives any check a page it can type through.
      if (this.managed) {
        await this.managed.activateWindow();
        await page.waitForFunction(
          () => window.__ehPredict.safe === true,
          null,
          { timeout: 25000 },
        );
      }
      // The rig holds itself to the rule it hands the checks. Every one of them starts
      // from this page, so a page returned mid-repaint makes the first reading of whatever
      // runs next untrustworthy, and silently.
      if (!(await quiet(page, 1200))) {
        inconclusive('the console never settled after connecting, so no first reading can be trusted');
      }
      return page;
    } catch (error) {
      try {
        if (page) await this.closePage(page);
        else await closeContext();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'console page bootstrap failed and its context did not close');
      }
      throw error;
    }
  }

  /** Close the BrowserContext that owns a page; success releases it, failure remains retryable. */
  closePage(page: Page): Promise<void> {
    return this.pageContexts.close(page);
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

  /**
   * Whether this rig drives a managed workspace (platform-JWT console). The disconnect
   * surface reports a failed retry differently in the two modes: self-host's token
   * FETCH fails against a down console ('reconnect failed'), while managed's mint
   * succeeds and the SOCKET dies ('session disconnected' with the button standing).
   */
  isManaged(): boolean {
    return this.managed !== null;
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
   *
   * A managed workspace's base session is shared with the operator's own clients, so it
   * is never selected or killed. A fresh owned window is selected only in this run's
   * grouped view, which gives the check a fresh login shell without moving the operator.
   */
  async resetPane() {
    if (this.managed) {
      await this.managed.resetWindow();
    } else {
      await $`docker exec -u abc ${this.container} tmux kill-server`.quiet().nothrow();
    }
    const restart = await $`docker exec ${this.container} s6-svc -r /run/service/svc-console`.quiet().nothrow();
    if (restart.exitCode !== 0) throw new Error(`could not restart console: ${restart.stderr.toString().trim()}`);
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
    const result = await $`docker exec ${this.container} s6-svc -r /run/service/svc-console`.quiet().nothrow();
    if (result.exitCode !== 0) throw new Error(`could not restart console: ${result.stderr.toString().trim()}`);
  }

  /** Split the active test pane and return tmux's four-edge reading for the new pane. */
  async splitPane(axis: 'columns' | 'rows'): Promise<PaneBounds> {
    if (this.managed) await this.managed.activateWindow();
    const session = this.managed?.probeSession ?? 'console-view';
    const target = `=${session}:`;
    const flag = axis === 'columns' ? '-h' : '-v';
    const format = '#{pane_top}|#{pane_height}|#{pane_left}|#{pane_width}';
    const result = await $`docker exec -u abc -e HOME=/config ${this.container} tmux split-window ${flag} -l 50% -P -F ${format} -t ${target} -c /config/workspace`
      .quiet().nothrow();
    if (result.exitCode !== 0) throw new Error(`could not split ${axis}: ${result.stderr.toString().trim()}`);
    const values = result.text().trim().split('|').map(Number);
    if (values.length !== 4 || values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`tmux returned malformed pane geometry: ${JSON.stringify(result.text().trim())}`);
    }
    const [top, height, left, width] = values as [number, number, number, number];
    if (height < 1 || width < 1) throw new Error(`tmux returned empty pane geometry: ${JSON.stringify(values)}`);
    return { top, bottom: top + height, left, right: left + width };
  }

  /** Keep the active test pane and remove its sibling panes. */
  async collapsePanes(): Promise<void> {
    if (this.managed) await this.managed.activateWindow();
    const session = this.managed?.probeSession ?? 'console-view';
    const result = await $`docker exec -u abc -e HOME=/config ${this.container} tmux kill-pane -a -t ${`=${session}:`}`
      .quiet().nothrow();
    if (result.exitCode !== 0) throw new Error(`could not collapse test panes: ${result.stderr.toString().trim()}`);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeOwned().finally(() => { this.closePromise = null; });
    return this.closePromise;
  }

  private async closeOwned() {
    const errors: unknown[] = [];
    try {
      await this.pageContexts.closeAll();
    } catch (error) {
      errors.push(error);
    }
    if (!this.browserClosed) {
      try {
        await this.browser.close();
        this.browserClosed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (!this.managedReleased) {
      try {
        await this.managed?.release();
        this.managedReleased = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (!this.proxyStopped) {
      try {
        await this.proxy.stop();
        this.proxyStopped = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (!this.fixturesRemoved && this.proxyStopped) {
      try {
        await this.fixtures.remove();
        this.fixturesRemoved = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'console rig cleanup failed');
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** One read of everything the probe vends, except the grid reader. */
export async function probe(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const p = window.__ehPredict;
    return {
      safe: p.safe, app: p.app, words: p.words, row: p.row, col: p.col, rows: p.rows, cols: p.cols, baseY: p.baseY,
      top: p.top, bottom: p.bottom, left: p.left, right: p.right,
      quiet: p.quiet, inputLen: p.inputLen, fresh: p.fresh, owning: p.owning, rtt: p.rtt,
      burst: p.burst, reflow: p.reflow, wrap: p.wrap, box: p.box, hold: p.hold, edge: p.edge, pend: p.pend,
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

/** Prove that the named process is on an editable composer, then restore its empty draft. */
export async function composerInputProbe(page: Page, app: string): Promise<string | null> {
  const start = await probe(page);
  await page.keyboard.type('x', { delay: 12 });
  await settle(page, 6000);
  if (!(await quiet(page, 400, 6000))) return 'the composer probe never settled';
  const entered = await probe(page);
  if (entered.app !== app || entered.col !== start.col + 1) {
    return `the pane did not accept a composer probe at column ${start.col}`;
  }

  await page.keyboard.press('Backspace');
  await settle(page, 6000);
  if (!(await quiet(page, 400, 6000))) return 'clearing the composer probe never settled';
  const cleared = await probe(page);
  if (cleared.app !== app || cleared.col !== start.col) {
    return `the composer probe did not clear back to column ${start.col}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page helpers (moved from console-checks/keys.ts; they read only the probe and the
// keyboard, the same layer as probe/quiet/settle)
// ---------------------------------------------------------------------------

/**
 * Wait for a page predicate, and skip the check if it never holds.
 *
 * The argument is typed loosely on purpose. Playwright declares the callback as
 * taking `Unboxed<Arg>`, which it cannot prove equal to a caller's own type
 * parameter, so a generic wrapper never typechecks. Every argument passed here is a
 * plain serialisable value, which is the case where the two coincide.
 */
export async function waitFor(
  page: Page,
  fn: (arg: any) => boolean,
  arg: unknown,
  ms: number,
  reason: string,
) {
  try {
    await page.waitForFunction(fn, arg, { timeout: ms });
  } catch {
    inconclusive(reason);
  }
}

/** Wait for the gate to re-arm. Nothing is predicted while it is down. */
export function waitSafe(page: Page, ms: number, reason: string) {
  return waitFor(page, () => window.__ehPredict.safe === true, null, ms, reason);
}

/** Wait for the wire to fall silent, and skip the check if it never does. */
export async function quietOrSkip(page: Page, what: string, ms = 8000) {
  if (!(await quiet(page, 600, ms))) inconclusive(`the wire never settled after ${what}`);
}

/** Whether the pane is back at a shell within `ms`. */
export function atShell(page: Page, ms: number): Promise<boolean> {
  return page.waitForFunction(() => window.__ehPredict.app === 'zsh', null, { timeout: ms })
    .then(() => true, () => false);
}

/**
 * Clear the line and start a fresh, proven one.
 *
 * The engine only claims a prompt the server has drawn, so a check that starts
 * mid-line exercises the recovery path instead of the one it is named after. Enter
 * re-proves the floor.
 */
export async function freshLine(page: Page) {
  await page.keyboard.press('Control+C');
  await Bun.sleep(700);
  await page.keyboard.press('Enter');
  await waitSafe(page, 15000, 'the gate never re-armed on a fresh prompt');
  await Bun.sleep(900);
}

/** Type, then read the engine back before the echo can have arrived. */
export async function typeAndRead(page: Page, text: string, delay = 15) {
  await page.keyboard.type(text, { delay });
  return probe(page);
}

/** Press, then read the engine back before the echo can have arrived. */
export async function pressAndRead(page: Page, key: string) {
  await page.keyboard.press(key);
  return probe(page);
}

/** The engine's burst, or a failed check naming what it declined to predict. */
export function burstOf(p: { burst: Burst | null }, what: string): Burst {
  const b = p.burst;
  assert(b !== null, `${what}: the engine predicted nothing`);
  return b;
}

/** Put an application in the pane and wait until the engine agrees it is there. */
export async function launchApp(page: Page, name: AppName) {
  const spec = APPS[name];
  await page.keyboard.type(appCommand(spec, pageFixtures.get(page)), { delay: 4 });
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

/**
 * Return the pane to a shell. Two interrupts: the first leaves the composer, the second
 * the app.
 *
 * The draft is killed first and Escape is kept for the second attempt, not the first.
 * On an EMPTY composer Claude Code 2.1 turns Escape into its session manager ("your
 * conversation moved to the background"), where the interrupt pair no longer quits; the
 * next check's launch command was then typed into that manager as a new session, and
 * every application after it "never took the pane". Sent after a failed pair, Escape
 * closes whatever dialog swallowed it, and the pair is tried again.
 */
export async function teardownApp(page: Page) {
  const interrupt = async () => {
    for (const _ of [0, 1]) {
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyC');
      await page.keyboard.up('Control');
      await Bun.sleep(400);
    }
  };
  await page.keyboard.press('Control+u');
  await Bun.sleep(200);
  await interrupt();
  if (await atShell(page, 8000)) return;
  await page.keyboard.press('Escape');
  await Bun.sleep(300);
  await interrupt();
  if (await atShell(page, 8000)) return;
  // An application that ignores the interrupt gets the key its own row names, and only
  // while the pane still reports it: at the shell's own empty prompt ^D would close the
  // pane, and every later check with it.
  const holding = await page.evaluate(() => window.__ehPredict.app);
  const spec = Object.values(APPS).find((s) => s.paneApp === holding);
  if (spec?.leave) {
    await page.keyboard.press(spec.leave);
    await atShell(page, 8000);
  }
}

// ---------------------------------------------------------------------------
// Sweeping the roster
// ---------------------------------------------------------------------------

/** What one row of a sweep says about itself; the sweep answers for every row at the end. */
export interface Verdict {
  /** The guarded behaviour broke in this application. */
  fail(message: string): void;
  /** The check never reached the state it guards in this application; the body may go on. */
  skip(reason: string): void;
  /** What passed, for the summary line; surfaces only when no row failed or skipped. */
  pass(note: string): void;
}

/**
 * Drive one check through several applications in turn: launch each (or, for a `null`
 * row, wait for the shell), run `body`, and return the pane to the shell before the
 * next. One helper, so every check that sweeps the roster shares one skip/fail
 * discipline instead of restating it:
 *
 *   - an application that never takes the pane is a skip naming what held it instead;
 *   - an Inconclusive thrown inside the body (waitSafe, quietOrSkip) is a skip for THAT
 *     application and the sweep goes on, so a wire that stalls on the fourth app cannot
 *     discard failures already found on the first three: a failure outranks a skip;
 *   - any other throw inside the body (burstOf's assert) is a failure for that
 *     application, likewise kept, so a red run names every broken row rather than the
 *     first.
 *
 * Messages are prefixed with the application's name. After the last row the page is
 * closed, failures fail the check, skips make it inconclusive, and the notes come back
 * for the summary line. `before` runs ahead of each launch, on the pane the previous row
 * handed back (wrapkeep clears the screen so a floating composer opens with room below
 * it). Readiness after the launch belongs to the body: how long a composer takes to be
 * trustworthy differs per check, and so does what to do when it never is.
 */
export async function sweep<A extends AppName | null>(
  rig: ConsoleRig,
  page: Page,
  rows: readonly A[],
  body: (app: A, v: Verdict) => Promise<void>,
  before?: () => Promise<void>,
): Promise<string[]> {
  const bad: string[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  try {
    for (const app of rows) {
      const name = app ?? 'zsh';
      const v: Verdict = {
        fail: (m) => { bad.push(`${name}: ${m}`); },
        skip: (m) => { skipped.push(`${name}: ${m}`); },
        pass: (m) => { notes.push(m); },
      };
      try {
        if (before) await before();
        if (app) {
          await launchApp(page, app);
        } else if (!(await atShell(page, 20000))) {
          v.skip('the pane never came back to a shell');
          continue;
        }
        await body(app, v);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof Inconclusive) {
          // Which application DID hold the pane is most of the diagnosis.
          const holding = await probe(page).then((p) => p.app, () => '?');
          v.skip(`${message}, pane is holding ${JSON.stringify(holding)}`);
        } else {
          v.fail(message);
        }
      } finally {
        // The next row has to find the pane the way this one found it, including on the
        // paths that gave up early. A composer left running is a terminal the next app
        // does not expect, and it measures whatever it finds.
        if (app) await teardownApp(page).catch(() => undefined);
        else await page.keyboard.press('Control+u').catch(() => undefined);
        await Bun.sleep(800);
      }
    }
  } finally {
    await rig.closePage(page);
  }
  assert(bad.length === 0, bad.join('; '));
  if (skipped.length) inconclusive(skipped.join('; '));
  return notes;
}

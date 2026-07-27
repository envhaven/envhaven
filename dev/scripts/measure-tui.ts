#!/usr/bin/env bun
// Composer geometry of the AI CLIs, measured against real terminals.
//
// console/ui/terminal.html predicts where a TUI's input box will wrap, so a
// keystroke can be painted before the round trip instead of after it. Those
// predictions come from a table of measured constants (`var TUI`), and a
// constant measured once is a constant that goes stale: these applications
// redesign their composers between releases. This script is how the table is
// written and how drift is caught.
//
//   bun dev/scripts/measure-tui.ts                # check every row in the table
//   bun dev/scripts/measure-tui.ts --print codex  # measure and print one row
//
// It drives each application in tmux on its OWN socket (never the default one,
// which carries the workspace session), types one character at a time and reads
// the cursor after each, so the wrap column is OBSERVED rather than
// reconstructed from a settled grid. Every field is measured at two terminal
// widths, because `pad` claims to be a margin and a margin has to hold at any
// width.
//
// Requires a running workspace container: `bun dev/scripts/start.ts`.
import { readFileSync } from 'fs';
import { join } from 'path';
import { $ } from 'bun';
import { REPO_ROOT, loadConfig, log, formatTestSummary, isContainerRunning } from './lib';

const PAGE = join(REPO_ROOT, 'console/ui/terminal.html');
const WIDTHS = [120, 100];
const ROWS = 30;
const SETTLE_MS = 160;   // one keystroke's render; Ink and Bubbletea both repaint whole frames
const BOOT_MS = 25000;   // budget for a cold TUI to draw its composer

interface Row {
  pad: number;
  indent: number;
  pull: boolean;
  down: boolean;
  prompt: string | null;
}

// The table in terminal.html is the single source of truth; this reads it rather
// than restating it. `new Function` evaluates the object literal exactly as the
// browser will, so \u escapes and comments need no parser of our own.
function tableFromPage(): Record<string, Row> {
  const html = readFileSync(PAGE, 'utf8');
  const m = html.match(/\n {2}var TUI = (\{[\s\S]*?\n {2}\});/);
  if (!m) throw new Error(`Could not find "var TUI = {...}" in ${PAGE}`);
  return new Function(`return ${m[1]}`)() as Record<string, Row>;
}

// rowIsPrompt treats U+0020 and U+00A0 as the same cell, because Claude Code
// draws one in its live composer and the other in plain redraws. Compare the
// way the engine compares.
const norm = (s: string) => s.replace(/ /g, ' ');
// promptShaped in terminal.html: only chrome is learnable, so only chrome is
// worth seeding. A prefix outside this envelope must be null in the table.
const shaped = (p: string) => p.length > 0 && p.length <= 4 && /\S/.test(p) && !/[0-9A-Za-z]/.test(p);

class Pane {
  constructor(private container: string, private sock: string) {}

  private run(args: string[]) {
    return $`docker exec -u abc -e HOME=/config ${this.container} tmux -L ${this.sock} ${args}`
      .quiet()
      .nothrow();
  }

  // Never trimmed: a pane capture is positional, and trimming it drops the blank
  // rows above the composer and shifts every row index under the cursor.
  async tmux(...args: string[]): Promise<string> {
    return (await this.run(args)).text();
  }

  async start(app: string, cols: number) {
    await this.run(['kill-server']);
    const r = await this.run([
      'new-session', '-d', '-s', 'm', '-x', String(cols), '-y', String(ROWS),
      '-c', '/config/workspace', `/bin/zsh -lc 'exec ${app}'`,
    ]);
    if (r.exitCode !== 0) throw new Error(`could not start ${app}: ${r.stderr.toString().trim()}`);
  }

  async stop() {
    await this.run(['kill-server']);
  }

  async cursor(): Promise<[number, number]> {
    const out = await this.tmux('display', '-p', '-t', 'm', '#{cursor_x} #{cursor_y}');
    const [x, y] = out.trim().split(/\s+/).map(Number);
    return [x, y];
  }

  // Cursor and screen from ONE tmux invocation, so the row under the cursor is
  // the row that was under it: a TUI repainting between two calls otherwise
  // hands back a cursor from one frame and a screen from the next.
  async snapshot(): Promise<{ x: number; y: number; rows: string[] }> {
    const out = await this.tmux('display', '-p', '-t', 'm', '#{cursor_x} #{cursor_y}', ';',
                                'capture-pane', '-p', '-t', 'm');
    const lines = out.split('\n');
    const [x, y] = (lines[0] ?? '').trim().split(/\s+/).map(Number);
    return { x, y, rows: lines.slice(1) };
  }

  async screen(): Promise<string> {
    return (await this.tmux('capture-pane', '-p', '-t', 'm'))
      .split('\n').filter((l) => l.trim()).slice(-6).join('\n      ');
  }

  async type(text: string) {
    await this.run(['send-keys', '-l', '-t', 'm', text]);
  }

  async key(name: string) {
    await this.run(['send-keys', '-t', 'm', name]);
  }

  // Ready means "a character typed here lands in an input box". Probing for that
  // directly beats waiting on any one application's splash: a first-run trust
  // dialog swallows the keystroke instead, and Enter is what dismisses those.
  async waitForComposer(): Promise<void> {
    const deadline = Date.now() + BOOT_MS;
    while (Date.now() < deadline) {
      await Bun.sleep(1500);
      const [x0] = await this.cursor();
      await this.type('x');
      await Bun.sleep(SETTLE_MS * 3);
      const [x1] = await this.cursor();
      if (x1 === x0 + 1) {
        await this.key('BSpace');
        await Bun.sleep(SETTLE_MS * 3);
        return;
      }
      // Backspace first: if the composer was merely slow and took the probe after
      // all, Enter would submit it. Enter then dismisses a dialog or does nothing.
      await this.key('BSpace');
      await this.key('Enter');
    }
    // Almost always a sign-in wall rather than a slow boot, so show the screen:
    // which application wants credentials is the whole of the diagnosis.
    throw new Error(
      `no composer accepted a keystroke within ${BOOT_MS / 1000}s. Screen:\n      ${await this.screen()}`
    );
  }
}

// Type up to a column short of where the wrap is expected, then walk in one
// character at a time until the cursor proves the wrap. The expectation only
// aims the probe: a wrong one costs extra steps and still reports the truth.
async function measure(container: string, app: string, cols: number, expectPad: number | null): Promise<Row> {
  const pane = new Pane(container, `ehmeasure-${app}-${cols}`);
  try {
    await pane.start(app, cols);
    await pane.waitForComposer();

    const empty = await pane.snapshot();
    const promptCol = empty.x;
    const promptRaw = (empty.rows[empty.y] ?? '').slice(0, promptCol);

    // Land on a word boundary a short walk before the expected wrap, so the
    // characters stepped in below are exactly the word that will move.
    const target = expectPad === null ? Math.floor(cols / 2) : cols - expectPad;
    const bulk = 'abcde '.repeat(Math.ceil(cols / 6) + 2).slice(0, Math.max(0, target - promptCol - 6));
    const upToSpace = bulk.slice(0, bulk.lastIndexOf(' ') + 1);
    if (upToSpace) {
      await pane.type(upToSpace);
      await Bun.sleep(SETTLE_MS * 4);
    }

    let [px, py] = await pane.cursor();
    // The walk is bounded only to stop a broken run: any wrap column the engine
    // would accept is reachable well inside it.
    for (let k = 1; k <= cols; k++) {
      await pane.type('abcdefghijklmnopqrstuvwxyz'[(k - 1) % 26]);
      await Bun.sleep(SETTLE_MS);
      const [x, y] = await pane.cursor();
      if (y !== py || x < px) {
        // A hard wrap drops the cursor to column 0 of the next row and moves no
        // word; a word wrap lands it at the continuation indent plus the word.
        // indent and down are normalised the way learnWrap normalises them: a
        // hard wrap always takes the next row, so its direction carries no
        // information and the engine stores false rather than a fact it will
        // never read.
        const pull = x !== 0;
        return {
          pad: cols - px,
          indent: pull ? x - k : 0,
          pull,
          down: pull && y > py,
          prompt: shaped(norm(promptRaw)) ? norm(promptRaw) : null,
        };
      }
      px = x;
      py = y;
    }
    throw new Error(`typed ${cols} characters past column ${target} without wrapping`);
  } finally {
    await pane.stop();
  }
}

function describe(r: Row): string {
  const p = r.prompt === null ? 'null' : `'${r.prompt.replace(/./gu, (c) =>
    c.codePointAt(0)! < 0x7f ? c : `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`)}'`;
  return `{ pad: ${r.pad}, indent: ${r.indent}, pull: ${r.pull}, down: ${r.down}, prompt: ${p} }`;
}

const config = loadConfig();
const args = process.argv.slice(2);
const printOnly = args.includes('--print');
const container = args.find((a) => a.startsWith('--container='))?.split('=')[1] ?? config.containerName;
const table = tableFromPage();
const apps = args.filter((a) => !a.startsWith('--'));

log.header('TUI composer geometry');

if (!(await isContainerRunning(container))) {
  log.error(`Container '${container}' not running`);
  log.info('Start it with: bun dev/scripts/start.ts');
  process.exit(1);
}

const targets = apps.length ? apps : Object.keys(table);
log.info(`Container: ${container}`);
log.info(`Widths: ${WIDTHS.join(', ')} columns\n`);

let passed = 0;
let failed = 0;

for (const app of targets) {
  const want = Object.prototype.hasOwnProperty.call(table, app) ? table[app]! : null;
  let measured: Row[];
  try {
    measured = [];
    for (const cols of WIDTHS) measured.push(await measure(container, app, cols, want?.pad ?? null));
  } catch (e) {
    log.error(`${app}: ${(e as Error).message}`);
    failed++;
    continue;
  }

  const [a, b] = measured as [Row, Row];
  // pad is the claim that survives a resize; everything else must simply agree.
  const stable = (['pad', 'indent', 'pull', 'down', 'prompt'] as const).filter((k) => a[k] !== b[k]);
  if (stable.length) {
    log.error(`${app}: differs between ${WIDTHS[0]} and ${WIDTHS[1]} columns on ${stable.join(', ')}`);
    log.info(`  ${WIDTHS[0]}: ${describe(a)}`);
    log.info(`  ${WIDTHS[1]}: ${describe(b)}`);
    log.info('  Not a constant margin at every width: this app cannot take a row.');
    failed++;
    continue;
  }

  if (printOnly || !want) {
    log.info(`${app}: ${describe(a)}`);
    if (!want && !printOnly) log.info('  (no row in the table; add it above if this app should be seeded)');
    passed++;
    continue;
  }

  const wrong = (['pad', 'indent', 'pull', 'down', 'prompt'] as const).filter((k) => a[k] !== want[k]);
  if (wrong.length === 0) {
    log.success(`${app}: ${describe(a)}`);
    passed++;
  } else {
    log.error(`${app}: table is stale on ${wrong.join(', ')}`);
    log.info(`  table:    ${describe(want)}`);
    log.info(`  measured: ${describe(a)}`);
    log.info(`  Replace the row in console/ui/terminal.html with the measured one.`);
    failed++;
  }
}

formatTestSummary(passed, failed);
process.exit(failed === 0 ? 0 : 1);

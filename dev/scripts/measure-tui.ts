#!/usr/bin/env bun
// Composer geometry of the AI CLIs, measured against real terminals.
//
// console/ui/assets/eh-predictor.js predicts where a TUI's input box will wrap, so a
// keystroke can be painted before the round trip instead of after it. Those
// predictions come from a model table of measured constants (`var TUI`), and a
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
import { $ } from 'bun';
import { loadConfig, log, formatTestSummary, isContainerRunning } from './lib';
import { type Seed, consoleModel, tuiTable } from './lib/engine';
import { APPS, type AppSpec } from './lib/console-apps';
import toolDefs from '../../tool-definitions.json';

const WIDTHS = [120, 100];
const ROWS = 30;
// The characters the walk steps in with, one per keystroke. Distinct letters, so the row
// they land on can be searched for exactly the run that was typed.
const WALK = 'abcdefghijklmnopqrstuvwxyz';
const SETTLE_MS = 160;   // one keystroke's render; Ink and Bubbletea both repaint whole frames
const SETTLE_TRIES = 24; // frames compared before a pane that never settles hands back its last reading
const BOOT_MS = 25000;   // budget for a cold TUI to draw its composer

// What one measurement reports. `seed` is exactly the model's table row, the part that
// gets pasted into `var TUI`; `chrome` and `ink` are measured for a different reason and
// never seeded.
//
// `pad` and `indent` are WIDTHS — how many columns the application keeps to itself at
// each end. `left` and `right` are what actually occupies those columns: a margin of
// blanks and a drawn border behave differently, and only the second one has to be
// stripped before a row can be read for its text. They are not table columns, because
// the engine reads a border off the pane structurally rather than being told about one
// (see textStart/textEnd in the console model); measuring them is how the claim that `pad`
// decomposes into gutter, border and margin gets checked rather than assumed.
interface Row {
  seed: Seed;
  chrome: { left: string; right: string };
  ink: string | null;
}

/** The keys of `a` and `b` that differ. One comparison for the seed and for the chrome. */
function differing<T extends object>(a: T, b: T): (keyof T)[] {
  return (Object.keys(a) as (keyof T)[]).filter((k) => a[k] !== b[k]);
}

// promptAt in the engine treats U+0020 and U+00A0 as the same cell, because Claude
// Code draws one in its live composer and the other in plain redraws. Compare the
// way the engine compares.
const norm = (s: string) => s.replace(/\u00a0/g, ' ');
// Trailing blanks off a captured row. Not trimEnd(): that also strips the U+00A0 Claude
// Code draws in its composer, which is a cell, not padding.
const rtrim = (s: string) => s.replace(/ +$/, '');

// The exact model asset's row readers, loaded through lib/engine.ts. borderSkip is the
// column where a bordered composer's left chrome (one
// box glyph and the blanks inside it) ends, 0 for an unbordered row; textEnd is where a
// row's text ends once one trailing box glyph and the blanks inside it are stripped, so
// the space test below reads text, not chrome; promptShaped is the learnable-prompt
// envelope, and a prefix outside it must be null in the table. A renamed helper aborts
// the sweep here instead of measuring against a stale copy.
const { borderSkip, textEnd, promptShaped } = consoleModel();

// A keystroke landing SOMEWHERE is not a keystroke landing in the composer. Most of
// these applications answer a cold start with a sign-in wall, and the ones that simply
// refuse the keystroke are already caught by waitForComposer's timeout. The dangerous
// wall is the one that is itself a line editor: gemini's device flow ended at a bare
// `Enter the authorization code:` readline, which takes the probe, wraps at the screen
// edge like any shell, and measures cleanly as a hard-wrapping composer with no prompt.
// Not one field of that row was true of gemini's real composer, and it measured green
// twice before a human looked at the screen.
//
// Every pattern here was taken from a wall this script actually hit rather than from a
// guess about what one might say. `strict` marks the ones only a sign-in screen ever
// says, and those are the only patterns consulted once something HAS accepted a
// keystroke: a false match there refuses a measurement that would have been fine.
// `/api key/i` is the cautionary case, and is deliberately not strict: pi and hermes
// both mention an API key in the hint line under their working composers, and while it
// was strict both stopped being measurable. The rest run only when nothing accepted a
// keystroke at all, where the measurement has already failed and the only question left
// is how to describe it: a miss there files a sign-in screen as a broken composer.
const WALLS: { re: RegExp; strict: boolean }[] = [
  { re: /oauth\/authorize/i, strict: true },           // codex
  { re: /enter (?:the )?api key/i, strict: true },      // vibe
  { re: /waiting for authentication/i, strict: true },  // droid
  { re: /sign in with/i, strict: true },                // codex's device-code hint
  { re: /api key/i, strict: false },                    // qwen's "API key cannot be empty" modal
  { re: /press r to retry/i, strict: false },           // vibe, once its browser hand-off has failed
  { re: /select login method/i, strict: false },        // agy
  { re: /finish signing in/i, strict: false },          // grok's device flow
  { re: /trust this folder|trust the contents/i, strict: false }, // claude's and codex's first-run prompts
  // No bare `log in` / `sign in`: Claude Code's WORKING composer carries the hint
  // `Not logged in · Run /login` under an API-key session, and a never-wrapping
  // regression in it would be filed as a sign-in wall and exit green.
];

// A tool nobody has signed into cannot be measured, and that is not the same thing as a
// tool that measured wrong. The first is a fact about this container; the second is a
// fact about the model's table, and only the second should turn a sweep red. Without the
// distinction, `bun dev/scripts/measure-tui.ts` is red on any machine where four of the
// seventeen tools have never been logged in, which is every machine — and a check that is
// always red is one nobody reads.
class Unmeasurable extends Error {}

// Tools in the image with no terminal composer to measure. Not a skip-for-now: there is
// nothing here for the predictive echo to seed, ever, so the sweep does not drive them at
// all rather than reporting them as something that went wrong.
const NOT_A_COMPOSER: Record<string, string> = {
  openclaw: 'not driven from the terminal',
  hermes: 'not driven from the terminal',
};

// Applications that ARE measured and deliberately have no table row, with the reason. A
// sweep that is permanently red about a decision already taken is one nobody reads, so a
// declared exception reports as expected — but only while it stays true. If one of these
// measures the same at both widths it has become seedable, and that is news: it fails,
// asking for the row it can now have. The declaration is load-bearing in both directions.
const NO_ROW: Record<string, string> = {
  opencode:
    'two composers — a centred splash box whose wrap column tracks cols/2, then a ' +
    'bottom-anchored one whose pad changes again when its sidebar opens. No single row ' +
    'describes both, and seeding either mispredicts in the other.',
};

/** One settled reading of the pane: where the cursor is, and every row as captured. */
interface Frame {
  x: number;
  y: number;
  rows: string[];
}

/** The last six inked rows of a capture, laid out for a diagnostic. */
function tail(screen: string): string {
  return screen.split('\n').filter((l) => l.trim()).slice(-6).join('\n      ');
}

class Pane {
  constructor(private container: string, private sock: string) {}

  // tmux runs through as-abc, with the environment every workspace process gets, because the
  // server a new-session starts passes its environment to the measured app, and root's PATH
  // (what a bare docker exec gets) holds none of the tool directories.
  private run(args: string[]) {
    return $`docker exec ${this.container} /usr/local/lib/envhaven/as-abc tmux -L ${this.sock} ${args}`
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
    // The launch command has one owner per application: the console harness's
    // registry, which already carries the stub credentials a composer needs to
    // draw unauthenticated (goose exits at launch with no provider configured).
    // A tool with no row there launches bare, exactly as before. `env` absorbs
    // the assignments those rows carry: zsh's exec rejects a leading VAR=val.
    const spec = (APPS as Record<string, AppSpec>)[app];
    const r = await this.run([
      'new-session', '-d', '-s', 'm', '-x', String(cols), '-y', String(ROWS),
      // Interactive, so ~/.zshrc and the EnvHaven additions apply exactly as they do
      // for a user: the aliases that add permission flags change what the app draws.
      // The welcome auto-attach is what -i would also run, hence the skip.
      '-c', '/config/workspace', `ENVHAVEN_SKIP_WELCOME=1 /bin/zsh -ic 'exec env ${spec?.command ?? app}'`,
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
  async snapshot(): Promise<Frame> {
    // -N keeps the trailing blanks. tmux trims them by default, and both ends of the
    // composer are read out of these rows: an empty composer whose prompt separator is
    // an ordinary space (Antigravity's `> `) has that space AS its trailing blank, so a
    // trimmed read hands back a one-cell prompt and seeds the text floor a column short.
    const out = await this.tmux('display', '-p', '-t', 'm', '#{cursor_x} #{cursor_y}', ';',
                                'capture-pane', '-pN', '-t', 'm');
    const lines = out.split('\n');
    const [x, y] = (lines[0] ?? '').trim().split(/\s+/).map(Number);
    return { x, y, rows: lines.slice(1) };
  }

  // One row WITH the escape sequences tmux re-serialises its grid into. It is the only
  // capture that shows what colour an application ASKED for, as opposed to what a
  // renderer resolved, and asking is the thing the predictor has to match.
  //
  // One row at a time (`-S y -E y`), not a slice of a whole-pane capture. tmux writes
  // colour as deltas against a cell it carries from the previous line and never re-emits
  // (cmd-capture-pane.c passes one `grid_cell` through every line of the loop), so a row
  // read out of a full capture starts from a default the application never set, and any
  // colour still in effect from the row above reads as `default`. A single-line capture
  // starts that carry fresh.
  async escRow(y: number): Promise<string> {
    return (await this.tmux('capture-pane', '-e', '-pN', '-S', String(y), '-E', String(y), '-t', 'm'))
      .split('\n')[0] ?? '';
  }

  // A tmux reading is only worth believing once the application has stopped drawing.
  // Ink and Bubbletea repaint the WHOLE frame on every keystroke, and a sample caught
  // mid-repaint has a cursor parked wherever the paint had got to — which reads as a wrap
  // that never happened. Measured before this existed: codex reported a continuation
  // indent of -7 at 120 columns and -5 at 100, and gemini a pad of 8 with an indent of 111
  // and the entire typed run as its left-hand chrome. None of those are composer
  // geometries; each is one frame of a repaint, reported as fact.
  //
  // So a reading is taken twice and counts only when the two agree — cursor AND screen,
  // because a frame can land the cursor back where it was while the rows are still
  // moving. SETTLE_TRIES bounds it: an application that never settles (a spinner beside the
  // composer) hands back its last reading rather than hanging the sweep, and the checks
  // downstream catch what that produces.
  async settled(): Promise<Frame> {
    await Bun.sleep(SETTLE_MS); // never pair two frames from before the keystroke
    let prev = await this.snapshot();
    for (let i = 0; i < SETTLE_TRIES; i++) {
      await Bun.sleep(SETTLE_MS);
      const next = await this.snapshot();
      if (next.x === prev.x && next.y === prev.y && next.rows.join('\n') === prev.rows.join('\n')) {
        return next;
      }
      prev = next;
    }
    return prev;
  }

  async type(text: string) {
    await this.run(['send-keys', '-l', '-t', 'm', text]);
  }

  async key(name: string) {
    await this.run(['send-keys', '-t', 'm', name]);
  }

  // Refuse the measurement when the pane is showing a sign-in screen rather than a
  // composer. `accepted` says whether anything took a keystroke: once something has, only
  // the strict patterns count, because a composer's hint line may mention an API key (see
  // WALLS). Returns the screen it captured, so a caller that needs it does not re-capture.
  async refuseWall(accepted: boolean, context: string): Promise<string> {
    const screen = await this.tmux('capture-pane', '-p', '-t', 'm');
    const wall = WALLS.find((w) => (accepted ? w.strict : true) && w.re.test(screen));
    if (wall) {
      throw new Unmeasurable(
        `${context} (matched ${wall.re}). Log this tool in inside the container and ` +
        `measure again. Screen:\n      ${tail(screen)}`,
      );
    }
    return screen;
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
        await this.refuseWall(true, 'a sign-in wall took the keystroke, not a composer');
        return;
      }
      // Nothing took the probe. Before pressing anything else, look at what is on
      // screen: a sign-in MENU refuses letters exactly the way a slow composer does, and
      // the Enter below is a button press on it. Measured on droid, which opens on
      // `> Login / Exit` — the probe pressed Login and started a device-code flow, and
      // whatever took keystrokes after that got measured as if it were a composer.
      // Nothing has been accepted at all here, so every pattern applies (see WALLS).
      await this.refuseWall(false, 'not signed in: nothing accepted a keystroke and the pane is showing a sign-in screen');
      // Backspace first: if the composer was merely slow and took the probe after
      // all, Enter would submit it. Enter then dismisses a dialog or does nothing.
      await this.key('BSpace');
      await this.key('Enter');
    }
    // Almost always a sign-in wall rather than a slow boot, so show the screen:
    // which application wants credentials is the whole of the diagnosis. The wall is
    // tested here as well as above because a tool can refuse the probe keystroke
    // outright — qwen sits on a modal that swallows it, and vibe on a browser hand-off —
    // and reporting those as "no composer" put four sign-in screens in the failure column.
    const screen = await this.refuseWall(false, 'not signed in: a sign-in wall is holding the pane');
    // Nothing on screen and nothing accepting input: the application is not running at
    // all. `amp` does this on a host without AVX2, where it dies on SIGILL before it
    // draws anything.
    const cmd = (await this.tmux('display', '-p', '-t', 'm', '#{pane_current_command}')).trim();
    if (!screen.trim()) {
      throw new Unmeasurable(
        `nothing was drawn and no keystroke was taken; the pane is running ` +
        `${JSON.stringify(cmd)}. The application did not start.`,
      );
    }
    throw new Error(
      `no composer accepted a keystroke within ${BOOT_MS / 1000}s. Screen:\n      ${tail(screen)}`
    );
  }
}

// The SGR foreground in effect at one column of a captured row, as a short descriptor:
// `default` for text the application left in the terminal's own colour, `256:235` /
// `ansi4` / `rgb:r,g,b` for one it chose, and a `+dim` suffix for SGR 2.
//
// This is the fact a predicted character's COLOUR turns on, and it is the one thing here
// that is measured but must never become a table column. A colour is a fact about the
// application AND the theme it is being drawn under — grok picks a different palette
// against a light terminal than a dark one — so a seeded colour would be wrong for half
// the users. The engine learns it at runtime, from the application's own echo. What this
// answers is the narrower question a new tool's row needs: does this application draft in
// the default foreground, in which case the terminal's colour is right for its very first
// keystroke, or in one of its own, in which case the predictor has to read the row.
//
// The escape-stripped text is checked against the plain capture up to the column being
// read, so a row whose sequences were not walked correctly reports nothing rather than a
// colour from the wrong cell.
// What `capture-pane -e` writes besides text: CSI sequences (colours end in `m`), an
// OSC 8 hyperlink, and the raw SO/SI bytes of a charset change. They are tmux's own
// re-serialisation of its grid, not a replay of what the application sent.
const SGR_TOKEN = /\x1b\[[0-9;:]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x0e\x0f]|[\s\S]/gu;
function inkAt(esc: string, col: number, plain: string): string | null {
  let fg = 'default';
  let dim = false;
  const chars: string[] = [];
  const fgs: string[] = [];
  for (const m of esc.matchAll(SGR_TOKEN)) {
    const tok = m[0];
    const c0 = tok.charCodeAt(0);
    if (c0 === 0x0e || c0 === 0x0f) continue;
    if (c0 === 0x1b) {
      if (!tok.endsWith('m')) continue;
      const codes = (tok.slice(2, -1) || '0').split(';').map((v) => Number(v || 0));
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k];
        if (c === 0) { fg = 'default'; dim = false; }
        else if (c === 2) dim = true;
        else if (c === 22) dim = false;
        else if (c === 39) fg = 'default';
        else if (c >= 30 && c <= 37) fg = `ansi${c - 30}`;
        else if (c >= 90 && c <= 97) fg = `ansi${c - 90 + 8}`;
        // 38 (foreground), 48 (background) and 58 (underline) all carry a colour whose
        // selector is a 5 or a 2; only the foreground is recorded, but the others'
        // parameters are consumed too, or a background's `2` reads as SGR 2, dim.
        else if ((c === 38 || c === 48 || c === 58) && codes[k + 1] === 5) { if (c === 38) fg = `256:${codes[k + 2]}`; k += 2; }
        else if ((c === 38 || c === 48 || c === 58) && codes[k + 1] === 2) { if (c === 38) fg = `rgb:${codes.slice(k + 2, k + 5).join(',')}`; k += 4; }
      }
      continue;
    }
    chars.push(tok);
    fgs.push(dim ? `${fg}+dim` : fg);
  }
  const want = Array.from(plain).slice(0, col + 1).join('');
  if (col < 0 || col >= fgs.length || chars.slice(0, col + 1).join('') !== want) return null;
  return fgs[col];
}

// n columns of word-separated text, `abcde abcde ...` cut to length. The run-up and the
// space probe both type it, and each needs words rather than one solid letter (see them).
const filler = (n: number) => 'abcde '.repeat(Math.ceil(Math.max(0, n) / 6)).slice(0, Math.max(0, n));

// What one wrap was, read off two settled frames: `frame` is the one whose keystroke
// moved the cursor and `done` the one after a further keystroke let the application
// finish moving the word (see the walk in measure). `landed` is the continuation row
// itself; the chrome is sliced off it once the wrap column is known.
interface Wrap {
  pull: boolean;
  indent: number;
  lazy: boolean;
  down: boolean;
  landed: string;
}

// `px`/`py` is where the cursor sat before the wrapping keystroke, `typed` the run the
// walk has typed so far: the word the composer will move to the continuation row, so the
// landed row has to actually contain it, which is how a measurement proves it measured a
// wrap rather than a repaint.
function classifyWrap(frame: Frame, done: Frame, walk: { px: number; py: number; typed: string }): Wrap {
  const { px, py, typed } = walk;
  // Both ends are read from the row's CONTENT rather than from the cursor, and the
  // difference is not cosmetic. Deriving the indent as `cursor - characters typed`
  // assumes the application has finished moving the word by the time it parks the
  // cursor, and codex has not: on the wrapping keystroke it draws the continuation
  // row's indent with the cursor at it and fills in the moved word a frame later,
  // resting there for well over half a second. That arithmetic read its indent as -7.
  // The row itself is never ambiguous: the moved word is either on it or it is not.
  const landed = done.rows[frame.y] ?? '';
  const at = landed.indexOf(typed);
  const pull = at !== -1;
  const indent = pull ? at : 0;
  // A LAZY wrap (codex, measured): the char that fills the row paints at its last cell
  // and the cursor drops to an EMPTY continuation; the word only moves with the extra
  // keystroke the walk types. Read at the WRAP frame, before that keystroke: the
  // continuation is blank while the row it left is full. A one-phase composer (claude,
  // agy) has already moved the word by then.
  const landedEarly = frame.rows[frame.y] ?? '';
  const fromEarly = rtrim(frame.rows[py] ?? '');
  const lazy = pull && !/\S/.test(landedEarly) && fromEarly.length > px;
  // Normalised the way learnWrap normalises it: a hard wrap always takes the next row,
  // so its direction carries no information and the table stores false rather than a
  // fact the engine will never read.
  const down = pull && frame.y > py;
  return { pull, indent, lazy, down, landed };
}

// Two shapes no settled wrap has; a reading with either was taken mid-repaint, and a
// reading nobody can trust is worse than none: it gets pasted into the model's table and
// seeds every session of that application with it. `above` is the row the wrap left.
function assertSettledWrap(app: string, w: Wrap, pinned: boolean, cols: number, above: string): void {
  if (w.down && pinned) {
    throw new Error(
      `${app} read as growing downward out of a pane whose last row was already ` +
      'occupied, which nothing can do: this sample was taken while the application ' +
      'was still drawing. Claude Code was seeded from one of these, and it cost a ' +
      'predicted continuation row painted over the composer border on every wrap.',
    );
  }
  // A hard wrap is the case where the word did NOT move, and it has to look like one
  // rather than merely failing to look like a pull: the characters split across the
  // seam, the row it wrapped from full to its last column.
  const aboveLen = rtrim(above).length;
  if (!w.pull && aboveLen < cols - 1) {
    throw new Error(
      `nothing moved to the continuation row, but the row above ends at column ` +
      `${aboveLen} rather than filling the width. That is neither a word wrap nor a ` +
      `hard one: the pane was still repainting. Row reads ${JSON.stringify(w.landed.slice(0, 40))}.`,
    );
  }
}

// The SGR the application drew the last typed character in, wherever that character
// actually ended up: a word-wrapping composer moved it to the landed row, behind the
// cursor, while a hard wrap left it filling the LAST cell of the row it wrapped from and
// dropped the cursor to column 0 of the next. Reading behind the cursor either way asks
// for column -1 in the second case, which is how goose and the shell reported no draft
// colour at all.
async function readInk(pane: Pane, done: Frame, cols: number): Promise<string | null> {
  const row = done.x > 0 ? done.y : done.y - 1;
  const col = done.x > 0 ? done.x - 1 : cols - 1;
  return inkAt(await pane.escRow(row), col, done.rows[row] ?? '');
}

// The space rule, measured rather than assumed: land a word ending exactly at the wrap
// column, then type a space. Claude Code, codex and grok eat the seam space and open an
// EMPTY continuation; agy pulls the word down with it and lands the cursor after it. The
// discriminator is the cursor's own row after the space: it holds the word only when the
// word moved (an up-grower's word rises with the box either way, so a shrink of the row
// it left says nothing on its own). `wrapCol` is the column the word wrapped at,
// `cursorX` where the cursor sits now, at the end of the moved word.
async function probeSpacePull(pane: Pane, wrapCol: number, cursorX: number, indent: number): Promise<boolean> {
  const fill = wrapCol - 5 - cursorX;
  if (fill < 0) return false;
  // Word-separated filler: a solid run of one letter would make the LAST word the whole
  // run, and agy's space pull, the behaviour under test, does not fire for a word that
  // long. Sliced arbitrarily, so the last word is the fragment plus 'vwxyz': never
  // longer than ten.
  await pane.type(filler(fill) + 'vwxyz');
  const preSpace = await pane.settled();
  const wy = preSpace.y;
  const beforeLen = textEnd(preSpace.rows[wy] ?? '');
  await pane.type(' ');
  const postSpace = await pane.settled();
  const afterLen = textEnd(postSpace.rows[wy] ?? '');
  const wrapped = postSpace.y !== wy || afterLen < beforeLen - 3;
  const cursorRowLen = textEnd(postSpace.rows[postSpace.y] ?? '');
  return wrapped && cursorRowLen > indent + 1;
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
    // The prompt is whatever the application drew left of its cursor — minus the
    // chrome a BORDERED composer puts there. grok's row opens `│ ❯ ` behind a
    // border glyph and a gutter: read raw, the six cells fail the shape envelope
    // and the tool measures `prompt: null`, which costs the engine its prompt row
    // (Home, kill-to-start and the backspace's permission all key on it). One
    // leading box glyph plus its blanks is stripped by the engine's own borderSkip (the
    // same skip promptAt makes); plain leading blanks are kept, because they are part of
    // the prompt where they exist (a prompt with a leading space, like ` > `).
    const promptHead = (empty.rows[empty.y] ?? '').slice(0, promptCol);
    const promptRaw = promptHead.slice(borderSkip(promptHead));

    // Land on a word boundary a short walk before the expected wrap, so the
    // characters stepped in below are exactly the word that will move.
    const target = expectPad === null ? Math.floor(cols / 2) : cols - expectPad;
    const bulk = filler(target - promptCol - 6);
    const upToSpace = bulk.slice(0, bulk.lastIndexOf(' ') + 1);
    if (upToSpace) {
      await pane.type(upToSpace);
      await Bun.sleep(SETTLE_MS * 4);
    }

    // Whether the box has anywhere to grow DOWNWARD, read once the run-up has settled.
    // The walk below adds a handful of characters and cannot change the box's height
    // until the wrap itself, so this is the layout the wrap starts from. A pane whose
    // last row is already occupied has no row for the box's own bottom to move into,
    // and the cursor cannot drop onto a row that does not exist. An application that
    // makes room by SCROLLING instead keeps the cursor on its screen row, so that path
    // never reads as downward growth either: `down` and an occupied last row cannot
    // both be true, and a reading that says they are was taken mid-repaint.
    const pinned = ((await pane.snapshot()).rows[ROWS - 1] ?? '').trim() !== '';

    const start = await pane.settled();
    let { x: px, y: py } = start;
    // The row the walk is typing on, read fresh at every settled frame. The wrap
    // column is derived from THIS row's own text length, not from the cursor: on a
    // row the app fills completely before wrapping (fx) the cursor clamps at the
    // last cell, and a cursor-derived margin is one column short of the truth —
    // the seed then wraps the model a keystroke ahead of the pane on every line.
    // Seeded from the run-up's own frame, because the first walk keystroke can already
    // be the one that wraps, and an empty row there measures a pad of the full width.
    let preRow = start.rows[py] ?? '';
    // Every character the walk types, in order. It is the word the composer will move to
    // the continuation row, so the landed row has to actually contain it — which is how a
    // measurement proves it measured a wrap rather than a repaint.
    let typed = '';
    // The walk is bounded only to stop a broken run: any wrap column the engine
    // would accept is reachable well inside it.
    for (let k = 1; k <= cols; k++) {
      const ch = WALK[(k - 1) % WALK.length];
      typed += ch;
      await pane.type(ch);
      const frame = await pane.settled();
      const { x, y } = frame;
      if (y !== py || x < px) {
        // A hard wrap drops the cursor to column 0 of the next row and moves no
        // word; a word wrap lands it at the continuation indent plus the word. The walk
        // types one more character first, so an application that fills in the moved word
        // a frame late (codex) has finished by the time the row is read.
        await pane.type(WALK[k % WALK.length]);
        typed += WALK[k % WALK.length];
        const done = await pane.settled();
        const w = classifyWrap(frame, done, { px, py, typed });
        assertSettledWrap(app, w, pinned, cols, done.rows[py] ?? '');
        // The engine's atLen is a LINE length — left chrome included, right chrome
        // excluded — which is exactly what the engine's own textEnd reads off the
        // row the walk was on when the wrap fired (see the comment above it).
        const atLen = textEnd(preRow);
        // Before the space probe types into the pane: it would move the cell this reads.
        const ink = await readInk(pane, done, cols);
        const spacePull = w.pull ? await probeSpacePull(pane, atLen, done.x, w.indent) : false;
        // Both ends off the row the wrap just LANDED on. That row holds one word, so
        // every column outside `indent .. cols - pad` on it is the application's own
        // chrome and nothing else, which is exactly the claim being measured. Reading
        // the right end off the row it wrapped FROM instead looks equally reasonable and
        // is wrong for a hard-wrapping composer, whose text fills the final column by
        // definition: gemini reported its last typed letter as a border, and reported a
        // different letter at each width, so the check called a stable app unstable.
        // The outer margin is dropped from each end, leaving the part that is drawn
        // rather than merely reserved.
        return {
          seed: {
            pad: cols - atLen,
            indent: w.indent,
            pull: w.pull,
            down: w.down,
            prompt: promptShaped(norm(promptRaw)) ? norm(promptRaw) : null,
            lazy: w.lazy,
            spacePull,
          },
          chrome: {
            left: w.landed.slice(0, w.indent).replace(/^ +/, ''),
            right: rtrim(w.landed.slice(atLen)),
          },
          ink,
        };
      }
      px = x;
      py = y;
      preRow = frame.rows[y] ?? '';
    }
    // A composer that never wraps is usually not a composer. Ask the screen before
    // calling it a geometry failure: qwen and droid both reach here from a sign-in flow
    // that accepts keystrokes into something which is not a draft.
    // The walk accepted every character, so only a strict pattern may refuse it: the rule
    // WALLS states, and the site that used to break it. A composer whose hint mentions an
    // API key and stopped wrapping is a regression, not a logged-out tool.
    const screen = await pane.refuseWall(true, `not signed in: ${cols} characters went into something that never wrapped`);
    throw new Error(
      `typed ${cols} characters past column ${target} without wrapping. Screen:\n      ${tail(screen)}`,
    );
  } finally {
    await pane.stop();
  }
}

// What the application draws at each end, outside its text. Reported next to the row
// rather than inside it: the braces are meant to be pasted into the table, and these two
// are measured to be checked, not to be seeded.
function chrome(r: Row): string {
  const q = (s: string) => (s ? JSON.stringify(s) : 'none');
  return `left ${q(r.chrome.left)}, right ${q(r.chrome.right)}`;
}

// What the draft colour means for the engine. Theme-dependent colours are learned;
// a measured fixed ANSI colour can supply the row's cold fallback.
function draft(r: Row, seed: Seed | null): string {
  if (r.ink === null) return 'unread (the escape capture did not line up with the plain one)';
  if (r.ink === 'default') {
    return 'default foreground — the terminal\'s own colour is right from the first keystroke';
  }
  if (seed?.coldFg) {
    return `${r.ink} — fixed; the table seeds ${seed.coldFg} until the first echo teaches it`;
  }
  return `${r.ink} — its own, so the predictor reads the row until the first echo teaches it`;
}

function describe(r: Seed): string {
  const p = r.prompt === null ? 'null' : `'${r.prompt.replace(/./gu, (c) =>
    c.codePointAt(0)! < 0x7f ? c : `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`)}'`;
  // The flags ride the row only when true, exactly as the model's table carries
  // them: both default false there, so a false one is noise in the paste.
  const flags = (['lazy', 'spacePull'] as const).filter((k) => r[k]).map((k) => `, ${k}: true`).join('');
  return `{ pad: ${r.pad}, indent: ${r.indent}, pull: ${r.pull}, down: ${r.down}, prompt: ${p}${flags} }`;
}

const config = loadConfig();
const args = process.argv.slice(2);
const printOnly = args.includes('--print');
const container = args.find((a) => a.startsWith('--container='))?.split('=')[1] ?? config.containerName;
const table = tuiTable();
const apps = args.filter((a) => !a.startsWith('--'));
const paneApp = (app: string) => (APPS as Record<string, AppSpec>)[app]?.paneApp ?? app;

log.header('TUI composer geometry');

if (!(await isContainerRunning(container))) {
  log.error(`Container '${container}' not running`);
  log.info('Start it with: bun dev/scripts/start.ts');
  process.exit(1);
}

// With no app named, sweep EVERYTHING: the seeded table plus every command in the image's
// tool catalog. A tool that has just been added to the image is therefore measured without
// being registered anywhere first — which is the point, because its measurement is what
// its table row is written from. Tools with no row print their measurement and say so;
// tools with one are checked against it.
function sweepTargets(): string[] {
  // A table key is the process tmux reports. Prefer its registered launch name when the
  // two differ, so a full sweep launches `kimi` rather than looking for `kimi-code`.
  const launchName = (processName: string) =>
    Object.keys(APPS).find((name) => APPS[name as keyof typeof APPS].paneApp === processName) ?? processName;
  const seen = new Set(Object.keys(table).map(launchName));
  for (const t of toolDefs.tools) seen.add(t.command);
  return [...seen];
}

const targets = apps.length ? apps : sweepTargets();
log.info(`Container: ${container}`);
log.info(`Widths: ${WIDTHS.join(', ')} columns\n`);

let passed = 0;
let failed = 0;
let skipped = 0;

for (const app of targets) {
  if (Object.hasOwn(NOT_A_COMPOSER, app)) {
    log.info(`${app}: not measured — ${NOT_A_COMPOSER[app]}`);
    continue;
  }
  const processName = paneApp(app);
  const want = Object.hasOwn(table, processName) ? table[processName]! : null;
  let measured: Row[];
  try {
    measured = [];
    for (const cols of WIDTHS) measured.push(await measure(container, app, cols, want?.pad ?? null));
  } catch (e) {
    if (e instanceof Unmeasurable) {
      log.warn(`${app}: ${e.message}`);
      skipped++;
      continue;
    }
    log.error(`${app}: ${(e as Error).message}`);
    failed++;
    continue;
  }

  const [a, b] = measured as [Row, Row];
  // pad is the claim that survives a resize; everything else must simply agree. The
  // chrome is held to the same standard, on both sides: a border that sits at a different
  // distance from the edge at 100 columns than at 120 is not a fixed margin, and the
  // engine would be seeding a wrap column that only holds at one width. The draft colour
  // is reported beside the row, not gated: an escape capture that fails to line up at one
  // width reads null there, which is not a geometry.
  const stableSeed = differing(a.seed, b.seed)
    .filter((key) => key !== 'down' || want?.down !== null);
  const stable = [...stableSeed, ...differing(a.chrome, b.chrome)];
  if (a.ink !== b.ink) log.warn(`${app}: draft colour read ${a.ink} at ${WIDTHS[0]} and ${b.ink} at ${WIDTHS[1]} columns`);
  if (stable.length) {
    if (Object.hasOwn(NO_ROW, app)) {
      log.warn(`${app}: no row, as declared — ${NO_ROW[app]}`);
      log.info(`  ${WIDTHS[0]}: ${describe(a.seed)}  (${chrome(a)})`);
      log.info(`  ${WIDTHS[1]}: ${describe(b.seed)}  (${chrome(b)})`);
      log.info(`  It differs on ${stable.join(', ')}, which is the reason it has none.`);
      skipped++;
      continue;
    }
    log.error(`${app}: differs between ${WIDTHS[0]} and ${WIDTHS[1]} columns on ${stable.join(', ')}`);
    log.info(`  ${WIDTHS[0]}: ${describe(a.seed)}  (${chrome(a)})`);
    log.info(`  ${WIDTHS[1]}: ${describe(b.seed)}  (${chrome(b)})`);
    log.info('  Not a constant margin at every width: this app cannot take a row.');
    failed++;
    continue;
  }
  if (Object.hasOwn(NO_ROW, app)) {
    log.error(`${app}: declared unseedable, but it measured the SAME at both widths`);
    log.info(`  measured: ${describe(a.seed)}  (${chrome(a)})`);
    log.info(`  ${NO_ROW[app]}`);
    log.info('  That is no longer true. Give it a row and delete its NO_ROW entry.');
    failed++;
    continue;
  }

  if (printOnly || !want) {
    log.info(`${app}: ${describe(a.seed)}`);
    log.info(`  chrome: ${chrome(a)}`);
    log.info(`  draft:  ${draft(a, want)}`);
    if (!want && !printOnly) log.info('  (no model row; add it to console/ui/assets/eh-model.js if this app should be seeded)');
    passed++;
    continue;
  }

  const wrong = differing(a.seed, want);
  if (wrong.length === 0) {
    log.success(`${app}: ${describe(a.seed)}  (${chrome(a)})`);
    log.info(`  draft: ${draft(a, want)}`);
    passed++;
  } else if (want.down === null && wrong.length === 1 && wrong[0] === 'down') {
    // A null-direction row says the app's growth is the layout's, never a constant
    // the app holds: measure it, but do not fail the table for it.
    log.success(`${app}: ${describe(a.seed)}  (${chrome(a)})`);
    log.info(`  draft: ${draft(a, want)}`);
    passed++;
  } else {
    log.error(`${app}: table is stale on ${wrong.join(', ')}`);
    log.info(`  table:    ${describe(want)}`);
    log.info(`  measured: ${describe(a.seed)}`);
    log.info(`  Replace the row in console/ui/assets/eh-model.js with the measured one.`);
    failed++;
  }
}

// Named before the summary, because a sweep that measured six tools and skipped four is a
// different thing from one that measured ten, and the count alone cannot say which.
if (skipped) log.info(`${skipped} tool(s) could not be measured (not signed in, or did not start)`);
if (passed === 0 && skipped) {
  log.error('nothing was measured: every tool was skipped, so the table was not checked');
  failed++;
}
formatTestSummary(passed, failed);
process.exit(failed === 0 ? 0 : 1);

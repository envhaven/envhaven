// Pixel checks for the colours the predictor paints on.
//
// Everything else in this file's neighbourhood reads the grid. These two cannot: the DOM
// is correct either way. The overlay holds the right characters in the right cells, and
// what goes wrong is the colour inside it, so a check that reads text sees a settled row
// while the user watches a rectangle of the wrong shade flicker on every keystroke. The
// only instrument that sees the symptom is a screenshot.
//
// Both run at device scale 2. The sample points and the tolerance below were measured at
// that scale, and at scale 1 a cell offers too few pixels to sample a band inside.
import type { Page } from '@playwright/test';
import { log } from '../log';
import { APPS, type AppName, appsWith } from '../console-apps';
import {
  PIXEL_VIEWPORT, type Check, type ConsoleRig,
  assert, inconclusive, launchApp, probe, quiet, settle, sweep, teardownApp,
} from '../console-rig';

type Rgb = [number, number, number];

/**
 * Read a screenshot's pixels back, inside the page.
 *
 * Playwright hands a screenshot over as PNG bytes and this script has no decoder for
 * them. The page has one. So the shot goes back across as base64, an Image and a canvas
 * turn it into pixels, and only the numbers come home. Nothing is written to disk.
 *
 * Every clip here is exactly one terminal row, so the strip is read as `cells` equal
 * columns: one sample column down the middle of each cell, from y=2 to `band` of the row
 * height. Starting at 2 skips the cell's top edge, where the row above bleeds in. The
 * floor of 3 keeps a single-pixel read available when `band` is 0.
 */
async function samplePixels(page: Page, shot: Buffer, cells: number, band: number): Promise<Rgb[][]> {
  return page.evaluate(async ({ b64, cells, band }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const scale = img.width / cells;
    const bottom = Math.max(3, Math.round(img.height * band));
    const out: Rgb[][] = [];
    for (let cell = 0; cell < cells; cell++) {
      const x = Math.round((cell + 0.5) * scale);
      const run: Rgb[] = [];
      for (let y = 2; y < bottom; y++) {
        const i = (y * img.width + x) * 4;
        run.push([data[i], data[i + 1], data[i + 2]]);
      }
      out.push(run);
    }
    return out;
  }, { b64: shot.toString('base64'), cells, band });
}

/** Which row to read: the one the model is painting, or the one xterm put its cursor on. */
type RowPick = 'model' | 'cursor';

interface RowView {
  /** Columns on the row, which is the terminal's width. */
  cols: number;
  /** Screen row, so a clip can be built for it. */
  vrow: number;
  /** Where xterm drew its own cursor span, when it drew one. */
  curCol: number | null;
  /** The row's own background, or null when its widest run carries none. */
  bg: string | null;
  /** The terminal's background, which is what a row without one falls back to. */
  pageBg: string;
  /** True while the engine hides xterm's cursor behind its own predicted block. */
  owning: boolean;
  /** Every run on the row, in order. A null bg means the run carries no background. */
  spans: { col: number; n: number; cls: string; bg: string | null }[];
  /** Screen origin and one cell's size, in CSS pixels. */
  sx: number;
  sy: number;
  cw: number;
  ch: number;
}

/**
 * One row of the terminal, as the page renders it.
 *
 * The background it reports is resolved by the engine's own rule: the widest run wins,
 * counting runs that carry no background at all, with xterm's cursor and any decoration
 * excluded outright. That rule is the thing under test, so it is reproduced rather than
 * improved. Scoring only runs that HAVE a background is the defect: on an ordinary row of
 * blanks an app's one inverse caret becomes the sole candidate and hands its colour, which
 * is really a foreground colour, to the whole row.
 *
 * Null means the row this check needs is not on screen, or its width could not be read.
 * Either way there is nothing to sample.
 */
async function readRow(page: Page, pick: RowPick): Promise<RowView | null> {
  return page.evaluate((pick) => {
    const p = window.__ehPredict;
    const rows = document.querySelector('.xterm-rows');
    const screen = document.querySelector('.xterm-screen');
    if (!rows || !screen || !rows.children.length) return null;

    let vrow = -1;
    if (pick === 'model') {
      vrow = p.row - p.baseY;
    } else {
      for (let i = 0; i < rows.children.length; i++) {
        if (rows.children[i].querySelector('.xterm-cursor')) { vrow = i; break; }
      }
    }
    const el = rows.children[vrow];
    if (!el) return null;
    const cols = (p.text(p.row) || '').length;
    if (!cols) return null;

    // The engine's own test for "carries no background of its own", in its own spelling.
    const bare = (v: string) => !v || v === 'transparent' || /^rgba\([^)]*,\s*0(\.0+)?\)$/.test(v);
    const spans: RowView['spans'] = [];
    let col = 0;
    let curCol: number | null = null;
    let widest = -1;
    let bg: string | null = null;
    for (const s of Array.from(el.children)) {
      const n = (s.textContent || '').length;
      const cls = s.className || '';
      const raw = getComputedStyle(s).backgroundColor;
      spans.push({ col, n, cls, bg: bare(raw) ? null : raw });
      if (/xterm-cursor/.test(cls)) curCol = col;
      if (!/xterm-cursor|xterm-decoration/.test(cls) && n > widest) {
        widest = n;
        bg = bare(raw) ? null : raw;
      }
      col += n;
    }

    const box = screen.getBoundingClientRect();
    return {
      cols, vrow, curCol, bg, spans,
      pageBg: getComputedStyle(document.body).backgroundColor,
      // The class is what actually hides xterm's cursor. The probe's `owning` flag is the
      // engine's bookkeeping about the same thing, and it is the class that decides whose
      // cursor a screenshot catches.
      owning: document.getElementById('term')!.classList.contains('eh-hide-cursor'),
      sx: box.left,
      sy: box.top,
      cw: box.width / cols,
      ch: rows.children[0].getBoundingClientRect().height,
    };
  }, pick);
}

/** The three channels out of a CSS colour, whichever spelling the page used. */
function rgbOf(css: string): Rgb | null {
  const m = css.match(/(\d+),\s*(\d+),\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** The alpha of a CSS colour, 1 when it has none: xterm draws SGR 2 (dim) as rgba(..., 0.5). */
function alphaOf(css: string): number {
  const m = css.match(/^rgba\((?:\s*\d+\s*,){3}\s*([\d.]+)\s*\)/);
  return m ? Number(m[1]) : 1;
}

// ---------------------------------------------------------------------------
// boxbg
// ---------------------------------------------------------------------------

/** Typed run with no ascenders and no descenders, so the sampled band is never ink. */
const RUN = 'xoxoacesxoacesoxacesxoaces';

// Measured, not guessed. The top 22% of a cell is background under every x-height glyph at
// this scale, and a channel more than 12 away from the row's colour is a different colour
// rather than the row above bleeding into the cell's top edge.
const BAND = 0.22;
const TOLERANCE = 12;

// Sampling starts here because the first cells belong to the app's prompt or its box
// border, which are ink and would read as a wrong background on every run.
const FIRST_COL = 2;

export const cursorGhost: Check = {
  name: 'cursor-ghost',
  what: 'moving between composer rows erases the old inverse caret before its echo arrives',
  needsFreshPane: true,
  async run(rig) {
    const page = await rig.page(PIXEL_VIEWPORT);
    try {
      await launchApp(page, 'invcomposer');
      const start = await probe(page);
      await page.keyboard.type('x'.repeat(start.cols - 6) + ' yoyo', { delay: 12 });
      await settle(page, 6000);
      assert((await probe(page)).wrap?.pull === true, 'the mimic did not establish its two-row composer');

      const moves = [
        { key: 'Control+a', cross: true },
        { key: 'Control+e', cross: true },
        { key: 'Alt+ArrowLeft', cross: false },
        { key: 'ArrowLeft', cross: true },
        { key: 'ArrowRight', cross: true },
        { key: 'Alt+ArrowLeft', cross: true },
        { key: 'Alt+ArrowRight', cross: true },
        { key: 'ArrowRight', cross: false },
        { key: 'ArrowLeft', cross: false },
      ];
      for (const move of moves) {
        await settle(page, 6000);
        const before = await probe(page);
        const row = await readRow(page, 'model');
        assert(!!row, `${move.key}: the source row is missing`);
        const caret = row!.spans.find((span) => span.col <= before.col && span.col + span.n > before.col);
        assert(!!caret?.bg && caret.bg !== row!.pageBg, `${move.key}: the source cell has no inverse caret`);
        const reference = rgbOf(row!.bg || row!.pageBg)!;
        const sourceText = await page.evaluate((r) => window.__ehPredict.text(r), before.row);
        await page.keyboard.press(move.key);
        const pending = await probe(page);
        assert(!!pending.burst && !pending.hold, `${move.key}: navigation was not predicted`);
        assert((pending.burst!.row !== before.row) === move.cross,
          `${move.key}: unexpected predicted row ${pending.burst!.row}, started at ${before.row}`);
        assert(pending.burst!.row !== before.row || pending.burst!.line.length !== before.col,
          `${move.key}: the predicted cursor did not move`);
        const shot = await page.screenshot({ clip: {
          x: row!.sx + before.col * row!.cw,
          y: row!.sy + row!.vrow * row!.ch,
          width: row!.cw, height: row!.ch,
        } });
        const after = await probe(page);
        assert(after.row === before.row && after.col === before.col,
          `${move.key}: echo arrived before the old caret could be sampled; increase --down`);
        const pixels = (await samplePixels(page, shot, 1, BAND))[0]!;
        assert(pixels.every((pixel) => pixel.every((channel, i) => Math.abs(channel - reference[i]!) <= TOLERANCE)),
          `${move.key}: the old caret is still visible on row ${before.row}, column ${before.col}`);
        await settle(page, 6000);
        const landed = await probe(page);
        assert(landed.row === pending.burst!.row && landed.col === pending.burst!.line.length,
          `${move.key}: the real cursor did not reach the predicted position`);
        const unchanged = await page.evaluate((r) => window.__ehPredict.text(r), before.row);
        assert(unchanged === sourceText, `${move.key}: covering the caret changed its underlying text`);
      }
      return `${moves.length} character, word, and Home/End moves cleared the old caret before echo`;
    } finally {
      await teardownApp(page).catch(() => undefined);
      await rig.closePage(page);
    }
  },
};

type BoxShape = 'mimic' | 'inverse' | 'claude';

const BOX_APP: Record<BoxShape, AppName> = {
  mimic: 'boxcomposer',
  inverse: 'invcomposer',
  claude: 'claude',
};

interface WrongColumn { col: number; px: Rgb; delta: number }

/** Columns whose sampled band is not the colour the row was painted in. */
function wrongColumns(cells: Rgb[][], ref: Rgb, to: number, skip: number): WrongColumn[] {
  const bad: WrongColumn[] = [];
  for (let col = FIRST_COL; col < to; col++) {
    if (col === skip) continue;
    let delta = 0;
    let px: Rgb | null = null;
    for (const p of cells[col] ?? []) {
      const d = Math.max(Math.abs(p[0] - ref[0]), Math.abs(p[1] - ref[1]), Math.abs(p[2] - ref[2]));
      if (d > delta) { delta = d; px = p; }
    }
    if (delta > TOLERANCE && px) bad.push({ col, px, delta });
  }
  return bad;
}

/**
 * A predicted character must sit on the background the APPLICATION drew, not on the
 * terminal's own.
 *
 * Reported against Codex. Its input box carries a background of its own, and every opaque
 * layer the predictor paints (glyph run, delete cover, ghost cover, cursor block, the wrap
 * layers) used the theme background, so a rectangle of the wrong colour appeared inside
 * the box for a round trip, on typing and on deleting alike.
 *
 * Three shapes drive the same implementation, each exported as its own check, so a red run
 * names the shape that broke. The panelled mimic catches an overlay that assumes the
 * terminal's colour. The inverse mimic draws no panel and its own caret instead, which is
 * the trap for a resolver that considers only runs carrying a background. Claude Code is
 * the real thing, in case the mimics have drifted from what a shipped TUI does.
 */
async function runBoxBg(rig: ConsoleRig, shape: BoxShape): Promise<string> {
  const app = BOX_APP[shape];
  const page = await rig.page(PIXEL_VIEWPORT);
  try {
    await launchApp(page, app);
    // launchApp waits for the pane to change hands and then gives the app a moment to
    // draw. An app that died in that moment leaves a shell holding the pane, and every
    // pixel below would belong to zsh, so the read is worth repeating.
    const pane = (await probe(page)).app;
    if (pane !== APPS[app].paneApp) {
      inconclusive(`the pane is running ${JSON.stringify(pane)}, not ${app}, so nothing under test ran`);
    }

    // `?? inconclusive(...)` rather than a guard statement. inconclusive returns never,
    // so this hands back a value already known to be non-null, which the nested phase
    // closures below can still see: a narrowing guard does not survive into a closure.
    const row = (await readRow(page, 'model'))
      ?? inconclusive('the composer row is not on screen, so there was nothing to sample');
    const boxBg = row.bg ?? row.pageBg;
    log.dim(`    row ${row.vrow}, ${row.cols} columns, painted ${boxBg}`);

    // Whether the row carries a background of its own, or the terminal's shows through.
    const ownBg = boxBg !== row.pageBg;
    // `mimic` exists to paint a panel, so a row without one means the fixture did not
    // run. That is a rig fault rather than a result, and scoring it would report the
    // terminal's background as though it were the app's.
    //
    // Claude Code is deliberately not held to the same rule. Measured here: it draws its
    // composer from border glyphs rather than a filled panel, so carrying no background
    // of its own is a true fact about the app, not a broken run. That case still asserts
    // something worth having, that the engine paints on the background the app left
    // rather than inventing one, but it cannot exercise the panel path and the note below
    // says which of the two it got instead of implying a contrast that never happened.
    // `inverse` is exempt for its own reason: there the terminal background IS the right
    // answer and the app's one coloured cell is the colour that must lose.
    if (shape === 'mimic' && !ownBg) {
      inconclusive(`the panel app painted no background of its own (${boxBg}), so this run had nothing to contrast`);
    }
    if (shape === 'inverse') {
      // With no caret on the row there is no wrong colour available to be picked, and a
      // pass would mean nothing at all.
      const caret = row.spans.filter((s) => !/xterm-cursor/.test(s.cls) && s.bg && s.bg !== row.pageBg);
      if (!caret.length) inconclusive('the app drew no inverse caret on the row, so nothing could be mis-sampled');
      log.dim(`    inverse caret: ${caret.map((s) => `col ${s.col} len ${s.n} ${s.bg}`).join(', ')}`);
    }

    const ref = rgbOf(boxBg)
      ?? inconclusive(`the row's background did not read as a colour (${boxBg})`);

    const clip = {
      x: Math.round(row.sx),
      y: Math.round(row.sy + row.vrow * row.ch),
      width: Math.round(row.cw * row.cols),
      height: Math.round(row.ch),
    };

    // What this check needs is the model AHEAD of the pane on the burst's own row:
    // predicted cells on screen that the echo has not reached yet. It used to ask for
    // `matched === false` instead, a proxy for the same thing back when the only way a
    // burst could be marked as agreed-with was the echo catching all the way up. That
    // stopped being true once reconcile learned to recognise the pane merely WALKING the
    // predicted line, and a proxy that no longer tracks its subject reports inconclusive
    // forever.
    const paint = () => page.evaluate(() => {
      const p = window.__ehPredict, b = p.burst;
      return b && { modelCol: b.line.length, paneCol: p.col, paneRow: p.row, burstRow: b.row };
    });
    // Ahead or behind: typing leaves predicted glyphs the echo has not reached, deleting
    // leaves cover cells whose erase is still in flight. Either way the two disagree about
    // where the cursor is, and that disagreement IS the overlay being sampled.
    const painting = (b: Awaited<ReturnType<typeof paint>>) =>
      !!b && b.burstRow === b.paneRow && b.modelCol !== b.paneCol;

    // A failure outranks a skip, so both phases run and the verdict comes at the end. A
    // phase that could not observe anything must not bury a phase that saw the bug.
    const failures: string[] = [];
    const skips: string[] = [];
    const checked: Record<string, number> = {};

    async function phase(label: string, act: () => Promise<void>, edge: (modelCol: number) => number) {
      await act();
      const before = await paint();
      if (!painting(before)) {
        skips.push(`${label}: nothing predicted was still ahead of the echo (${JSON.stringify(before)})`);
        return;
      }
      const shot = await page.screenshot({ clip });
      const after = await paint();
      // A screenshot is not instant. If the echo landed while it was being taken, these
      // pixels are of a converged row and say nothing about the overlay.
      if (!after || !painting(after)) {
        skips.push(`${label}: the echo caught up during the screenshot (${JSON.stringify(after)})`);
        return;
      }
      const to = edge(after.modelCol);
      const n = Math.max(0, to - FIRST_COL);
      if (!n) {
        skips.push(`${label}: no columns to check`);
        return;
      }
      checked[label] = n;
      const cells = await samplePixels(page, shot, row.cols, BAND);
      // The predicted cursor block is painted in the cursor's colour by design, so its own
      // column is not part of the assertion.
      const bad = wrongColumns(cells, ref, to, after.modelCol);
      for (const b of bad.slice(0, 3)) {
        log.dim(`    ${label} column ${b.col} reads rgb(${b.px.join(',')}), the row is ${boxBg}, delta ${b.delta}`);
      }
      if (bad.length) {
        const worst = bad[0]!;
        failures.push(
          `${label}: ${bad.length} of ${n} column(s) sat on the wrong background, ` +
          `worst at column ${worst.col} which read rgb(${worst.px.join(',')}) where the row is ${boxBg}`,
        );
      }
    }

    // Two phases, because the report covered both. The glyph layer paints while typing and
    // the cover layer paints while deleting. Separate code paths, separate colours to get
    // wrong.
    await phase('typing', () => page.keyboard.type(RUN, { delay: 8 }), (modelCol) => modelCol);

    // Let the typed run land first, so the deletes open their own burst against a converged
    // grid. A plain wait rather than quiet(): a real TUI repaints on its own schedule and
    // the wire is under no obligation to fall silent here.
    await Bun.sleep(1200);
    await phase('deleting', async () => {
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Backspace');
        await Bun.sleep(18);
      }
    }, () => RUN.length + FIRST_COL);

    assert(!failures.length, failures.join('; '));
    if (skips.length) inconclusive(skips.join('; '));
    return `typing and deleting both painted on ${boxBg}` +
      `${ownBg ? " (the app's own)" : ' (the terminal\'s: this app draws no panel of its own)'}` +
      ` (${checked.typing} and ${checked.deleting} columns)`;
  } finally {
    await teardownApp(page).catch(() => undefined);
    await rig.closePage(page);
  }
}

export const boxbgMimic: Check = {
  name: 'boxbg-mimic',
  what: "predicted paint sits on a panelled app's own background, not the terminal's",
  run: (rig: ConsoleRig) => runBoxBg(rig, 'mimic'),
};

export const boxbgInverse: Check = {
  name: 'boxbg-inverse',
  what: "predicted paint survives an app whose only coloured cell is its own inverse caret",
  run: (rig: ConsoleRig) => runBoxBg(rig, 'inverse'),
};

export const boxbgClaude: Check = {
  name: 'boxbg-claude',
  what: "predicted paint sits on the right background in Claude Code's composer",
  run: (rig: ConsoleRig) => runBoxBg(rig, 'claude'),
};

// ---------------------------------------------------------------------------
// blinkbg
// ---------------------------------------------------------------------------

// The blink period is one second, so 14 shots 160ms apart cross both beats several times
// over whatever phase the sampling happens to start in.
const BLINK_SAMPLES = 14;
const BLINK_STEP = 160;

export const blinkbg: Check = {
  name: 'blinkbg',
  what: "the blinking cursor's off beat shows the application's background, not the terminal's",
  // xterm's injected blink_block keyframe fills the OFF beat with `background-color:
  // inherit`, and the row div a cursor span inherits from carries no background of its own.
  // Inside a TUI's coloured input box that resolves to the terminal's background: a
  // one-cell hole flickering once a second. It is the one surface the predicted paint does
  // not cover, because here xterm draws the cursor and the engine does not.
  //
  // Needs the page IDLE. While the engine owns the cursor it hides xterm's, and the cell
  // under test would be the engine's own block instead of the one this guards.
  //
  // The mimic holds the terminal raw with signals off and never reads stdin, so teardown
  // cannot ^C it and the pane stays occupied. Hence the fresh pane, for this check and for
  // whatever the runner puts after it.
  needsFreshPane: true,
  async run(rig: ConsoleRig): Promise<string> {
    const page = await rig.page(PIXEL_VIEWPORT);
    try {
      await launchApp(page, 'blinkmimic');
      // The mimic paints one band and then sits still, so the wire really does go silent.
      if (!(await quiet(page, 600, 15000))) {
        inconclusive('the wire never fell silent after the mimic started, so the page never went idle');
      }
      // Idle long enough for releaseCursor() to run and hand the cell back to xterm.
      await Bun.sleep(1800);

      const pane = (await probe(page)).app;
      if (pane !== APPS.blinkmimic.paneApp) {
        inconclusive(`the pane is running ${JSON.stringify(pane)}, not the band mimic, so nothing under test ran`);
      }

      // The row xterm actually drew the cursor on. The burst is long over by the time the
      // page goes idle, so the probe's own row is not the one to trust here.
      const row = await readRow(page, 'cursor');
      if (!row || row.curCol === null) inconclusive('xterm drew no cursor span, so there was no blink to sample');
      if (!row.bg) {
        inconclusive("the cursor's row carries no background of its own, so there is no box for the blink to punch through");
      }
      if (row.owning) {
        inconclusive('the engine still owns the cursor (#term.eh-hide-cursor), so the real one is hidden');
      }

      const clip = {
        x: Math.round(row.sx + row.curCol * row.cw),
        y: Math.round(row.sy + row.vrow * row.ch),
        width: Math.max(2, Math.round(row.cw)),
        height: Math.round(row.ch),
      };

      const seen = new Map<string, number>();
      for (let i = 0; i < BLINK_SAMPLES; i++) {
        const shot = await page.screenshot({ clip });
        // One cell, one pixel: the middle of the cell, two rows down. The band is a run of
        // spaces, so no glyph is antialiased anywhere near that point and the colour is
        // whatever the cell was filled with. Exact equality is the right comparison and a
        // tolerance would only hide the bug.
        const cells = await samplePixels(page, shot, 1, 0);
        const px = cells[0][0];
        const colour = `rgb(${px.join(',')})`;
        seen.set(colour, (seen.get(colour) ?? 0) + 1);
        await Bun.sleep(BLINK_STEP);
      }

      // Resolve the theme's cursor colour through a throwaway div. The variable holds
      // whatever spelling the theme wrote (#ffffff, say) while the sampled pixels are
      // rgb(), and comparing the two spellings directly never matches. The browser is the
      // one thing that converts between them correctly.
      const cursorCss = await page.evaluate(() => {
        const v = getComputedStyle(document.getElementById('term')!).getPropertyValue('--eh-cursor-bg').trim();
        const d = document.createElement('div');
        d.style.backgroundColor = v || '#ffffff';
        document.body.appendChild(d);
        const out = getComputedStyle(d).backgroundColor;
        d.remove();
        return out;
      });

      // Computed styles come back spaced and sampled pixels do not, which is the whole
      // reason this normalises before comparing.
      const norm = (c: string) => c.replace(/\s+/g, '');
      const box = norm(row.bg);
      const cursor = norm(cursorCss);
      // The ON beat is the cursor's own colour and is not under test. Every OTHER colour
      // the cell takes is an off beat, and an off beat must be the background the
      // application drew. Anything else is the terminal's background punched through.
      const offBeats = [...seen.keys()].map(norm).filter((c) => c !== cursor);
      const wrong = offBeats.filter((c) => c !== box);

      for (const [c, n] of [...seen].sort((a, b) => b[1] - a[1])) log.dim(`    ${c.padEnd(18)} x${n}`);
      // The clip has to be ON the cursor cell. If it is not, every sample reads the row
      // background, `offBeats` is exactly that one colour, `wrong` is empty and the check
      // passes having photographed a cell the cursor never touched. Seeing the cursor
      // colour at least once is what proves the aim.
      if (![...seen.keys()].map(norm).includes(cursor)) {
        inconclusive(
          `the cursor's on beat (${cursor}) never appeared across ${BLINK_SAMPLES} samples, ` +
          `so the clip was not on the cursor cell`,
        );
      }
      if (!offBeats.length) {
        inconclusive(`the cursor never blinked off across ${BLINK_SAMPLES} samples, so nothing was under test`);
      }
      assert(
        !wrong.length,
        `the off beat painted ${wrong.join(', ')} where the application painted ${box} (cursor colour ${cursor})`,
      );
      return `the off beat sat on the application's ${box}, with the on beat at ${cursor}`;
    } finally {
      await teardownApp(page).catch(() => undefined);
      await rig.closePage(page);
    }
  },
};

// ---------------------------------------------------------------------------
// draftink
// ---------------------------------------------------------------------------

// The applications draftink drives: the shell first, then every row of console-apps.ts
// marked `ink`, in roster order. Why each one is on that list is the comment on its row,
// where anyone adding a tool looks; the two mimics are there because the real CLIs cannot
// be held in the states this check needs.
const INK_APPS: (AppName | null)[] = [null, ...appsWith('ink')];

/** The first painted glyph in the predictor's overlay: its column, its text, its colour. */
async function overlayInk(page: Page): Promise<{ col: number; text: string; color: string; vrow: number } | null> {
  return page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen');
    const rows = document.querySelector('.xterm-rows');
    if (!screen || !rows || !rows.children.length) return null;
    const ch = rows.children[0].getBoundingClientRect().height;
    for (const layer of Array.from(screen.children)) {
      if (!(layer instanceof HTMLElement) || layer.style.zIndex !== '10') continue;
      for (const line of Array.from(layer.children)) {
        if (!(line instanceof HTMLElement)) continue;
        // `.eh-ink` is the engine's own name for a run of PREDICTED characters. The overlay
        // also holds transparent padding, cover runs painted in the background colour and an
        // inverted cursor block, and picking through those by style reads the wrong cell.
        const sp = line.querySelector('.eh-ink');
        if (!(sp instanceof HTMLElement) || !/\S/.test(sp.textContent || '')) continue;
        let col = 0;
        for (const prev of Array.from(line.children)) {
          if (prev === sp) break;
          col += (prev.textContent || '').length;
        }
        return {
          col, text: sp.textContent || '', color: sp.style.color,
          vrow: Math.round(parseFloat(line.style.top || '0') / ch),
        };
      }
    }
    return null;
  });
}

/** The colour the application itself drew at one cell, once its echo has landed. */
async function settledInk(page: Page, vrow: number, col: number): Promise<{ ch: string; color: string } | null> {
  return page.evaluate(({ vrow, col }) => {
    const rows = document.querySelector('.xterm-rows');
    const el = rows && rows.children[vrow];
    if (!el) return null;
    let n = 0;
    for (const sp of Array.from(el.children)) {
      if (!(sp instanceof HTMLElement)) continue;
      const t = sp.textContent || '';
      // Counted even when nothing is read from it: a cursor run occupies real cells, and
      // skipping it without advancing puts every column after it one cell to the left.
      const skip = /xterm-cursor|xterm-decoration/.test(sp.className);
      if (col < n + t.length) {
        const c = t.charAt(col - n);
        return !skip && /\S/.test(c) ? { ch: c, color: getComputedStyle(sp).color } : null;
      }
      n += t.length;
    }
    return null;
  }, { vrow, col });
}

export const draftink: Check = {
  name: 'draftink',
  what: 'a predicted character is painted in the colour the application draws its draft in',
  needsFreshPane: true,
  // The product claim this file exists for is that a predicted character is
  // indistinguishable from the echoed one, and colour is half of that. Two faults have
  // shipped against it, in opposite directions, and neither was visible to any check that
  // reads the grid — the DOM held the right character both times.
  //
  //   The theme's foreground, always. grok paints its composer in its own palette, so
  //   under a light dashboard theme every predicted character came out rgb(10,10,10) on
  //   rgb(18,18,18): painted on time, and invisible until the echo replaced it.
  //
  //   The row's widest ink, always. A composer nobody has typed into holds no draft at
  //   all, only chrome, so the first keystrokes of every line were painted in zsh's
  //   prompt colour and in Claude Code's dim placeholder.
  //
  // So the assertion is neither of those colours by name: it is that the overlay's glyph
  // and the application's own glyph, at the same cell, are the same colour. That holds
  // whatever palette an application picks, and it is the thing the user actually sees.
  //
  // Both states are exercised per app, because they take different paths. The FIRST
  // keystroke of a session has no draft to learn from and rests on the fallback; a later
  // one is painted in the colour learned from the application's own echo.
  async run(rig): Promise<string> {
    const page = await rig.page(PIXEL_VIEWPORT);
    const notes = await sweep(rig, page, INK_APPS, async (app, v) => {
      const name = app ?? 'zsh';
      if (!(await quiet(page, 600, 20000))) {
        v.skip('the wire never settled after the app took the pane');
        return;
      }

      // `phase` types, catches the overlay mid-flight, then lets the echo land and
      // reads the application's own colour at the very cell the overlay painted.
      const phase = async (label: string, keys: string) => {
        await page.keyboard.type(keys, { delay: 12 });
        const ink = await overlayInk(page);
        if (!ink) {
          v.skip(`${label}: no glyph was still unreconciled to read a colour from`);
          return;
        }
        if (!(await quiet(page, 700, 12000))) {
          v.skip(`${label}: the echo never settled, so there is nothing to compare against`);
          return;
        }
        const real = await settledInk(page, ink.vrow, ink.col);
        if (!real) {
          v.skip(`${label}: the application drew nothing at column ${ink.col}`);
          return;
        }
        if (real.ch !== ink.text.charAt(0)) {
          v.skip(
            `${label}: predicted ${JSON.stringify(ink.text.charAt(0))} at column ${ink.col}, ` +
            `the application put ${JSON.stringify(real.ch)} there — different cells cannot be compared`,
          );
          return;
        }
        const a = rgbOf(ink.color);
        const b = rgbOf(real.color);
        if (!a || !b) {
          v.skip(`${label}: could not read ${ink.color} / ${real.color} as colours`);
          return;
        }
        // Alpha counts: a prediction painted in xterm's dim colour is rgba(..., 0.5) over
        // the same rgb, and dropping the fourth number would pass it as a match.
        const off = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]),
                             Math.abs(alphaOf(ink.color) - alphaOf(real.color)) * 255);
        if (off > TOLERANCE) {
          v.fail(
            `${label}: predicted ${JSON.stringify(ink.text.charAt(0))} in ${ink.color}, ` +
            `the application drew it in ${real.color} (off by ${off})`,
          );
        } else {
          v.pass(`${name}/${label} ${real.color}`);
        }
      };

      // Nothing has been typed into this application yet, so there is no draft to have
      // learned a colour from. This is the state both shipped faults were in.
      await phase('first', 'q');
      // And now there is: the colour comes from the application's own echo.
      await phase('learned', 'wertyu');
      await page.keyboard.press('Control+U');
      await Bun.sleep(300);
    });
    // A state that was not measured is not a pass: the two faults this check exists for
    // live in specific rows, and a run that skipped them has not looked (sweep makes any
    // skip inconclusive).
    return `${notes.length} state(s) matched the application's own ink: ${notes.join(', ')}`;
  },
};

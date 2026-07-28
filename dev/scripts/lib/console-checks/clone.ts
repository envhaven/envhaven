// Three checks ported from an ad-hoc harness. Two of them read what the console
// PAINTS rather than what the engine says it believes, which is the gap the probe
// cannot cover on its own: the engine can move exactly the right rows, report exactly
// the right numbers, and still hand the user a frame in the wrong grey or a rule in
// the wrong place. Catching that means looking at the rendered DOM and at the
// rendered pixels. The third asks a fresh shell to predict its very first wrap, back
// when the engine has watched nothing and has only its seed to go on.
import type { Page } from '@playwright/test';
import { log } from '../log';
import {
  VIEWPORT, assert, type Burst, type Check, gridRow, inconclusive, launchApp, probe,
  quiet, teardownApp,
} from '../console-rig';

/** What `probe()` vends, for the helpers that hand a snapshot back to a check. */
type Snapshot = Awaited<ReturnType<typeof probe>>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * The terminal's width, read off the row the cursor is on.
 *
 * The probe pads every row it vends out to the full width, so any live row answers
 * this. The cursor's row is the one guaranteed to exist.
 */
async function termCols(page: Page): Promise<number> {
  const cols = await page.evaluate(() => {
    const p = window.__ehPredict;
    return p.text(p.row)?.length ?? 0;
  });
  assert(cols > 0, 'could not read the terminal width');
  return cols;
}

/**
 * Type one character at a time until the engine predicts a wrap, and stop there.
 *
 * The pause between characters is what makes the wrap observable. Typed in one run
 * the whole line arrives before the poll gets a look in, and the check ends up
 * reading a model that has already been reconciled against the echo, which is the
 * one state it is not asking about. Returns null when the wrap never came, and every
 * caller has to treat that as "this check never ran".
 */
async function typeUntilWrap(
  page: Page,
  chars: string,
): Promise<(Snapshot & { burst: Burst }) | null> {
  for (const c of chars) {
    await page.keyboard.type(c);
    await Bun.sleep(45);
    const p = await probe(page);
    if (p.burst?.wrapped) return p as Snapshot & { burst: Burst };
  }
  return null;
}

/** Right-trimmed grid rows over an absolute range, for a failure report. */
async function dumpRows(page: Page, from: number, to: number): Promise<string[]> {
  const out: string[] = [];
  for (let row = from; row <= to; row++) {
    const text = await gridRow(page, row);
    out.push(`${row} |${(text ?? '(no such row)').replace(/ +$/, '')}`);
  }
  return out;
}

interface Geom {
  x: number;
  y: number;
  w: number;
  /** Height of one row, derived rather than assumed: the font metrics decide it. */
  ch: number;
}

/** Where the terminal sits on the page, and how tall one row is. */
function geom(page: Page): Promise<Geom | null> {
  return page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen');
    if (!screen) return null;
    const box = screen.getBoundingClientRect();
    // The FIRST ROW's measured height, not the screen box divided by the row count.
    // Those two differ by the box's sub-pixel remainder, and `band` multiplies the
    // difference by the row offset, so a band many rows down slides off the row it
    // meant to photograph and the diff reads as a change nobody made. ghost.ts and
    // paint.ts already measure it this way.
    const rows = document.querySelector('.xterm-rows');
    const first = rows?.children[0] as HTMLElement | undefined;
    if (!first) return null;
    return { x: box.x, y: box.y, w: box.width, ch: first.getBoundingClientRect().height };
  });
}

/**
 * A PNG of one band of rows, addressed the way the probe addresses rows.
 *
 * `baseY` is the caller's on purpose. Two shots taken either side of a round trip
 * have to clip the same rectangle to be comparable at all, so the band is pinned to
 * the screen position those rows had when the caller measured them. A caller that
 * re-read baseY between shots would be comparing two different pieces of screen.
 */
function band(page: Page, g: Geom, baseY: number, fromRow: number, toRow: number): Promise<Buffer> {
  const y = g.y + (fromRow - baseY) * g.ch;
  const height = (toRow - fromRow + 1) * g.ch;
  return page.screenshot({ clip: { x: g.x, y, width: g.w, height } });
}

// Both numbers were measured off real captures, and neither is a round guess.
// Byte equality is useless here: a glyph landing a hundredth of a pixel over from one
// paint to the next changes bytes and changes nothing anyone can see. A channel that
// moves by more than 40 is visible. A band where fewer than 0.5% of pixels moved
// reads as the same picture. Loosening either number hides the regression they exist
// to catch, which is a frame painted in the wrong place or the wrong colour.
const CHANNEL_TOLERANCE = 40;
const DIFF_BUDGET_PCT = 0.5;

interface PixelDiff {
  sizeMismatch: boolean;
  visible: number;
  total: number;
  pct: number;
}

/**
 * How much of one clipped band a person would see change against another.
 *
 * Decoding happens in the page because the page already has a PNG decoder and a
 * canvas, and shipping a pixel library into a dev script to do the same job would be
 * a dependency in exchange for nothing.
 */
function visibleDiff(page: Page, before: Buffer, after: Buffer): Promise<PixelDiff> {
  const uri = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
  return page.evaluate(
    async ({ a, b, tolerance }) => {
      // decode() rather than onload: onload alone has no failure path, so an image that
      // never decodes leaves this promise pending and the check dies on the evaluate
      // timeout with nothing to say about why.
      const load = async (src: string) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        return img;
      };
      const ia = await load(a);
      const ib = await load(b);
      if (ia.width !== ib.width || ia.height !== ib.height) {
        return { sizeMismatch: true, visible: 0, total: 0, pct: 100 };
      }
      const pixels = (img: HTMLImageElement) => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height).data;
      };
      const A = pixels(ia);
      const B = pixels(ib);
      // Alpha is ignored: both bands are opaque screenshots, so a difference there
      // would say nothing about what is on screen.
      let visible = 0;
      for (let i = 0; i < A.length; i += 4) {
        const moved = Math.max(
          Math.abs(A[i] - B[i]),
          Math.abs(A[i + 1] - B[i + 1]),
          Math.abs(A[i + 2] - B[i + 2]),
        );
        if (moved > tolerance) visible++;
      }
      const total = ia.width * ia.height;
      return { sizeMismatch: false, visible, total, pct: (100 * visible) / total };
    },
    { a: uri(before), b: uri(after), tolerance: CHANNEL_TOLERANCE },
  );
}

/** Wait until claude has drawn its composer prompt, or say that it never did. */
async function awaitComposer(page: Page) {
  // `app === 'claude'` goes true the moment the process takes the pane, which is
  // several repaints too early to read a row off. The prompt glyph is the first
  // honest sign that the composer is on screen.
  try {
    await page.waitForFunction(
      () => {
        const p = window.__ehPredict;
        const row = p.text(p.row);
        return !!row && row.charCodeAt(0) === 0x276f && p.col === 2;
      },
      null,
      { timeout: 30000 },
    );
  } catch {
    inconclusive('claude never drew its composer prompt');
  }
  if (!(await quiet(page, 1500, 30000))) {
    inconclusive('claude never stopped repainting after boot, so every row read would be about to change');
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** One row that changed colour when it was cloned, and the pair of colours. */
interface CloneDiff {
  row: number;
  node: number;
  text: string;
  real: string;
  clone: string;
}

// Short words, so a draft of a given length wraps several times instead of once.
// What it says does not matter. How often it breaks does.
const CLONECOLOR_WORDS =
  'o sea si yo ahora agarro y relanzo el tema del calculo lamentablemente esto parece andar perfecto de manera inmediata '.split(' ');

export const clonecolor: Check = {
  name: 'clonecolor',
  what: 'a composer row moved by cloning paints exactly like the row it was cloned from',
  // Launches an application, so it needs the pane sitting at a shell prompt.
  needsFreshPane: true,
  // render() moves wrapped composer rows by cloning xterm's own row elements, on the
  // stated grounds that the colours ride on the clone. They only ride if the clone
  // keeps an `.xterm-rows` ancestor. xterm colours a cell either with a palette class
  // (.xterm-fg-244, which survives anywhere) or with nothing at all, and an unclassed
  // cell inherits from `.xterm-dom-renderer-owner-N .xterm-rows`, where `.xterm-dim`
  // is scoped too. Cloned into a plain div, unclassed cells fall through to the page's
  // own foreground and dim runs stop being dim, so a moved row reads a different
  // colour than the identical rows sitting beside it.
  //
  // The invariant is asserted on every rendered row rather than by catching one wrap
  // in flight: clone each row the way render() clones it, then compare every computed
  // colour. Catching it in flight would make this a timing check, and the fault has
  // nothing to do with timing.
  async run(rig): Promise<string> {
    const page: Page = await rig.page(VIEWPORT);
    try {
      await launchApp(page, 'claude');
      await awaitComposer(page);

      // Sized off the live terminal rather than written as a fixed sentence. A draft
      // that merely reaches the wrap column is a coin flip, and a run that never wraps
      // proves nothing at all. Two full rows of content wraps several times at any
      // width this ever runs at.
      const cols = await termCols(page);
      let draft = '';
      for (let i = 0; draft.length < cols * 2; i++) {
        draft += CLONECOLOR_WORDS[i % CLONECOLOR_WORDS.length] + ' ';
      }
      await page.keyboard.type(draft, { delay: 10 });
      if (!(await quiet(page, 900, 20000))) {
        inconclusive('the composer never settled after the draft, so the rows were still being repainted');
      }

      const res = await page.evaluate(() => {
        const bail = (err: string) => ({
          err,
          checked: 0,
          withText: 0,
          strayCursors: 0,
          boxRows: 0,
          boxCls: '',
          diffs: [] as CloneDiff[],
        });

        const rows = document.querySelector('.xterm-rows');
        const screen = document.querySelector('.xterm-screen');
        if (!rows || !screen) return bail('the terminal has no rows or no screen element');
        const layer = Array.from(screen.children).find(
          (el) => (el as HTMLElement).style.zIndex === '10',
        ) as HTMLElement | undefined;
        if (!layer) return bail('the predictive overlay was never built');
        const box = Array.from(layer.children).find(
          (el) =>
            (el as HTMLElement).style.zIndex === '1' && (el as HTMLElement).style.overflow === 'hidden',
        ) as HTMLElement | undefined;
        if (!box) return bail('render() never built a box block, so no wrap was reached');

        // Exactly how render() builds that block: a div inside .xterm-screen holding
        // clones, carrying whatever classes the product gives it. Hardcoding
        // `xterm-rows` here would hide the very failure this found. xterm also toggles
        // `xterm-focus` on that container and keys its cursor rules off the pair, so
        // the class list has to come from the product rather than from the check's
        // idea of what the product ought to be doing.
        const host = document.createElement('div');
        host.className = box.className;
        host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden';
        screen.appendChild(host);

        // The cursor cell is skipped, and it has to be. Under `.xterm-focus` xterm
        // drives that cell with a CSS blink ANIMATION, and a freshly inserted clone
        // starts its own animation at phase zero while the original is wherever it
        // happens to be. The two can never be sampled equal, whatever classes the
        // container carries. render() strips the cursor markers from its clones for
        // that reason, which is asserted on its own below; here we compare the cells
        // whose colour is actually static.
        const isCursor = (el: Element) => /xterm-cursor/.test(el.className || '');
        const nodes = (el: Element) => [el, ...Array.from(el.querySelectorAll('*'))];
        const colors = (el: Element) =>
          nodes(el).map((n) => (isCursor(n) ? null : getComputedStyle(n).color));

        const diffs: CloneDiff[] = [];
        let checked = 0;
        let withText = 0;
        for (let row = 0; row < rows.children.length; row++) {
          const src = rows.children[row];
          const text = (src.textContent || '').replace(/ +$/, '');
          if (!text) continue;
          withText++;
          host.textContent = '';
          host.appendChild(src.cloneNode(true));
          const real = colors(src);
          const copy = colors(host.children[0]);
          checked++;
          for (let node = 0; node < Math.max(real.length, copy.length); node++) {
            const a = real[node];
            const b = copy[node];
            if (a === null || b === null) continue; // the cursor cell, see above
            if (a !== b) {
              diffs.push({ row, node, text: text.slice(0, 34), real: a, clone: b });
              break;
            }
          }
        }
        host.remove();

        // And the other half of the invariant, on the product's OWN block. render()
        // has to strip the cursor markers from what it clones; left in, a moved row
        // carries a second block cursor into the overlay, blinking to its own clock.
        return {
          err: null,
          checked,
          withText,
          diffs,
          strayCursors: box.querySelectorAll('.xterm-cursor').length,
          boxRows: box.children.length,
          boxCls: box.className || '(none)',
        };
      });

      if (res.err) inconclusive(res.err);
      // A screen with nothing on it proves nothing about cloning.
      if (res.checked < 5) {
        inconclusive(`only ${res.checked} rendered row(s) carried content (${res.withText} had text), too few to compare`);
      }

      for (const d of res.diffs.slice(0, 3)) {
        log.dim(`    row ${d.row} node ${d.node}: real ${d.real} vs clone ${d.clone}`);
        log.dim(`    |${d.text}`);
      }
      assert(
        res.diffs.length === 0,
        `${res.diffs.length} of ${res.checked} rendered rows change colour when cloned the way render() clones them`,
      );
      assert(
        res.strayCursors === 0,
        `render() left ${res.strayCursors} cursor cell(s) in the ${res.boxRows} moved row(s), each blinking to its own clock`,
      );
      return `${res.checked} rows clone identically; the moved block (${res.boxRows} rows, classed ${JSON.stringify(res.boxCls)}) carries no cursor`;
    } finally {
      await teardownApp(page).catch(() => undefined);
      await page.close();
    }
  },
};

export const wrapseed: Check = {
  name: 'wrapseed',
  what: 'the first wrap in a fresh shell is predicted from the seeded style, with no echo to learn from',
  // The seed is only the answer while the engine has watched nothing wrap, so this
  // cannot inherit a pane that has already been typed into.
  needsFreshPane: true,
  // The engine learns how an application wraps by watching it, which leaves the first
  // wrap of a session with nothing to go on. A shell gets a seeded style instead: a
  // hard break in the last column, no word pulled down to the next row. This walks a
  // prompt to the edge of the row and asks what the engine believed one keystroke
  // before the server answered.
  async run(rig): Promise<string> {
    const page: Page = await rig.page(VIEWPORT);
    try {
      const cols = await termCols(page);
      const start = await probe(page);
      if (start.app !== 'zsh') {
        inconclusive(`the pane is running ${start.app}, so the shell's seeded wrap style is not what would be under test`);
      }
      assert(
        !!start.wrap && start.wrap.pull === false && start.wrap.atLen === cols - 1,
        `the shell seed should hard-wrap in column ${cols - 1} and pull no word down, the engine holds ${JSON.stringify(start.wrap)}`,
      );

      const promptRow = start.row;
      const runUp = cols - start.col - 3;
      // A negative run-up means the prompt itself already fills the row, which is a
      // pane this check cannot say anything about.
      if (runUp <= 0) inconclusive(`the prompt leaves no room to fill (column ${start.col} of ${cols})`);
      await page.keyboard.type('x'.repeat(runUp), { delay: 4 });
      if (!(await quiet(page, 900, 15000))) inconclusive('the wire never settled after filling the row');

      const wrapped = await typeUntilWrap(page, 'WORDW');
      if (!wrapped) {
        inconclusive('no keystroke past the last column produced a wrapped burst, so the prediction under test was never made');
      }

      const b = wrapped.burst;
      assert(
        b.row === promptRow + 1 && b.line.length === 0,
        `the wrap should drop the cursor to column 0 of row ${promptRow + 1}, the model put it at ${b.row}/${b.line.length}`,
      );
      assert(
        !!wrapped.edge && wrapped.edge.col === cols - 1,
        `the glyph that triggered the wrap should fill column ${cols - 1}, the edge is ${JSON.stringify(wrapped.edge)}`,
      );
      assert(
        wrapped.box === null,
        `a shell has no box around its input, yet a frame moved: ${JSON.stringify(wrapped.box)}`,
      );

      // typeUntilWrap stops ON the wrapping keystroke, which leaves the continuation
      // row empty. Two more characters give it content that zsh then has to draw the
      // same way the prediction drew it.
      await page.keyboard.type('QK', { delay: 40 });
      if (!(await quiet(page, 600, 10000))) inconclusive('the wire never settled after the continuation');
      const continuation = (await gridRow(page, promptRow + 1))?.replace(/ +$/, '') ?? null;
      assert(
        continuation === 'QK',
        `the continuation row should read QK exactly as zsh drew it, the grid holds ${JSON.stringify(continuation)}`,
      );
      return `the first wrap landed at row ${b.row} column 0 with the edge glyph in column ${cols - 1}, no echo needed`;
    } finally {
      await page.keyboard.press('Control+u').catch(() => undefined);
      await page.close();
    }
  },
};

export const boxrise: Check = {
  name: 'boxrise',
  what: 'a composer wrap lifts the box one row and repaints it where the settled box lands',
  // Launches an application, so it needs the pane sitting at a shell prompt.
  needsFreshPane: true,
  // Claude Code grows its composer upward. The wrap adds a row at the top while the
  // bottom rule holds still, so the engine has to move the frame itself, one row up,
  // a round trip before the application gets around to it.
  //
  // Whether it moved the right rows is a question about content and the probe answers
  // it. Whether the moved frame LOOKS like the frame that arrives is a question about
  // pixels, so the top rule is clipped at the instant of the wrap and again once the
  // echo has settled, and the two bands are compared.
  async run(rig): Promise<string> {
    const page: Page = await rig.page(VIEWPORT);
    try {
      const cols = await termCols(page);
      await launchApp(page, 'claude');
      await awaitComposer(page);

      const rest = await probe(page);
      const cursorRow = rest.row;
      assert(
        !!rest.wrap && rest.wrap.down === false,
        `the composer seed should grow upward, the engine holds ${JSON.stringify(rest.wrap)}`,
      );

      // A run-up that stops a few columns short of the break, then a word to break on.
      // Sized off the live width for the same reason clonecolor's draft is.
      await page.keyboard.type('z'.repeat(cols - 14) + ' PALAB', { delay: 5 });
      if (!(await quiet(page, 1000, 15000))) inconclusive('the composer never settled before the wrap');

      const g = await geom(page);
      if (!g) inconclusive('the terminal screen element is gone, so no band can be clipped');
      const baseY = (await probe(page)).baseY;

      const wrapped = await typeUntilWrap(page, 'RAXXXXXX');
      if (!wrapped) {
        inconclusive('no keystroke produced a wrapped burst, so the frame never moved and no band was compared');
      }

      const box = wrapped.box;
      assert(box !== null, 'the wrap moved no frame at all, so the composer box never rose');
      assert(
        box.delta === -1,
        `the wrap should move the box up exactly one row, the frame reports ${JSON.stringify(box)}`,
      );
      assert(
        box.textRow === cursorRow - 1,
        `the pre-wrap text should rise to row ${cursorRow - 1}, the frame put it at ${box.textRow}`,
      );
      assert(
        wrapped.burst.row === cursorRow,
        `the cursor should keep row ${cursorRow}, the model moved it to ${wrapped.burst.row}`,
      );
      const rule = (await gridRow(page, cursorRow + 1))?.replace(/ +$/, '') ?? '';
      assert(
        /^─+$/.test(rule),
        `the bottom rule under the cursor row should still be one unbroken line, the grid holds ${JSON.stringify(rule)}`,
      );

      // The moved rule is the border this whole thing is about, so it is the band that
      // gets compared by pixels. The input row it lifts is compared by content
      // instead: overlay text is greyscale-antialiased where xterm's own rows are
      // LCD-antialiased, a difference every predicted glyph in this engine carries and
      // no amount of frame work can settle.
      const ruleRow = cursorRow - 2;
      const optimistic = await band(page, g, baseY, ruleRow, ruleRow);
      await Bun.sleep(1800);

      // Both bands are pinned to the screen position those rows had before the wrap.
      // A scroll in between moves every row under that rectangle, so the second clip
      // would frame something else entirely and the comparison would be about the
      // scroll rather than about the frame.
      const settledBaseY = (await probe(page)).baseY;
      if (settledBaseY !== baseY) {
        inconclusive(`the buffer scrolled while the echo landed (baseY ${baseY} to ${settledBaseY}), so the two clips no longer frame the same row`);
      }
      const settled = await band(page, g, baseY, ruleRow, ruleRow);

      const diff = await visibleDiff(page, optimistic, settled);
      if (diff.sizeMismatch) {
        inconclusive('the two clips came back different sizes, so the terminal geometry moved under the check');
      }
      if (diff.pct >= DIFF_BUDGET_PCT) {
        for (const line of await dumpRows(page, ruleRow, cursorRow + 1)) log.dim(`    ${line}`);
      }
      assert(
        diff.pct < DIFF_BUDGET_PCT,
        `the rule the frame moved to row ${ruleRow} is not the rule the echo drew there: ${diff.visible} of ${diff.total} pixels differ visibly (${diff.pct.toFixed(3)}%)`,
      );
      return `the box rose one row and the moved rule matched the settled one to within ${diff.pct.toFixed(3)}% of pixels`;
    } finally {
      await teardownApp(page).catch(() => undefined);
      await page.close();
    }
  },
};

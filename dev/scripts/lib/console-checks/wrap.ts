import { tuiTable } from '../engine';
import { type AppName, APPS, appsWith } from '../console-apps';
import {
  VIEWPORT, type Check, type WrapStyle, composerInputProbe, probe, quiet, readTrace, resetsSince, sweep, traceMark,
} from '../console-rig';

// ---------------------------------------------------------------------------
// seedwrap
// ---------------------------------------------------------------------------

// The applications the engine seeds a wrap style for: the shell first, then every row of
// console-apps.ts marked `seed`, in roster order. The shell has to run on the fresh pane,
// because a burst on the terminal's last row never predicts the scroll. The numbers each
// one is held to come from the model's own table (lib/engine.ts reads it out of the
// shipped asset), so a re-measured row changes exactly one place. What proves the numbers
// describe the real applications is `bun dev/scripts/measure-tui.ts`, which drives each
// one in a real terminal and measures its composer. This check asks a narrower question:
// does the engine seed at runtime what the model's table says, at the live width, and does the
// first wrap paint. test-console-ui.ts holds the roster to the table without a browser,
// so an app marked `seed` with no model row, or a model row with no marked app, fails
// there; deleting either side is loud.
const SEEDED: (AppName | null)[] = [null, ...appsWith('seed')];
const paneApp = (app: AppName | null) => app ? APPS[app].paneApp : 'zsh';

// The characters that carry a line across its wrap column. The length doubles as the
// ceiling on how far behind the wrap column a lead may land: a lead that fell further
// back than this never approached the wrap it was aiming at, and whatever the run then
// measured belongs to some other part of the line.
const CROSSING = 'wxyzabcdefghijklmnopqrstuvwxyzabcdefghij';

export const seedwrap: Check = {
  name: 'seedwrap',
  what: 'a seeded application predicts its first wrap before it has learned one',
  needsFreshPane: true,
  // The table exists so that an application wraps optimistically the first time, with
  // nothing learned yet. Two things have to hold for that, per app: the engine adopts
  // the table's row the moment the app takes the pane, at the live terminal width
  // (atLen is cols - pad, never a constant), and typing past that column paints the
  // wrap rather than riding the echo.
  //
  // The second one keys on burst.wrapped. wrapStep sets that flag only on the path that
  // paints, while a wrap that rides goes through wrapRide into a handoff, which leaves
  // wrapped false and draining true. So `wrapped && !draining` reads as exactly "this
  // wrap was painted rather than waited for", and unlike `matched` it says nothing
  // about how far behind the echo happened to be.
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    const table = tuiTable();
    const done = await sweep(rig, page, SEEDED, async (app, v) => {
      const name = paneApp(app);
      const row = table[name];
      if (!row) { v.fail("no row in the model's table, so there is nothing to seed from"); return; }

      // A composer still drawing itself has a cursor column that means nothing, and
      // every measurement below is taken from that column.
      if (!(await quiet(page, 600, 20000))) {
        v.skip('the wire never settled after the app took the pane');
        return;
      }

      // 1. The seed, at the live width.
      const start = await probe(page);
      // The terminal's own width, never a row's string length: fx's and goose's
      // header rows carry a combining mark, which read 128 cells as 129 and judged a
      // correct seed of 128 - pad against 129 - pad.
      const width = start.cols;
      if (!width) { v.skip('could not read the terminal width'); return; }
      const seed = start.wrap;
      if (!seed) { v.fail('no wrap style when it took the pane, so nothing was seeded'); return; }
      const want = { atLen: width - row.pad, indent: row.indent, pull: row.pull, down: row.down, lazy: row.lazy, spacePull: row.spacePull };
      const wrong = (Object.keys(want) as (keyof typeof want)[]).filter((k) => want[k] !== seed[k]);
      if (wrong.length) {
        v.fail(`seed wrong on ${wrong.join(', ')} at ${width} cols (want ${JSON.stringify(want)}, got ${JSON.stringify(seed)})`);
      }

      // 2. The first wrap has to paint. Type up to a word boundary a little short of
      //    the wrap column, so a composer that pulls words has a whole word to move,
      //    then send the characters that cross it.
      const runway = seed.atLen - start.col;
      if (runway < 12) { v.skip(`${runway} columns of runway, which leaves nothing to wrap`); return; }
      const lead = 'abcde '.repeat(Math.ceil(runway / 6) + 1).slice(0, runway - 8);
      await page.keyboard.type(lead.slice(0, lead.lastIndexOf(' ') + 1), { delay: 4 });
      if (!(await quiet(page, 600, 12000))) { v.skip('the wire never settled after the lead'); return; }

      const pre = (await probe(page)).col;
      // One character past the wrap column: the model wraps on the keystroke it takes
      // while the line already measures atLen, so it needs (atLen - col) + 1 of them.
      const rest = seed.atLen - pre + 1;
      if (rest < 1 || rest > CROSSING.length) {
        v.skip(`the lead landed at column ${pre}, ${rest} short of atLen ${seed.atLen}`);
        return;
      }
      await page.keyboard.type(CROSSING.slice(0, rest), { delay: 25 });

      // Read while the burst is still live. Settling first hands back a reconciled
      // row, and a reconciled row is the one state that cannot tell a painted wrap
      // from a wrap that rode the echo home.
      const post = (await probe(page)).burst;
      if (!post) {
        v.fail(`no burst after crossing the wrap column (${pre} to atLen ${seed.atLen})`);
      } else if (!post.wrapped || post.draining) {
        v.fail(`the wrap rode the echo instead of painting (wrapped=${post.wrapped} draining=${post.draining} line=${JSON.stringify(post.line)})`);
      } else if (seed.pull && row.lazy) {
        // A lazy wrap's first phase paints the edge char on the old row and an EMPTY
        // continuation at the indent; the word moves one keystroke later.
        if (post.line.length !== seed.indent || /\w/.test(post.line)) {
          v.fail(`a lazy wrap's continuation should be exactly the ${seed.indent}-cell indent, got ${JSON.stringify(post.line)}`);
        } else if (!post.pullPend) {
          // Read off the burst rather than the edge glyph: the edge retires the moment
          // the crossing char's own echo lands, which on a fast link beats the probe.
          v.fail('a lazy wrap left no pull pending for the next keystroke');
        } else {
          v.pass(`${name} at ${seed.atLen}`);
        }
      } else if (seed.pull && post.line.search(/[^\s─-▟]/) !== seed.indent) {
        // The continuation carries the composer's own left chrome (grok's and Kimi's `│`
        // plus gutter, fx's `┃ `), so the draft's start is the first cell that is neither
        // blank nor box-drawing, the way the engine's textStart reads it. grok and Kimi
        // draw both ends rather than merely leaving them empty, so they fail if
        // the engine ever goes back to reading a row as first non-blank to last non-blank.
        v.fail(`the continuation starts at column ${post.line.search(/[^\s─-▟]/)}, expected indent ${seed.indent}`);
      } else {
        v.pass(`${name} at ${seed.atLen}`);
      }
    });
    return `${done.length} apps seeded from the table and painted a first wrap: ${done.join(', ')}`;
  },
};

// ---------------------------------------------------------------------------
// wrapkeep
// ---------------------------------------------------------------------------

// Long enough to cross several wrap columns without a pause, which is the whole point.
// Every word in it is distinct, so a row that shows up twice can only be a rendering
// fault rather than the sentence repeating itself.
const KEEP_SENTENCE =
  'siento que cuando tipeo muy rapido no le doy ninguna chance al renderizado optimistico de esta ' +
  'terminal para resolverlo bien y entonces aparecen lineas duplicadas justo abajo del todo mientras sigo ' +
  'escribiendo sin parar durante bastante tiempo para cruzar varios saltos de linea seguidos y ver que pasa ' +
  'con la direccion de crecimiento de la caja cuando el eco viene atrasado respecto del modelo local';

// Fast enough that the model stays in front of the pane for the whole run. The failure
// under test only exists while the echo is behind; a typist the server can keep up with
// never reaches it.
const KEEP_DELAY = 30;

/** One frame of the watcher's view: what the model believes, and what the pane holds. */
interface Sample {
  w: WrapStyle | null;
  has: boolean;
  off: boolean;
  len: number;
  row: number;
  brow: number | null;
}

export const wrapkeep: Check = {
  name: 'wrapkeep',
  what: 'typing through wraps without pausing never costs the model its grip on the pane',
  needsFreshPane: true,
  // This is the guard for the reported duplicated line. The artifact is the overlay
  // painting a row the application is not using, and it is reached by a chain that this
  // check watches end to end:
  //
  //   the typist stays ahead of the echo, so the burst never matches
  //     -> the burst's snapshot of the row goes stale and it is rebound to a grid that
  //        is several keystrokes behind, silently losing them
  //     -> a correct wrap is judged mispredicted and the growth DIRECTION is flipped
  //     -> the next wrap paints its continuation on a row the pane never used, and two
  //        copies of the same line sit on screen.
  //
  // So the assertions are: no rebind while the keys are flowing, no direction flip, no
  // style unlearned, and no paint on a row the pane is not using.
  //
  // The tolerances are deliberately asymmetric, and flattening them quietly breaks the
  // check for every seeded app. What sets an app's budget is where its composer sits
  // when the run starts, which decides whether it has anywhere left to grow, and the
  // engine's own row records that as `down`.
  //
  // grok pins its box to the BOTTOM of the pane from the first frame, so upward is its
  // only direction and zero flips is structural, not a budget. Claude Code resolves
  // its nullable seed from the first ridden wrap. It and Codex, Antigravity, Kimi,
  // Muse, pi and fx can grow into blank rows before the pane fills, then legitimately
  // change direction once. They get a single flip each, and their off-grid frames are not
  // read at all, because around a legitimate flip an overlay one row off the cursor is
  // the pane moving underneath a correct prediction and this check has no way to tell
  // that from the fault. goose hard-wraps like the shell: no box to grow, so no direction
  // to flip, and its zero coincides with the pinned boxes' for a different reason.
  //
  // Zero flips is a WEAK reading on its own: a direction that cannot be corrected
  // counts zero exactly like a direction that was right. What separates them here is
  // the off-grid assertion, which the zero-flip apps are held to: a continuation
  // painted on a row the pane is not using shows up there whether or not anything ever
  // tried to fix it. Claude Code seeded downward is what that pairing caught.
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    const table = tuiTable();
    // Each app gets a clean pane. Left on the previous app's output, a composer that
    // floats in a scrolling stream starts pinned to the bottom with no blank rows below
    // it, so its growth arrives as a scroll and the seeded direction is legitimately
    // wrong. That is a different phenomenon from the one under test, and it would land
    // here as a failure.
    const clearPane = async () => {
      await page.keyboard.type('clear', { delay: 5 });
      await page.keyboard.press('Enter');
      await Bun.sleep(900);
    };
    const done = await sweep(rig, page, appsWith('seed'), async (app, v) => {
      const name = paneApp(app);
      const row = table[name];
      const flipsAllowed = row?.down === false ? 0 : 1;
      if (!(await quiet(page, 1500, 30000))) {
        v.skip('the wire never settled after boot, so the seed cannot be trusted');
        return;
      }
      const seed = (await probe(page)).wrap;
      if (!seed) { v.skip('no seeded wrap style, so there is nothing to keep'); return; }

      // A process name is not a composer: first-run and sign-in screens take the pane
      // under the same executable while ignoring ordinary draft input.
      const unavailable = await composerInputProbe(page, name);
      if (unavailable) { v.skip(unavailable); return; }

      // The fault signal is the engine's own decision trace: a burst that dies is a
      // `reset` with its reason attached. NOT the burst's absence: a burst that matched
      // and closes mid-run hands the next keystroke a fresh, current burst, and a
      // watcher keying on presence alone files that handoff as a lost grip.
      const watermark = await traceMark(page);

      let flips = 0, unlearns = 0, wraps = 0, offGrid = 0;
      let hadStyle = true, lastDown = seed.down, prevLen = 0;
      const offGridDiag: string[] = [];
      let typing = true;

      const watch = (async () => {
        while (typing) {
          const s: Sample = await page.evaluate(() => {
            const p = window.__ehPredict, b = p.burst;
            return {
              w: p.wrap, has: !!b, off: !!(b && b.offGrid && b.row !== p.row), len: b ? b.line.length : 0,
              row: p.row, brow: b && b.row,
            };
          });
          // A wrap is the model's line getting suddenly shorter: the continuation
          // starts over near the indent while the row it left behind stays put.
          if (s.has && prevLen - s.len > 20) wraps++;
          if (s.w && hadStyle && s.w.down !== null && lastDown !== null && s.w.down !== lastDown) flips++;
          if (!s.w && hadStyle) unlearns++;
          if (s.off) {
            offGrid++;
            if (!offGridDiag.length) {
              offGridDiag.push(`overlay on row ${s.brow}, pane cursor on row ${s.row}`);
            }
          }
          prevLen = s.has ? s.len : 0;
          hadStyle = !!s.w;
          if (s.w) lastDown = s.w.down;
          await Bun.sleep(20);
        }
      })();

      // The watcher stops on every path: after a key throws it would keep reading a page
      // that is being closed, and its rejection would go unhandled.
      try {
        await page.keyboard.type(KEEP_SENTENCE, { delay: KEEP_DELAY });
      } finally {
        typing = false;
        watch.catch(() => undefined);
      }
      await watch;

      // Everything this check asserts was counted while the keys were flowing, so a
      // wire that will not fall silent afterwards invalidates nothing. It costs only
      // the closing style read, and that read is a diagnosis rather than a verdict,
      // so the timeout is reported in place instead of skipping the app.
      const settled = await quiet(page, 400, 6000);
      const final = settled
        ? JSON.stringify((await probe(page)).wrap)
        : 'unread, the wire never fell silent after the run';

      // The deaths, from the engine's own ring since this app's watermark.
      const resets = await resetsSince(page, watermark);

      let failed = false;
      // Every failure rides with the engine's decision trace: a burst death is two
      // frames stale by the time it is reported, and the ring is the only record of
      // why the engine lost the pane.
      const fail = async (message: string) => {
        failed = true;
        v.fail(`${message}\n    trace: ${(await readTrace(page)).slice(-16).join(' | ')}`);
      };
      if (resets.length > 0) await fail(`${resets.length} burst reset(s) mid-run (${resets[0].replace(/ @\d+$/, '')}), the model lost the pane and re-read a stale grid`);
      if (flips > flipsAllowed) await fail(`${flips} direction flip(s), at most ${flipsAllowed} is legitimate here`);
      if (unlearns > 0) await fail(`${unlearns} unlearn(s) of a measured wrap style (seed ${JSON.stringify(seed)}, final ${final})`);
      // Only for the apps pinned to the pane's bottom (a zero-flip budget): see the note
      // above on why the floating ones are read for flips alone. And only for WORD-pull
      // apps: a hard-wrapping one (goose, zsh) drops its burst onto the continuation
      // row on purpose, so it sits off the pane's row for the whole echo window —
      // structurally, on every wrap, with no fault to read into it. A mispredicted
      // hard wrap shows up as a reset instead, which the count above already holds.
      if (row?.down === false && row.pull !== false && offGrid > 0) await fail(`${offGrid} frame(s) painting off the pane's row, first at ${offGridDiag[0]}`);
      if (wraps < 2) v.skip(`${wraps} wrap(s) in the whole run, so the path under test barely ran`);
      else if (!failed) v.pass(`${app} ${wraps} wraps, ${flips} flip(s)`);
    }, clearPane);
    return `every app held its pane through a continuous run: ${done.join(', ')}`;
  },
};

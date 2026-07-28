import { log } from '../log';
import {
  Inconclusive, VIEWPORT, assert, gridRow, inconclusive, launchApp, probe, quiet,
  teardownApp, type Check, type WrapStyle,
} from '../console-rig';

// ---------------------------------------------------------------------------
// seedwrap
// ---------------------------------------------------------------------------

// The wrap table's own rows, written out here as literals. Reading them off the page
// under test would prove only that the page agrees with itself, so the numbers are
// restated and any drift between the two shows up as a failure. What proves the
// numbers describe the real applications is `bun dev/scripts/measure-tui.ts`, which
// drives each one in a real terminal and measures its composer. This check asks a
// narrower question: does the engine seed what the table says, at the live width.
//
// The shell is the one row with nothing to launch, which is what the null marks.
const SEED_TABLE = [
  { name: 'zsh',    app: null,     pad: 1, indent: 0, pull: false, down: false },
  { name: 'claude', app: 'claude', pad: 2, indent: 2, pull: true,  down: false },
  { name: 'codex',  app: 'codex',  pad: 1, indent: 2, pull: true,  down: true  },
  { name: 'pi',     app: 'pi',     pad: 1, indent: 0, pull: true,  down: true  },
] as const;

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
  //
  // Deleting an app's row from the table must fail this check. That is the guard, and
  // it is what keeps the table load-bearing instead of decorative.
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    const bad: string[] = [];
    const skipped: string[] = [];
    const notes: string[] = [];
    try {
      for (const row of SEED_TABLE) {
        try {
          if (row.app) {
            try {
              await launchApp(page, row.app);
            } catch (e) {
              if (!(e instanceof Inconclusive)) throw e;
              // Which application DID hold the pane is most of the diagnosis.
              const holding = (await probe(page)).app;
              skipped.push(`${row.name}: ${(e as Error).message}, pane is holding ${JSON.stringify(holding)}`);
              continue;
            }
          } else if (!(await page
            .waitForFunction(() => window.__ehPredict.app === 'zsh', null, { timeout: 20000 })
            .catch(() => null))) {
            skipped.push(`${row.name}: the pane never came back to a shell`);
            continue;
          }

          // A composer still drawing itself has a cursor column that means nothing, and
          // every measurement below is taken from that column.
          if (!(await quiet(page, 600, 20000))) {
            skipped.push(`${row.name}: the wire never settled after the app took the pane`);
            continue;
          }

          // 1. The seed, at the live width.
          const start = await probe(page);
          const width = (await gridRow(page, 0))?.length ?? 0;
          if (!width) {
            skipped.push(`${row.name}: could not read the terminal width`);
            continue;
          }
          const seed = start.wrap;
          if (!seed) {
            bad.push(`${row.name}: no wrap style when it took the pane, so nothing was seeded`);
            continue;
          }
          const want = { atLen: width - row.pad, indent: row.indent, pull: row.pull, down: row.down };
          const wrong = (Object.keys(want) as (keyof typeof want)[]).filter((k) => want[k] !== seed[k]);
          if (wrong.length) {
            bad.push(
              `${row.name}: seed wrong on ${wrong.join(', ')} at ${width} cols ` +
              `(want ${JSON.stringify(want)}, got ${JSON.stringify(seed)})`,
            );
          }

          // 2. The first wrap has to paint. Type up to a word boundary a little short of
          //    the wrap column, so a composer that pulls words has a whole word to move,
          //    then send the characters that cross it.
          const runway = seed.atLen - start.col;
          if (runway < 12) {
            skipped.push(`${row.name}: ${runway} columns of runway, which leaves nothing to wrap`);
            continue;
          }
          const lead = 'abcde '.repeat(Math.ceil(runway / 6) + 1).slice(0, runway - 8);
          await page.keyboard.type(lead.slice(0, lead.lastIndexOf(' ') + 1), { delay: 4 });
          if (!(await quiet(page, 600, 12000))) {
            skipped.push(`${row.name}: the wire never settled after the lead`);
            continue;
          }

          const pre = (await probe(page)).col;
          // One character past the wrap column: the model wraps on the keystroke it takes
          // while the line already measures atLen, so it needs (atLen - col) + 1 of them.
          const rest = seed.atLen - pre + 1;
          if (rest < 1 || rest > CROSSING.length) {
            skipped.push(`${row.name}: the lead landed at column ${pre}, ${rest} short of atLen ${seed.atLen}`);
            continue;
          }
          await page.keyboard.type(CROSSING.slice(0, rest), { delay: 25 });

          // Read while the burst is still live. Settling first hands back a reconciled
          // row, and a reconciled row is the one state that cannot tell a painted wrap
          // from a wrap that rode the echo home.
          const post = (await probe(page)).burst;
          if (!post) {
            bad.push(`${row.name}: no burst after crossing the wrap column (${pre} to atLen ${seed.atLen})`);
          } else if (!post.wrapped || post.draining) {
            bad.push(
              `${row.name}: the wrap rode the echo instead of painting ` +
              `(wrapped=${post.wrapped} draining=${post.draining} line=${JSON.stringify(post.line)})`,
            );
          } else if (seed.pull && post.line.search(/\S/) !== seed.indent) {
            bad.push(
              `${row.name}: the continuation starts at column ${post.line.search(/\S/)}, ` +
              `expected indent ${seed.indent}`,
            );
          } else {
            notes.push(`${row.name} at ${seed.atLen}`);
          }
        } finally {
          // The next app has to find the pane the way this one found it, including on
          // the paths that gave up early. A composer left running is a terminal the next
          // app does not expect, and it measures whatever it finds.
          if (row.app) await teardownApp(page).catch(() => undefined);
          else await page.keyboard.press('Control+u');
          await Bun.sleep(800);
        }
      }
    } finally {
      await page.close();
    }

    assert(bad.length === 0, bad.join('; '));
    if (skipped.length) inconclusive(skipped.join('; '));
    return `${notes.length} apps seeded from the table and painted a first wrap: ${notes.join(', ')}`;
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

const KEEP_TABLE = [
  { app: 'claude', flips: 0 },
  { app: 'codex',  flips: 1 },
  { app: 'pi',     flips: 1 },
] as const;

/** One frame of the watcher's view: what the model believes, and what the pane holds. */
interface Sample {
  w: WrapStyle | null;
  has: boolean;
  off: boolean;
  len: number;
  row: number;
  col: number;
  brow: number | null;
  line: string | null;
  grid: string;
  above: string;
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
  // check for all three apps. Claude Code takes the ALTERNATE screen, which has no
  // scrollback to scroll into, so its growth direction is a structural constant: any
  // flip is wrong by construction, and it is held to zero flips and zero off-grid
  // frames. Codex and pi float in a scrolling stream and legitimately change direction
  // once, when their pane runs out of blank rows below them. They get a single flip
  // each, and their off-grid frames are not read at all, because around a legitimate
  // flip an overlay one row off the cursor is the pane moving underneath a correct
  // prediction and this check has no way to tell that from the fault.
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    const bad: string[] = [];
    const skipped: string[] = [];
    const notes: string[] = [];
    try {
      for (const app of KEEP_TABLE) {
        try {
          // Each app gets a clean pane. Left on the previous app's output, a composer
          // that floats in a scrolling stream starts pinned to the bottom with no blank
          // rows below it, so its growth arrives as a scroll and the seeded direction is
          // legitimately wrong. That is a different phenomenon from the one under test,
          // and it would land here as a failure.
          await page.keyboard.type('clear', { delay: 5 });
          await page.keyboard.press('Enter');
          await Bun.sleep(900);

          try {
            await launchApp(page, app.app);
          } catch (e) {
            if (!(e instanceof Inconclusive)) throw e;
            const holding = (await probe(page)).app;
            skipped.push(`${app.app}: ${(e as Error).message}, pane is holding ${JSON.stringify(holding)}`);
            continue;
          }
          if (!(await quiet(page, 1500, 30000))) {
            skipped.push(`${app.app}: the wire never settled after boot, so the seed cannot be trusted`);
            continue;
          }
          const seed = (await probe(page)).wrap;
          if (!seed) {
            skipped.push(`${app.app}: no seeded wrap style, so there is nothing to keep`);
            continue;
          }

          let rebinds = 0, flips = 0, unlearns = 0, wraps = 0, offGrid = 0;
          let hadBurst = false, hadStyle = true, lastDown = seed.down, prevLen = 0;
          // Both diagnoses are rendered at the instant they happen. The sample that
          // explains a rebind is gone one frame later.
          const rebindDiag: string[] = [];
          const offGridDiag: string[] = [];
          let typing = true;

          const watch = (async () => {
            let last: Sample | null = null;
            while (typing) {
              const s: Sample = await page.evaluate(() => {
                const p = window.__ehPredict, b = p.burst;
                return {
                  w: p.wrap, has: !!b, off: !!(b && b.offGrid), len: b ? b.line.length : 0,
                  row: p.row, col: p.col, brow: b && b.row, line: b && b.line,
                  grid: (p.text(p.row) || '').replace(/ +$/, ''),
                  above: (p.text(p.row - 1) || '').replace(/ +$/, ''),
                };
              });
              if (hadBurst && !s.has) {
                rebinds++;
                // The sample one tick BEFORE the death is the one that explains it.
                if (rebinds === 1 && last) {
                  rebindDiag.push(
                    `    ${app.app}: last live sample before the first rebind`,
                    `    wrap=${JSON.stringify(last.w)} cursor=${last.row}/${last.col} burstRow=${last.brow} off=${last.off}`,
                    `    above |${last.above.slice(0, 132)}`,
                    `    grid  |${last.grid.slice(0, 132)}`,
                    `    model |${(last.line ?? '').slice(0, 132)}`,
                  );
                }
              }
              // A wrap is the model's line getting suddenly shorter: the continuation
              // starts over near the indent while the row it left behind stays put.
              if (s.has && prevLen - s.len > 20) wraps++;
              if (s.w && hadStyle && s.w.down !== lastDown) flips++;
              if (!s.w && hadStyle) unlearns++;
              if (s.off) {
                offGrid++;
                if (!offGridDiag.length) {
                  offGridDiag.push(`overlay on row ${s.brow}, pane cursor on row ${s.row}`);
                }
              }
              if (s.has) last = s;
              hadBurst = s.has;
              prevLen = s.has ? s.len : 0;
              hadStyle = !!s.w;
              if (s.w) lastDown = s.w.down;
              await Bun.sleep(20);
            }
          })();

          await page.keyboard.type(KEEP_SENTENCE, { delay: KEEP_DELAY });
          typing = false;
          await watch;

          // Everything this check asserts was counted while the keys were flowing, so a
          // wire that will not fall silent afterwards invalidates nothing. It costs only
          // the closing style read, and that read is a diagnosis rather than a verdict,
          // so the timeout is reported in place instead of skipping the app.
          const settled = await quiet(page, 400, 6000);
          const final = settled
            ? JSON.stringify((await probe(page)).wrap)
            : 'unread, the wire never fell silent after the run';

          const before = bad.length;
          if (rebinds > 0) {
            bad.push(`${app.app}: ${rebinds} rebind(s) mid-run, the model lost the pane and re-read a stale grid`);
          }
          if (flips > app.flips) {
            bad.push(`${app.app}: ${flips} direction flip(s), at most ${app.flips} is legitimate here`);
          }
          if (unlearns > 0) {
            bad.push(`${app.app}: ${unlearns} unlearn(s) of a measured wrap style (seed ${JSON.stringify(seed)}, final ${final})`);
          }
          // Only for the app that cannot move: see the note above on why the other two
          // are read for flips alone.
          if (app.flips === 0 && offGrid > 0) {
            bad.push(`${app.app}: ${offGrid} frame(s) painting off the pane's row, first at ${offGridDiag[0]}`);
          }
          if (wraps < 2) {
            skipped.push(`${app.app}: ${wraps} wrap(s) in the whole run, so the path under test barely ran`);
          }
          for (const line of rebindDiag) log.dim(line);
          if (bad.length === before && wraps >= 2) notes.push(`${app.app} ${wraps} wraps, ${flips} flip(s)`);
        } finally {
          await teardownApp(page).catch(() => undefined);
          await Bun.sleep(900);
        }
      }
    } finally {
      await page.close();
    }

    assert(bad.length === 0, bad.join('; '));
    if (skipped.length) inconclusive(skipped.join('; '));
    return `every app held its pane through a continuous run: ${notes.join(', ')}`;
  },
};

// Two checks that read PIXELS instead of state, ported from the ad-hoc harness that
// found the defects they guard.
//
// Both watch the same surface: the engine's cursor block and the columns right of it,
// on a composer that draws its own ghost text. The prediction paints into cells the
// app's hint already occupies, so a guess that is perfectly correct in the DOM can
// still leave half an eaten hint on screen. The assertion that came before these read
// predCursor.textContent, reported clean three runs running, and was blind to the
// reported symptom. An assertion that cannot observe the symptom is not a guard.
//
// Measured before the fix, with the hint `Try "how do I log an error?"` on the row:
//   typed 'h'  ->  `❯ h█y "how do I log an error?"`
//   typed 'ho' ->  `❯ ho█ "how do I log an error?"`
// Nothing in the DOM said that was wrong.
// Type-only, so it is erased at transpile and this file never pulls Playwright into a
// runtime import. console-rig stays the one module that does.
import type { Page } from '@playwright/test';
import { log } from '../log';
import {
  PIXEL_VIEWPORT, VIEWPORT, assert, inconclusive, launchApp, quiet, teardownApp,
  type Check,
} from '../console-rig';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** One painted frame in which the engine's cursor block held a glyph. */
interface BlockFrame {
  glyph: string;
  /** The burst behind that frame, or null when none was live. */
  matched: boolean | null;
  dirty: boolean | null;
  len: number | null;
  tail: string | null;
}

interface BlockRecording {
  /** Frames where the block carried a glyph. Both checks want this empty. */
  frames: BlockFrame[];
  /** Frames where the block was drawn at all. Zero means the recorder watched nothing. */
  drawn: number;
}

/**
 * Record every painted frame in which the engine's cursor block holds a glyph.
 *
 * While a burst that changed content is open, the cells right of the cursor are
 * unknowable until the echo lands, so terminal.html blanks the block on purpose. A
 * glyph there is the whole defect, visible as one letter of the app's hint sitting
 * inside the caret.
 *
 * A poll cannot do this job. The block is repainted on the frame, a stale glyph can
 * live for one or two of them, and a sample that lands between repaints says nothing
 * about either. So the recorder rides requestAnimationFrame and reads the block on the
 * same clock the engine draws it on.
 *
 * The overlay is looked up per frame rather than captured once. terminal.html rebuilds
 * that layer whenever it is detached, and a recorder holding the old element would
 * report a clean run while watching a node nobody paints into.
 *
 * Returns false when the terminal screen is not on the page. Silence from a recorder
 * that was never installed reads exactly like silence from a correct engine.
 */
function startBlockFrames(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __ehFrames?: BlockFrame[]; __ehFramesDrawn?: number; __ehFramesOn?: boolean;
    };
    const screen = document.querySelector('.xterm-screen');
    if (!screen) return false;
    w.__ehFrames = [];
    w.__ehFramesDrawn = 0;
    w.__ehFramesOn = true;

    // The optimistic layers carry inline z-indexes and no class, so that is what they
    // are found by: one z-index:10 layer under the screen, the cursor block at 3 inside it.
    const byZ = (parent: Element, z: string) =>
      Array.from(parent.children).find(
        (el) => (el as HTMLElement).style && (el as HTMLElement).style.zIndex === z,
      ) as HTMLElement | undefined;

    const tick = () => {
      if (!w.__ehFramesOn) return;
      requestAnimationFrame(tick);
      const layer = byZ(screen, '10');
      const block = layer && byZ(layer, '3');
      if (!block || block.style.display === 'none') return;
      w.__ehFramesDrawn!++;
      const glyph = block.textContent || '';
      if (!glyph.trim()) return;
      const b = window.__ehPredict.burst;
      w.__ehFrames!.push({
        glyph,
        matched: b ? b.matched : null,
        dirty: b ? b.dirty : null,
        len: b ? b.line.length : null,
        tail: b ? (b.tail || '').slice(0, 12) : null,
      });
    };
    requestAnimationFrame(tick);
    return true;
  });
}

/**
 * Stop the recorder, take what it saw, and take the globals off the page with it.
 *
 * Deleting the flag is what stops the loop: the next frame reads undefined and returns.
 * Safe to call twice, which is how the teardown path can run it without knowing whether
 * the check already did.
 */
function stopBlockFrames(page: Page): Promise<BlockRecording> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __ehFrames?: BlockFrame[]; __ehFramesDrawn?: number; __ehFramesOn?: boolean;
    };
    const recording = { frames: w.__ehFrames ?? [], drawn: w.__ehFramesDrawn ?? 0 };
    delete w.__ehFramesOn;
    delete w.__ehFrames;
    delete w.__ehFramesDrawn;
    return recording;
  });
}

/**
 * The burst as the model holds it this instant, or null when none is live.
 *
 * Read in one evaluate with the pane's cursor, because `ahead` below compares the two
 * and sampling them separately would compare two different instants.
 */
function burstState(page: Page) {
  return page.evaluate(() => {
    const p = window.__ehPredict;
    const b = p.burst;
    return b && {
      line: b.line, tail: b.tail || '', matched: b.matched, dirty: b.dirty,
      modelCol: b.line.length, paneCol: p.col, paneRow: p.row, burstRow: b.row,
    };
  });
}

/**
 * Is the model still ahead of the pane on the burst's own row?
 *
 * That is the state these checks need: predicted cells on screen that the echo has not
 * reached. They used to ask `matched === false` instead, which was a proxy for the same
 * thing back when the only way a burst got marked agreed-with was the echo catching all
 * the way up. Reconcile then learned to recognise the pane merely WALKING the predicted
 * line, so `matched` goes true while the model is still ahead, and the proxy stopped
 * tracking its subject. A proxy that no longer tracks its subject reports inconclusive
 * forever, which is a guard that has quietly stopped guarding.
 */
const ahead = (b: Awaited<ReturnType<typeof burstState>>) =>
  !!b && b.burstRow === b.paneRow && b.modelCol !== b.paneCol;

/**
 * Put Claude Code in the pane and wait until its composer is really drawn.
 *
 * `launchApp` returns once the pane reports `claude`, which happens well before the
 * input box exists. Both checks read the composer row itself, so they wait for the
 * stronger signal: the app's own prompt glyph (U+276F) opening the cursor's row with
 * the caret parked two columns in.
 */
async function launchComposer(page: Page) {
  await launchApp(page, 'claude');
  try {
    await page.waitForFunction(
      () => {
        const p = window.__ehPredict;
        const t = p.text(p.row);
        return !!t && t.charCodeAt(0) === 0x276f && p.col === 2;
      },
      null,
      { timeout: 30000 },
    );
  } catch {
    inconclusive('Claude Code never drew its composer prompt');
  }
  // Measured against the app rather than the wire: the hint lands a beat after the prompt.
  await Bun.sleep(1500);
  // Then the wire itself. Both checks sample a single instant and trust that what they
  // saw was still true a moment later, which a composer still repainting would break.
  if (!(await quiet(page, 600, 10000))) {
    inconclusive('the composer never stopped repainting, so no instant could be trusted');
  }
}

// ---------------------------------------------------------------------------
// ghostcover
// ---------------------------------------------------------------------------

/**
 * The composer row as pixels: where the app's ghost run ends, plus the geometry needed
 * to clip a screenshot to that one row.
 *
 * Ghost text is any span styled unlike plain input, which is what render() keys on. The
 * two matter equally: the opening `Try "…"` placeholder is `xterm-dim`, while the hint
 * redrawn after a clear is a plain palette grey (`xterm-fg-246`). The first fix keyed on
 * dim alone and shipped the bug in the other, so the match covers both.
 */
function composerGhost(page: Page) {
  return page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows');
    const screen = document.querySelector('.xterm-screen');
    if (!rows || !screen || !rows.children.length) return null;
    const p = window.__ehPredict;
    const vrow = p.row - p.baseY;
    const el = rows.children[vrow];
    if (!el) return null;
    const text = p.text(p.row) || '';
    const cols = text.length;
    if (!cols) return null;

    const box = screen.getBoundingClientRect();
    let col = 0;
    let to = -1; // one past the last ghost column, -1 when the row carries none
    const styles: string[] = [];
    for (const span of Array.from(el.children)) {
      const t = span.textContent || '';
      const styled = /xterm-dim|xterm-fg-/.test(span.className || '');
      // Only a run reaching past the cursor can be painted over, so runs left of it are
      // not the subject. A later run wins: it is the one the prediction is walking into.
      if (styled && col + t.length > p.col) { to = col + t.length; styles.push(span.className); }
      col += t.length;
    }
    return {
      to, cols, vrow, col: p.col,
      sx: box.left, sy: box.top,
      cw: box.width / cols,
      ch: rows.children[0].getBoundingClientRect().height,
      styles: styles.join(' | '),
      text: text.replace(/ +$/, ''),
    };
  });
}

export const ghostcover: Check = {
  name: 'ghostcover',
  what: 'typing over a composer hint leaves nothing but background right of the cursor',
  // Screenshot the composer row mid-flight, then assert every column right of the cursor
  // block matches the background. That is the only reading that can see the reported
  // symptom: the prediction covers the FIRST columns of the hint while the rest keeps
  // sitting beside the caret, eaten one character per keystroke until the echo erases it.
  //
  // Two phases, because Claude Code rotates its hint styling and a dim-keyed cover silently
  // missed the palette-grey one. The unconfirmed window is widened honestly, without
  // touching latency: a fast multi-character burst cannot match until the WHOLE burst has
  // echoed, since reconcile needs curCol === line.length, so `matched` stays false for a
  // full round trip. A phase proves nothing unless the burst was genuinely unconfirmed on
  // both sides of the screenshot, which is checked either side and skipped when it was not.
  //
  // Fresh pane because phase one is the first placeholder the app ever draws, and an
  // inherited pane may already hold an application or half a typed line.
  needsFreshPane: true,
  async run(rig): Promise<string> {
    const page = await rig.page(PIXEL_VIEWPORT);
    try {
      await launchComposer(page);
      // Armed for the whole session, phases included: the block must never carry a glyph
      // while a burst that changed content is open, whatever else is happening.
      if (!(await startBlockFrames(page))) {
        inconclusive('the terminal screen was not on the page, so no frame could be read');
      }

      const skips: string[] = [];
      const leaked: string[] = [];
      let phases = 0;
      let columns = 0;

      type Attempt = 'ok' | 'racy' | 'structural';
      const attemptPhase = async (label: string): Promise<Attempt> => {
        const g = await composerGhost(page);
        if (!g || g.to < 0) { skips.push(`${label}: no ghost text on the composer row`); return 'structural'; }

        // Enough characters to be a real multi-key burst, never so many that they cover
        // the run under inspection. Measured bounds.
        const n = Math.max(6, Math.min(12, Math.floor((g.to - g.col) / 2)));
        if (g.col + n >= g.to - 1) {
          skips.push(`${label}: the burst covers the whole ghost run, so nothing could leak`);
          return 'structural';
        }
        await page.keyboard.type('hoy vamos a ver'.slice(0, n), { delay: 8 });

        const before = await burstState(page);
        if (!ahead(before)) {
          skips.push(`${label}: nothing predicted was still ahead of the echo, so the window never opened`);
          return 'racy';
        }

        const clip = {
          x: Math.round(g.sx),
          y: Math.round(g.sy + g.vrow * g.ch),
          width: Math.round(g.cw * g.cols),
          height: Math.round(g.ch),
        };
        const shot = await page.screenshot({ clip });
        const after = await burstState(page);
        // The screenshot takes real time. An echo that landed inside it makes the pixels
        // a picture of the settled row, which proves nothing about the prediction.
        if (!after || !ahead(after)) {
          skips.push(`${label}: the echo landed during the screenshot, so the sample sits outside the window`);
          return 'racy';
        }

        const scan = await page.evaluate(
          async ({ b64, to, len, cols }: { b64: string; to: number; len: number; cols: number }) => {
            const img = new Image();
            img.src = 'data:image/png;base64,' + b64;
            await img.decode();
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0, 0, img.width, img.height).data;
            const scale = img.width / cols; // device pixels per terminal column
            const at = (x: number, y: number) => {
              const i = (y * img.width + x) * 4;
              return [d[i], d[i + 1], d[i + 2]];
            };
            // Background is read off the row itself, a few columns past the ghost run, so a
            // theme change moves the reference instead of breaking the check.
            const ref = at(Math.round((Math.min(cols - 2, to + 3) + 0.5) * scale), Math.round(img.height / 2));

            const bad: { col: number; worst: number; px: number[] }[] = [];
            for (let col = len + 1; col < to; col++) {
              let worst = 0;
              let worstPx = ref;
              // Measured, not guessed: two device pixels in from every edge of the cell
              // skips the antialiased rim and the cell's own border, and a channel delta
              // above 18 is a glyph rather than the background's own noise.
              for (let sx = 2; sx < scale - 2; sx++) {
                for (let sy = 2; sy < img.height - 2; sy++) {
                  const p = at(Math.round(col * scale) + sx, sy);
                  const diff = Math.max(
                    Math.abs(p[0] - ref[0]), Math.abs(p[1] - ref[1]), Math.abs(p[2] - ref[2]),
                  );
                  if (diff > worst) { worst = diff; worstPx = p; }
                }
              }
              if (worst > 18) bad.push({ col, worst, px: worstPx });
            }
            return { ref, bad, checked: Math.max(0, to - (len + 1)) };
          },
          { b64: shot.toString('base64'), to: g.to, len: after.line.length, cols: g.cols },
        );

        if (!scan.checked) { skips.push(`${label}: no columns left of the ghost run to check`); return 'structural'; }
        phases++;
        columns += scan.checked;
        if (!scan.bad.length) return 'ok';

        for (const b of scan.bad.slice(0, 6)) {
          log.dim(`    ${label}: column ${b.col} is rgb(${b.px.join(',')}), background rgb(${scan.ref.join(',')}), delta ${b.worst}`);
        }
        log.dim(`    row |${g.text.slice(0, 60)}`);
        leaked.push(`${label} left ${scan.bad.length} of ${scan.checked} column(s) painted`);
        return 'ok';
      };

      // The screenshot has to land inside the un-echoed window, and sometimes it misses.
      // That is a race in the instrument, not a fact about the engine, and letting it
      // end the check means the guard reports nothing on a run where the engine was
      // never even asked. So a missed window is retried: clear the draft, let the app
      // redraw its hint, and open the window again.
      //
      // Only a timing miss retries. A row with no ghost text on it will not grow one by
      // being asked three times, so a structural skip is reported at once.
      //
      // The attempt says which kind it was. Deciding that by matching the skip's PROSE,
      // which is what this did first, means rewording a message silently switches the
      // retry off, and nothing goes red when it happens.
      const phase = async (label: string) => {
        for (let attempt = 1; ; attempt++) {
          const outcome = await attemptPhase(label);
          if (outcome !== 'racy' || attempt >= 3) return;
          skips.pop();
          await page.keyboard.press('Control+u');
          await Bun.sleep(1300);
        }
      };

      await phase('initial placeholder');

      // Clear the input so the app redraws its hint. It rotates between the dim `Try "…"`
      // and a palette-grey suggestion, and only the second exercises the branch the
      // dim-only fix missed, so re-roll for it rather than leave that coverage to chance.
      // If it never turns up the phase still runs, and the styling it actually saw is
      // reported, so the result never overclaims.
      let styling = '';
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Control+u');
        await Bun.sleep(1300);
        styling = (await composerGhost(page))?.styles ?? '';
        if (/xterm-fg-/.test(styling)) break;
      }
      log.dim(`    redrawn hint styled ${JSON.stringify(styling || '(none)')}`);
      await phase('redrawn hint after clear');

      // Past the wrap column, unbroken. wrapStep replaces `tail` wholesale at the seam, and
      // an unbroken token is both what a user types and the composer's hardest wrap branch.
      // No screenshot here: the frame recorder is the assertion.
      const cols = await page.evaluate(() => (window.__ehPredict.text(window.__ehPredict.row) || '').length);
      assert(cols > 0, 'could not read the terminal width');
      const run = 'sdhgaskugaskdgasjhdafgsjdhasfduasyfqwertyuiopasdfghjklzxcvbnm'.repeat(3).slice(0, cols + 12);
      await page.keyboard.type(run, { delay: 20 });
      await Bun.sleep(2200);

      const recording = await stopBlockFrames(page);
      // Only frames with a dirty burst behind them. With nothing in flight the block is
      // meant to hold the glyph under it, and counting those would fail every clean run.
      const carried = recording.frames.filter((f) => f.dirty === true);
      for (const f of carried.slice(0, 4)) {
        log.dim(`    block held ${JSON.stringify(f.glyph)} at column ${f.len}, matched=${f.matched}, tail ${JSON.stringify(f.tail)}`);
      }

      const problems = [...leaked];
      if (carried.length) {
        problems.push(`the block carried a glyph on ${carried.length} frame(s) while a content burst was open`);
      }
      // A failure outranks a skip. A phase that could not run does not soften one that ran
      // and found the hint still on screen.
      assert(problems.length === 0, problems.join('; '));

      if (!recording.drawn) inconclusive('the cursor block was never drawn while the recorder watched');
      if (skips.length) {
        inconclusive(skips.length > 1 ? `${skips[0]} (and ${skips.length - 1} more)` : skips[0]);
      }
      return `${phases} phase(s), ${columns} column(s) right of the block all background, block empty across ${recording.drawn} drawn frame(s)`;
    } finally {
      await stopBlockFrames(page).catch(() => undefined);
      await teardownApp(page).catch(() => undefined);
      await page.close();
    }
  },
};

// ---------------------------------------------------------------------------
// staletail
// ---------------------------------------------------------------------------

const STALETAIL_RUN = 'sdhgaskugaskdgasjhdafgsjdhasfduasyf';

/**
 * The composer row, read through the probe alone.
 *
 * Ghost text is everything past the cursor while the input is empty, which needs no
 * styling to detect. Keying on `.xterm-dim` skipped every hint Claude renders without
 * SGR 2, and that is exactly the case a dim-keyed cover would also miss.
 */
function composerRow(page: Page) {
  return page.evaluate(() => {
    const p = window.__ehPredict;
    const row = (p.text(p.row) || '').replace(/ +$/, '');
    return { row, col: p.col, ghost: row.length > p.col ? row.slice(p.col) : '' };
  });
}

/**
 * The pause before typing resumes is the whole variable, so it is the only thing that
 * differs between the three erase flows. It has to be long enough for the app's repaint
 * to arrive and short enough that the burst is not dropped on the deadline. The original
 * runs recorded a reproduction at 260ms and at 450ms, and a clean 120ms; all three are
 * kept, since the pair that reproduces is what makes the clean one mean anything.
 */
const STALETAIL_FLOWS: { name: string; prep(page: Page): Promise<void> }[] = [
  // The control comes first and never erases. It is what proves the rig can still see a
  // clean run, so a green result from the others is a result rather than a blind spot.
  { name: 'forward only (control)', prep: async () => {} },
  ...[120, 260, 450].map((pauseMs) => ({
    name: `erase, resume @${pauseMs}ms`,
    prep: async (page: Page) => {
      await page.keyboard.type('abcd', { delay: 25 });
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Backspace');
        await Bun.sleep(25);
      }
      await Bun.sleep(pauseMs);
    },
  })),
];

export const staletail: Check = {
  name: 'staletail',
  what: 'a hint frozen in the model tail is never painted into the cursor block',
  // reconcile refreshes `tail` only at a match, and a match needs curCol === line.length
  // with the row prefix agreeing. Typing forward reaches that only after the echo, by
  // which time the app has deleted its placeholder, which is why every forward-typing
  // probe came back clean. Erase back to an EMPTY input and the app redraws the
  // placeholder; the burst then matches at the prompt column and refreshes `tail` FROM
  // the placeholder, with matched=true. The burst survives because the user is still
  // typing, so every later keystroke grows `line` while `tail` stays `Try "…"`, and the
  // block paints its first letter.
  //
  // Four flows, and the erase ones are the only way into that state. A run where the
  // state never armed is measuring nothing, so it reports skipped rather than passing.
  //
  // Fresh pane for the same reason as ghostcover: the flows need Claude Code launched
  // from a shell, drawing the hint it draws on a cold composer.
  needsFreshPane: true,
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    try {
      await launchComposer(page);

      const reproduced: string[] = [];
      const skipped: string[] = [];
      let armed = false;
      let drawn = 0;
      let first: BlockFrame | null = null;

      for (const flow of STALETAIL_FLOWS) {
        // Empty the composer and give the app its measured beat to put the hint back.
        await page.keyboard.press('Control+u');
        await Bun.sleep(1200);
        const start = await composerRow(page);
        if (!start.ghost) {
          skipped.push(`${flow.name}: the composer showed no ghost text (${JSON.stringify(start.row.slice(0, 34))})`);
          continue;
        }

        await flow.prep(page);
        const burst = await burstState(page);
        // The state under test: a live content burst whose `tail` holds the app's hint
        // while `matched` claims it is fresh. Without it a clean result measures nothing.
        if (burst && burst.matched && burst.dirty && burst.tail.trim()) armed = true;

        if (!(await startBlockFrames(page))) {
          inconclusive('the terminal screen was not on the page, so no frame could be read');
        }
        await page.keyboard.type(STALETAIL_RUN, { delay: 18 });
        await Bun.sleep(2000);
        const recording = await stopBlockFrames(page);
        drawn += recording.drawn;

        // Every glyph frame counts here, whatever the burst says. The frozen tail is
        // painted precisely because the engine believes it is holding fresh content, so a
        // filter on the burst's own opinion would filter out the bug.
        if (!recording.frames.length) continue;
        reproduced.push(`${flow.name} on ${recording.frames.length} frame(s)`);
        first = first ?? recording.frames[0];
        for (const f of recording.frames.slice(0, 3)) {
          log.dim(`    ${flow.name}: block held ${JSON.stringify(f.glyph)}, matched=${f.matched}, dirty=${f.dirty}, tail ${JSON.stringify(f.tail)}`);
        }
      }

      assert(
        reproduced.length === 0,
        `the block painted the app's hint during ${reproduced.join(', ')}` +
          (first ? `; first frame held ${JSON.stringify(first.glyph)} against tail ${JSON.stringify(first.tail)}` : ''),
      );
      if (!drawn) inconclusive('the cursor block was never drawn while the recorder watched');
      if (!armed) {
        inconclusive(
          `no flow ever froze \`tail\` on the hint, so the guarded state never occurred` +
            (skipped.length ? ` (${skipped[0]})` : ''),
        );
      }
      const ran = STALETAIL_FLOWS.length - skipped.length;
      return `stale tail armed and the block stayed empty across ${ran} of ${STALETAIL_FLOWS.length} flows, ${drawn} drawn frame(s)`;
    } finally {
      await stopBlockFrames(page).catch(() => undefined);
      await teardownApp(page).catch(() => undefined);
      await page.close();
    }
  },
};

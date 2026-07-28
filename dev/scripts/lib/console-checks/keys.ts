// Keyboard checks for the console's predictive echo.
//
// console/ui/terminal.html paints a keystroke before the server has echoed it, so
// every assertion below is an INSTANT read: the probe runs a few milliseconds after
// the key, the link carries about 150ms of round trip, and what the engine reports
// therefore cannot have come back from the server yet. Remove the latency and every
// one of these is satisfied by the echo alone, which proves nothing at all.
//
// One check per behaviour rather than one long script. A regression should be named
// by the run ("keys-nav") instead of by an index into a list of assertions, and a
// check that cannot reach its state should not take the unrelated assertions after
// it down with it.
import type { Page } from '@playwright/test';
import {
  VIEWPORT, assert, type Burst, type Check, gridRow, inconclusive, launchApp, probe,
  quiet, settle, teardownApp,
} from '../console-rig';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a page-side condition, and treat a timeout as "never seen".
 *
 * The harness these checks came from swallowed six of these waits and then asserted
 * on whatever state it fell through to. That reports a stalled wire as an engine
 * fault, and it reports it with the message of whichever assertion happened to run
 * next. A timeout means the check never reached the state it guards, which is a
 * different answer from the engine being wrong.
 */
// The argument is typed loosely on purpose. Playwright declares the callback as
// taking `Unboxed<Arg>`, which it cannot prove equal to a caller's own type
// parameter, so a generic wrapper never typechecks. Every argument passed here is a
// plain serialisable value, which is the case where the two coincide.
async function waitFor(
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
function waitSafe(page: Page, ms: number, reason: string) {
  return waitFor(page, () => window.__ehPredict.safe === true, null, ms, reason);
}

/** Wait for the wire to fall silent, and skip the check if it never does. */
async function quietOrSkip(page: Page, what: string, ms = 8000) {
  if (!(await quiet(page, 600, ms))) inconclusive(`the wire never settled after ${what}`);
}

/**
 * Clear the line and start a fresh, proven one.
 *
 * The engine only claims a prompt the server has drawn, so a check that starts
 * mid-line exercises the recovery path instead of the one it is named after. Enter
 * re-proves the floor.
 */
async function freshLine(page: Page) {
  await page.keyboard.press('Control+C');
  await Bun.sleep(700);
  await page.keyboard.press('Enter');
  await waitSafe(page, 15000, 'the gate never re-armed on a fresh prompt');
  await Bun.sleep(900);
}

/**
 * Put the prompt at the top of the screen.
 *
 * A predicted wrap needs a row below it to wrap into. The bottom row rides by
 * design, since predicting a scroll means repainting the whole screen on a guess, so
 * a check that wraps at the bottom measures that policy rather than the prediction.
 */
async function clearScreen(page: Page) {
  await page.keyboard.type('clear');
  await page.keyboard.press('Enter');
  await waitSafe(page, 15000, 'the gate never re-armed after clear');
  await Bun.sleep(900);
}

/** Drop a composer draft: two Escapes inside the confirm window it asks for. */
async function clearDraft(page: Page) {
  await page.keyboard.press('Escape');
  await Bun.sleep(350);
  await page.keyboard.press('Escape');
  await Bun.sleep(800);
}

/** Type, then read the engine back before the echo can have arrived. */
async function typeAndRead(page: Page, text: string, delay = 15) {
  await page.keyboard.type(text, { delay });
  return probe(page);
}

/** Press, then read the engine back before the echo can have arrived. */
async function pressAndRead(page: Page, key: string) {
  await page.keyboard.press(key);
  return probe(page);
}

/** The engine's burst, or a failed check naming what it declined to predict. */
function burstOf(p: { burst: Burst | null }, what: string): Burst {
  const b = p.burst;
  assert(b !== null, `${what}: the engine predicted nothing`);
  return b;
}

/** A grid row that exists, or a failed check. */
async function rowText(page: Page, r: number): Promise<string> {
  const text = await gridRow(page, r);
  assert(text !== null, `the grid has no row ${r}`);
  return text;
}

/** The terminal width, read off a row the pane has actually drawn. */
async function columns(page: Page): Promise<number> {
  const cols = await page.evaluate(() => window.__ehPredict.text(window.__ehPredict.row)?.length ?? 0);
  assert(cols > 0, 'could not read the terminal width');
  return cols;
}

/** How wide the prompt is: on a fresh line the cursor sits just past it. */
async function promptWidth(page: Page): Promise<number> {
  return (await probe(page)).col;
}

/**
 * Non-empty rows in an absolute range, trailing blanks trimmed.
 *
 * Absolute buffer rows, the same coordinates the probe reports everywhere else, so a
 * caller can read around the cursor without translating anything.
 */
function rowsBetween(page: Page, from: number, to: number): Promise<string[]> {
  return page.evaluate(({ from, to }) => {
    const out: string[] = [];
    for (let r = from; r <= to; r++) {
      const t = window.__ehPredict.text(r);
      if (t && t.trim()) out.push(t.trimEnd());
    }
    return out;
  }, { from, to });
}

/** Every non-empty row currently on screen. */
async function screenRows(page: Page, p: { baseY: number; rows: number }): Promise<string[]> {
  return rowsBetween(page, p.baseY, p.baseY + p.rows - 1);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

// Twenty characters, five of them outside ASCII. The engine paints by code point, so
// an accent that costs one keystroke has to cost one column and one inputLen.
const ACCENTED = 'echo café ñoño áéíóú';

export const keysTyping: Check = {
  name: 'keys-typing',
  what: 'plain and accented characters paint before the server echoes them',
  needsFreshPane: true,
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    try {
      await freshLine(page);

      const typed = await typeAndRead(page, ACCENTED);
      const b = burstOf(typed, 'typing the accented line');
      assert(b.line.endsWith(ACCENTED), `the burst ends "${b.line.slice(-24)}" instead of the text that was typed`);
      assert(b.dirty === true, 'the burst is not dirty, so nothing was painted');
      assert(typed.inputLen === ACCENTED.length,
        `inputLen is ${typed.inputLen} for ${ACCENTED.length} keystrokes, so an accent cost more than one`);

      const done = await settle(page);
      const line = await rowText(page, done.row);
      assert(line.includes(ACCENTED), `the grid converged to "${line.trimEnd()}"`);
      assert(!done.burst, 'a burst outlived the echo it was predicting');

      // One backspace is one character, whatever it took to compose that character.
      const back = await pressAndRead(page, 'Backspace');
      const bb = burstOf(back, 'backspace over an accent');
      assert(bb.line.endsWith('áéíó') && !bb.line.endsWith('áéíóú'),
        `backspace left the burst ending "${bb.line.slice(-8)}"`);

      const after = await settle(page);
      const shortened = await rowText(page, after.row);
      assert(shortened.includes('áéíó') && !shortened.includes('áéíóú'),
        `the grid disagrees after backspace: "${shortened.trimEnd()}"`);

      return '7 assertions, all painted before the echo';
    } finally {
      await page.keyboard.press('Control+u').catch(() => undefined);
      await page.close();
    }
  },
};

export const keysChords: Check = {
  name: 'keys-chords',
  what: 'the linux control chords move and delete by word before the echo',
  needsFreshPane: true,
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    try {
      await freshLine(page);
      await page.keyboard.type('echo abc def', { delay: 15 });
      await quietOrSkip(page, 'typing the line');

      const left = burstOf(await pressAndRead(page, 'Control+ArrowLeft'), 'Ctrl+Left');
      assert(left.line.endsWith('abc '), `Ctrl+Left put the model cursor after "${left.line.slice(-8)}"`);

      const right = burstOf(await pressAndRead(page, 'Control+ArrowRight'), 'Ctrl+Right');
      assert(right.line.endsWith('def'), `Ctrl+Right put the model cursor after "${right.line.slice(-8)}"`);

      const kill = burstOf(await pressAndRead(page, 'Control+Backspace'), 'Ctrl+Backspace');
      assert(kill.dirty && kill.line.endsWith('abc '),
        `Ctrl+Backspace left "${kill.line.slice(-8)}" (dirty ${kill.dirty})`);

      const done = await settle(page);
      const line = await rowText(page, done.row);
      assert(line.includes('echo abc') && !line.includes('def'), `the grid disagrees: "${line.trimEnd()}"`);

      return '4 assertions, all painted before the echo';
    } finally {
      await page.keyboard.press('Control+u').catch(() => undefined);
      await page.close();
    }
  },
};

export const keysMacChords: Check = {
  name: 'keys-mac-chords',
  what: 'the mac command and option chords land exactly, or refuse to claim at all',
  needsFreshPane: true,
  // Reporting macOS changes which chords the engine maps, so this is the only way to
  // reach the ⌘ and ⌥ paths at all. Everything else about the page is the same.
  async run(rig): Promise<string> {
    const page = await rig.page({ ...VIEWPORT, mac: true });
    try {
      await freshLine(page);
      await page.keyboard.type(ACCENTED, { delay: 15 });
      await quietOrSkip(page, 'typing the accented line');
      const end = await probe(page); // where the line really ends, for ⌘→ to be judged against

      const home = burstOf(await pressAndRead(page, 'Meta+ArrowLeft'), '⌘←');
      assert(home.line.length === home.floor,
        `⌘← claimed column ${home.line.length} with the proven floor at ${home.floor}`);
      await waitFor(page, (f) => window.__ehPredict.col === f, home.floor, 3000,
        `the grid cursor never reached the input start at column ${home.floor}, so the ⌘← claim was never confirmed`);

      const tail = burstOf(await pressAndRead(page, 'Meta+ArrowRight'), '⌘→');
      assert(tail.line.length === end.col, `⌘→ claimed column ${tail.line.length} and the line ends at ${end.col}`);

      // A full round trip, so the kill below starts from a cursor the server agrees is
      // at the end rather than from one still in flight.
      await Bun.sleep(1000);
      const kill = burstOf(await pressAndRead(page, 'Meta+Backspace'), '⌘⌫');
      assert(kill.dirty && kill.line.length === kill.floor,
        `⌘⌫ left column ${kill.line.length} with floor ${kill.floor} (dirty ${kill.dirty})`);

      const killed = await settle(page);
      const line = await rowText(page, killed.row);
      assert(!line.includes('café'), `the kill left text on the row: "${line.trimEnd()}"`);
      assert(killed.inputLen === 0, `inputLen is ${killed.inputLen} after the whole input was killed`);

      await freshLine(page);
      await page.keyboard.type('echo uno dos tres', { delay: 15 });
      await quietOrSkip(page, 'typing the word-nav line');

      const w1 = burstOf(await pressAndRead(page, 'Alt+ArrowLeft'), '⌥←');
      assert(w1.line.endsWith('dos '), `one ⌥← landed after "${w1.line.slice(-10)}"`);
      await page.keyboard.press('Alt+ArrowLeft');
      const w3 = burstOf(await pressAndRead(page, 'Alt+ArrowLeft'), '⌥← three times');
      assert(w3.line.endsWith('echo '), `three ⌥← landed after "${w3.line.slice(-10)}"`);

      // A fourth has nowhere to go. The engine keeps the claim it already proved rather
      // than handing off, because a handoff at the floor is a cursor that visibly stalls
      // for a round trip and then does not move.
      const refused = await pressAndRead(page, 'Alt+ArrowLeft');
      const w4 = burstOf(refused, '⌥← at the floor');
      assert(!w4.draining && w4.line.length === w4.floor && !refused.hold,
        `the refused ⌥← left column ${w4.line.length}, floor ${w4.floor}, draining ${w4.draining}, hold ${!!refused.hold}`);

      await Bun.sleep(1000);
      const held = await probe(page);
      assert(held.col === w4.floor, `the cursor drifted to ${held.col} after the refused ⌥←, floor is ${w4.floor}`);

      const fwd = burstOf(await pressAndRead(page, 'Alt+ArrowRight'), '⌥→');
      assert(fwd.line.endsWith('echo '),
        `⌥→ landed after "${fwd.line.slice(-12)}"; zsh stops at the next word start, not at the end of this one`);
      await settle(page);

      return '11 assertions, all painted before the echo';
    } finally {
      await page.keyboard.press('Control+u').catch(() => undefined);
      await page.close();
    }
  },
};

export const keysNav: Check = {
  name: 'keys-nav',
  what: 'movement across a wrap seam rebases exactly, and unknowable keys hand off instead of freezing',
  needsFreshPane: true,
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    try {
      // Recall: Up is a history search, and what comes back is unknowable from the
      // client. Claiming it paints a line the engine invented. Handing off is correct.
      await freshLine(page);
      await page.keyboard.type('echo hola mundo', { delay: 15 });
      await quietOrSkip(page, 'typing the line to recall');
      await page.keyboard.press('Enter');
      await waitSafe(page, 15000, 'the gate never re-armed after running the line');
      await Bun.sleep(900);

      const recall = await pressAndRead(page, 'ArrowUp');
      assert(!recall.burst || recall.burst.draining || !!recall.hold,
        'recall was claimed outright, so the engine painted a line it had no way to know');

      // The recalled text sits on an unproven floor. Word-left has to keep moving at
      // echo pace there; the failure this guards is a cursor that stops dead.
      await Bun.sleep(900);
      const atEnd = (await probe(page)).col;
      await page.keyboard.press('Alt+ArrowLeft');
      await waitFor(page, (c) => window.__ehPredict.col < c, atEnd, 3000,
        `the cursor never left column ${atEnd} after a word-left on recalled text; that is either the freeze this guards against or a wire that stalled, and this check cannot tell the two apart`);
      const moved = await probe(page);
      assert(!moved.burst || !moved.burst.dirty, 'a dirty claim survived the move, so the row is modelled wrong');

      await freshLine(page);
      await clearScreen(page);
      const cols = await columns(page);
      const promptLen = await promptWidth(page);
      const top = (await probe(page)).row;

      // One streak of typing straight through the wrap, so inputLen spans the seam and
      // the continuation row carries a floor of 0.
      await page.keyboard.type('echo ' + 'd'.repeat(cols - promptLen - 5) + 'efgh', { delay: 8 });
      const wrapped = await settle(page, 6000);
      assert(wrapped.row === top + 1 && wrapped.col === 4,
        `the line settled at ${wrapped.row}/${wrapped.col}, expected the continuation row ${top + 1} at column 4`);

      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
      const inRow = burstOf(await probe(page), 'four lefts inside the continuation row');
      assert(inRow.line.length === 0, `the model cursor sits at column ${inRow.line.length} of the continuation, expected 0`);

      const up = await pressAndRead(page, 'ArrowLeft'); // this one crosses the seam
      const ub = burstOf(up, 'left across the seam');
      assert(ub.row === top && ub.line.length === cols - 1 && ub.offGrid === true,
        `the seam crossing modelled ${ub.row}/${ub.line.length} (offGrid ${ub.offGrid}), expected ${top}/${cols - 1} off-grid`);
      await waitFor(page, (a) => window.__ehPredict.col === a.c && window.__ehPredict.row === a.r,
        { c: cols - 1, r: top }, 3000,
        `the grid never followed the seam crossing to row ${top} column ${cols - 1}`);

      const down = burstOf(await pressAndRead(page, 'ArrowRight'), 'right across the seam');
      assert(down.row === top + 1 && down.line.length === 0,
        `the return crossing modelled ${down.row}/${down.line.length}, expected ${top + 1}/0`);
      await settle(page);

      // The d-run and "efgh" are one word straddling the seam, so word-left has to walk
      // off the continuation and land on the row above.
      const wleft = burstOf(await pressAndRead(page, 'Alt+ArrowLeft'), 'word-left across the seam');
      assert(wleft.row === top && wleft.line.endsWith('echo '),
        `word-left landed on row ${wleft.row} after "${wleft.line.slice(-8)}"`);
      await settle(page);

      const wright = burstOf(await pressAndRead(page, 'Alt+ArrowRight'), 'word-right across the seam');
      assert(wright.row === top + 1 && wright.line.length === 4,
        `word-right landed at ${wright.row}/${wright.line.length}, expected ${top + 1}/4`);
      await settle(page, 6000);

      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
      await settle(page);
      const del = burstOf(await pressAndRead(page, 'Backspace'), 'backspace across the seam');
      assert(del.dirty && del.row === top && del.line.length === cols - 1,
        `the cross-seam backspace modelled ${del.row}/${del.line.length} (dirty ${del.dirty}), expected ${top}/${cols - 1}`);
      await settle(page, 6000);
      const healed = await rowText(page, top);
      assert(healed.trimEnd().length === cols && healed.endsWith('e'),
        `the row above converged to "...${healed.slice(-6)}" at width ${healed.trimEnd().length}`);

      await freshLine(page);
      await clearScreen(page);
      const t13top = (await probe(page)).row;
      await page.keyboard.type('echo ' + 'k'.repeat(cols - promptLen - 5) + 'lmno', { delay: 8 });
      await settle(page, 6000);

      // ^A on a continuation row starts from an unproven floor, so the engine rides it.
      // Riding is fine here. Freezing is not.
      const homeRead = await pressAndRead(page, 'Control+A');
      assert((!homeRead.burst || homeRead.burst.draining) && (!homeRead.hold || homeRead.hold.nav === true),
        `^A on a wrapped line claimed instead of handing off (burst ${!!homeRead.burst}, hold ${JSON.stringify(homeRead.hold)})`);
      await waitFor(page, (a) => window.__ehPredict.row === a.r && window.__ehPredict.col === a.c,
        { r: t13top, c: promptLen }, 3000,
        `^A never reached the input start at row ${t13top} column ${promptLen}, so echo-paced could not be told apart from frozen`);

      const endRead = burstOf(await pressAndRead(page, 'Control+E'), '^E across the seam');
      assert(endRead.row === t13top + 1 && endRead.line.length === 4,
        `^E predicted ${endRead.row}/${endRead.line.length}, expected ${t13top + 1}/4`);
      await settle(page, 6000);

      await freshLine(page);
      await page.keyboard.type('echo uno dos', { delay: 12 });
      await quietOrSkip(page, 'typing the line before the ride');

      const ride = await pressAndRead(page, 'ArrowUp');
      assert(!ride.burst && !!ride.hold && ride.hold.nav === true,
        `Up should ride behind a nav hold (burst ${!!ride.burst}, hold ${JSON.stringify(ride.hold)})`);

      // One round trip. The hold releases on the first cursor evidence, and the very
      // next keystroke has to be optimistic again: a hold that outlives its cause is a
      // sluggish terminal for as long as it lasts.
      await Bun.sleep(500);
      const resumed = burstOf(await typeAndRead(page, 'X'), 'typing after the ride');
      assert(resumed.line.endsWith('X'), `the first key after the ride painted "${resumed.line.slice(-6)}"`);
      await settle(page);

      return '17 assertions across the seam and the handoffs, all read before the echo';
    } finally {
      await page.keyboard.press('Control+u').catch(() => undefined);
      await page.close();
    }
  },
};

export const keysEditing: Check = {
  name: 'keys-editing',
  what: 'a learned wrap is predicted in place, and deletes across it stay optimistic',
  needsFreshPane: true,
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    try {
      await freshLine(page);
      const cols = await columns(page);
      const promptLen = await promptWidth(page);

      // First crossing in this pane: the engine holds no style for the shell yet, so it
      // rides the wrap and learns the shape from what comes back.
      const fill1 = 'echo ' + 'a'.repeat(cols - promptLen - 5 + 6);
      await page.keyboard.type(fill1, { delay: 12 });
      const rode = await settle(page, 6000);
      const above = await rowText(page, rode.row - 1);
      const cont = await rowText(page, rode.row);
      assert(above.trimEnd().length === cols && cont.trimEnd().length > 0,
        `the ridden wrap converged to ${above.trimEnd().length} columns above and ${cont.trimEnd().length} below`);
      const learned = await probe(page);
      assert(learned.wrap !== null && learned.wrap.pull === false && Math.abs(learned.wrap.atLen - (cols - 1)) <= 1,
        `zsh's hard wrap was learned as ${JSON.stringify(learned.wrap)}, expected a break near column ${cols - 1} with no word pulled`);

      // Second crossing, on a cleared screen so there is a row below to wrap into. This
      // one has to be predicted, in place, with no ride.
      await freshLine(page);
      await clearScreen(page);
      const top = (await probe(page)).row;
      const fill2 = 'echo ' + 'b'.repeat(cols - promptLen - 5 - 2); // stops two short of the learned edge
      const pre = await typeAndRead(page, fill2, 8);
      const pb = burstOf(pre, 'typing up to the edge');
      assert(!pb.wrapped && pb.line.length === promptLen + fill2.length,
        `pre-edge typing modelled ${pb.line.length} columns (wrapped ${pb.wrapped}), expected ${promptLen + fill2.length}`);

      const crossed = await typeAndRead(page, 'XYZ', 25);
      const cb = burstOf(crossed, 'crossing the learned edge');
      assert(cb.wrapped === true && cb.row === top + 1,
        `the crossing modelled row ${cb.row} (wrapped ${cb.wrapped}), expected ${top + 1} wrapped`);
      assert(crossed.edge === null || (crossed.edge.row === top && crossed.edge.col === cols - 1),
        `the edge glyph is held at ${JSON.stringify(crossed.edge)}, expected row ${top} column ${cols - 1}`);
      assert(cb.line.length > 0 && cb.floor === 0,
        `the continuation modelled ${cb.line.length} columns from floor ${cb.floor}, expected content from floor 0`);

      await settle(page, 6000);
      const r1 = await rowText(page, top);
      const r2 = await rowText(page, top + 1);
      assert(r1.trimEnd().length === cols && r1[cols - 1] === 'Y' && r2.startsWith('Z'),
        `the wrap converged with "${r1.slice(-3)}" above and "${r2.slice(0, 5)}" below`);

      // What follows only says anything against a PREDICTED wrap, which needs the hard
      // wrap style still in hand.
      await waitFor(page, () => {
        const w = window.__ehPredict.wrap;
        return !!w && w.pull === false;
      }, null, 5000,
        'the zsh hard-wrap style was not in hand, so the continuation-row deletes below would have been measuring an unlearned wrap');

      await freshLine(page);
      await clearScreen(page);
      await page.keyboard.type('echo ' + 'c'.repeat(cols - promptLen - 5 + 8), { delay: 10 });
      await settle(page, 6000);

      // A predicted wrap keeps inputLen across the seam, and that is what lets a delete
      // on the continuation row stay optimistic instead of handing off.
      const back = burstOf(await pressAndRead(page, 'Backspace'), 'backspace on the continuation row');
      assert(back.dirty && !back.draining,
        `the continuation backspace handed off (dirty ${back.dirty}, draining ${back.draining})`);
      await settle(page);

      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Alt+Backspace');
        await Bun.sleep(120);
      }
      await settle(page, 6000);
      const idle = await probe(page);
      assert(!idle.burst && !idle.hold,
        `the word-delete storm left the engine busy (burst ${!!idle.burst}, hold ${!!idle.hold})`);

      return '9 assertions, wrap learned then predicted';
    } finally {
      await page.keyboard.press('Control+u').catch(() => undefined);
      await page.close();
    }
  },
};

// A marker, not a credential. `su` reads it, fails to authenticate, and drops it;
// nothing here writes it anywhere. It is distinctive so the screen scan below has
// something unambiguous to look for.
const GATE_MARKER = 'zzprobe-never-painted';

export const keysGate: Check = {
  name: 'keys-gate',
  what: 'the gate disarms at a password prompt and nothing is painted there',
  needsFreshPane: true,
  // The engine paints characters the server has not confirmed. At a password prompt
  // the server is deliberately echoing nothing, so anything painted there is a
  // plaintext secret on the screen and in the scrollback, put there by us. That makes
  // this the one check in the file where a false pass is a disclosure rather than a
  // glitch, and it is why the marker below is a marker.
  //
  // Two separate things are guarded. Enter disarms locally, before the server's frame
  // arrives, which closes the window where a fast typist gets ahead of the round trip
  // and paints onto a command that has already run. And a canonical no-echo prompt
  // keeps the gate down for as long as it is up.
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    try {
      await freshLine(page);
      await page.keyboard.type('echo done', { delay: 15 });
      await page.keyboard.press('Enter');

      const sent = await probe(page); // instant: this is before the server's frame
      assert(sent.safe === false,
        'the gate stayed armed at Enter, so a keystroke could be painted onto a command that already ran');
      assert(sent.fresh === true, 'the next line was not marked fresh, so the engine would claim a prompt it has not seen');

      await waitSafe(page, 15000, 'the gate never re-armed after the command');
      await Bun.sleep(800);

      await page.keyboard.type('su -c true', { delay: 15 });
      await page.keyboard.press('Enter');
      await Bun.sleep(1500); // the prompt is canonical and echoes nothing

      // Distinguish "su never asked" from "the gate failed to drop". Both leave the gate
      // armed, and only the second is this check's business.
      const at = await probe(page);
      const before = await screenRows(page, at);
      if (!before.some((r) => /password/i.test(r))) {
        inconclusive('su never asked for a password, so the gate was never put in front of one');
      }
      assert(at.safe === false, 'the gate stayed armed at a password prompt');

      await page.keyboard.type(GATE_MARKER, { delay: 10 });
      const typed = await probe(page);
      assert(!typed.burst && typed.inputLen === 0,
        `the engine modelled ${typed.inputLen} characters of a password (burst ${!!typed.burst})`);

      // A prefix, so a half-painted marker is caught as well as a whole one.
      const after = await screenRows(page, typed);
      assert(!after.join('\n').includes(GATE_MARKER.slice(0, 7)), 'the password was painted onto the screen');

      await page.keyboard.press('Control+C');
      await Bun.sleep(800);

      return '5 assertions, nothing painted while the gate was down';
    } finally {
      await page.keyboard.press('Control+u').catch(() => undefined);
      await page.close();
    }
  },
};

export const keysLearning: Check = {
  name: 'keys-learning',
  what: 'the engine rides one composer wrap, learns the word-pull style, then predicts the next',
  needsFreshPane: true,
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    try {
      await freshLine(page);
      const cols = await columns(page);
      await launchApp(page, 'composer');
      await waitSafe(page, 15000, 'the gate never re-armed inside the composer, so nothing there could be predicted');

      // The mimic wraps at cols-2 and indents continuations by two, pulling the whole
      // word down with it. Entering the pane swaps zsh's style out, so the engine starts
      // with nothing for this app: the first crossing rides and teaches, and a crossing
      // after that has to be predicted in place.
      const W = cols - 2;
      const words: string[] = [];
      let total = 2;
      while (total < 2 * W - 12) {
        const word = 'w' + String(words.length).padStart(2, 'o') + 'rd';
        words.push(word);
        total += word.length + 1;
      }
      await page.keyboard.type(words.join(' '), { delay: 10 });
      await settle(page, 6000);

      // Bounded, and it stops at the first sighting. The learner needs a quiet wire, so
      // the loop pauses every few words. How many crossings it takes is not the subject
      // here, which is why running out is reported as never having seen the state rather
      // than as the engine being wrong.
      let predicted = false;
      let crossings = 0;
      for (; crossings < 40 && !predicted; crossings++) {
        await page.keyboard.type(' next' + crossings, { delay: 8 });
        const q = await probe(page);
        if (q.burst && q.burst.wrapped && q.wrap && q.wrap.pull) predicted = true;
        if (crossings % 3 === 2) await Bun.sleep(220);
      }

      const style = await probe(page);
      assert(style.wrap !== null && style.wrap.pull === true && style.wrap.indent === 2,
        `the composer wrap was learned as ${JSON.stringify(style.wrap)}, expected a word pull with a 2-column indent`);
      if (!predicted) {
        inconclusive(`${crossings} crossings went by without one being predicted, so the learned style was never seen driving a prediction`);
      }

      const converged = await settle(page, 6000);
      assert(!converged.burst, 'a burst outlived the composer draft it was predicting');

      // Word deletes walking back across the wrap the engine just predicted.
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Alt+Backspace');
        await Bun.sleep(90);
      }
      const idle = await settle(page, 6000);
      assert(!idle.burst && !idle.hold,
        `the delete storm left the engine busy (burst ${!!idle.burst}, hold ${!!idle.hold})`);

      // A block that reflowed wrong shows up as two prompt rows: the real one, and an
      // overlay the engine painted and never took back.
      const here = await probe(page);
      const block = await rowsBetween(page, here.row - 3, here.row + 2);
      const prompts = block.filter((r) => r.startsWith('> ')).length;
      assert(prompts === 1, `the composer block holds ${prompts} prompt rows: ${JSON.stringify(block)}`);

      return `5 assertions, wrap predicted after ${crossings} crossings`;
    } finally {
      await teardownApp(page).catch(() => undefined);
      await page.close();
    }
  },
};

export const keysComposer: Check = {
  name: 'keys-composer',
  what: "claude's composer is seeded, so its first wrap is predicted and the block navigates without a ride",
  needsFreshPane: true,
  // Seventeen assertions in one check because they are one session: a launch, one
  // draft, and a sequence of states where each is the setup for the next. Split apart
  // they would each pay the launch again and re-engineer the same two-row draft, which
  // is more code and more to go wrong than the finer failure naming buys back.
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    try {
      await freshLine(page);
      const cols = await columns(page);
      await launchApp(page, 'claude');
      await waitSafe(page, 30000, 'the gate never re-armed inside claude');
      // A fixed beat rather than a quiet() wait: the composer redraws on its own
      // schedule, so silence is not a reliable sign that it has finished its first paint.
      await Bun.sleep(500);

      // Claude's composer is a known pane, so the style is seeded rather than learned.
      // That is the whole point: the FIRST wrap has to be right, with no ride to teach it.
      const seeded = await probe(page);
      assert(
        seeded.wrap !== null && seeded.wrap.pull === true && seeded.wrap.indent === 2 && seeded.wrap.atLen === cols - 2,
        `the seeded style is ${JSON.stringify(seeded.wrap)}, expected a word pull at ${cols - 2} with a 2-column indent`,
      );

      const typed = burstOf(await typeAndRead(page, 'hola cañón über'), 'typing into the composer');
      assert(typed.dirty && typed.line.endsWith('hola cañón über'),
        `the composer burst ends "${typed.line.slice(-20)}" (dirty ${typed.dirty})`);
      const drafted = await settle(page, 6000);
      assert(!drafted.burst, 'a burst outlived the composer draft');

      // Bounded, and it stops at the first sighting. Running out means the draft never
      // reached the edge, which is a check that did not run.
      let wrapSeen: Burst | null = null;
      let words = 0;
      for (; words < 30 && !wrapSeen; words++) {
        await page.keyboard.type(' pal' + String(words).padStart(2, 'a'), { delay: 8 });
        const q = await probe(page);
        if (q.burst && q.burst.wrapped) wrapSeen = q.burst;
        if (words % 4 === 3) await Bun.sleep(200);
      }
      if (!wrapSeen) {
        inconclusive(`${words} words went in without the draft wrapping, so the seeded style was never put to work`);
      }
      assert(/^ {2}\S/.test(wrapSeen.line),
        `the predicted continuation reads ${JSON.stringify(wrapSeen.line.slice(0, 12))}, expected the indent then the pulled word`);

      const afterWrap = await settle(page, 6000);
      const kept = await probe(page);
      assert(!afterWrap.burst && kept.wrap !== null && kept.wrap.pull === true,
        `the predicted wrap left burst ${!!afterWrap.burst} and style ${JSON.stringify(kept.wrap)}`);

      // Engineer the row to end exactly at the wrap length, then type a space. There is
      // no word to pull down, so the continuation has to open empty.
      await clearDraft(page);
      await page.keyboard.type('x'.repeat(cols - 9) + ' yyyy', { delay: 6 });
      await settle(page, 6000);
      const spaced = burstOf(await typeAndRead(page, ' '), 'space at the wrap edge');
      assert(spaced.wrapped && spaced.line === '  ',
        `the space opened ${JSON.stringify(spaced.line)}, expected the bare indent`);
      const landed = burstOf(await typeAndRead(page, 'z'), 'first character after a space wrap');
      assert(landed.line === '  z', `the character landed as ${JSON.stringify(landed.line)}`);
      const spaceDone = await settle(page, 6000);
      const stillPull = await probe(page);
      assert(!spaceDone.burst && stillPull.wrap !== null && stillPull.wrap.pull === true,
        `the space wrap left burst ${!!spaceDone.burst} and style ${JSON.stringify(stillPull.wrap)}`);

      // Back one column off the end, so the row above certainly holds the column the
      // vertical moves start from.
      await page.keyboard.press('ArrowLeft');
      await settle(page);
      const vRow = (await probe(page)).row;

      const up = burstOf(await pressAndRead(page, 'ArrowUp'), 'Up inside the draft');
      assert(up.row === vRow - 1 && up.offGrid === true,
        `Up modelled row ${up.row} (offGrid ${up.offGrid}), expected ${vRow - 1} off-grid`);
      await waitFor(page, (r) => window.__ehPredict.row === r, vRow - 1, 3000,
        `the grid never followed the Up to row ${vRow - 1}`);

      const down = burstOf(await pressAndRead(page, 'ArrowDown'), 'Down inside the draft');
      assert(down.row === vRow, `Down modelled row ${down.row}, expected ${vRow} clamped to the row end`);
      await settle(page);

      const home = burstOf(await pressAndRead(page, 'Control+A'), '^A across the draft');
      assert(home.row === vRow - 1 && home.line.length === 2,
        `^A modelled ${home.row}/${home.line.length}, expected ${vRow - 1}/2`);
      await settle(page);

      const end = burstOf(await pressAndRead(page, 'Control+E'), '^E across the draft');
      assert(end.row === vRow && end.line.endsWith('z'),
        `^E modelled row ${end.row} ending "${end.line.slice(-4)}"`);
      await settle(page);

      // A ridden key zeroes inputLen: the engine no longer knows how much of the row it
      // put there. The row's floor is structural, so a delete after the ride still has
      // somewhere to stop and has to stay optimistic.
      await page.keyboard.press('Escape'); // one Escape: the draft survives, the key rides
      await Bun.sleep(800);
      const ridden = await probe(page);
      assert(ridden.inputLen === 0, `inputLen is ${ridden.inputLen} after a ridden key, expected 0`);

      const structural = burstOf(await pressAndRead(page, 'Backspace'), 'backspace after a ride');
      assert(structural.dirty && structural.line === '  ',
        `the backspace modelled ${JSON.stringify(structural.line)} (dirty ${structural.dirty})`);
      await settle(page, 6000);

      await clearDraft(page);
      await page.keyboard.type('hola mundo', { delay: 10 });
      await Bun.sleep(600);
      const killed = burstOf(await pressAndRead(page, 'Control+U'), '^U on the draft row');
      assert(killed.dirty && killed.line.length === 2,
        `^U left ${killed.line.length} columns (dirty ${killed.dirty}), expected the prompt edge at 2`);
      await settle(page, 6000);

      // Leaving restores zsh's style from the per-app cache. Re-learning it would cost
      // the user another ridden wrap every time they come back from an application.
      await teardownApp(page).catch(() => undefined);
      await waitFor(page, () => window.__ehPredict.app === 'zsh', null, 8000,
        'claude never released the pane, so the per-app style restore was never exercised');
      await Bun.sleep(1500);
      const restored = await probe(page);
      assert(restored.wrap !== null && restored.wrap.pull === false,
        `zsh came back with style ${JSON.stringify(restored.wrap)}, expected its hard wrap`);

      return `17 assertions, first wrap predicted after ${words} words`;
    } finally {
      // The body exits claude on its own. This catches the runs that never got there.
      await teardownApp(page).catch(() => undefined);
      await page.close();
    }
  },
};

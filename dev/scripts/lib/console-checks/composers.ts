// Keyboard checks driven through every composer on the roster.
//
// The single-pane keyboard checks live in keys.ts; these sweep the applications, one
// after another, holding each to the same instant-read standard: the probe runs a few
// milliseconds after the key, the link carries about 150ms of round trip, so what the
// engine reports cannot have come back from the server yet. Which applications a check
// drives is a fact on the application's row in console-apps.ts (`floor`, `words`,
// `ghost`, `trailing`), so where a tool is tested has one answer.
import { type AppName, APPS, appsWith } from '../console-apps';
import {
  VIEWPORT, type Check, burstOf, composerInputProbe, freshLine, gridRow, pressAndRead, probe,
  launchApp, teardownApp, assert,
  quiet, quietOrSkip, readTrace, resetsSince, settle, sweep, traceMark, typeAndRead, waitSafe,
} from '../console-rig';

export const keysReflow: Check = {
  name: 'keys-reflow',
  what: 'deletion reflows every continuation before echo, including composer shrink and repeated edits',
  needsFreshPane: true,
  async run(rig): Promise<string> {
    const page = await rig.page({ width: 460, height: 620 });
    try {
      await launchApp(page, 'claude');
      const unavailable = await composerInputProbe(page, 'claude');
      assert(!unavailable, unavailable || 'composer unavailable');
      let checked = 0;
      for (const example of [
        { text: 'look at this very nice example with several more words to bring back from later lines', at: 17, keys: ['Alt+Backspace'] },
        { text: 'extraordinary look at this very nice example and more words', at: 13, keys: ['Alt+Backspace'] },
        { text: 'look at this very nice example with several more words to bring back from later lines', at: 17, keys: ['Backspace', 'Backspace', 'Backspace', 'Backspace'] },
        { text: 'look at this very nice example with several more words to bring back from later lines', at: 17, keys: ['Alt+Backspace', 'n', 'e', 'w'] },
        { text: 'look at this very nice example with several more words to bring back from later lines', at: 17, keys: ['Alt+Backspace', ...Array<string>(50).fill('ArrowRight'), 'Backspace'] },
        { text: 'look at this very nice example with several more words to bring back from later lines', at: 17, keys: ['Alt+Backspace', ...Array<string>(70).fill('x')] },
        { text: 'alpha beta\n\ngamma delta', at: 10, keys: ['Alt+Backspace'] },
      ]) {
        const lines = example.text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (i) await page.keyboard.press('Control+j');
          await page.keyboard.type(lines[i]!, { delay: 12 });
        }
        await settle(page, 8000);
        await quietOrSkip(page, 'wrapped draft');
        if (lines.length > 1) {
          for (let i = 0; i < example.text.length; i++) await page.keyboard.press('ArrowLeft');
        } else await page.keyboard.press('Control+a');
        for (let i = 0; i < example.at; i++) await page.keyboard.press('ArrowRight');
        await settle(page, 8000);
        await quietOrSkip(page, 'cursor positioned within the draft');
        const watermark = await traceMark(page);
        for (const key of example.keys) await page.keyboard.press(key);
        const instant = await probe(page);
        const burst = burstOf(instant, 'wrapped edit');
        assert(instant.reflow !== null && instant.reflow.length >= 2, 'no multi-row prediction');
        const pixels = await page.evaluate(() => {
          const p = window.__ehPredict;
          const height = document.querySelector('.xterm-rows')!.children[0]!.getBoundingClientRect().height;
          const painted = Array.from(document.querySelectorAll<HTMLElement>('.eh-reflow > div')).map((el) => {
            const row = Math.round(parseFloat(el.style.top) / height) + p.baseY;
            const start = el.children[0]!.textContent!.length;
            const ink = el.children[1]!.textContent!;
            const actual = p.text(row)!;
            return { row, text: actual.slice(0, start) + ink + actual.slice(start + ink.length) };
          });
          return { painted, grid: p.reflow!.map(({ row }) => ({ row, text: p.text(row) })) };
        });
        assert(pixels.painted.length > 0, 'the renderer did not paint the reflow');
        assert(pixels.grid.some((row) => row.text !== instant.reflow!.find((r) => r.row === row.row)!.text),
          'the server already echoed; this did not measure prediction');
        for (const row of pixels.painted) {
          assert(row.text === instant.reflow.find((r) => r.row === row.row)?.text,
            `painted row ${row.row} disagrees with its predicted text`);
        }
        await settle(page, 10000);
        await quietOrSkip(page, 'reflow echo');
        const echoed = await probe(page);
        assert(echoed.row === burst.row && echoed.col === burst.line.length,
          `case ${checked + 1}: predicted cursor ${burst.row}/${burst.line.length}, echoed ${echoed.row}/${echoed.col}; rows ${JSON.stringify(instant.reflow)}; trace ${(await readTrace(page)).slice(-8).join('; ')}`);
        for (const row of instant.reflow) {
          const actual = await gridRow(page, row.row);
          if (row.clear && actual !== row.was) continue;
          assert(actual === row.text, `case ${checked + 1} (${example.keys.join(',')}), row ${row.row}: predicted ${JSON.stringify(row.text)}, echoed ${JSON.stringify(actual)}; trace ${(await readTrace(page)).slice(-12).join('; ')}`);
        }
        assert(!echoed.burst, 'reflow prediction outlived the completed echo');
        const resets = await resetsSince(page, watermark);
        assert(resets.length === 0, `reflow expired rather than matching: ${resets.join('; ')}`);
        checked++;
        await page.keyboard.press('Escape');
        await Bun.sleep(150);
        await page.keyboard.press('Escape');
        await settle(page, 8000);
        await quietOrSkip(page, 'clearing the draft');
      }
      return `${checked} multi-row edits painted before echo and matched every affected row and cursor`;
    } finally {
      await teardownApp(page).catch(() => undefined);
      await rig.closePage(page);
    }
  },
};

// ---------------------------------------------------------------------------
// keysEditingComposer
// ---------------------------------------------------------------------------

export const keysEditingComposer: Check = {
  name: 'keys-editing-composer',
  what: 'cursor navigation and deletion stay optimistic in every composer on the roster',
  needsFreshPane: true,
  // The faults this guards were all found by driving the real apps, and none of them
  // was visible to the single-app checks:
  //
  //   codex deletion — reflowRisk mistook the PROMPT row for a continuation row
  //   (its edge equals the indent), the blank row above always "fit", and every
  //   backspace handed off and rode the round trip.
  //
  //   grok navigation — the row's raw trimmed length includes the right box border,
  //   so word-right and End walked the cursor into chrome, mispredicted, and the
  //   burst died carrying every later keystroke down with it.
  //
  //   grok deletion — the prompt seeded as null and rowIsPrompt only matched at
  //   column 0, so the row behind `│ ❯ ` had no structural edge: Home, kill-to-start
  //   and the backspace's permission all handed off.
  //
  // The shape per app is one draft, then arrows, word moves, Home/End, three
  // backspaces, a word delete and a kill — every op read BEFORE its echo can have
  // landed, so a held burst with the right column is the assertion. The floor it holds
  // Home and the kill to is where the EMPTY composer's own cursor sat; the row's `floor`
  // only sanity-checks that the app's chrome still puts it there.
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    const notes = await sweep(rig, page, appsWith('floor'), async (app, v) => {
      await waitSafe(page, 30000, `the gate never re-armed inside ${app}`);
      await Bun.sleep(500);
      await quietOrSkip(page, `${app} startup`);
      // Where the empty composer keeps its cursor IS the input's start.
      const floor = (await probe(page)).col;

      const draft = 'siento que cuando escribes codigo limpio';
      await page.keyboard.type(draft, { delay: 12 });
      await settle(page, 6000);
      // The end column is the PANE's cursor, not the model's: typed faster than
      // the round trip, the echo trails by the last few keystrokes until the wire
      // goes quiet, and every expected column below is derived from this number.
      await quietOrSkip(page, `${app} draft`);
      const end = (await probe(page)).col;
      // A first-run screen (agy's wizard, grok's sign-in, goose's provider setup on a
      // fresh container) takes the pane under the app's name without being its
      // composer. It shows as a draft that did not land whole, or as a cursor that
      // is not where the composer's chrome puts it; both are the check never
      // reaching its state, not the engine being wrong.
      if (end !== floor + draft.length) {
        v.skip(`the draft settled at ${end}, not ${floor + draft.length}, so this is not its composer`);
        return;
      }
      const chrome = APPS[app].floor;
      if (chrome !== 'moves' && floor !== chrome) {
        v.skip(`the empty composer's cursor sat at ${floor}, its chrome puts it at ${chrome}; a redesigned composer, or not its composer`);
        return;
      }
      // The model is read the instant a key lands (burstOf); the PANE is read once the
      // wire settles, so an app that ignores a chord fails here rather than passing on
      // the engine's own optimism.
      const echoed = async (op: string, want: number) => {
        await settle(page);
        const col = (await probe(page)).col;
        if (col !== want) v.fail(`${op} echoed column ${col}, expected ${want}`);
      };

      // Arrows: five left, two right. Each must hold a burst at the expected
      // column the instant the key lands.
      for (let i = 1; i <= 5; i++) {
        const b = burstOf(await pressAndRead(page, 'ArrowLeft'), `left ${i}`);
        if (b.line.length !== end - i) v.fail(`left ${i} modelled column ${b.line.length}, expected ${end - i}`);
        await settle(page);
      }
      for (let i = 1; i <= 2; i++) {
        const b = burstOf(await pressAndRead(page, 'ArrowRight'), `right ${i}`);
        if (b.line.length !== end - 5 + i) v.fail(`right ${i} modelled column ${b.line.length}, expected ${end - 5 + i}`);
        await settle(page);
      }

      // Word moves, measured against the apps' own rule: Alt+ArrowLeft stops at
      // the START of the word the cursor is in or past — from the draft's end
      // that is "limpio"'s start, 6 columns back (the separator is not crossed).
      // Alt+ArrowRight lands at the draft's end.
      const wl = burstOf(await pressAndRead(page, 'Alt+ArrowLeft'), 'word-left');
      if (wl.line.length !== end - 6) v.fail(`word-left modelled column ${wl.line.length}, expected ${end - 6}`);
      await settle(page);
      const wr = burstOf(await pressAndRead(page, 'Alt+ArrowRight'), 'word-right');
      if (wr.line.length !== end) v.fail(`word-right modelled column ${wr.line.length}, expected ${end} (grok's fault walked into the border)`);
      await settle(page);

      // Home/End: the floor is the app's own chrome, read off the model.
      const home = burstOf(await pressAndRead(page, 'Control+A'), 'Home');
      if (home.line.length !== floor) v.fail(`Home modelled column ${home.line.length}, expected the floor at ${floor}`);
      await echoed('Home', floor);
      const back = burstOf(await pressAndRead(page, 'Control+E'), 'End');
      if (back.line.length !== end) v.fail(`End modelled column ${back.line.length}, expected ${end}`);
      await echoed('End', end);

      // Deletion: three backspaces, each optimistic. codex's fault handed the
      // FIRST one off, so `burstOf` is the assertion, not a courtesy.
      for (let i = 1; i <= 3; i++) {
        const b = burstOf(await pressAndRead(page, 'Backspace'), `backspace ${i}`);
        if (!b.dirty || b.line.length !== end - i) v.fail(`backspace ${i} modelled ${JSON.stringify(b.line.slice(-8))} (dirty ${b.dirty}), expected column ${end - i}`);
        await settle(page);
      }
      const wd = burstOf(await pressAndRead(page, 'Alt+Backspace'), 'word-delete');
      if (!wd.dirty || wd.line.length !== end - 6) v.fail(`word-delete modelled column ${wd.line.length}, expected ${end - 6}`);
      await echoed('word-delete', end - 6);
      const kill = burstOf(await pressAndRead(page, 'Control+U'), 'kill');
      if (!kill.dirty || kill.line.length !== floor) v.fail(`kill modelled column ${kill.line.length}, expected the floor at ${floor}`);
      await echoed('kill', floor);
      v.pass(app);
    });
    return `${notes.length} composers navigated and deleted without a ride: ${notes.join(', ')}`;
  },
};

// ---------------------------------------------------------------------------
// keysWords
// ---------------------------------------------------------------------------

// Every punctuation class the rules disagree on, in 63 columns: opencode's splash box
// wraps its text at 70, and a wrapped draft would be measuring wraps, not words.
const WORDS_DRAFT = 'foo.bar baz_qux a-b "quoted" ./src/x.ts --flag=1 (ok) don\'t end';

export const keysWords: Check = {
  name: 'keys-words',
  what: 'word jumps and word deletes land where each application puts them, before the echo',
  needsFreshPane: true,
  // The applications with a word rule in the model, minus the shell, whose rule
  // keys-chords and keys-mac-chords already hold it to; test-console-ui.ts refuses a rule
  // this roster does not drive.
  //
  // The expected columns are not written down here: each key is read off the model the
  // instant it lands and off the PANE once the wire settles, and the two have to agree.
  // That holds the engine to the application rather than to its own idea of a word,
  // which is how one rule served five applications for a year (dev/fixtures/word-rules.json
  // is the same standard, measured, for the unit check). A jump the engine hands off fails
  // here too: a ride is a cursor that stalls for a round trip and then moves.
  async run(rig): Promise<string> {
    const page = await rig.page({ ...VIEWPORT, mac: true });
    const notes = await sweep(rig, page, appsWith('words'), async (app, v) => {
      await waitSafe(page, 30000, `the gate never re-armed inside ${app}`);
      await Bun.sleep(600);
      const floor = (await probe(page)).col;
      await page.keyboard.type(WORDS_DRAFT, { delay: 12 });
      await settle(page, 6000);
      await quietOrSkip(page, `${app} draft`);
      const end = (await probe(page)).col;
      if (end !== floor + WORDS_DRAFT.length) {
        v.skip(`the draft settled at ${end}, not ${floor + WORDS_DRAFT.length}, so this is not its composer`);
        return;
      }
      const agree = async (label: string, key: string, edit: boolean) => {
        const inst = await pressAndRead(page, key);
        const b = inst.burst;
        await settle(page);
        await quiet(page, 400, 6000);
        const pane = await probe(page);
        if (!b) { v.fail(`${label} predicted nothing (the pane went to ${pane.col})`); return; }
        if (b.row !== pane.row || b.line.length !== pane.col) {
          v.fail(`${label} modelled ${b.row}/${b.line.length}, the pane went to ${pane.row}/${pane.col}`);
        }
        if (!edit) return;
        if (!b.dirty) v.fail(`${label} painted nothing`);
        const row = (await gridRow(page, pane.row)) ?? '';
        if (row.slice(0, pane.col) !== b.line) {
          v.fail(`${label} modelled ${JSON.stringify(b.line.slice(-18))}, the pane shows ${JSON.stringify(row.slice(0, pane.col).slice(-18))}`);
        }
      };
      for (let i = 1; i <= 9; i++) await agree(`word-left ${i}`, 'Alt+ArrowLeft', false);
      for (let i = 1; i <= 9; i++) await agree(`word-right ${i}`, 'Alt+ArrowRight', false);
      await agree('End', 'Meta+ArrowRight', false);
      for (let i = 1; i <= 6; i++) await agree(`word-delete ${i}`, 'Alt+Backspace', true);
      v.pass(app);
    });
    return `${notes.length} applications, 25 keys each, every landing the pane's own: ${notes.join(', ')}`;
  },
};

// ---------------------------------------------------------------------------
// keysGhost
// ---------------------------------------------------------------------------

export const keysGhost: Check = {
  name: 'keys-ghost',
  what: 'an empty composer\'s placeholder is not navigable: every cursor key refuses before the echo, as the pane does',
  needsFreshPane: true,
  // Measured before the fix: → ⌥→ and End walked the predicted cursor across Claude Code's
  // dim `Try "…"` (columns 3, 7 and 40 against a pane that stayed at 2), and opencode's
  // grey `Ask anything…` the same way. Two placeholders in two styles, dim and coloured,
  // so the ghost rule is exercised on each.
  async run(rig): Promise<string> {
    const page = await rig.page({ ...VIEWPORT, mac: true });
    const notes = await sweep(rig, page, appsWith('ghost'), async (app, v) => {
      await waitSafe(page, 30000, `the gate never re-armed inside ${app}`);
      await Bun.sleep(1500);
      await quietOrSkip(page, `${app} startup`);
      const start = await probe(page);
      const row = (await gridRow(page, start.row)) ?? '';
      if (row.trimEnd().length <= start.col) {
        v.skip('no placeholder is showing right of the cursor');
        return;
      }
      for (const key of ['ArrowRight', 'Alt+ArrowRight', 'Meta+ArrowRight', 'ArrowLeft', 'Alt+ArrowLeft', 'Meta+ArrowLeft']) {
        const inst = await pressAndRead(page, key);
        const col = inst.burst ? inst.burst.line.length : inst.col;
        if (col !== start.col || (inst.burst && inst.burst.dirty)) {
          v.fail(`${key} modelled column ${col} (dirty ${!!inst.burst?.dirty}) on the empty composer, whose input starts at ${start.col}`);
        }
        await settle(page);
        const pane = await probe(page);
        if (pane.col !== start.col) v.fail(`the pane itself moved to ${pane.col} on ${key}, so this is not a refusal to guard`);
      }
      for (const key of ['Backspace', 'Alt+Backspace']) {
        const inst = await pressAndRead(page, key);
        if (inst.burst && inst.burst.dirty) v.fail(`${key} on the empty composer painted a delete`);
        await settle(page);
      }
      // The first keystroke lands at the input's start, over the placeholder.
      const before = await probe(page); // what the engine held the instant before the key
      const first = await typeAndRead(page, 'x');
      if (!first.burst) {
        const row1 = (await gridRow(page, first.row)) ?? '';
        v.fail(`the first keystroke predicted nothing (safe ${first.safe}, hold ${JSON.stringify(first.hold)}, inputLen ${first.inputLen}, ` +
          `pane ${first.row}/${first.col} of ${first.cols} cols; row length ${row1.length}; before the key: burst ${JSON.stringify(before.burst && { row: before.burst.row, line: before.burst.line.slice(0, 12), draining: before.burst.draining, dirty: before.burst.dirty })} hold ${JSON.stringify(before.hold)} pane ${before.row}/${before.col})`);
      } else if (first.burst.line.length !== start.col + 1) {
        v.fail(`the first keystroke modelled column ${first.burst.line.length}, expected ${start.col + 1}`);
      }
      await settle(page, 6000);
      v.pass(app);
    });
    return `${notes.length} placeholders refused every cursor key: ${notes.join(', ')}`;
  },
};

// ---------------------------------------------------------------------------
// keysStorm
// ---------------------------------------------------------------------------

// The words the storm inserts. Short and distinct, so a row the model garbles is
// readable in the failure dump.
const STORM_WORDS = ['alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];

export const keysStorm: Check = {
  name: 'keys-storm',
  what: 'typing, deletes, word deletes and cursor moves interleaved at full speed never cost the model its grip',
  needsFreshPane: true,
  // The reported fault class: a burst that DIES mid-run (the model lost the pane and
  // re-read a stale grid) or a measured wrap style forgotten mid-session. Both are
  // read out of the engine's own decision trace, so a designed handoff (a ridden
  // Home, a rode wrap) is never filed as one — the trace names each death.
  //
  // The sequence is a seeded LCG per application: deterministic per run, different
  // per app, and printed on failure so the exact ops replay.
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    const notes = await sweep(rig, page, [null, ...appsWith('seed')], async (app, v) => {
      const name = app ?? 'zsh';
      if (app) {
        await waitSafe(page, 30000, `the gate never re-armed inside ${app}`);
        await Bun.sleep(500);
      } else {
        await freshLine(page);
      }
      if (app) {
        const unavailable = await composerInputProbe(page, APPS[app].paneApp);
        if (unavailable) { v.skip(unavailable); return; }
      }

      const watermark = await traceMark(page);

      let sgen = 0;
      for (const c of name) sgen = (sgen * 31 + c.charCodeAt(0)) >>> 0;
      const rnd = () => (sgen = (sgen * 1103515245 + 12345) >>> 0) / 0x100000000;

      let unlearns = 0;
      let watching = true;
      const seeded = !!(await probe(page)).wrap;
      const watch = (async () => {
        let style = seeded;
        while (watching) {
          const w = (await probe(page)).wrap;
          if (style && !w) unlearns++;
          if (w) style = true;
          await Bun.sleep(15);
        }
      })();

      // The watcher stops on every path: after a key throws it would keep reading a page
      // that is being closed, and its rejection would go unhandled.
      try {
        for (let i = 0; i < 120; i++) {
          const r = rnd();
          if (r < 0.52) {
            await page.keyboard.type(STORM_WORDS[Math.floor(rnd() * STORM_WORDS.length)] + (rnd() < 0.8 ? ' ' : ''), { delay: 5 });
          } else if (r < 0.66) {
            const n = 1 + Math.floor(rnd() * 2);
            for (let k = 0; k < n; k++) await page.keyboard.press('Backspace');
          } else if (r < 0.74) {
            await page.keyboard.press('Alt+Backspace');
          } else if (r < 0.83) {
            const n = 1 + Math.floor(rnd() * 3);
            for (let k = 0; k < n; k++) await page.keyboard.press('ArrowLeft');
          } else if (r < 0.90) {
            const n = 1 + Math.floor(rnd() * 3);
            for (let k = 0; k < n; k++) await page.keyboard.press('ArrowRight');
          } else if (r < 0.95) {
            await page.keyboard.press('Alt+ArrowLeft');
          } else {
            await page.keyboard.press('Alt+ArrowRight');
          }
          await Bun.sleep(10);
        }
      } finally {
        watching = false;
        watch.catch(() => undefined);
      }
      await watch;

      // Every burst death while the keys were flowing is a fault with its reason
      // attached. Settling below is outside this check's continuous-input window.
      const resets = await resetsSince(page, watermark);
      if (resets.length) {
        const tail = (await readTrace(page)).slice(-14).join(' | ');
        for (const l of resets.slice(0, 3)) v.fail(`burst died mid-run: ${l}\n    trace: ${tail}`);
      }
      if (unlearns) v.fail(`${unlearns} wrap style unlearn(s) mid-run`);

      const idle = await settle(page, 8000);
      if (idle.burst || idle.hold) {
        v.fail(`the storm left the engine busy (burst ${!!idle.burst}, hold ${!!idle.hold})`);
        return;
      }
      // The model kept the pane through the whole run if nothing above fired. Prove
      // it is still predicting, not merely quiet: park at the content's end, where an
      // insert is a plain append, and one more insert must paint. (Typing mid-row at
      // the wrap edge rides by design — the overflow shifts content the model cannot
      // see — so the probe has to land at the end to mean anything.)
      await page.keyboard.press('Control+E');
      await settle(page, 8000);
      const more = burstOf(await typeAndRead(page, 'ok'), `typing after the ${name} storm`);
      if (!more.line.endsWith('ok')) v.fail(`the post-storm insert modelled ${JSON.stringify(more.line.slice(-6))}`);
      else v.pass(name);
    });
    return `${notes.length} editors held the pane through a 120-op storm: ${notes.join(', ')}`;
  },
};

// ---------------------------------------------------------------------------
// keysTrailing
// ---------------------------------------------------------------------------

export const keysTrailing: Check = {
  name: 'keys-trailing',
  what: 'End lands on a trailing space the grid cannot show, in the shell and the composers with a word rule',
  needsFreshPane: true,
  // A word delete leaves its separator behind: `uno dos tres` becomes `uno dos ` and the
  // pane's End goes past that space, which on the grid is a blank like any other. Read off
  // the grid, End predicted one column short and the cursor snapped right a round trip
  // later (measured on Claude Code). The burst's own record of where content ends is what
  // this holds: End, a refused →, and a character typed after the space.
  async run(rig): Promise<string> {
    const page = await rig.page({ ...VIEWPORT, mac: true });
    const rows: (AppName | null)[] = [null, ...appsWith('trailing')];
    const notes = await sweep(rig, page, rows, async (app, v) => {
      if (app) {
        await waitSafe(page, 30000, `the gate never re-armed inside ${app}`);
        await Bun.sleep(600);
      } else {
        await freshLine(page);
      }
      const floor = (await probe(page)).col;
      const draft = app ? 'uno dos tres' : 'echo uno dos tres';
      await page.keyboard.type(draft, { delay: 12 });
      await settle(page, 6000);
      await quietOrSkip(page, `${app ?? 'zsh'} draft`);
      const draftEnd = (await probe(page)).col;
      if (draftEnd !== floor + draft.length) {
        v.skip(`the draft settled at ${draftEnd}, not ${floor + draft.length}, so this is not its composer`);
        return;
      }
      await page.keyboard.press('Alt+Backspace');
      await settle(page, 6000);
      await quietOrSkip(page, `${app ?? 'zsh'} word delete`);
      const end = (await probe(page)).col; // after the trailing space, where the pane parks
      await page.keyboard.press('Meta+ArrowLeft');
      await settle(page, 6000);
      await quietOrSkip(page, `${app ?? 'zsh'} Home`);
      const back = burstOf(await pressAndRead(page, 'Meta+ArrowRight'), 'End');
      if (back.line.length !== end) v.fail(`End modelled column ${back.line.length}, the pane parks at ${end}`);
      await settle(page);
      const over = burstOf(await pressAndRead(page, 'ArrowRight'), '→ at the end');
      if (over.line.length !== end) v.fail(`→ past the end modelled column ${over.line.length}, expected a refusal at ${end}`);
      await settle(page);
      const typed = burstOf(await typeAndRead(page, 'x'), 'typing after the space');
      if (!typed.line.endsWith(' x')) v.fail(`typing after the trailing space modelled ${JSON.stringify(typed.line.slice(-8))}`);
      const landed = await settle(page, 6000);
      const row = (await gridRow(page, landed.row)) ?? '';
      if (!row.slice(0, landed.col).endsWith('dos x')) v.fail(`the row converged to ${JSON.stringify(row.slice(0, landed.col).slice(-12))}`);
      v.pass(app ?? 'zsh');
    });
    return `${notes.length} editors landed End on the trailing space: ${notes.join(', ')}`;
  },
};

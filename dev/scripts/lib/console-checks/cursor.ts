// Cursor movement that inserts nothing.
//
// These two ask the narrowest question in the suite, and it is the one that turned out
// to matter most. A burst that only MOVES the cursor changes no content, so the row the
// model describes has to be the row already on the grid, exactly, whatever the echo is
// doing. Anything else is a modelling fault rather than a race, and it shows up on
// screen as characters the user never typed.
import { log } from '../log';
import {
  VIEWPORT, assert, type Check, freshLine, inconclusive, probe, quiet, settle,
} from '../console-rig';

const TAILMOVE_LINE =
  'echo alpha bravo charlie delta epsilon foxtrot golf hotel india juliet kilo';

export const midline: Check = {
  name: 'midline',
  what: 'navigation and deletion preserve and paint the suffix while earlier typing echoes arrive',
  needsFreshPane: true,
  async run(rig) {
    const page = await rig.page(VIEWPORT);
    try {
      let trailing = 0;
      for (const edit of [
        { name: 'character move', keys: Array(7).fill('ArrowLeft'), text: 'echo alpha bravo charlie' },
        { name: 'word move', keys: ['Alt+ArrowLeft'], text: 'echo alpha bravo charlie' },
        { name: 'character delete', keys: [...Array(7).fill('ArrowLeft'), 'Backspace'], text: 'echo alpha bravocharlie' },
        { name: 'word delete', keys: ['Alt+ArrowLeft', 'Alt+Backspace'], text: 'echo alpha charlie' },
      ]) {
        await freshLine(page);
        await settle(page);
        const start = await probe(page);
        await page.keyboard.type('echo alpha bravo charlie', { delay: 0 });
        for (const key of edit.keys) await page.keyboard.press(key);
        const instant = await page.evaluate(() => {
          const p = window.__ehPredict;
          const tail = document.querySelector('.eh-tail') as HTMLElement | null;
          return {
            burst: p.burst, grid: p.text(p.row),
            paintedTail: tail?.style.display === 'block' ? tail.lastElementChild?.textContent : null,
          };
        });
        assert(!!instant.burst, `${edit.name}: prediction was lost before the echo`);
        assert((instant.burst!.line + instant.burst!.tail).slice(start.col).trimEnd() === edit.text,
          `${edit.name}: remaining text is wrong immediately after editing`);
        if (!instant.grid?.includes('charlie')) {
          trailing++;
          assert(instant.paintedTail?.includes('charlie') === true,
            `${edit.name}: pending suffix was not painted (${JSON.stringify(instant.paintedTail)})`);
        }
        const until = Date.now() + 1200;
        while (Date.now() < until) {
          const p = await probe(page);
          if (p.burst) {
            assert((p.burst.line + p.burst.tail).slice(start.col).trimEnd() === edit.text,
              `${edit.name}: a delayed echo rewrote the remaining text`);
          }
          await Bun.sleep(10);
        }
        const done = await settle(page);
        const actual = await page.evaluate((row) => window.__ehPredict.text(row), done.row);
        assert(actual?.slice(start.col).trimEnd() === edit.text,
          `${edit.name}: server text did not converge to ${JSON.stringify(edit.text)}`);
      }
      assert(trailing === 4, `only ${trailing}/4 edits outran their typing echoes`);
      return '4 mixed edit runs preserved and painted their suffix before the echo';
    } finally {
      await page.keyboard.press('Control+u').catch(() => undefined);
      await rig.closePage(page);
    }
  },
};

export const tailmove: Check = {
  name: 'tailmove',
  what: 'a rightward cursor run never rewrites the row the model believes in',
  // `line + tail` must equal the grid row at every instant, however far behind the echo
  // is. That invariant does not depend on timing, which is what makes a disagreement
  // conclusive rather than flaky.
  //
  // This is the check that caught a shipped regression the other fifteen passed. The
  // engine adopted the tail starting at the PANE's cursor while sizing it to the room
  // the MODEL's cursor left. For inserted characters those two disagree by exactly the
  // un-echoed insertions, which is how far the standing content is about to be pushed
  // right, so the read is correct. For a cursor that walked right over content that
  // never moved, the same read is skewed left by the gap: the walked-over characters
  // get spliced into the tail and the row's last characters fall off the end.
  async run(rig) {
    const page = await rig.page(VIEWPORT);
    try {
      await page.keyboard.type(TAILMOVE_LINE, { delay: 6 });
      if (!(await quiet(page, 600, 12000))) inconclusive('the wire never settled after typing the line');
      await page.keyboard.press('Control+a');
      if (!(await quiet(page, 600, 8000))) inconclusive('the wire never settled after Home');

      const start = await probe(page);
      if (start.col > 20) {
        inconclusive(`Home never landed (cursor at column ${start.col}), so a rightward walk has nothing to walk over`);
      }

      let walking = true;
      let samples = 0;
      let trailing = 0;
      const disagreed: { model: string; grid: string; len: number; curCol: number }[] = [];

      const watch = (async () => {
        while (walking) {
          const s = await page.evaluate(() => {
            const p = window.__ehPredict;
            const b = p.burst;
            if (!b) return null;
            return {
              model: b.line + b.tail, grid: p.text(b.row), len: b.line.length,
              curCol: p.col, curRow: p.row, brow: b.row,
            };
          });
          if (s && s.grid !== null) {
            samples++;
            // The gap is what makes a sample interesting. With the echo caught up the
            // read is trivially correct, so a run that never trails proves nothing.
            if (s.curRow === s.brow && s.curCol < s.len) trailing++;
            if (s.model !== s.grid) {
              disagreed.push({ model: s.model, grid: s.grid, len: s.len, curCol: s.curCol });
            }
          }
          await Bun.sleep(6);
        }
      })();

      // Faster than the downlink, so the model runs several columns ahead of the echo.
      // The poller stops on every path: after a key throws it would keep reading a page
      // that is being closed, and its rejection would go unhandled.
      try {
        for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowRight', { delay: 8 });
      } finally {
        walking = false;
        watch.catch(() => undefined);
      }
      await watch;

      const worst = disagreed[0];
      if (worst) {
        log.dim(`    model |${worst.model.replace(/ +$/, '')}`);
        log.dim(`    grid  |${worst.grid.replace(/ +$/, '')}`);
        log.dim(`    cursor at ${worst.curCol}, model cursor at ${worst.len}, gap ${worst.len - worst.curCol}`);
      }
      // Failure outranks the skip. A disagreement is the engine modelling a row the pane
      // never held, and that is a defect whether or not the echo happened to be trailing
      // in the samples that caught it. Asking about `trailing` first files the one thing
      // this check exists to catch under "never reached the state it guards".
      assert(
        disagreed.length === 0,
        `${disagreed.length} of ${samples} samples had the model believing a row the pane never held`,
      );
      if (!trailing) inconclusive(`the echo never trailed across ${samples} samples, so the suspect read never ran`);
      return `${samples} samples, ${trailing} with the echo trailing, 0 disagreements`;
    } finally {
      await page.keyboard.press('Control+u').catch(() => undefined);
      await rig.closePage(page);
    }
  },
};

export const endreach: Check = {
  name: 'endreach',
  what: 'End predicts the true end of a line longer than the screen',
  // predictEnd walks right one column per step, so the count it hands predictMove is a
  // hard ceiling on how far the cursor can travel. A ceiling below the line's length
  // parks the prediction mid-line and lets the echo snap the cursor to the real end,
  // which is the stutter this engine exists to remove. It shipped that way at cols*4:
  // on a 66-column terminal a 464-character line predicted row 17 and echoed 20.
  //
  // The line is sized from the live terminal so the check overshoots that ceiling at
  // any width rather than at the one width it was written on.
  async run(rig) {
    const page = await rig.page(VIEWPORT);
    try {
      const cols = (await probe(page)).cols;
      // Leading # so zsh reads the whole thing as a comment and never runs it.
      const length = cols * 4 + 200;
      const text = '#' + 'abcdefghij'.repeat(Math.ceil(length / 10)).slice(0, length - 1);
      await page.keyboard.type(text, { delay: 0 });
      const typed = await settle(page, 20000);

      // Home rides the echo on an unproven wrapped zsh line, so let the grid land first.
      await page.keyboard.press('Control+a');
      await Bun.sleep(1500);
      const home = await settle(page, 10000);
      if (home.row === typed.row && home.col === typed.col) {
        inconclusive('Home never moved the cursor, so End was never asked to travel');
      }

      await page.keyboard.press('Control+e');
      // Read the prediction well before the echo can cross a link this slow.
      await Bun.sleep(40);
      const pred = await probe(page);
      if (!pred.burst) {
        inconclusive(
          'End produced no prediction and rode the echo. Right on screen, but the ceiling this guards is no longer observable',
        );
      }
      // The BURST's cursor, not the terminal's. `line.length` is where the model thinks
      // the cursor is; the terminal's own cursor has not been told anything yet at 40ms,
      // so reading it measures the echo rather than the prediction.
      const predRow = pred.burst.row;
      const predCol = pred.burst.line.length;

      await Bun.sleep(1500);
      const after = await settle(page, 10000);

      assert(
        predRow === after.row && predCol === after.col,
        `End parked at ${predRow}/${predCol} and the echo snapped the cursor to ${after.row}/${after.col}`,
      );
      return `predicted ${predRow}/${predCol} on a ${text.length}-character line spanning ${Math.ceil(text.length / cols)} rows`;
    } finally {
      await page.keyboard.press('Control+c').catch(() => undefined);
      await Bun.sleep(600);
      await rig.closePage(page);
    }
  },
};

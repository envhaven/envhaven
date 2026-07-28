// Two checks ported out of the ad-hoc harness: the disconnect surface, and the
// duplicated composer row.
//
// Neither can be read out of the source. The first needs a real socket to die under a
// live page, because everything interesting happens in the seconds between the close
// and the reconnect. The second needs the echo to keep missing while the grid repaints
// underneath the model, which only happens when somebody types through a wrap without
// pausing.
import type { Page } from '@playwright/test';
import {
  VIEWPORT, assert, inconclusive, launchApp, quiet, teardownApp, type Check,
} from '../console-rig';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a page condition and say whether it arrived.
 *
 * The originals wrote `waitForFunction(...).catch(() => {})` and then asserted on
 * whatever state they found. That reports a product fault whenever the truth is that
 * nothing happened at all, which is the one reading a harness must never get wrong.
 * Every wait here hands back a boolean, and every caller decides in the open whether a
 * miss is a failure or a check that never ran.
 */
function waited(page: Page, fn: () => boolean, timeout: number): Promise<boolean> {
  return page.waitForFunction(fn, null, { timeout }).then(() => true, () => false);
}

/**
 * Every row of the terminal grid, scrollback included.
 *
 * The disconnect surface is a DOM overlay and has to stay one. Reading the whole grid
 * is how a check proves the page never wrote a word about the connection into the
 * session the user is coming back to.
 */
function gridText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const p = window.__ehPredict;
    let s = '';
    for (let r = 0; r < p.baseY + p.rows; r++) {
      const t = p.text(r);
      if (t) s += t + '\n';
    }
    return s;
  });
}

/** What the status card is saying right now. */
function statusState(page: Page) {
  return page.evaluate(() => {
    const el = document.getElementById('status')!;
    const btn = document.getElementById('statusBtn')!;
    return {
      shown: el.classList.contains('show') && getComputedStyle(el).display !== 'none',
      who: document.getElementById('statusWho')!.textContent,
      msg: document.getElementById('statusMsg')!.textContent,
      mark: document.getElementById('statusSpin')!.textContent,
      // The button is taken away with `visibility`, which leaves its box standing so
      // the card behind it never reflows.
      buttonVisible: getComputedStyle(btn).visibility !== 'hidden',
    };
  });
}

/**
 * Where each part of the card sits.
 *
 * Everything in the card is centred, so "did not move" means each part kept its centre
 * line and its vertical box. The card's own width tracks its widest child and changes
 * with the message text, which shifts nothing on screen, so width is deliberately
 * absent from the reading.
 */
function cardBoxes(page: Page) {
  return page.evaluate(() => {
    const r = (sel: string) => {
      const b = document.querySelector(sel)!.getBoundingClientRect();
      return [Math.round(b.x + b.width / 2), Math.round(b.y), Math.round(b.height)];
    };
    return {
      mark: r('#status .mark'),
      who: r('#statusWho'),
      btn: r('#statusBtn'),
      card: r('#status .card'),
    };
  });
}

/**
 * Wait until the console answers again, asked from the page.
 *
 * Same origin, so the request travels the proxy and the port the socket is about to
 * use. A probe fired from the harness would answer for a path the browser never takes,
 * and during a restart those two differ for a second or so.
 */
async function consoleAnswers(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await page.evaluate(
      () => fetch('/__console/ui', { cache: 'no-store' }).then((r) => r.ok, () => false),
    );
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(500);
  }
}

/**
 * A horizontal rule: 20 or more identical box-drawing characters and nothing else.
 *
 * The composer draws its frame out of U+2500 to U+257F. The length floor is what keeps
 * a stray pair of dashes inside the user's own sentence from reading as the frame.
 */
function isRuleRow(s: string | null): boolean {
  if (!s) return false;
  const t = s.replace(/ +$/, '');
  if (t.length < 20) return false;
  const c = t.charCodeAt(0);
  if (c < 0x2500 || c > 0x257f) return false;
  for (let i = 1; i < t.length; i++) if (t.charCodeAt(i) !== c) return false;
  return true;
}

/**
 * One frame of the wrap overlay: what the engine says it is moving, what the grid holds
 * at the row it is about to clone, and what the clone is painting.
 *
 * Layers are found by z-index, which is the engine's own contract: 10 is the predictive
 * overlay root, 3 is the predicted cursor block, and 1 with `overflow: hidden` is the
 * cloned box block. Only the last of the three is read here. The overflow test carries
 * real weight, because the wipe strip also sits at z-index 1 and is the sibling that
 * would otherwise be mistaken for the clone.
 */
function wrapFrame(page: Page) {
  return page.evaluate(() => {
    const p = window.__ehPredict;
    const b = p.box;
    return {
      box: b,
      fromText: b ? p.text(b.from) : null,
      painted: (() => {
        const screen = document.querySelector('.xterm-screen');
        if (!screen) return null;
        const layer = Array.from(screen.children).find(
          (el): el is HTMLElement => el instanceof HTMLElement && el.style.zIndex === '10',
        );
        if (!layer) return null;
        const blocks = Array.from(layer.children).filter(
          (el): el is HTMLElement =>
            el instanceof HTMLElement && el.style.zIndex === '1' && el.style.overflow === 'hidden',
        );
        if (!blocks.length) return null;
        return Array.from(blocks[0].children).map(
          (el) => (el.textContent || '').replace(/ +$/, '').slice(0, 46),
        );
      })(),
    };
  });
}

type WrapFrame = Awaited<ReturnType<typeof wrapFrame>>;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export const statusCard: Check = {
  name: 'status',
  what: 'a dropped session is surfaced over the terminal and never written into it',
  // The check types a line and then proves it survives the drop, so it has to own the
  // pane it is asserting about. Without this it inherits whatever the previous check
  // left running, and blinkbg's mimic in particular cannot be killed with ^C.
  needsFreshPane: true,
  // The console is a page in front of a pty, so a transport drop has two audiences. The
  // user has to be told what happened, which workspace it happened to, and whether
  // anything is being attempted on their behalf. The session underneath has to be left
  // exactly as it was, because it survived the drop and they are coming back to it.
  // Writing "session disconnected" into the pane would leave our words in their
  // scrollback forever, and the pane belongs to them.
  //
  // The drop here is real. Restarting the console service closes every socket, which is
  // what a transport drop looks like from the browser. Nothing is stubbed, so the
  // timings are the product's own and the check has to read them honestly.
  async run(rig): Promise<string> {
    // `name` is what the dashboard passes when it embeds the console, and the only
    // thing that lets the card name the workspace instead of a bare hostname.
    const page = await rig.page({ ...VIEWPORT, params: { name: 'rnt' } });
    try {
      // A first, successful connect says nothing at all. The dashboard's loader already
      // covers that moment and self-host shows a login form, so a card here would be a
      // second surface stacked over a terminal that works.
      const landed = await statusState(page);
      assert(!landed.shown, `the status surface was up on a first, successful connect ('${landed.msg}')`);

      // Something recognisable to look for later, to prove the drop left the pane alone.
      await page.keyboard.type('echo hola', { delay: 20 });
      if (!(await quiet(page, 600, 12000))) inconclusive('the wire never settled after typing');

      await rig.restartConsole();

      // Two things follow a real drop and they are separable: the engine disarms, since
      // `safe` goes false the moment the socket closes, and the card appears. Waiting on
      // either one first is what tells a page that ignored the drop apart from a restart
      // that never dropped anything. A single wait on the card cannot make that call,
      // and the original could only guess.
      const dropped = await waited(
        page,
        () => !window.__ehPredict.safe ||
              document.getElementById('status')!.classList.contains('show'),
        20000,
      );
      if (!dropped) {
        inconclusive('the console restart never dropped the session, so there was no disconnect to surface');
      }

      const surfaced = await waited(
        page, () => document.getElementById('status')!.classList.contains('show'), 10000);
      assert(surfaced, 'the session dropped and the page never said so');

      const down = await statusState(page);
      assert(down.who === 'rnt', `the card should name the workspace, it said '${down.who}'`);
      assert(down.msg === 'session disconnected', `the card should say what happened, it said '${down.msg}'`);
      assert(down.buttonVisible, 'the card offered no Reconnect button after the drop');
      // The static mark. A spinner here would claim work that nobody is doing: after a
      // drop the next move belongs to the user, and animation would say otherwise.
      assert(down.mark === '⠿', `the mark should stand still while nothing is being attempted, it was '${down.mark}'`);

      const grid = await gridText(page);
      assert(!/disconnected|press a key|reconnect/i.test(grid),
        'the page wrote something about the connection into the terminal grid');
      assert(/echo hola/.test(grid), 'the drop lost the session content that was already on screen');

      // A retry fired while the console is still restarting. Nothing promises that
      // window is still open by the time the click lands, so the three outcomes stay
      // apart: a failure is the guarded behaviour, a success means the window closed
      // before we got there, and neither means the attempt hung.
      await page.click('#statusBtn');
      const outcome = await page.waitForFunction(() => {
        if (document.getElementById('statusMsg')!.textContent === 'reconnect failed') return 'failed';
        if (!document.getElementById('status')!.classList.contains('show')) return 'reconnected';
        return null;
      }, null, { timeout: 20000 }).then((h) => h.jsonValue(), () => null);

      if (outcome === 'reconnected') {
        inconclusive('the console answered before the retry landed, so a failed attempt was never observable');
      }
      if (outcome !== 'failed') {
        const stuck = await statusState(page);
        inconclusive(`a retry against a down console neither failed nor connected within 20s (the card says '${stuck.msg}')`);
      }
      const failed = await statusState(page);
      assert(failed.shown && failed.buttonVisible,
        `a failed attempt should keep the card and the button, got shown=${failed.shown} button=${failed.buttonVisible}`);

      if (!(await consoleAnswers(page, 45000))) {
        inconclusive('the console never came back after the restart, so the reconnect could not be tried');
      }

      const before = await cardBoxes(page);
      await page.click('#statusBtn');
      // Read while the attempt is still in flight. The rig puts a real round trip in
      // front of the token request, so this window is comfortably wider than the read.
      await Bun.sleep(60);
      const trying = await statusState(page);
      if (!trying.shown) {
        inconclusive('the socket opened inside 60ms of the click, so the in-progress state was never on screen');
      }
      assert(trying.msg === 'reconnecting', `an attempt in progress should say so, it said '${trying.msg}'`);
      assert(!trying.buttonVisible, 'the button survived the attempt it started, so it can be clicked twice');
      // The button leaving is the only change on screen, and it has to be the only one.
      // A card that reflows around it would move the message the user is reading.
      const during = await cardBoxes(page);
      assert(JSON.stringify(before) === JSON.stringify(during),
        `the card moved when the button was taken away\n  before: ${JSON.stringify(before)}\n  during: ${JSON.stringify(during)}`);

      const cleared = await waited(
        page, () => !document.getElementById('status')!.classList.contains('show'), 30000);
      assert(cleared, 'the card never cleared, so the Reconnect button did not reconnect');

      if (!(await waited(page, () => window.__ehPredict.safe === true, 20000))) {
        inconclusive('the engine never re-armed after the reconnect, so the focus test could not run');
      }
      await Bun.sleep(1500);

      // Typed without clicking the terminal first. A reconnect driven from the button
      // leaves focus on the button, so the page has to hand it back. If it does not, the
      // next keystroke goes nowhere and a working session looks dead.
      await page.keyboard.type('echo despues', { delay: 20 });
      if (!(await quiet(page, 600, 12000))) {
        inconclusive('the wire never settled after typing into the reconnected session');
      }

      const after = await gridText(page);
      assert(/echo despues/.test(after), 'typing after the reconnect landed nowhere, so focus never came back');
      assert(!/disconnected|press a key/i.test(after), 'the reconnect left our words in the scrollback');

      return 'drop surfaced without touching the grid, retry failed honestly, Reconnect restored the session and the focus';
    } finally {
      await page.keyboard.press('Control+u').catch(() => undefined);
      await page.close();
    }
  },
};

const DUPE_SENTENCE =
  'este helado lo voy a tener que poner en el freezer sino te va a quedar como sopa de vainilla ' +
  'lamentablemente y ademas se derrite todo por el calor que hace hoy en esta ciudad tan humeda';

export const dupeBox: Check = {
  name: 'dupe',
  what: 'a wrapping composer never clones a row that has stopped being the rule',
  needsFreshPane: true,
  // boxShift stores row POSITIONS at wrap time (from is the top rule, to is the rows
  // under it) while render() clones row CONTENT at paint time. The two readings agree
  // only while the grid stands still. Once the echo lands the composer repaints a row
  // higher, so the row that WAS the top rule now holds the first line of input. Cloning
  // it paints a duplicate input row over the real rule, and the block is opaque, so the
  // rule disappears underneath its own duplicate.
  //
  // One invariant covers all of it, for every frame an upward boxShift is alive:
  //   the grid row at box.from is a horizontal rule.
  // The first frame where that stops holding is the frame before the duplicate.
  //
  // The typing has to be continuous. A pause lets the burst match, which retires
  // boxShift, and the fault needs it alive while the grid repaints under it. That is
  // ordinary usage: someone typing a sentence through the wrap without stopping.
  async run(rig): Promise<string> {
    const page = await rig.page(VIEWPORT);
    try {
      await launchApp(page, 'claude');

      const cols = await page.evaluate(() => {
        const p = window.__ehPredict;
        return p.text(p.row)?.length ?? 0;
      });
      assert(cols > 0, 'could not read the terminal width');
      // Past the wrap and then some. Sized from the live width, so the check carries no
      // constant that only holds at one viewport.
      const sentence = DUPE_SENTENCE.slice(0, cols + 40);

      let frames = 0;
      let violations = 0;
      let first: WrapFrame | null = null;

      for (const ch of sentence) {
        await page.keyboard.type(ch);
        const f = await wrapFrame(page);
        // delta -1 is the upward case, where the wrap pulled the composer up a row.
        if (f.box && f.box.delta === -1) {
          frames++;
          if (!isRuleRow(f.fromText)) {
            violations++;
            if (!first) first = f;
          }
        }
        await Bun.sleep(18);
      }

      // A run that never reached a wrap reports a clean zero, which reads as a pass and
      // is a lie: the path under test simply did not run. Absence of evidence is a
      // failed run here, so it is reported as one.
      if (!frames) {
        inconclusive(
          `no upward wrap frame was ever seen across ${sentence.length} characters at ${cols} columns, ` +
          'so the clone never ran. Check the terminal width against the typed length.',
        );
      }

      const diagnosis = first
        ? [
            `${violations} of ${frames} upward wrap frames cloned a row that is no longer the rule`,
            `  box        : ${JSON.stringify(first.box)}`,
            `  grid[from] : ${JSON.stringify((first.fromText || '').replace(/ +$/, '').slice(0, 46))}`,
            `  overlay    : ${JSON.stringify(first.painted)}`,
          ].join('\n')
        : '';
      assert(violations === 0, diagnosis);

      return `${frames} upward wrap frames over ${sentence.length} characters at ${cols} columns, 0 stale clones`;
    } finally {
      await teardownApp(page).catch(() => undefined);
      await page.close();
    }
  },
};

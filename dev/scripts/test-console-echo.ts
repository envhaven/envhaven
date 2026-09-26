#!/usr/bin/env bun
// End-to-end checks for the console's predictive echo.
//
// console/ui/assets/eh-predictor.js paints a keystroke before the server has echoed it, then
// reconciles that guess against the real grid as the bytes arrive. Everything about
// it is a race, so nothing about it can be checked by reading the source: the engine
// has to be run against a real terminal over a link slow enough for the prediction
// to be visible, and asked what it believes while it is still wrong.
//
//   bun dev/scripts/test-console-echo.ts                    # every check
//   bun dev/scripts/test-console-echo.ts tailmove wrapkeep  # named checks only
//   bun dev/scripts/test-console-echo.ts --container=envhaven-test --password=test
//
// Requires a running workspace container with a console password set:
// `bun dev/scripts/start.ts`. The mimic applications in dev/fixtures are copied in
// automatically. Browser comes from `cd dev && bunx playwright install chromium`.
//
// A check reports one of three things, and the difference between the last two is
// the whole reason this file is not a pile of booleans:
//   pass    the guarded behaviour held
//   fail    the guarded behaviour broke
//   skip    the check never reached the state it guards, so it proved nothing
// Skips exit non-zero. A guard that did not run is not a guard.
import { loadConfig, log, isContainerRunning } from './lib';
import { rosterDrift } from './lib/console-apps';
import { ConsoleRig, Inconclusive, type Check } from './lib/console-rig';
import { retryCleanup, retryableCleanup } from './lib/console-proxy';
import { tailmove, midline, endreach } from './lib/console-checks/cursor';
import { clonecolor, wrapseed, boxrise, boxfall } from './lib/console-checks/clone';
import { seedwrap, wrapkeep } from './lib/console-checks/wrap';
import { dupeBox, reconnectInput, statusCard } from './lib/console-checks/status';
import { ghostcover, staletail } from './lib/console-checks/ghost';
import { boxbgMimic, boxbgInverse, boxbgClaude, blinkbg, cursorGhost, draftink } from './lib/console-checks/paint';
import {
  keysTyping, keysChords, keysMacChords, keysNav, keysEditing, keysGate, keysLearning, keysComposer, paneBounds,
} from './lib/console-checks/keys';
import {
  keysEditingComposer, keysWords, keysGhost, keysTrailing, keysStorm, keysReflow,
} from './lib/console-checks/composers';

// Ordered by what each one costs and what it leaves behind. The cheap state checks
// come first so a broken engine is reported in a minute rather than in twenty. The
// final checks are last for a reason: blinkbg drives a mimic that cannot be killed
// with ^C, pane-bounds changes the tmux layout, and the transport checks restart the
// console service under a live page.
const CHECKS: Check[] = [
  tailmove,
  midline,
  cursorGhost,
  endreach,
  keysTyping,
  keysChords,
  keysMacChords,
  keysNav,
  keysEditing,
  keysGate,
  keysLearning,
  keysComposer,
  keysEditingComposer,
  keysReflow,
  keysWords,
  keysGhost,
  keysTrailing,
  keysStorm,
  clonecolor,
  wrapseed,
  boxrise,
  boxfall,
  seedwrap,
  wrapkeep,
  dupeBox,
  ghostcover,
  staletail,
  draftink,
  boxbgMimic,
  boxbgInverse,
  boxbgClaude,
  blinkbg,
  paneBounds,
  reconnectInput,
  statusCard,
];

const config = loadConfig();
const args = process.argv.slice(2);
// slice, not split('=')[1]: a console password is allowed to contain '='.
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
// A typo'd latency would otherwise reach the proxy as the string "NaN", kill it on
// int(), and surface fifteen seconds later as "latency proxy never reached ...".
const millis = (name: string, fallback: number) => {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    log.error(`--${name} takes a number of milliseconds, got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return value;
};
const container = flag('container') ?? config.containerName;
const password = flag('password') ?? config.password;
const downMs = millis('down', 120);
const upMs = millis('up', 30);
const named = args.filter((a) => !a.startsWith('--'));

log.header('Console predictive echo');

if (!(await isContainerRunning(container))) {
  log.error(`Container '${container}' not running`);
  log.info('Start it with: bun dev/scripts/start.ts');
  process.exit(1);
}

const unknown = named.filter((n) => !CHECKS.some((c) => c.name === n));
if (unknown.length) {
  log.error(`No such check: ${unknown.join(', ')}`);
  log.info(`Available: ${CHECKS.map((c) => c.name).join(', ')}`);
  process.exit(1);
}
const selected = named.length ? CHECKS.filter((c) => named.includes(c.name)) : CHECKS;

log.info(`Container: ${container}`);
// A tool is registered once, on its row in lib/console-apps.ts, and each check derives
// its roster from that row. What can still drift is the row against the model: a seeded
// app whose wrap table row was deleted, or a word rule the checks never drive. This is the
// one place that notices, before a run that would print green without ever touching the
// app. test-console-ui.ts asks the same question in CI, with no container.
{
  const drift = rosterDrift();
  if (drift.length) {
    log.error(`console-apps.ts and the model disagree: ${drift.join('; ')}`);
    process.exit(1);
  }
}

// A signal may land while the proxy and browser are still opening. Cleanup waits for
// that attempt, shares concurrent callers, and retries failed owned-resource disposal.
const rigPromise = ConsoleRig.open({ container, password, downMs, upMs });
let cleanupPromise: Promise<void> | null = null;
const closeRig = retryableCleanup(() => rigPromise.then((active) => active.close(), () => undefined));
function cleanup(): Promise<void> {
  cleanupPromise ??= retryCleanup(closeRig).finally(() => { cleanupPromise = null; });
  return cleanupPromise;
}
// The first signal owns the rest of the run: it cleans up and exits with its own code. The
// check loop stops at the next check, because another one would restart the console or
// kill tmux under that cleanup, and then waits on the same exit rather than print a
// summary of a run that never finished.
let stopping: Promise<void> | null = null;
function exitAfterCleanup(code: number): void {
  stopping ??= cleanup()
    .catch((error) => log.error(`Console cleanup failed: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => process.exit(code));
}
process.on('SIGINT', () => exitAfterCleanup(130));
process.on('SIGTERM', () => exitAfterCleanup(143));

const rig = await rigPromise;

let passed = 0;
let failed = 0;
let skipped = 0;

try {
  for (const check of selected) {
    if (stopping) break;
    log.newline();
    log.info(`${check.name}: ${check.what}`);
    if (check.needsFreshPane) await rig.resetPane();

    const mark = rig.pageErrorCount();
    let outcome: { kind: 'pass' | 'fail' | 'skip'; message: string };
    try {
      outcome = { kind: 'pass', message: await check.run(rig) };
    } catch (e) {
      outcome = e instanceof Inconclusive
        ? { kind: 'skip', message: e.message }
        : { kind: 'fail', message: e instanceof Error ? e.message : String(e) };
    }
    // An exception out of the engine outranks whatever the check concluded, because a
    // check that passed while the page was throwing did not pass. Stated once and
    // applied to every outcome, rather than repeated in each arm where the two copies
    // can drift.
    const [engineError] = rig.pageErrorsSince(mark);
    if (engineError) outcome = { kind: 'fail', message: `the engine threw — ${engineError}` };

    if (outcome.kind === 'pass') {
      log.success(`${check.name}: ${outcome.message}`);
      passed++;
    } else if (outcome.kind === 'skip') {
      log.warn(`${check.name}: SKIPPED — ${outcome.message}`);
      skipped++;
    } else {
      log.error(`${check.name}: ${outcome.message}`);
      failed++;
    }
  }
} finally {
  await (stopping ?? cleanup());
}

log.newline();
log.header('Summary');
log.plain(`Passed:  ${passed}`);
log.plain(`Failed:  ${failed}`);
log.plain(`Skipped: ${skipped}`);
log.newline();

if (failed === 0 && skipped === 0) {
  log.success(`All ${passed} checks passed`);
} else if (failed) {
  log.error(`${failed} check(s) failed`);
} else {
  log.warn(`${skipped} check(s) never reached the state they guard`);
}
process.exit(failed === 0 && skipped === 0 ? 0 : 1);

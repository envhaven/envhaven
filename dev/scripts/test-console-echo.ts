#!/usr/bin/env bun
// End-to-end checks for the console's predictive echo.
//
// console/ui/terminal.html paints a keystroke before the server has echoed it, then
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
import { ConsoleRig, Inconclusive, type Check } from './lib/console-rig';
import { tailmove, endreach } from './lib/console-checks/cursor';
import { clonecolor, wrapseed, boxrise } from './lib/console-checks/clone';
import { seedwrap, wrapkeep } from './lib/console-checks/wrap';
import { dupeBox, statusCard } from './lib/console-checks/status';
import { ghostcover, staletail } from './lib/console-checks/ghost';
import { boxbgMimic, boxbgInverse, boxbgClaude, blinkbg } from './lib/console-checks/paint';
import {
  keysTyping, keysChords, keysMacChords, keysNav, keysEditing, keysGate,
  keysLearning, keysComposer,
} from './lib/console-checks/keys';

// Ordered by what each one costs and what it leaves behind. The cheap state checks
// come first so a broken engine is reported in a minute rather than in twenty. The
// two at the end are last for a reason: blinkbg drives a mimic that cannot be killed
// with ^C, and the status check restarts the console service under a live page.
const CHECKS: Check[] = [
  tailmove,
  endreach,
  keysTyping,
  keysChords,
  keysMacChords,
  keysNav,
  keysEditing,
  keysGate,
  keysLearning,
  keysComposer,
  clonecolor,
  wrapseed,
  boxrise,
  seedwrap,
  wrapkeep,
  dupeBox,
  ghostcover,
  staletail,
  boxbgMimic,
  boxbgInverse,
  boxbgClaude,
  blinkbg,
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
const rig = await ConsoleRig.open({ container, password, downMs, upMs });

let passed = 0;
let failed = 0;
let skipped = 0;

try {
  for (const check of selected) {
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
  await rig.close();
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

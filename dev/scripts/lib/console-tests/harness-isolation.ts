import { APPS, appCommand } from '../console-apps';
import {
  CONSOLE_FIXTURE_MODE,
  CONSOLE_FIXTURE_USER,
  consoleFixturePath,
  OwnedCleanups,
  retryCleanup,
  retryableCleanup,
} from '../console-proxy';
import type { TestReporter } from './types';

export async function runHarnessIsolationTests(report: TestReporter): Promise<void> {
  const { pass, fail } = report;

  try {
    let attempts = 0;
    const attemptCount = () => attempts;
    const cleanup = retryableCleanup(async () => {
      attempts++;
      if (attempts === 1) throw new Error('first disposal failed');
    });
    const first = cleanup();
    const concurrent = cleanup();
    if (first !== concurrent) throw new Error('concurrent callers did not share one disposal');
    const initial = await Promise.allSettled([first, concurrent]);
    if (initial.some((result) => result.status !== 'rejected') || attemptCount() !== 1) {
      throw new Error(`first disposal ran ${attempts} times or did not reject for both callers`);
    }
    await cleanup();
    await cleanup();
    if (attemptCount() !== 2) {
      throw new Error(`successful disposal was not remembered (${attempts} attempts)`);
    }
    let boundedAttempts = 0;
    await retryCleanup(async () => {
      boundedAttempts++;
      if (boundedAttempts < 3) throw new Error('retry me');
    });
    if (boundedAttempts !== 3) {
      throw new Error(`bounded cleanup stopped after ${boundedAttempts} attempts`);
    }
    pass('Cleanup shares in-flight work, retries rejection and remembers success');
  } catch (error) {
    fail(`Retryable cleanup contract failed: ${(error as Error).message}`);
  }

  try {
    const owned = new OwnedCleanups<string>('owned context cleanup failed');
    let finish!: () => void;
    let started = false;
    owned.add('awaited', () => {
      started = true;
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const waiting = owned.close('awaited');
    await Promise.resolve();
    if (!started || owned.size() !== 1) throw new Error('ownership ended before disposal resolved');
    finish();
    await waiting;
    if (owned.size() !== 0) throw new Error('successful disposal remained owned');

    let attempts = 0;
    owned.add('retryable', async () => {
      if (++attempts === 1) throw new Error('context close failed');
    });
    let reported = false;
    try {
      await owned.closeAll();
    } catch (error) {
      reported = error instanceof AggregateError;
    }
    if (!reported || owned.size() !== 1) throw new Error('failed disposal was hidden or released');
    await owned.closeAll();
    if (attempts !== 2 || owned.size() !== 0) {
      throw new Error('failed disposal was not retryable');
    }
    pass('Owned contexts stay live until awaited disposal succeeds and report retryable failures');
  } catch (error) {
    fail(`Owned cleanup contract failed: ${(error as Error).message}`);
  }

  try {
    const runId = 'ab-mmmmmmmm-0123456789ab';
    const path = consoleFixturePath(runId);
    const command = appCommand(APPS.composer, path);
    if (path !== `/tmp/eh-fixtures-${runId}` ||
        !command.includes(`${path}/composer.py`) ||
        command.includes('__ENVHAVEN_CONSOLE_FIXTURES__')) {
      throw new Error(`mimic command did not resolve to ${path}`);
    }
    if (appCommand(APPS.claude, path) !== APPS.claude.command) {
      throw new Error('ordinary command changed');
    }
    let pathRejected = false;
    let commandRejected = false;
    try { consoleFixturePath('shared'); } catch { pathRejected = true; }
    try { appCommand(APPS.composer, '/tmp/eh-fixtures'); } catch { commandRejected = true; }
    if (!pathRejected || !commandRejected) throw new Error('shared fixture directory was accepted');
    if (CONSOLE_FIXTURE_USER !== 'abc' || CONSOLE_FIXTURE_MODE !== '700') {
      throw new Error(`fixtures use ${CONSOLE_FIXTURE_USER}:${CONSOLE_FIXTURE_MODE}, want abc:700`);
    }
    pass('Mimics require the canonical private, shell-owned run-scoped fixture directory');
  } catch (error) {
    fail(`Run-scoped fixture contract failed: ${(error as Error).message}`);
  }
}

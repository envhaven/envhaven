#!/usr/bin/env bun
// Static console gate. Browser integration remains in test-console-echo.ts.
import { formatTestSummary, log } from './lib';
import { runAssetManifestTests } from './lib/console-tests/asset-manifest';
import { runHarnessIsolationTests } from './lib/console-tests/harness-isolation';
import { runModelFixtureTests } from './lib/console-tests/model-fixtures';
import { runPredictorRuntimeTests } from './lib/console-tests/predictor-runtime';
import { runReflowTests } from './lib/console-tests/reflow';
import type { TestReporter } from './lib/console-tests/types';

let passed = 0;
let failed = 0;
const report: TestReporter = {
  pass(message) { log.success(message); passed++; },
  fail(message) { log.error(message); failed++; },
};

log.header('Console asset and manifest contracts');
runAssetManifestTests(report);
log.header('Console model fixtures');
runModelFixtureTests(report);
log.header('Predictor transitions and browser runtime');
runPredictorRuntimeTests(report);
runReflowTests(report);
log.header('Console harness cleanup and isolation');
await runHarnessIsolationTests(report);

formatTestSummary(passed, failed);
process.exit(failed === 0 ? 0 : 1);

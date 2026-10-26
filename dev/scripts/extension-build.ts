#!/usr/bin/env bun
import { $ } from 'bun';
import { existsSync } from 'fs';
import { join } from 'path';
import { EXTENSION_DIR, WEBVIEW_DIR, log, runStep } from './lib';

const webviewOnly = process.argv.includes('--webview-only');
const hostOnly = process.argv.includes('--host-only');

// Each install and build runs as a step, so a failure names it with what its command printed.
let depsReady = true;

if (!existsSync(join(EXTENSION_DIR, 'node_modules'))) {
  depsReady = await runStep('Installing extension dependencies', () =>
    $`bun install --frozen-lockfile`.cwd(EXTENSION_DIR).quiet()
  );
}

if (depsReady && !hostOnly && !existsSync(join(WEBVIEW_DIR, 'node_modules'))) {
  depsReady = await runStep('Installing webview dependencies', () =>
    $`bun install --frozen-lockfile`.cwd(WEBVIEW_DIR).quiet()
  );
}

if (!depsReady) {
  process.exit(1);
}

// Both builds run when both are asked for, so one pass reports each failure.
let success = true;

if (!webviewOnly) {
  success = await runStep('Building extension host', () => $`bun run build`.cwd(EXTENSION_DIR).quiet()) && success;
}

if (!hostOnly) {
  success = await runStep('Building webview', () => $`bun run build`.cwd(WEBVIEW_DIR).quiet()) && success;
}

if (success) {
  log.success('Extension build complete');
  process.exit(0);
} else {
  log.error('Extension build failed');
  process.exit(1);
}

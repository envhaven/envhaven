#!/usr/bin/env bun
import { $ } from 'bun';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { EXTENSION_DIR, WEBVIEW_DIR, log, formatTestSummary } from './lib';

let passed = 0;
let failed = 0;

function pass(msg: string) {
  log.success(msg);
  passed++;
}

function fail(msg: string) {
  log.error(msg);
  failed++;
}

log.header('Cleaning previous builds');
rmSync(join(EXTENSION_DIR, 'dist'), { recursive: true, force: true });
rmSync(join(WEBVIEW_DIR, 'build'), { recursive: true, force: true });
rmSync(join(EXTENSION_DIR, 'envhaven.vsix'), { force: true });
pass('Cleaned dist/, webview/build/, and envhaven.vsix');

log.header('Installing dependencies');
try {
  await $`bun install --frozen-lockfile`.cwd(EXTENSION_DIR).quiet();
  pass('Extension dependencies installed');
} catch {
  try {
    await $`bun install`.cwd(EXTENSION_DIR).quiet();
    pass('Extension dependencies installed');
  } catch {
    fail('Extension dependencies failed to install');
  }
}

try {
  await $`bun install --frozen-lockfile`.cwd(WEBVIEW_DIR).quiet();
  pass('Webview dependencies installed');
} catch {
  try {
    await $`bun install`.cwd(WEBVIEW_DIR).quiet();
    pass('Webview dependencies installed');
  } catch {
    fail('Webview dependencies failed to install');
  }
}

log.header('Type checking extension host');
// esbuild bundles without type-checking, so this is the only gate for src/.
try {
  await $`bun run typecheck`.cwd(EXTENSION_DIR);
  pass('Extension src type-checks (tsc --noEmit)');
} catch {
  fail('Extension src has type errors (tsc --noEmit)');
}

log.header('Running extension unit tests');
try {
  await $`bun test`.cwd(EXTENSION_DIR);
  pass('Extension unit tests passed');
} catch {
  fail('Extension unit tests failed');
}

log.header('Building extension host');
try {
  await $`bun run build`.cwd(EXTENSION_DIR);
  pass('Extension host built successfully');
} catch {
  fail('Extension host build failed');
}

if (existsSync(join(EXTENSION_DIR, 'dist/extension.js'))) {
  const stat = Bun.file(join(EXTENSION_DIR, 'dist/extension.js'));
  pass(`dist/extension.js exists (${stat.size} bytes)`);
} else {
  fail('dist/extension.js not found');
}

const sourcemaps = await Array.fromAsync(new Bun.Glob('*.map').scan(join(EXTENSION_DIR, 'dist')));
if (sourcemaps.length > 0) {
  fail('Sourcemap files found in dist/ (should not exist in production)');
} else {
  pass('No sourcemap files in dist/');
}

log.header('Building webview');
try {
  await $`bun run build`.cwd(WEBVIEW_DIR);
  pass('Webview built successfully');
} catch {
  fail('Webview build failed');
}

if (existsSync(join(WEBVIEW_DIR, 'build/assets/index.js'))) {
  const stat = Bun.file(join(WEBVIEW_DIR, 'build/assets/index.js'));
  pass(`webview/build/assets/index.js exists (${stat.size} bytes)`);
} else {
  fail('webview/build/assets/index.js not found');
}

if (existsSync(join(WEBVIEW_DIR, 'build/assets/index.css'))) {
  const stat = Bun.file(join(WEBVIEW_DIR, 'build/assets/index.css'));
  pass(`webview/build/assets/index.css exists (${stat.size} bytes)`);
} else {
  fail('webview/build/assets/index.css not found');
}

if (existsSync(join(WEBVIEW_DIR, 'build/index.html'))) {
  fail('webview/build/index.html exists (should be excluded)');
} else {
  pass('webview/build/index.html correctly excluded');
}

log.header('Packaging extension');
try {
  await $`bunx vsce package --out envhaven.vsix`.cwd(EXTENSION_DIR);
  pass('Extension packaged successfully');
} catch {
  fail('Extension packaging failed');
}

if (existsSync(join(EXTENSION_DIR, 'envhaven.vsix'))) {
  const stat = Bun.file(join(EXTENSION_DIR, 'envhaven.vsix'));
  if (stat.size > 50000) {
    pass(`envhaven.vsix exists (${stat.size} bytes)`);
  } else {
    fail(`envhaven.vsix too small (${stat.size} bytes) - likely missing files`);
  }
} else {
  fail('envhaven.vsix not found');
}

log.header('Verifying VSIX contents');
let vsixContents = '';
try {
  const result = await $`unzip -l ${join(EXTENSION_DIR, 'envhaven.vsix')}`.quiet();
  vsixContents = result.text();
} catch {}

function checkVsixFile(path: string) {
  if (vsixContents.includes(path)) {
    pass(`VSIX contains ${path}`);
  } else {
    fail(`VSIX missing ${path}`);
  }
}

function checkVsixNotFile(path: string) {
  if (vsixContents.includes(path)) {
    fail(`VSIX should not contain ${path}`);
  } else {
    pass(`VSIX correctly excludes ${path}`);
  }
}

checkVsixFile('extension/package.json');
checkVsixFile('extension/dist/extension.js');
checkVsixFile('extension/webview/build/assets/index.js');
checkVsixFile('extension/webview/build/assets/index.css');

checkVsixNotFile('extension/src/');
checkVsixNotFile('extension/webview/src/');
checkVsixNotFile('extension/node_modules/');
checkVsixNotFile('extension/webview/node_modules/');
checkVsixNotFile('.map');

formatTestSummary(passed, failed);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env bun
import { $ } from 'bun';
import { existsSync } from 'fs';
import { join } from 'path';
import { EXTENSION_DIR, WEBVIEW_DIR, log } from './lib';

const webviewOnly = process.argv.includes('--webview-only');
const hostOnly = process.argv.includes('--host-only');

async function installDeps(): Promise<boolean> {
  if (!existsSync(join(EXTENSION_DIR, 'node_modules'))) {
    log.info('Installing extension dependencies...');
    try {
      await $`bun install --frozen-lockfile`.cwd(EXTENSION_DIR).quiet();
    } catch {
      log.error('Failed to install extension dependencies');
      return false;
    }
  }
  
  if (!hostOnly && !existsSync(join(WEBVIEW_DIR, 'node_modules'))) {
    log.info('Installing webview dependencies...');
    try {
      await $`bun install --frozen-lockfile`.cwd(WEBVIEW_DIR).quiet();
    } catch {
      log.error('Failed to install webview dependencies');
      return false;
    }
  }
  
  return true;
}

async function buildHost(): Promise<boolean> {
  log.info('Building extension host...');
  try {
    await $`bun run build`.cwd(EXTENSION_DIR).quiet();
    log.success('Extension host built');
    return true;
  } catch {
    log.error('Extension host build failed');
    return false;
  }
}

async function buildWebview(): Promise<boolean> {
  log.info('Building webview...');
  try {
    await $`bun run build`.cwd(WEBVIEW_DIR).quiet();
    log.success('Webview built');
    return true;
  } catch {
    log.error('Webview build failed');
    return false;
  }
}

if (!await installDeps()) {
  process.exit(1);
}

let success = true;

if (!webviewOnly) {
  success = await buildHost() && success;
}

if (!hostOnly) {
  success = await buildWebview() && success;
}

if (success) {
  log.success('Extension build complete');
  process.exit(0);
} else {
  log.error('Extension build failed');
  process.exit(1);
}

#!/usr/bin/env bun
import { $ } from 'bun';
import { join } from 'path';
import { loadConfig, log, runStep, isContainerRunning, EXTENSION_DIR } from './lib';

const config = loadConfig();

if (!await isContainerRunning(config.containerName)) {
  log.error(`Container '${config.containerName}' is not running`);
  process.exit(1);
}

// Packaged on this side with the command test-extension.ts runs, then copied into the container,
// so nothing is mounted. vsce 4 refuses to package without --no-dependencies (esbuild already
// bundled every runtime import into dist/).
const vsix = join(EXTENSION_DIR, 'envhaven.vsix');
const target = '/tmp/envhaven.vsix';

// One step at a time, stopping at the first that fails, which runStep names with its reason.
const installed =
  await runStep('Packaging the extension', () =>
    $`bunx --no-install --package @vscode/vsce vsce package --no-dependencies --out ${vsix}`.cwd(EXTENSION_DIR).quiet()
  ) &&
  await runStep('Copying it into the container', () =>
    $`docker cp ${vsix} ${config.containerName}:${target}`.quiet()
  ) &&
  // As abc with its environment: the extension belongs in abc's extensions directory.
  await runStep('Installing it as abc', () =>
    $`docker exec ${config.containerName} /usr/local/lib/envhaven/as-abc /app/code-server/bin/code-server --extensions-dir /config/extensions --install-extension ${target} --force`.quiet()
  );

if (!installed) process.exit(1);
log.success('Extension installed');

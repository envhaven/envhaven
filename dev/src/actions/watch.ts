import { spawn, $ } from 'bun';
import { join } from 'path';
import { readdirSync, statSync, existsSync } from 'fs';
import type { Config } from '../lib/config';
import { REPO_ROOT, DEV_ROOT } from '../lib/config';
import { getContainerStatus } from '../lib/docker';
import { runContainer } from './run';

type AddLog = (type: 'info' | 'success' | 'error' | 'warn' | 'command' | 'dim', text: string) => void;
type SetProcess = (proc: { kill: () => void } | null) => void;

const EXTENSION_DIR = join(REPO_ROOT, 'extension');
const WEBVIEW_DIR = join(EXTENSION_DIR, 'webview');

// Any running test container will do: extension-install.ts packages the extension on this side
// and copies it in, so nothing is mounted and a running container is left as it is. Without
// one, the container starts the way the Start action starts it.
async function ensureContainer(
  config: Config,
  addLog: AddLog,
  refreshStatus: () => Promise<void>
): Promise<boolean> {
  if (await getContainerStatus(config.containerName) === 'running') {
    addLog('success', 'Container running');
    return true;
  }

  await runContainer(addLog, refreshStatus);
  if (await getContainerStatus(config.containerName) === 'running') return true;

  addLog('error', 'Container failed to start');
  return false;
}

// Runs a dev script quietly. extension-build.ts and extension-install.ts write each failed step
// and what its command printed to stderr, so a failure shows those lines instead of a bare
// "failed".
async function runDevScript(script: string, args: string[], addLog: AddLog): Promise<boolean> {
  const result = await $`bun ${join(DEV_ROOT, 'scripts', script)} ${args}`.quiet().nothrow();
  if (result.exitCode === 0) return true;

  const output = result.stderr.toString().trim() || `${script} failed (exit code ${result.exitCode})`;
  for (const line of output.split('\n')) {
    if (line.trim()) addLog('error', line.replace(/^✗ /, ''));
  }
  return false;
}

const runExtensionBuild = (addLog: AddLog, webviewOnly = false) =>
  runDevScript('extension-build.ts', webviewOnly ? ['--webview-only'] : [], addLog);

const runExtensionInstall = (addLog: AddLog) => runDevScript('extension-install.ts', [], addLog);

function getDirectoryHash(dir: string, patterns: string[]): string {
  let hash = '';
  const walk = (d: string) => {
    try {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'node_modules') {
          walk(join(d, entry.name));
        } else if (entry.isFile() && patterns.some(p => entry.name.endsWith(p))) {
          hash += `${entry.name}:${statSync(join(d, entry.name)).mtimeMs}|`;
        }
      }
    } catch {}
  };
  walk(dir);
  return hash;
}

export async function runWatch(
  config: Config,
  addLog: AddLog,
  refreshStatus: () => Promise<void>,
  setProcess: SetProcess,
  signal?: AbortSignal
): Promise<void> {
  addLog('info', 'Starting extension watch mode...');

  if (!await ensureContainer(config, addLog, refreshStatus)) {
    return;
  }

  if (!existsSync(join(EXTENSION_DIR, 'node_modules'))) {
    addLog('info', 'Installing extension dependencies...');
    try {
      await $`bun install --frozen-lockfile`.cwd(EXTENSION_DIR).quiet();
    } catch {
      addLog('error', 'Failed to install extension dependencies');
      return;
    }
  }

  if (!existsSync(join(WEBVIEW_DIR, 'node_modules'))) {
    addLog('info', 'Installing webview dependencies...');
    try {
      await $`bun install --frozen-lockfile`.cwd(WEBVIEW_DIR).quiet();
    } catch {
      addLog('error', 'Failed to install webview dependencies');
      return;
    }
  }

  addLog('info', 'Starting esbuild watch mode...');
  const esbuildProc = spawn(['bun', 'run', 'dev'], {
    cwd: EXTENSION_DIR,
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const killAll = () => {
    esbuildProc.kill();
  };
  setProcess({ kill: killAll });

  await Bun.sleep(2000);

  addLog('info', 'Initial build...');
  if (!await runExtensionBuild(addLog)) {
    killAll();
    return;
  }
  if (!await runExtensionInstall(addLog)) {
    killAll();
    return;
  }

  addLog('success', 'Watch mode active');
  addLog('info', `Web UI: http://${config.host}:${config.webPort}`);
  addLog('info', `Terminal: http://${config.host}:${config.consolePort}`);
  addLog('dim', 'Reload browser after changes: Ctrl+Shift+P → Developer: Reload Window');
  addLog('dim', 'Watching for changes...');

  let lastDistHash = getDirectoryHash(join(EXTENSION_DIR, 'dist'), ['.js']);
  let lastWebviewHash = getDirectoryHash(join(WEBVIEW_DIR, 'src'), ['.tsx', '.ts', '.css']);

  while (!esbuildProc.killed && !signal?.aborted) {
    await Bun.sleep(1000);
    
    if (signal?.aborted) break;

    const currentDistHash = getDirectoryHash(join(EXTENSION_DIR, 'dist'), ['.js']);
    if (currentDistHash !== lastDistHash) {
      lastDistHash = currentDistHash;
      addLog('info', 'Extension host changed, repackaging...');
      const installed = await runExtensionInstall(addLog);
      if (signal?.aborted) break;
      if (installed) addLog('success', 'Done - reload browser');
    }

    const currentWebviewHash = getDirectoryHash(join(WEBVIEW_DIR, 'src'), ['.tsx', '.ts', '.css']);
    if (currentWebviewHash !== lastWebviewHash) {
      lastWebviewHash = currentWebviewHash;
      addLog('info', 'Webview changed, rebuilding...');
      const installed = await runExtensionBuild(addLog, true) && await runExtensionInstall(addLog);
      if (signal?.aborted) break;
      if (installed) addLog('success', 'Done - reload browser');
    }
  }
  
  killAll();
}

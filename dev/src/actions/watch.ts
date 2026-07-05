import { spawn, $ } from 'bun';
import { join } from 'path';
import { readdirSync, statSync, existsSync } from 'fs';
import type { Config } from '../lib/config';
import { REPO_ROOT, DEV_ROOT, getExtensionMountPath } from '../lib/config';
import { getContainerStatus, removeContainer, waitForContainer } from '../lib/docker';

type AddLog = (type: 'info' | 'success' | 'error' | 'warn' | 'command' | 'dim', text: string) => void;
type SetProcess = (proc: { kill: () => void } | null) => void;

const EXTENSION_DIR = join(REPO_ROOT, 'extension');
const WEBVIEW_DIR = join(EXTENSION_DIR, 'webview');

async function ensureContainerWithExtension(config: Config, addLog: AddLog): Promise<boolean> {
  const status = await getContainerStatus(config.containerName);
  
  if (status === 'running') {
    try {
      await $`docker exec ${config.containerName} test -d /extension`.quiet();
      addLog('success', 'Container running with extension mounted');
      return true;
    } catch {
      addLog('warn', 'Container running but extension not mounted');
      addLog('info', 'Restarting with extension mount...');
      await removeContainer(config.containerName);
    }
  }

  const extPath = getExtensionMountPath(config);
  addLog('info', `Starting container with extension mount: ${extPath}`);

  try {
    await $`docker run -d --name ${config.containerName} -p ${config.webPort}:8443 -p ${config.sshPort}:22 -p ${config.consolePort}:7681 -e PASSWORD=${config.password} -e SUDO_PASSWORD=${config.password} -v ${extPath}:/extension ${config.image}`.quiet();
  } catch (e) {
    addLog('error', `Failed to start container: ${e}`);
    return false;
  }

  const ready = await waitForContainer(config.containerName, 90, (msg) => {
    addLog('dim', msg);
  });

  if (!ready) {
    addLog('error', 'Container failed to become ready');
    return false;
  }

  addLog('success', 'Container ready');
  return true;
}

async function runExtensionBuild(addLog: AddLog, webviewOnly: boolean = false): Promise<boolean> {
  const args = webviewOnly ? ['--webview-only'] : [];
  try {
    await $`bun ${join(DEV_ROOT, 'scripts/extension-build.ts')} ${args}`.quiet();
    return true;
  } catch {
    addLog('error', webviewOnly ? 'Webview build failed' : 'Extension build failed');
    return false;
  }
}

async function runExtensionInstall(config: Config, addLog: AddLog): Promise<boolean> {
  try {
    await $`bun ${join(DEV_ROOT, 'scripts/extension-install.ts')}`.quiet();
    return true;
  } catch {
    addLog('error', 'Extension install failed');
    return false;
  }
}

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
  setProcess: SetProcess,
  signal?: AbortSignal
): Promise<void> {
  addLog('info', 'Starting extension watch mode...');

  if (!await ensureContainerWithExtension(config, addLog)) {
    return;
  }

  if (!existsSync(join(EXTENSION_DIR, 'node_modules'))) {
    addLog('info', 'Installing extension dependencies...');
    try {
      await $`bun install`.cwd(EXTENSION_DIR).quiet();
    } catch {
      addLog('error', 'Failed to install extension dependencies');
      return;
    }
  }

  if (!existsSync(join(WEBVIEW_DIR, 'node_modules'))) {
    addLog('info', 'Installing webview dependencies...');
    try {
      await $`bun install`.cwd(WEBVIEW_DIR).quiet();
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
  if (!await runExtensionInstall(config, addLog)) {
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
      await runExtensionInstall(config, addLog);
      if (signal?.aborted) break;
      addLog('success', 'Done - reload browser');
    }

    const currentWebviewHash = getDirectoryHash(join(WEBVIEW_DIR, 'src'), ['.tsx', '.ts', '.css']);
    if (currentWebviewHash !== lastWebviewHash) {
      lastWebviewHash = currentWebviewHash;
      addLog('info', 'Webview changed, rebuilding...');
      await runExtensionBuild(addLog, true);
      await runExtensionInstall(config, addLog);
      if (signal?.aborted) break;
      addLog('success', 'Done - reload browser');
    }
  }
  
  killAll();
}

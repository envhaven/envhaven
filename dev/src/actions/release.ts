import { spawn } from 'bun';
import { DEV_ROOT } from '../lib/config';
import { runInteractive } from '../lib/terminal';
import { join } from 'path';

type AddLog = (type: 'info' | 'success' | 'error' | 'warn' | 'command' | 'dim', text: string) => void;
type SetProcess = (proc: { kill: () => void } | null) => void;

interface ReleaseResult {
  success: boolean;
  version?: string;
  error?: string;
}

async function run(cmd: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function validateRelease(version: string, repoRoot: string, addLog: AddLog): Promise<ReleaseResult> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return { success: false, error: `Invalid version format. Use X.Y.Z (e.g., 1.2.3)` };
  }

  const tag = `v${version}`;

  const tagCheck = await run(['git', 'rev-parse', tag], repoRoot);
  if (tagCheck.exitCode === 0) {
    return { success: false, error: `Tag ${tag} already exists` };
  }

  const branchResult = await run(['git', 'branch', '--show-current'], repoRoot);
  if (branchResult.stdout !== 'master') {
    return { success: false, error: `Must be on master branch (currently on ${branchResult.stdout})` };
  }

  addLog('dim', 'Fetching latest from origin (may prompt for passphrase)...');
  const fetchExit = await runInteractive(['git', 'fetch', 'origin', 'master'], repoRoot);
  if (fetchExit !== 0) {
    return { success: false, error: 'Failed to fetch from origin' };
  }

  const localRev = await run(['git', 'rev-parse', 'HEAD'], repoRoot);
  const remoteRev = await run(['git', 'rev-parse', 'origin/master'], repoRoot);

  if (localRev.stdout !== remoteRev.stdout) {
    return { success: false, error: 'Local master is not up to date with origin. Run: git pull origin master' };
  }

  return { success: true, version };
}

export async function runRelease(
  version: string,
  addLog: AddLog,
  setProcess: SetProcess,
  signal?: AbortSignal
): Promise<void> {
  const repoRoot = join(DEV_ROOT, '..');

  addLog('info', `Preparing release v${version}...`);

  const validation = await validateRelease(version, repoRoot, addLog);
  if (!validation.success) {
    addLog('error', validation.error!);
    return;
  }

  if (signal?.aborted) return;

  const tag = `v${version}`;

  const lastTagResult = await run(['git', 'describe', '--tags', '--abbrev=0'], repoRoot);
  if (lastTagResult.exitCode === 0) {
    addLog('info', `Commits since ${lastTagResult.stdout}:`);
    const logResult = await run(
      ['git', 'log', '--oneline', `${lastTagResult.stdout}..HEAD`],
      repoRoot
    );
    for (const line of logResult.stdout.split('\n').slice(0, 15)) {
      if (line) addLog('dim', `  ${line}`);
    }
  }

  if (signal?.aborted) return;

  let tagMessage = `Release ${version}`;
  if (lastTagResult.exitCode === 0) {
    const commits = await run(['git', 'log', '--oneline', `${lastTagResult.stdout}..HEAD`], repoRoot);
    if (commits.stdout) {
      tagMessage += '\n\n' + commits.stdout;
    }
  }

  addLog('command', `git tag -s ${tag} -m "..."`);
  addLog('dim', '(will prompt for GPG passphrase)');
  const tagExit = await runInteractive(['git', 'tag', '-s', tag, '-m', tagMessage], repoRoot);
  if (tagExit !== 0) {
    addLog('error', 'Failed to create tag');
    return;
  }

  if (signal?.aborted) {
    await run(['git', 'tag', '-d', tag], repoRoot);
    addLog('warn', 'Aborted - tag removed');
    return;
  }

  addLog('command', `git push origin ${tag}`);
  addLog('dim', '(may prompt for SSH passphrase)');
  const pushExit = await runInteractive(['git', 'push', 'origin', tag], repoRoot);
  if (pushExit !== 0) {
    addLog('error', 'Failed to push tag');
    await run(['git', 'tag', '-d', tag], repoRoot);
    addLog('warn', 'Tag removed due to push failure');
    return;
  }

  addLog('success', `Release v${version} initiated!`);
  addLog('info', '');
  addLog('info', 'Track build: https://github.com/envhaven/envhaven/actions');
  addLog('info', `Image: ghcr.io/envhaven/envhaven:${version}`);
  addLog('info', `CLI:   github.com/envhaven/envhaven/releases/tag/v${version}`);
}

export async function getRecentTags(): Promise<string[]> {
  const repoRoot = join(DEV_ROOT, '..');
  const result = await run(['git', 'tag', '--sort=-v:refname'], repoRoot);
  if (result.exitCode !== 0) return [];
  return result.stdout.split('\n').filter(Boolean).slice(0, 5);
}

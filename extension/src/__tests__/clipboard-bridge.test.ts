import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as environment from '../environment';
import { readTerminalSelection, SELECTION_BUFFER, writeExtensionFlag } from '../clipboard-bridge';

// readTerminalSelection runs tmux. This shell may sit inside the developer's own tmux
// server, so the command is captured and answered here, never run.
describe('readTerminalSelection', () => {
  let commands: string[] = [];
  let spies: Array<{ mockRestore(): void }> = [];

  function tmuxAnswers(outcome: Promise<{ stdout: string; stderr: string }>): void {
    outcome.catch(() => {});
    spies.push(
      spyOn(environment, 'execSafe').mockImplementation((command: string) => {
        commands.push(command);
        return outcome;
      })
    );
  }

  beforeEach(() => {
    commands = [];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
  });

  test('reads the named selection buffer, not the newest buffer of any kind', async () => {
    tmuxAnswers(Promise.resolve({ stdout: 'selected text\n', stderr: '' }));
    expect(await readTerminalSelection()).toBe('selected text\n');
    expect(commands).toEqual(['tmux save-buffer -b envhaven-selection -']);
    expect(SELECTION_BUFFER).toBe('envhaven-selection');
  });

  test('has nothing to copy, quietly, when tmux has no server or no selection yet', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    spies.push(error);
    tmuxAnswers(Promise.reject(new Error('exit code 1')));
    expect(await readTerminalSelection()).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  test('reports any other failure', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    spies.push(error);
    tmuxAnswers(Promise.reject(new Error('timeout')));
    expect(await readTerminalSelection()).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('writeExtensionFlag', () => {
  let dir = '';
  let errorSpy: { mockRestore(): void } | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'envhaven-flag-'));
  });

  afterEach(() => {
    errorSpy?.mockRestore();
    errorSpy = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function quietly(): void {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  }

  test('writes this pid to a file only its owner can read', () => {
    const flag = join(dir, 'flag');
    writeFileSync(flag, 'stale pid from an earlier host');
    expect(writeExtensionFlag(flag)).toBe(true);
    expect(readFileSync(flag, 'utf8')).toBe(String(process.pid));

    const fresh = join(dir, 'fresh');
    expect(writeExtensionFlag(fresh)).toBe(true);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  test('refuses to write through a symlink planted at the path', () => {
    quietly();
    const target = join(dir, 'zshrc');
    writeFileSync(target, 'the user file the link points at');
    const flag = join(dir, 'flag');
    symlinkSync(target, flag);

    expect(writeExtensionFlag(flag)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('the user file the link points at');
  });

  test('does not wait on a FIFO planted at the path', () => {
    quietly();
    const flag = join(dir, 'flag');
    // Bun.spawnSync, not child_process, so no other file's spawn mock is in the way.
    expect(Bun.spawnSync(['mkfifo', flag]).exitCode).toBe(0);
    expect(writeExtensionFlag(flag)).toBe(false);
  });

  test('reports a path it cannot write instead of throwing', () => {
    quietly();
    const flag = join(dir, 'flag');
    mkdirSync(flag);
    expect(writeExtensionFlag(flag)).toBe(false);
  });
});

import { describe, expect, it, mock } from 'bun:test';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import { TmuxControl } from '../tmux-control';

// Pass-through by default, as in consoleClient.test.ts, so whichever test file
// loads after this one still spawns real processes.
const realSpawn = childProcess.spawn;
const spawnMock = mock(
  (command: string, args: readonly string[] = [], options: childProcess.SpawnOptions = {}) =>
    realSpawn(command, args, options)
);
mock.module('child_process', () => ({ spawn: spawnMock }));

describe('TmuxControl.start', () => {
  it('attaches without ever starting a tmux server', async () => {
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
    spawnMock.mockImplementationOnce(() => proc as unknown as childProcess.ChildProcess);
    const control = new TmuxControl('envhaven');
    try {
      await control.start();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [command, args] = spawnMock.mock.calls[0];
      expect(command).toBe('tmux');
      // Without -N, every 1 s retry while no server runs would start one.
      expect(args).toEqual(['-N', '-C', 'attach-session', '-t', '=envhaven']);
    } finally {
      control.dispose();
    }
  });
});

describe('TmuxControl.isChangeLine', () => {
  it('detects window-add', () => {
    expect(TmuxControl.isChangeLine('%window-add @5')).toBe(true);
  });

  it('detects window-close', () => {
    expect(TmuxControl.isChangeLine('%window-close @3')).toBe(true);
  });

  it('detects session-window-changed', () => {
    expect(TmuxControl.isChangeLine('%session-window-changed $0 @1')).toBe(true);
  });

  it('detects window-renamed', () => {
    expect(TmuxControl.isChangeLine('%window-renamed @2 claude')).toBe(true);
  });

  it('detects sessions-changed (no args)', () => {
    expect(TmuxControl.isChangeLine('%sessions-changed')).toBe(true);
  });

  it('ignores pane output', () => {
    expect(TmuxControl.isChangeLine('%output %1 hello world')).toBe(false);
  });

  it('ignores command begin/end framing', () => {
    expect(TmuxControl.isChangeLine('%begin 1234 5678 0')).toBe(false);
    expect(TmuxControl.isChangeLine('%end 1234 5678 0')).toBe(false);
    expect(TmuxControl.isChangeLine('%error 1234 5678 0')).toBe(false);
  });

  it('ignores arbitrary text', () => {
    expect(TmuxControl.isChangeLine('random')).toBe(false);
    expect(TmuxControl.isChangeLine('')).toBe(false);
  });

  it('does not match prefix substrings (no false positive on window-add-something)', () => {
    // A hypothetical future event prefixed with our name must still be treated as non-change,
    // because our notification list is explicit. The split char after the prefix is space or tab.
    expect(TmuxControl.isChangeLine('%window-addendum foo')).toBe(false);
  });
});

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  parseStatLine,
  classify,
  signalProcess,
  __test__,
} from '../resource-monitor';

describe('parseStatLine', () => {
  it('parses a plain stat line', () => {
    // Fields 1..22: pid (comm) state ppid pgrp session tty_nr tpgid flags
    //              minflt cminflt majflt cmajflt utime stime cutime cstime
    //              priority nice num_threads itrealvalue starttime
    const raw =
      '1234 (zsh) S 900 1234 1234 34816 1234 4194304 ' +
      '100 0 0 0 ' +
      '50 30 0 0 ' +
      '20 0 1 0 ' +
      '987654321 1000000 200 ...rest';
    const row = parseStatLine(raw);
    expect(row).not.toBeNull();
    expect(row!.pid).toBe(1234);
    expect(row!.comm).toBe('zsh');
    expect(row!.state).toBe('S');
    expect(row!.ppid).toBe(900);
    expect(row!.utime).toBe(50);
    expect(row!.stime).toBe(30);
    expect(row!.starttime).toBe(987654321);
  });

  it('parses a stat line where comm contains spaces and parens', () => {
    const raw =
      '4321 (some (weird) proc) R 1 4321 4321 0 -1 4194304 ' +
      '0 0 0 0 ' +
      '10 20 0 0 ' +
      '20 0 1 0 ' +
      '42 999 100 end';
    const row = parseStatLine(raw);
    expect(row).not.toBeNull();
    expect(row!.pid).toBe(4321);
    expect(row!.comm).toBe('some (weird) proc');
    expect(row!.ppid).toBe(1);
    expect(row!.utime).toBe(10);
    expect(row!.stime).toBe(20);
    expect(row!.starttime).toBe(42);
  });

  it('returns null on malformed input (no parens)', () => {
    expect(parseStatLine('not a stat line')).toBeNull();
  });

  it('returns null when too few fields', () => {
    expect(parseStatLine('1 (x) S 1 2 3')).toBeNull();
  });
});

describe('classify', () => {
  const panePids = new Set([100, 200]);

  it('classifies a pane shell PID as "pane"', () => {
    expect(classify(100, 1, panePids, new Map())).toBe('pane');
  });

  it('classifies a direct child of a pane shell as "user"', () => {
    expect(classify(500, 100, panePids, new Map([[500, 100]]))).toBe('user');
  });

  it('classifies a grandchild of a pane shell as "child"', () => {
    const ppidMap = new Map<number, number>([
      [500, 100], // child of pane
      [600, 500], // grandchild
      [700, 600], // great-grandchild
    ]);
    expect(classify(600, 500, panePids, ppidMap)).toBe('child');
    expect(classify(700, 600, panePids, ppidMap)).toBe('child');
  });

  it('returns null for processes not under any pane', () => {
    const ppidMap = new Map<number, number>([
      [800, 1],
      [900, 800],
    ]);
    expect(classify(900, 800, panePids, ppidMap)).toBeNull();
  });

  it('tolerates cycles in ppid chain without infinite loop', () => {
    const ppidMap = new Map<number, number>([
      [1000, 1001],
      [1001, 1000],
    ]);
    expect(classify(1000, 1001, panePids, ppidMap)).toBeNull();
  });
});

describe('signalProcess (safety gate)', () => {
  beforeEach(() => {
    __test__.reset();
  });

  it('refuses PID 1', () => {
    __test__.setLastSnapshot([[1, 100]]);
    const r = signalProcess(1, 100, 'SIGTERM');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('init');
  });

  it('refuses a PID not in the last snapshot', () => {
    __test__.setLastSnapshot([[555, 999]]);
    const r = signalProcess(777, 999, 'SIGTERM');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not in current view');
  });

  it('refuses when process has exited and PID reused (starttime mismatch)', () => {
    // PID for this process (self) is definitely readable; snapshot points to fake starttime.
    __test__.setLastSnapshot([[process.pid, 0]]);
    const r = signalProcess(process.pid, 0, 'SIGTERM');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('PID reused');
  });

  it('treats a process that has already exited as ok', () => {
    // Use a PID that almost certainly does not exist; starttime is irrelevant
    // because readProcStat() returns null, short-circuiting to ok.
    const deadPid = 2_000_000_000;
    __test__.setLastSnapshot([[deadPid, 42]]);
    const r = signalProcess(deadPid, 42, 'SIGTERM');
    expect(r.ok).toBe(true);
  });
});

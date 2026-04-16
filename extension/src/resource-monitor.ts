import { readFileSync, readdirSync } from 'fs';
import { execSafe } from './environment';

export type ProcessCategory = 'pane' | 'user' | 'child';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  starttime: number;
  name: string;
  cmd: string;
  cpuPct: number;
  memMb: number;
  category: ProcessCategory;
}

export interface CpuStats {
  pct: number;
  nCpus: number;
}

export interface RamStats {
  usedMb: number;
  totalMb: number;
  pct: number;
}

export interface ResourceSnapshot {
  cpu: CpuStats;
  ram: RamStats;
  processes: ProcessInfo[];
  capturedAt: number;
}

export interface SignalResult {
  ok: boolean;
  reason?: string;
}

interface StatRow {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  utime: number;
  stime: number;
  starttime: number;
}

let prevTotalJiffies = 0;
let prevProcTicks = new Map<number, number>();
let nCpusCached = 0;
let memTotalKbCached = 0;
let lastSnapshotPids = new Map<number, number>();

export async function snapshot(): Promise<ResourceSnapshot> {
  if (nCpusCached === 0) nCpusCached = readNCpus();
  const nCpus = nCpusCached;

  const mem = readMemInfo();
  if (memTotalKbCached === 0) memTotalKbCached = mem.totalKb;
  const memTotalKb = memTotalKbCached || mem.totalKb || 1;

  const panePids = await getTmuxPanePids();
  const extHostPid = process.pid;

  const statMap = new Map<number, StatRow>();
  for (const pid of listPids()) {
    const row = readProcStat(pid);
    if (row) statMap.set(pid, row);
  }

  const ppidMap = new Map<number, number>();
  for (const [pid, s] of statMap) ppidMap.set(pid, s.ppid);

  const totalNow = readCpuTotalJiffies();
  const deltaTotal = Math.max(1, totalNow - prevTotalJiffies);
  const nextProcTicks = new Map<number, number>();

  const processes: ProcessInfo[] = [];

  for (const [pid, s] of statMap) {
    if (pid <= 2) continue;
    if (s.ppid === 2) continue;
    if (s.comm.startsWith('[')) continue;
    if (pid === extHostPid) continue;
    if (isAncestor(pid, extHostPid, ppidMap)) continue;

    const category = classify(pid, s.ppid, panePids, ppidMap);
    if (!category) continue;

    const ticksNow = s.utime + s.stime;
    nextProcTicks.set(pid, ticksNow);
    const ticksPrev = prevProcTicks.get(pid) ?? ticksNow;
    const cpuPct = clamp(
      ((ticksNow - ticksPrev) / deltaTotal) * nCpus * 100,
      0,
      100 * nCpus
    );

    const memMb = Math.round(readProcVmRss(pid) / 1024);
    const cmd = readProcCmdline(pid);

    processes.push({
      pid,
      ppid: s.ppid,
      starttime: s.starttime,
      name: s.comm,
      cmd: cmd || s.comm,
      cpuPct,
      memMb,
      category,
    });
  }

  processes.sort((a, b) => b.cpuPct - a.cpuPct);

  prevProcTicks = nextProcTicks;
  prevTotalJiffies = totalNow;
  lastSnapshotPids = new Map(processes.map((p) => [p.pid, p.starttime]));

  const aggCpu = processes.reduce((sum, p) => sum + p.cpuPct, 0) / nCpus;
  const cpuPct = clamp(aggCpu, 0, 100);

  const availKb = mem.availableKb || memTotalKb;
  const usedKb = Math.max(0, memTotalKb - availKb);
  const ramPct = clamp((usedKb / memTotalKb) * 100, 0, 100);

  return {
    cpu: { pct: cpuPct, nCpus },
    ram: {
      usedMb: Math.round(usedKb / 1024),
      totalMb: Math.round(memTotalKb / 1024),
      pct: ramPct,
    },
    processes,
    capturedAt: Date.now(),
  };
}

export function signalProcess(
  pid: number,
  starttime: number,
  signal: 'SIGTERM' | 'SIGKILL'
): SignalResult {
  if (pid === 1) return { ok: false, reason: 'init' };
  if (!lastSnapshotPids.has(pid)) return { ok: false, reason: 'not in current view' };
  const cur = readProcStat(pid);
  if (!cur) return { ok: true };
  if (cur.starttime !== starttime) return { ok: false, reason: 'PID reused' };
  try {
    process.kill(pid, signal);
    return { ok: true };
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { ok: true };
    if (code === 'EPERM') return { ok: false, reason: 'permission denied' };
    return { ok: false, reason: (e as Error).message ?? String(e) };
  }
}

export function parseStatLine(raw: string): StatRow | null {
  const lastParen = raw.lastIndexOf(')');
  if (lastParen < 0) return null;
  const head = raw.slice(0, lastParen + 1);
  const firstParen = head.indexOf('(');
  if (firstParen < 0) return null;
  const pid = parseInt(head.slice(0, firstParen).trim(), 10);
  if (!Number.isFinite(pid)) return null;
  const comm = head.slice(firstParen + 1, lastParen);
  const rest = raw.slice(lastParen + 1).trim().split(/\s+/);
  if (rest.length < 20) return null;
  return {
    pid,
    comm,
    state: rest[0],
    ppid: parseInt(rest[1], 10) || 0,
    utime: parseInt(rest[11], 10) || 0,
    stime: parseInt(rest[12], 10) || 0,
    starttime: parseInt(rest[19], 10) || 0,
  };
}

export function classify(
  pid: number,
  ppid: number,
  panePids: Set<number>,
  ppidMap: Map<number, number>
): ProcessCategory | null {
  if (panePids.has(pid)) return 'pane';
  if (panePids.has(ppid)) return 'user';
  let cur = ppid;
  const seen = new Set<number>();
  for (let i = 0; i < 20 && cur > 1 && !seen.has(cur); i++) {
    if (panePids.has(cur)) return 'child';
    seen.add(cur);
    cur = ppidMap.get(cur) ?? 1;
  }
  return null;
}

function isAncestor(pid: number, ancestor: number, ppidMap: Map<number, number>): boolean {
  let cur = ppidMap.get(pid) ?? 1;
  const seen = new Set<number>();
  for (let i = 0; i < 20 && cur > 1 && !seen.has(cur); i++) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = ppidMap.get(cur) ?? 1;
  }
  return false;
}

function readProcStat(pid: number): StatRow | null {
  try {
    return parseStatLine(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

function readProcVmRss(pid: number): number {
  try {
    const raw = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /^VmRSS:\s+(\d+)/m.exec(raw);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function readProcCmdline(pid: number): string {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const cmd = raw.replace(/\0/g, ' ').trim();
    return cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd;
  } catch {
    return '';
  }
}

function readCpuTotalJiffies(): number {
  try {
    const first = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0];
    const parts = first.trim().split(/\s+/);
    let sum = 0;
    for (let i = 1; i <= 8; i++) sum += parseInt(parts[i] ?? '0', 10) || 0;
    return sum;
  } catch {
    return 0;
  }
}

function readMemInfo(): { totalKb: number; availableKb: number } {
  try {
    const raw = readFileSync('/proc/meminfo', 'utf8');
    const total = /^MemTotal:\s+(\d+)/m.exec(raw);
    const avail = /^MemAvailable:\s+(\d+)/m.exec(raw);
    return {
      totalKb: total ? parseInt(total[1], 10) : 0,
      availableKb: avail ? parseInt(avail[1], 10) : 0,
    };
  } catch {
    return { totalKb: 0, availableKb: 0 };
  }
}

function readNCpus(): number {
  try {
    const raw = readFileSync('/proc/cpuinfo', 'utf8');
    return raw.split('\n').filter((l) => l.startsWith('processor')).length || 1;
  } catch {
    return 1;
  }
}

function listPids(): number[] {
  try {
    const out: number[] = [];
    for (const entry of readdirSync('/proc')) {
      if (/^\d+$/.test(entry)) out.push(parseInt(entry, 10));
    }
    return out;
  } catch {
    return [];
  }
}

async function getTmuxPanePids(): Promise<Set<number>> {
  const pids = new Set<number>();
  try {
    const { stdout } = await execSafe("tmux list-panes -a -t envhaven -F '#{pane_pid}'");
    for (const line of stdout.split('\n')) {
      const n = parseInt(line.trim(), 10);
      if (Number.isFinite(n) && n > 0) pids.add(n);
    }
  } catch {
    /* no tmux session yet — empty set */
  }
  return pids;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export const __test__ = {
  reset(): void {
    prevTotalJiffies = 0;
    prevProcTicks = new Map();
    nCpusCached = 0;
    memTotalKbCached = 0;
    lastSnapshotPids = new Map();
  },
  setLastSnapshot(entries: Array<[number, number]>): void {
    lastSnapshotPids = new Map(entries);
  },
};

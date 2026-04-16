import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, X } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './ui/collapsible';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode, type ProcessInfo, type ResourceSnapshot } from '../lib/vscode';

const RING_R = 20;
const RING_W = 4;
const RING_C = 2 * Math.PI * RING_R;

function thresholdColor(pct: number): string {
  if (pct >= 85) return 'var(--vscode-charts-red, #f14c4c)';
  if (pct >= 60) return 'var(--vscode-charts-yellow, #cca700)';
  return 'var(--vscode-charts-green, #89d185)';
}

function Ring({ pct, label, subLabel }: { pct: number; label: string; subLabel: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * RING_C;
  const color = thresholdColor(clamped);
  return (
    <div className="flex flex-col items-center gap-1">
      <svg viewBox="0 0 48 48" className="h-14 w-14">
        <circle
          cx="24"
          cy="24"
          r={RING_R}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={RING_W}
        />
        <circle
          cx="24"
          cy="24"
          r={RING_R}
          fill="none"
          stroke={color}
          strokeWidth={RING_W}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${RING_C}`}
          transform="rotate(-90 24 24)"
          style={{ transition: 'stroke-dasharray 0.4s ease, stroke 0.2s ease' }}
        />
        <text
          x="24"
          y="27"
          textAnchor="middle"
          className="fill-foreground"
          style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}
        >
          {Math.round(clamped)}%
        </text>
      </svg>
      <div className="flex flex-col items-center">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-section-header">
          {label}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground">{subLabel}</span>
      </div>
    </div>
  );
}

function Gauges({ cpu, ram }: Pick<ResourceSnapshot, 'cpu' | 'ram'>) {
  const ramGb = (ram.totalMb / 1024).toFixed(1);
  const ramUsedGb = (ram.usedMb / 1024).toFixed(1);
  return (
    <div className="flex items-center justify-around rounded-md border border-border bg-muted/20 py-2">
      <Ring pct={cpu.pct} label="CPU" subLabel={`${cpu.nCpus} vCPU`} />
      <Ring pct={ram.pct} label="RAM" subLabel={`${ramUsedGb} / ${ramGb} GB`} />
    </div>
  );
}

function ProcessRow({
  p,
  nCpus,
  pending,
  onKill,
}: {
  p: ProcessInfo;
  nCpus: number;
  pending: boolean;
  onKill: (p: ProcessInfo) => void;
}) {
  const perCorePct = p.cpuPct / nCpus;
  return (
    <div className="flex h-6 items-center gap-2 rounded-md px-2 hover:bg-accent">
      <span className="flex-1 truncate text-[11px]" title={`${p.cmd}\nPID ${p.pid}`}>
        {p.name}
      </span>
      <span
        className="w-10 text-right font-mono text-[10px] tabular-nums"
        style={{ color: thresholdColor(perCorePct) }}
      >
        {perCorePct.toFixed(0)}%
      </span>
      <span className="w-16 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
        {p.memMb} MB
      </span>
      <div className="flex w-4 shrink-0 items-center justify-end">
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onKill(p);
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded hover:bg-destructive/20"
                  aria-label="Terminate"
                >
                  <X className="h-3 w-3 text-muted-foreground/60 hover:text-destructive" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Terminate</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}

function ProcessGroup({
  title,
  items,
  nCpus,
  defaultOpen = false,
  pending,
  onKill,
}: {
  title: string;
  items: ProcessInfo[];
  nCpus: number;
  defaultOpen?: boolean;
  pending: Set<number>;
  onKill: (p: ProcessInfo) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const totalCpu = items.reduce((sum, p) => sum + p.cpuPct, 0) / Math.max(1, nCpus);
  const totalMem = items.reduce((sum, p) => sum + p.memMb, 0);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-0.5 text-left hover:bg-accent">
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${
              open ? 'rotate-90' : ''
            }`}
          />
          <span className="flex-1 truncate text-[12px] text-muted-foreground">
            {title}{' '}
            <span className="font-mono tabular-nums opacity-60">({items.length})</span>
          </span>
          <span className="w-10 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
            {items.length > 0 ? `${totalCpu.toFixed(0)}%` : ''}
          </span>
          <span className="w-16 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
            {items.length > 0 ? `${totalMem} MB` : ''}
          </span>
          <span className="w-4 shrink-0" aria-hidden="true" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content overflow-hidden">
        <div className="ml-1.5 space-y-0.5 border-l border-border/30 pt-0.5 pl-2">
          {items.length === 0 ? (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">None</div>
          ) : (
            items.map((p) => (
              <ProcessRow
                key={p.pid}
                p={p}
                nCpus={nCpus}
                pending={pending.has(p.pid)}
                onKill={onKill}
              />
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ProcessTree({
  panes,
  users,
  kids,
  nCpus,
}: {
  panes: ProcessInfo[];
  users: ProcessInfo[];
  kids: ProcessInfo[];
  nCpus: number;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Set<number>>(new Set());
  const failsafeTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    setPending((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set<number>();
      for (const p of panes) alive.add(p.pid);
      for (const p of users) alive.add(p.pid);
      for (const p of kids) alive.add(p.pid);
      const next = new Set<number>();
      for (const pid of prev) {
        if (alive.has(pid)) {
          next.add(pid);
        } else {
          const t = failsafeTimers.current.get(pid);
          if (t) clearTimeout(t);
          failsafeTimers.current.delete(pid);
        }
      }
      return next.size === prev.size ? prev : next;
    });
  }, [panes, users, kids]);

  useEffect(() => {
    const timers = failsafeTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const handleKill = (p: ProcessInfo) => {
    setPending((prev) => {
      const next = new Set(prev);
      next.add(p.pid);
      return next;
    });
    const existing = failsafeTimers.current.get(p.pid);
    if (existing) clearTimeout(existing);
    failsafeTimers.current.set(
      p.pid,
      setTimeout(() => {
        failsafeTimers.current.delete(p.pid);
        setPending((prev) => {
          if (!prev.has(p.pid)) return prev;
          const next = new Set(prev);
          next.delete(p.pid);
          return next;
        });
      }, 4000)
    );
    vscode.postMessage({ command: 'killProcess', pid: p.pid, starttime: p.starttime });
  };

  const total = panes.length + users.length + kids.length;
  const totalCpu =
    [...panes, ...users, ...kids].reduce((sum, p) => sum + p.cpuPct, 0) / Math.max(1, nCpus);
  const totalMem = [...panes, ...users, ...kids].reduce((sum, p) => sum + p.memMb, 0);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent">
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${
              open ? 'rotate-90' : ''
            }`}
          />
          <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-section-header">
            Processes{' '}
            <span className="font-mono text-[10px] font-normal normal-case tracking-normal opacity-60">
              ({total})
            </span>
          </span>
          <span className="w-10 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
            {total > 0 ? `${totalCpu.toFixed(0)}%` : ''}
          </span>
          <span className="w-16 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
            {total > 0 ? `${totalMem} MB` : ''}
          </span>
          <span className="w-4 shrink-0" aria-hidden="true" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content overflow-hidden">
        <div className="space-y-0.5 border-l border-border/50 pt-1 pl-2">
          <ProcessGroup
            title="Shells"
            items={panes}
            nCpus={nCpus}
            pending={pending}
            onKill={handleKill}
          />
          <ProcessGroup
            title="User"
            items={users}
            nCpus={nCpus}
            defaultOpen
            pending={pending}
            onKill={handleKill}
          />
          <ProcessGroup
            title="Child"
            items={kids}
            nCpus={nCpus}
            pending={pending}
            onKill={handleKill}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ResourcesPanel() {
  const resources = useWorkspaceStore((s) => s.resources);
  if (!resources) return null;

  const panes = resources.processes.filter((p) => p.category === 'pane');
  const users = resources.processes.filter((p) => p.category === 'user');
  const kids = resources.processes.filter((p) => p.category === 'child');

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-section-header">
        Resources
      </h3>
      <Gauges cpu={resources.cpu} ram={resources.ram} />
      <ProcessTree panes={panes} users={users} kids={kids} nCpus={resources.cpu.nCpus} />
    </div>
  );
}

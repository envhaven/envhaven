import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, Loader2, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet';
import { Button } from './ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode, type ProcessInfo } from '../lib/vscode';
import { thresholdColor } from '../lib/thresholds';
import { usePendingFailsafe } from '../lib/use-pending-failsafe';

const FAILSAFE_MS = 4000;

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
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent">
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${
              open ? 'rotate-90' : ''
            }`}
          />
          <span className="flex-1 truncate text-xs text-muted-foreground">
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

export function ProcessSheet() {
  const { resources, openSheet, setOpenSheet } = useWorkspaceStore();
  const open = openSheet === 'process';

  const { pending, markPending, reconcile } = usePendingFailsafe<number>(FAILSAFE_MS);

  const panes = resources?.processes.filter((p) => p.category === 'pane') ?? [];
  const users = resources?.processes.filter((p) => p.category === 'user') ?? [];
  const kids = resources?.processes.filter((p) => p.category === 'child') ?? [];
  const nCpus = resources?.cpu.nCpus ?? 1;

  useEffect(() => {
    const alive = new Set<number>();
    for (const p of panes) alive.add(p.pid);
    for (const p of users) alive.add(p.pid);
    for (const p of kids) alive.add(p.pid);
    reconcile((pid) => alive.has(pid));
  }, [panes, users, kids, reconcile]);

  const handleKill = (p: ProcessInfo) => {
    markPending(p.pid);
    vscode.postMessage({ command: 'killProcess', pid: p.pid, starttime: p.starttime });
  };

  const total = panes.length + users.length + kids.length;
  const totalCpu =
    [...panes, ...users, ...kids].reduce((sum, p) => sum + p.cpuPct, 0) / Math.max(1, nCpus);
  const totalMem = [...panes, ...users, ...kids].reduce((sum, p) => sum + p.memMb, 0);

  return (
    <Sheet open={open} onOpenChange={(v) => setOpenSheet(v ? 'process' : null)}>
      <SheetContent className="flex flex-col">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setOpenSheet(null)}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <SheetTitle className="flex-1">
              Processes{' '}
              <span className="font-mono text-[10px] font-normal tracking-normal opacity-60">
                ({total})
              </span>
            </SheetTitle>
          </div>
          <SheetDescription className="pl-8">
            <span className="font-mono tabular-nums">{totalCpu.toFixed(0)}%</span> CPU
            {' · '}
            <span className="font-mono tabular-nums">{totalMem} MB</span> RAM
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <div className="space-y-1 px-2 pb-3 [&>*:first-child]:mt-3">
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
        </div>
      </SheetContent>
    </Sheet>
  );
}

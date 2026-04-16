import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, SquareTerminal, X } from 'lucide-react';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode, type TmuxWindow } from '../lib/vscode';

const FAILSAFE_MS = 4000;

type PendingKey = number | 'new';

function TerminalRow({
  window,
  pending,
  onKill,
}: {
  window: TmuxWindow;
  pending: boolean;
  onKill: (idx: number) => void;
}) {
  const handleClick = () => {
    vscode.postMessage({ command: 'switchTerminal', windowIndex: window.index });
  };

  return (
    <div
      onClick={handleClick}
      className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-muted/30 px-2 hover:bg-accent"
    >
      <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate text-sm">{window.name}</span>
      <div className="group relative flex h-4 w-4 shrink-0 items-center justify-center">
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : (
          <>
            <span
              className={`absolute h-2 w-2 rounded-full transition-opacity group-hover:opacity-0 ${
                window.active ? 'bg-success' : 'bg-muted-foreground/40'
              }`}
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                onKill(window.index);
              }}
              className="absolute flex h-4 w-4 items-center justify-center rounded opacity-0 transition-opacity hover:bg-destructive/20 group-hover:opacity-100"
            >
              <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function TerminalsPanel() {
  const { workspace } = useWorkspaceStore();
  const windows = workspace?.tmuxWindows ?? [];

  const [pending, setPending] = useState<Set<PendingKey>>(new Set());
  const failsafeTimers = useRef<Map<PendingKey, ReturnType<typeof setTimeout>>>(new Map());
  const prevLen = useRef<number>(windows.length);

  useEffect(() => {
    setPending((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(windows.map((w) => w.index));
      const next = new Set<PendingKey>();
      for (const k of prev) {
        if (k === 'new') {
          if (windows.length > prevLen.current) {
            clearFailsafe(k);
          } else {
            next.add(k);
          }
        } else if (alive.has(k)) {
          next.add(k);
        } else {
          clearFailsafe(k);
        }
      }
      prevLen.current = windows.length;
      return next.size === prev.size ? prev : next;
    });

    function clearFailsafe(k: PendingKey) {
      const t = failsafeTimers.current.get(k);
      if (t) clearTimeout(t);
      failsafeTimers.current.delete(k);
    }
  }, [windows]);

  useEffect(() => {
    const timers = failsafeTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const markPending = (k: PendingKey) => {
    setPending((prev) => {
      const next = new Set(prev);
      next.add(k);
      return next;
    });
    const existing = failsafeTimers.current.get(k);
    if (existing) clearTimeout(existing);
    failsafeTimers.current.set(
      k,
      setTimeout(() => {
        failsafeTimers.current.delete(k);
        setPending((prev) => {
          if (!prev.has(k)) return prev;
          const next = new Set(prev);
          next.delete(k);
          return next;
        });
      }, FAILSAFE_MS)
    );
  };

  const handleNewTerminal = () => {
    prevLen.current = windows.length;
    markPending('new');
    vscode.postMessage({ command: 'newTerminal' });
  };

  const handleKill = (idx: number) => {
    markPending(idx);
    vscode.postMessage({ command: 'killTerminal', windowIndex: idx });
  };

  const newPending = pending.has('new');

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-section-header">
          Terminals
        </h3>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={handleNewTerminal}
                disabled={newPending}
              >
                {newPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>New Terminal</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {windows.length === 0 ? (
        <div className="text-xs text-muted-foreground">No terminal sessions</div>
      ) : (
        <div className="space-y-1">
          {windows.map((window) => (
            <TerminalRow
              key={window.index}
              window={window}
              pending={pending.has(window.index)}
              onKill={handleKill}
            />
          ))}
        </div>
      )}
    </div>
  );
}

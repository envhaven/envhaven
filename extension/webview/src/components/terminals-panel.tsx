import { useEffect, useRef } from 'react';
import { Loader2, Plus, SquareTerminal, X } from 'lucide-react';
import { Section, SectionHeader, SectionBody } from './ui/section';
import { Row } from './ui/row';
import { IconButton } from './ui/icon-button';
import { EmptyState } from './ui/empty-state';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode, type TmuxWindow } from '../lib/vscode';
import { usePendingFailsafe } from '../lib/use-pending-failsafe';

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

  const trailing = (
    <div className="relative flex h-4 w-4 items-center justify-center">
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
  );

  return (
    <Row
      onClick={handleClick}
      bordered
      leading={<SquareTerminal className="h-3.5 w-3.5 text-muted-foreground" />}
      label={window.name}
      trailing={trailing}
    />
  );
}

export function TerminalsPanel() {
  const { workspace } = useWorkspaceStore();
  const windows = workspace?.tmuxWindows ?? [];

  const { pending, markPending, reconcile } = usePendingFailsafe<PendingKey>(FAILSAFE_MS);
  // Snapshot length at the moment we dispatch `newTerminal`. The 'new' key is
  // considered confirmed once the tmux list grows past this baseline.
  const newBaseline = useRef<number>(windows.length);

  useEffect(() => {
    const alive = new Set<number>(windows.map((w) => w.index));
    reconcile((k) =>
      k === 'new' ? windows.length <= newBaseline.current : alive.has(k)
    );
  }, [windows, reconcile]);

  const handleNewTerminal = () => {
    newBaseline.current = windows.length;
    markPending('new');
    vscode.postMessage({ command: 'newTerminal' });
  };

  const handleKill = (idx: number) => {
    markPending(idx);
    vscode.postMessage({ command: 'killTerminal', windowIndex: idx });
  };

  const newPending = pending.has('new');

  return (
    <Section>
      <SectionHeader
        title="Terminals"
        action={
          <IconButton
            tooltip="New Terminal"
            size="sm"
            onClick={handleNewTerminal}
            disabled={newPending}
          >
            {newPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </IconButton>
        }
      />

      {windows.length === 0 ? (
        <EmptyState compact title="No terminal sessions" />
      ) : (
        <SectionBody>
          {windows.map((window) => (
            <TerminalRow
              key={window.index}
              window={window}
              pending={pending.has(window.index)}
              onKill={handleKill}
            />
          ))}
        </SectionBody>
      )}
    </Section>
  );
}

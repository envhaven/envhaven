import { ChevronRight, Circle, CircleCheck } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode } from '../lib/vscode';

interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  onClick: () => void;
}

export function OnboardingCard() {
  const { workspace, installedSkills, setOpenSheet, getConnectedTools, docsOpened, markDocsOpened } =
    useWorkspaceStore();
  if (!workspace) return null;

  const connected = getConnectedTools();

  const items: ChecklistItem[] = [
    {
      id: 'tool',
      label: 'Connect an AI tool',
      done: connected.length > 0,
      onClick: () => setOpenSheet('tools'),
    },
    {
      id: 'ssh',
      label: 'Set up SSH access',
      done: !!workspace.sshKeyConfigured,
      onClick: () => setOpenSheet('ssh'),
    },
    {
      id: 'skill',
      label: 'Install your first skill',
      done: installedSkills.length > 0,
      onClick: () => setOpenSheet('skills'),
    },
    {
      id: 'docs',
      label: 'Open the docs',
      done: docsOpened,
      onClick: () => {
        markDocsOpened();
        vscode.postMessage({ command: 'openDocs' });
      },
    },
  ];

  return (
    <Card className="border-border/60">
      <CardContent className="space-y-3 p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Welcome to EnvHaven</h2>
          <p className="text-[11px] text-muted-foreground">
            Set up your workspace in four steps.
          </p>
        </div>
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id}>
              <button
                onClick={item.onClick}
                className="group flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-xs hover:bg-accent"
              >
                {item.done ? (
                  <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" />
                ) : (
                  <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span
                  className={
                    item.done
                      ? 'flex-1 text-muted-foreground line-through'
                      : 'flex-1 text-foreground'
                  }
                >
                  {item.label}
                </span>
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

import { useEffect } from 'react';

import { ExternalLink } from 'lucide-react';
import { vscode, type ExtensionToWebviewMessage } from './lib/vscode';
import { useWorkspaceStore } from './stores/workspace-store';
import { ToolLauncher } from './components/tool-launcher';
import { TerminalsPanel } from './components/terminals-panel';
import { ResourcesPanel } from './components/resources-panel';
import { WorkspaceInfo, SshSection, TryEnvHavenCard, VersionSection } from './components/workspace-info';
import { Skeleton } from './components/ui/skeleton';

export default function App() {
  const {
    isLoading,
    setWorkspace,
    workspace,
    setPortUpdateStatus,
    updateTerminals,
    setResources,
  } = useWorkspaceStore();

  useEffect(() => {
    const handleMessage = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const message = event.data;

      switch (message.command) {
        case 'updateWorkspace':
          if (message.workspace) {
            setWorkspace(message.workspace);
          }
          break;
        case 'updateTerminals':
          if (message.tmuxWindows) {
            updateTerminals(message.tmuxWindows);
          }
          break;
        case 'updateResources':
          if (message.resources) {
            setResources(message.resources);
          }
          break;
        case 'portUpdateSuccess':
          setPortUpdateStatus('success');
          setTimeout(() => setPortUpdateStatus('idle'), 1500);
          break;
        case 'portUpdateError':
          setPortUpdateStatus('error', message.error);
          setTimeout(() => setPortUpdateStatus('idle'), 3000);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    vscode.postMessage({ command: 'ready' });

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [setWorkspace, setPortUpdateStatus, updateTerminals, setResources]);

  const handleOpenDocs = () => {
    vscode.postMessage({ command: 'openDocs' });
  };

  if (isLoading) {
    return (
      <div className="flex h-full flex-col p-3 space-y-5">
        <div className="space-y-2">
          <Skeleton className="h-3 w-16" />
          <div className="space-y-1">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <div className="space-y-1">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      </div>
    );
  }

  const isManaged = workspace?.isManaged ?? false;

  return (
    <div className="flex h-full flex-col p-3 pb-6">
      <main className="flex-1 space-y-5">
        <TerminalsPanel />
        <ToolLauncher />
        <ResourcesPanel />
        <SshSection />
        <WorkspaceInfo />
      </main>

      <footer className="mt-auto space-y-3 pt-4">
        {!isManaged && <VersionSection />}

        {!isManaged && <TryEnvHavenCard />}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[11px] text-muted-foreground">
          <button
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
            onClick={handleOpenDocs}
          >
            <ExternalLink className="h-3 w-3" /> Docs
          </button>
        </div>
      </footer>
    </div>
  );
}

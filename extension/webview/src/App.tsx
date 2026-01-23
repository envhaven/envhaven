import { useEffect } from 'react';

import { vscode, type ExtensionToWebviewMessage } from './lib/vscode';
import { useWorkspaceStore } from './stores/workspace-store';
import { ToolLauncher } from './components/tool-launcher';
import { TerminalsPanel } from './components/terminals-panel';
import { WorkspaceInfo, SshSection, TryEnvHavenCard, VersionSection } from './components/workspace-info';
import { Skeleton } from './components/ui/skeleton';
import { Separator } from './components/ui/separator';

export default function App() {
  const { isLoading, setWorkspace, workspace, setPortUpdateStatus, updateTerminals } = useWorkspaceStore();

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
  }, [setWorkspace, setPortUpdateStatus, updateTerminals]);

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
    <div className="flex h-full flex-col p-3">
      <main className="flex-1 space-y-5">
        <TerminalsPanel />
        <ToolLauncher />
        <WorkspaceInfo />
      </main>

      <footer className="mt-auto pt-4 space-y-3">
        <Separator />
        
        {!isManaged && <VersionSection />}
        
        <SshSection />
        
        {!isManaged && <TryEnvHavenCard />}

        <div className="flex gap-3 pt-1">
          <button
            className="text-[11px] text-link hover:underline"
            onClick={handleOpenDocs}
          >
            Docs
          </button>
        </div>
      </footer>
    </div>
  );
}

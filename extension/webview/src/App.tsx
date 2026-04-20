import { useEffect } from 'react';

import { ArrowUpCircle, Cloud, ExternalLink, Plug } from 'lucide-react';
import { vscode, type ExtensionToWebviewMessage } from './lib/vscode';
import { useWorkspaceStore, YOUNG_WORKSPACE_MAX_AGE_SEC } from './stores/workspace-store';
import { ToolLauncher } from './components/tool-launcher';
import { TerminalsPanel } from './components/terminals-panel';
import { ResourcesPanel } from './components/resources-panel';
import { WorkspaceInfo } from './components/workspace-info';
import { SkillsPanel } from './components/skills-panel';
import { OnboardingCard } from './components/onboarding-card';
import { SshSheet } from './components/ssh-sheet';
import { ProcessSheet } from './components/process-sheet';
import { SkillsSheet } from './components/skills-sheet';
import { AiToolsSheet } from './components/ai-tools-sheet';
import { FooterChip } from './components/ui/footer-chip';
import { Skeleton } from './components/ui/skeleton';

export default function App() {
  const {
    isLoading,
    setWorkspace,
    workspace,
    setPortUpdateStatus,
    updateTerminals,
    setResources,
    setOpenSheet,
    setInstalledSkills,
    setSkillSearchResults,
    setInstallInFlight,
    setRemoveInFlight,
    setSkillMarkdown,
    setSshKeyOp,
    markDocsOpened,
    isFreshWorkspace,
    getWorkspaceAgeSec,
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
        case 'updateInstalledSkills':
          if (message.installedSkills) {
            setInstalledSkills(message.installedSkills);
          }
          break;
        case 'skillSearchResult':
          if (typeof message.query === 'string' && message.results) {
            setSkillSearchResults(message.query, message.results, message.error);
          }
          break;
        case 'skillMarkdownResult':
          if (message.source && message.skillId) {
            const key = `${message.source}/${message.skillId}`;
            setSkillMarkdown(key, message.markdown, message.frontmatter, message.error);
          }
          break;
        case 'skillInstallComplete':
          if (message.source && message.skillId) {
            const key = `${message.source}/${message.skillId}`;
            setInstallInFlight(key, false);
          }
          break;
        case 'skillRemoveComplete':
          if (message.skillName) {
            setRemoveInFlight(message.skillName, false);
          }
          break;
        case 'sshKeyResult':
          if (message.sshKeyOpSource && typeof message.success === 'boolean') {
            setSshKeyOp(message.sshKeyOpSource, {
              status: message.success ? 'success' : 'error',
              error: message.error,
              lastTs: Date.now(),
            });
          }
          break;
        case 'openSheet':
          if (message.sheet) setOpenSheet(message.sheet);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    vscode.postMessage({ command: 'ready' });

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [
    setWorkspace,
    setPortUpdateStatus,
    updateTerminals,
    setResources,
    setInstalledSkills,
    setSkillSearchResults,
    setInstallInFlight,
    setRemoveInFlight,
    setSkillMarkdown,
    setSshKeyOp,
    setOpenSheet,
  ]);

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
  const sshEnabled = !!workspace?.sshEnabled;
  const updateAvailable = !!workspace?.version?.updateAvailable;
  const currentVersion = workspace?.version?.current ?? null;
  const latestVersion = workspace?.version?.latest ?? null;

  const isFresh = isFreshWorkspace();
  const ageSec = getWorkspaceAgeSec();
  // When age is unknown (marker missing), err on the side of the "older user"
  // UX: hide first-run chips rather than nag an established user.
  const isYoungWorkspace = ageSec !== null && ageSec < YOUNG_WORKSPACE_MAX_AGE_SEC;
  const showTryChip = !isManaged && isYoungWorkspace;
  const showDocsChip = isYoungWorkspace;

  const handleOpenDocs = () => {
    markDocsOpened();
    vscode.postMessage({ command: 'openDocs' });
  };

  const handleOpenPlatform = () => {
    vscode.postMessage({ command: 'openPlatform' });
  };

  const handleCopyPullCommand = () => {
    vscode.postMessage({
      command: 'copyToClipboard',
      text: 'docker pull ghcr.io/envhaven/envhaven:latest',
    });
  };

  return (
    <div className="flex h-full flex-col p-3 pb-3">
      <main className="flex-1 space-y-5">
        {isFresh ? (
          <>
            <OnboardingCard />
            <TerminalsPanel />
            <ToolLauncher />
          </>
        ) : (
          <>
            <TerminalsPanel />
            <ToolLauncher />
            <WorkspaceInfo />
            <ResourcesPanel />
            <SkillsPanel />
          </>
        )}
      </main>

      <footer className="mt-auto flex flex-wrap items-center gap-1 pt-4">
        {sshEnabled && !isFresh && (
          <FooterChip
            icon={<Plug className="h-3 w-3" />}
            onClick={() => setOpenSheet('ssh')}
          >
            SSH
          </FooterChip>
        )}

        {updateAvailable && !isManaged && (
          <FooterChip
            icon={<ArrowUpCircle className="h-3 w-3" />}
            onClick={handleCopyPullCommand}
            variant="warning"
            title={`Update: ${currentVersion} → ${latestVersion}\nClick to copy docker pull command`}
          >
            {currentVersion}→{latestVersion}
          </FooterChip>
        )}

        {showTryChip && (
          <FooterChip
            icon={<Cloud className="h-3 w-3" />}
            onClick={handleOpenPlatform}
          >
            Try EnvHaven Managed
          </FooterChip>
        )}

        {showDocsChip && (
          <FooterChip
            icon={<ExternalLink className="h-3 w-3" />}
            onClick={handleOpenDocs}
          >
            Docs
          </FooterChip>
        )}
      </footer>

      <SshSheet />
      <ProcessSheet />
      <SkillsSheet />
      <AiToolsSheet />
    </div>
  );
}

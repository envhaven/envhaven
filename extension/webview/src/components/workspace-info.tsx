import { useState, useEffect } from 'react';
import { Copy, Key, Check, ChevronRight, Github, ExternalLink, Pencil, ArrowUpCircle } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardContent } from './ui/card';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { cn } from '../lib/utils';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode } from '../lib/vscode';

function PreviewSection({ url, isOnline }: { url: string; isOnline: boolean }) {
  const { workspace, optimisticSetPort, portUpdateStatus } = useWorkspaceStore();
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  const currentPort = workspace?.exposedPort || 3000;

  useEffect(() => {
    if (portUpdateStatus === 'success') {
      setShowSuccess(true);
      const timer = setTimeout(() => setShowSuccess(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [portUpdateStatus]);

  const handleCopy = () => {
    vscode.postMessage({ command: 'copyToClipboard', text: url });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleEditClick = () => {
    setEditValue(currentPort.toString());
    setIsEditing(true);
    setShowSuccess(false);
  };

  const handlePortSave = () => {
    const port = parseInt(editValue, 10);
    if (!isNaN(port) && port >= 1024 && port <= 65535 && port !== currentPort) {
      optimisticSetPort(port);
      vscode.postMessage({ command: 'updatePreviewPort', port });
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handlePortSave();
    if (e.key === 'Escape') setIsEditing(false);
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md p-3 transition-all duration-500",
        isOnline
          ? "border border-success/20 bg-success/5 shadow-sm"
          : "bg-muted"
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Preview
          </span>

          {isOnline && (
            <div className="flex items-center gap-1.5 animate-in fade-in zoom-in duration-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              <span className="text-[10px] font-bold tracking-wide text-success hidden sm:inline-block">
                LIVE
              </span>
            </div>
          )}
        </div>

        <div className="flex gap-0.5">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-6 w-6 shrink-0 transition-colors",
                    isOnline 
                      ? "text-success/70 hover:bg-success/10 hover:text-success" 
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={handleCopy}
                >
                  {copied ? (
                    <Check className="h-3 w-3 text-success" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy URL</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-6 w-6 shrink-0 transition-colors",
                    isOnline 
                      ? "text-success/70 hover:bg-success/10 hover:text-success" 
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  asChild
                >
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open in Browser</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className="relative group mb-3">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "block truncate font-mono text-xs transition-all duration-300",
                  isOnline
                    ? "font-medium text-foreground underline decoration-success/30 decoration-dashed underline-offset-4 hover:decoration-success hover:decoration-solid"
                    : "text-muted-foreground hover:text-foreground hover:underline"
                )}
              >
                {url.replace('https://', '')}
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {isOnline
                ? "Your app is public! Click to open."
                : "Start dev server to activate."}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className="flex items-center justify-between rounded-sm bg-background/40 px-2 py-1.5 border border-border/5">
        <span className="text-[10px] text-muted-foreground">App Port</span>
        
        <div className="relative group/port">
          {isEditing ? (
            <Input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handlePortSave}
              onKeyDown={handleKeyDown}
              className="h-5 w-[50px] rounded-sm px-1 py-0 text-center font-mono text-[10px] font-medium shadow-sm focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-offset-0"
            />
          ) : (
            <TooltipProvider>
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleEditClick}
                    className={cn(
                      "flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-[10px] transition-all duration-200",
                      showSuccess 
                        ? "bg-success/20 text-success" 
                        : "bg-background/50 text-foreground hover:bg-background hover:shadow-sm cursor-pointer border border-transparent hover:border-border/20"
                    )}
                  >
                    <span className="font-mono font-medium">{currentPort}</span>
                    <Pencil className="h-2.5 w-2.5 opacity-50" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  Change exposed port
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      {!isOnline && (
        <div className="mt-2 flex items-center gap-1.5 animate-in fade-in slide-in-from-top-1 duration-500">
           <div className="h-1 w-1 rounded-full bg-muted-foreground/40" />
           <span className="text-[10px] text-muted-foreground/70">
             Start dev server on port <span className="font-mono">{currentPort}</span> to go live
           </span>
        </div>
      )}
    </div>
  );
}

function GitHubKeysInput() {
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleImport = () => {
    const trimmed = username.trim().replace(/^@/, '');
    if (!trimmed) return;
    setLoading(true);
    vscode.postMessage({ command: 'importGitHubKeys', username: trimmed });
    setTimeout(() => {
      setLoading(false);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    }, 1000);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleImport();
  };

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="text"
        placeholder="GitHub username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1 text-[10px] placeholder:text-muted-foreground/70"
      />
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-sm"
              onClick={handleImport}
              disabled={!username.trim() || loading}
            >
              {success ? <Check className="h-3.5 w-3.5 text-success" /> : <Github className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Import keys from GitHub</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function SshKeyInput() {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    const trimmed = value.trim();
    if (!trimmed || !trimmed.startsWith('ssh-')) return;
    vscode.postMessage({ command: 'setSshKey', sshPublicKey: trimmed });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
  };

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="text"
        placeholder="ssh-ed25519 AAAA..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1 font-mono text-[10px] placeholder:text-muted-foreground/70"
      />
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-sm"
              onClick={handleSave}
              disabled={!value.trim().startsWith('ssh-')}
            >
              {saved ? <Check className="h-3.5 w-3.5 text-success" /> : <Key className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add to authorized_keys</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export function SshSection() {
  const { workspace } = useWorkspaceStore();
  const [isOpen, setIsOpen] = useState(false);

  if (!workspace?.sshEnabled || !workspace.sshCommand) return null;

  const subdomain = workspace.hostname.replace(/^ssh-/, '').replace(/\.envhaven\.app$/, '');
  const havenCommand = workspace.isManaged
    ? `haven connect . ${subdomain}`
    : `haven connect . abc@${workspace.hostname}:${workspace.sshPort}`;

  const handleCopy = () => {
    vscode.postMessage({ command: 'copySshCommand', tool: havenCommand });
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button
          className="flex w-full items-center justify-between rounded-sm px-1 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground group transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <ChevronRight
              className={`h-3.5 w-3.5 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
            />
            Remote Access
          </span>
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent className="collapsible-content overflow-hidden">
        <div className="space-y-3 pt-2 pb-1">
          <div className="flex items-start gap-1.5">
            <code
              className="flex-1 min-w-0 break-all rounded-sm bg-muted px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground"
              title={havenCommand}
            >
              {havenCommand}
            </code>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={handleCopy}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy Haven command</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          {!workspace.sshConfigured && (
            <p className="text-[10px] text-yellow-600 dark:text-yellow-500">
              Set <span className="font-mono">ENVHAVEN_SSH_HOST</span> for correct command
            </p>
          )}

          <div className="space-y-2">
            <div className="space-y-1">
              <span className="text-[10px] text-muted-foreground">Import public keys from GitHub</span>
              <GitHubKeysInput />
            </div>
            <div className="space-y-1">
              <span className="text-[10px] text-muted-foreground">Or paste a public key directly</span>
              <SshKeyInput />
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function TryEnvHavenCard() {
  const handleGetStarted = () => {
    vscode.postMessage({ command: 'openPlatform' });
  };

  return (
    <Card className="text-center">
      <CardContent className="space-y-2 p-4">
        <p className="text-xs text-muted-foreground">Running locally</p>
        <Button variant="default" className="w-full" onClick={handleGetStarted}>
          Try EnvHaven
        </Button>
        <p className="text-[11px] text-muted-foreground">Zero setup. Public URLs. Always on.</p>
      </CardContent>
    </Card>
  );
}

export function VersionSection() {
  const { workspace } = useWorkspaceStore();

  if (!workspace?.version?.updateAvailable) return null;

  const { current, latest } = workspace.version;

  const handleCopyPullCommand = () => {
    vscode.postMessage({ 
      command: 'copyToClipboard', 
      text: 'docker pull ghcr.io/envhaven/envhaven:latest' 
    });
  };

  return (
    <div className="rounded-md p-3 border border-amber-500/30 bg-amber-500/10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowUpCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          <span className="text-[10px] font-medium text-amber-700 dark:text-amber-400">
            Update available
          </span>
        </div>
        
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="font-mono text-[10px]">{current}</span>
          <span className="text-[10px]">→</span>
          <span className="font-mono text-[10px] font-medium text-amber-600 dark:text-amber-400">{latest}</span>
        </div>
      </div>

      <div className="mt-2 space-y-1.5">
        <p className="text-[10px] text-amber-700 dark:text-amber-400">
          {workspace.isManaged 
            ? "Update available in your dashboard at envhaven.com"
            : "New version available!"
          }
        </p>
        {!workspace.isManaged && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleCopyPullCommand}
                  className="flex items-center gap-1.5 rounded-sm bg-background/50 px-2 py-1 font-mono text-[10px] text-foreground hover:bg-background transition-colors"
                >
                  <span>docker pull ghcr.io/envhaven/envhaven:latest</span>
                  <Copy className="h-2.5 w-2.5 opacity-50" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Copy pull command</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}

export function WorkspaceInfo() {
  const { workspace } = useWorkspaceStore();

  if (!workspace?.isManaged || !workspace.previewUrl) return null;

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-section-header">
        Workspace
      </h3>

      <PreviewSection url={workspace.previewUrl} isOnline={workspace.previewPortOpen} />
      <VersionSection />
    </div>
  );
}

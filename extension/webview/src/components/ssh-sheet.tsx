import { useEffect, useState } from 'react';
import { Copy, Key, Check, Github, ArrowLeft, ArrowUpRight, Info, Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode } from '../lib/vscode';

/**
 * Single-line, monospaced shell command with a thin horizontal scrollbar for
 * overflow affordance and a copy button attached on the right edge.
 *
 * Important: the `<code>` element MUST explicitly set `bg-transparent`.
 * Browser user-agent stylesheets paint `<code>` with a default background
 * color that overrides nothing in Tailwind — it renders on top of the
 * wrapper's bg and creates the "different tone in the middle" artifact.
 */
function CommandBlock({ command, copyLabel }: { command: string; copyLabel: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    vscode.postMessage({ command: 'copySshCommand', text: command });
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-stretch overflow-hidden rounded-sm border border-border bg-input">
      <div className="relative min-w-0 flex-1">
        <div className="code-scroll overflow-x-auto overflow-y-hidden">
          <code
            className="inline-block whitespace-pre bg-transparent pl-2 pr-8 py-1.5 font-mono text-xs leading-relaxed text-foreground"
            title={command}
          >
            {command}
          </code>
        </div>
        {/* Scroll affordance. Using CSS relative-color syntax so both stops
            are the same bg color with only alpha varying — avoids the dark
            midpoint that `transparent → color` produces in sRGB interpolation. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-8"
          style={{
            background:
              'linear-gradient(to right, rgb(from var(--color-input) r g b / 0), var(--color-input))',
          }}
        />
      </div>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleCopy}
              className="flex shrink-0 items-center justify-center border-l border-border bg-transparent px-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={copyLabel}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">{copyLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function CommandLabel({ children, info }: { children: React.ReactNode; info: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </span>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex h-4 w-4 items-center justify-center text-muted-foreground/60 hover:text-foreground"
              aria-label="What is this?"
            >
              <Info className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            align="start"
            collisionPadding={12}
            className="max-w-[200px] text-xs leading-relaxed"
          >
            {info}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

// Auto-clear the success indicator this long after a completed op. Decoupled
// from any request timing — it only affects how long the green check lingers.
const SSH_KEY_SUCCESS_LINGER_MS = 2000;

function GitHubKeysInput() {
  const { sshKeyOps, setSshKeyOp } = useWorkspaceStore();
  const op = sshKeyOps.github;
  const [username, setUsername] = useState('');

  useEffect(() => {
    if (op.status !== 'success') return;
    const t = setTimeout(
      () => setSshKeyOp('github', { status: 'idle' }),
      SSH_KEY_SUCCESS_LINGER_MS
    );
    return () => clearTimeout(t);
  }, [op.status, op.lastTs, setSshKeyOp]);

  const handleImport = () => {
    const trimmed = username.trim().replace(/^@/, '');
    if (!trimmed) return;
    setSshKeyOp('github', { status: 'loading' });
    vscode.postMessage({ command: 'importGitHubKeys', username: trimmed });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleImport();
  };

  const isLoading = op.status === 'loading';
  const isSuccess = op.status === 'success';

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="text"
        placeholder="GitHub username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1 text-xs placeholder:text-muted-foreground/70"
        disabled={isLoading}
      />
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-sm"
              onClick={handleImport}
              disabled={!username.trim() || isLoading}
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : isSuccess ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Github className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Import keys from GitHub</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function SshKeyInput() {
  const { sshKeyOps, setSshKeyOp } = useWorkspaceStore();
  const op = sshKeyOps.paste;
  const [value, setValue] = useState('');

  useEffect(() => {
    if (op.status !== 'success') return;
    const t = setTimeout(
      () => setSshKeyOp('paste', { status: 'idle' }),
      SSH_KEY_SUCCESS_LINGER_MS
    );
    return () => clearTimeout(t);
  }, [op.status, op.lastTs, setSshKeyOp]);

  const handleSave = () => {
    const trimmed = value.trim();
    if (!trimmed || !trimmed.startsWith('ssh-')) return;
    setSshKeyOp('paste', { status: 'loading' });
    vscode.postMessage({ command: 'setSshKey', sshPublicKey: trimmed });
    setValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
  };

  const isLoading = op.status === 'loading';
  const isSuccess = op.status === 'success';

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="text"
        placeholder="ssh-ed25519 AAAA..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1 font-mono text-xs placeholder:text-muted-foreground/70"
        disabled={isLoading}
      />
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-sm"
              onClick={handleSave}
              disabled={!value.trim().startsWith('ssh-') || isLoading}
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : isSuccess ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Key className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add to authorized_keys</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export function SshSheet() {
  const { workspace, openSheet, setOpenSheet } = useWorkspaceStore();
  const open = openSheet === 'ssh';

  if (!workspace) return null;

  const subdomain = workspace.hostname.replace(/^ssh-/, '').replace(/\.envhaven\.app$/, '');
  const havenCommand = workspace.isManaged
    ? `haven connect . ${subdomain}`
    : `haven connect . abc@${workspace.hostname}:${workspace.sshPort}`;

  // Mirror the format produced by `get_ssh_string` in /opt/envhaven/bin/envhaven.
  const sshCommand =
    workspace.sshCommand ??
    (workspace.sshPort === 22
      ? `ssh abc@${workspace.hostname}`
      : `ssh abc@${workspace.hostname} -p ${workspace.sshPort}`);

  return (
    <Sheet open={open} onOpenChange={(v) => setOpenSheet(v ? 'ssh' : null)}>
      <SheetContent className="flex min-w-0 flex-col">
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
            <SheetTitle className="flex-1">Remote Access</SheetTitle>
          </div>
          <SheetDescription className="pl-8">
            Connect to this workspace from your local machine.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <div className="min-w-0 space-y-5 px-4 pb-4 [&>*:first-child]:mt-4">
            <div className="space-y-1.5">
              <CommandLabel
                info={
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-foreground">
                      <span className="font-semibold">Local editor</span>
                      <span className="text-muted-foreground">↔</span>
                      <span className="font-semibold">Remote AI</span>
                    </div>
                    <p>
                      Edit in{' '}
                      <span className="font-medium text-foreground">vim, zed, vscode</span>{' '}
                      locally while{' '}
                      <span className="font-medium text-foreground">
                        Claude Code, Codex, OpenCode
                      </span>{' '}
                      run extended sessions on the workspace. Files sync both ways in{' '}
                      <span className="font-medium text-foreground">~200ms</span>.
                    </p>
                    <p>
                      Plus: run any remote command like{' '}
                      <span className="rounded-sm bg-muted px-1 py-px font-mono text-[10px]">
                        haven npm start
                      </span>
                      .
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        vscode.postMessage({
                          command: 'openToolDocs',
                          url: 'https://github.com/envhaven/envhaven/blob/master/cli/README.md',
                        })
                      }
                      className="inline-flex items-center gap-1 text-link underline-offset-4 hover:underline"
                    >
                      Setup Guide
                      <ArrowUpRight className="h-3 w-3" />
                    </button>
                  </div>
                }
              >
                Haven CLI
              </CommandLabel>
              <CommandBlock command={havenCommand} copyLabel="Copy Haven command" />
            </div>

            <div className="space-y-1.5">
              <CommandLabel
                info={
                  <>
                    Direct shell access. Run commands in the workspace from your local terminal.
                    Useful for ad-hoc work or when you don&apos;t need file sync.
                  </>
                }
              >
                SSH
              </CommandLabel>
              <CommandBlock command={sshCommand} copyLabel="Copy SSH command" />
              {!workspace.sshConfigured && (
                <p className="text-[11px] text-yellow-600 dark:text-yellow-500">
                  Set <span className="font-mono">ENVHAVEN_SSH_HOST</span> on the host for the
                  correct hostname.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <CommandLabel
                info={
                  <>
                    Imports every public key from{' '}
                    <span className="font-mono">github.com/&lt;username&gt;.keys</span> into{' '}
                    <span className="font-mono">~/.ssh/authorized_keys</span>.
                  </>
                }
              >
                Import keys from GitHub
              </CommandLabel>
              <GitHubKeysInput />
            </div>

            <div className="space-y-1.5">
              <CommandLabel
                info={
                  <>
                    Appends the key to <span className="font-mono">~/.ssh/authorized_keys</span>.
                    Paste any <span className="font-mono">ssh-ed25519</span>,{' '}
                    <span className="font-mono">ssh-rsa</span>, or{' '}
                    <span className="font-mono">ecdsa-*</span> public key.
                  </>
                }
              >
                Or paste a public key
              </CommandLabel>
              <SshKeyInput />
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

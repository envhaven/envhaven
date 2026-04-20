import { useState } from 'react';
import { ExternalLink, Check, ChevronRight, EllipsisVertical, Info, LogOut } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { Separator } from './ui/separator';
import { Section, SectionHeader, SectionBody } from './ui/section';
import { Row } from './ui/row';
import { StatusDot } from './ui/status-dot';
import { ToolIcon } from './tool-icons';
import { AgentAvatars } from './agent-avatars';
import { cn } from '../lib/utils';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode, type AITool, type EnvVarMeta } from '../lib/vscode';

// Fallback shown for env vars not listed in tool-definitions.json's envVarMeta
// block. Should be rare — adding a new provider means editing that JSON.
const DEFAULT_META: EnvVarMeta = { placeholder: 'Paste key...', hint: '', url: null };

function ApiKeyInput({ envVar, onSaved }: { envVar: string; onSaved?: () => void }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const metaMap = useWorkspaceStore((s) => s.workspace?.envVarMeta);
  const meta = metaMap?.[envVar] ?? DEFAULT_META;

  const handleSave = () => {
    if (!value.trim()) return;
    vscode.postMessage({ command: 'setApiKey', envVar, apiKey: value.trim() });
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onSaved?.();
    }, 1500);
    setValue('');
  };

  return (
    <div className="px-2 py-1.5">
      <label className="mb-1 block text-[11px] font-medium leading-none text-muted-foreground">
        {envVar}
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          type="password"
          placeholder={meta.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          className="h-7 flex-1 px-2 font-mono text-xs"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={handleSave}
          disabled={!value.trim()}
        >
          <Check className={cn('h-3.5 w-3.5', saved && 'text-success')} />
        </Button>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  if (meta.url) vscode.postMessage({ command: 'openToolDocs', url: meta.url });
                }}
              >
                <Info className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-[220px]">
              <p className="text-xs font-medium">{envVar}</p>
              {meta.hint && (
                <p className="text-xs text-muted-foreground">
                  {meta.hint.split(/(`[^`]+`)/).map((part, i) =>
                    part.startsWith('`') && part.endsWith('`')
                      ? <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{part.slice(1, -1)}</code>
                      : part
                  )}
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

export function ToolRow({ tool }: { tool: AITool }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isReady = tool.authStatus === 'ready';
  const isApiKeyOnly = !isReady && !tool.authCommand;
  const hasEnvVars = tool.envVars && tool.envVars.length > 0;

  const handleRowClick = () => {
    if (isReady) {
      vscode.postMessage({ command: 'runTool', toolName: tool.name, toolCommand: tool.command });
    } else if (tool.authCommand) {
      vscode.postMessage({ command: 'runTool', toolName: tool.name, toolCommand: tool.authCommand });
    } else {
      setMenuOpen(true);
    }
  };

  const label = (
    <div className="flex items-center gap-2 min-w-0">
      <span className="truncate font-medium">{tool.name}</span>
      {!isReady && (
        <span className="hidden shrink-0 text-[10px] text-muted-foreground group-hover:inline">
          {isApiKeyOnly ? 'Set key' : 'Sign in'}
        </span>
      )}
    </div>
  );

  const trailing = (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <StatusDot variant={isReady ? 'success' : 'idle'} />
          </TooltipTrigger>
          <TooltipContent>
            {isReady ? (tool.connectedVia ? `${tool.connectedVia} is set` : 'Ready') : 'Needs setup'}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <EllipsisVertical className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-72 p-1"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              vscode.postMessage({ command: 'openToolDocs', url: tool.docsUrl });
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
          >
            <ExternalLink className="h-4 w-4" />
            Documentation
          </button>

          {!isReady && hasEnvVars && (
            <>
              <Separator className="my-1" />
              {tool.envVars!.map((envVar) => (
                <ApiKeyInput key={envVar} envVar={envVar} onSaved={() => setMenuOpen(false)} />
              ))}
            </>
          )}

          {isReady && (
            <>
              <Separator className="my-1" />
              <button
                onClick={() => {
                  vscode.postMessage({ command: 'signOutTool', toolId: tool.id });
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </>
          )}
        </PopoverContent>
      </Popover>
    </>
  );

  return (
    <Row
      onClick={handleRowClick}
      bordered
      className="h-9"
      leading={<ToolIcon id={tool.id} className="h-4 w-4" />}
      label={label}
      trailing={trailing}
    />
  );
}

function AiToolsEmptyState({
  toolNames,
  onBrowse,
}: {
  toolNames: string[];
  onBrowse: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border/50 px-4 py-5 text-center">
      <AgentAvatars agents={toolNames} size="md" max={3} />
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-foreground">Sign in to an AI tool</p>
        <p className="text-[11px] text-muted-foreground">
          All {toolNames.length} are built-in.
        </p>
      </div>
      <Button variant="default" size="sm" className="h-7 gap-1 text-xs" onClick={onBrowse}>
        Browse tools
        <ChevronRight className="h-3 w-3" />
      </Button>
    </div>
  );
}

export function ToolLauncher() {
  const { workspace, getConnectedTools, getDisconnectedTools, setOpenSheet } = useWorkspaceStore();

  if (!workspace) return null;

  const connectedTools = getConnectedTools();
  const disconnectedTools = getDisconnectedTools();

  if (connectedTools.length === 0 && disconnectedTools.length === 0) return null;

  const manageAction = (
    <Button
      variant="ghost"
      size="sm"
      className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
      onClick={() => setOpenSheet('tools')}
    >
      Manage
      <ChevronRight className="h-3 w-3" />
    </Button>
  );

  return (
    <Section data-section="ai-tools">
      <SectionHeader title="AI Tools" action={manageAction} />
      {connectedTools.length === 0 ? (
        <AiToolsEmptyState
          toolNames={workspace.aiTools.map((t) => t.name)}
          onBrowse={() => setOpenSheet('tools')}
        />
      ) : (
        <SectionBody>
          {connectedTools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </SectionBody>
      )}
    </Section>
  );
}

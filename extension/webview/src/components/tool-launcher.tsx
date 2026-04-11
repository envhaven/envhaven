import { useState, useEffect } from 'react';
import { ExternalLink, Check, ChevronRight, EllipsisVertical, Info } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { Separator } from './ui/separator';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { ToolIcon } from './tool-icons';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode, type AITool } from '../lib/vscode';

interface EnvVarMeta {
  placeholder: string;
  hint: string;
  url: string | null;
}

const ENV_VAR_META: Record<string, EnvVarMeta> = {
  ANTHROPIC_API_KEY: {
    placeholder: 'sk-ant-...',
    hint: 'Pay-per-use. Get key at console.anthropic.com',
    url: 'https://console.anthropic.com/settings/keys',
  },
  CLAUDE_CODE_OAUTH_TOKEN: {
    placeholder: 'sk-ant-oat01-...',
    hint: 'Uses your Claude subscription. Run `claude setup-token` locally to generate.',
    url: null,
  },
  OPENAI_API_KEY: {
    placeholder: 'sk-...',
    hint: 'Pay-per-use. Get key at platform.openai.com',
    url: 'https://platform.openai.com/api-keys',
  },
  GEMINI_API_KEY: {
    placeholder: 'AIza...',
    hint: 'Free tier available. Get key at aistudio.google.com',
    url: 'https://aistudio.google.com/apikey',
  },
  GOOGLE_API_KEY: {
    placeholder: 'AIza...',
    hint: 'Same format as GEMINI_API_KEY. Get key at aistudio.google.com',
    url: 'https://aistudio.google.com/apikey',
  },
  OPENROUTER_API_KEY: {
    placeholder: 'sk-or-...',
    hint: 'Unified API for hundreds of models. Get key at openrouter.ai',
    url: 'https://openrouter.ai/keys',
  },
  MISTRAL_API_KEY: {
    placeholder: 'Paste key...',
    hint: 'Pay-per-use. Get key at console.mistral.ai',
    url: 'https://console.mistral.ai/api-keys',
  },
  AMP_API_KEY: {
    placeholder: 'Paste token...',
    hint: 'Access token from ampcode.com settings',
    url: 'https://ampcode.com/settings',
  },
  AUGMENT_SESSION_AUTH: {
    placeholder: 'Paste session JSON...',
    hint: 'Run `auggie login` then `auggie token print` to generate.',
    url: null,
  },
  FACTORY_API_KEY: {
    placeholder: 'Paste key...',
    hint: 'Get key from your Factory account at app.factory.ai',
    url: 'https://app.factory.ai',
  },
  QWEN_API_KEY: {
    placeholder: 'Paste key...',
    hint: 'Get key from Alibaba Cloud DashScope console',
    url: 'https://dashscope.console.aliyun.com',
  },
};

const DEFAULT_META: EnvVarMeta = { placeholder: 'Paste key...', hint: '', url: null };

function ApiKeyInput({ envVar, onSaved }: { envVar: string; onSaved?: () => void }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const meta = ENV_VAR_META[envVar] || DEFAULT_META;

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
          {saved ? <Check className="h-3.5 w-3.5 text-success" /> : <Check className="h-3.5 w-3.5" />}
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

function ToolRow({ tool }: { tool: AITool }) {
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

  return (
    <div
      onClick={handleRowClick}
      className="group flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-muted/30 px-2 hover:bg-accent"
    >
      <ToolIcon id={tool.id} className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate text-sm font-medium">{tool.name}</span>

      {!isReady && (
        <span className="hidden text-[10px] text-muted-foreground group-hover:inline">
          {isApiKeyOnly ? 'Set key' : 'Sign in'}
        </span>
      )}

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`h-2 w-2 shrink-0 rounded-full ${isReady ? 'bg-success' : 'bg-muted-foreground/40'}`} />
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
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function ToolLauncher() {
  const { workspace, getConnectedTools, getDisconnectedTools } = useWorkspaceStore();

  const connectedTools = workspace ? getConnectedTools() : [];
  const disconnectedTools = workspace ? getDisconnectedTools() : [];
  const [isOpen, setIsOpen] = useState(connectedTools.length === 0);

  useEffect(() => {
    if (connectedTools.length > 0) setIsOpen(false);
  }, [connectedTools.length]);

  if (!workspace) return null;
  if (connectedTools.length === 0 && disconnectedTools.length === 0) return null;

  const hasConnectedTools = connectedTools.length > 0;

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-section-header">
        AI Tools
      </h3>

      <div className="space-y-1">
        {connectedTools.map((tool) => (
          <ToolRow key={tool.id} tool={tool} />
        ))}

        {hasConnectedTools && disconnectedTools.length > 0 ? (
          <Collapsible open={isOpen} onOpenChange={setIsOpen}>
            <CollapsibleTrigger asChild>
              <button className="flex w-full items-center justify-between rounded-sm px-1 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors cursor-pointer">
                <span className="flex items-center gap-1.5">
                  <ChevronRight
                    className={`h-3.5 w-3.5 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
                  />
                  More Tools ({disconnectedTools.length})
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="collapsible-content overflow-hidden">
              <div className="space-y-1 pt-1">
                {disconnectedTools.map((tool) => (
                  <ToolRow key={tool.id} tool={tool} />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          disconnectedTools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))
        )}
      </div>
    </div>
  );
}

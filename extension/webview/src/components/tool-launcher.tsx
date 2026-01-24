import { useState, useEffect } from 'react';
import { Settings, ExternalLink, Zap, Copy, SquareTerminal, Key, Check, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { Separator } from './ui/separator';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { ToolIcon } from './tool-icons';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode, type AITool, type SetupStep } from '../lib/vscode';

function ApiKeyInput({ envVar }: { envVar: string }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    if (!value.trim()) return;
    vscode.postMessage({ command: 'setApiKey', envVar, apiKey: value.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    }
  };

  return (
    <div className="flex items-center gap-1 px-2 py-1">
      <Key className="h-3 w-3 shrink-0 text-muted-foreground" />
      <Input
        type="password"
        placeholder={envVar}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        className="h-6 flex-1 px-1.5 font-mono"
      />
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0"
              onClick={handleSave}
              disabled={!value.trim()}
            >
              {saved ? <Check className="h-3 w-3 text-success" /> : <Check className="h-3 w-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Save to shell config</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function SetupStepItem({ step, tool }: { step: SetupStep; tool: AITool }) {
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (step.command) {
      vscode.postMessage({ command: 'copyToClipboard', text: step.command });
    }
  };

  const handleRun = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (step.command) {
      vscode.postMessage({
        command: 'runSetupCommand',
        toolName: tool.name,
        setupCommand: step.command,
      });
    }
  };

  if (step.command) {
    return (
      <div className="flex items-center gap-1 px-2 py-1">
        <code className="code-scroll flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {step.command}
        </code>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0"
                onClick={handleCopy}
              >
                <Copy className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0"
                onClick={handleRun}
              >
                <SquareTerminal className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run in Terminal</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }

  return (
    <div className="px-2 py-1 text-xs text-muted-foreground">{step.instruction}</div>
  );
}

function ToolRow({ tool }: { tool: AITool }) {
  const { workspace } = useWorkspaceStore();
  const isReady = tool.authStatus === 'ready';
  const isOpenCode = tool.id === 'opencode';
  const showOhMyOpenCodeTip = isOpenCode && !workspace?.hasOhMyOpenCode;
  const hasSetupSteps = !isReady && tool.setupSteps && tool.setupSteps.length > 0;
  const hasEnvVars = !isReady && tool.envVars && tool.envVars.length > 0;

  const handleRowClick = () => {
    vscode.postMessage({
      command: 'runTool',
      toolName: tool.name,
      toolCommand: tool.command,
    });
  };

  const handleOpenDocs = () => {
    vscode.postMessage({ command: 'openToolDocs', url: tool.docsUrl });
  };

  const handleInstallOhMyOpenCode = () => {
    vscode.postMessage({ command: 'installOhMyOpenCode' });
  };

  return (
    <div
      onClick={handleRowClick}
      className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-muted/30 px-2 hover:bg-accent"
    >
      <ToolIcon id={tool.id} className="h-4 w-4 shrink-0" />

      <span className="flex-1 truncate text-sm font-medium">{tool.name}</span>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                isReady ? 'bg-success' : 'bg-muted-foreground/40'
              }`}
            />
          </TooltipTrigger>
          <TooltipContent>
            {isReady
              ? tool.connectedVia
                ? `${tool.connectedVia} is set`
                : 'Ready'
              : 'Needs setup'}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-64 p-1"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleOpenDocs}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
          >
            <ExternalLink className="h-4 w-4" />
            Open Documentation
          </button>

          {hasEnvVars && (
            <>
              <Separator className="my-1" />
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                Set API Key
              </div>
              {tool.envVars!.map((envVar) => (
                <ApiKeyInput key={envVar} envVar={envVar} />
              ))}
            </>
          )}

          {hasSetupSteps && (
            <>
              <Separator className="my-1" />
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                Alternative Setup
              </div>
              {tool.setupSteps!.map((step, i) => (
                <SetupStepItem key={i} step={step} tool={tool} />
              ))}
            </>
          )}

          {showOhMyOpenCodeTip && (
            <>
              <Separator className="my-1" />
              <button
                onClick={handleInstallOhMyOpenCode}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              >
                <Zap className="h-4 w-4 text-yellow-500" />
                Install oh-my-opencode
              </button>
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

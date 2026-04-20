import { Avatar, AvatarFallback } from './ui/avatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { ToolIcon } from './tool-icons';
import { cn } from '../lib/utils';
import { useWorkspaceStore } from '../stores/workspace-store';

interface AgentAvatarsProps {
  agents: string[];
  size?: 'sm' | 'md';
  max?: number;
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<AgentAvatarsProps['size']>, string> = {
  sm: 'h-5 w-5',
  md: 'h-6 w-6',
};
const ICON_SIZE_CLASSES: Record<NonNullable<AgentAvatarsProps['size']>, string> = {
  sm: 'h-3 w-3',
  md: 'h-3.5 w-3.5',
};

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function AgentAvatars({ agents, size = 'sm', max = 4, className }: AgentAvatarsProps) {
  // `aiTools` is the single source for display-name → tool-id resolution —
  // populated from tool-definitions.json on the extension side, so this map
  // can't drift from the icon set.
  const aiTools = useWorkspaceStore((s) => s.workspace?.aiTools);

  if (agents.length === 0) return null;

  const lookupId = (agentName: string): string | null =>
    aiTools?.find((t) => t.name === agentName)?.id ?? null;

  const visible = agents.slice(0, max);
  const overflow = agents.length - visible.length;
  const avatarSize = SIZE_CLASSES[size];
  const iconSize = ICON_SIZE_CLASSES[size];

  return (
    <TooltipProvider delayDuration={200}>
      <div className={cn('flex -space-x-1.5', className)}>
        {visible.map((agent) => {
          const toolId = lookupId(agent);
          return (
            <Tooltip key={agent}>
              <TooltipTrigger asChild>
                <Avatar className={cn(avatarSize, 'ring-1 ring-background')}>
                  <AvatarFallback className="bg-muted">
                    {toolId ? (
                      <ToolIcon id={toolId} className={iconSize} />
                    ) : (
                      <span className="text-[9px]">{initials(agent)}</span>
                    )}
                  </AvatarFallback>
                </Avatar>
              </TooltipTrigger>
              <TooltipContent side="top">{agent}</TooltipContent>
            </Tooltip>
          );
        })}
        {overflow > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Avatar className={cn(avatarSize, 'ring-1 ring-background')}>
                <AvatarFallback className="bg-muted text-[9px] font-medium text-muted-foreground">
                  +{overflow}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent side="top">{agents.slice(max).join(', ')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}

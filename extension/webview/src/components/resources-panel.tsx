import { ChevronRight } from 'lucide-react';
import { Section, SectionHeader } from './ui/section';
import { Button } from './ui/button';
import { Progress } from './ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { useWorkspaceStore } from '../stores/workspace-store';
import { thresholdColor } from '../lib/thresholds';

function ResourceBar({
  label,
  pct,
  tooltip,
}: {
  label: string;
  pct: number;
  tooltip: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const rounded = Math.round(clamped);
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2.5">
            <span className="w-10 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {label}
            </span>
            <Progress
              value={clamped}
              indicatorStyle={{ backgroundColor: thresholdColor(clamped) }}
              className="h-1.5 flex-1"
            />
            <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
              {rounded}%
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-xs">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ResourcesPanel() {
  const resources = useWorkspaceStore((s) => s.resources);
  const setOpenSheet = useWorkspaceStore((s) => s.setOpenSheet);
  if (!resources) return null;

  const total = resources.processes.length;
  const label = total === 1 ? 'Process' : 'Processes';
  const ramTotalGb = (resources.ram.totalMb / 1024).toFixed(1);
  const ramUsedGb = (resources.ram.usedMb / 1024).toFixed(1);
  const diskUsedGb = resources.disk.usedGb.toFixed(1);
  const diskTotalGb = resources.disk.totalGb.toFixed(1);

  return (
    <Section>
      <SectionHeader
        title="Resources"
        action={
          <Button
            variant="ghost"
            size="sm"
            className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => setOpenSheet('process')}
          >
            {total} {label}
            <ChevronRight className="h-3 w-3" />
          </Button>
        }
      />
      <div className="space-y-1.5">
        <ResourceBar
          label="CPU"
          pct={resources.cpu.pct}
          tooltip={`${resources.cpu.nCpus} vCPU`}
        />
        <ResourceBar
          label="RAM"
          pct={resources.ram.pct}
          tooltip={`${ramUsedGb} / ${ramTotalGb} GB`}
        />
        <ResourceBar
          label="DISK"
          pct={resources.disk.pct}
          tooltip={`${diskUsedGb} / ${diskTotalGb} GB`}
        />
      </div>
    </Section>
  );
}

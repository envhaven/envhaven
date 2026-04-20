import { FileText, ExternalLink, EllipsisVertical, Loader2, ChevronRight } from 'lucide-react';
import { Section, SectionHeader, SectionBody } from './ui/section';
import { Row } from './ui/row';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from './ui/dropdown-menu';
import { useWorkspaceStore } from '../stores/workspace-store';
import { vscode, type InstalledSkill } from '../lib/vscode';

// Note: removal is delegated to the store's `removeSkill` action so both
// this panel and the SkillsSheet "Installed" tab share a single path.

function SkillRow({
  skill,
  onRemove,
  removing,
}: {
  skill: InstalledSkill;
  onRemove: (name: string) => void;
  removing: boolean;
}) {
  const handleOpenMd = () => {
    if (removing) return;
    vscode.postMessage({ command: 'openSkillInEditor', skillPath: skill.path });
  };

  const trailing = removing ? (
    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 opacity-60 hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <EllipsisVertical className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleOpenMd}>
          <ExternalLink className="h-3.5 w-3.5" />
          View SKILL.md
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          onClick={(e) => {
            e.stopPropagation();
            onRemove(skill.name);
          }}
        >
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Row
      onClick={handleOpenMd}
      interactive={!removing}
      className={removing ? 'opacity-60' : undefined}
      leading={<FileText className="h-3.5 w-3.5 text-muted-foreground" />}
      label={skill.name}
      trailing={trailing}
    />
  );
}

export function SkillsPanel() {
  const { installedSkills, setOpenSheet, skillRemoving, removeSkill } = useWorkspaceStore();

  const browseAction = (
    <Button
      variant="ghost"
      size="sm"
      className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
      onClick={() => setOpenSheet('skills')}
    >
      Browse
      <ChevronRight className="h-3 w-3" />
    </Button>
  );

  if (installedSkills.length === 0) {
    return (
      <Section>
        <SectionHeader title="Skills" action={browseAction} />
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title="No skills installed"
          description="Skills extend your AI agent with specialized knowledge."
          action={
            <Button
              variant="secondary"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setOpenSheet('skills')}
            >
              Browse skills
            </Button>
          }
        />
      </Section>
    );
  }

  const scroll = installedSkills.length >= 8;

  return (
    <Section>
      <SectionHeader title="Skills" action={browseAction} />
      <SectionBody {...(scroll ? { maxHeight: '300px', className: 'pr-1' } : {})}>
        {installedSkills.map((s) => (
          <SkillRow
            key={s.name}
            skill={s}
            onRemove={removeSkill}
            removing={!!skillRemoving[s.name]}
          />
        ))}
      </SectionBody>
    </Section>
  );
}

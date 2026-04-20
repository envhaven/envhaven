import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Search,
  FileText,
  ArrowDownToLine,
  ExternalLink,
  ArrowLeft,
  Loader2,
} from 'lucide-react';
import { AgentAvatars } from './agent-avatars';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { useWorkspaceStore } from '../stores/workspace-store';
import {
  vscode,
  type InstalledSkill,
  type SkillsShResult,
} from '../lib/vscode';

const POPULAR_QUERIES = ['react', 'typescript', 'design', 'docker', 'review', 'testing'];

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}K`;
  return String(n);
}

const SKILL_KEY = (source: string, skillId: string) => `${source}/${skillId}`;

interface DetailTarget {
  source: string;
  skillId: string;
  name: string;
  installs?: number;
  description?: string;
}

function SkillResultCard({
  result,
  installed,
  onOpen,
  onInstall,
  onRemove,
}: {
  result: SkillsShResult;
  installed: boolean;
  onOpen: (t: DetailTarget) => void;
  onInstall: (t: DetailTarget) => void;
  onRemove: (name: string) => void;
}) {
  const target: DetailTarget = {
    source: result.source,
    skillId: result.skillId,
    name: result.name,
    installs: result.installs,
  };
  const { skillInstalling } = useWorkspaceStore();
  const installing = !!skillInstalling[SKILL_KEY(result.source, result.skillId)];

  return (
    <button
      onClick={() => onOpen(target)}
      className="group flex w-full min-w-0 flex-col gap-1 overflow-hidden rounded-md border border-border bg-muted/20 p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/50"
    >
      <div className="flex w-full min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{result.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground">
          <ArrowDownToLine className="h-3 w-3" />
          {formatInstalls(result.installs)}
        </div>
      </div>
      <div className="flex w-full min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {result.source}
        </span>
        {installed ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 text-[10px]"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(result.name);
            }}
          >
            Installed
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            className="h-6 shrink-0 text-[10px]"
            disabled={installing}
            onClick={(e) => {
              e.stopPropagation();
              onInstall(target);
            }}
          >
            {installing ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Installing
              </>
            ) : (
              'Install'
            )}
          </Button>
        )}
      </div>
    </button>
  );
}

function InstalledCard({
  skill,
  onRemove,
}: {
  skill: InstalledSkill;
  onRemove: (name: string) => void;
}) {
  const { skillRemoving } = useWorkspaceStore();
  const removing = !!skillRemoving[skill.name];
  const handleOpenMd = () => {
    vscode.postMessage({ command: 'openSkillInEditor', skillPath: skill.path });
  };
  return (
    <div
      className={
        'flex w-full min-w-0 flex-col gap-1 overflow-hidden rounded-md border border-border bg-muted/20 p-3' +
        (removing ? ' opacity-60' : '')
      }
    >
      <div className="flex w-full min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{skill.name}</span>
        </div>
        {skill.source && (
          <span className="shrink-0 text-[10px] text-muted-foreground">{skill.source}</span>
        )}
      </div>
      {skill.description && (
        <p className="text-[11px] text-muted-foreground line-clamp-2">{skill.description}</p>
      )}
      <div className="flex w-full min-w-0 items-center justify-between gap-2">
        <AgentAvatars agents={skill.agents} size="sm" max={4} />
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px]"
            onClick={handleOpenMd}
            disabled={removing}
          >
            View SKILL.md
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] text-destructive hover:bg-destructive/10"
            onClick={() => onRemove(skill.name)}
            disabled={removing}
          >
            {removing ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Removing
              </>
            ) : (
              'Remove'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-base font-semibold text-foreground">{children as ReactNode}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-sm font-semibold text-foreground">{children as ReactNode}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-xs font-semibold text-foreground">{children as ReactNode}</h3>
  ),
  p: ({ children }) => (
    <p className="my-2 text-xs leading-relaxed text-foreground/90">{children as ReactNode}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-2 ml-4 list-disc space-y-1 text-xs">{children as ReactNode}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-4 list-decimal space-y-1 text-xs">{children as ReactNode}</ol>
  ),
  li: ({ children }) => (
    <li className="text-xs leading-relaxed text-foreground/90">{children as ReactNode}</li>
  ),
  code: ({ children, className }) => {
    const isBlock = /language-/.test(className ?? '');
    if (isBlock) {
      return <code className="font-mono text-[11px]">{children as ReactNode}</code>;
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
        {children as ReactNode}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="code-scroll my-2 overflow-x-auto rounded-md bg-muted p-2 text-[11px]">
      {children as ReactNode}
    </pre>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-link underline-offset-4 hover:underline"
    >
      {children as ReactNode}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border bg-quote-background py-1 pl-3 text-xs italic">
      {children as ReactNode}
    </blockquote>
  ),
};

function SkillDetail({
  target,
  installed,
  installing,
  onBack,
  onInstall,
  onRemove,
}: {
  target: DetailTarget;
  installed: boolean;
  installing: boolean;
  onBack: () => void;
  onInstall: (t: DetailTarget) => void;
  onRemove: (name: string) => void;
}) {
  const key = SKILL_KEY(target.source, target.skillId);
  const { skillMarkdown, setSkillMarkdownLoading } = useWorkspaceStore();
  const entry = skillMarkdown[key];

  useEffect(() => {
    if (!entry) {
      setSkillMarkdownLoading(key);
      vscode.postMessage({
        command: 'fetchSkillMarkdown',
        source: target.source,
        skillId: target.skillId,
      });
    }
  }, [key, entry, setSkillMarkdownLoading, target.source, target.skillId]);

  const handleOpenOnSkillsSh = () => {
    vscode.postMessage({
      command: 'openToolDocs',
      url: `https://skills.sh/${target.source}/${target.skillId}`,
    });
  };

  const handleOpenOnGithub = () => {
    vscode.postMessage({
      command: 'openToolDocs',
      url: `https://github.com/${target.source}`,
    });
  };

  const description = entry?.frontmatter?.description;

  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={onBack}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <SheetTitle className="min-w-0 flex-1 break-words">{target.name}</SheetTitle>
        </div>
      </SheetHeader>

      <div className="space-y-3 border-b border-border px-4 py-3">
        {/* Meta bar. `flex-wrap` lets long sources break onto a new line
            without stealing room from the installs counter. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className="break-all font-mono">{target.source}</span>
          {typeof target.installs === 'number' && (
            <>
              <span className="shrink-0 text-muted-foreground/40">·</span>
              <span className="shrink-0 font-mono tabular-nums">
                {formatInstalls(target.installs)} installs
              </span>
            </>
          )}
        </div>

        {/* Description from frontmatter — full text, no clamp. */}
        {description && (
          <p className="text-[13px] leading-snug text-foreground/90">{description}</p>
        )}

        {/* Primary action — only shown when not installed, owns the row. */}
        {!installed && (
          <Button
            variant="default"
            size="sm"
            className="h-8 w-full text-xs"
            disabled={installing}
            onClick={() => onInstall(target)}
          >
            {installing ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Installing
              </>
            ) : (
              'Install'
            )}
          </Button>
        )}

        {/* Meta-actions row. Remove sits left as a peer of skills.sh / GitHub
            links — same size, same weight, just destructive-tinted. When not
            installed, only the right-side link-outs render. */}
        <div className="flex items-center justify-between gap-4 text-[11px]">
          {installed ? (
            <button
              onClick={() => onRemove(target.name)}
              className="inline-flex items-center gap-1 text-destructive/80 transition-colors hover:text-destructive"
            >
              Remove
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-4">
            <button
              onClick={handleOpenOnSkillsSh}
              className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              skills.sh
              <ExternalLink className="h-3 w-3" />
            </button>
            <button
              onClick={handleOpenOnGithub}
              className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              GitHub
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
        {/* Markdown's leading h1/h2 carries its own mt-4 — we let that act as
            the natural gap against the header divider. Non-markdown states
            (loading / error / empty) are plain divs with no inherent margin,
            so each carries an explicit pt-3. `:last-child:mb-0` prevents the
            closing margin from stacking on top of the container's pb-3. */}
        <div className="min-w-0 px-4 pb-3 [&>*:last-child]:mb-0">
          {entry?.loading ? (
            <div className="flex items-center gap-2 pt-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading SKILL.md…
            </div>
          ) : entry?.error ? (
            <div className="space-y-1 pt-3">
              <p className="text-xs text-destructive">Couldn't load SKILL.md: {entry.error}</p>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={handleOpenOnSkillsSh}
              >
                <ExternalLink className="h-3 w-3" />
                View on skills.sh
              </Button>
            </div>
          ) : entry?.content ? (
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={MARKDOWN_COMPONENTS}
            >
              {entry.content}
            </Markdown>
          ) : (
            <div className="pt-3 text-xs text-muted-foreground">No content.</div>
          )}
        </div>
      </div>
    </>
  );
}

function BrowseEmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="space-y-3 py-8">
      <p className="text-center text-xs text-muted-foreground">Type to search skills.sh</p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {POPULAR_QUERIES.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="rounded-full border border-border bg-muted/20 px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent/50 hover:text-foreground"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SkillsSheet() {
  const {
    openSheet,
    setOpenSheet,
    installedSkills,
    skillsSearchResults,
    skillsSearchError,
    skillInstalling,
    setInstallInFlight,
    removeSkill,
  } = useWorkspaceStore();

  const isOpen = openSheet === 'skills';
  const [tab, setTab] = useState<'browse' | 'installed'>('browse');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!isOpen) {
      setDetail(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    if (skillsSearchResults[trimmed]) return;
    debounceRef.current = setTimeout(() => {
      vscode.postMessage({ command: 'searchSkills', query: trimmed });
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, skillsSearchResults]);

  const installedNames = new Set(installedSkills.map((s) => s.name));

  const handleInstall = (t: DetailTarget) => {
    const key = SKILL_KEY(t.source, t.skillId);
    setInstallInFlight(key, true);
    vscode.postMessage({
      command: 'installSkill',
      source: t.source,
      skillId: t.skillId,
    });
  };


  const trimmed = query.trim();
  const results = trimmed.length >= 2 ? skillsSearchResults[trimmed] : undefined;

  return (
    <Sheet open={isOpen} onOpenChange={(v) => setOpenSheet(v ? 'skills' : null)}>
      <SheetContent className="flex min-w-0 flex-col p-0">
        {detail ? (
          <SkillDetail
            target={detail}
            installed={installedNames.has(detail.name)}
            installing={!!skillInstalling[SKILL_KEY(detail.source, detail.skillId)]}
            onBack={() => setDetail(null)}
            onInstall={handleInstall}
            onRemove={removeSkill}
          />
        ) : (
          <>
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
                <SheetTitle className="flex-1">Browse Skills</SheetTitle>
              </div>
            </SheetHeader>
            <div className="space-y-3 px-4 py-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  placeholder="Search skills…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <Tabs value={tab} onValueChange={(v) => setTab(v as 'browse' | 'installed')}>
                <TabsList>
                  <TabsTrigger value="browse">Browse</TabsTrigger>
                  <TabsTrigger value="installed">Installed ({installedSkills.length})</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {tab === 'browse' ? (
              <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden border-t border-border">
                <div className="space-y-2 px-4 pb-3 [&>*:first-child]:mt-3">
                  {trimmed.length < 2 ? (
                    <BrowseEmptyState onPick={setQuery} />
                  ) : results === undefined ? (
                    <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground justify-center">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Searching skills.sh…
                    </div>
                  ) : results.length === 0 ? (
                    <div className="py-8 text-center text-xs text-muted-foreground">
                      {skillsSearchError
                        ? `Search failed: ${skillsSearchError}`
                        : `No skills match "${trimmed}". Try a different term.`}
                    </div>
                  ) : (
                    results.map((r) => (
                      <SkillResultCard
                        key={r.id}
                        result={r}
                        installed={installedNames.has(r.name)}
                        onOpen={setDetail}
                        onInstall={handleInstall}
                        onRemove={removeSkill}
                      />
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden border-t border-border">
                <div className="space-y-2 px-4 pb-3 [&>*:first-child]:mt-3">
                  {installedSkills.length === 0 ? (
                    <EmptyState
                      icon={<FileText className="h-6 w-6" />}
                      title="No skills installed"
                      description="Install a skill from the Browse tab."
                    />
                  ) : (
                    installedSkills.map((s) => (
                      <InstalledCard
                        key={s.name}
                        skill={s}
                        onRemove={removeSkill}
                      />
                    ))
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

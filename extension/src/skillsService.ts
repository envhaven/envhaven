import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { TOOL_DEFINITIONS } from './environment';

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SKILLS_SH_API = 'https://skills.sh/api/search';
const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Resolve the `npx skills add -a <agent>` id for a tool. Source of truth is
 * the `skillsAgent` field in tool-definitions.json. Tools without that field
 * (e.g. aider) aren't wired up on skills.sh and get reported as unsupported
 * at install time.
 */
function mapToolIdToSkillsAgent(toolId: string): string | null {
  const def = TOOL_DEFINITIONS.find((t) => t.id === toolId);
  return def?.skillsAgent ?? null;
}

// NOTE: these 3 interfaces are mirrored in extension/webview/src/lib/vscode.ts
// because the webview bundle (Vite) can't import from the extension bundle
// (esbuild) without cross-project tsconfig plumbing that isn't worth it for
// 3 small shapes. If you add/remove a field here, update the mirror.
export interface InstalledSkill {
  name: string;
  description: string;
  source: string | null;
  path: string;
  agents: string[];
}

export interface SkillsShResult {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  source?: string;
  license?: string;
}

const FRONTMATTER_BLOCK_RE = /^---\s*\n[\s\S]*?\n---\s*\n?/;
const FRONTMATTER_BODY_RE = /^---\s*\n([\s\S]*?)\n---/;

export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const match = markdown.match(FRONTMATTER_BODY_RE);
  if (!match) return {};
  const body = match[1];
  const out: SkillFrontmatter = {};
  for (const line of body.split('\n')) {
    const kv = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === 'name' || key === 'description' || key === 'source' || key === 'license') {
      out[key] = value;
    }
  }
  return out;
}

/** Remove the leading `---...---` block so the rendered body doesn't print the raw frontmatter. */
export function stripSkillFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_BLOCK_RE, '');
}

/**
 * List installed skills via the authoritative `npx skills ls -g --json` CLI.
 *
 * The CLI owns the notion of "where skills live" — per agent (e.g.
 * `~/.claude/skills/`, `~/.config/opencode/skills/`, …) plus any legacy
 * canonical paths. It dedupes by skill `name` and reports the agents each
 * skill is linked into. We enrich each entry by reading the returned
 * `SKILL.md` for the frontmatter description + source.
 */
export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  const res = await runNpxSkills(['ls', '-g', '--json']);
  if (res.code !== 0) {
    console.warn('envhaven: `npx skills ls -g --json` failed', {
      code: res.code,
      stderr: res.stderr.slice(0, 500),
    });
    return [];
  }
  let rows: Array<{ name: string; path: string; scope?: string; agents?: string[] }>;
  try {
    rows = JSON.parse(res.stdout);
  } catch (err) {
    console.warn('envhaven: failed to parse `npx skills ls` output as JSON', err, {
      stdoutHead: res.stdout.slice(0, 200),
    });
    return [];
  }
  const skills: InstalledSkill[] = rows.map((row) => {
    let description = '';
    let source: string | null = null;
    try {
      const md = fs.readFileSync(path.join(row.path, 'SKILL.md'), 'utf-8');
      const fm = parseSkillFrontmatter(md);
      description = fm.description ?? '';
      source = fm.source ?? null;
    } catch (err) {
      console.warn(`envhaven: skill SKILL.md unreadable at ${row.path}`, err);
    }
    return {
      name: row.name,
      description,
      source,
      path: row.path,
      agents: row.agents ?? [],
    };
  });
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

const searchCache = new Map<string, { results: SkillsShResult[]; ts: number }>();

export async function searchSkillsSh(query: string): Promise<SkillsShResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const cached = searchCache.get(q);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) {
    return cached.results;
  }

  const url = `${SKILLS_SH_API}?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`skills.sh search failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { skills?: SkillsShResult[] };
  const results = Array.isArray(data.skills) ? data.skills : [];
  searchCache.set(q, { results, ts: Date.now() });
  return results;
}

export interface InstallResult {
  ok: boolean;
  agents: string[];
  unsupportedAgents: string[];
  error?: string;
  output?: string;
}

export async function installSkill(
  source: string,
  skillId: string,
  connectedToolIds: string[]
): Promise<InstallResult> {
  const agents: string[] = [];
  const unsupportedAgents: string[] = [];
  for (const id of connectedToolIds) {
    const mapped = mapToolIdToSkillsAgent(id);
    if (mapped) agents.push(mapped);
    else unsupportedAgents.push(id);
  }
  if (agents.length === 0) {
    return {
      ok: false,
      agents: [],
      unsupportedAgents,
      error: 'No authenticated tools are supported by skills.sh',
    };
  }
  // Canonical syntax per vercel-labs/skills README:
  //   npx skills add <source> --skill <id> [--skill <id>...] --full-depth -g -a <agent> -y
  // The `<source>@<id>` shorthand isn't documented and fails when the skill's
  // SKILL.md lives below the repo root (CLI defaults to root-only traversal).
  // `--full-depth` makes the CLI walk into subdirectories; `--skill` resolves
  // the specific SKILL.md frontmatter `name` to install.
  const args = [
    'add',
    source,
    '--skill',
    skillId,
    '--full-depth',
    '-g',
    '-y',
  ];
  for (const a of agents) args.push('-a', a);
  const res = await runNpxSkills(args);
  if (res.code === 0) {
    return { ok: true, agents, unsupportedAgents, output: res.stdout };
  }
  return {
    ok: false,
    agents,
    unsupportedAgents,
    error: res.stderr.slice(0, 500) || res.stdout.slice(-500) || `exit ${res.code}`,
  };
}

/**
 * Remove a skill via `npx skills remove <dir>`. The CLI matches by the skill's
 * directory basename (e.g. `react-components`), NOT the frontmatter `name`
 * (which can be arbitrary like `react:components`). Pass the path returned by
 * `listInstalledSkills` and we derive the basename here — anything else will
 * silently 404 inside the CLI.
 */
export async function removeSkill(skillPath: string): Promise<{ ok: boolean; error?: string }> {
  const dirName = path.basename(skillPath.replace(/\/+$/, ''));
  if (!dirName) {
    return { ok: false, error: `invalid skill path: ${skillPath}` };
  }
  const res = await runNpxSkills(['remove', dirName, '-g', '-y']);
  if (res.code === 0) return { ok: true };
  return { ok: false, error: res.stderr.slice(0, 500) || `exit ${res.code}` };
}

// ---------------------------------------------------------------------------
// SKILL.md preview fetch
//
// skills.sh doesn't expose a public content endpoint; the page server-renders
// markdown inline into RSC flight chunks that we can't safely scrape. Source
// of truth = the upstream GitHub repo.
//
// The `skillId` returned by skills.sh search is the frontmatter `name`, not
// the directory basename — e.g. `vercel-react-best-practices` lives at
// `skills/react-best-practices/SKILL.md`. So we can't path-match blindly.
// Strategy:
//   1. Fetch the repo tree (1 API call) to enumerate all SKILL.md paths.
//   2. Fast path: if any path ends with `/${skillId}/SKILL.md`, fetch its raw.
//   3. Fallback: fetch all SKILL.md files via raw.githubusercontent.com in
//      parallel, parse each frontmatter, match by `name === skillId`.
// Raw URLs don't count against the 60/hour unauthenticated API limit, so the
// fallback is cheap even on repos with 20+ skills.
// ---------------------------------------------------------------------------

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';
const MAX_SKILL_MD_CANDIDATES = 30;

const markdownCache = new Map<string, { content: string; ts: number }>();

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchRawSkillMd(source: string, filePath: string): Promise<string> {
  const url = `${GITHUB_RAW_BASE}/${source}/HEAD/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`raw fetch failed: HTTP ${res.status}`);
  }
  return res.text();
}

export async function fetchSkillMarkdown(source: string, skillId: string): Promise<string> {
  const key = `${source}/${skillId}`;
  const cached = markdownCache.get(key);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) {
    return cached.content;
  }

  // 1. Enumerate all SKILL.md paths in the repo.
  const url = `${GITHUB_API_BASE}/repos/${source}/git/trees/HEAD?recursive=1`;
  const res = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`GitHub tree fetch failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    tree?: Array<{ path: string; type: string }>;
    truncated?: boolean;
  };
  const skillMdPaths = (data.tree ?? [])
    .filter((e) => e.type === 'blob' && e.path.endsWith('SKILL.md'))
    .map((e) => e.path);

  // 2. Fast path: skillId matches a directory basename.
  const direct = skillMdPaths.find(
    (p) => p.endsWith(`/${skillId}/SKILL.md`) || p === `${skillId}/SKILL.md`
  );
  if (direct) {
    const content = await fetchRawSkillMd(source, direct);
    markdownCache.set(key, { content, ts: Date.now() });
    return content;
  }

  // 3. Fallback: skillId is a frontmatter `name` that doesn't match any dir
  //    basename (common on skills.sh — e.g. "vercel-react-best-practices"
  //    lives at "skills/react-best-practices/SKILL.md"). Fetch each SKILL.md
  //    via the raw host in parallel and match by frontmatter name.
  const cappedPaths = skillMdPaths.slice(0, MAX_SKILL_MD_CANDIDATES);
  const capHit = skillMdPaths.length > MAX_SKILL_MD_CANDIDATES;
  const candidates = await Promise.all(
    cappedPaths.map(async (p) => {
      try {
        const raw = await fetchRawSkillMd(source, p);
        return { path: p, name: parseSkillFrontmatter(raw).name, content: raw };
      } catch {
        return null;
      }
    })
  );
  const winner = candidates.find(
    (c): c is { path: string; name: string | undefined; content: string } =>
      c !== null && c.name === skillId
  );
  if (!winner) {
    // Be explicit about both failure modes so the user can act on them — a
    // truncated tree (>100k files) means we can't enumerate, and a candidate
    // cap hit means the target might be further down the list.
    const reason = data.truncated
      ? 'repo tree truncated'
      : capHit
        ? `only searched first ${MAX_SKILL_MD_CANDIDATES} of ${skillMdPaths.length} SKILL.md files`
        : null;
    throw new Error(
      reason
        ? `SKILL.md for "${skillId}" not found in ${source} (${reason} — view on skills.sh)`
        : `SKILL.md for "${skillId}" not found in ${source}`
    );
  }
  markdownCache.set(key, { content: winner.content, ts: Date.now() });
  return winner.content;
}

interface NpxResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runNpxSkills(args: string[]): Promise<NpxResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['skills', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: String(err) }));
  });
}


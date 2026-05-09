import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const SESSIONS_FILE = 'data/sessions.json';
const LAST_RESET_FILE = 'data/last-reset.json';
const JOURNAL_DIR = 'data/journal';

// Word-count budgets per tier (powers of two). Tiers map to age in days:
// 1=0-6, 2=7-13, 3=14-20, 4=21-27. ≥28d → deleted. Budgets are MAX, not
// targets; sparse sessions can be much shorter, empty ones produce no file.
const TIER_BUDGETS: Record<number, number> = { 1: 512, 2: 256, 3: 128, 4: 64 };
const JOURNAL_DROP_DAYS = 28;

export function safeJid(jid: string): string {
  return jid.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function tierForAge(days: number): number | null {
  if (days < 0) return 1;
  if (days >= JOURNAL_DROP_DAYS) return null;
  return Math.floor(days / 7) + 1;
}

function daysAgo(dateStr: string, now: Date = new Date()): number {
  const d = new Date(`${dateStr}T00:00:00`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today.getTime() - d.getTime()) / 86_400_000);
}

type Frontmatter = { date: string; session: string; tier: number; summary?: string };

function parseFrontmatter(text: string): { fm: Frontmatter; body: string } | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm: Partial<Frontmatter> = {};
  for (const line of m[1]!.split('\n')) {
    const eq = line.indexOf(':');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k === 'date' || k === 'session' || k === 'summary') (fm as Record<string, string>)[k] = v;
    else if (k === 'tier') fm.tier = Number(v);
  }
  if (!fm.date || !fm.session || !fm.tier) return null;
  return { fm: fm as Frontmatter, body: m[2]!.trimStart() };
}

type SessionMap = Record<string, string>;

let sessions: SessionMap | null = null;

async function loadSessions(): Promise<SessionMap> {
  if (sessions) return sessions;
  try {
    const raw = await readFile(SESSIONS_FILE, 'utf-8');
    sessions = JSON.parse(raw) as SessionMap;
  } catch {
    sessions = {};
  }
  return sessions;
}

async function saveSessions(): Promise<void> {
  if (!sessions) return;
  await mkdir(dirname(SESSIONS_FILE), { recursive: true });
  await writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// Snapshot of jid → sessionId pairs for the orchestrator to iterate at flush
// time. Returns a copy; mutating it does not affect the bridge's live map.
export async function loadAllSessions(): Promise<Record<string, string>> {
  return { ...(await loadSessions()) };
}

export async function clearSession(jid: string): Promise<void> {
  const map = await loadSessions();
  if (jid in map) {
    delete map[jid];
    await saveSessions();
  }
}

export async function loadLastReset(): Promise<number> {
  try {
    const raw = await readFile(LAST_RESET_FILE, 'utf-8');
    return (JSON.parse(raw).timestamp as number | undefined) ?? 0;
  } catch {
    return 0;
  }
}

export async function saveLastReset(ts: number): Promise<void> {
  await mkdir(dirname(LAST_RESET_FILE), { recursive: true });
  await writeFile(LAST_RESET_FILE, JSON.stringify({ timestamp: ts, iso: new Date(ts).toISOString() }, null, 2));
}

export type AskOpts = { cwd?: string; model?: string; systemPromptAppend?: string };
type AskResult = { text: string; sessionId: string; cost: number; turns: number };

// Heuristic detector for "the session id you tried to resume isn't valid
// anymore" errors. The Agent SDK doesn't expose a typed error class for
// this; it surfaces either as an exception during iteration or as a
// non-success result event with the failure text in `errors`. We match a
// conservative pattern: "session" + a clearly-fatal qualifier. False
// positives just trigger one wasted retry; false negatives leave the
// existing "Claude stopped" error path intact.
function isSessionInvalidString(s: string): boolean {
  if (!/session/i.test(s)) return false;
  return /not\s*found|does\s*not\s*exist|invalid|unknown|expired|no\s*such/i.test(s);
}

export async function ask(jid: string, prompt: string, opts: AskOpts = {}): Promise<AskResult> {
  return askInner(jid, prompt, opts, 0);
}

async function askInner(jid: string, prompt: string, opts: AskOpts, attempt: number): Promise<AskResult> {
  const map = await loadSessions();
  const existing = map[jid];

  const sessionId = existing ?? randomUUID();
  if (!existing) {
    map[jid] = sessionId;
    await saveSessions();
  }

  const options = {
    cwd: opts.cwd,
    model: opts.model,
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    promptSuggestions: false,
    ...(opts.systemPromptAppend
      ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: opts.systemPromptAppend } }
      : {}),
    ...(existing ? { resume: existing } : { sessionId }),
  };

  let resultText = '';
  let cost = 0;
  let turns = 0;
  let finalSessionId = sessionId;
  // Set from either the throw or the result-error path; handled in one
  // place after the loop so the recovery branch isn't duplicated.
  let staleSession = false;

  try {
    const q = query({ prompt, options });
    for await (const msg of q) {
      if (msg.type === 'result') {
        finalSessionId = msg.session_id;
        cost = msg.total_cost_usd;
        turns = msg.num_turns;
        if (msg.subtype === 'success') {
          resultText = msg.result;
        } else {
          const errStr = `${msg.subtype} ${(msg.errors ?? []).join(' ')}`;
          if (existing && attempt === 0 && isSessionInvalidString(errStr)) {
            staleSession = true;
          } else {
            resultText = `⚠️ Claude stopped: ${msg.subtype}${msg.errors?.length ? `\n${msg.errors.join('\n')}` : ''}`;
          }
        }
        break;
      }
    }
  } catch (err) {
    if (existing && attempt === 0 && isSessionInvalidString(err instanceof Error ? err.message : String(err))) {
      staleSession = true;
    } else {
      throw err;
    }
  }

  if (staleSession) {
    console.warn(`[ask] stale session ${existing} for ${jid}; clearing and retrying with fresh session`);
    delete map[jid];
    await saveSessions();
    return askInner(jid, prompt, opts, 1);
  }

  if (finalSessionId && finalSessionId !== map[jid]) {
    map[jid] = finalSessionId;
    await saveSessions();
  }

  return { text: resultText || '(no response)', sessionId: finalSessionId, cost, turns };
}

function buildFlushPrompt(jid: string, sessionId: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const shortId = sessionId.replace(/-/g, '').slice(0, 8);
  const journalPath = resolve(JOURNAL_DIR, safeJid(jid), `${today}__${shortId}.md`);
  return `[SYSTEM MAINTENANCE; the user does not see this message]

This WhatsApp chat session is about to be reset for the scheduled daily flush. Do TWO things, in order:

# 1. Update durable surfaces (decision tree, no overlap)

Apply this tree to each fact worth carrying forward. Stop at the first match:

1. **Discussion-trace specific to THIS chat** (a topic discussed here, an entity mentioned in chat, a back-and-forth that mattered) → journal entry only (step 2 below). Stop.
2. **Who the user IS** (identity, role, language, tone, durable cross-channel preferences) → SOUL.md. Stop.
3. **Explicit "always do X / never do Y" guidance** the user gave → \`feedback\` auto-memory: a new file under the project's auto-memory dir following the prescribed shape (\`name\`/\`description\`/\`type: feedback\` frontmatter, body with rule + **Why:** + **How to apply:**). Stop.
4. **Project state spanning chats** (decisions, ongoing initiatives, deadlines, stakeholders, constraints) → \`project\` auto-memory. Stop.
5. **Pointer to an external system** (API endpoint, dashboard, channel, third-party service) → \`reference\` auto-memory. Stop.
6. **Bridge runtime config** (whitelist contents, daemons, restart commands, env vars affecting the bridge) → TOOLS.md. Stop.
7. **EnvHaven environment baseline** → CLAUDE.md. In practice this is hand-maintained; don't auto-edit unless the user explicitly asked.

**Anti-redundancy rule (mandatory).** Before writing anywhere, search for the fact:
- If it's already documented somewhere on this list, edit in place. Never append a duplicate.
- If you find the same fact in two places after applying the tree, the one further DOWN the list is the duplicate; remove it from the lower place.
- TOOLS.md is the **delta from CLAUDE.md**, not a re-listing. If CLAUDE.md already documents a tool/setting, do not repeat it in TOOLS.md unless this workspace's config genuinely differs.
- Don't restate things in the auto-memory MEMORY.md index; that's a one-line-per-entry pointer file, not a memory.

Edit existing sections in place; don't append. Add new sections only when the topic is genuinely new. Skip casual chat, things already covered, code in the repo, and one-off task state.

# 2. Write today's journal entry

Write a summary of THIS session's conversation to:

  ${journalPath}

Format the file EXACTLY like this:

---
date: ${today}
session: ${shortId}
tier: 1
summary: <one line, ≤80 chars, the gist of the session>
---

<your summary body here>

The body is a **budget of up to ${TIER_BUDGETS[1]} words; not a target**. Use only what's needed:
- Sparse / casual sessions: a few dozen words is plenty.
- If there was nothing substantive (greetings, one-off lookups, no decisions, no preferences expressed): **don't write the file at all**; just skip step 2 entirely.
- Substantive sessions (decisions, ongoing projects, named entities, unresolved threads): use up to the full budget if needed.

The \`summary:\` field is **mandatory** when you write the file. It's used in the journal injection's TOC view once this entry tiers out of full-body inclusion (≥15 days old); at that point it's the only thing future Claude sees about this session unless it explicitly Reads the file. Make it concrete: ≤80 chars, ground-truth gist, named entities preserved.

Capture in the body: topics discussed, decisions made, unresolved threads, references to people/places/things. Preserve named entities verbatim. Match the conversation's language (Spanish, English, etc.). Skip pure tool-execution traces unless results mattered.

Don't send a WhatsApp reply; this is internal. Edit files, write the journal (or skip), and end with one short line listing what you changed (or "nothing worth saving").`;
}

function buildCompactPrompt(absPath: string, fromTier: number, toTier: number): string {
  const budget = TIER_BUDGETS[toTier]!;
  const tocImportant = toTier >= 3
    ? `\n\nNOTE: at tier ${toTier} this entry will only be inlined into future system prompts as a TOC line (date + \`summary:\`). The body will not be visible unless Claude explicitly Reads this file. The \`summary:\` field carries this entry's load; make it concrete, ≤80 chars, named entities preserved.`
    : '';
  return `[SYSTEM; internal journal compaction, not visible to any user]

Compress the journal entry at:

  ${absPath}

It is currently at tier ${fromTier} (${TIER_BUDGETS[fromTier]}-word budget). Rewrite it to fit a tier-${toTier} budget of **up to ${budget} words**; use less if appropriate. Preserve: dates, named entities, decisions, unresolved threads. Drop: filler, examples that don't carry meaning, repetition. Keep all original frontmatter EXCEPT update \`tier\` to ${toTier}.

If \`summary:\` is missing from the frontmatter (older entries pre-dating the field), ADD a one-line summary (≤80 chars) capturing the gist; see the note below for why this matters.${tocImportant}

Read the file with Read, then write the compressed version back with Write. End with one short confirmation line.`;
}

async function compactJournalEntry(
  absPath: string,
  fromTier: number,
  toTier: number,
  opts: AskOpts,
): Promise<void> {
  // One-shot Claude call (no session resume); keeping each compaction
  // isolated avoids paying to re-send prior compactions' turns when several
  // entries cross tier boundaries in the same flush.
  const options = {
    cwd: opts.cwd,
    model: opts.model,
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    promptSuggestions: false,
    sessionId: randomUUID(),
    ...(opts.systemPromptAppend
      ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: opts.systemPromptAppend } }
      : {}),
  };
  const q = query({ prompt: buildCompactPrompt(absPath, fromTier, toTier), options });
  for await (const msg of q) {
    if (msg.type === 'result') {
      if (msg.subtype !== 'success') {
        throw new Error(`compaction failed: ${msg.subtype}`);
      }
      return;
    }
  }
}

async function ageJournalEntries(
  jid: string,
  opts: AskOpts,
): Promise<{ skipped: number; compacted: number; deleted: number }> {
  const dir = resolve(JOURNAL_DIR, safeJid(jid));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { skipped: 0, compacted: 0, deleted: 0 };
  }
  let skipped = 0, compacted = 0, deleted = 0;

  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const abs = resolve(dir, name);
    let raw: string;
    try {
      raw = await readFile(abs, 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;

    const age = daysAgo(parsed.fm.date);
    const target = tierForAge(age);

    if (target === null) {
      await unlink(abs);
      deleted++;
      continue;
    }
    if (parsed.fm.tier === target) {
      // Don't rehash entries already at their current budget; this is the
      // explicit cost-saver. In steady state most files hit this branch.
      skipped++;
      continue;
    }
    if (parsed.fm.tier > target) continue; // shouldn't happen; fast-forward only

    try {
      await compactJournalEntry(abs, parsed.fm.tier, target, opts);
      compacted++;
    } catch (err) {
      console.error(`[journal] compaction failed for ${abs}:`, err);
    }
  }

  return { skipped, compacted, deleted };
}

// Extract memory and write today's journal entry for a single chat, then
// clear that chat's session so the next message starts fresh. Atomic per
// JID; the orchestrator decides which chats to flush and serializes them
// through the same per-JID queue as user messages, so this never races
// against an inbound message.
export async function flushOneJid(
  jid: string,
  sessionId: string,
  opts: AskOpts,
): Promise<{ turns: number; reply: string }> {
  const r = await ask(jid, buildFlushPrompt(jid, sessionId), opts);
  await clearSession(jid);
  console.log(`[flush] ${jid}: ${r.turns} turns; ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`);
  return { turns: r.turns, reply: r.text };
}

// Age every JID's journal dir, regardless of whether it had a session
// today. A chat silent for a week still needs its older entries aged into
// lower tiers or deleted past 28 days.
export async function ageAllJournals(opts: AskOpts): Promise<void> {
  let allDirs: string[] = [];
  try {
    allDirs = await readdir(JOURNAL_DIR);
  } catch {
    return;
  }
  for (const safeJidName of allDirs) {
    const abs = resolve(JOURNAL_DIR, safeJidName);
    try {
      const s = await stat(abs);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    const r = await ageJournalEntries(safeJidName, opts);
    if (r.compacted || r.deleted) {
      console.log(`[journal] ${safeJidName}: skipped=${r.skipped} compacted=${r.compacted} deleted=${r.deleted}`);
    }
  }
}

import 'dotenv/config';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { startWhatsApp, type GroupAdd, type IncomingMessage, type WhatsAppHandle } from './whatsapp.ts';
import { ask, ageAllJournals, flushOneJid, loadAllSessions, loadLastReset, saveLastReset, safeJid, tierForAge, type AskOpts } from './claude.ts';
import { toWhatsApp, chunk } from './format.ts';
import { startCronScheduler, type CronEntry } from './crons.ts';

// uncaughtException → clean exit so the wrapper restarts with fresh state.
// unhandledRejection → log only; usually a stray un-awaited promise.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] terminating for clean restart:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const ENV_PATH = '.env';
const ALLOWED_GROUPS_FILE = 'data/allowed-groups.json';
const JOURNAL_DIR = 'data/journal';
const CWD = process.env.CLAUDE_CWD || process.cwd();
const MODEL = process.env.CLAUDE_MODEL || undefined;
const RESET_HOUR = Number(process.env.DAILY_RESET_HOUR ?? '5'); // local time
// IANA timezone for cron schedules. Empty/unset → system timezone (host's
// /etc/timezone), so a fresh install matches the operator's local time
// without extra config. Override only when the host clock differs from the
// timezone the user thinks in (e.g. UTC host, user in UY).
const CRON_TIMEZONE = process.env.CRON_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
const SOUL_PATH = resolve(CWD, 'SOUL.md');
const TOOLS_PATH = resolve(CWD, 'TOOLS.md');

// Re-read on every message so Claude can edit allowed-groups.json via its
// file tools and the change takes effect immediately; no restart.
function loadAllowedGroups(): Set<string> {
  try {
    const raw = readFileSync(ALLOWED_GROUPS_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveAllowedGroups(groups: Set<string>): void {
  mkdirSync(dirname(ALLOWED_GROUPS_FILE), { recursive: true });
  writeFileSync(ALLOWED_GROUPS_FILE, JSON.stringify([...groups], null, 2));
}

// Re-read role assignments from .env on every message so Claude can edit
// them (via its file tools) and the change takes effect immediately. Three
// role slots carry distinct authorities; getRole() returns the highest the
// sender matches (owner > full > restricted).
type Role = 'owner' | 'full' | 'restricted';
type RoleAssignment = { ownerLid: string; full: string[]; restricted: string[] };

function parseEnvList(raw: string, key: string): string[] {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    return trimmed
      .slice(eq + 1)
      .replace(/^["']|["']$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function readRoles(): RoleAssignment {
  let raw = '';
  try { raw = readFileSync(ENV_PATH, 'utf-8'); } catch { /* fall through */ }
  return {
    ownerLid: parseEnvList(raw, 'OWNER_LID')[0] ?? '',
    // BOOTSTRAP is the placeholder used during install before Step 7 captures
    // the real LID; filtered here so it never matches an actual sender.
    full: parseEnvList(raw, 'WHITELIST_NUMBERS').filter((v) => v !== 'BOOTSTRAP'),
    restricted: parseEnvList(raw, 'RESTRICTED_LIDS'),
  };
}

function getRole(lid: string, phone?: string): Role | null {
  const r = readRoles();
  const matches = (slot: string) => slot === lid || (!!phone && slot === phone);
  if (r.ownerLid && matches(r.ownerLid)) return 'owner';
  if (r.full.some(matches)) return 'full';
  if (r.restricted.some(matches)) return 'restricted';
  return null;
}

const initialRoles = readRoles();
const initialAny = [initialRoles.ownerLid, ...initialRoles.full, ...initialRoles.restricted].filter(Boolean);
if (initialAny.length === 0) {
  console.error('❌ All role slots empty in .env (OWNER_LID, WHITELIST_NUMBERS, RESTRICTED_LIDS). Refusing to start; every WhatsApp message would reach Claude.');
  console.error('   Add at least one LID. After someone messages the bot, their LID appears in the "Ignored message" log.');
  process.exit(1);
}

console.log(
  `Whitelist (initial): owner=${initialRoles.ownerLid || '(none)'} ` +
    `full=[${initialRoles.full.join(',')}] ` +
    `restricted=[${initialRoles.restricted.join(',')}]`,
);
console.log(`Working directory: ${CWD}`);
if (MODEL) console.log(`Model override: ${MODEL}`);

// Tight: only what Claude needs that ISN'T documented elsewhere. Bridge
// mechanics (groups, whitelist, daemon configs, restart commands) live in
// TOOLS.md; user identity in SOUL.md; project state in auto-memory. Repeating
// any of that here causes drift on every bridge feature change.
const SYSTEM_PROMPT_APPEND = `
You are reachable via WhatsApp through a bridge running from this workspace.
The user is on a phone; small screen, autocorrect, voice-to-text typos.

# Mobile UX

- Short chat-style replies. If a response would exceed ~10 lines or include
  big code blocks, summarize first, offer detail on request.
- For tasks > ~10s, send a one-line "working on X" first.
- Don't use slash-command syntax. Resolve "do X" by doing X directly.

# Bridge preprocessing (what arrives in your prompt)

- Media (images / videos / documents / stickers / voice notes): bracketed
  header with the absolute path, e.g. \`[image attached: /abs/path/abc.jpg]\`
  or \`[audio attached: /abs/path/voice.ogg]\`, then any caption on the next
  line. Use \`Read\` on the path (natively renders images, PDFs); for other
  formats use \`Bash\` (\`pdftotext\`, \`unzip\`, \`ffmpeg\`, etc.). Don't echo
  the path back. Files live in \`data/attachments/<jid>/\` and the bridge owns
  them; don't move or delete. If a download errored you'll see
  \`[error procesando mensaje: ...]\` instead.
- Voice notes have **no built-in transcription**. On \`[audio attached: …]\`,
  first check TOOLS.md → "Adjacent services" for a configured path; use it
  if present. If none, offer the user a tight install menu (don't lecture):
    1. **faster-whisper** (recommended; local, GPU, private, no API keys);
       installed as a sibling dir e.g. \`/config/.whisper/\`.
    2. Cloud alternative if no GPU: Groq Whisper or OpenAI Whisper API.
  Or skip and describe metadata only (\`ffprobe\` for size/duration). Once
  the user picks, install ad hoc per the host's installation protocol and
  **document the new service in TOOLS.md → "Adjacent services"** so future
  sessions don't re-ask.
- Quote-replies: \`[The user is replying to "..."]\\n\\n<message>\`.

# Behavior

- Permissions bypassed → **you are the safety check**. Before destructive or
  hard-to-reverse actions (\`rm -rf\`, dropping data, force-push, killing
  processes outside this bridge, mass deletes, overwriting uncommitted work,
  touching \`~/.ssh\`/\`~/.gnupg\`), state what you'll do and wait for explicit
  ok. Confirmation is for the action's scope, not a blanket pass.
- Your reply may be auto-quoted (group chats, or newer messages arrived while
  you worked); plain otherwise. You don't control this.

# Cron jobs

Recurring tasks live in \`data/crons.json\` (re-read by the scheduler every
60s; no restart needed). Schema, array of:

\`\`\`
{
  "jid": "<chat to reply in>",
  "creatorLid": "<LID of the sender who asked>",
  "schedule": "<5-field cron, evaluated in ${CRON_TIMEZONE}>",
  "prompt": "<self-contained instruction for future-you>",
  "lastRun": "<ISO timestamp; current time at creation>"
}
\`\`\`

When asked to schedule something, edit the file: \`jid\` = current chat,
\`creatorLid\` = the asker's LID, \`lastRun\` = current ISO time so the first
fire is the next future occurrence (else the scheduler anchors on first
sight, costing you one tick). The \`prompt\` will be replayed cold; embed
temporal context ("Es lunes 9am, mostrale al usuario su agenda"). At fire
time the bridge re-checks the creator's role; if they were removed from the
whitelist the run is skipped, the entry stays.

To list / delete / modify, edit the array. Restricted senders cannot mutate
this file (the role gate above already blocks Edit/Write); they may Read it
to answer "what's scheduled?".

Catch-up after downtime is collapsed: N missed occurrences fire as one. Don't
write logic that assumes every scheduled occurrence delivered.

# Where to find things

- **SOUL.md** (\`${SOUL_PATH}\`); user identity, tone, language, durable preferences.
- **TOOLS.md** (\`${TOOLS_PATH}\`); bridge runtime config, daemons, all bridge controls (whitelist, groups, restart, daily reset, env vars).
- **Auto-memory**; project state, validated feedback, external service pointers. Indexed in \`MEMORY.md\` (auto-loaded).
- **Your memory of past chats with this user**; appended below as \`# What you remember\` if any. Recent days vivid (full bodies); older condensed; oldest just date + gist. Read \`data/journal/<safe-jid>/<date>__*.md\` for the full text of an older entry the user references.

When the user references something you don't have in context, say so plainly and consult the right source rather than fabricate.
`.trim();

const inFlight = new Map<string, Promise<unknown>>();
function enqueue<T>(jid: string, fn: () => Promise<T>): Promise<T> {
  const prev = inFlight.get(jid) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  inFlight.set(jid, next.catch(() => undefined));
  return next;
}

// Per-chat monotonic counter, ticked at message arrival. Lets handle() detect
// whether newer messages arrived while it was working; if so, quote the reply
// to anchor it to the specific message Claude was responding to.
const lastSeq = new Map<string, number>();
function nextSeq(jid: string): number {
  const n = (lastSeq.get(jid) ?? 0) + 1;
  lastSeq.set(jid, n);
  return n;
}

// Last activity timestamp per chat. The daily flush skips JIDs with recent
// activity so a thread that's still going at 5am isn't yanked mid-sentence;
// it flushes at the next daily reset once it's idle. Default 15min;
// override with FLUSH_IDLE_THRESHOLD_MS.
const lastActivityAt = new Map<string, number>();
const FLUSH_IDLE_THRESHOLD_MS = Number(process.env.FLUSH_IDLE_THRESHOLD_MS ?? String(15 * 60 * 1000));
function noteActivity(jid: string): void {
  lastActivityAt.set(jid, Date.now());
}
function isJidIdle(jid: string): boolean {
  const last = lastActivityAt.get(jid);
  return last === undefined || Date.now() - last > FLUSH_IDLE_THRESHOLD_MS;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function buildPrompt(msg: IncomingMessage): string {
  if (!msg.quoted) return msg.text;
  return `[The user is replying to a previous message: "${truncate(msg.quoted.text, 300)}"]\n\n${msg.text}`;
}

type JournalEntry = { date: string; tier: number; body: string; summary?: string };

function readJournalEntries(jid: string): JournalEntry[] {
  const dir = resolve(JOURNAL_DIR, safeJid(jid));
  if (!existsSync(dir)) return [];
  const entries: JournalEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    let raw: string;
    try {
      raw = readFileSync(resolve(dir, name), 'utf-8');
    } catch {
      continue;
    }
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) continue;
    let date = '', tier = 0;
    let summary: string | undefined;
    for (const line of m[1]!.split('\n')) {
      const eq = line.indexOf(':');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k === 'date') date = v;
      else if (k === 'tier') tier = Number(v);
      else if (k === 'summary') summary = v;
    }
    if (!date || !tier) continue;
    entries.push({ date, tier, body: m[2]!.trim(), summary });
  }
  // Newest first.
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
}

// Token budget: tier 1+2 inline full bodies (last 14 days, ≈ 5400 words max);
// tier 3+4 collapse to a TOC of date + one-line summary so older context costs
// O(entries) tokens, not O(entries × budget). Claude can still Read the file
// directly via the path hint when something older is referenced.
function buildJournalText(jid: string): string {
  const entries = readJournalEntries(jid);
  if (entries.length === 0) return '';
  const buckets: Record<number, JournalEntry[]> = { 1: [], 2: [], 3: [], 4: [] };
  const now = new Date();
  for (const e of entries) {
    const d = new Date(`${e.date}T00:00:00`);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const ageDays = Math.floor((today.getTime() - d.getTime()) / 86_400_000);
    const tier = tierForAge(ageDays);
    if (tier === null) continue; // safety: ≥28d should already be deleted
    buckets[tier]!.push(e);
  }
  const sections: string[] = [];
  if (buckets[1]!.length > 0) {
    const body = buckets[1]!.map((e) => `### ${e.date}\n\n${e.body}`).join('\n\n---\n\n');
    sections.push(`## Last 7 days\n\n${body}`);
  }
  if (buckets[2]!.length > 0) {
    const body = buckets[2]!.map((e) => `### ${e.date}\n\n${e.body}`).join('\n\n---\n\n');
    sections.push(`## 8–14 days ago\n\n${body}`);
  }
  const tocLines: string[] = [];
  for (const tier of [3, 4] as const) {
    for (const e of buckets[tier]!) {
      const tag = e.summary?.trim() || '(no summary in frontmatter; Read the file for details)';
      tocLines.push(`- ${e.date}; ${tag}`);
    }
  }
  if (tocLines.length > 0) {
    const dirHint = resolve(JOURNAL_DIR, safeJid(jid));
    sections.push(
      `## 15–27 days ago (TOC only)\n\n_Bodies elided to keep this prompt small. Read \`${dirHint}/<date>__*.md\` if the user references one._\n\n${tocLines.join('\n')}`,
    );
  }
  if (sections.length === 0) return '';
  return `\n\n# What you remember from past chats with this user\n\n_Recent days vivid, older condensed, oldest just date + gist. This is your recall of prior conversations with this user, not a live transcript._\n\n${sections.join('\n\n')}`;
}

function buildRoleAddendum(role: Role): string {
  if (role === 'owner') {
    return `\n\n# Sender role: owner\n\nThis sender is the OWNER of this bridge install. They have full trust AND can mutate the whitelist (\`.env\` keys: \`OWNER_LID\`, \`WHITELIST_NUMBERS\`, \`RESTRICTED_LIDS\`) and \`data/allowed-groups.json\`. Honor whitelist-edit requests directly.`;
  }
  if (role === 'full') {
    return `\n\n# Sender role: full-trust\n\nThis sender is full-trust but is NOT the owner. They can ask you to do anything you'd do for the owner EXCEPT modifying the whitelist or allowed-groups files. If they ask you to add or remove a sender, change roles, or allow or revoke a group, refuse politely: explain that only the owner (set in \`.env\` as \`OWNER_LID\`) can authorize whitelist changes, and offer to relay the request to the owner.`;
  }
  return `\n\n# Sender role: restricted\n\nThis sender is RESTRICTED. They can ask you to read files, search the workspace (Glob, Grep), fetch web pages (WebFetch, WebSearch), and discuss code. Do NOT use \`Bash\`, \`Edit\`, \`Write\`, \`NotebookEdit\`, \`KillShell\`, or any tool that mutates state on their behalf. If they ask you to do something that requires mutation (run a command, modify a file, push to git, install a package, restart a service, edit \`.env\` or \`data/allowed-groups.json\`), refuse and explain: their role is read-only; only the owner can change their role in \`.env\`. Whitelist edits and group-allow authorizations are off-limits regardless.`;
}

function buildGroupPrivacyAddendum(isGroup: boolean): string {
  if (!isGroup) return '';
  return `\n\n# Group chat privacy\n\nThis is a WhatsApp group chat. Other members of the group (including ones not in any whitelist) can read your replies. Treat the group as a public space:\n\n- Avoid absolute file paths inside the workspace; refer to files by name only ("the API handler", "the deploy script").\n- Do not include environment variable values, API keys, tokens, secrets, or auth flow details.\n- Do not include URLs, hostnames, or endpoints that aren't already public.\n- Avoid internal architecture details, security configurations, or anything you'd treat as sensitive in a 1:1.\n\nIf the user needs full detail, suggest they DM you. When you must describe something concrete, abstract it ("I checked the config", "the relevant value was set"). The owner is responsible for what they discuss in groups; you reduce the surface.`;
}

async function handle(wa: WhatsAppHandle, msg: IncomingMessage, seq: number): Promise<void> {
  if (msg.fromMe) return;
  // Group gate: groups must be explicitly allowed (auto-added when an
  // owner or full-trust user adds the bot; manually editable in
  // allowed-groups.json). Returning here means no Claude call; no token
  // spend on un-allowed traffic.
  if (msg.isGroup && !loadAllowedGroups().has(msg.jid)) {
    console.log(`Ignored group message in ${msg.jid} (group not allowed)`);
    return;
  }
  // Sender role gate. getRole accepts either form: LID (canonical, stable
  // across phone changes) or resolved phone (human-readable).
  // senderPhoneNumber is undefined when Baileys hasn't observed a mapping
  // yet; LID match still works.
  const role = getRole(msg.senderNumber, msg.senderPhoneNumber);
  if (!role) {
    const id = msg.senderPhoneNumber
      ? `${msg.senderNumber} (+${msg.senderPhoneNumber})`
      : msg.senderNumber;
    console.log(
      `Ignored message from ${id} (not whitelisted). ` +
        `Add either form to OWNER_LID, WHITELIST_NUMBERS, or RESTRICTED_LIDS in .env to allow.`,
    );
    return;
  }
  noteActivity(msg.jid);

  const quotedNote = msg.quoted ? ` (replying to "${truncate(msg.quoted.text, 40)}")` : '';
  console.log(`[${msg.senderNumber}/${role}] →${quotedNote} ${msg.text.slice(0, 80)}${msg.text.length > 80 ? '…' : ''}`);

  // Typing indicator is a UX nicety; a transient Baileys "Connection Closed"
  // here must not abort the reply. The await ask() that follows can buy time
  // for a reconnect before we actually need to send.
  await wa.setTyping(msg.jid, true).catch(() => undefined);
  const typingTick = setInterval(() => {
    wa.setTyping(msg.jid, true).catch(() => undefined);
  }, 8000);

  // Per-call askOpts. systemPromptAppend is concatenated low-variance →
  // high-variance so the prompt cache keeps the longest stable prefix:
  // base (constant) → group-privacy (per-JID, fixed for that JID) →
  // journal (per-JID, fixed between daily flushes) → role (per-sender, the
  // only piece that swaps within a group chat). In 1:1 chats the order is
  // moot; in groups it preserves journal/group-privacy cache hits across
  // owner / full / restricted senders.
  const perCallOpts: AskOpts = {
    ...askOpts,
    systemPromptAppend:
      SYSTEM_PROMPT_APPEND +
      buildGroupPrivacyAddendum(msg.isGroup) +
      buildJournalText(msg.jid) +
      buildRoleAddendum(role),
  };

  try {
    const result = await ask(msg.jid, buildPrompt(msg), perCallOpts);
    console.log(`  ← ${result.turns} turns, $${result.cost.toFixed(4)}`);
    const formatted = toWhatsApp(result.text);
    const parts = chunk(formatted);
    // Quote on the first chunk only when threading is genuinely ambiguous:
    // group chats (multiple senders) or when newer messages arrived during
    // processing (Claude's reply lands after the user moved on).
    const newerArrived = (lastSeq.get(msg.jid) ?? seq) > seq;
    const shouldQuote = msg.isGroup || newerArrived;
    for (let i = 0; i < parts.length; i++) {
      const opts = i === 0 && shouldQuote ? { quoted: msg.raw } : undefined;
      await wa.send(msg.jid, parts[i]!, opts);
    }
  } catch (err) {
    console.error('Claude query failed:', err);
    // Always quote errors so the user knows which message failed.
    await wa.send(msg.jid, `⚠️ Error: ${err instanceof Error ? err.message : String(err)}`, { quoted: msg.raw });
  } finally {
    clearInterval(typingTick);
    await wa.setTyping(msg.jid, false).catch(() => undefined);
  }
}

const askOpts: AskOpts = { cwd: CWD, model: MODEL, systemPromptAppend: SYSTEM_PROMPT_APPEND };

// Fire a scheduled cron job. Mirrors handle()'s pipeline (role gate → per-call
// systemPromptAppend → ask → toWhatsApp/chunk → send) minus the message-only
// concerns (no quoted-reply, no typing indicator, no seq tracking; nobody is
// waiting on the other end). Failures here log loudly and surface a one-line
// error in the chat so the operator notices on their phone.
async function fireCron(wa: WhatsAppHandle, entry: CronEntry, fireAt: Date): Promise<void> {
  // Re-check the creator's role at fire time. If they were demoted or
  // removed from the whitelist, skip; the entry remains so the operator can
  // decide whether to delete it (auto-deletion would silently lose their
  // schedules during a temporary role change).
  const role = getRole(entry.creatorLid);
  if (role !== 'owner' && role !== 'full') {
    console.error(`[cron] creator ${entry.creatorLid} no longer authorized (role=${role ?? 'none'}); skipping fire scheduled for ${fireAt.toISOString()}`);
    return;
  }
  const isGroup = entry.jid.endsWith('@g.us');
  const perCallOpts: AskOpts = {
    ...askOpts,
    systemPromptAppend:
      SYSTEM_PROMPT_APPEND +
      buildGroupPrivacyAddendum(isGroup) +
      buildJournalText(entry.jid) +
      buildRoleAddendum(role),
  };
  console.log(`[cron] firing for ${entry.jid} (creator=${entry.creatorLid}/${role}, schedule="${entry.schedule}", scheduled=${fireAt.toISOString()})`);
  try {
    const result = await ask(entry.jid, entry.prompt, perCallOpts);
    console.log(`  ← ${result.turns} turns, $${result.cost.toFixed(4)}`);
    const parts = chunk(toWhatsApp(result.text));
    for (const part of parts) {
      await wa.send(entry.jid, part);
    }
  } catch (err) {
    console.error(`[cron] fire failed for ${entry.jid}:`, err);
    try {
      await wa.send(entry.jid, `⚠️ Cron error: ${err instanceof Error ? err.message : String(err)}`);
    } catch (sendErr) {
      console.error('[cron] also failed to send error notice:', sendErr);
    }
  }
}

function getMostRecentResetTime(now: Date, hour: number): Date {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d > now) d.setDate(d.getDate() - 1);
  return d;
}

// Daily flush orchestration. Iterates sessions; for each idle chat, runs
// the memory-extraction call serialized through the same per-JID queue as
// user messages (so it cannot race with an inbound message). Active chats
// stay resumable until their next idle window. After per-JID flushes,
// ages every journal dir and stamps the reset marker.
async function performFlush(): Promise<{ flushed: number; skipped: number; durationMs: number }> {
  const start = Date.now();
  const sessions = await loadAllSessions();
  let flushed = 0;
  let skipped = 0;
  for (const [jid, sessionId] of Object.entries(sessions)) {
    if (!isJidIdle(jid)) {
      console.log(`[flush] skipping active jid ${jid} (recent activity)`);
      skipped++;
      continue;
    }
    try {
      await enqueue(jid, () => flushOneJid(jid, sessionId, askOpts));
      flushed++;
    } catch (err) {
      console.error(`[flush] ${jid}:`, err);
    }
  }
  await ageAllJournals(askOpts);
  await saveLastReset(Date.now());
  return { flushed, skipped, durationMs: Date.now() - start };
}

async function catchUpIfMissed(hour: number): Promise<void> {
  const now = new Date();
  const last = await loadLastReset();
  if (last === 0) {
    // First boot with this code; assume sessions are fresh, mark "last reset" as now.
    await saveLastReset(now.getTime());
    return;
  }
  const recent = getMostRecentResetTime(now, hour).getTime();
  if (last < recent) {
    console.log(`[reset] missed daily reset (last: ${new Date(last).toLocaleString()}, expected: ${new Date(recent).toLocaleString()}); catching up`);
    const r = await performFlush();
    console.log(`[reset] catch-up done: flushed=${r.flushed} skipped=${r.skipped} in ${Math.round(r.durationMs / 1000)}s`);
  }
}

function scheduleDailyReset(hour: number): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delayMs = next.getTime() - now.getTime();
  console.log(`Daily session reset scheduled for ${next.toLocaleString()} (in ${Math.round(delayMs / 60000)}m)`);
  setTimeout(async () => {
    try {
      const r = await performFlush();
      console.log(`[reset] daily flush: flushed=${r.flushed} skipped=${r.skipped} in ${Math.round(r.durationMs / 1000)}s`);
    } catch (err) {
      console.error('[reset] daily flush failed:', err);
    } finally {
      scheduleDailyReset(hour);
    }
  }, delayMs);
}

function handleGroupAdd(event: GroupAdd): void {
  const label = `${event.groupJid} ("${event.groupName ?? '?'}")`;
  // Group auto-allow requires owner or full-trust inviter. Restricted
  // senders cannot expand the bot's reach into new groups.
  const inviterRole = getRole(event.inviterNumber, event.inviterPhoneNumber);
  if (inviterRole !== 'owner' && inviterRole !== 'full') {
    const id = event.inviterPhoneNumber
      ? `${event.inviterNumber} (+${event.inviterPhoneNumber})`
      : event.inviterNumber;
    const reason = inviterRole === 'restricted'
      ? 'restricted role lacks group-allow authority'
      : 'not whitelisted';
    console.log(`Bot added to group ${label} by ${id}: ${reason}, group remains ignored`);
    return;
  }
  const allowed = loadAllowedGroups();
  if (allowed.has(event.groupJid)) {
    console.log(`Bot re-added to already-allowed group ${label}`);
    return;
  }
  allowed.add(event.groupJid);
  saveAllowedGroups(allowed);
  console.log(`Auto-allowed group ${label}; added by whitelisted ${event.inviterNumber}`);
}

const wa = await startWhatsApp(
  (msg) => {
    // Allocate the seq at arrival, not at handle() time; handle() runs after
    // the per-jid queue drains, by which point newer messages may have arrived
    // and bumped the counter past us.
    const seq = nextSeq(msg.jid);
    return enqueue(msg.jid, () => handle(wa, msg, seq));
  },
  handleGroupAdd,
);
await catchUpIfMissed(RESET_HOUR);
scheduleDailyReset(RESET_HOUR);
startCronScheduler({
  timezone: CRON_TIMEZONE,
  // Serialize fires through the same per-JID queue as inbound messages and
  // the daily flush, so a cron firing at 4:59am can't race the 5am reset
  // for that chat.
  onDue: (entry, fireAt) => {
    enqueue(entry.jid, () => fireCron(wa, entry, fireAt));
  },
});

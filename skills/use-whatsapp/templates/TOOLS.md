# Tools

Inventory of tools, services, configs, env vars, and operational state in this workspace. Update this file the moment you install, configure, or change access on anything; the next session should not have to rediscover it.

Keep entries tight. One section per tool. If a tool is removed, delete its entry.

**Scope (what belongs here, what doesn't).** TOOLS.md is the **delta from CLAUDE.md**, not a re-listing. If CLAUDE.md already documents the tool or setting, don't repeat it here unless this workspace's config genuinely differs.

What belongs here: **services you operate locally on this host**. Daemons, sibling containers you start and stop, anything where the operational surface (paths, ports, restart commands, env vars, hardware constraints, dependencies between services) is yours to own. One section per service.

What does NOT belong here:

- **External services you only consume** (third-party APIs, dashboards like Grafana or Linear, sibling containers reached only via HTTP whose lifecycle is someone else's problem). These go in `reference_*.md` auto-memories, indexed by `MEMORY.md`. Endpoint, auth, capabilities, common operations.
- User identity, tone, preferences. These go in SOUL.md.
- Per-chat conversation traces. These go in the WhatsApp journal.

**The split rule.** If you ever have to restart it or configure it, TOOLS.md. If you only call it over the wire, `reference_*.md` in auto-memory. The interaction surface decides the home, not the physical location: a daemon that moves to a vendor's cloud stops being TOOLS.md material the day you stop operating it.

---

## WhatsApp ↔ Claude Code bridge

- **Path**: `<bridge-dir>`; typically a sibling of the workspace (e.g. `/config/.whatsapp/` on EnvHaven, `$XDG_STATE_HOME/whatsapp-claude/` or `$HOME/.whatsapp-claude/` elsewhere). Kept outside the workspace tree so the workspace shows only what the user is building. If you chose "inside the workspace" during install, this will be `<workspace>/whatsapp-claude/` instead.
- **What**: Routes WhatsApp messages from the bot's number (**+<bot-phone>**) to a Claude Agent SDK call running with `cwd=<workspace>`, replies back in the chat.
- **Auth model**: User's Anthropic subscription via `~/.claude/.credentials.json`. No `ANTHROPIC_API_KEY` set, no per-token charges. SDK reports informational `total_cost_usd` in logs but the user is not billed.
- **Permissions**: `bypassPermissions` mode (every tool call runs without prompting). **Claude is the safety check**: confirm in chat before destructive actions (`rm -rf`, dropping data, force-pushing, killing processes outside the bridge, mass deletes, touching `~/.ssh` or `~/.gnupg`). Only the owner runs with mutating tools; guests are held to the read-only set by the SDK `tools` cap and a read-jail hook (see Roles below).
- **Run**: <run-mechanism> Auth state in `auth/` survives restarts (no QR rescan).
- **Restart**: <restart-cmd>
- **Manual start** (if auto-start fails or is not configured): `cd <bridge-dir> && ./run.sh`. The wrapper supervisor traps SIGINT, so Ctrl-C only respawns Node. To **fully stop** the bridge: kill the tmux session/window.
- **Logs**: `/tmp/wa-claude.log` (mode 600; sender ID, role, and message-length counts, not full bodies (a quoted-reply preview ≤40 chars can appear). Do not relax permissions: the file still carries enough metadata about timing and senders to be sensitive).
- **Roles** (LIDs only; WhatsApp's privacy mode hides phone numbers from the bridge). Two slots in `<bridge-dir>/.env`, re-read on every message:
  - **`OWNER_LID=<lid>`**: exactly one LID, the only unrestricted principal. Full Code toolset plus sole authority to mutate the whitelist (`.env` keys and `data/allowed-groups.json`) and create crons via natural language. Current: `<owner-lid>`.
  - **`GUEST_LIDS=<lid>,...`**: read-only guests. Each guest turn passes the SDK `tools` option capped to exactly `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`; under `bypassPermissions` that base-set cap is the real restrictor, since `Bash`, `Edit`, `Write`, and `Task` are absent from the model's context. A `PreToolUse` hook then confines those read tools to the workspace and the chat's own attachment dir, denying the bridge's `.env`, `auth/`, and `data/` (sessions, crons, allowed-groups, journals, other chats' attachments) and everything outside the workspace. Hooks deny even under `bypassPermissions`. The system-prompt addendum remains as defense in depth. Current: `<guests>`.
  - `getRole()` in `src/index.ts` returns owner else guest; the per-message system prompt addendum is built in `buildRoleAddendum()`.
- **Groups**: bot ignores group messages by default. When the **owner** adds the bot to a group, the bridge auto-records that group's JID in `<bridge-dir>/data/allowed-groups.json` and starts responding there. Guests cannot auto-allow groups. Inside an allowed group, only whitelisted senders (owner or guest) get replies; non-whitelisted members are still ignored. Edit the file to revoke a group or to manually allow one the bridge missed. Re-read on every message; no restart. Token-safe: the gate runs before any Claude call, and before any media download or read receipt.
- **Group privacy mode**: in any allowed group, the bridge appends a privacy addendum to the system prompt instructing Claude to abstract paths, secrets, and architecture details. Heuristic, not enforced; reduces leak surface to non-whitelisted readers in the group (see `src/index.ts:buildGroupPrivacyAddendum`).
- **Conversation history**: per (chat, sender) → Claude session id, stored in `<bridge-dir>/data/sessions.json`. Keying on the sender (not just the chat) means each sender in a group gets an isolated transcript, so a guest can never resume the owner's session. Delete an entry to start a fresh session for that sender.
- **Daily flush**: every day at 5am local (configurable via `DAILY_RESET_HOUR` in `.env`). Memory extraction runs only on the **owner's** sessions. Per active owner session: one combined Claude call updates evergreen surfaces in place per the flush prompt's decision tree (SOUL / feedback-mem / project-mem / reference-mem / TOOLS; see `src/claude.ts:buildFlushPrompt`) AND writes today's journal entry to `<bridge-dir>/data/journal/<safe-jid>/<YYYY-MM-DD>__<sessionId-8>.md` (frontmatter `date`/`session`/`tier`/`summary`, body ≤ 512 words; sparse sessions write less or skip the file). Guest sessions are cleared without a full-tool resume, so a read-only transcript is never reprocessed with `Bash`/`Edit` and guests accrue no journal or durable memory. Then an aging pass walks every JID's journal: files at the correct tier for their age are **skipped (no LLM call)**, files crossing a tier boundary are re-summarized in one shot directly to the target tier, files ≥28 days old are deleted. Then SDK sessions reset globally. Catch-up on next start if down at 5am (marker: `data/last-reset.json`). Tiers (max words, not targets): T1 0–6d=512, T2 7–13d=256, T3 14–20d=128, T4 21–27d=64.
- **Cron jobs**: user-defined recurring tasks live in `<bridge-dir>/data/crons.json` (5 fields per entry: `jid`, `creatorLid`, `schedule`, `prompt`, `lastRun`). The scheduler ticks every 60s, re-reads the file, fires entries whose `nextRun(lastRun) <= now`, persists the new `lastRun` BEFORE invoking Claude (idempotency: a crash mid-fire never double-fires). Schedules are 5-field cron evaluated in `CRON_TIMEZONE` (`.env`; empty = system tz). **Crons are owner-only**: only the owner can create one, and at fire time `fireCron` skips any entry whose creator is no longer the owner and re-checks the allowed-groups gate before posting into a group. Catch-up after downtime is **collapsed**: N missed occurrences fire as one. Mutated by Claude via natural language (no slash commands); guests cannot create or run crons. Source: `src/crons.ts` (scheduler), `src/index.ts:fireCron` (handler).
- **Conversation journal injection**: per-message, the bridge injects the JID's journal into the system prompt. **Tier 1+2** (last 14 days) inline full bodies. **Tier 3+4** (15–27 days) collapse to a TOC of `<date>; <summary>` lines; bodies live on disk and Claude can `Read` them directly via the path hint when something older is referenced. To wipe one chat's journal: `rm -rf <bridge-dir>/data/journal/<safe-jid>/`.
- **Reply-to-message**: inbound; when the user quote-replies on WhatsApp, the bridge prepends `[The user is replying to a previous message: "..."]` to Claude's prompt. Outbound; the reply auto-quotes only when threading is genuinely ambiguous (group chats, or when the user sent newer messages while Claude was working); plain otherwise. Errors always quote.
- **Source**: `src/index.ts` (entry, whitelist+groups, queue, daily reset, cron handler), `src/whatsapp.ts` (Baileys: messages + group-add events + media), `src/claude.ts` (SDK + session map + flush+extract), `src/crons.ts` (cron scheduler + persistence), `src/format.ts` (markdown→WhatsApp).
- **Media**: images, videos, documents, stickers, **and voice notes** are downloaded to `<bridge-dir>/data/attachments/<safe-jid>/<msg-id>.<ext>` (mode `0600`) and surfaced to Claude as absolute paths in a bracketed prefix (`[image attached: …]`, `[audio attached: …]`, `[document attached: …]`, etc.). The bridge does no transcription, no OCR, no preprocessing. `Read` renders images and PDFs natively; other formats handled via `Bash` on demand. **Retention** follows the same decision tree as memory: on each daily flush (`ageAttachments` in `src/whatsapp.ts`), an attachment whose basename appears in SOUL.md, TOOLS.md, CLAUDE.md, the journal, or the auto-memory dir is kept indefinitely; otherwise it ages out after 28 days. **Transcription** is an *adjacent service* (see below); install ad hoc when needed.
- **Resilience**: outbound `send` waits for the connection to reopen and retries transient `Connection Closed` failures (up to 5 attempts × 30s). The `WhatsAppHandle` re-targets the live socket on every reconnect (no stale-closure send failures). Process-level `uncaughtException` exits cleanly; the tmux launch's `while true` wrapper (or s6/systemd/launchd if Step 10) restarts in 2s. Restart with `tmux send-keys -t "<tmux-session>:wa-claude" C-c` (wrapper respawns); fully stop with `tmux kill-window -t "<tmux-session>:wa-claude"`. **Inbound replay is not durable**; a bridge crash between WhatsApp ACK and Claude's reply loses that message; user resends.
- **Stack**: Node <node-version>, <pkg-mgr>, tsx, TypeScript strict, ESM. `@whiskeysockets/baileys@<baileys-version>`, `@anthropic-ai/claude-agent-sdk` (versions pinned in `<bridge-dir>/package.json`).

---

## Security model and threat scope

The bridge is a **trust amplifier**: an **owner** message becomes a Claude Agent SDK call running with `bypassPermissions` and the full Code toolset. What lands in chat as a one-line ask becomes shell access to your container by way of Claude. **Guest** messages run the same SDK with the `tools` option capped to the five read tools and a read-jail hook, so a guest gets a read-only view of the workspace, not shell. The threat model below follows from that.

**The owner is the only trusted principal; guests are read-only.** The owner role (`OWNER_LID`, exactly one) is "I let this person open a tmux window in my container"; it is bootstrapped distinct from later additions. Every subsequent sender is added to `GUEST_LIDS` as a read-only guest per the skill's M3 management action; there is no intermediate full-access tier.

**Guest read-only is SDK-gated, not just system-prompt prose.** Each guest turn passes the SDK `tools` option capped to exactly the five read tools (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`); under `bypassPermissions` that base-set cap is the real restrictor, since `Bash`, `Edit`, `Write`, `Task` and the other mutating tools are simply absent from the model's context for that turn. A clever message cannot prompt-inject the model into calling a tool that isn't there. On top of that, a `PreToolUse` hook confines the read tools to the workspace and the chat's own attachment dir, denying the bridge's `.env`, `auth/`, and `data/` (sessions, crons, allowed-groups, journals, other chats' attachments) and everything outside the workspace; hooks deny even under `bypassPermissions`, so a guest cannot reach `Bash`/`Edit`/`Write` or read the bridge config or another chat's transcript. The system-prompt addendum is kept as defense in depth (it shapes refusal language and covers tools added in future SDK versions). The role *assignment* itself, however, is governed by `.env`: an attacker with write access to that file can promote themselves to owner. The boot-time `chmod 600 .env` is hygiene, not a substitute for filesystem protection. Add as guests collaborators you'd let read your code, not hostile parties.

**Whitelist edits require owner.** Only the LID matching `OWNER_LID` can authorize whitelist changes via natural language. A guest asking Claude to add or remove a LID, change roles, or allow or revoke a group is refused (offered a relay to the owner). Enforced in `src/index.ts:buildRoleAddendum`.

**Group privacy is heuristic.** In any allowed group, the system prompt instructs Claude to abstract paths, secrets, and architecture details. Reduces the leak surface but does not guarantee containment. Treat allowed groups as semi-public; for sensitive work, 1:1 only.

**`auth/creds.json` is your WhatsApp linked-device credential.** Anyone with read access (root on the host, another container with the same bind-mount, an offline copy of the bridge dir) can impersonate the bot outside this container. This is the standard WhatsApp linked-device threat model, not specific to this bridge. Mode 700 on `<bridge-dir>` protects against other users on the same host; nothing protects against root or volume theft.

**`/tmp/wa-claude.log` is plaintext** (mode 600). The bridge logs sender ID, role, and message-length counts, not full bodies (a quoted-reply preview ≤40 chars can appear), but the metadata alone (timing, sender frequency) is still sensitive. Backups, snapshots, and syslog forwarding pick it up. Don't discuss secrets through the chat: even if the log itself is clean, Claude's responses are written wherever the operator points them (a file edit lands on disk in plaintext regardless).

**Identity verification at whitelist-add time is operator responsibility.** The bridge captures whichever LID happens to send a message; it cannot verify the LID belongs to who claimed it. Cross-check out of band before adding (call, ask something only they would know). The `+<phone>` shown alongside a LID once Baileys has resolved the mapping helps but is a hint, not authoritative.

**Bootstrap window is AskUserQuestion-protected.** Step 7 of the skill always confirms the captured LID with the operator before writing to `OWNER_LID`, even with a single candidate in the log poll. Pay attention to the LID you're approving; if your bot's number leaked, a stranger could have messaged during the window.

---

## Adjacent services

Services Claude reaches for alongside the bridge; voice transcription, YouTube transcript fetchers, anti-detection browsers (Camofox), OCR pipelines, document converters, anything else; are installed **ad hoc per user request**, never as part of the bridge install. They follow a **sibling-dir convention**: each service gets its own directory next to `<bridge-dir>`, named `.<service>`; e.g.

- `/config/.whatsapp/` ← the bridge
- `/config/.whisper/` ← local transcription daemon (if installed)
- `/config/.camofox/` ← anti-detection browser HTTP API (if installed)
- `/config/.youtube-transcripts/` ← YouTube transcript fetcher (if installed)

Same hygiene as the bridge dir: outside the workspace tree (so they don't pollute the project's preview URL), mode 700 (auth state and config don't leak to other host users), runtime files self-contained. Off-EnvHaven the convention is `$XDG_STATE_HOME/.<service>/` or `$HOME/.<service>/`.

When the user asks for one, follow the host's installation protocol (CLAUDE.md → "Installation Protocol" on EnvHaven), then **append a subsection here** documenting:

- Endpoint / port / socket path
- Env vars the bridge or Claude needs to read
- How the service is started (tmux window? auto-start mechanism?)
- Restart / health-check command
- How the bridge or Claude consumes it (e.g. "POST audio to `http://127.0.0.1:7117/transcribe`, returns `{text}`")

Future Claude sessions read TOOLS.md first; a missing or stale entry means re-asking the user. Keep entries tight, same as the rest of TOOLS.md.

### Voice transcription (not installed)

The bridge surfaces voice notes as `[audio attached: <path>]` with no transcription. If the user wants automatic transcription, Claude offers three install paths on the first audio (see system prompt in `src/index.ts`):

1. **faster-whisper** (local, GPU); `/config/.whisper/`
2. **Groq Whisper API** (cloud, cheapest)
3. **OpenAI Whisper API** (cloud, familiar)

Once installed, replace this stub with a real subsection per the structure above.

---

(other tools; add as installed)

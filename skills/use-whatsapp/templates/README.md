# WhatsApp ↔ Claude Code bridge

Routes WhatsApp messages to a Claude Agent SDK call and replies back. Built by the `/use-whatsapp` skill; this README is the operating manual that lives next to the bridge for the humans (and future Claude sessions) who maintain it.

For install, re-install, repair, or adding a sender, re-run the skill. For day-to-day operation, the sections below.

## Operational notes

### Restart cleanly (auth survives; never delete `auth/` unless re-pairing)

| Auto-start | Restart command |
|---|---|
| None (tmux only) | `tmux send-keys -t "$TMUX_SESSION:wa-claude" C-c`; the wrapper loop respawns Node in 2s. To **fully stop** (no respawn), `tmux kill-window -t "$TMUX_SESSION:wa-claude"`. |
| /custom-cont-init.d/ | `tmux kill-session -t wa-claude 2>/dev/null; sleep 2; sudo bash /custom-cont-init.d/10-wa-claude.sh`. |
| s6-overlay | `sudo s6-svc -r /run/service/svc-wa-claude` |
| systemd-user | `systemctl --user restart wa-claude.service` |
| launchd | `launchctl unload ~/Library/LaunchAgents/dev.user.wa-claude.plist && launchctl load ~/Library/LaunchAgents/dev.user.wa-claude.plist` |

### Logs

```bash
tail -F /tmp/wa-claude.log               # live
grep -E '^\[|← \d+|⚠️' /tmp/wa-claude.log # signal-only
```

Mode 600; only your user can read it. Contains message text, don't relax that.

### Self-recovery

Two failure modes the bridge handles automatically:

- **Stale Claude session.** If `data/sessions.json` references a session id the SDK can no longer resume, the next message detects it, clears that JID's entry, and retries once with a fresh session. SOUL.md, TOOLS.md, journals still load. Log line: `[ask] stale session <id> for <jid>; clearing and retrying with fresh session`.
- **LID→phone map cold start.** In-memory only; re-accumulates as messages flow. LID-form whitelist entries always work; phone-form entries may need a few messages from each sender post-restart.

### Session reset (manual)

For a single chat: ask Claude on WhatsApp to "forget our conversation". Wipes that JID's entry in `data/sessions.json`.

For all chats: `echo '{}' > data/sessions.json`.

### Group control (manual)

Stop responding in a group: ask Claude to "leave that group". Adds/removes JIDs in `data/allowed-groups.json`. To allow a group the bridge missed, append the JID to that file directly. Re-read on every message.

### Cron jobs (manual)

Schedule a recurring task: ask Claude on WhatsApp ("agendá un cron que cada lunes 9am me mande mi agenda"). Claude writes an entry to `data/crons.json`; the scheduler picks it up within 60s. List/edit/delete the same way (or open the file). Five fields per entry: `jid`, `creatorLid`, `schedule` (5-field cron in `CRON_TIMEZONE`), `prompt`, `lastRun`. After downtime, missed runs collapse to one fire. Restricted senders cannot mutate this file.

### Uninstall auto-start

| Mechanism | Uninstall |
|---|---|
| /custom-cont-init.d/ | `sudo rm /custom-cont-init.d/*-wa-claude.sh`. Effective at next container start. |
| s6-overlay | `sudo rm /etc/s6-overlay/s6-rc.d/user/contents.d/svc-wa-claude && sudo rm -rf /etc/s6-overlay/s6-rc.d/svc-wa-claude` |
| systemd-user | `systemctl --user disable --now wa-claude.service && rm ~/.config/systemd/user/wa-claude.service` |
| launchd | `launchctl unload ~/Library/LaunchAgents/dev.user.wa-claude.plist && rm ~/Library/LaunchAgents/dev.user.wa-claude.plist` |

## Troubleshooting

### Bun crashes with exit 132 (SIGILL)

CPU lacks AVX2. Use pnpm or npm. Don't try `bun install` even if `bun --version` works.

### Baileys default-export TypeScript error: "expression is not callable"

Use the **named** import:

```ts
import { makeWASocket } from '@whiskeysockets/baileys';   // right
import makeWASocket from '@whiskeysockets/baileys';       // wrong
```

Baileys 6.7.18 is CommonJS; under NodeNext resolution the default import resolves to the namespace object.

### Code 515 (`restartRequired`) right after pairing

Normal Baileys post-handshake. The bridge reconnects within ~2s. If it persists more than once per pairing, unlink the device on the phone and re-pair.

### "unexpected error in 'init queries'" / 408 timeout

Internal Baileys init query timed out. Non-fatal; messaging still works. The template silences pino at level `silent`; if you see this, your `pino` level isn't silent.

### Blue ticks not appearing

The template calls `sock.readMessages([m.key])` for every incoming message. If you removed it, add it back.

### "Ignored message from <id>" but the user IS the sender

Add their LID (or `+phone` once Baileys resolves it) to `WHITELIST_NUMBERS`/`OWNER_LID`/`RESTRICTED_LIDS` in `.env`. Re-read on every message.

### QR not rendering after launch

Most likely a startup error. Dump `tail -50 /tmp/wa-claude.log`. Common causes: Node < 20, `pnpm install` didn't finish, `.env` missing or all role slots empty (the bridge refuses to start; should be `WHITELIST_NUMBERS=BOOTSTRAP` during install Step 7).

### Window `wa-claude` doesn't exist after a crash

`tmux new-window` with a command argument auto-closes when the command exits. The launcher uses `new-window` (no command) followed by `send-keys` so the shell wraps the process and stays. If you mis-launched, recreate.

### `tmux send-keys` errors with `can't find pane: <path>`

Some environments install tmux hooks (notably **EnvHaven**) that rewrite name-form window targets. Address windows by **numeric index** (`<session>:<index>`). Resolve with `tmux list-windows -t "$TMUX_SESSION" -F '#I #W' | awk '$2 == "wa-claude" {print $1; exit}'`.

### Bridge appears connected but doesn't respond

Check in order:
1. `test -f auth/creds.json`
2. `grep '✅ Connected' /tmp/wa-claude.log | tail -1`
3. Sender's LID matches `WHITELIST_NUMBERS`/`OWNER_LID`? (Look for `Ignored message from`.)
4. `pgrep -f 'tsx.*src/index'`

### Multiple devices conflict (code 440)

Two Baileys instances against the same WhatsApp account → disconnect 440. Stop one. Common cause: starting an auto-start service while a tmux bridge is still running.

### "Connection Closed" but no reply reached the user

The retry loop tries 5×30s. If you see `succeeded on attempt M`, working as designed. If it exhausts, Baileys gave up reconnecting (usually `loggedOut` 401); check log for `Logged out; delete auth/ and re-scan.`.

### Bridge keeps restarting in a tight loop

The wrapper backs off exponentially (2s → 60s cap). Tail `/tmp/wa-claude.log` for the underlying error: missing `.env`, broken `auth/creds.json`, missing dependency, syntax error. Stop with `tmux kill-window -t "$TMUX_SESSION:wa-claude"`.

### Image or document arrived but Claude says it can't see it

`↘ saved image → /…/data/attachments/…` should appear for every attachment. If present, the file is on disk; Claude's `Read` may not natively render that format (`.docx`, `.zip`, video) → fall through to `Bash` (`pdftotext`, `unzip`, `ffmpeg`). If the line is missing, check `data/attachments/<jid>/` is creatable.

### Bot was added to a group but doesn't respond

Auto-allow only fires if (a) the bridge was online when added and (b) the inviter's LID is whitelisted (owner or full-trust). Otherwise, append the JID to `data/allowed-groups.json` manually:

```bash
node -e 'const f="data/allowed-groups.json";const j=require("fs").existsSync(f)?JSON.parse(require("fs").readFileSync(f,"utf-8")):[];j.push("<group-jid>@g.us");require("fs").writeFileSync(f,JSON.stringify(j,null,2))'
```

### Auto-start service won't start

| Mechanism | Diagnosis |
|---|---|
| /custom-cont-init.d/ | `cat /custom-cont-init.d/10-wa-claude.sh`. Common: (a) script mtime newer than container boot (`init-custom-files` already ran); (b) `BRIDGE_DIR` path missing; (c) explicit `PATH=` doesn't contain `node` (mise/asdf/nvm); (d) script not executable. |
| s6-overlay | `sudo s6-svstat /run/service/svc-wa-claude`. `run` script must be executable and start with `#!/usr/bin/with-contenv bash`. |
| systemd-user | `systemctl --user status wa-claude.service && journalctl --user -u wa-claude.service -n 50`. Forgot `loginctl enable-linger`? |
| launchd | `launchctl list \| grep wa-claude`; `plutil -lint ~/Library/LaunchAgents/dev.user.wa-claude.plist` for syntax errors. |

## Anatomy of the bridge

The bridge dir lives at `$BRIDGE_DIR`, typically a sibling of the workspace (`/config/.whatsapp/` on EnvHaven; `$XDG_STATE_HOME/whatsapp-claude/` or `$HOME/.whatsapp-claude/` elsewhere). Workspace dir holds only what the user is actively building plus the agent-instruction surface (`AGENTS.md`, `CLAUDE.md`, `SOUL.md`, `TOOLS.md`).

```
$BRIDGE_DIR/                               (mode 700)
├── package.json          (pnpm/npm; tsx; ESM)
├── tsconfig.json         (strict, NodeNext, allowImportingTsExtensions)
├── run.sh                (resilient supervisor; bash loop + trap '' INT)
├── .env                  (mode 600; WHITELIST_NUMBERS, CLAUDE_CWD, DAILY_RESET_HOUR)
├── .gitignore            (auth/, data/, .env, node_modules)
├── auth/                 (Baileys linked-device creds; survives restarts)
├── data/
│   ├── sessions.json         (per-WhatsApp-chat → Claude session id)
│   ├── allowed-groups.json   (group JIDs the bot may respond in)
│   ├── all-groups.json       (snapshot of every group the bot participates in)
│   ├── last-reset.json       (timestamp of last 5am flush)
│   ├── crons.json            (user-defined recurring jobs; scheduler ticks every 60s)
│   ├── attachments/<jid>/    (images, videos, documents, stickers; one file per WA message id)
│   └── journal/<jid>/        (per-session journal: YYYY-MM-DD__<sid8>.md, tiered by age)
└── src/
    ├── index.ts          (entry: whitelist, queue, system prompt, scheduler, cron handler)
    ├── whatsapp.ts       (Baileys: connect, on message, group-add, send, read receipts)
    ├── claude.ts         (Agent SDK: query, session map, flush+memory extract)
    ├── crons.ts          (cron scheduler: tick loop, persistence, catch-up collapse)
    └── format.ts         (markdown → WhatsApp; chunk for length)
```

### Why outside the workspace

Runtime files (`auth/`, `data/`, `node_modules/`, `.env`) are infrastructure for the workspace, not part of it. Keeping them out of `$WORKSPACE_DIR` means the workspace tree shows only project content (matching what self-hosted IDEs publish via preview URL), and bridge cleanup doesn't touch user content.

The bridge's process CWD is `$BRIDGE_DIR` (so `data/`, `auth/`, `.env` resolve there); the **Agent SDK's `cwd`** (what Claude operates in) is `$WORKSPACE_DIR`. The `CLAUDE_CWD` env var controls only the SDK's `cwd`.

### Media and attachments

All inbound media (images, videos, documents, stickers, voice notes) is downloaded via Baileys `downloadMediaMessage` to `data/attachments/<jid>/<msg-id>.<ext>`. The extension comes from the WhatsApp `mimetype` (with a built-in lookup that includes the literal `audio/ogg; codecs=opus` PTT emits) or the document's original filename, fallback `.bin`. Claude's prompt receives a bracketed prefix with the absolute path: `[image attached: …]`, `[audio attached: …]`, `[document attached: …; original name: …]`, with any caption on the next line.

The bridge does **no transcription, no OCR, no preprocessing**. Claude consumes the file via `Read` (images, PDFs) or shells out via `Bash` (`ffmpeg`, `pdftotext`, `unzip`) on demand.

For voice notes, the bridge has no built-in transcription. The system prompt tells Claude to check `TOOLS.md` → "Adjacent services" first, then offer a tight install menu (faster-whisper local recommended; cloud fallback for no-GPU hosts). Once installed, the new service is documented in TOOLS.md and used automatically thereafter.

Files are **not pruned** automatically. Clean manually if disk pressure becomes an issue.

### Resilience model

Three layers:

1. **Connection-aware send (in-process).** Baileys' WebSocket drops occasionally (codes 428, 440, 515 are routine). The bridge tracks `'connecting' | 'open' | 'closed' | 'logged-out'`. Outbound `send()` waits for `open` (up to 30s per attempt) and retries transient failures (`Connection Closed`, `Timed Out`, `Stream Errored`) up to 5 times. The handle uses a closure-scoped `sock` that swaps on reconnect; without this, every reply after the first disconnect would silently fail. Sent message protos cached in-memory (256-entry cap) and served via `getMessage` so retry/re-encrypt requests don't leave recipients on "Waiting for this message…".
2. **Process-level safety nets.** `uncaughtException` → log + exit 1 (clean state for restart). `unhandledRejection` → log only. `loggedOut` (401) is non-recoverable; needs fresh QR.
3. **Process supervisor.** `run.sh` loops `pnpm`/`npm start` with exponential back-off (2s → 60s cap, resets after a 30s+ run). With auto-start (s6/systemd/launchd), the OS supervisor handles restart and `run.sh`'s loop is bypassed.

**Out of scope: inbound replay durability.** A bridge crash between WhatsApp ACK and Claude's reply loses that message; Baileys has already ACKed it and the linked-device protocol won't redeliver. The Claude Agent SDK is not idempotent across crashes; replaying mid-turn could re-execute Bash/Edit calls. Lose the rare message; resend.

### Continuity model

Cross-session continuity is split across **five surfaces with non-overlapping ownership**:

| Surface | Owns | Update |
|---|---|---|
| `<workspace>/SOUL.md` | Identity, voice, language, durable preferences | Edited by Claude at flush; auto-loaded via CLAUDE.md |
| `<workspace>/TOOLS.md` | Bridge runtime config, daemons, env vars, restart commands. **Delta from CLAUDE.md.** | Edited by Claude at flush; auto-loaded |
| `~/.claude/projects/<encoded-cwd>/memory/` | `feedback`, `project`, `reference` auto-memories | Native Claude Code system; `MEMORY.md` index auto-loaded |
| `<workspace>/CLAUDE.md` | EnvHaven/workspace baseline | Hand-maintained; flush avoids touching unless asked |
| `<bridge-dir>/data/journal/<safe-jid>/` | Per-chat conversation traces | Written at flush; aged daily; dropped at 28d |

The flush prompt's decision tree (`src/claude.ts:buildFlushPrompt`) walks each fact in order: discussion-trace → journal. Identity → SOUL. Explicit "always X / never Y" → feedback. Cross-chat project state → project. External pointer → reference. Bridge runtime → TOOLS. Stop at first match. Anti-redundancy: before writing anywhere, search; if duplicates exist, the lower one on the tree is the duplicate.

#### Journal file format

Each journal file at `data/journal/<safe-jid>/<YYYY-MM-DD>__<sessionId-8>.md`:

```
---
date: YYYY-MM-DD
session: <8-char session id>
tier: 1|2|3|4
summary: <one line, ≤80 chars, the gist>
---

<body>
```

`summary:` is mandatory. It's the only thing visible once the entry tiers out (≥15 days); ground-truth, named entities preserved.

#### Tiered ageing

| Tier | Age (days) | Word budget (max) | In system prompt |
|------|------------|--------------------|------------------|
| 1    | 0–6        | 512                | Full body inlined |
| 2    | 7–13       | 256                | Full body inlined |
| 3    | 14–20      | 128                | TOC only (`<date>; <summary>`) |
| 4    | 21–27      | 64                 | TOC only |
|      | ≥28        |                    | Deleted |

#### Daily flush at 5am

Catch-up via `data/last-reset.json` if the bridge was down at 5am.

1. **Per active JID**: one combined Claude call resumes the session and (a) walks the decision tree above, (b) writes today's journal entry at tier 1 with `summary:`, body ≤ 512 words, or **skips the file** if the session was trivial.
2. **Aging pass**: walk every JID's journal directory. Files at the right tier skipped (no LLM call). Files crossing a boundary re-summarized in one shot directly to the target tier. Files ≥28d deleted.
3. **Reset SDK sessions** globally; stamp `data/last-reset.json`.

Steady-state: ≤1 main flush + ≤3 small compactions per JID per day. Inactive JIDs cost 0.

To wipe one chat's journal: `rm -rf data/journal/<safe-jid>/`. To edit an entry: open the file directly. Bridge re-reads on every message.

### Why bypassPermissions is on

The container/sandbox boundary is the security boundary. Permission prompts inside the container only add friction. The system prompt instructs Claude to be the safety check; confirm in chat before destructive actions, don't auto-yes.

### Why no slash commands

User-tested preference. Natural language is the affordance. Mutable state (whitelist, sessions, allowed groups) lives in files Claude can edit. The user says "let X message you" or "forget our last chat" and Claude resolves it via the file system.

### Why groups are gated

Without a gate, anyone who adds the bot to a group could spam it; every message in every group would burn tokens. The gate (`data/allowed-groups.json`, checked before any SDK call) means only groups the owner explicitly authorized reach Claude. Non-whitelisted participants in an allowed group are still ignored.

### Why the bridge dir is mode 700

`auth/creds.json` is the WhatsApp linked-device credential; whoever reads it can impersonate the bridge. `.env` holds the whitelist. `/tmp/wa-claude.log` and `data/sessions.json` can leak message content. On shared hosts, default 755 would expose all of these to other local users.

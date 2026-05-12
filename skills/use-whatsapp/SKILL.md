---
name: use-whatsapp
description: Stand up a personal WhatsApp ↔ Claude Code bridge. The user messages a WhatsApp number from their phone and Claude Code (with full agent loop, file tools, bash) replies. Uses Anthropic subscription auth (no per-token charges). Per-chat session continuity, daily 5am session resets with pre-flush memory extraction, three-role LID whitelist (owner / full-trust / restricted), group chat support with privacy mode (auto-allowed when an owner or full-trust user adds the bot), reply-to-message support, user-defined cron jobs scheduled in natural language, no slash commands. Optional auto-start (`/custom-cont-init.d/` on LinuxServer.io/EnvHaven, s6-rc, systemd-user, or launchd) so the bridge survives reboots. This skill builds a standalone Claude Code bridge.
---

# Use WhatsApp

Stand up a self-hosted bridge so the user can talk to Claude Code from WhatsApp. Each incoming WhatsApp message becomes a Claude Agent SDK `query()` call running with full Code tool access (Bash, Read, Edit, Glob, etc.). Replies stream back to the chat. Conversation context is preserved per-chat via the SDK's session resume.

The bridge runs as a Node process. Step 6 launches it in a tmux window so the QR is visible during pairing; Step 10 optionally migrates it to a system service (`/custom-cont-init.d/` on LinuxServer.io, s6 / systemd-user / launchd elsewhere) so it survives reboots. Auth is via WhatsApp's linked-device QR; the user's Anthropic subscription provides the model, no API key, no per-token charges.

## What the user gets

- Full Claude Code agent loop in WhatsApp (Bash, file edits, web fetch, all tools).
- Conversation context preserved per WhatsApp chat (SDK session resume).
- Daily session reset at 5am with pre-flush memory extraction. The flush prompt is structured as a **strict decision tree** (journal / SOUL / feedback-mem / project-mem / reference-mem / TOOLS / CLAUDE) with an anti-redundancy rule, so the same fact never lands in two places.
- **Three-role LID-based whitelist** (re-read on every message, no restart when edited). `OWNER_LID`: one LID with full trust plus authority to mutate the whitelist via natural language. `WHITELIST_NUMBERS`: comma-separated full-trust LIDs (everything the owner can do, except whitelist edits). `RESTRICTED_LIDS`: read-only LIDs. Restricted senders are hard-gated at the SDK level — the bridge passes `tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']` to the Agent SDK `query()` call for those turns, so `Bash`, `Edit`, `Write`, `NotebookEdit` are not in the model's context. The per-message system-prompt addendum remains as defense in depth.
- Read receipts (blue ticks) on incoming messages.
- Typing indicator while Claude is working.
- Markdown → WhatsApp formatting (bold, italic, strikethrough, code blocks, bullets) with chunking for long replies.
- **Reply-to-message support**: when the user quote-replies in WhatsApp, the bridge prepends `[The user is replying to "..."]` to Claude's prompt. Outbound replies auto-quote only when threading is genuinely ambiguous; group chats, or when the user sent newer messages while Claude was working; so calm 1:1 chats stay clean.
- **Media handling**: images, videos, documents, stickers, **and voice notes** are downloaded to `data/attachments/<jid>/<msg-id>.<ext>` and surfaced to Claude as absolute paths in a bracketed prefix (`[image attached: …]`, `[audio attached: …]`, `[document attached: …]`, etc.). Claude's `Read` tool renders images and PDFs natively; other formats (audio, video, archives) are handled via `Bash` on demand. The bridge ships **no built-in transcription**; if the user wants voice notes auto-transcribed, Claude offers a tight set of ad-hoc install options on the first audio (see "Adjacent services" in `templates/TOOLS.md`).
- **Group chat support with privacy mode**: bot ignores groups by default; when an **owner or full-trust** user adds it to a group, the bridge auto-records that group in `data/allowed-groups.json` and starts responding there. Restricted senders cannot auto-allow groups. Inside an allowed group, only senders with a role get replies; non-whitelisted members are still ignored. Owner can revoke a group by editing the file (Claude can do it via natural language). No tokens spent on un-allowed traffic; the gate runs before any Claude call. **Group privacy mode**: every reply in any allowed group runs with a system prompt addendum instructing Claude to abstract paths, secrets, and architecture details (heuristic; reduces leak surface to non-whitelisted readers).
- **Optional auto-start**: install as a LinuxServer.io `/custom-cont-init.d/` script (recommended on EnvHaven, only path that survives image upgrade there), an s6-rc service (when `/etc/s6-overlay/` is host-mounted), a systemd-user service, or a launchd agent. Skill probes the env and offers the best fit.
- **Cron jobs scheduled in natural language**. The user says "agendá un cron que cada lunes 9am me mande mi agenda" and Claude writes an entry to `data/crons.json` (5 fields: `jid`, `creatorLid`, `schedule`, `prompt`, `lastRun`); the in-process scheduler (60s tick, IANA timezone via `CRON_TIMEZONE`, `croner` library) re-reads the file each tick, so listing/editing/deleting is also natural language. Idempotent (`lastRun` persisted before fire), self-healing (catch-up after downtime collapses N missed runs into one fire), serialized through the same per-JID queue as messages so a 4:59am cron never races the 5am flush. Restricted senders cannot mutate the file (existing role gate).
- No slash commands; everything driven by natural language and file edits.
- Permissions are bypassed inside the container/sandbox; the system prompt instructs Claude to confirm before destructive actions and to enforce per-sender role limits (no whitelist edits except for the owner; no mutation tools for restricted senders; group-privacy abstraction in any allowed group). See *Security model and threat scope* in `templates/TOOLS.md` for the full threat model.

## When to use

The user wants to message Claude Code from their phone. Triggers:

- "let me talk to Claude Code on WhatsApp"
- "WhatsApp bridge for Claude"
- "/use-whatsapp"

Do NOT use this skill for: business-API integrations (this uses linked-device, not the official WhatsApp Business API), sending automated outbound messages (this is bidirectional chat), or installing **adjacent agent services** (transcription daemons, YouTube transcript fetchers, Camofox, OCR pipelines, etc.); those are user-driven, ad-hoc, sibling-dir installs documented in `templates/TOOLS.md` → "Adjacent services". The skill builds the bridge and stops there.

## Security model

This skill stands up a remote control channel for Claude Code. Anyone whose WhatsApp LID is whitelisted gets the bridge's host as if it were their shell, mediated by Claude running with `bypassPermissions`. Treat installing this skill the way you treat handing out an SSH key.

**Intended use:** a single owner (you) drives Claude Code from your phone, on a host you control. Personal homelabs, dev workstations, self-hosted containers where you are the only operator.

**Not suitable for:** shared production hosts, multi-tenant environments, hosts holding third-party data, or any setting where "Claude can run arbitrary `Bash`" is not a property you actively want.

**What is enforced:**

- Group chats are ignored by default; only owner/full-trust senders can auto-allow a group by adding the bot.
- Sender-role gate runs before any Claude call (no tokens spent on un-whitelisted traffic).
- Restricted role is hard-gated at the SDK level: the `tools` option on the Agent SDK `query()` call restricts the model to `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`. `Bash`, `Edit`, `Write`, `NotebookEdit` are not in the model's context for those senders. The system-prompt role addendum remains as defense in depth.
- Group privacy addendum instructs Claude to abstract paths, secrets, and architecture details whenever the conversation runs in a group.
- `.env` is `chmod 600`-ed on boot in case it was copied from `.env.example` with a looser umask.
- Media attachments are written `mode 0600` and aged out on the daily flush after 28 days, unless their basename is referenced from SOUL/TOOLS/CLAUDE, the journal, or auto-memory (same decision tree as memory itself).
- Log lines never contain message text or reply previews; only sender ID, role, and counts.

**What is NOT enforced (deliberately):**

- `bypassPermissions` is the design, not a bug. Owner and full-trust senders get full tools. If you wouldn't let this sender run `sudo` on the host, do not whitelist them.
- The `restricted` role's intent (read-only) is enforced via the SDK `tools` gate, but the role assignment itself lives in `.env`. An attacker with write access to `.env` can promote themselves; the boot-time chmod is hygiene, not a substitute for filesystem-level protection.
- No rate-limiting per sender. This is a personal bridge, not a public endpoint.

See `templates/TOOLS.md` → *Security model and threat scope* for the full threat enumeration.

## Wizard pacing

This skill is wizard-style. Every step that needs a decision uses `AskUserQuestion`; every step that needs the user to do something physical (scan a QR, send a test message, type a sudo password) **waits for explicit confirmation** before polling. Don't barrel through. The user gets to choose, and to redirect at any point.

`$SKILL_DIR` is **`dirname` of this `SKILL.md`'s absolute path**; you already know it because you read this file to follow these instructions. Do not guess; do not fall back to `~/.claude/skills/use-whatsapp/`.

## Step 0; Pre-flight checks

Probe the environment. Hard requirements must be present; for soft ones, offer to install. Record what's available so Step 10 can pick the right auto-start path.

```bash
# Hard requirements
node --version                                            # need v20+
tmux -V                                                   # any modern version
test -f ~/.claude/.credentials.json && echo "claude: OK" # subscription auth file
command -v pnpm || command -v npm                         # at least one package manager

# Init systems (record results for Step 10).  For each candidate path that
# could host an auto-start file, also record whether it is bind-mounted from
# the host (different device id from /etc means host-mounted, scripts placed
# there will survive container recreation / image upgrade).  In LinuxServer.io
# images (including EnvHaven), only host-mounted paths survive recreation;
# the image rootfs is destroyed when the container is recreated.
ETC_DEV=$(stat -c %D /etc 2>/dev/null)

if [ -d /custom-cont-init.d ]; then
  CCI_DEV=$(stat -c %D /custom-cont-init.d)
  if [ -n "$CCI_DEV" ] && [ "$CCI_DEV" != "$ETC_DEV" ]; then
    echo "init: custom-cont-init.d (host-mounted, persistent)"
  else
    echo "init: custom-cont-init.d (image overlay, NOT persistent across recreation)"
  fi
fi
if [ -d /etc/s6-overlay/s6-rc.d ] && command -v s6-svc >/dev/null; then
  S6_DEV=$(stat -c %D /etc/s6-overlay)
  if [ -n "$S6_DEV" ] && [ "$S6_DEV" != "$ETC_DEV" ]; then
    echo "init: s6-overlay (host-mounted, persistent)"
  else
    echo "init: s6-overlay (image overlay, NOT persistent across recreation)"
  fi
fi
command -v systemctl >/dev/null && systemctl --user daemon-reload 2>/dev/null && echo "init: systemd-user"
[ "$(uname)" = "Darwin" ] && command -v launchctl >/dev/null && echo "init: launchd"

# Sudo style: needed for /custom-cont-init.d/, s6-overlay, and systemd-user linger
sudo -n true 2>/dev/null && echo "sudo: passwordless" || echo "sudo: requires password"
```

If `node` < 20: `AskUserQuestion` → offer to upgrade or abort. If `tmux` is missing on macOS, `brew install tmux`; on Debian/Ubuntu, `sudo apt install -y tmux` (confirm first). If `~/.claude/.credentials.json` is missing, instruct the user to run `claude /login` in another terminal and re-invoke the skill; don't proceed.

## Step 0.5; Detect existing install and route

If a bridge is already installed, **the rest of the install flow (Steps 1–9) is the wrong path**; it asks decisions you've already made and risks clobbering live state. Probe before asking the user anything.

```bash
EXISTING_BRIDGE=""

# Service-file probes give the most authoritative location (the bridge dir is
# recorded inside the unit / run script). Try these first.
[ -f ~/.config/systemd/user/wa-claude.service ] && \
  EXISTING_BRIDGE=$(grep -oP '^WorkingDirectory=\K.*' ~/.config/systemd/user/wa-claude.service 2>/dev/null)
[ -z "$EXISTING_BRIDGE" ] && [ -f ~/Library/LaunchAgents/dev.user.wa-claude.plist ] && \
  EXISTING_BRIDGE=$(plutil -extract WorkingDirectory raw ~/Library/LaunchAgents/dev.user.wa-claude.plist 2>/dev/null)
[ -z "$EXISTING_BRIDGE" ] && [ -f /etc/s6-overlay/s6-rc.d/svc-wa-claude/run ] && \
  EXISTING_BRIDGE=$(grep -oP '^cd \K.*' /etc/s6-overlay/s6-rc.d/svc-wa-claude/run 2>/dev/null)
# /custom-cont-init.d/ scripts (LinuxServer.io / EnvHaven Option A).  Match any
# numeric prefix.  The script captures BRIDGE_DIR=<path> as a literal at install
# time, so a simple grep recovers it.
if [ -z "$EXISTING_BRIDGE" ]; then
  for f in /custom-cont-init.d/*-wa-claude.sh; do
    [ -f "$f" ] || continue
    EXISTING_BRIDGE=$(grep -oP '^BRIDGE_DIR=\K.*' "$f" | head -1)
    [ -n "$EXISTING_BRIDGE" ] && break
  done
fi

# Fall back to filesystem probes of common locations.
if [ -z "$EXISTING_BRIDGE" ]; then
  for cand in /config/.whatsapp "$XDG_STATE_HOME/whatsapp-claude" "$HOME/.whatsapp-claude" /config/workspace/whatsapp-claude "$PWD/whatsapp-claude"; do
    [ -d "$cand" ] && [ -f "$cand/.env" ] && [ -d "$cand/src" ] && EXISTING_BRIDGE="$cand" && break
  done
fi
```

If `$EXISTING_BRIDGE` is empty, no bridge installed; continue to Step 1.

Otherwise probe its health (single-user-friendly, no sudo needed):

```bash
PROC_ALIVE=$(pgrep -f "tsx.*$EXISTING_BRIDGE/src/index" >/dev/null && echo yes || echo no)
AUTH_OK=$(test -f "$EXISTING_BRIDGE/auth/creds.json" && echo yes || echo no)
OWNER=$(grep -E '^OWNER_LID=' "$EXISTING_BRIDGE/.env" 2>/dev/null | sed 's/^OWNER_LID=//' | head -1)
WL=$(grep -E '^WHITELIST_NUMBERS=' "$EXISTING_BRIDGE/.env" 2>/dev/null | sed 's/^WHITELIST_NUMBERS=//' | head -1)
WL_OK=$({ [ -n "$OWNER" ] || { [ -n "$WL" ] && [ "$WL" != "BOOTSTRAP" ]; }; } && echo yes || echo no)
```

`AskUserQuestion`: **Existing bridge detected at `$EXISTING_BRIDGE` (proc=$PROC_ALIVE, auth=$AUTH_OK, whitelist=$WL_OK, owner=${OWNER:-none}). What do you want to do?**

- **Update bridge code** (Recommended); refresh template files (`src/`, `package.json`, `run.sh`), reinstall deps, restart. Preserves `auth/`, `data/`, `.env`. See *Management actions → M1 Update bridge code*
- **Add a WhatsApp sender**; capture a new LID, ask for role (full-trust or restricted), append to the right list. See *Management actions → M3 Add sender*
- **Diagnose and repair**; run sanity checks against the existing install, propose fixes for whatever's broken. See *Management actions → M2 Diagnose and repair*
- **Reinstall fresh**; back up the existing dir to `${EXISTING_BRIDGE}.bak.<ts>` and run Steps 1–9 from scratch. Requires QR rescan.

For "Reinstall fresh", `mv "$EXISTING_BRIDGE" "${EXISTING_BRIDGE}.bak.$(date +%s)"` and continue to Step 1. For the other three, jump to the named subsection; Steps 1–9 don't apply.

Free-text answers (e.g. "uninstall", "migrate auto-start to systemd") are not pre-canned options; handle them by reading the bridge's `README.md` (under "Uninstall auto-start") and *Step 10* below, and walking the user through the relevant pieces.

## Step 1; Workspace and bridge placement

Compute defaults from the environment. **Don't ask if the defaults are unambiguous** (EnvHaven detected, only one writable choice); only `AskUserQuestion` when the heuristic is in doubt.

```bash
# Workspace default
if [ -d /config/workspace ] && [ -w /config/workspace ]; then
  WORKSPACE_DEFAULT=/config/workspace                  # EnvHaven
else
  WORKSPACE_DEFAULT=$PWD
fi

# Bridge dir default (sibling of workspace; keeps the workspace tree clean)
if [ "$WORKSPACE_DEFAULT" = "/config/workspace" ]; then
  BRIDGE_DEFAULT=/config/.whatsapp                     # EnvHaven sibling pattern
elif [ -n "$XDG_STATE_HOME" ]; then
  BRIDGE_DEFAULT="$XDG_STATE_HOME/whatsapp-claude"
else
  BRIDGE_DEFAULT="$HOME/.whatsapp-claude"
fi
```

If `WORKSPACE_DEFAULT=/config/workspace` (EnvHaven), set `WORKSPACE_DIR` and `BRIDGE_DIR` directly to the defaults and skip the prompt. Otherwise `AskUserQuestion` once: **"Workspace `$WORKSPACE_DEFAULT`, bridge runtime at `$BRIDGE_DEFAULT`. Proceed, or specify alternatives?"**, with options **Proceed (recommended)** and **Customize**.

Account choice (personal number vs dedicated) is the user's decision in their phone, not in the skill: both paths produce identical bridge behavior. Don't ask.

Verify: `test -d "$WORKSPACE_DIR" && test -w "$WORKSPACE_DIR"` and `test -d "$(dirname "$BRIDGE_DIR")" && test -w "$(dirname "$BRIDGE_DIR")"`. Abort with a clear message if either fails.

## Step 2; Create the bridge project

Check for collisions first:

```bash
test -d "$BRIDGE_DIR" && echo "exists"
```

If it exists, `AskUserQuestion`: **A bridge directory already exists at `$BRIDGE_DIR`. What should I do?**
- **Update templates** (Recommended); refresh `src/`, `package.json`, `run.sh`; preserve `auth/`, `data/`, `.env`. Jump to *Management actions → M1*
- **Reuse existing**; skip Steps 2–4 and verify it still runs (Step 6 onward)
- **Reinstall (back up old)**; move it to `${BRIDGE_DIR}.bak.<timestamp>` and create fresh
- **Abort**; exit the skill

Otherwise create and copy templates:

```bash
mkdir -p "$BRIDGE_DIR/src"
chmod 700 "$BRIDGE_DIR"   # restrict so other host users can't read auth/, .env, or logs inside
cp "$SKILL_DIR/templates/package.json"     "$BRIDGE_DIR/"
cp "$SKILL_DIR/templates/tsconfig.json"    "$BRIDGE_DIR/"
cp "$SKILL_DIR/templates/.gitignore"       "$BRIDGE_DIR/"
cp "$SKILL_DIR/templates/.env.example"     "$BRIDGE_DIR/"
cp "$SKILL_DIR/templates/README.md"        "$BRIDGE_DIR/"
cp "$SKILL_DIR/templates/src/whatsapp.ts"  "$BRIDGE_DIR/src/"
cp "$SKILL_DIR/templates/src/claude.ts"    "$BRIDGE_DIR/src/"
cp "$SKILL_DIR/templates/src/format.ts"    "$BRIDGE_DIR/src/"
cp "$SKILL_DIR/templates/src/index.ts"     "$BRIDGE_DIR/src/"
cp "$SKILL_DIR/templates/run.sh"           "$BRIDGE_DIR/"
chmod +x "$BRIDGE_DIR/run.sh"
```

The `chmod 700` on the bridge dir means files inside (auth/, .env, data/, the log if you put it here) are inaccessible to other host users **regardless of their individual modes**. Harmless on single-user containers; important on multi-user hosts.

## Step 3; Install dependencies

```bash
cd "$BRIDGE_DIR"
if command -v pnpm >/dev/null; then pnpm install; else npm install; fi
```

If `pnpm` exits with `132` (SIGILL; older x86_64 without AVX2, common in containers), fall back to `npm install`. **Don't use Bun**; unreliable on the same CPUs even when `bun --version` works.

## Step 4; Initial `.env` (with bootstrap workaround)

```bash
# Don't clobber an existing .env; only seed from .env.example if absent.
[ -f "$BRIDGE_DIR/.env" ] || cp "$BRIDGE_DIR/.env.example" "$BRIDGE_DIR/.env"
chmod 600 "$BRIDGE_DIR/.env"

# Only set CLAUDE_CWD if empty/missing (preserve any manual edit from a prior install).
grep -qE '^CLAUDE_CWD=.+' "$BRIDGE_DIR/.env" || \
  sed -i "s|^CLAUDE_CWD=.*|CLAUDE_CWD=$WORKSPACE_DIR|" "$BRIDGE_DIR/.env"

# Only set WHITELIST_NUMBERS=BOOTSTRAP if empty/missing (preserve real LIDs).
grep -qE '^WHITELIST_NUMBERS=.+' "$BRIDGE_DIR/.env" || \
  sed -i "s|^WHITELIST_NUMBERS=.*|WHITELIST_NUMBERS=BOOTSTRAP|" "$BRIDGE_DIR/.env"
```

`CLAUDE_CWD` stays pointed at the **workspace** even though the bridge lives elsewhere. That's deliberate: the bridge's process CWD is its own dir (relative paths for `data/`, `auth/`, `.env` resolve there), but the Agent SDK's `cwd` option; what Claude actually operates in via Read/Edit/Bash; is the user's workspace. This decoupling is what makes "bridge outside the workspace" work cleanly.

**Don't ask the user for their phone number.** WhatsApp's modern privacy mode hides senders' phones from the bridge; you initially only see opaque **LIDs** like `111222333444555` (a 15-digit identifier with no relation to the phone number). The user can't know their LID in advance; we capture it in Step 7. (The bridge resolves LIDs to phone numbers opportunistically as Baileys observes them via `chats.phoneNumberShare` events and the per-message `senderPn` field; the whitelist accepts either form. But at bootstrap only the LID is reliable, and LID-form entries always work without depending on the resolver.)

`WHITELIST_NUMBERS=BOOTSTRAP` is a placeholder so the bridge will start (it refuses to boot with an empty whitelist; otherwise every WhatsApp message would reach Claude). `BOOTSTRAP` is non-empty but won't match any real LID, so messages get logged as ignored; exactly what we need to capture the user's LID.

## Step 5; Set up SOUL.md and TOOLS.md

Copy templates only if files don't already exist (don't clobber existing content):

```bash
test -f "$WORKSPACE_DIR/SOUL.md"  || cp "$SKILL_DIR/templates/SOUL.md"  "$WORKSPACE_DIR/SOUL.md"
test -f "$WORKSPACE_DIR/TOOLS.md" || cp "$SKILL_DIR/templates/TOOLS.md" "$WORKSPACE_DIR/TOOLS.md"
```

SOUL.md and TOOLS.md stay at the workspace root even when the bridge lives outside the workspace; they're part of the workspace's agent-instruction surface (alongside `AGENTS.md`/`CLAUDE.md`), not infrastructure.

> **EnvHaven note.** Step 5's prepend to `CLAUDE.md` and `AGENTS.md` (below) only persists across container restarts on EnvHaven versions with the AGENTS.md no-clobber fix ([envhaven@e96e81b](https://github.com/envhaven/envhaven/commit/e96e81b92f2b2620a6f8c16b90bf14b6562e18b8), May 2026). On older versions, `init-agents-md` regenerates both files on every container init, wiping the prepend. If unsure, pull the latest EnvHaven image before continuing, or rely on the auto-memory `MEMORY.md` index (which Claude Code loads independently) to surface SOUL/TOOLS to Claude. A `MEMORY.md` entry is not subject to the regeneration.

Then ensure both `<WORKSPACE_DIR>/CLAUDE.md` **and** `<WORKSPACE_DIR>/AGENTS.md` reference SOUL/TOOLS. Both files matter: Claude Code reads `CLAUDE.md`, OpenAI Codex and many other agents read `AGENTS.md`, and on EnvHaven the two are regenerated as identical copies. The skill applies the same prepend to both, skipping ones that don't exist or already have the reference. Prefer `@` import directives over plain markdown links: `@` makes Claude Code (and other agents that honor the convention) inline the file's contents into the prompt, while a markdown link only documents that the file should be read.

For each of `CLAUDE.md` and `AGENTS.md`:

1. **File exists and already references SOUL.md/TOOLS.md** (`grep -qE '@\./SOUL\.md|\[SOUL\.md\]|\[\`SOUL\.md\`\]'`) → skip silently.
2. **File exists but lacks the reference** → prepend the snippet without asking. Idempotent and additive (never destructive).
3. **Neither file exists** → write the snippet to `CLAUDE.md` as the file's sole content. The user grows it later.

If any of these surprises the user, the prepend is small enough to revert by hand. Asking twice (once per file) is the wrong friction; the answer is almost always yes, and the cost of "no" is a one-line `git revert`.

Pseudocode:

```bash
PREPEND_FILE=$(mktemp); cat > "$PREPEND_FILE" <<'SNIPPET'
<paste the snippet below here>
SNIPPET

ensure_refs() {
  local f="$1"
  [ -f "$f" ] || return 0
  grep -qE '@\./SOUL\.md|\[SOUL\.md\]|\[`SOUL\.md`\]' "$f" && return 0
  # AskUserQuestion to prepend; on Yes:
  cat "$PREPEND_FILE" "$f" > "$f.new" && mv "$f.new" "$f"
}
ensure_refs "$WORKSPACE_DIR/CLAUDE.md"
ensure_refs "$WORKSPACE_DIR/AGENTS.md"
rm "$PREPEND_FILE"
```

The snippet:

```markdown
## Persistent state, read first

@./SOUL.md
@./TOOLS.md

Both files above are evergreen workspace state. **Read them at the start of every session.** Claude Code auto-imports the contents via the `@` directives above; if your agent does not understand `@`, open them via the markdown links below.

- [`SOUL.md`](./SOUL.md): user identity, tone, language, durable cross-channel preferences (web IDE, CLI, WhatsApp bridge). Update the moment the user expresses a preference about behavior. Channel-specific rules go in `feedback` auto-memories instead.
- [`TOOLS.md`](./TOOLS.md): runtime config for **services you operate locally on this host** (daemons, sibling containers you start and stop, env vars, ports, restart commands, hardware constraints). One section per service. Delta from this file, not a re-listing.

Edit both in place when state changes (no append-only logs, no dated entries). If a fact is wrong or stale, fix or remove it.

The auto-memory directory at `~/.claude/projects/<encoded-cwd>/memory/` holds the rest, indexed by `MEMORY.md`:

- `feedback_*.md`: validated rules the user gave (with **Why** and **How to apply**).
- `project_*.md`: cross-chat project state (active goals, ongoing initiatives).
- `reference_*.md`: **external services you only consume** (third-party APIs, dashboards, sibling containers reached only via HTTP whose lifecycle is someone else's problem). Endpoint, auth, capabilities, common operations.

**Where does a new tool live?** If you operate it (start, stop, configure, debug when it crashes), `TOOLS.md`. If you only call it over the wire and someone else keeps it alive, `reference_*.md` in auto-memory. The interaction surface decides the home, not the physical location: a daemon that moves to a vendor's cloud stops being TOOLS.md material the day you stop operating it.
```

## Step 6; Authenticate (QR scan)

Launch via `run.sh`; the resilient supervisor copied in Step 2. It traps `SIGINT` so the user can `Ctrl-C` the inner Node process to force a restart while the wrapper keeps looping; to **fully stop**, kill the tmux pane (`tmux kill-window -t "$TMUX_SESSION:wa-claude"`). The script also handles `umask 077` and `chmod 600` on `/tmp/wa-claude.log` (which can contain message text).

```bash
TMUX_SESSION="${TMUX_SESSION_NAME:-$(tmux display-message -p '#S' 2>/dev/null || echo claude)}"

# Ensure session exists (idempotent; no-op if already present).
tmux has-session -t "$TMUX_SESSION" 2>/dev/null || tmux new-session -d -s "$TMUX_SESSION"

# Window may already exist from a prior install. Three cases:
#   - window present + process alive  → reuse, skip launch
#   - window present + process dead   → restart inside it (don't spawn duplicate)
#   - window absent                   → create and launch
#
# Always address windows by **numeric index** (`$SESSION:$INDEX`), not by name
# (`$SESSION:wa-claude`).  Some environments (notably EnvHaven) install tmux
# hooks that rewrite name-form targets before send-keys sees them, producing a
# confusing `can't find pane: <some-path>` error.  Numeric indices bypass
# every name-resolution hook.
WA_INDEX=$(tmux list-windows -t "$TMUX_SESSION" -F '#I #W' 2>/dev/null | awk '$2 == "wa-claude" {print $1; exit}')
if [ -n "$WA_INDEX" ]; then
  if pgrep -f "tsx.*$BRIDGE_DIR/src/index" >/dev/null; then
    echo "Bridge already running in tmux:$TMUX_SESSION:$WA_INDEX (wa-claude); reusing"
  else
    tmux send-keys -t "$TMUX_SESSION:$WA_INDEX" "./run.sh" Enter
  fi
else
  WA_INDEX=$(tmux new-window -d -t "$TMUX_SESSION" -n wa-claude -c "$BRIDGE_DIR" -P -F '#{window_index}')
  tmux send-keys -t "$TMUX_SESSION:$WA_INDEX" "./run.sh" Enter
fi
```

If you install Option A (`/custom-cont-init.d/`), the init script launches `./run.sh` so the in-process wrapper continues to handle crash respawn (the init script itself only runs once per container start).  If you install Options B–D (s6-rc, systemd-user, launchd), the OS-level supervisor handles restart natively, and those `run`/`ExecStart` scripts invoke `pnpm start` directly without the wrapper loop.

Wait until the bridge surfaces a sign of life; poll, don't blind-sleep. If `auth/creds.json` already exists (re-running against an authed install), no QR will appear; poll for the connect line instead and skip the QR prompts entirely:

```bash
if [ -f "$BRIDGE_DIR/auth/creds.json" ]; then
  for i in $(seq 1 30); do
    grep -q '✅ Connected to WhatsApp as' /tmp/wa-claude.log && echo "Reconnected (auth survived)" && break
    sleep 1
  done
  echo "Auth state present; skipping QR scan."
else
  # Snapshot baseline so historical QRs in the log don't trigger false positives.
  LOG_BASELINE=$(wc -l < /tmp/wa-claude.log 2>/dev/null || echo 0)
  for i in $(seq 1 30); do
    tail -n +"$((LOG_BASELINE + 1))" /tmp/wa-claude.log 2>/dev/null | grep -q '▄' && echo "QR ready" && break
    sleep 1
  done
fi
```

If 30 attempts pass without either signal, dump the last 30 log lines to the user; most likely a startup error (Node version, dependency install failure, missing `.env`).

If auth was present and the connect line appeared, **skip the rest of Step 6** (no QR scan, no AskUserQuestion below) and continue to Step 7. Otherwise, tell the user:

> The QR code is in tmux window `wa-claude` (session `$TMUX_SESSION`). Switch with **Ctrl+B 2** (or click the window in your tmux/IDE sidebar). On your phone:
>
> 1. Open WhatsApp
> 2. Settings → **Linked Devices** → **Link a Device**
> 3. Scan the QR
>
> The QR rotates every ~60s; if it refreshes mid-scan, scan the new one.

`AskUserQuestion`: **Have you scanned the QR?**
- **Yes; scanned it** (proceed)
- **Not yet, give me a moment** (re-ask after the user is ready)
- **It's not working** (troubleshoot; see "QR not rendering" / "Code 515" in the troubleshooting section)

After scan, the log shows code `515` (`restartRequired`) followed immediately by a successful reconnect; normal post-pairing. Verify:

```bash
grep '✅ Connected to WhatsApp as' /tmp/wa-claude.log | tail -1
```

If empty after 30s of polling, the scan didn't complete; re-prompt. Don't assume success.

## Step 7; Capture the user's LID and assign OWNER_LID

WhatsApp exposes senders as opaque **LIDs** (Linked Identifiers, `<digits>@lid`), not phone numbers. The role slots in `.env` use LIDs, and there's no way to know a person's LID before they message the bot once. Step 7 captures the install operator's LID and writes it to `OWNER_LID`. Subsequent senders are added later via M3 with a role choice (full-trust or restricted); the operator stays the only LID with whitelist-edit authority.

**Skip this step entirely if `OWNER_LID` is already set, or if `WHITELIST_NUMBERS` has real LIDs** (re-run after update or repair). Adding *new* senders is M3, not a re-run of Step 7:

```bash
CURRENT_OWNER=$(grep -E '^OWNER_LID=' "$BRIDGE_DIR/.env" | sed 's/^OWNER_LID=//' | head -1)
CURRENT_WL=$(grep -E '^WHITELIST_NUMBERS=' "$BRIDGE_DIR/.env" | sed 's/^WHITELIST_NUMBERS=//' | head -1)
if [ -n "$CURRENT_OWNER" ] || { [ -n "$CURRENT_WL" ] && [ "$CURRENT_WL" != "BOOTSTRAP" ]; }; then
  echo "Roles already populated (owner=${CURRENT_OWNER:-none}, full=$CURRENT_WL); skipping LID capture."
  # → continue to Step 8
fi
```

Otherwise, **snapshot the log size before prompting** so we only consider lines logged *after* the user sends their test message. If older `Ignored message from` entries exist (previous installs, other senders that messaged during downtime), naive `tail -1` would pick the wrong LID:

```bash
LOG_BASELINE=$(wc -l < /tmp/wa-claude.log)
```

Tell the user:

> Now message the bot from your phone (any text, e.g. "hi"). The first message gets dropped because no role matches yet (`WHITELIST_NUMBERS=BOOTSTRAP` is just a placeholder). It'll show up in the log as `Ignored message from <LID>`, with `(+<phone>)` alongside once Baileys has resolved the mapping (may take a message or two). I'll capture the LID and write it to `OWNER_LID`: this is your install, you bootstrap as the owner. Other senders can be added later by re-running the skill and asking to add a sender.

`AskUserQuestion`: **Have you sent the test message?**
- **Yes; sent it** (proceed to poll)
- **Not yet** (re-ask)

Poll only **new** lines (after the baseline) up to ~60s, collecting all unique LIDs:

```bash
CANDIDATES=""
for i in $(seq 1 30); do
  CANDIDATES=$(tail -n +"$((LOG_BASELINE + 1))" /tmp/wa-claude.log \
    | grep -oP 'Ignored message from \K\d+' | sort -u | paste -sd ',' -)
  [ -n "$CANDIDATES" ] && break
  sleep 2
done
echo "Candidate LIDs: $CANDIDATES"
```

If the poll times out, ask the user to verify they sent a message and re-poll.

**Always confirm via AskUserQuestion**, even with a single candidate. The bridge cannot verify the captured LID belongs to the operator; if your bot's number leaked, a stranger could have messaged during the window. The single LID you'd otherwise auto-confirm could be theirs:

`AskUserQuestion`: **Confirm OWNER_LID. Captured `<candidate(s)>`. Which one is yours?**
- **`<lid-1>`** (with phone if Baileys resolved it: `(+<phone-1>)`)
- **`<lid-2>`** (if multiple candidates)
- **None of these; retry** (re-snapshot baseline and ask the user to send another test message)

When confirmed, write to `OWNER_LID` and clear the bootstrap placeholder:

```bash
sed -i "s|^OWNER_LID=.*|OWNER_LID=$LID|" "$BRIDGE_DIR/.env"
sed -i "s|^WHITELIST_NUMBERS=BOOTSTRAP$|WHITELIST_NUMBERS=|" "$BRIDGE_DIR/.env"
```

The bridge re-reads `.env` on every message; no restart needed. Tell the user to send another test message; this one should reach Claude. Verify:

```bash
sleep 6 && tail -10 /tmp/wa-claude.log | grep -E '\[\d+/owner\] →|← \d+ turns'
```

A successful round-trip: `[111222333444555/owner] → hello` followed by `← 1 turns, $0.0XXX`. The `/owner` suffix confirms the role gate read `OWNER_LID` correctly.

## Step 8; Finalize TOOLS.md WhatsApp section

The skill copied a template TOOLS.md in Step 5 with `<placeholder>` markers throughout the WhatsApp section. Now substitute every install-specific value so the section reflects this exact install: paths, bot number, current whitelist, tmux session, package versions. Future Claude sessions read TOOLS.md first; the goal is that they have everything they need to operate, debug, or extend the bridge without re-asking the user.

Capture install state:

```bash
BOT_NUMBER=$(grep -oP '✅ Connected to WhatsApp as \K\d+' /tmp/wa-claude.log | tail -1)
OWNER_LID_VAL=$(grep -E '^OWNER_LID=' "$BRIDGE_DIR/.env" | sed 's/^OWNER_LID=//')
WHITELIST_LIDS=$(grep -E '^WHITELIST_NUMBERS=' "$BRIDGE_DIR/.env" | sed 's/^WHITELIST_NUMBERS=//')
RESTRICTED_LIDS_VAL=$(grep -E '^RESTRICTED_LIDS=' "$BRIDGE_DIR/.env" | sed 's/^RESTRICTED_LIDS=//')
NODE_VER=$(node --version | sed 's/^v//')
BAILEYS_VER=$(grep -oP '"@whiskeysockets/baileys":\s*"\K[^"]+' "$BRIDGE_DIR/package.json" | head -1)
PKG_MGR=$(command -v pnpm >/dev/null && echo pnpm || echo npm)
```

Substitute placeholders (idempotent: safe to re-run, since unmatched placeholders are no-ops):

```bash
sed -i \
  -e "s|<bridge-dir>|$BRIDGE_DIR|g" \
  -e "s|<workspace>|$WORKSPACE_DIR|g" \
  -e "s|<bot-phone>|$BOT_NUMBER|g" \
  -e "s|<tmux-session>|${TMUX_SESSION:-claude}|g" \
  -e "s|<owner-lid>|${OWNER_LID_VAL:-(none)}|g" \
  -e "s|<whitelist>|${WHITELIST_LIDS:-(none)}|g" \
  -e "s|<restricted>|${RESTRICTED_LIDS_VAL:-(none)}|g" \
  -e "s|<node-version>|$NODE_VER|g" \
  -e "s|<baileys-version>|$BAILEYS_VER|g" \
  -e "s|<pkg-mgr>|$PKG_MGR|g" \
  "$WORKSPACE_DIR/TOOLS.md"
```

The `<run-mechanism>` and `<restart-cmd>` placeholders stay in place until Step 10. If the user declines Step 10 (no auto-start), substitute them now with the manual-start fallback (see Step 10's "Skip" row in the After-install table).

Make sure the user knows the bot's number; they will forget it.

## Step 9; Verify and hand off

Sanity checklist (report to user):

- [ ] Bridge running (`pgrep -f "tsx.*$BRIDGE_DIR/src/index"` returns a PID)
- [ ] Bot's WhatsApp number: **+`$BOT_NUMBER`**
- [ ] Roles (read live from `.env`):
  - OWNER_LID: `$(grep -E '^OWNER_LID=' "$BRIDGE_DIR/.env" | sed 's/^OWNER_LID=//')`
  - WHITELIST_NUMBERS: `$(grep -E '^WHITELIST_NUMBERS=' "$BRIDGE_DIR/.env" | sed 's/^WHITELIST_NUMBERS=//')`
  - RESTRICTED_LIDS: `$(grep -E '^RESTRICTED_LIDS=' "$BRIDGE_DIR/.env" | sed 's/^RESTRICTED_LIDS=//')`
- [ ] Logs: `/tmp/wa-claude.log` (mode 600)
- [ ] Bridge dir mode 700 (other host users can't read auth/, .env, data/)
- [ ] SOUL.md, TOOLS.md exist in `$WORKSPACE_DIR/`, referenced from CLAUDE.md
- [ ] TOOLS.md WhatsApp section: Step 8 placeholders substituted (`grep -n '<bridge-dir>\|<bot-phone>\|<workspace>\|<tmux-session>\|<owner-lid>\|<whitelist>\|<restricted>\|<node-version>\|<baileys-version>\|<pkg-mgr>' "$WORKSPACE_DIR/TOOLS.md"` returns nothing inside the WhatsApp section). `<run-mechanism>`/`<restart-cmd>` are filled by Step 10.
- [ ] Daily reset scheduled (check log for `Daily session reset scheduled for ...`)
- [ ] Round-trip evidence: at least one `← \d+ turns` entry in the recent log (re-runs may not need a fresh test message; auth survived)

Hand off:

> All set. Message the bot at +$BOT_NUMBER. Things to know:
>
> - **No slash commands**; say things in plain English; Claude edits files directly.
> - **Permissions are bypassed** in this bridge; Claude is the safety check; it'll ask before destructive actions.
> - **Sessions reset every day at 5am** local time. Continuity comes from SOUL.md, TOOLS.md, and the auto-memory directory.
> - **Adding more senders**: ask Claude on WhatsApp to "let X message you" (you, the owner, are the only role allowed to authorize this; full-trust senders asking the same get refused and offered to relay). They message the bot first, you tell Claude the LID (or phone, if shown in the log) that just got rejected and pick a role: **full-trust** (everything you can do, except whitelist edits) or **restricted** (read-only). Claude updates `.env`. No restart needed.
> - **Groups**: the bot ignores group chats by default. When you add the bot to a group, the bridge auto-allows that group. Tell Claude "leave that group" or "stop responding in group X" to revoke. Other group members can't talk to the bot unless their LID is whitelisted.
> - **TOOLS.md is the operating manual.** Every install detail (paths, restart command, current whitelist, package versions, auto-start mechanism) lives in `<WORKSPACE_DIR>/TOOLS.md` under the WhatsApp section. Edit it the moment you change config; future Claude sessions read it first and won't have to ask you twice.

Then proceed to Step 10 to offer auto-start.

## Step 10; Auto-start (optional but recommended)

The tmux bridge dies on system reboot, container restart, or tmux server kill. To survive these, install it as a managed service.

`AskUserQuestion`: **Set up auto-start so the bridge survives reboots? [Yes (recommended) / No, manual start only]**

If yes, pick the option from Step 0's probe (no second prompt; the host capabilities determine the choice):

- **Option A** (`/custom-cont-init.d/`): LinuxServer.io / EnvHaven, host-mounted. Survives image upgrade. **Default whenever available.**
- **Option B** (s6-overlay): only when `/etc/s6-overlay/s6-rc.d/` is host-mounted (rare; default EnvHaven layouts have it on image rootfs and lose it on recreation).
- **Option C** (systemd-user): modern Linux desktops/servers.
- **Option D** (launchd): macOS.

### Option A: `/custom-cont-init.d/<NN>-<name>.sh`

`init-custom-files` runs every `*.sh` here at container start, as root, before regular services. When the directory is host-mounted (deliberate customization on EnvHaven), scripts survive recreation and image upgrade.

```bash
USER_NAME=$(stat -c %U "$BRIDGE_DIR")
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
NODE_BIN_DIR=$(dirname "$(command -v node)")
SCRIPT_DST=/custom-cont-init.d/10-wa-claude.sh

cat > /tmp/wa-claude-cont-init.sh <<EOF
#!/bin/bash
BRIDGE_DIR=$BRIDGE_DIR
SESSION=wa-claude
USER_NAME=$USER_NAME

[ -d "\$BRIDGE_DIR" ] || { echo "[wa-claude] bridge dir not found at \$BRIDGE_DIR, skipping"; exit 0; }

# Drop privs. Explicit HOME (SDK reads ~/.claude/credentials) and PATH
# (with-contenv doesn't inherit mise/asdf/nvm).
/command/s6-setuidgid "\$USER_NAME" env \\
    HOME=$HOME_DIR \\
    PATH=$NODE_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
    tmux new-session -d -s "\$SESSION" -c "\$BRIDGE_DIR" "./run.sh"
EOF

echo "$SUDO_PASSWORD" | sudo -S -p '' install -m 755 /tmp/wa-claude-cont-init.sh "$SCRIPT_DST"
rm /tmp/wa-claude-cont-init.sh
```

Smoke-test without waiting for reboot:

```bash
tmux kill-window -t "$TMUX_SESSION:wa-claude"
sleep 2
echo "$SUDO_PASSWORD" | sudo -S -p '' bash /custom-cont-init.d/10-wa-claude.sh
sleep 6 && grep '✅ Connected' /tmp/wa-claude.log | tail -1
```

A fresh `Connected` line confirms the script for next boot.

### Option B: s6-overlay

Only pick when `/etc/s6-overlay/s6-rc.d/` is **host-mounted** (Step 0 records this). On EnvHaven default, route to A instead.

```bash
sudo mkdir -p /etc/s6-overlay/s6-rc.d/svc-wa-claude/dependencies.d
echo "longrun" | sudo tee /etc/s6-overlay/s6-rc.d/svc-wa-claude/type > /dev/null
sudo touch /etc/s6-overlay/s6-rc.d/svc-wa-claude/dependencies.d/init-services
sudo tee /etc/s6-overlay/s6-rc.d/svc-wa-claude/run > /dev/null <<EOF
#!/usr/bin/with-contenv bash
cd $BRIDGE_DIR
umask 077
touch /tmp/wa-claude.log && chmod 600 /tmp/wa-claude.log
exec s6-setuidgid $(whoami) bash -c './run.sh'
EOF
sudo chmod +x /etc/s6-overlay/s6-rc.d/svc-wa-claude/run
sudo touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-wa-claude
```

Activates on next container restart; the existing tmux bridge keeps running until then. After restart: `sudo s6-svstat /run/service/svc-wa-claude`.

### Option C: systemd --user

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/wa-claude.service <<EOF
[Unit]
Description=WhatsApp ↔ Claude Code bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$BRIDGE_DIR
ExecStart=$BRIDGE_DIR/run.sh
Restart=always
RestartSec=5
StandardOutput=append:/tmp/wa-claude.log
StandardError=inherit
UMask=077

[Install]
WantedBy=default.target
EOF
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
tmux send-keys -t "$TMUX_SESSION:wa-claude" C-c   # stop tmux bridge to avoid 440 conflict
sleep 2
systemctl --user enable --now wa-claude.service
systemctl --user status wa-claude.service --no-pager
```

`loginctl enable-linger` keeps the service running after logout. The Ctrl+C stops the tmux bridge before launching the systemd one (two Baileys instances → 440 conflict).

### Option D: launchd

```bash
PLIST=~/Library/LaunchAgents/dev.user.wa-claude.plist
mkdir -p ~/Library/LaunchAgents
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>             <string>dev.user.wa-claude</string>
    <key>ProgramArguments</key>  <array><string>$BRIDGE_DIR/run.sh</string></array>
    <key>WorkingDirectory</key>  <string>$BRIDGE_DIR</string>
    <key>RunAtLoad</key>         <true/>
    <key>KeepAlive</key>         <true/>
    <key>StandardOutPath</key>   <string>/tmp/wa-claude.log</string>
    <key>StandardErrorPath</key> <string>/tmp/wa-claude.log</string>
    <key>Umask</key>             <integer>63</integer>
</dict>
</plist>
EOF
chmod 600 "$PLIST"
tmux send-keys -t "$TMUX_SESSION:wa-claude" C-c
sleep 2
launchctl load -w "$PLIST"
launchctl list | grep dev.user.wa-claude
```

(`Umask` 63 = `0o077` decimal; launchd takes integer.)

### After install; update TOOLS.md

Substitute the `<run-mechanism>` and `<restart-cmd>` placeholders Step 8 left in the WhatsApp section. Use `Edit`, not `sed` (paths and backticks). Replace `<user>` with `$(stat -c %U "$BRIDGE_DIR")` and `<window-index>` with `$WA_INDEX` from Step 6:

| Option | `<run-mechanism>` (trailing period included) | `<restart-cmd>` |
|---|---|---|
| A | ``auto-started via `/custom-cont-init.d/10-wa-claude.sh` (host-mounted; survives recreation). Lands in dedicated tmux session `wa-claude` as user `<user>`.`` | `` `tmux kill-session -t wa-claude 2>/dev/null; sleep 2; sudo bash /custom-cont-init.d/10-wa-claude.sh` `` |
| B | ``auto-started by s6-overlay longrun `svc-wa-claude`. Status: `sudo s6-svstat /run/service/svc-wa-claude`.`` | `` `sudo s6-svc -r /run/service/svc-wa-claude` `` |
| C | ``auto-started by systemd-user unit `wa-claude.service`. Status: `systemctl --user status wa-claude.service`.`` | `` `systemctl --user restart wa-claude.service` `` |
| D | ``auto-started by launchd agent `dev.user.wa-claude`. Status: `launchctl list \| grep dev.user.wa-claude`.`` | `` `launchctl unload ~/Library/LaunchAgents/dev.user.wa-claude.plist && launchctl load ~/Library/LaunchAgents/dev.user.wa-claude.plist` `` |
| None | ``tmux session `<tmux-session>` window `wa-claude` (no auto-start; bridge dies on container restart). Manual start: `cd <bridge-dir> && ./run.sh`.`` | `` `tmux send-keys -t "<tmux-session>:<window-index>" C-c` (wrapper respawns) `` |

After substitution, `grep -n '<.*>' <WORKSPACE_DIR>/TOOLS.md` should return nothing in the WhatsApp section.

## Management actions

Sub-flows invoked from Step 0.5's router (or Step 2's collision options) when re-running the skill against an existing install. **Each is self-contained and does not re-run Steps 1–9.** Throughout these flows, `$EXISTING_BRIDGE` is the path detected in Step 0.5 (or `$BRIDGE_DIR` if entering from Step 2).

### M1; Update bridge code

Refresh template files while preserving `auth/`, `data/`, `.env`. Use this when a new skill version ships fixes to `src/` or new dependencies in `package.json`. Ask the user before overwriting files they may have customized:

```bash
cd "$EXISTING_BRIDGE"
TS=$(date +%s)
TOUCH=(src/index.ts src/whatsapp.ts src/claude.ts src/format.ts package.json tsconfig.json run.sh .env.example README.md)

CHANGED=()
for f in "${TOUCH[@]}"; do
  src="$SKILL_DIR/templates/$f"
  dst="$EXISTING_BRIDGE/$f"
  [ -f "$src" ] || continue                                 # template missing; skip
  if [ ! -f "$dst" ]; then cp "$src" "$dst"; continue; fi   # new file; install
  cmp -s "$src" "$dst" && continue                          # identical; skip
  CHANGED+=("$f")
done
```

If `CHANGED` is non-empty, `AskUserQuestion`: **These files differ from the templates: `${CHANGED[*]}`. Overwrite all (with `.bak.$TS` backups), or pick per-file?**; offer **Overwrite all (recommended)** and **Review per-file** (loop AskUserQuestion per entry). Then apply:

```bash
for f in "${CHANGED[@]}"; do
  cp "$EXISTING_BRIDGE/$f" "$EXISTING_BRIDGE/$f.bak.$TS"
  cp "$SKILL_DIR/templates/$f" "$EXISTING_BRIDGE/$f"
done
chmod +x "$EXISTING_BRIDGE/run.sh"

# Pick up any new deps. pnpm install is a no-op if lock matches.
if command -v pnpm >/dev/null; then pnpm install; else npm install; fi
```

Restart, picking the right command based on the supervisor in use:

```bash
if [ -f ~/.config/systemd/user/wa-claude.service ] && systemctl --user is-active wa-claude.service >/dev/null 2>&1; then
  systemctl --user restart wa-claude.service
elif [ -f ~/Library/LaunchAgents/dev.user.wa-claude.plist ] && launchctl list | grep -q dev.user.wa-claude; then
  launchctl unload  ~/Library/LaunchAgents/dev.user.wa-claude.plist
  launchctl load   ~/Library/LaunchAgents/dev.user.wa-claude.plist
elif [ -f /etc/s6-overlay/s6-rc.d/svc-wa-claude/run ] && command -v s6-svc >/dev/null; then
  sudo s6-svc -r /run/service/svc-wa-claude
elif tmux list-windows -t "${TMUX_SESSION:-claude}" -F '#W' 2>/dev/null | grep -qx wa-claude; then
  tmux send-keys -t "${TMUX_SESSION:-claude}:wa-claude" C-c     # wrapper loop respawns
else
  echo "No supervisor detected; start manually: cd $EXISTING_BRIDGE && ./run.sh"
fi
```

Verify: `tail -20 /tmp/wa-claude.log` should show wrapper restart + new `✅ Connected to WhatsApp as` within ~10s. Auth survived; no QR rescan.

### M2; Diagnose and repair

Run sanity checks against the existing install and propose fixes for failures. Report each finding to the user and **ask before destructive ones** (auth deletion, sessions wipe).

| Check | Failure → Fix |
|---|---|
| `pgrep -f "tsx.*$EXISTING_BRIDGE/src/index"` returns a PID | None → restart per supervisor (see M1's restart block); if it crashes immediately, `tail -100 /tmp/wa-claude.log` and address |
| `test -f $EXISTING_BRIDGE/auth/creds.json` | Missing → re-pair via Step 6 (do not reinstall; keeps data/, .env, customizations) |
| `OWNER_LID` set or `WHITELIST_NUMBERS` has real LIDs | All slots empty (or only `BOOTSTRAP`) → run Step 7 to capture the owner; subsequent senders go through M3 |
| `node_modules/` present and matches lockfile | Missing/stale → `pnpm install` (or `npm install`) |
| `data/sessions.json` parses as JSON | Corrupt → confirm with user, then `echo '{}' > data/sessions.json` (loses per-chat continuity but recoverable) |
| Recent `Connection Closed` retries succeed | Exhausting all 5 retries → likely `loggedOut` (code 401); confirm, then `rm -rf auth/` and re-pair |
| `package.json` matches the template's | Drift detected → suggest M1 (Update bridge code) |
| Two Baileys instances running (code 440 in log) | Stop the duplicate (usually a stray tmux window when an autostart service is also active) |
| (LinuxServer.io only) Init script `/custom-cont-init.d/*-wa-claude.sh` was last modified **after** the current container's boot time | The script never ran on this boot, since `init-custom-files` had already finished by the time the script appeared.  Diagnose: `stat -c %Y /custom-cont-init.d/*-wa-claude.sh` (script mtime) vs `awk '/btime/{print $2}' /proc/stat` (container boot time).  If mtime > btime, smoke-test the script in place rather than waiting for a real reboot: `tmux kill-session -t wa-claude 2>/dev/null; sleep 2; sudo bash /custom-cont-init.d/10-wa-claude.sh; sleep 8; grep '✅ Connected' /tmp/wa-claude.log \| tail -1`.  A fresh `Connected` line confirms the script is sound for next boot. |

If everything passes, report green and stop; no changes.

### M3; Add a WhatsApp sender

Capture a new LID and add them to the right role list. M3 never overwrites `OWNER_LID`; the operator stays the only LID with whitelist-edit authority. Only the operator (the LID matching `OWNER_LID`) should be running this flow; the bridge's role enforcement refuses whitelist edits requested by full-trust senders.

```bash
LOG_BASELINE=$(wc -l < /tmp/wa-claude.log)
```

Tell the user:

> Have the new sender message the bot from their phone (any text). The first message gets dropped (their LID has no role yet) but shows up in the log as `Ignored message from <LID>`. I'll capture it and ask you what role to give them.

`AskUserQuestion`: **Have they sent the test message?** Options: **Yes** / **Not yet**. On Yes, poll new lines only:

```bash
NEW_LID=""
for i in $(seq 1 30); do
  NEW_LID=$(tail -n +"$((LOG_BASELINE + 1))" /tmp/wa-claude.log | grep -oP 'Ignored message from \K\d+' | tail -1)
  [ -n "$NEW_LID" ] && break
  sleep 2
done
```

If multiple new `Ignored from` lines appeared, `AskUserQuestion` to disambiguate (same pattern as Step 7). Always confirm even with a single candidate; the operator should see the LID before any write.

Then ask the operator what role to assign:

`AskUserQuestion`: **Role for `<LID>` (with `(+<phone>)` if Baileys resolved it)?**
- **Full-trust** (Recommended for known collaborators): Same powers as you, except cannot edit the whitelist or allowed-groups. Effectively shell access via Claude.
- **Restricted**: Read-only role. Claude refuses Bash, Edit, Write, NotebookEdit, and any state-mutating tool on their behalf. Heuristic, not a sandbox.
- **Cancel**: Don't add.

**Append** to the right list, never replace; preserve existing entries:

```bash
case "$ROLE" in
  full)
    KEY=WHITELIST_NUMBERS ;;
  restricted)
    KEY=RESTRICTED_LIDS ;;
  *)
    echo "Cancelled, no change."; exit 0 ;;
esac
CURRENT=$(grep -E "^${KEY}=" "$EXISTING_BRIDGE/.env" | sed "s|^${KEY}=||")
if echo "$CURRENT" | tr ',' '\n' | grep -qx "$NEW_LID"; then
  echo "Already in $KEY; nothing to do."
else
  # Strip BOOTSTRAP if present (placeholder only)
  [ "$CURRENT" = "BOOTSTRAP" ] && CURRENT=""
  NEW="${CURRENT:+$CURRENT,}$NEW_LID"
  sed -i "s|^${KEY}=.*|${KEY}=$NEW|" "$EXISTING_BRIDGE/.env"
fi
```

The bridge re-reads `.env` on every message; no restart. Ask the user to send another message from the new sender; verify with `tail -10 /tmp/wa-claude.log | grep -E "\[\d+/(full|restricted)\] →|← \d+ turns"`. The `/full` or `/restricted` suffix confirms the role gate matched.

## Operational notes, troubleshooting, and design rationale

Lives in the bridge's own README (`$BRIDGE_DIR/README.md`, copied from `templates/README.md` in Step 2). Covers: restart commands per supervisor, log handling, self-recovery flows, session and group manual control, uninstall paths, every common failure mode, and the design notes (anatomy of the source tree, why outside the workspace, resilience layers, continuity surfaces, journal tiering, why bypassPermissions, why no slash commands, why groups are gated, why mode 700).

Read it when re-running this skill against an existing install (M1/M2 may need it) or when answering an operator's debug question. Don't duplicate that content here; if the README is wrong, fix the README.

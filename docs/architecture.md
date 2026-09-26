# Architecture

Technical overview of the EnvHaven Docker image design decisions and rationale.

## Overview

EnvHaven is a Docker image that provides a Batteries-Included Agentic Environment with pre-installed AI coding tools. It extends the LinuxServer.io (LSIO) code-server image.

```
┌─────────────────────────────────────────────────────────────────┐
│                     EnvHaven Container                          │
│                                                                 │
│  /opt/envhaven/wrappers/ ← Catalog-declared launch defaults     │
│  /opt/envhaven/bin/    ← Real AI tools (mise, uv, claude...)    │
│  /usr/local/lib/envhaven/ ← Root-owned startup helpers          │
│  /opt/envhaven/uv-tools/ ← Python tool virtualenvs             │
│  /mise/                ← mise data, shims, tool installs        │
│  /app/                 ← code-server, pre-installed extensions  │
│  /defaults/            ← Templates (copied on first boot)       │
│  /config/              ← User data (VOLUME - mounted by user)   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Base Image

EnvHaven extends `linuxserver/code-server:latest`, which provides:

- **code-server**: VS Code in the browser
- **s6-overlay**: Process supervisor and init system
- **Ubuntu 24.04**: Stable base with recent packages
- **LSIO conventions**: Standardized paths and patterns

## The Volume Mount Problem

**This is the most important architectural decision to understand.**

### LSIO Convention

LinuxServer.io images set `HOME=/config` and expect users to mount a volume there for persistence:

```bash
docker run -v /my/data:/config envhaven
```

### The Problem

Tools installed during `docker build` that land in `$HOME` (e.g., `~/.local/bin/`) get **shadowed** when the user mounts their volume:

```
Build time:  /config/.local/bin/claude  ← Tool installed here
Runtime:     /config/ mounted from host ← Empty, shadows everything
Result:      claude: command not found
```

This affected all our AI tools. The image would build successfully, but tools would be missing at runtime.

### The Solution

Install tools to `/opt/envhaven/bin/`, a path that is **never mounted over**:

```dockerfile
# Create tool directory outside /config
RUN mkdir -p /opt/envhaven/bin /opt/envhaven/uv-tools

# Install straight into the safe location where the installer supports it
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/opt/envhaven/bin/mise sh

# Or install, then move, when it does not
RUN curl -fsSL https://cli.kiro.dev/install | bash && \
    mv /config/.local/bin/kiro* /opt/envhaven/bin/
```

### PATH Priority

Users can still override any tool by installing their own version:

```
/config/.local/bin      # User overrides (first priority)
/opt/envhaven/wrappers  # EnvHaven launch defaults
/opt/envhaven/bin       # Real system tools (our installations)
/opt/envhaven/cargo/bin # Rust toolchain (cargo, rustc)
/mise/shims             # mise-managed tools
/usr/local/bin          # System binaries
```

## Directory Structure

| Path | Purpose | Mounted? | Mutable? |
|------|---------|----------|----------|
| `/config` | User home directory (`HOME=/config`) | **Yes** | Yes |
| `/config/.local/bin` | User and self-updater tool overrides, first on PATH | **Yes** | Yes |
| `/opt/envhaven/wrappers` | Launcher links for every catalog tool with `launchArgs` | No | No |
| `/opt/envhaven/bin` | Pre-installed AI tools | No | Yes (abc-writable for self-updates) |
| `/usr/local/lib/envhaven` | Helpers called by root during startup | No | No |
| `/opt/envhaven/uv-tools` | Python tool virtualenvs | No | Yes (abc-writable for self-updates) |
| `/opt/envhaven/rustup`, `/opt/envhaven/cargo` | Rust toolchain and cargo home | No | Yes |
| `/opt/envhaven/playwright` | Playwright browser cache | No | Yes |
| `/opt/envhaven/claude-home` | Claude Code's baked baseline install (build-time HOME; runtime HOME is `/config`) | No | Yes |
| `/mise` | mise data, shims, installs | No | Yes (abc-writable for self-updates) |
| `/defaults` | Templates copied on first boot | No | No |
| `/app` | code-server and pre-installed extensions | No | No |

## Tool Install and Update Policy

Two zones. The **baked baseline** lives in `/mise` and `/opt/envhaven` (image layers): container
recreation and image updates reset it to known-good. The **workspace overlay** is
`/config/.local` on the mounted volume: it persists, sits first on PATH, and anything a user or
a tool's self-updater puts there shadows the baseline.

Self-updaters stay enabled; we never disable a vendor updater. Every tool must satisfy two
invariants:

1. **Kill-safe**: an interrupted self-update never leaves the command broken. `tool --version`
   must be safe to kill at any instant.
2. **Recoverable baseline**: container recreation restores a working baked copy regardless of
   what the updater did.

A tool whose *background* updater violates invariant 1 on its normal install rung moves to the
rung where the vendor's own updater satisfies it. Claude Code is the precedent: its npm-channel
updater swaps files in place (a kill between npm's delete and rename bricks the command), so it
installs via the vendor's native installer, whose updater stages versioned binaries and flips a
symlink atomically. Manual, user-invoked update commands are exempt from invariant 1 (the user
is present to retry), never from invariant 2.

Recorded exceptions: qwen auto-updates by default by spawning `npm install -g` over
its own install. No conforming vendor mechanism exists; invariant 2 contains the damage and
`npm install -g <pkg>` repairs in place.

Updates land wherever the vendor's updater writes; we never redirect one. Claude lands in the
overlay (persists per-workspace); npm, uv, and mise tools land in the image layer (ephemeral,
re-baselined by image updates). What is uniform is the invariant set and PATH precedence, not a
landing directory.

### Category 1: mise-managed tools

[mise](https://mise.jdx.dev/) manages language runtimes and some AI tools via backends:

```toml
# /mise/config.toml
[tools]
node = "22"
python = "3.12"
go = "1.22.5"
bun = "1.3.5"
"github:sharkdp/fd" = "10.2.0"
"aqua:cli/cli" = "latest"          # gh
"aqua:cloudflare/cloudflared" = "latest"
"aqua:sst/opencode" = "latest"
"aqua:astral-sh/uv" = "latest"
"github:aaif-goose/goose" = "latest"
"github:vercel-labs/fx" = "latest"
"github:MoonshotAI/kimi-code" = "latest"
```

`github:` is the backend mise names as ubi's replacement (2026.8 warns that ubi is deprecated
and goes in 2027.1); it fetches one release asset and picks the binary out of it. Nothing here
uses `ubi:` any more.

Kimi's native updater keeps this rung kill-safe: it downloads a versioned binary into a staging
directory, verifies the release checksum, smoke-tests `--version`, and swaps it by rename on the
next launch with rollback to the untouched executable on failure.

mise itself is installed to `/opt/envhaven/bin/mise` with a symlink at `/usr/local/bin/mise`.

| Path | Purpose |
|------|---------|
| `/mise/config.toml` | Tool definitions |
| `/mise/installs/` | Installed tool versions |
| `/mise/shims/` | Executable shims (in PATH) |
| `/opt/envhaven/bin/mise` | mise binary |

### Category 2: uv-managed Python tools

[uv](https://github.com/astral-sh/uv) installs Python CLI tools in isolated virtualenvs:

```dockerfile
ENV UV_TOOL_DIR="/opt/envhaven/uv-tools"
ENV UV_TOOL_BIN_DIR="/opt/envhaven/bin"

RUN uv tool install mistral-vibe && uv tool install hermes-agent
```

### Category 3: Standalone installers

HOME-anchored installers run at build with their output relocated out of `/config` (the volume
mount would hide it); if the tool needs a `$HOME` anchor at runtime, an init script seeds it,
guard-before-mutate. One pattern, two variants:

**mv-only** (kiro, droid, agy, grok): run the installer, move the binary.

```dockerfile
RUN curl -fsSL https://cli.kiro.dev/install | bash && \
    mv /config/.local/bin/kiro* /opt/envhaven/bin/
RUN curl -fsSL https://app.factory.ai/cli | sh && \
    mv /config/.local/bin/droid /opt/envhaven/bin/
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash && \
    mv /config/.local/bin/agy /opt/envhaven/bin/agy
RUN curl -fsSL https://x.ai/cli/install.sh | bash && \
    mv /config/.grok/downloads/grok-linux-x86_64 /opt/envhaven/bin/grok && \
    rm -rf /config/.grok /config/.local/bin/grok /config/.local/bin/agent /config/.config/fish
```

A move that misses fails on the line that caused it: `/config/.local/bin` is first on PATH,
so a binary left behind there would even pass the `--version` gate. Grok is the one that
needs reading twice: `~/.grok/bin/grok` is a symlink into `~/.grok/downloads`, so moving the
link would strand the binary, and the installer also links both names from `~/.local/bin`
and writes a fish completion, all pointing at what is removed.

**direct destination** (Muse): its installer accepts `MUSE_INSTALL_DIR`, so the launcher and its
versioned binary land in `/opt/envhaven/bin` without an intermediate HOME install. Muse's updater
downloads to a temporary directory, validates the manifest's size and SHA-256, publishes the new
version by rename, and only removes old versions after success. Launcher updates are syntax- and
checksum-checked before a rename, with the previous launcher retained. Both update paths therefore
remain usable if the process is interrupted.

**HOME-swap plus seed** (claude): bake under `HOME=/opt/envhaven/claude-home`, expose via an
`/opt/envhaven/bin/claude` symlink, and seed `/config/.local/bin/claude` at boot
(`init-user-config-run`) so the runtime updater owns the overlay copy and its launcher check
passes. The updater's first run replaces the seed with the workspace's own versioned install
under `/config/.local/share/claude`.

## s6-overlay Init System

s6-overlay runs initialization scripts after the container starts but **after** volumes are mounted. This is key: we can safely write to `/config/` in init scripts.

Every service's `run` file is `runtime/scripts/<service>-run` (`svc-console` also has a
`finish`); what each one does is the table in
[development.md](development.md#runtime-scripts). Oneshots run once at startup, longruns
are supervised for the container's life, and every arrow in the graph below is a
`dependencies.d` entry the Dockerfile declares.

### Execution Order

```
Container starts
    ↓
Volumes mounted (/config)
    ↓
s6-overlay runs init-adduser (LSIO creates abc user)
    ↓
Oneshots start concurrently (all declare init-adduser)
  init-env-compat
  init-extensions
  init-vscode-settings
  init-agent-config
  init-user-config
  init-zsh-config     ← init-user-config, init-mods-end
  init-agents-md      ← init-env-compat
    ↓
Longrun services start
  svc-sshd            ← init-user-config, init-zsh-config
  svc-cloudflared
  svc-console         ← init-user-config, init-zsh-config, init-env-compat
    ↓
code-server starts    ← init-env-compat, init-zsh-config
```

## VS Code Extension Installation

Extensions must survive volume mounts. We use a symlink strategy:

### Build Time

```dockerfile
RUN mkdir -p /app/pre-installed-extensions && \
    /app/code-server/bin/code-server \
        --extensions-dir /app/pre-installed-extensions \
        --install-extension /tmp/envhaven.vsix
```

### Runtime (init-extensions script)

```bash
# Symlink pre-installed extensions to user's extension directory
for ext in /app/pre-installed-extensions/*; do
    ln -sf "$ext" "/config/extensions/$(basename $ext)"
done
```

Result:
```
/config/extensions/envhaven.envhaven-0.2.0 → /app/pre-installed-extensions/envhaven.envhaven-0.2.0
```

User-installed extensions go directly to `/config/extensions/` and persist normally.

## Environment Variables

Single source of truth in `/etc/environment`:

```bash
PATH="/config/.local/bin:/opt/envhaven/wrappers:/opt/envhaven/bin:/opt/envhaven/cargo/bin:/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
MISE_DATA_DIR="/mise"
MISE_CONFIG_DIR="/mise"
MISE_CACHE_DIR="/mise/cache"
MISE_STATE_DIR="/mise/state"
UV_TOOL_DIR="/opt/envhaven/uv-tools"
UV_TOOL_BIN_DIR="/opt/envhaven/bin"
RUSTUP_HOME="/opt/envhaven/rustup"
CARGO_HOME="/opt/envhaven/cargo"
```

This file is sourced by:
- SSH sessions (via `pam_env`)
- bash (via `/etc/bash.bashrc`)
- zsh (via `/etc/zsh/zshenv`)

## Adding New Tools

The decision ladder, first match wins:

1. Static single binary with an aqua or github backend: `mise.toml`.
2. npm package: `npm install -g` under mise's node.
3. Python package: `uv tool install` (UV_TOOL_DIR/UV_TOOL_BIN_DIR are baked).
4. Vendor installer only, or forced here by the update contract: run the installer at build and
   relocate the result out of `/config` (Category 3 above).

Then, always:

5. Confirm from the vendor's docs which updater the tool ships and whether it is kill-safe
   (invariant 1). Guessing is forbidden. A background updater that swaps files in place forces
   rung 4.
6. Add the tool to `tool-definitions.json`. The verification gates derive from it: the
   Dockerfile verification block, `dev/scripts/test-image.ts` (which CI runs),
   `dev/scripts/test-ai-tools.ts`, and the platform e2e suite all run `command --version`
   for every catalog entry, so the roster cannot drift. `test-image.ts` additionally
   counts the image's copy of the catalog and fails when the count differs from this
   repo's, so an image built from a different tree usually fails as a roster mismatch
   rather than as a mystery missing tool.

7. If it is an interactive TUI that draws its own input box, seed the browser terminal for it.
   The console paints each keystroke before the server echoes it, and it can only predict a
   wrap whose shape it knows. A tool with no row still works, and after its first wrap the
   engine learns the style from what it just watched. What the row buys is that first wrap of
   each session, which rides the round trip instead of being painted.

   Three steps, and the middle one is the only one that produces numbers:

   ```bash
   bun dev/scripts/measure-tui.ts                  # sweeps every tool in the catalog
   bun dev/scripts/measure-tui.ts --print <tool>   # or just the one you added
   ```

   Put the row it prints into `var TUI` in `console/ui/assets/eh-model.js`. Never hand-derive those
   numbers. The script exists because these applications redesign their composers between
   releases, and a measured constant is the only kind worth committing. Run with no arguments
   and it drives the whole catalog, so a tool that has just been added to the image is measured
   without being registered anywhere first: its measurement is what its row is written from.

   A row is five geometry fields plus, when they measure true, two behavioural flags:

   - **`lazy: true`**: the wrap is two-phase (codex); the char that fills the row paints at
     its last cell and the cursor drops to an EMPTY continuation, and the word only moves
     down with the next word char's repaint. A space after the drop eats the seam and the
     word never moves. Measured by reading the continuation row at the wrap frame, before
     the sweep's extra keystroke lets the application finish.
   - **`spacePull: true`**: a space at the wrap edge still pulls the last word onto the
     continuation (agy, Kimi, Muse, pi). Every other measured app eats the seam space and opens an
     empty continuation. Measured by landing a word exactly at the wrap column, typing a
     space, and checking whether the cursor's row holds the word afterwards.

   The sweep's own vocabulary, which is what keeps it readable rather than permanently red:

   | outcome | meaning |
   |---------|---------|
   | measured | the row, ready to paste, checked against the table if it already has one |
   | table is stale | the application changed; replace the row with the measured one |
   | differs between widths | no constant margin exists; the app cannot take a row |
   | not signed in | nothing to do with the engine; log the tool in and measure again |
   | did not start | the binary never drew anything (`amp` on a host without AVX2) |
   | no row, as declared | a `NO_ROW` entry says why, and fails if that stops being true |
   | not measured | a `NOT_A_COMPOSER` entry: no terminal composer to seed, ever |

   Two things it reports that are NOT table columns, both there to be read by a person:

   - **`draft:`** reports the SGR the application draws its draft in. `default foreground` means the
     terminal's own colour is right from the very first keystroke; anything else (grok's
     `256:235`) means the predictor usually reads the colour off the row until the first echo
     teaches it. A fixed ANSI colour is the one exception: Muse emits palette index 252 before
     any draft exists, so its row seeds the equivalent `coldFg`. Theme-dependent colours remain
     unseeded: grok picks a different palette against a light terminal than a dark one, so a
     committed constant would be wrong for half the users.
   - **`chrome:`** reports what is actually drawn in the columns the application keeps to itself.
     `pad` and `indent` say how MANY columns those are at each end; `chrome` says what is in
     them. A composer that borders its input (`left "│ ", right " │"`) behaves differently
     from one that merely reserves the space, and the engine strips one box-drawing glyph
     and its gutter from EACH end of a row before reading that row for text; see
     `textStart` / `textEnd`. Both sides, deliberately: reading a row as first non-blank to
     last non-blank is right only for a composer with nothing beside its input, and the
     roster has four that do have something there. grok and Kimi are bordered on both sides;
     opencode and fx are bordered on the left. Under the old left-only read none could ever
     learn its own wrap, so every wrap in them rode the round trip no matter how long the
     session ran.

   Three follow-ons, all easy to miss:

   - **npm-installed CLIs are usually shims.** The launcher keeps running as the parent of the
     real binary and tmux reports the parent, so the pane reads as `node` and the console can
     never scope anything to the tool. Measured on codex 0.145.0, `pane_current_command` is
     `node` for the entire session. Check it directly, with the tool running in a pane:
     `tmux display-message -p '#{pane_current_command}'`. If that prints the runtime rather
     than the tool, add the runtime to `runtimeWrappers` in `console/gate.go`, on that
     observation and with the observation in the commit rather than on a guess.
   - **A row nothing tests is a row that rots.** One registration: the tool's row in
     `dev/scripts/lib/console-apps.ts`, where the per-check facts live beside the launch
     command. The model row is keyed by the observed pane process; when that differs from
     the launch command, record it as `paneApp` on the harness row. Each check derives its
     roster from that row, so adding a tool is one edit
     and "where is this tool tested" has one answer:

     | field | what it turns on |
     |-------|------------------|
     | `command`, `paneApp`, `bootMs`, `settleMs`, `leave` | how the harness launches it and gets the pane back |
     | `seed` | the model has a `var TUI` row for it: `seedwrap` proves the seed is real, `wrapkeep` types through its wraps |
     | `floor` | `keys-editing-composer` drives nav and deletion, holding Home and the kill to that column |
     | `ink` | `draftink` compares a predicted glyph's colour against the app's own |
     | `words` | the model has a word rule for it: `keys-words` holds the rule to the live pane |
     | `ghost` | `keys-ghost` drives its empty composer's placeholder |
     | `trailing` | `keys-trailing` drives End onto a trailing space |

     `test-console-ui.ts` (CI, no container) fails when a row and the model disagree in
     either direction: a `var TUI` row with no app marked `seed`, an app marked `seed` the
     model has no row for, and the same both ways for word rules. Deleting a row is loud.

     Launch the tool with a FAKE API key in its environment (`GEMINI_API_KEY=AIza-fake agy`,
     claude's row was the first): the composer is a local line editor and draws before any
     credential is checked, so no check needs a real login. A fake key does not replace the
     app's first-run state, which lives in the container's home, so run each app once by
     hand in the test container before trusting a skip. What each one asks for on a fresh
     container is measured and recorded beside the rows in `console-apps.ts`; that comment
     is the record, and a second copy here is one that drifts. A tool that checks the key
     first keeps a bare command and the checks skip it on auth-walled machines. `floor` is
     the draft's first column: the prompt's length for an unbordered composer,
     behind-border plus prompt for a boxed one (grok: 6), and `'moves'` for a composer
     whose chrome shifts with the width (opencode centres its splash box).
   - **A word is whatever the tool says it is.** Option+Arrow and Option+Backspace move
     and delete by word, and the roster disagrees on what a word is: the shell stops on
     letters and digits only, Claude Code joins `file.txt` and `don't`, codex and pi stop on
     punctuation runs and jump to a word's END, Kimi shares that rule, fx jumps to the end
     of letter/digit/underscore runs, Muse does the same without treating underscore as a
     word character, and opencode stops after
     its own wrap delimiters. The model keeps one rule per tool (`WORD_RULES` and
     `WORD_APPS` in `console/ui/assets/eh-model.js`), and a tool with no rule gets the
     shell's, which paints a jump one column off and then a word delete that takes the
     wrong word. Measure the new tool with the recipe in `dev/scripts/README.md` under
     "Word rules", add its cases to `dev/fixtures/word-rules.json` (the columns are the
     tool's own, read off tmux, never the model's), give it a rule in `WORD_RULES`, point
     its pane app at that rule in `WORD_APPS`, and mark its row `words`; `test-console-ui.ts`
     then holds the rule to the fixture with no
     browser, and `keys-words` holds it to the live pane.

     Then run the checks that press the row, and `keys-words` if it got a rule:

     ```bash
     bun dev/scripts/test-console-echo.ts seedwrap wrapkeep draftink keys-editing-composer keys-words
     ```

     `seedwrap` goes red if the engine stops seeding what its table claims, which is what
     keeps the table load-bearing instead of decorative.

   When a measurement or a check disagrees with what you expected, DO NOT adjust the row
   to fit. Drive the real tool in tmux inside the container (its own `-L` socket, never the
   workspace one), type one character at a time, and read cursor and screen together after
   each, settling on two identical frames (`Pane.settled` in measure-tui.ts is the pattern).
   Every field of the row was measured that way, and the wrong ones were all written by
   reading a mid-repaint frame as settled fact. The tool's own screen is the only source of
   truth; the sweep exists to make reading it a habit.

8. Give it presentation metadata. These values belong in the same tool object as the runtime data:

   - **`envVarMeta`.** Every name in a tool's `envVars` needs an entry, or
     `console/api_golden_test.go` fails. That entry is the placeholder and hint the key field
     renders, so an env var without one is a field the customer cannot fill in. The same
     file's `TestShippedCatalog` pins the roster size: bump it, or the console job fails.
   - **`authSummary`.** Keep this to the login choices a user needs in the generated tables.
     Runtime auth behavior still comes from `authCommand`, `envVars`, and the other operational
     fields; do not derive help copy from those mechanics.
   - **`icon`.** Store the mark as the catalog's deliberately small SVG data model: paths,
     rectangles, circles, transformed groups, and at most one linear gradient. The generator
     rejects unknown shapes and attributes rather than silently dropping them. Both UI adapters
     render this generated data; neither repo carries another copy of the SVG bodies.

9. Decide how it stops asking permission. The container is the sandbox, so a tool that prompts
   is a tool that wastes the customer's turn. An env var goes in the Dockerfile next to
   `OPENCODE_PERMISSION`; launch flags go in the catalog's `launchArgs` and use the shared
   executable launcher; a config file goes in `runtime/templates/` with a block in
   `init-agent-config-run`. The build links every tool with `launchArgs` to the launcher from
   the catalog itself, so the Dockerfile needs no edit, but the tool's real executable must be
   at `/opt/envhaven/bin/<command>` or the build fails. Record it in the auto-approve table in
   `runtime/templates/AGENTS.md.template`, which is what the customer's own AGENTS.md quotes.

10. Regenerate the platform contract:

    ```bash
    bun dev/scripts/platform-tool-catalog.ts --write
    bun dev/scripts/platform-tool-catalog.ts --check
    ```

    `platform-tool-catalog.generated.ts` projects ids, names, commands, descriptions, auth help,
    docs URLs, env vars, env-var metadata, and typed icon data. The same command updates marked
    tool sections in `README.md`, `docs/ai-tools.md`, and `runtime/templates/AGENTS.md.template`.
    It also carries a SHA-256 of recursively key-sorted `tool-definitions.json` content and a
    self-verifying artifact-content SHA-256. Those hashes identify catalog content only; neither
    claims a Git revision nor an OCI image digest. Image CI rejects stale artifact or documentation
    output. The Docker release workflow regenerates it, writes both catalog hashes and the exact
    Git revision into OCI config labels, and uploads the same bytes as an immutable Actions
    artifact named by the artifact-content hash.
    The platform vendors those bytes and derives its literal `ToolId` union from them, so no
    operational field is typed again in the platform repo. The exact-revision comparison remains
    a coordinated image-first release gate; a dirty image checkout cannot stand in for a release.

11. Let the user try it in a live workspace WITHOUT a release: rebuild the console binary
    and drop it into a running container. That loop applies to every console change, so it
    lives in [development.md](development.md#trying-a-console-change-in-a-live-container).

## Persistent Terminal Sessions

EnvHaven provides persistent terminal sessions that survive reconnects. This enables long-running AI agent sessions while you disconnect and reconnect freely.

### Why tmux

We use [tmux](https://github.com/tmux/tmux), the battle-tested terminal multiplexer that's been rock-solid for decades. Rather than reinvent session persistence, we leverage tmux's proven architecture with a minimal, opinionated configuration.

Our approach:
- **Single session** (`envhaven`): all windows live here, simplifying multi-device access
- **Status bar off by default**: VS Code and the managed dashboard already show a window list; SSH sessions and the self-host browser terminal get a bar (window names, hotkey hints) via grouped sessions
- **Mouse enabled**: click to switch terminals, scroll naturally
- **Sensible defaults**: 50k scrollback, no escape delay, numbering starts at 1

The full config is in `runtime/templates/tmux.conf`. Power users can bring their own tmux knowledge; newcomers get a good experience without learning tmux.

### How It Works

When you open a terminal (via VS Code, SSH, or the web UI), you land in the `envhaven` tmux session's windows. Each terminal is a tmux "window" within this session. VS Code terminals and the managed dashboard console attach to the session directly. SSH logins and the self-host browser terminal attach through grouped sessions (`ssh-$$` per connection, `console-view` for the console) that share the same windows but keep their own current window and status bar, and destroy themselves on disconnect.

```
┌─────────────────────────────────────────────────────────────────┐
│                     EnvHaven Container                          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   Persistent Session                      │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │  │
│  │  │  Window 1   │  │  Window 2   │  │  Window 3   │       │  │
│  │  │  opencode   │  │   codex     │  │  npm run    │       │  │
│  │  │  (running)  │  │  (running)  │  │  dev        │       │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  User disconnects → processes keep running                      │
│  User reconnects → same terminals, same state                   │
└─────────────────────────────────────────────────────────────────┘
```

### Browser Console Boundaries

The console keeps terminal authority on the server. `console/gate.go` samples the active
tmux pane, including its absolute bottom edge, while `console/pump.go` owns the pty,
WebSocket, safety lease, and predictive wire codec. A safe verdict keeps the full polling
cadence so silent tty-mode changes fail closed; polling becomes sparse only while the
browser already holds an unsafe verdict. Any gate error also fails closed.

Tmux mutations have one implementation in `console/api_actions.go`. The authenticated
`POST /__console/action` route and the local `envhaven-console --action-json` mode enter
the same validator and executor. The extension prefers HTTP. When credentials are absent,
or a loopback connection is definitely refused before an action arrives, it invokes the
installed binary with one JSON argv value, a bounded output buffer, and a hard deadline.
No TypeScript path accepts a shell command or invokes tmux directly.

The browser separates policy, state, input, rendering, and platform wiring. Every production
module is a synchronous classic script below 750 lines, loaded in dependency order:

- `eh-model.js` is pure policy: frame decoding, pane geometry, application rules, and the
  predictor lifecycle controller.
- `eh-predict-input.js` decodes terminal bytes into commands without owning state.
- `eh-predict-layout.js` owns pane, prompt, seam, and wrap geometry for one session.
- `eh-predict-navigation.js` applies cursor movement to that session.
- `eh-predict-actions.js` applies content edits and learned wrap policy.
- `eh-predict-style.js` samples and caches xterm row colours and font metrics.
- `eh-predict-renderer.js` owns link underlines, prediction layers, and optimistic cursor paint.
- `eh-predict-reconcile.js` compares predictions with the authoritative xterm grid.
- `eh-predict-session.js` constructs its collaborators around one private state object.
  It dispatches commands, rolls back failed input edits, and publishes frozen renderer views.
- `eh-predictor.js` is the composition root for terminal, clipboard, embedding, status, and
  WebSocket transport. It constructs collaborators with explicit one-way dependencies.
- `eh-engine.js` is the small adapter that supplies browser globals and starts the composition root.

`test-console-ui.ts` is a small orchestrator over focused asset, model-fixture,
predictor-runtime, and harness-isolation suites. Together they execute the shipped model,
parse every runtime module, and enforce load order, dependency direction, and line limits
without requiring a browser.

Predictive frames retain the two shipped contracts. V1 (`0x02`) carries the foreground
application without usable geometry, so both server and browser treat its safety lease as
false. V4 (`0x05`) carries all four pane bounds as big-endian uint16 values. Active
negotiation accepts only implicit or explicit version 1 and version 4; unsupported values
fail before the WebSocket upgrade. Current pages and managed probes always request v4.

Managed framing, CORS, and WebSocket upgrades consume one parsed full-origin policy.
Exact origins are the default. A scheme-qualified `*.` hostname is the sole wildcard
form; it preserves the scheme and port and excludes the bare apex. Self-hosted HTTP API
access stays same-origin and its terminal page denies framing.

### Multi-Device Access

All clients share the same windows:

```
           Browser          SSH           Haven CLI
              │               │               │
              └───────────────┼───────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  tmux "envhaven"  │
                    │   (in container)  │
                    └───────────────────┘
```

Start `opencode` on your laptop via SSH, close the connection, resume from your desktop browser. Same session, same state.

### Implementation Details

| Component | Purpose |
|-----------|---------|
| `runtime/templates/tmux.conf` | Minimal tmux config |
| `runtime/scripts/envhaven-welcome.sh` | Auto-attach on shell init; picks the base or a grouped session per client |
| Extension sidebar | Subscribes to tmux control mode, which pushes window changes; renders the "Terminals" panel. A 5 s poll runs alongside as a safety net |

**Session lifecycle:**
- Created on first terminal open (`tmux new-session -s envhaven`)
- Survives reconnects (tmux detach/attach)
- Destroyed on container stop. There is no resurrect plugin; the session does not outlive the container

## Design Principles

| Principle | Application |
|-----------|-------------|
| **Simplicity** | One real-tool location (`/opt/envhaven/bin`), one launcher directory, one user data location (`/config`) |
| **User Override** | `/config/.local/bin` has highest PATH priority, so users can override any tool |
| **Survival** | All system tools survive volume mounts |
| **Transparency** | `/etc/environment` is the single source of truth for PATH and env vars |
| **LSIO Compatibility** | Respect base image conventions, don't fight them |

## Troubleshooting

### Tool not found after container start

**Cause:** Tool was installed to `/config/.local/bin/` during build and got shadowed.

**Fix:** Move the tool to `/opt/envhaven/bin/` in the Dockerfile.

### Tool works in web terminal but not via SSH

**Cause:** SSH session not picking up PATH from `/etc/environment`.

**Fix:** Ensure `/etc/environment` is sourced. Check `pam_env` configuration.

### Extension not appearing in VS Code

**Cause:** Symlink not created by init-extensions script.

**Fix:** Check `/etc/s6-overlay/s6-rc.d/init-extensions/run` logs. Extension must exist in `/app/pre-installed-extensions/`.

### mise shim not working

**Cause:** mise not in PATH or MISE_* env vars not set.

**Fix:** Verify `/etc/environment` contains correct mise configuration and is being sourced.

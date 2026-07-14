# Architecture

Technical overview of the EnvHaven Docker image design decisions and rationale.

## Overview

EnvHaven is a Docker image that provides a Batteries-Included Agentic Environment with pre-installed AI coding tools. It extends the LinuxServer.io (LSIO) code-server image.

```
┌─────────────────────────────────────────────────────────────────┐
│                     EnvHaven Container                          │
│                                                                 │
│  /opt/envhaven/bin/    ← AI tools (mise, uv, aider, kiro...)  │
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

- **code-server** — VS Code in the browser
- **s6-overlay** — Process supervisor and init system
- **Ubuntu 24.04** — Stable base with recent packages
- **LSIO conventions** — Standardized paths and patterns

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

Install tools to `/opt/envhaven/bin/` — a path that is **never mounted over**:

```dockerfile
# Create tool directory outside /config
RUN mkdir -p /opt/envhaven/bin /opt/envhaven/uv-tools

# Install tools, then move to safe location
RUN curl https://mise.run | sh && \
    mv /config/.local/bin/mise /opt/envhaven/bin/mise
```

### PATH Priority

Users can still override any tool by installing their own version:

```
/config/.local/bin      # User overrides (first priority)
/opt/envhaven/bin       # System tools (our installations)
/opt/envhaven/cargo/bin # Rust toolchain (cargo, rustc)
/mise/shims             # mise-managed tools
/usr/local/bin          # System binaries
```

## Directory Structure

| Path | Purpose | Mounted? | Mutable? |
|------|---------|----------|----------|
| `/config` | User home directory (`HOME=/config`) | **Yes** | Yes |
| `/config/.local/bin` | User and self-updater tool overrides, first on PATH | **Yes** | Yes |
| `/opt/envhaven/bin` | Pre-installed AI tools | No | Yes (abc-writable for self-updates) |
| `/opt/envhaven/uv-tools` | Python tool virtualenvs | No | Yes (abc-writable for self-updates) |
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

Recorded exceptions: gemini and qwen auto-update by default by spawning `npm install -g` over
their own install. No conforming vendor mechanism exists; invariant 2 contains the damage and
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
bun = "latest"
"ubi:sharkdp/fd" = "10.2.0"
"aqua:cli/cli" = "latest"          # gh
"aqua:cloudflare/cloudflared" = "latest"
"aqua:sst/opencode" = "latest"
"aqua:astral-sh/uv" = "latest"
"ubi:block/goose" = "latest"
```

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

RUN uv tool install aider-chat && uv tool install mistral-vibe && uv tool install hermes-agent
```

### Category 3: Standalone installers

HOME-anchored installers run at build with their output relocated out of `/config` (the volume
mount would hide it); if the tool needs a `$HOME` anchor at runtime, an init script seeds it,
guard-before-mutate. One pattern, two instances:

**mv-only** (kiro, droid): run the installer, move the binary.

```dockerfile
RUN curl -fsSL https://cli.kiro.dev/install | bash && \
    mv /config/.local/bin/kiro* /opt/envhaven/bin/ 2>/dev/null || true
RUN curl -fsSL https://app.factory.ai/cli | sh && \
    mv /config/.local/bin/droid /opt/envhaven/bin/ 2>/dev/null || true
```

**HOME-swap plus seed** (claude): bake under `HOME=/opt/envhaven/claude-home`, expose via an
`/opt/envhaven/bin/claude` symlink, and seed `/config/.local/bin/claude` at boot
(`init-user-config-run`) so the runtime updater owns the overlay copy and its launcher check
passes. The updater's first run replaces the seed with the workspace's own versioned install
under `/config/.local/share/claude`.

## s6-overlay Init System

s6-overlay runs initialization scripts after the container starts but **after** volumes are mounted. This is key — we can safely write to `/config/` in init scripts.

### Init Scripts (oneshot)

Located in `runtime/scripts/`, these run once at container startup:

| Script | Purpose |
|--------|---------|
| `init-user-config` | SSH keys, git config, shell setup, `/config/artifacts` drop folder |
| `init-zsh-config` | oh-my-zsh configuration |
| `init-vscode-settings` | VS Code theme and settings |
| `init-extensions` | Symlink pre-installed extensions |
| `init-agents-md` | Generate workspace AGENTS.md |
| `init-agent-config` | Seed AI agent configs (Claude, Codex), no-clobber |

### Services (longrun)

| Script | Purpose |
|--------|---------|
| `svc-sshd` | SSH daemon for remote access |
| `svc-cloudflared` | Cloudflare tunnel (only if `CLOUDFLARE_TUNNEL_TOKEN` is set) |
| `svc-console` | In-container console server (:7681): browser terminal plus an HTTP API (stats, tools, env, skills, artifacts, tmux actions) behind the same auth |

### Execution Order

```
Container starts
    ↓
Volumes mounted (/config)
    ↓
s6-overlay runs init-adduser (LSIO creates abc user)
    ↓
Our oneshot scripts run (depend on init-adduser)
    ↓
Longrun services start (svc-sshd, svc-cloudflared, svc-console)
    ↓
code-server starts
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
PATH="/config/.local/bin:/opt/envhaven/bin:/opt/envhaven/cargo/bin:/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
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

1. Static single binary with an aqua/ubi backend: `mise.toml`.
2. npm package: `npm install -g` under mise's node.
3. Python package: `uv tool install` (UV_TOOL_DIR/UV_TOOL_BIN_DIR are baked).
4. Vendor installer only, or forced here by the update contract: run the installer at build and
   relocate the result out of `/config` (Category 3 above).

Then, always:

5. Confirm from the vendor's docs which updater the tool ships and whether it is kill-safe
   (invariant 1). Guessing is forbidden. A background updater that swaps files in place forces
   rung 4.
6. Add the tool to `tool-definitions.json`. The verification gates derive from it: the
   Dockerfile verification block, `dev/scripts/test-image.ts`, `dev/scripts/test-ai-tools.ts`,
   CI, and the platform e2e suite all run `command --version` for every catalog entry, so the
   roster cannot drift.

## Persistent Terminal Sessions

EnvHaven provides persistent terminal sessions that survive reconnects. This enables long-running AI agent sessions while you disconnect and reconnect freely.

### Why tmux

We use [tmux](https://github.com/tmux/tmux)—the battle-tested terminal multiplexer that's been rock-solid for decades. Rather than reinvent session persistence, we leverage tmux's proven architecture with a minimal, opinionated configuration.

Our approach:
- **Single session** (`envhaven`) — all windows live here, simplifying multi-device access
- **Status bar off by default** — VS Code and the managed dashboard already show a window list; SSH sessions and the self-host browser terminal get a bar (window names, hotkey hints) via grouped sessions
- **Mouse enabled** — click to switch terminals, scroll naturally
- **Sensible defaults** — 50k scrollback, no escape delay, numbering starts at 1

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
│  │  │  opencode   │  │   aider     │  │  npm run    │       │  │
│  │  │  (running)  │  │  (running)  │  │  dev        │       │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  User disconnects → processes keep running                      │
│  User reconnects → same terminals, same state                   │
└─────────────────────────────────────────────────────────────────┘
```

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
| Extension sidebar | Polls tmux for window list, renders "Terminals" panel |

**Session lifecycle:**
- Created on first terminal open (`tmux new-session -s envhaven`)
- Survives reconnects (tmux detach/attach)
- Destroyed on container stop (unless `/config` mounted and tmux resurrect configured)

## Design Principles

| Principle | Application |
|-----------|-------------|
| **Simplicity** | One tool location (`/opt/envhaven/bin`), one user data location (`/config`) |
| **User Override** | `/config/.local/bin` has highest PATH priority — users can override any tool |
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

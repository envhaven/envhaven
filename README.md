<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/logo-white.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/logo.svg">
    <img alt="EnvHaven" src=".github/logo.svg" width="80">
  </picture>
</p>

<h1 align="center">EnvHaven</h1>

<p align="center">
  <strong>Batteries-included development environment for agentic workflows.</strong>
</p>

<p align="center">
  <a href="https://github.com/envhaven/envhaven/actions"><img src="https://github.com/envhaven/envhaven/actions/workflows/docker.yml/badge.svg" alt="Build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <img src=".github/product-overview.gif" alt="EnvHaven product overview" width="640">
</p>

As tools like Claude Code, OpenCode and Codex gain agency, they need full system access to be effective. Running them locally carries risk (`rm -rf` accidents, credential leaks) and friction (installing runtimes, approving every action).

EnvHaven is an isolated, remote environment with every major AI coding tool built-in. The container provides the isolation, so all agents ship with full access by default. No approval prompts, no confirmation dialogs. Your local machine stays untouched.

**Workflow Freedom:**
- **Browser-only**: Deploy the image, open VS Code in your browser, run `opencode`. Zero setup.
- **Local editor + remote AI**: Use the Haven CLI to sync your project. Edit in Neovim, Zed, Jetbrains, et al. while agents run in the container. Changes sync in ~200ms.

---

## Why EnvHaven

🛡️ **Zero-Risk AI environment**
Give autonomous agents full access in a containerized environment. If they break something, nuke the workspace and start over. Your local machine stays untouched.

🖥️ **Pick Up Where You Left Off**
Start Claude Code on your laptop, close the lid, resume from your desktop: same session, same state. Your AI agents and dev servers keep running while you're away. Come back from any device.

🌲 **Evergreen AI Tooling**
The landscape moves too fast to manage manually. EnvHaven ships with 17 AI CLI tools (Claude Code, OpenCode, Codex, Kimi Code CLI, Muse Code, Goose, etc.) built-in and ready to run.

🌐 **Instant Public URLs** *(Managed only)*
Every managed workspace gets a wildcard `*.envhaven.app` domain. Deploy a web app, webhook receiver, or Discord bot. Live instantly, with no ngrok, no tunnels, no DNS.

💾 **Persistent & Owned**
Unlike ephemeral environments (Codespaces) or walled gardens (Replit), EnvHaven workspaces are persistent Linux environments you own.

⚡ **Open Model**
- **Self-Hosted**: Free forever, open-source Docker image and CLI. Run it on your own server.
- **Managed** (from $12/mo): Zero-config hosting with custom domains, always-on workspaces, and no DevOps.

---

## Who It's For

| Persona | Use Case |
|---------|----------|
| **Vibe Coders** | That ship by prompting their way to products. Need a "magic box" where code just runs, already fully setup. |
| **AI-Native Devs** | Power users of agentic coding tools like Claude Code or OpenCode that want a standardized, pre-configured backend for their agents. |
| **Setup Purists** | Developers married to their beautifully tuned and customized editor. Use Haven CLI to keep your workflow while agents run wild in a contained environment.  |
| **Bot Builders** | Those who vibe-code 24/7 persistent scripts (Discord, Telegram or even trading bots). |

## Quick Start

### Path A: Browser-Only (Zero Setup)
Deploy the image and code immediately in the browser.

```bash
docker run -d \
  --name envhaven \
  -p 8443:8443 \
  -p 2222:22 \
  -e PASSWORD=password \
  -e SUDO_PASSWORD=password \
  ghcr.io/envhaven/envhaven:latest
```

1. Open `http://localhost:8443` (Password: `password`)
2. Open terminal; you're dropped into a persistent session
3. Run `opencode`, `claude`, or `codex` and start coding

### Path B: Local Editor + Remote AI (Haven CLI)
Use your local editor. Files sync bidirectionally. Agents run in the container.

**1. Install Haven CLI**
```bash
curl -fsSL https://envhaven.com/install.sh | bash
```

**2. Connect to your workspace**
```bash
cd my-project

# Managed workspace (shorthand)
haven connect . myproject-alice

# Self-hosted container
haven connect . abc@your-server.com:2222
```
*Files sync in ~200ms.*

**3. Run remote commands**
```bash
haven opencode     # Runs OpenCode in the container
haven make build   # Runs make in the container
haven npm install  # Runs npm in the container
```

> **Self-hosted?** You'll need to configure SSH keys first. See [SSH Access](#ssh-access).

## What's Included

The image (`ghcr.io/envhaven/envhaven`) comes batteries-included.

### AI Coding Agents
No API keys are pre-set. You can set them directly in the UI via the bundled EnvHaven Extension in code-server.

You can also provide your own keys via env vars (`-e ANTHROPIC_API_KEY=...`) or config files.

<!-- BEGIN GENERATED: TOOL CATALOG -->
The image includes 17 AI coding agents.

| Tool | Command | Description | Authentication |
|------|---------|-------------|----------------|
| **[Claude Code](https://code.claude.com/docs)** | `claude` | Anthropic's official CLI | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or `/login` in the CLI |
| **[Codex](https://github.com/openai/codex)** | `codex` | OpenAI's coding agent | ChatGPT/device login, an API key via `codex login --with-api-key`, or `CODEX_ACCESS_TOKEN` |
| **[OpenCode](https://opencode.ai/docs)** | `opencode` | AI coding agent from Anomaly | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY` |
| **[Antigravity CLI](https://antigravity.google/docs/cli)** | `agy` | Google's agent-first CLI | `GEMINI_API_KEY`, or run `agy` to sign in |
| **[Grok Build](https://docs.x.ai/build/overview)** | `grok` | SpaceXAI's coding agent | `XAI_API_KEY` or `grok login --device-auth` |
| **[Kimi Code CLI](https://moonshotai.github.io/kimi-code/en/)** | `kimi` | Moonshot AI's open-source coding agent | `kimi login --region global` (use `mainland-cn` for kimi.com) |
| **[Muse Code](https://developer.meta.com/ai/products/muse-code/)** | `muse` | Meta's agentic coding assistant | `META_API_KEY` or browser sign-in on first run |
| **[OpenClaw](https://docs.openclaw.ai)** | `openclaw` | Personal AI assistant gateway | Provider API keys or `openclaw onboard` |
| **[Hermes Agent](https://hermes-agent.nousresearch.com/docs)** | `hermes` | Self-improving agent from Nous Research | Provider API keys or `hermes setup` |
| **[Pi](https://pi.dev/docs/latest)** | `pi` | Minimal extensible coding agent | Provider API keys or `/login` in the CLI |
| **[Goose](https://goose-docs.ai)** | `goose` | Extensible open-source agent | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; run `goose configure` |
| **[Qwen Code](https://qwenlm.github.io/qwen-code-docs)** | `qwen` | Alibaba's coding assistant | `OPENAI_API_KEY` with an OpenAI-compatible endpoint |
| **[Mistral Vibe](https://github.com/mistralai/mistral-vibe)** | `vibe` | Mistral's minimal CLI coding agent | `MISTRAL_API_KEY` |
| **[Factory](https://docs.factory.ai/droid-cli/quickstart)** | `droid` | Factory's Droid coding agent | Browser login or `FACTORY_API_KEY` |
| **[Kiro](https://kiro.dev/docs/cli)** | `kiro-cli` | AWS-powered AI CLI | Browser or device-flow login |
| **[Amp](https://ampcode.com/manual)** | `amp` | Frontier coding agent | `AMP_API_KEY` or `amp login` |
| **[fx](https://fx.sh/docs)** | `fx` | Tiny native coding agent from Vercel Labs | `AI_GATEWAY_API_KEY`, or run `fx` to sign in |
<!-- END GENERATED: TOOL CATALOG -->

### Zero-Friction Permissions

EnvHaven workspaces are structurally isolated. The container provides the isolation, so all agents are pre-configured with full access by default. No approval prompts, no confirmation dialogs. Agents execute immediately.

You can re-enable prompts per tool by editing the relevant config or unsetting the env var. See the in-workspace `AGENTS.md` for details.

### Runtimes & SDKs
| Language | Version | Notes |
|----------|---------|-------|
| **Node.js** | 22.x | LTS |
| **Bun** | 1.3.5 | Fast JS runtime |
| **Python** | 3.12 | Via `mise` |
| **Go** | 1.22 | |
| **Rust** | Stable | Via rustup |

### Dev Tools
- **Core:** `zsh`, `git`, `curl`, `wget`, `unzip`
- **Utils:** `ripgrep`, `fd`, `jq`, `sqlite3`, `htop`
- **Media:** `ffmpeg` (video/audio), `playwright` (browser automation)
- **Integrations:** `gh` (GitHub CLI), `docker` (client)

## Haven CLI Architecture

The CLI enables a hybrid workflow: **Local Editor + Remote Compute**.

- **Latency:** ~200ms bidirectional sync.
- **Compatibility:** Works with any editor.
- **Independence:** The sync daemon runs in the background; close the CLI and sync continues.

```
┌────────────────────────────────────────────────────────────────────────┐
│                            YOUR MACHINE                                │
│                                                                        │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐   │
│  │  Local Editors  │     │    Haven CLI    │     │  Local Builds   │   │
│  │                 │     │                 │     │                 │   │
│  │  vim            │     │  haven connect  │     │  binaries       │   │
│  │  vscode         │     │  haven status   │     │  native apps    │   │
│  │  zed            │     │  haven <cmd>    │     │  certs+signing  │   │
│  │                 │     │                 │     │                 │   │
│  └────────┬────────┘     └────────┬────────┘     └────────┬────────┘   │
│           │                       │                       │            │
│           ▼                       ▼                       ▼            │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    ~/projects/myapp/                             │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                   ▲                                    │
└───────────────────────────────────┼────────────────────────────────────┘
                                    │
                           Files sync in ~200ms
                        via SSH + Mutagen Protocol
                                    │
┌───────────────────────────────────┼────────────────────────────────────┐
│                                   ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    /config/workspace/myapp/                      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│           ▲                       ▲                       ▲            │
│           │                       │                       │            │
│  ┌────────┴────────┐     ┌────────┴────────┐     ┌────────┴────────┐   │
│  │  Claude Code    │     │    OpenCode     │     │     Codex       │   │
│  │  Long-running   │     │  Long-running   │     │  Task-based     │   │
│  │  AI sessions    │     │  AI sessions    │     │  AI sessions    │   │
│  └─────────────────┘     └─────────────────┘     └─────────────────┘   │
│                                                                        │
│                          ENVHAVEN CONTAINER                            │
└────────────────────────────────────────────────────────────────────────┘
```

**Why this matters:**
- **AI agents need contained compute:** They require massive context windows, long-running processes, specific toolchains, and might do dangerous stuff some time.
- **You need your editor:** You rely on your custom keybindings, themes, and muscle memory.
- **Flexibility:** Both workflows work independently or together.

## Docker Compose

For persistent deployments, use `docker-compose.yml` with `.env`:

```bash
cp .env.example .env    # Copy and edit with your passwords/API keys
docker compose up -d
```

Or use inline environment variables for quick testing:

```yaml
services:
  envhaven:
    image: ghcr.io/envhaven/envhaven:latest
    container_name: envhaven
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - PASSWORD=password        # Web UI password
      - SUDO_PASSWORD=password   # sudo/SSH password
    volumes:
      - ./config:/config         # Persist home directory
    ports:
      - 8443:8443               # Web UI
      - 2222:22                 # SSH Access
    restart: unless-stopped
```

See [Configuration Reference](docs/configuration.md) for all options including AI API keys and SSH setup.

## SSH Access

SSH enables the Haven CLI and direct terminal access.

| Setup | SSH Host | Haven CLI |
|-------|----------|-----------|
| **Managed** | `ssh-{subdomain}.envhaven.app` | `haven connect . myproject-alice` |
| **Self-hosted** | `your-server:2222` | `haven connect . abc@your-server:2222` |

**Self-hosted setup:** Import your GitHub keys automatically:

```yaml
environment:
  - PUBLIC_KEY_URL=https://github.com/yourusername.keys
ports:
  - "2222:22"
```

See [Configuration Reference](docs/configuration.md) for all SSH options.

## Documentation

- **[AI Tools Guide](docs/ai-tools.md)**: Setup guides, API keys, and usage examples for all 17 AI coding tools
- **[Configuration Reference](docs/configuration.md)**: Complete env vars, SSH setup, bundled tools, and compose examples
- **[Development Guide](docs/development.md)**: Building from source, testing, and contributing
- **[Haven CLI](cli/README.md)**: CLI source and architecture

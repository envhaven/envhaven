# AI Tools Guide

## Available Tools

<!-- BEGIN GENERATED: TOOL CATALOG -->
EnvHaven includes 17 CLI-based AI agents.

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

## API Key Configuration

### Setting API Keys

**Option 1: Environment variables in docker-compose.yml**

```yaml
environment:
  - ANTHROPIC_API_KEY=sk-ant-...
  - OPENAI_API_KEY=sk-...
  - GOOGLE_API_KEY=...
  - MISTRAL_API_KEY=...
```

**Option 2: Inside the container**

```bash
# Add to .bashrc or .zshrc for persistence
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc
source ~/.zshrc
```

**Option 3: Via the EnvHaven extension sidebar**

The EnvHaven extension in the VS Code sidebar provides a UI for setting API keys. The in-container console writes them to `~/.config/envhaven/environment`, a mode-`0600` file sourced by new bash and zsh sessions. It also performs any required vendor-specific setup.

Sign-out uses each vendor's native command when one exists. Antigravity and Factory expose logout
only inside their interactive clients, so EnvHaven opens a terminal and asks you to run `/logout`.
EnvHaven removes only values in its managed credential store. Manually authored rc exports are left
for you to edit, process-level keys require a workspace restart, and shared provider keys must be
removed from Environment because that action disconnects every tool named there. On upgrade, the
startup migration moves older `# envhaven` exports into the managed store. It recognizes the original
sidebar's unmarked format only when `.zshrc` and `.bashrc` each contain one static double-quoted
export with the same decoded name and value for a known managed key. Ambiguous or mismatched exports
are left untouched.

### Which Keys for Which Tools

<!-- BEGIN GENERATED: TOOL ENVIRONMENT VARIABLES -->
| Variable | Tools |
|----------|-------|
| `AI_GATEWAY_API_KEY` | fx |
| `AMP_API_KEY` | Amp |
| `ANTHROPIC_API_KEY` | Claude Code, OpenCode, OpenClaw, Hermes Agent, Pi, Goose |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code |
| `FACTORY_API_KEY` | Factory |
| `GEMINI_API_KEY` | OpenCode, Antigravity CLI, OpenClaw, Hermes Agent, Pi |
| `GOOGLE_API_KEY` | OpenCode, OpenClaw, Hermes Agent |
| `META_API_KEY` | Muse Code |
| `MISTRAL_API_KEY` | Mistral Vibe |
| `OPENAI_API_KEY` | OpenCode, OpenClaw, Hermes Agent, Pi, Goose, Qwen Code |
| `OPENROUTER_API_KEY` | Hermes Agent |
| `XAI_API_KEY` | Grok Build |
<!-- END GENERATED: TOOL ENVIRONMENT VARIABLES -->

## Persistent Terminals

Start Claude Code on your laptop. Close the lid. Open your desktop browser. Pick up exactly where you left off: same session, same scroll position, same everything.

EnvHaven terminals survive disconnects. Your AI agent keeps working while you're away. Your dev server keeps running. Come back hours later from any device and it's all still there.

### Example

1. Launch Claude Code in one terminal; it starts working on your refactor
2. Open a second terminal, run `npm run dev`
3. Open a third, `git log --oneline` to check history

Close your browser. Go home. Open EnvHaven on your phone; all three terminals are still running, exactly as you left them.

### How to Manage Terminals

| Method | How |
|--------|-----|
| **Sidebar** | The "Terminals" panel lists your terminals; use it to switch, create, and close |
| **Keyboard** | `Ctrl-b n` new, `Ctrl-b 1-9` switch, `Ctrl-b x` close |

## Quick Start Examples

### OpenCode

```bash
opencode
# Opens interactive session in current directory
# Type /connect to configure your provider
```

### Claude Code

```bash
claude
# Interactive Claude coding session
# Type /login to authenticate via browser
```

### Codex

```bash
codex "add error handling to this function"
# Or start interactive session
codex
```

Codex does not treat an ambient API key as a persisted interactive login. To use an OpenAI API
key, pipe it to the native login command: `printenv OPENAI_API_KEY | codex login --with-api-key`.
Codex stores that login in its own credential cache, which EnvHaven then reports and can sign out.
An enterprise `CODEX_ACCESS_TOKEN` is different: Codex reads it directly from the process. Remove
it from the workspace configuration and restart the workspace to sign out.

### Pi

```bash
pi
# Type /login to authenticate, or set a provider API key
```

### OpenClaw

```bash
openclaw onboard  # First time setup
openclaw          # Start the assistant
```

### Hermes Agent

```bash
hermes setup  # First time setup
hermes        # Start coding
```

### Goose

```bash
goose session start
# First time: run `goose configure` to set up provider
```

### Mistral Vibe

```bash
vibe
# Local/offline models are configured in ~/.vibe/config.toml
```

### Qwen Code

```bash
export OPENAI_API_KEY=...   # any OpenAI-compatible endpoint
qwen                       # select the matching API-key provider on first run
```

The free OAuth tier ended on 2026-04-15, so Qwen Code needs a current API-key provider. Its
`security.auth.selectedType` setting must name that provider before any process variable, managed or
manual shell export, `~/.qwen/.env` value, or settings value counts as connected. EnvHaven ignores a
stale OAuth cache as proof of readiness; sign-out removes credential values, including legacy ones,
and keeps model/provider settings intact.

### Amp

```bash
amp login  # First time setup
amp        # Start coding
```

### Kiro

```bash
kiro-cli
# Browser auth opens automatically
# Sign in with GitHub, Google, or AWS Builder ID
```

`KIRO_API_KEY` is supported by Kiro's non-interactive/headless mode on eligible paid plans. Kiro's
interactive TUI requires browser or device-flow login, so EnvHaven does not use that variable as
the TUI's signed-in status.

### Factory

```bash
droid
# Browser auth opens automatically on first run
```

### Antigravity CLI

```bash
agy
# Authenticates on first run; or set GEMINI_API_KEY before the container starts
```

agy reads `GEMINI_API_KEY` only with `modelProvider: "gemini"` in `~/.gemini/antigravity-cli/settings.json`;
EnvHaven writes that setting when the key is saved and checks it again before every launch. Boot
also prepares it for keys supplied through the container environment.

### Grok Build

```bash
grok login --device-auth   # Device-code flow, built for headless containers
grok                       # Start coding
```

### Kimi Code CLI

```bash
kimi login --region global  # Device-code login for kimi.ai
kimi                        # Start coding in Never Ask mode
```

Configure Kimi Platform API keys inside `kimi` with `/provider`. EnvHaven does not export them as
shell environment variables. EnvHaven's connection control tracks Kimi's managed OAuth login; API-key
providers stay under Kimi's `/provider` manager. Use `kimi login --region mainland-cn` for a
kimi.com account.

### Muse Code

```bash
muse login  # Sign in with your Meta account in the browser
muse        # Start coding
```

Set `META_API_KEY` for non-interactive authentication. A bare `muse` launch adds
`--disable-approval`, which removes command approval prompts while retaining Muse's OS-enforced
sandbox. Explicit arguments pass through unchanged, so `muse login`, `muse logout`, and
`muse --approval-mode on-request` keep their native behavior.

EnvHaven applies the default approval flags through executable launchers, rather than shell
aliases. The same defaults therefore apply to interactive terminals and non-interactive commands
such as `haven agy`. A user-installed executable in `~/.local/bin` still takes precedence.

### fx

```bash
fx         # Sign in on first run, then start coding
```

Running `fx` unauthenticated opens its sign-in flow: Vercel AI Gateway, a ChatGPT subscription,
or a SuperGrok subscription. Setting `AI_GATEWAY_API_KEY` beforehand skips it.

## VS Code Extensions

Some AI tools have VS Code extensions that are pre-installed:

| Extension | Notes |
|-----------|-------|
| EnvHaven | Tool launcher sidebar, API key management |

### HTTPS Requirement

VS Code extensions with webview UIs require a **secure context** to render properly. Over plain HTTP, some extension panels may show blank.

**Solutions:**

1. **Use HTTPS** - Set up a reverse proxy with SSL
2. **Use a tunnel** - Cloudflare Tunnel, ngrok, etc.
3. **Access via localhost** - Always considered secure

**CLI tools are unaffected** - All CLI tools (`opencode`, `claude`, `codex`, etc.) work regardless of HTTP/HTTPS.

## Using Haven CLI (Local Editor + Remote AI)

Haven CLI lets you use your local editor (neovim, emacs, helix) while AI tools run on the remote EnvHaven container. Changes sync bidirectionally in ~200ms.

### Setup

```bash
# Install Haven CLI on your local machine
curl -fsSL https://envhaven.com/install.sh | bash

# Connect a local project to remote workspace
cd ~/projects/myapp
haven connect .
```

### Workflow

```bash
# Terminal 1: Local editor
nvim src/app.ts

# Terminal 2: Remote AI tool (via Haven CLI)
haven opencode       # or haven claude, haven codex

# Changes sync automatically:
# - AI writes code on remote → appears in local nvim in ~200ms
# - You edit locally → AI sees changes on next file read
```

### Commands

```bash
haven connect .          # Connect current directory
haven disconnect         # Stop sync
haven status             # Check connection status
haven opencode           # Run OpenCode on remote
haven codex              # Run Codex on remote
haven <any-command>      # Run any command on remote
```

See [cli/README.md](../cli/README.md) for full documentation.

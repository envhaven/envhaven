# AI Tools Guide

EnvHaven includes 12 CLI-based AI coding assistants pre-installed and ready to use.

## Available Tools

| Tool | Command | Description | API Key / Auth |
|------|---------|-------------|----------------|
| **OpenCode** | `opencode` | SST's autonomous coding agent | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` |
| **Claude Code** | `claude` | Anthropic's official CLI | `ANTHROPIC_API_KEY` or `/login` in CLI |
| **Aider** | `aider` | AI pair programming | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY` |
| **Codex** | `codex` | OpenAI's coding agent | `OPENAI_API_KEY` or ChatGPT login |
| **Gemini CLI** | `gemini` | Google's AI in terminal | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| **Goose** | `goose` | Block's developer agent | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (run `goose configure`) |
| **Mistral Vibe** | `vibe` | Powered by Devstral | `MISTRAL_API_KEY` |
| **Qwen Code** | `qwen` | Alibaba's coding assistant | `QWEN_API_KEY` or `OPENAI_API_KEY` (compatible endpoint) |
| **Amp** | `amp` | Sourcegraph's coding agent | `AMP_API_KEY` or `amp login` |
| **Augment** | `auggie` | Context-aware coding agent | Browser login via `auggie login` |
| **Kiro** | `kiro-cli` | AWS-powered AI CLI | Browser login (GitHub/Google/AWS Builder ID) |
| **Factory Droid** | `droid` | Factory's AI agent | Browser login or `FACTORY_API_KEY` |

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

The EnvHaven extension in the VS Code sidebar provides a UI for setting API keys. Keys are saved to your shell config for persistence.

### Which Keys for Which Tools

| API Key | Tools |
|---------|-------|
| `ANTHROPIC_API_KEY` | Claude Code, OpenCode, Aider, Goose |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code (subscription auth) |
| `OPENAI_API_KEY` | Codex, OpenCode, Aider, Goose, Qwen Code |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini CLI, OpenCode, Aider |
| `MISTRAL_API_KEY` | Mistral Vibe |
| `OPENROUTER_API_KEY` | Aider |
| `AMP_API_KEY` | Amp |
| `AUGMENT_SESSION_AUTH` | Augment |
| `FACTORY_API_KEY` | Factory Droid |
| `QWEN_API_KEY` | Qwen Code |

## Persistent Terminals

Start Claude Code on your laptop. Close the lid. Open your desktop browser. Pick up exactly where you left off—same session, same scroll position, same everything.

EnvHaven terminals survive disconnects. Your AI agent keeps working while you're away. Your dev server keeps running. Come back hours later from any device and it's all still there.

### Example

1. Launch Claude Code in one terminal; it starts working on your refactor
2. Open a second terminal, run `npm run dev`
3. Open a third, `git log --oneline` to check history

Close your browser. Go home. Open EnvHaven on your phone—all three terminals still running, exactly as you left them.

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

### Aider

```bash
# With Claude (default if ANTHROPIC_API_KEY is set)
aider

# With GPT-4
aider --model gpt-4

# Add specific files to context
aider src/main.ts src/utils.ts
```

### Codex

```bash
codex "add error handling to this function"
# Or start interactive session
codex
```

### Gemini CLI

```bash
gemini
# Select auth method on first run
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
qwen
# Sign in on first run (free tier available)
```

### Amp

```bash
amp login  # First time setup
amp        # Start coding
```

### Augment

```bash
auggie login  # First time setup
auggie        # Start coding
```

### Kiro

```bash
kiro-cli
# Browser auth opens automatically
# Sign in with GitHub, Google, or AWS Builder ID
```

### Factory Droid

```bash
droid
# Browser auth opens automatically on first run
```

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

**CLI tools are unaffected** - All CLI tools (`opencode`, `claude`, `aider`, etc.) work regardless of HTTP/HTTPS.

## Using Haven CLI (Local Editor + Remote AI)

Haven CLI lets you use your local editor (neovim, emacs, helix) while AI tools run on the remote EnvHaven container. Changes sync bidirectionally in ~200ms.

### Setup

```bash
# Install Haven CLI on your local machine
curl -fsSL https://envhaven.com/install.sh | sh

# Connect a local project to remote workspace
cd ~/projects/myapp
haven connect .
```

### Workflow

```bash
# Terminal 1: Local editor
nvim src/app.ts

# Terminal 2: Remote AI tool (via Haven CLI)
haven opencode       # or haven claude, haven aider

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
haven aider              # Run Aider on remote
haven <any-command>      # Run any command on remote
```

See [cli/README.md](../cli/README.md) for full documentation.

## Tool-Specific Documentation

- [OpenCode Docs](https://opencode.ai/docs)
- [Claude Code Docs](https://docs.anthropic.com/en/docs/claude-code)
- [Aider Docs](https://aider.chat/docs)
- [Codex CLI](https://github.com/openai/codex)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Goose Docs](https://block.github.io/goose)
- [Mistral Vibe](https://github.com/mistralai/mistral-vibe)
- [Qwen Code](https://qwenlm.github.io/qwen-code-docs)
- [Amp Docs](https://ampcode.com/manual)
- [Augment Docs](https://docs.augmentcode.com/cli/overview)
- [Kiro Docs](https://kiro.dev/docs/cli)
- [Factory Docs](https://docs.factory.ai)

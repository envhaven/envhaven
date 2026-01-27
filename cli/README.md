# Haven CLI

Local editor + remote AI coding environment.

Haven CLI enables you to use your local editor (neovim, emacs, helix) while AI tools (Claude Code, OpenCode, aider) run extended sessions on remote EnvHaven containers.

## Installation

### macOS / Linux

```bash
curl -fsSL https://envhaven.com/install.sh | sh
```

### Windows

Haven CLI requires WSL (Windows Subsystem for Linux):

```bash
# In WSL terminal
curl -fsSL https://envhaven.com/install.sh | sh
```

### Manual Installation

```bash
# macOS Apple Silicon
curl -fsSL https://github.com/envhaven/envhaven/releases/latest/download/haven-darwin-arm64 -o haven

# macOS Intel
curl -fsSL https://github.com/envhaven/envhaven/releases/latest/download/haven-darwin-x64 -o haven

# Linux x64
curl -fsSL https://github.com/envhaven/envhaven/releases/latest/download/haven-linux-x64 -o haven

# Linux ARM64
curl -fsSL https://github.com/envhaven/envhaven/releases/latest/download/haven-linux-arm64 -o haven

chmod +x haven
mv haven ~/.local/bin/
```

## Quick Start

```bash
# Managed EnvHaven workspace (shorthand)
haven connect . myproject-alice

# Self-hosted container (specify user and port)
haven connect . abc@myserver.com:2222

# Connect interactively (prompts for connection)
haven connect .

# Run AI tools on remote
haven opencode
haven claude
haven aider

# Run any command on remote
haven npm install
haven git status
haven python app.py

# Check status
haven status

# Disconnect
haven disconnect
```

## Commands

### `haven connect [path] [target]`

Connect a local directory to a remote EnvHaven workspace.

```bash
# Managed EnvHaven workspace (shorthand - recommended)
haven connect . myproject-alice

# Full URL also works
haven connect . ssh-myproject-alice.envhaven.app

# Self-hosted container (specify user and port)
haven connect . abc@myserver.com:2222

# Interactive - prompts for connection
haven connect .

# Reconnect (from within a connected directory)
haven connect

# After workspace rebuild (clear cached host key)
haven connect --reset-host-key

# Override idle timeout
haven connect --idle-timeout 4h
```

**Target formats:**
| Format | Example | Expands To |
|--------|---------|------------|
| Shorthand (managed) | `myproject-alice` | `ssh-myproject-alice.envhaven.app` |
| Full hostname | `ssh-myproject-alice.envhaven.app` | (used as-is) |
| Self-hosted | `abc@myserver.com:2222` | (used as-is) |

**Managed workspace subdomains:**
| URL | Purpose |
|-----|---------|
| `myproject-alice.envhaven.app` | code-server web UI (via CF tunnel) |
| `preview-myproject-alice.envhaven.app` | Preview URL (via CF tunnel) |
| `ssh-myproject-alice.envhaven.app` | SSH access (direct A record, port 22) |

### `haven disconnect`

Stop sync and disconnect from remote workspace.

```bash
haven disconnect
```

### `haven status`

Show connection and sync status.

```bash
# Standard output
haven status

# Watch mode (live updates)
haven status --watch

# JSON output (for scripts)
haven status --json

# Diagnose connection issues
haven status --diagnose
```

### `haven <command>`

Run any command on the remote workspace.

```bash
haven opencode           # Start OpenCode session
haven aider --model gpt-4   # Run aider with args
haven npm install        # Run npm
haven git push          # Run git
```

Commands inherit stdin/stdout for interactive use.

### Escape Hatch

If you need to run a command literally named "status" on remote:

```bash
haven -- status
```

## How It Works

```
┌────────────────────────────────────────────────────────────────────────┐
│                            YOUR MACHINE                                │
│                                                                        │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐   │
│  │   Local Editor  │     │   Haven CLI     │     │  Sync Daemon    │   │
│  │                 │     │                 │     │   (Mutagen)     │   │
│  │  nvim/lazyvim   │     │  haven connect  │     │                 │   │
│  │  emacs/doom     │     │  haven status   │     │  Continuous     │   │
│  │  helix          │     │  haven <cmd>    │     │  bidirectional  │   │
│  │                 │     │                 │     │  ~200ms latency │   │
│  └────────┬────────┘     └────────┬────────┘     └────────┬────────┘   │
│           │                       │                       │            │
│           ▼                       ▼                       ▼            │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    ~/projects/myapp/                             │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                   ▲                                    │
└───────────────────────────────────┼────────────────────────────────────┘
                                    │
                         SSH + Mutagen Protocol
                              (~200ms)
                                    │
┌───────────────────────────────────┼────────────────────────────────────┐
│                                   ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    /config/workspace/myapp/                       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│           ▲                       ▲                       ▲            │
│           │                       │                       │            │
│  ┌────────┴────────┐     ┌────────┴────────┐     ┌────────┴────────┐   │
│  │  Claude Code    │     │    OpenCode     │     │     aider       │   │
│  │  Long-running   │     │  Long-running   │     │  Task-based     │   │
│  │  AI sessions    │     │  AI sessions    │     │  AI sessions    │   │
│  └─────────────────┘     └─────────────────┘     └─────────────────┘   │
│                                                                        │
│                          ENVHAVEN CONTAINER                            │
└────────────────────────────────────────────────────────────────────────┘
```

## Sync Behavior

- **Continuous bidirectional sync** - Changes sync in ~200ms
- **Conflict detection** - If both sides modify the same file, a `.sync-conflict` file is created
- **Ignored paths** - Common build artifacts are automatically ignored (node_modules, .git, dist, etc.)

### Custom Ignore Patterns

Create `.havenignore` in your project root (gitignore syntax):

```gitignore
data/
*.csv
.terraform/
```

## Configuration

### File Locations

```
~/.config/haven/connections.json   # Connection mappings
~/.local/share/haven/mutagen/      # Mutagen data
~/.ssh/config                       # SSH config (host entries appended per connection)
```

### SSH Keys

Haven CLI dynamically discovers SSH keys in `~/.ssh/`:
- Scans for all `.pub` files where a matching private key exists
- Validates each key with `ssh-keygen -lf` (filters invalid files)
- Includes auto-generated `haven_ed25519` if created

All valid keys are added to the SSH config, so SSH tries each until one works.

#### No SSH Keys?

If you have no SSH keys, Haven automatically generates `~/.ssh/haven_ed25519` and shows you the public key to add to your workspace. This key has no passphrase for maximum convenience.

#### Encrypted (Passphrase-Protected) Keys

Haven uses SSH BatchMode for non-interactive operation. BatchMode cannot prompt for passphrases, so **encrypted keys require ssh-agent**.

Haven **proactively detects** encrypted keys before attempting connection:

```
$ haven connect . myproject

⚠ Your SSH keys are encrypted (passphrase-protected)

  Found keys:
    ~/.ssh/id_ed25519 (encrypted, not in agent)

  Haven uses non-interactive SSH which can't prompt for passphrases.

What would you like to do?

  [1] Generate a Haven key (recommended)
      One-time setup, no passphrase, works everywhere

  [2] Load your key into ssh-agent first
      Run: eval "$(ssh-agent -s)" && ssh-add

Choice [1]:
```

**Option 1 (Haven key)** — simplest, zero ongoing maintenance:
- Generates `~/.ssh/haven_ed25519` with no passphrase
- Shows the public key to add to your workspace
- One-time setup, works forever

**Option 2 (ssh-agent)** — for users who prefer their existing keys:
```bash
eval "$(ssh-agent -s)"
ssh-add

# On macOS, persist in Keychain
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

#### GitHub OAuth Users

If you logged into EnvHaven via GitHub, your SSH keys are automatically imported to the workspace. You just need ssh-agent if your keys have a passphrase.

#### Key Usability Detection

Haven CLI detects key issues **proactively** (before connecting), not reactively (after failure):

| Situation | What Haven Does |
|-----------|-----------------|
| No keys exist | Auto-generates `haven_ed25519`, shows public key |
| Haven key exists | Proceeds (always usable) |
| Unencrypted key exists | Proceeds |
| Encrypted key in ssh-agent | Proceeds |
| **Encrypted key, not in agent** | **Prompts: generate haven key OR run ssh-add** |

This avoids confusing "connection failed" errors when the real issue is a passphrase prompt that BatchMode can't display.

#### When Connection Fails (After Key Check)

If keys are usable but connection still fails:

| Error | Likely Cause | Fix |
|-------|--------------|-----|
| "Host key verification failed" | Workspace rebuilt | `haven connect --reset-host-key` |
| "Permission denied" | Key not authorized | Add public key to workspace |
| Timeout | Workspace stopped or firewall | Check workspace status |

The haven key is always the simplest fix — one-time setup, no ongoing maintenance.

### SSH Configuration

Haven CLI adds host entries directly to `~/.ssh/config`. Each connected workspace gets a unique `Host` entry (e.g., `haven-abc123`) with connection details and identity files.

### Authorizing Keys on the Workspace

For the EnvHaven container to accept your SSH connections, your public key must be in the workspace's `authorized_keys`. Add keys via the **workspace IDE** (code-server), not the web dashboard:

1. Open your workspace in a browser (e.g., `https://myproject-alice.envhaven.app`)
2. In the VS Code sidebar, click the EnvHaven icon
3. Expand "Remote Access"
4. Either enter your GitHub username to import keys, or paste your public key directly

**Alternative methods:**

- **GitHub OAuth:** If you logged in via GitHub, your keys are auto-imported
- **docker-compose:** Set `PUBLIC_KEY_URL=https://github.com/yourusername.keys`

### SSH Troubleshooting

#### "Permission denied (publickey)"

This means SSH couldn't authenticate. Causes:

1. **Key not authorized**: Your public key isn't in the workspace
   - Haven will offer to generate a `haven_ed25519` key for you
   - Add keys via workspace IDE sidebar → EnvHaven → Remote Access

2. **Passphrase key without agent**: BatchMode can't prompt for passphrase
   ```bash
   eval "$(ssh-agent -s)" && ssh-add
   haven connect
   ```

3. **Wrong permissions on remote**: `.ssh` must be `700`, `authorized_keys` must be `600`

#### "Host key verification failed"

The workspace was rebuilt and has a new host key:
```bash
haven connect --reset-host-key
```

#### SSH works manually but Haven fails

Haven uses `BatchMode=yes` which disables interactive prompts. Test with:
```bash
ssh -o BatchMode=yes -p <port> <user>@<host> "echo ok"
```

If this fails but regular `ssh` works, you have a passphrase key without agent.

#### Connection timeout

1. Check workspace is running
2. Verify SSH port is accessible (firewall, port mapping)
3. For verbose output: `ssh -v abc@<host> -p <port>`

### Idle Timeout

The remote environment can set `HAVEN_IDLE_TIMEOUT` to auto-disconnect after inactivity:

```bash
# In EnvHaven container
export HAVEN_IDLE_TIMEOUT=30m  # 30 minutes
export HAVEN_IDLE_TIMEOUT=2h   # 2 hours
export HAVEN_IDLE_TIMEOUT=0    # Disabled
```

Override per-session:

```bash
haven connect . --idle-timeout 4h
```

## Development

### Install from Source

```bash
./install-local.sh
```

Requires [Bun](https://bun.sh). Builds and installs to `~/.local/bin/haven`.

### Dev Commands

```bash
bun install              # Install dependencies
bun run dev connect .    # Run in development
bun test                 # Run tests
bun run build            # Build for current platform
bun run build -- --all   # Build for all platforms
```

## License

MIT

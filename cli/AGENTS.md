# Haven CLI Development

This is the Haven CLI - a tool for syncing local directories with remote EnvHaven containers.

## Tech Stack

| Component | Choice |
|-----------|--------|
| Runtime | Bun |
| Language | TypeScript |
| CLI Framework | Commander.js |
| Sync Engine | Mutagen (downloaded at runtime) |
| SSH | System `ssh` (uses user's existing keys) |

## Project Structure

```
cli/
├── src/
│   ├── index.ts              # Entry point, CLI setup
│   ├── commands/
│   │   ├── connect.ts        # haven connect [path] [target]
│   │   ├── disconnect.ts     # haven disconnect
│   │   └── status.ts         # haven status
│   ├── remote/
│   │   ├── exec.ts           # Remote command execution
│   │   └── quote.ts          # POSIX shell quoting
│   ├── sync/
│   │   ├── mutagen.ts        # Mutagen lifecycle
│   │   ├── download.ts       # Mutagen download/extraction
│   │   └── ignore.ts         # Ignore pattern handling
│   ├── ssh/
│   │   ├── config.ts         # SSH config generation
│   │   └── keys.ts           # SSH key discovery + encryption detection
│   ├── config/
│   │   └── store.ts          # Connection config storage
│   └── utils/
│       ├── paths.ts          # Path utilities
│       ├── duration.ts       # Duration parsing
│       └── spinner.ts        # CLI output helpers
├── scripts/
│   ├── build.ts              # Build script
│   └── bundle-mutagen.ts     # Mutagen bundling
├── test/                     # Unit tests
└── install.sh                # curl | sh installer
```

## Key Concepts

### Reserved Commands

Only 3 commands are handled by the CLI:
- `haven connect [path] [target]` - Connect with optional inline target
- `haven disconnect`
- `haven status`

Everything else is passed through to the remote: `haven opencode` → `ssh remote opencode`

### Inline Connection Target

The CLI supports connecting without prompts:
```bash
# Managed workspace (shorthand)
haven connect . myproject-alice

# Self-hosted
haven connect . abc@myserver.com:2222
```

Target formats:
- Shorthand: `myproject-alice` → expands to `ssh-myproject-alice.envhaven.app`
- Full hostname: `ssh-myproject-alice.envhaven.app` (used as-is)
- Self-hosted: `user@host` or `user@host:port`

### Connection Config

Stored in `~/.config/haven/connections.json`:

```json
{
  "/Users/you/projects/myapp": {
    "host": "workspace.envhaven.app",
    "port": 2222,
    "user": "abc",
    "remotePath": "/config/workspace/myapp",
    "sshAlias": "haven-abc123"
  }
}
```

### SSH Key Handling

The CLI uses the user's existing SSH keys from `~/.ssh/`:
- Looks for: `id_ed25519`, `id_rsa`, `id_ecdsa`, `haven_ed25519`
- All found keys are added to the SSH config
- SSH tries each key until authentication succeeds

#### Why BatchMode Matters

The CLI uses `ssh -o BatchMode=yes` for connection testing and `mutagen` for file sync. BatchMode disables interactive prompts, which means:
- Passphrase-protected keys **cannot** prompt for passphrase
- SSH silently skips keys it can't use
- Keys must either be passphrase-less OR loaded in ssh-agent

#### The Haven Key (Golden Path)

When no SSH keys exist, Haven generates `~/.ssh/haven_ed25519`:
- Ed25519 key (modern, secure, compact)
- No passphrase (works without ssh-agent)
- Comment: `haven-cli`

This is the simplest path — one-time setup, zero ongoing maintenance.

#### Proactive Key Encryption Detection

The CLI detects encrypted (passphrase-protected) keys **before** attempting connection. This avoids confusing failures from BatchMode's inability to prompt for passphrases.

**Detection method:** `ssh-keygen -y -P "" -f <keyfile>` — exits non-zero if key is encrypted.

**Agent check:** `ssh-add -l` returns fingerprints of keys loaded in ssh-agent.

A key is **usable** if: `!encrypted || inAgent`

#### User Scenarios and Handling

| Scenario | Detection | Action |
|----------|-----------|--------|
| **No keys exist** | `keys.length === 0` | Auto-generate haven key, show public key |
| **Haven key exists** | `hasHavenKey()` | Proceed (always usable, no passphrase) |
| **Unencrypted key exists** | `!encrypted` | Proceed |
| **Encrypted key in agent** | `encrypted && inAgent` | Proceed |
| **Encrypted key, no agent** | `encrypted && !inAgent` | Proactive prompt (see below) |
| **Mixed keys (some usable)** | `any(usable)` | Proceed |

#### Key Usability Flow (Proactive)

```
                                ┌─────────────────────────────────────────┐
                                │                 START                   │
                                └─────────────────────────────────────────┘
                                                    │
                                                    ▼
                                ┌─────────────────────────────────────────┐
                                │           findExistingKeys()            │
                                └─────────────────────────────────────────┘
                                                    │
                        ┌───────────────────────────┼───────────────────────────┐
                        │                           │                           │
                        ▼                           ▼                           ▼
                ┌───────────────┐         ┌─────────────────┐         ┌─────────────────┐
                │   NO_KEYS     │         │ HAVEN_KEY_EXISTS│         │  OTHER_KEYS     │
                └───────────────┘         └─────────────────┘         └─────────────────┘
                        │                           │                           │
                        │                           │                           ▼
                        │                           │         ┌─────────────────────────────┐
                        │                           │         │     analyzeKeys()           │
                        │                           │         │ For each: encrypted? agent? │
                        │                           │         └─────────────────────────────┘
                        │                           │                           │
                        │                           │                ┌──────────┴──────────┐
                        │                           │                │                     │
                        │                           │                ▼                     ▼
                        │                           │      ┌─────────────────┐   ┌─────────────────┐
                        │                           │      │  USABLE_EXISTS  │   │  NO_USABLE      │
                        │                           │      │ ≥1 key works    │   │ All encrypted,  │
                        │                           │      └─────────────────┘   │ none in agent   │
                        │                           │                │           └─────────────────┘
                        ▼                           ▼                ▼                     │
                ┌───────────────┐         ┌─────────────────────────────┐                  │
                │  GENERATE     │         │        PROCEED              │                  │
                │ Auto-generate │         │ → testConnection()          │                  │
                │ haven key     │         │ → startSync()               │                  │
                └───────────────┘         └─────────────────────────────┘                  │
                        │                           ▲                                      │
                        │                           │                                      ▼
                        └───────────────────────────┤                          ┌───────────────────┐
                                                    │                          │      PROMPT       │
                                                    │                          │ [1] Generate key  │
                                                    │                          │ [2] ssh-add first │
                                                    │                          └───────────────────┘
                                                    │                                      │
                                                    │               ┌──────────────────────┴──────────────────────┐
                                                    │               │                                             │
                                                    │               ▼                                             ▼
                                                    │     ┌─────────────────┐                           ┌─────────────────┐
                                                    │     │ USER_CHOSE_GEN  │                           │ USER_CHOSE_AGENT│
                                                    │     │ Generate key    │                           │ Exit with       │
                                                    │     └─────────────────┘                           │ instructions    │
                                                    │               │                                   └─────────────────┘
                                                    └───────────────┘                                             │
                                                                                                                  ▼
                                                                                                        ┌─────────────────┐
                                                                                                        │    EXIT(1)      │
                                                                                                        └─────────────────┘
```

#### Connection Failure Flow (Post-Connection)

After key usability is confirmed, connection failures are simpler to diagnose:

```
┌─────────────────────────────────────────────────────────────┐
│ Connection failed (key usability already verified)          │
├─────────────────────────────────────────────────────────────┤
│ "Host key verification failed"?                             │
│   → Suggest: haven connect --reset-host-key                 │
├─────────────────────────────────────────────────────────────┤
│ Otherwise:                                                  │
│   → Show haven public key (if exists) for user to add       │
│   → List possible causes: workspace stopped, firewall, etc. │
└─────────────────────────────────────────────────────────────┘
```

#### Why Haven Key is the Default Recommendation

| Aspect | Haven Key | ssh-agent |
|--------|-----------|-----------|
| Works if key not authorized | ✅ Yes | ❌ No |
| Works with passphrase keys | ✅ Yes (no passphrase) | ✅ Yes (if loaded) |
| Ongoing maintenance | None | Run `ssh-add` each session* |
| Setup cost | One-time: add to workspace | None (if already authorized) |

*Unless using macOS Keychain or persistent agent.

The haven key is a one-time setup that works in all scenarios. Users who prefer their existing keys can choose ssh-agent.

#### ssh-agent Quick Reference

For users who want to use their existing passphrase-protected keys:

```bash
# Start agent and add key (persists for current session)
eval "$(ssh-agent -s)"
ssh-add

# Verify key is loaded
ssh-add -l

# Then retry
haven connect
```

On macOS, keys can be stored in Keychain for persistence:
```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

#### GitHub OAuth Users

Users who log in via GitHub OAuth have their SSH keys automatically imported to the workspace. If their key is:
- **Passphrase-less**: Just works
- **Passphrase-protected**: Need ssh-agent with key loaded

The haven key option still works — it just means having two authorized keys on the workspace.

### SSH Configuration

Haven generates `~/.ssh/config.d/haven.conf` per connection alias:

```
Host haven-abc123
  HostName myserver.com
  Port 2222
  User abc
  IdentityFile ~/.ssh/id_ed25519
  IdentityFile ~/.ssh/id_rsa
  ForwardAgent no
  ForwardX11 no
  StrictHostKeyChecking accept-new
  ServerAliveInterval 5
  ServerAliveCountMax 3
```

**Requirements:**
- Add `Include ~/.ssh/config.d/*` to the TOP of `~/.ssh/config`

### Mutagen Sync

- Downloaded from GitHub releases on first use
- Runs in background as sync daemon
- Data stored in `~/.local/share/haven/mutagen/`
- Uses Mutagen 0.17.x (latest stable)

**API Note:** Mutagen 0.17.x uses `--template` for structured output, not `--json`. The CLI uses Go template syntax to parse session data:
```bash
mutagen sync list --template '{{range .}}{{.Name}}|{{.Status.Description}}{{"\n"}}{{end}}'
```

## Development Commands

```bash
bun install          # Install deps
bun run dev          # Run in dev mode
bun test             # Run tests
bun run typecheck    # Type check
bun run build        # Build binary
```

## Testing

### Unit Tests

Tests use Bun's built-in test runner:

```bash
bun test                    # All tests
bun test test/utils/        # Specific directory
bun test --watch            # Watch mode
```

### Integration Testing

For testing against a real EnvHaven container, use the dev CLI or test script:

```bash
# Via dev TUI
cd /path/to/envhaven/dev && bun run setup   # One-time: install, build, link
eh   # Press 't' → 'c' (Test Haven CLI)

# Or run the script directly
bun dev/scripts/test-cli.ts --ci     # Non-interactive (for CI)
bun dev/scripts/test-cli.ts          # Interactive test flow
```

## Building

```bash
# Current platform only
bun run build

# All platforms (darwin/linux, x64/arm64)
bun run build -- --all
```

Outputs to `dist/`:
- `haven-darwin-arm64`
- `haven-darwin-x64`
- `haven-linux-x64`
- `haven-linux-arm64`

## Distribution

The CLI has two distribution channels:

### 1. Versioned Releases (Public)

When a git tag `v*` is pushed:
- `build-cli` job builds all platform binaries
- Binaries are uploaded to GitHub releases
- Users install via: `curl -fsSL https://raw.githubusercontent.com/envhaven/envhaven/master/cli/install.sh | sh`

This path only works when the repo is public.

### 2. Evergreen Beta (Private/Beta)

On every push to master that changes `cli/`:
- `build-cli-latest` job builds all platform binaries
- Binaries are uploaded as workflow artifact `haven-cli-latest`
- Platform (`envhaven/platform`) proxies downloads with beta token verification
- Users install via: `curl -fsSL "https://envhaven.com/install.sh?beta=TOKEN" | sh`

**Key differences:**

| Aspect | Versioned | Evergreen |
|--------|-----------|-----------|
| Trigger | Git tag `v*` | Push to master (cli/ changed) |
| Storage | GitHub releases | Workflow artifacts (90-day retention) |
| Auth required | No (when public) | Yes (beta token) |
| Version | Explicit (v0.1.0) | Always latest |
| Use case | Production users | Beta testers, internal testing |

**Evergreen is useful for:**
- Testing CLI changes before cutting a release
- Beta testers who want the latest features
- Internal team always on latest

The install script at `envhaven.com/install.sh` auto-adds `~/.local/bin` to the user's PATH by modifying their shell rc file (.zshrc, .bashrc, etc.).

## Common Issues

### SSH Connection Fails with "Permission denied"

The CLI will guide you through this, but the causes are:

1. **Key not authorized on workspace**: Your public key isn't in the workspace's `authorized_keys`
   - Solution: Generate haven key (CLI offers this) or add your key via EnvHaven extension

2. **Passphrase-protected key without agent**: BatchMode can't prompt for passphrases
   - Solution: `eval "$(ssh-agent -s)" && ssh-add` then retry
   - Or generate a haven key (no passphrase)

3. **Wrong permissions on remote**: The container's `.ssh` directory must be `700` and `authorized_keys` must be `600`

### SSH Works Manually But CLI Fails

The CLI uses BatchMode for non-interactive operation. Test with:
```bash
ssh -o BatchMode=yes -p <port> <user>@<host> "echo ok"
```

If this fails but regular SSH works, you have a passphrase-protected key without ssh-agent.

### "Host key verification failed"

The workspace was rebuilt and has a new host key. Run:
```bash
haven connect --reset-host-key
```

### SSH Authenticates But Commands Exit with Code 1

If SSH debug shows "Authenticated using publickey" but commands return exit code 1 with empty output, the remote user's login shell is likely set to `/bin/false` or `/usr/sbin/nologin`.

**Diagnosis:**
```bash
# Check the user's shell on the remote
docker exec <container> getent passwd abc | cut -d: -f7
```

If it shows `/bin/false`, SSH will authenticate successfully but immediately exit because there's no valid shell to run commands.

**Fix:** The `init-user-config` script in EnvHaven automatically detects and fixes this by setting zsh (or bash) as the login shell. If you encounter this in a fresh container, restart it or manually run:
```bash
docker exec <container> chsh -s /bin/zsh abc
```

### FUSE Filesystem Issues

On FUSE-backed home directories (like Unraid's shfs), SSH ControlMaster sockets may not work correctly. The CLI will still function but without connection multiplexing.

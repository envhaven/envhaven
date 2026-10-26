# Haven CLI

Local editor + remote AI coding environment.

Haven CLI enables you to use your local editor (Vim, VS Code, Zed, or anything else) while AI tools (Claude Code, OpenCode, Codex) run extended sessions on remote EnvHaven containers.

## Installation

### macOS / Linux

```bash
curl -fsSL https://envhaven.com/install.sh | bash
```

### Windows

Haven CLI requires WSL (Windows Subsystem for Linux):

```bash
# In WSL terminal
curl -fsSL https://envhaven.com/install.sh | bash
```

The installer downloads the binary for your platform and the release's `SHA256SUMS`, and installs
nothing unless the binary's SHA-256 is listed there. It writes to `~/.haven/bin` and adds that
directory to your shell profile's `PATH`.

### Manual Installation

```bash
# Pick one: haven-darwin-arm64, haven-darwin-x64, haven-linux-x64, haven-linux-arm64
BINARY=haven-linux-x64

curl -fsSLO https://github.com/envhaven/envhaven/releases/latest/download/$BINARY
curl -fsSLO https://github.com/envhaven/envhaven/releases/latest/download/SHA256SUMS

# Must print "<binary>: OK" (on macOS: shasum -a 256 -c --ignore-missing SHA256SUMS)
sha256sum -c --ignore-missing SHA256SUMS

chmod +x $BINARY
mv $BINARY ~/.local/bin/haven
```

### Verifying Provenance

Every release binary carries a signed build provenance attestation that ties it to the GitHub
Actions run and commit that built it. With the [GitHub CLI](https://cli.github.com):

```bash
gh attestation verify haven-linux-x64 --repo envhaven/envhaven
```

A checksum proves the download matches what the release lists; the attestation also proves the
release's binary came out of this repository's workflow.

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
haven codex

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

# Proactively clear cached host key (usually not needed - Haven auto-detects)
haven connect --reset-host-key

# Override idle timeout
haven connect --idle-timeout 4h

# Automatically use .gitignore patterns for sync exclusion
haven connect . --use-gitignore

# Sync .env, .env.* and .npmrc files too (or keep them local); remembered for this directory
haven connect --sync-env-files
haven connect --no-sync-env-files
```

The first connection to a workspace shows its SSH host key fingerprint and asks before trusting
it (see [Host Keys](#host-keys)).

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

### `haven disconnect [path]`

Stop sync and disconnect from remote workspace. Defaults to the current directory.

```bash
haven disconnect
haven disconnect ~/code/myproject
```

### `haven status [path]`

Show connection and sync status. Defaults to the current directory.

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
haven codex "fix the test"  # Run Codex with args
haven npm install        # Run npm
haven git push          # Run git
```

Commands inherit stdin/stdout for interactive use, and haven exits with the remote command's
exit code, as `ssh host cmd` does, so `haven npm test && git push` works. That also means the
workspace decides success or failure for any script that wraps haven.

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

## Sync Behavior

- **Continuous bidirectional sync** - Changes sync in ~200ms
- **Conflict detection** - If both sides modify the same file, a `.sync-conflict` file is created
- **Ignored paths** - Common build artifacts are automatically ignored (node_modules, .git, dist, etc.)

### Files That Never Sync

The workspace runs AI agents with permission prompts off, and they can read anything synced to it.
Private keys and credential stores therefore never sync, in either direction, at any depth in the
project:

- SSH private keys: `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` and their `_sk` variants
- Key and certificate files: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk`
- Credential directories and files: `.ssh/`, `.aws/`, `.gnupg/`, `.netrc`, `.pgpass`,
  `.git-credentials`, `.pypirc`
- Any other file that holds a private key, under a name the rules above miss (`deploy_key`,
  `id_ed25519_work`, `deploy_key.txt`): `haven connect` reads the header of every small regular
  file, whatever its extension, and excludes those that start like a private key. This check runs
  when you connect, so a key file created during a session under such a name syncs to the workspace
  until the next connect, which excludes it and says the workspace still has it. It skips folders
  the effective `.gitignore` rules exclude (they do not sync anyway) and looks at up to 100,000
  files and folders; past that it says so, and only the name rules apply.

The names match in any letter case (`server.KEY`, `Client.PEM`). These rules come after your
`.gitignore` lines, so a `!` line there cannot re-include them. Each connect lists the files they
exclude:

```
⚠ Not syncing 2 files that look like keys or credentials:
    certs/ca.pem
    deploy/github_key (holds a private key)
  Haven does not sync them. If the workspace needs one, copy it there yourself (scp).
```

A public certificate the workspace needs (a CA bundle named `*.pem`, say) has to be copied over
that way.

Versions of Haven before these rules synced everything, and a file can also sync before it is
excluded: a `.env` you later chose not to sync, or a key like the one above. When a connect
starts the directory's sync session with rules that exclude such a file (the first connect after
updating Haven, or one that changes what is excluded, even after `haven disconnect`), and the
workspace still has it, Haven lists it:

```
⚠ These files are on the workspace and are not synced from now on:
    .env
  If Haven copied them there earlier, you may want to delete them on the workspace. Deleting
  them there also deletes them from any other folder or machine that syncs the same workspace
  folder.
```

Only files the previous session's own rules let sync are listed, and a directory's first connect
lists nothing: the workspace may have made such a file itself, or another folder may sync it there.
Haven deletes nothing and suggests no command for it.

Haven takes the previous rules from the session itself while it still exists, running or paused,
or else from what the last connect recorded. Versions before this one recorded nothing, so if you
ran `haven disconnect` with one of them before updating, there is nothing to compare against and
nothing is listed. In that case, check the workspace yourself for keys and `.env` files the older
version may have copied there.

### .env and .npmrc Files

`.env`, `.env.*` (`.env.local`, `.env.development` and the like) and `.npmrc` often hold API keys
and tokens, and a project often needs them on the workspace as well. The first `haven connect` in
a directory asks whether to sync them, and the answer is remembered for that directory. The
default is no. When there is no input to answer from (a script, CI), the default applies to that
connect only and the question comes back on the next one. Templates (`.env.example`,
`.env.sample`, `.env.template`) always sync. A yes holds
even when your `.gitignore` lists `.env` and you exclude `.gitignore` matches from sync. Folders
named `.env` or `.env.*` (a Python virtualenv, usually) never sync.

```bash
haven connect --sync-env-files      # sync them from now on
haven connect --no-sync-env-files   # keep them on this machine from now on
```

### Gitignore Integration

When connecting a directory with a `.gitignore` file, Haven prompts:

```
Found .gitignore. Exclude matching files from sync? [Y/n]
```

This adds your gitignore patterns to the sync exclusion list, preventing large ignored directories (like `data/`, custom caches, etc.) from syncing.

**To skip the prompt:**
```bash
haven connect . --use-gitignore    # Always use .gitignore patterns
haven connect .                     # Prompts if .gitignore exists
```

Sync is two-way, so the workspace can edit `.gitignore` too, and with it what syncs. Haven
remembers the lines it last applied; when the file has changed or been deleted by the next
connect, it shows the added and removed lines and applies them only if you confirm (the default
keeps the previous rules). Before Haven has applied any version of the file, it lists the `!`
lines, which re-include files, ahead of the question, and the default is then no, with
`--use-gitignore` too. `.git` and the other version control folders never sync, whatever
`.gitignore` says, and neither does a `.git` file (a submodule's or a worktree's, which tells git
where its folder is).

### What Two-Way Sync Trusts

Everything the workspace writes inside the synced directory lands on your disk: source files, and
also `package.json` scripts, `Makefile`, `.envrc`, `pyproject.toml` and anything else your tools
run or read. Sync stays inside the directory you connected, but a workspace that is compromised
(or an agent on it that was talked into something) can change what runs the next time you build,
install or open a shell there. Treat changes that arrive from the workspace the way you would
treat a collaborator's commits: review build and config files before running them, particularly
after a long unattended agent session. Mutagen syncs symlinks as symlinks, so a link the workspace
creates can point outside the directory; tools that follow links will follow it.

### Path Safety

Haven warns before syncing unusually broad directories:

```
⚠ "~" is unusually broad for a project directory.
Are you sure you want to sync this path? [y/N]
```

**Flagged paths include:**
- System directories: `/`, `~`, `/etc`, `/var`, `/usr`, `/tmp`
- Common home folders: `~/Documents`, `~/Downloads`, `~/Desktop`
- Build/dependency directories: `node_modules`, `.git`, `dist`, `build`, `venv`

This prevents accidentally syncing your entire home directory or massive dependency folders. The
check resolves symlinks first (a link to `~` named like a project is still `~`), and it runs on
every connect, including a reconnect of a directory connected before. Answering no ends
`haven connect` with a non-zero exit code.

## Configuration

### File Locations

```
~/.config/haven/connections.json   # Connection mappings (private, 0600)
~/.config/haven/sessions/          # Session state, one file per local directory (hashed canonical path)
~/.local/share/haven/mutagen/      # Mutagen data
~/.ssh/haven/config                 # SSH host entries, one per workspace
~/.ssh/haven/agent-*.pub            # Public halves of agent-only keys a workspace uses
~/.ssh/config                       # Gets one line: Include ~/.ssh/haven/config
~/.ssh/known_hosts                  # Workspace host keys you confirmed
```

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` are honoured and take precedence over the two defaults
above.

Mutagen is downloaded on first use from mutagen-io's GitHub release. The CLI pins the SHA-256 of
each release archive and of the files inside it, refuses a download that does not match, and
checks the installed binary against the pinned hash before each use.

### SSH Keys

Haven CLI dynamically discovers SSH keys in `~/.ssh/`:
- Scans for all `.pub` files where a matching private key exists
- Validates each key with `ssh-keygen -lf` (filters invalid files)
- Includes auto-generated `haven_ed25519` if created
- Includes keys that live only in an agent (1Password, Secretive, hardware keys), read from the
  agent your ssh config names with `IdentityAgent`, or `SSH_AUTH_SOCK` when it names none

On connect, Haven offers them in that order (the Haven key first, then your usable key files, then
agent-only keys, then passphrase-protected files, which macOS can unlock from the Keychain), up to
five per connection so that a server which bans an address after a few refused logins does not
lock you out, and records the one the workspace accepts. The SSH config then offers only that key
(`IdentitiesOnly yes`), plus any key your own ssh config adds for every host (an `IdentityFile`
under `Host *`), which ssh adds to every host's list. Later connects try the recorded key first.
An agent-only key is named by its public half, saved under `~/.ssh/haven/`; ssh signs with the
matching key in the agent.

If no key is accepted on its own, Haven tries once more with ssh's own key selection, the way
versions before IdentitiesOnly worked, and says so; that workspace is then offered every key ssh
would offer until a single key works.

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

**Option 1 (Haven key)**, simplest with zero ongoing maintenance:
- Generates `~/.ssh/haven_ed25519` with no passphrase
- Shows the public key to add to your workspace
- One-time setup, works forever

**Option 2 (ssh-agent)**, for users who prefer their existing keys:
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
| "The host key has changed" | Workspace rebuilt or updated, or an intercepted connection | Check the fingerprint in the workspace terminal, then confirm |
| "Permission denied" | Key not authorized | Add public key to workspace |
| Timeout | Workspace stopped or firewall | Check workspace status |

The haven key is always the simplest fix: one-time setup, no ongoing maintenance.

### SSH Configuration

Each connected workspace gets a `Host` entry (e.g., `haven-3f2a9c0d1b4e5a67`) in
`~/.ssh/haven/config`, and `~/.ssh/config` gets a single `Include ~/.ssh/haven/config` line at
its top. Ssh uses the first value it finds for each setting, so the include comes first: a general
`Host *` block of yours (`ForwardAgent yes`, say) does not apply to workspaces. If you manage
`~/.ssh/config` yourself, keep that line before your own `Host` and `Match` blocks. Older
versions appended entries to the end of `~/.ssh/config`; the next connect of each directory
moves its entry.

### Host Keys

The first connection to a workspace shows the fingerprint of its SSH host key and asks before
trusting it:

```
⚠ First connection to ssh-myproject-alice.envhaven.app
  Host key: ED25519 SHA256:4Zq0...
  To check that this is your workspace, open its terminal in the browser, run the
  command below and compare the fingerprint it prints:
    ssh-keyscan -t ed25519 localhost 2>/dev/null | ssh-keygen -lf -
Trust this host and connect? [y/N]
```

A confirmed key goes into `~/.ssh/known_hosts`, and the SSH config uses
`StrictHostKeyChecking yes`, so neither ssh nor the sync ever accepts a different key on its own.
Nothing authenticates or syncs before the key is trusted. The key is read through ssh itself, so
a `ProxyJump` or `ProxyCommand` in your ssh config applies to it as to every other connection, as
long as it is set under `Host *`, `Host haven-*` or `Match host <workspace host>`. One set under a
single workspace's alias (`Host haven-1a85...`) is not used for this check, which runs under an
alias of its own; when that is why a connect fails, Haven says so. To script a first connect, add the workspace's key to
`~/.ssh/known_hosts` yourself after checking it; Haven then connects without asking. A
workspace you trust through a `@cert-authority` line or the system-wide known_hosts file is asked
about once, since Haven compares the key with the lines in `~/.ssh/known_hosts`; the key you
confirm is then kept there.

### Authorizing Keys on the Workspace

For the EnvHaven container to accept your SSH connections, your public key must be in the workspace's `authorized_keys`. Add keys via the **workspace IDE** (code-server), not the web dashboard:

1. Open your workspace in a browser (e.g., `https://myproject-alice.envhaven.app`)
2. In the VS Code sidebar, click the EnvHaven icon
3. Expand "Remote Access"
4. Either enter your GitHub username to import keys, or paste your public key directly

**Alternative methods:**

- **GitHub OAuth:** If you logged in via GitHub, your keys are auto-imported
- **docker-compose:** Set `PUBLIC_KEY_URL=https://github.com/<your-github-username>.keys`

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

#### "The host key has changed"

A workspace presents a new host key after it is rebuilt, and once after the update that gave each
workspace a host key of its own. Haven shows the key it trusted before and the one presented now:

```
⚠ The host key for ssh-myproject-alice.envhaven.app has changed
  Trusted until now: ED25519 SHA256:old...
  Presented now:     ED25519 SHA256:new...
Trust the new key and connect? [y/N]
```

The default is no: a changed key is also exactly what an intercepted connection looks like. Run
the `ssh-keyscan ... | ssh-keygen -lf -` command it prints in the workspace's own terminal (open
the workspace in your browser), and answer `y` only if the fingerprints match. Answering no
leaves everything as it was; run `haven connect` again once you have checked.

**Proactive reset** (forget the trusted key; the next connect asks as on a first connection):
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

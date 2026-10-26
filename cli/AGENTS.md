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
│   │   ├── config.ts         # SSH config generation (~/.ssh/haven/config + Include line)
│   │   ├── hostkeys.ts       # Host key scan, fingerprints, known_hosts trust
│   │   └── keys.ts           # SSH key discovery + encryption detection + identity candidates
│   ├── config/
│   │   └── store.ts          # Connection config storage + input validation
│   └── utils/
│       ├── paths.ts          # Path utilities
│       ├── duration.ts       # Duration parsing
│       ├── files.ts          # Atomic file writes
│       ├── guards.ts         # Path-safety guards (broad-directory detection)
│       ├── prompt.ts         # Questions on stdin (one reader per process)
│       ├── spinner.ts        # CLI output helpers
│       └── terminal.ts       # Strips terminal control sequences from remote text
├── scripts/
│   ├── build.ts              # Build script
│   └── bundle-mutagen.ts     # Mutagen bundling
├── test/                     # Unit tests
├── install.sh                # curl | bash installer
└── install-local.sh          # Local build + install
```

## Key Concepts

### Reserved Commands

Only 3 commands are handled by the CLI:
- `haven connect [path] [target]` - Connect with optional inline target
- `haven disconnect [path]`
- `haven status [path]`

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

Stored in `~/.config/haven/connections.json` (`XDG_CONFIG_HOME` wins if set; per-connection session
state lives beside it in `sessions/<hash>.json`, and the mutagen data dir honours `XDG_DATA_HOME`):

```json
{
  "/Users/you/projects/myapp": {
    "host": "workspace.envhaven.app",
    "port": 2222,
    "user": "abc",
    "remotePath": "/config/workspace/myapp",
    "sshAlias": "haven-3f2a9c0d1b4e5a67",
    "sessionId": "9c41d0b7e2a85f13",
    "identityFile": "/Users/you/.ssh/id_ed25519",
    "syncEnvFiles": false,
    "gitignorePatterns": ["data/", "*.sqlite"]
  }
}
```

The file is written 0600 (directory 0700) by an atomic rename, and every entry is validated on load
and on save: an entry with a malformed host, user, port or remote path is ignored with a warning,
and written back unchanged by the next save (an older version may have accepted it, and its sync
session can still be running), and a malformed optional field (alias, session id, key path,
`.gitignore` lines, the session's ignore patterns) is dropped on its own, with a warning, so
nothing invalid reaches `ssh` or `~/.ssh/config` and one bad value does not lose a connection
whose sync is still running.
`sshAlias` and `sessionId` are the first 16 hex digits of SHA-256 (of `user@host:port` and of the
canonical local path). Entries written before that change carry a short base36 alias and no
`sessionId`; they keep working, and their next `haven connect` ends the old mutagen session,
removes the old Host entry once no other directory uses it, and records the new ids. `identityFile`
is the key that authenticated last time, `syncEnvFiles` the remembered `.env`/`.npmrc` answer,
`gitignorePatterns` the `.gitignore` lines last accepted as sync ignores (neither is recorded from
a default taken because input ended), `syncIgnores` every ignore pattern of the sync session the
last connect started (see the Mutagen Sync bullet on files a replaced session synced), and
`retiredSessionId` the old session a move to the new ids paused, until terminating it succeeds.

### SSH Key Handling

The CLI dynamically discovers SSH keys in `~/.ssh/`:
- Scans for all `.pub` files where matching private key exists
- Validates each public key using `ssh-keygen -lf` (filters invalid files)
- Asks the agent ssh will really use for the alias: `identityAgentSocket()` reads the
  `identityagent` line of `ssh -G <alias>` (1Password and Secretive set `IdentityAgent` under
  `Host *` and leave `SSH_AUTH_SOCK` alone), falling back to `SSH_AUTH_SOCK`
- Adds keys that exist only in that agent (`ssh-add -L`), saving each public half as
  `~/.ssh/haven/agent-<hash>.pub` so the config can name it
- `identityCandidates()` orders them: Haven key, usable key files by name, agent-only keys, and
  last the passphrase-protected files the agent does not hold (macOS can still unlock those from
  the Keychain with `UseKeychain`)
- `haven connect` offers them up to five per connection (`KEYS_PER_CONNECTION`), reads the key the
  server accepted from `ssh -v` (`Server accepts key: <path> ...`) and records it
  (`identityFile`); the Host entry then names that key alone, with `IdentitiesOnly yes`. A
  connection per key, as first written, piled up refused logins that OpenSSH 9.8+ answers by
  refusing the address (`PerSourcePenalties`: three in quick succession), which locked out users
  with a few keys partway through
- If every one is refused on its own, a last try writes the block the way versions before
  IdentitiesOnly did (every key file, no `IdentitiesOnly`) so whatever ssh would have found still
  works; the CLI says so, records no `identityFile`, and probes again on the next connect
- For later: on an OpenSSH 9.8+ server, `PerSourcePenalties` (`authfail:5`, enforced from
  `min:15`) turns three refused connections into a refused address. A user with eleven or more key
  files (three groups), none accepted on its own, therefore has the fallback refused as well, and
  their other connections to that workspace wait out the penalty. The workspace sshd is 9.6p1, so
  this matters only once the image moves to 9.8 or later

Offering every key in `~/.ssh` handed each workspace the fingerprints of all of them (a way to
track a user across services) and spent its `MaxAuthTries`. Workspaces usually authorize the
user's GitHub keys rather than a Haven key, which is why the working key is found by trying.
Keys a user's own config adds for every host (`IdentityFile` under `Host *`) are still offered:
ssh adds them to any host's list, IdentitiesOnly or not.

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

This is the simplest path: one-time setup, zero ongoing maintenance.

#### Proactive Key Encryption Detection

The CLI detects encrypted (passphrase-protected) keys **before** attempting connection. This avoids confusing failures from BatchMode's inability to prompt for passphrases.

**Detection method:** `ssh-keygen -y -P "" -f <keyfile>`, which exits non-zero if the key is encrypted.

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

#### Host Key Check (Before Any Login)

`PROCEED` above starts with `ensureHostKeyTrusted()` (`ssh/hostkeys.ts` for the mechanics), run
under the probe alias (see the probe alias bullet under Mutagen Sync). `checkHostKey()` runs
`ssh` with that alias and `PreferredAuthentications=none`, so the user's ProxyJump or
ProxyCommand applies (ssh-keyscan, used before, connects directly and failed for everyone behind
a bastion) and no key is offered to a server that is not trusted yet. ssh records the presented
key into a throwaway known_hosts (`accept-new`), and `ssh-keygen -F` reads what
`~/.ssh/known_hosts` holds under the name ssh itself uses (`knownHostsName()`, from `ssh -G` on
the probe alias: the HostKeyAlias if one is set, otherwise the host name, bracketed with a port
other than 22). The key is trusted when it is one of those, and only then: nothing ssh prints
decides it.

```
┌─────────────────────────────────────────────────────────────┐
│ presented key is in known_hosts → proceed silently          │
├─────────────────────────────────────────────────────────────┤
│ known_hosts has nothing for this host → FIRST CONNECT       │
│   Show the presented key's fingerprint and the command that │
│   prints the real one inside the workspace; [y/N]           │
├─────────────────────────────────────────────────────────────┤
│ known_hosts has other keys → CHANGED                        │
│   Show old and new fingerprints, explain the one-time       │
│   change per-workspace host keys cause; [y/N]               │
├─────────────────────────────────────────────────────────────┤
│ yes → ssh-keygen -R, append the line ssh recorded           │
│ no / end of input → exit 1, nothing authenticated or synced │
└─────────────────────────────────────────────────────────────┘
```

Only the key that was shown is pinned: it is the one ssh negotiates, and pinning a type the user
did not see would let a man in the middle answer for it. The Host entry is
`StrictHostKeyChecking yes`, so ssh and mutagen fail rather than accept a different key, and
`accept-new` is gone. It is also `CheckHostIP no`: with it on (the default before OpenSSH 8.5)
ssh files the key under the address as well, and the address's stale line failed every connect
after a trusted key change.

Reading the verdict from ssh's output, as an earlier version of this check did, let a server pose
as a trusted one: before sending any key it can send a disconnect message, which ssh prints with
its newlines kept, so the text can carry a line identical to ssh's own refusal. Only a key in the
throwaway file counts now. ssh writes it there once the server has sent its key in the key
exchange, before checking the signature made with it, so a server can send a key it does not
hold. Nothing is lost by that, because every later connection is ssh's own with
`StrictHostKeyChecking yes` and fails on that signature.

Details of the capture:

- The name comes from `ssh -G` because ssh files keys under the host name in lower case and a
  hashed line matches only that exact string: a workspace typed as `Localhost`, looked up as
  typed, was never found under the hashing Debian, Ubuntu and WSL turn on, and every connect asked
  again. HostKeyAlias and CanonicalizeHostname line up the same way.
- The server is first asked only for the key types known_hosts holds for it
  (`hostKeyAlgorithms()`), so a workspace trusted by its RSA key is not reported changed because a
  fresh connection would pick ed25519. They are asked for in ssh's own order, its
  HostKeyAlgorithms from `ssh -G` (ed25519 first since OpenSSH 8.5, ECDSA first before), which is
  how ssh orders the known types too: in known_hosts order, a stale RSA line listed above the
  current ed25519 one was asked for first and read as a change that `ssh -v` calls "known and
  matches". Only "no matching host key type" brings a second try without that limit.
- `ControlPath=none`: a connection shared through a master (a user's `ControlMaster auto`, kept
  open by sync) has no key exchange, so nothing would be recorded and every reconnect would look
  unreachable. testConnection passes it too, so a key really logs in.
- `VerifyHostKeyDNS=no`, `GlobalKnownHostsFile=/dev/null`: either would let ssh accept the key
  without recording it.
- `LogLevel=ERROR` (testConnection passes it or `-v`) keeps a user's `LogLevel QUIET` from hiding
  why a connection failed; a command-line option outranks the config.
- A host trusted only through `@cert-authority` or the system-wide known_hosts has no line in
  `~/.ssh/known_hosts` to compare with, so it is asked about once, as a first connection, and the
  confirmed key is pinned there (`ssh-keygen -R` keeps CA and revocation lines).
- When no key is recorded, the reason shown is ssh's first line, except for the two lines ssh
  fills with the server's own text (a disconnect message, a greeting that is not SSH), which get a
  sentence of ours instead. When `ssh -G` shows a ProxyJump or ProxyCommand for the workspace's
  own alias and none for the probe, the CLI names that as the cause: the setting sits under that
  alias alone and belongs under `Host haven-*` or `Match host <host>`.

Questions read stdin through one reader per process (`utils/prompt.ts`). Once input ends, that
question and every later one take their default, which for every trust question is no; piped
answers are consumed one per question, in order.

#### Connection Failure Flow (Post-Connection)

After key usability is confirmed, connection failures are simpler to diagnose:

```
┌─────────────────────────────────────────────────────────────┐
│ Connection failed (host key trusted, keys tried in turn)    │
├─────────────────────────────────────────────────────────────┤
│ Host key refused at login (another key, or the trusted one  │
│ with an "incorrect signature")?                             │
│   → The server did not prove it holds the key: may be       │
│     intercepted, no user key was offered; report and exit   │
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

The haven key option still works; it just means having two authorized keys on the workspace.

### SSH Configuration

Haven keeps its host entries in `~/.ssh/haven/config` (0600, directory 0700) and adds one line,
`Include ~/.ssh/haven/config`, to the top of `~/.ssh/config`. Ssh takes the first value it finds
for each setting, so blocks appended at the end, as older versions did, lost to any `Host *`
defaults above them (`ForwardAgent yes`, `StrictHostKeyChecking no`). Each connection gets:

```
Host haven-3f2a9c0d1b4e5a67
  HostName myserver.com
  Port 2222
  User abc
  IdentityFile "/Users/you/.ssh/id_ed25519"
  IdentitiesOnly yes
  UserKnownHostsFile ~/.ssh/known_hosts
  StrictHostKeyChecking yes
  CheckHostIP no
  ForwardAgent no
  ForwardX11 no
  ServerAliveInterval 5
  ServerAliveCountMax 3
```

Rules for `writeHostConfig()`:

- Every value is validated again immediately before writing (alias `haven-[a-z0-9]+`, host and
  user against strict character sets, integer port, absolute identity path without `"` or control
  characters). A newline in a `user@host` target once wrote a `ProxyCommand` into the user's file.
- Both files are replaced by an atomic rename; a symlinked `~/.ssh/config` is written through and
  the link kept, and its existing mode is preserved.
- `~/.ssh/config` is only rewritten when the Include line is missing or an older block must go.
  An older block goes only for an alias in `drop`, only in the exact shape the committed version
  before the include wrote (HostName, Port, User, IdentityFile lines, then `ForwardAgent no`
  through `ServerAliveCountMax 3`), and only when the next line that is not blank or a comment is
  a `Host` or `Match` line or the end of the file: ssh reads every line up to the next `Host` or
  `Match` as part of the block, indented or not. A user's `Match` block after it survives, and so
  does anything else under a `Host haven-...` line, the user's own block for a workspace's alias
  included; Haven never writes that file's blocks for its current aliases, so those are always
  the user's. An earlier pattern took every indented line under the alias and deleted a user's
  block with its `LocalForward`.
- The block for the alias being written is replaced; `drop` names aliases this directory no longer
  uses, removed only when no other connection references them, and only by the last write of a
  connect, after the new sync session is running.

### Mutagen Sync

- Downloaded from GitHub releases on first use
- Runs in background as sync daemon; `haven disconnect` stops it once no session is left
- Data stored in `~/.local/share/haven/mutagen/`
- Uses Mutagen 0.17.6 (pinned), verified: `sync/download.ts` holds the SHA-256 of each platform's
  release archive (from mutagen-io's SHA256SUMS) and of the two files inside it. A download that
  does not match is refused; only the members `mutagen` and `mutagen-agents.tar.gz` are extracted
  (whatever the host tar does with `..` or absolute names), both are re-hashed and must be regular
  files, and they are renamed into place. Every process that uses mutagen checks the installed
  binary against the pinned hash first and reinstalls on a mismatch. Bumping `MUTAGEN_VERSION`
  means replacing all three hash tables.
- Every mutagen call has a timeout (30s daemon calls, 60s flush, 180s for create and resume,
  which connect to the workspace and install the agent there when it is missing). A session is
  labelled `haven-spec=<hash of alias, remote path, ignore rules>`; `startSync()` resumes a session
  only when the label matches and recreates it otherwise, since mutagen fixes both at creation.
- Ignore rules, in order: defaults; `.gitignore` lines (if accepted); `.env`, `.env.*`, `.npmrc`
  (excluded, or after a yes re-included with `!` and then `.env/` and `.env.*/` excluded again,
  since nearly every `.gitignore` lists `.env` and a `.env/` folder is usually a virtualenv);
  the VCS folders `--ignore-vcs` names (`.git/`, `.svn/`, `.hg/`, `.bzr/`, `_darcs/`), which
  mutagen itself puts first, where a `!.git/` line would re-include them, written here with `.git`
  matching files too (a submodule's or a worktree's `.git` is a file naming the git directory);
  credential files by name, every letter as a `[xX]` class so `server.KEY` matches `*.key`; and,
  by exact path, any other file whose content is a private key (`scanForCredentials()` finds
  `deploy_key`, a renamed `id_ed25519_work`). Mutagen applies the last matching pattern, so
  nothing in `.gitignore` can re-include a credential or a VCS folder (a synced `.git` folder
  would let the workspace set hooks or `core.fsmonitor`, which git runs locally, and a synced
  `.git` file would let it point git at a folder of its own with the same effect).
- A `.gitignore` with no accepted version yet (first connect, a no last time, an entry an older
  version wrote) has its `!` lines listed before the question, which then defaults to no, even
  with `--use-gitignore`; the workspace can write that file through sync. A `.gitignore` deleted
  since its lines were accepted counts as a change, with or without `--use-gitignore`: its lines
  are listed as removed and kept unless the user confirms.
- `scanForCredentials()` also feeds the notice `haven connect` prints listing what it does not
  sync (a CA bundle named `*.pem`, say). It reads the header of every small regular file, whatever
  its extension, and does not enter folders the complete ordered ignore rules exclude (including
  later negations), walks breadth-first, follows no symlinks, and stops after `SCAN_LIMIT` (100,000)
  entries; the notice says so when it stops, even if it found nothing, since the content rule then
  has not looked at everything.
- Moving a session off an older version's 32-bit name: the old session is paused (a failed pause
  aborts), the new one created, and its session and connection state saved before the old one is
  terminated. A failure before that commit terminates the new session and resumes the old one, so
  no active session is left untracked; the old alias's Host block is removed after that too. The
  committed connection names the old session (`retiredSessionId`) until terminating it succeeds,
  so a terminate that fails is retried by the next connect or disconnect (`retireSession()`).
- The `sync list` templates read a session's conflicts only under `{{if .SessionState}}` and an
  endpoint's scan problems only under `{{if .Alpha.EndpointState}}` (or Beta): mutagen leaves both
  nil while a session is paused or an endpoint disconnected, and a template that reads them fails
  the whole listing, which made `haven status` report every directory as disconnected.
- Files a replaced session synced (`reportStaleCopies()` in connect.ts): when the directory had
  a session for the same workspace folder (host, port, user and remote path unchanged), its ignore list
  is read before the new one starts: from mutagen while it exists, running or paused
  (`sessionIgnores()`, the template's `.Ignore.Paths`), or, once `haven disconnect` has ended it,
  from `syncIgnores` in connections.json, which every connect records after its session starts
  and which is validated on load like every other field. An entry last written by a version that
  recorded nothing has no `syncIgnores`, and the committed version's rules are not guessed: after
  a disconnect with that version nothing can be compared, nothing is listed, and the README asks
  the user to check the workspace after the upgrade. Once the new session runs, the files the new rules exclude and the old ones let sync (`isIgnored()`, mutagen's own
  matching: the last matching pattern wins, nothing inside an ignored folder syncs; its tests hold
  what mutagen 0.17.6 really synced) are looked up on the workspace in one ssh call
  (`remotePathsThatExist()`) and listed. They come from versions that synced everything, a `.env`
  answer turned to no, and private keys created mid-session under a name the rules miss, which
  sync until the next connect's scan excludes them. A session created fresh lists nothing, and no
  delete command is printed: the workspace may have made a file itself, and two directories can
  sync one workspace folder, so deleting there also deletes in the other (a lab once lost
  `~/a/shared/.env` to a `haven rm` printed for `~/b/shared`).
- A connect checks the host key and looks for a working key under a probe alias,
  `haven-probe<hash>` (`probeAlias()`), whose block has the workspace's HostName, Port and User;
  Haven's blocks set no HostKeyAlias, so ssh reads the same known_hosts entries. The workspace's
  own block is written once a key has logged in, in the same write that drops the probe block, and
  `cleanupOnExit()` (`utils/exit.ts`) removes the probe block on every other way out: a refusal,
  a declined key, a throw, Ctrl-C, a closed terminal, a kill (SIGKILL aside; the next connect to
  that workspace rewrites and drops it). On a signal it cleans up and raises the signal again, so
  the process still dies of it: bash stops a loop around a command only when the command was
  killed by Ctrl-C, and an exit code of 130 kept the loop going. Mutagen and `haven <cmd>` use the
  workspace's block, so a reconnect that stops partway leaves it as it was. Settings a user writes
  for one workspace's exact alias do not reach the probe; ones under `Host *`, `Host haven-*` or
  `Match host <host>` (matched against the HostName the probe block sets) do.
- `disconnect` flushes (a failure warns and continues), then terminates; a failed terminate exits 1
  and keeps the session file, because the session may still be live in the daemon. It then ends a
  session a migration left paused (`retiredSessionId`), which would otherwise keep the daemon
  running.

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

### Releases

When a git tag `v*` is pushed, the `release` job in `.github/workflows/cli.yml`:
- builds all four platform binaries
- writes `SHA256SUMS` for them
- creates a signed build provenance attestation for each binary (`actions/attest`), which users
  can check with `gh attestation verify haven-linux-x64 --repo envhaven/envhaven`
- uploads the binaries and `SHA256SUMS` to the GitHub release, failing if any is missing

The workflow runs with `contents: read` unless a job widens it, and every third-party action is
pinned by commit SHA.

There are two installers. Both download `SHA256SUMS` from the same release as the binary and
refuse to install on a missing file, a missing entry or a mismatch (`sha256sum`, or `shasum -a 256`
on macOS). Both download into a temporary directory inside the install directory and rename the
binary into place, so the rename replaces whatever sits at the destination, a symlink included,
instead of writing through it. A release cut before `SHA256SUMS` existed cannot be installed by
either.

| | `envhaven.com/install.sh` (documented) | `cli/install.sh` |
|---|---|---|
| Served by | envhaven.com | raw.githubusercontent.com, master |
| Downloads from | `envhaven.com/cli/<file>` (a proxy of the latest release) | `github.com/envhaven/envhaven/releases/download/<tag>/` |
| Installs to | `~/.haven/bin`, added to the shell profile | `~/.local/bin` (`INSTALL_DIR`), prints a PATH hint |

`cli/install.sh` is POSIX `sh` and needs `curl`. It reads the latest tag from where
`github.com/<repo>/releases/latest` redirects, which costs no GitHub API quota; the API probe it
replaced allowed 60 unauthenticated requests an hour per address, and then fell back to a URL that
404s. The envhaven.com proxy caches the latest release for the same reason, and serves the binary
and `SHA256SUMS` from one release object per request.

### Latest build (maintainers)

On every push to master that changes `cli/`, the `latest` job builds all four binaries and uploads
them as the workflow artifact `haven-cli-latest` (90-day retention). Nothing serves that artifact:
it is downloadable from the Actions run page by anyone with access to the repository, for testing
a change before cutting a release. There is no beta channel and no `?beta=` token; the platform's
`/install.sh` and `/cli/<binary>` routes serve the latest release to everyone, unauthenticated.
If a gated channel is ever wanted, it has to be built first: nothing in either repository checks a
token today.

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

### "The host key has changed"

The workspace was rebuilt, or updated to the image that gives each workspace its own host key.
`haven connect` shows the old and new fingerprints and asks, defaulting to no; confirm only after
comparing with `ssh-keyscan -t ed25519 localhost 2>/dev/null | ssh-keygen -lf -` run in the
workspace's own terminal. `haven connect --reset-host-key` forgets the old key first, after which
the next connect asks as on a first connection.

A test harness against a throwaway container answers the prompt by piping `y` into
`haven connect`, and removes the key afterwards with `ssh-keygen -R "[host]:port"`. Setting a
different `HOME` does not isolate this: ssh reads `~/.ssh` from the account's passwd entry, while
the CLI writes under `$HOME`.

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

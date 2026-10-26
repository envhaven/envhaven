# SSH Key Handling

Haven CLI uses `ssh -o BatchMode=yes` which cannot prompt for passphrases. Keys must be either unencrypted or loaded in ssh-agent.

## Usability Rule

```
usable = !encrypted OR inAgent
```

- `encrypted`: `ssh-keygen -y -P "" -f <key>` exits non-zero
- `inAgent`: fingerprint appears in `ssh-add -l`

## State Machine

```
                          haven connect
                               │
                               ▼
                      findExistingKeys()
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         ▼                     ▼                     ▼
     NO_KEYS            HAVEN_KEY_EXISTS        OTHER_KEYS
         │                     │                     │
         ▼                     │                     ▼
  generateHavenKey()           │              analyzeKeys()
         │                     │                     │
         ▼                     │         ┌───────────┴───────────┐
   showGeneratedKey()          │         │                       │
   (user adds to workspace)    │         ▼                       ▼
         │                     │    HAS_USABLE             NO_USABLE
         │                     │         │                       │
         │                     │         │                       ▼
         │                     │         │          promptForEncryptedKeyResolution()
         │                     │         │                       │
         │                     │         │         ┌─────────────┴─────────────┐
         │                     │         │         │                           │
         │                     │         │         ▼                           ▼
         │                     │         │   [1] Generate key            [2] Use agent
         │                     │         │         │                           │
         │                     │         │         ▼                           ▼
         │                     │         │   generateHavenKey()          EXIT(1)
         │                     │         │         │                    (with instructions)
         └─────────────────────┴─────────┴─────────┘
                               │
                               ▼
                      ensureHostKeyTrusted()
            (ssh with the probe alias, "none" auth only)
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         ▼                     ▼                     ▼
       KNOWN              FIRST CONNECT           CHANGED
         │              show fingerprint      show old + new
         │                   [y/N]                 [y/N]
         │                     └──────────┬──────────┘
         │                    no ◀────────┴────────▶ yes
         │                     │                     │
         │                     ▼                     ▼
         │                  EXIT(1)          pin the shown key
         │                                           │
         └─────────────────────┬─────────────────────┘
                               ▼
                      connectWithWorkingKey()
             identity candidates (Haven key, key files,
             agent-only keys, locked files; recorded key
             first), up to five per connection:
               writeHostConfig() (those keys, IdentitiesOnly)
               testConnection() (ssh -v -o BatchMode=yes)
               accepted key named by ssh -v → block names it
             all refused: one try with every key file and
             no IdentitiesOnly (ssh's own key selection)
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
                 ▼                           ▼
             SUCCESS                      FAILURE
     (workspace's own block     "Permission denied" → next key
      written, key recorded)    anything else, or none left
                 │                           │
                 ▼                           ▼
            startSync()               showSshKeyHelp()
                 │                       EXIT(1)
                 ▼
            CONNECTED
```

The host key is settled before anything authenticates, by ssh itself with a probe alias that has
the workspace's host, port and user (so a ProxyJump or ProxyCommand applies) and only the "none"
authentication method (so no key is offered): a key `~/.ssh/known_hosts` already holds for the
host is used silently, a new or changed one is shown with its fingerprint and needs an explicit
yes (the default is no). The workspace's own Host block changes only once a key has logged in;
until then everything runs under the probe alias, whose block is removed however the connect
ends. The SSH config is `StrictHostKeyChecking yes`, so after that check neither ssh nor mutagen
accepts another key on its own. Keys are then offered a few per connection, which keeps refused
logins under the point where newer OpenSSH servers refuse the address, and the config ends up
naming the one that worked. `--reset-host-key` forgets the trusted key first, so the check asks
as on a first connection.

## Why Haven Key is Trusted

We generate haven keys with `ssh-keygen -N ""` (empty passphrase). They are never encrypted. When `hasHavenKey()` returns true, we proceed without encryption check because we created it.

## Test Matrix

| Scenario | Behavior |
|----------|----------|
| No keys exist | Generate haven key, show to user |
| Haven key exists | Proceed |
| Other key (unencrypted) | Proceed |
| Other key (encrypted, in agent) | Proceed |
| Other key (encrypted, not in agent) | Prompt: generate or use agent |
| Mixed keys (some usable) | Proceed |

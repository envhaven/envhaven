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
                      writeHostConfig()
                      (all keys in IdentityFile)
                               │
                               ▼
                      testConnection()
                      (ssh -o BatchMode=yes)
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
                 ▼                           ▼
             SUCCESS                      FAILURE
                 │                           │
                 ▼               ┌───────────┴───────────┐
            startSync()          ▼                       ▼
                 │        host key changed          other failure
                 ▼               │                       │
            CONNECTED            ▼                       ▼
                          prompt reconnect?        showSshKeyHelp()
                          removeHostKey() + retry      EXIT(1)
```

On `testConnection()` failure Haven CLI distinguishes two cases: a **changed host key** (workspace rebuilt) prompts to reconnect, runs `removeHostKey()`, and retries; any **other failure** calls `showSshKeyHelp()` and exits. `--reset-host-key` forces the host-key path up front.

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

# EnvHaven Dev Tools

Development tooling for EnvHaven. Contains the TUI (`eh`) and standalone scripts.

## Architecture

```
dev/
├── scripts/              # Standalone scripts (SOURCE OF TRUTH)
│   ├── lib/              # Shared utilities
│   │   ├── config.ts     # Config from .env.dev
│   │   ├── docker.ts     # Docker operations
│   │   ├── log.ts        # CLI output formatting
│   │   └── env.ts        # Env file parsing
│   ├── build.ts          # docker build
│   ├── start.ts          # docker run
│   ├── stop.ts           # docker rm
│   ├── logs.ts           # docker logs -f
│   ├── test-image.ts     # Image health checks
│   ├── test-cli.ts       # Haven CLI tests
│   ├── test-extension.ts # Extension build test
│   ├── extension-build.ts
│   ├── extension-install.ts
│   └── README.md
├── src/
│   ├── actions/          # TUI wrappers (call scripts/)
│   ├── components/       # Ink/React components
│   ├── lib/              # TUI-specific utilities (re-exports scripts/lib)
│   └── state/            # Jotai atoms
├── .env.example
├── package.json
└── README.md
```

## Design Principles

1. **Scripts as source of truth** - All operations implemented in `scripts/`
2. **TUI wraps scripts** - `src/actions/` spawn scripts and format output
3. **CI uses scripts** - GitHub Actions call scripts directly
4. **Config from env** - Scripts read `dev/.env.dev`

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Bun |
| Language | TypeScript |
| TUI | Ink (React for CLIs) |
| State | Jotai |

## Running Scripts

```bash
# Standalone
bun dev/scripts/build.ts
bun dev/scripts/test-image.ts

# Via TUI
cd dev && bun run setup   # One-time: install, build, link
eh                        # Launch TUI from anywhere
```

## Docker-in-Docker Development

When running the dev scripts (via `eh`) from inside a container, you must set `ENVHAVEN_HOST_REPO_PATH` to the **host path** of this repository.

This single path enables:
1. Extension mounting for live development (`${ENVHAVEN_HOST_REPO_PATH}/extension`)
2. Test config persistence (`${ENVHAVEN_HOST_REPO_PATH}/.test-config` - gitignored)

```bash
# dev/.env.dev
ENVHAVEN_HOST_REPO_PATH=/home/user/projects/envhaven
ENVHAVEN_HOST=192.168.x.x
```

See [CONTRIBUTING.md](../CONTRIBUTING.md#developing-from-within-a-container).

## Adding a New Script

1. Create `dev/scripts/my-script.ts`
2. Import from `./lib` for config, logging, docker
3. Use `process.exit()` for exit codes
4. Add TUI wrapper in `src/actions/` if needed
5. Update `scripts/README.md`

Example:

```typescript
#!/usr/bin/env bun
import { loadConfig, log, isContainerRunning } from './lib';

const config = loadConfig();

if (!await isContainerRunning(config.containerName)) {
  log.error('Container not running');
  process.exit(1);
}

log.success('Container is running');
process.exit(0);
```

## Fast Extension Iteration (Hot-Inject)

When a test container (`envhaven-test`) is already running, skip full Docker image rebuilds. Build locally, package a VSIX, and inject it directly:

```bash
# 1. Build extension (host + webview)
bun dev/scripts/extension-build.ts

# 2. Run unit tests
cd extension && bun test

# 3. Package VSIX
cd extension && npx --yes @vscode/vsce package --out /tmp/envhaven.vsix

# 4. Inject into running container
docker cp /tmp/envhaven.vsix envhaven-test:/tmp/envhaven.vsix
docker exec envhaven-test sh -c '
  EXT_DIR=$(echo /config/extensions/envhaven.envhaven-*)
  rm -rf "$EXT_DIR"
  mkdir -p "$EXT_DIR" && cd "$EXT_DIR"
  unzip -o /tmp/envhaven.vsix "extension/*" >/dev/null 2>&1
  cp -r extension/* . && rm -rf extension
'

# 5. Reload sidebar in the browser (or refresh the code-server tab)
```

**Why this works**: code-server reads extensions from `/config/extensions/` at activation. Replacing the directory contents and reloading the sidebar picks up changes without restarting the container.

**When to use**: Any extension change (webview UI, sidebar-provider logic, environment detection, tool-definitions.json). Saves ~10 minutes vs a full `docker build`.

**When NOT to use**: Changes to the Dockerfile, runtime init scripts, or installed tool versions — those require a full `bun dev/scripts/build.ts`.

**Playwright E2E** can run against the injected extension immediately:
```bash
cd extension && npx playwright test --reporter=list
```
Playwright config lives at `extension/playwright.config.ts`, tests at `extension/e2e/`.

## TUI Action Pattern

TUI actions spawn scripts and stream output:

```typescript
import { spawn } from 'bun';
import { join } from 'path';
import { DEV_ROOT } from '../lib/config';
import { readProcessStreams, raceWithAbort } from '../lib/stream';

export async function runMyAction(config, addLog, setProcess, signal) {
  const proc = spawn(['bun', join(DEV_ROOT, 'scripts/my-script.ts')], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  setProcess({ kill: () => proc.kill() });

  await raceWithAbort(
    readProcessStreams(proc.stdout, proc.stderr, (line) => {
      if (line.startsWith('✓')) addLog('success', line.slice(2));
      else if (line.startsWith('✗')) addLog('error', line.slice(2));
      else addLog('dim', line);
    }, signal),
    signal,
    () => proc.kill()
  );
}
```

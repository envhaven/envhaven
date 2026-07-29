# EnvHaven Dev Scripts

Standalone scripts for building, testing, and managing EnvHaven development.

These scripts are the **single source of truth** for build/test operations. The TUI (`eh`) calls them and so does CI, so a green desk and a green pipeline mean the same thing. Only the image *build* still goes through Buildx, for the layer cache the release job shares.

## Usage

All scripts run with Bun:

```bash
bun dev/scripts/build.ts           # Build Docker image
bun dev/scripts/start.ts           # Start test container
bun dev/scripts/stop.ts            # Stop test container
bun dev/scripts/logs.ts            # Stream container logs
bun dev/scripts/test-image.ts      # Validate Docker image
bun dev/scripts/test-ai-tools.ts   # Verify all AI CLI tools
bun dev/scripts/test-cli.ts        # Test Haven CLI
bun dev/scripts/test-extension.ts  # Test extension build
bun dev/scripts/measure-tui.ts     # Check the console's TUI geometry table
bun dev/scripts/test-console-echo.ts  # Predictive echo, end to end in a browser
```

Or use the TUI which wraps these scripts with a nice interface:

```bash
cd dev && bun run setup   # One-time: install, build, link
eh                        # Press 'b' for build, 's' for start, 't' for test, etc.
```

## Scripts

| Script | Description | Options |
|--------|-------------|---------|
| `build.ts` | Build `envhaven:dev` Docker image | `--no-cache` |
| `start.ts` | Start test container | `--fresh`, `--mount-ext` |
| `stop.ts` | Stop and remove test container | |
| `logs.ts` | Stream container logs | `--tail=N` |
| `test-image.ts` | Boot two fresh containers and run every image check | |
| `test-ai-tools.ts` | Re-check the AI roster in the container already running | |
| `test-cli.ts` | Haven CLI integration tests | `--ci` (non-interactive) |
| `test-extension.ts` | Build extension and verify artifacts | |
| `extension-build.ts` | Build extension host and webview | `--webview-only`, `--host-only` |
| `extension-install.ts` | Package and install extension in container | |
| `measure-tui.ts` | Measure AI CLI composer geometry against the console's `TUI` table | `--print`, `--container=`, `<app>...` |
| `test-console-echo.ts` | Drive predictive echo in a real browser over a simulated round trip | `--container=`, `--password=`, `--down=`, `--up=`, `<check>...` |

## Adding a new AI CLI tool

The last two scripts are how a tool joins the browser terminal rather than merely
running inside it. Installing it is a Dockerfile edit, and registering it in
`tool-definitions.json` is what puts it in every `--version` gate. Neither teaches the
console to predict its wraps.

```bash
bun dev/scripts/measure-tui.ts --print <tool>          # measure its composer
# add the printed row to `var TUI` in console/ui/terminal.html
# add it to APPS in lib/console-rig.ts, and to SEED_TABLE and KEEP_TABLE in lib/console-checks/wrap.ts
bun dev/scripts/test-console-echo.ts seedwrap wrapkeep # prove the row is real
```

The full procedure, including why npm-installed CLIs need an entry in
`runtimeWrappers` in `console/gate.go` before any of this can work, is
`docs/architecture.md` under "Adding New Tools", step 7.

## Configuration

Scripts read from `dev/.env.dev`:

```bash
cp dev/.env.example dev/.env.dev
```

An exported variable wins over the file, so a one-off override works without editing it:

```bash
ENVHAVEN_IMAGE=envhaven:test bun dev/scripts/test-image.ts
```

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVHAVEN_CONTAINER_NAME` | `envhaven-test` | Test container name |
| `ENVHAVEN_IMAGE` | `envhaven:dev` | Docker image tag |
| `ENVHAVEN_HOST` | `localhost` | Host for access URLs |
| `ENVHAVEN_WEB_PORT` | `8443` | Web UI port |
| `ENVHAVEN_SSH_PORT` | `2222` | SSH port |
| `ENVHAVEN_CONSOLE_PORT` | `7681` | Browser terminal port (opens when a password is set) |
| `ENVHAVEN_HOST_REPO_PATH` | | Host path for Docker-in-Docker |

## CI Usage

EnvHaven's `ci.yml` runs these scripts directly, so a green CI and a green desk mean the same thing. The image is still built with `docker/build-push-action` (for the layer cache the release job shares), and `test-image.ts` then checks the result:

```yaml
- name: Setup Bun
  uses: oven-sh/setup-bun@v2

- name: Test extension
  run: bun dev/scripts/test-extension.ts

- name: Test image
  run: bun dev/scripts/test-image.ts
  env:
    ENVHAVEN_IMAGE: envhaven:test
```

`test-image.ts` needs no `bun install` — it imports only runtime builtins and `scripts/lib`. `test-extension.ts` does need one, since it builds the extension.

## Script Library

Shared utilities live in `scripts/lib/`:

- `config.ts` - Configuration loading from `.env.dev`
- `docker.ts` - Docker operations (status, exec, wait)
- `log.ts` - Colored CLI output
- `env.ts` - Environment file parsing

Import with:

```typescript
import { loadConfig, log, isContainerRunning } from './lib';
```

`console-rig.ts` is deliberately absent from that barrel. The check modules import
Playwright for types only, which erases; this is the one module that imports a runtime
value from it. Re-exporting it would make every other script here fail to load without
the browser dependency, and CI's console job runs `test-console-ui.ts` (which imports
`./lib`) with no `bun install` at all. Import it by path:

```typescript
import { ConsoleRig, probe, quiet } from './lib/console-rig';
```

## Fixtures

`dev/fixtures/` holds the terminal applications and the network shim that
`test-console-echo.ts` needs. The rig copies the whole directory into the
container on startup, so nothing there is installed by hand.

| File | Purpose |
|------|---------|
| `composer.py` | Word-wrapping composer, reproducing the measured Claude Code contract |
| `boxcomposer.py` | Same, but painting every row in its own background |
| `invcomposer.py` | Same, but hiding the real cursor and drawing an inverse-video caret |
| `blinkmimic.py` | One coloured band with the cursor parked in it, holding still |
| `latency-proxy.py` | Fixed-delay TCP proxy, so the round trip is visible enough to predict |

The mimics exist because the real AI CLIs cannot be held in these states on demand:
a background under the engine's control, a caret the app draws itself, a cursor that
never moves. The pixel checks drive both, `boxbg-claude` against the real Claude Code
and `boxbg-mimic` against `boxcomposer.py`, so a vendor redesign shows up as one of
the two diverging rather than as the whole check going quiet.

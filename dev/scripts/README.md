# EnvHaven Dev Scripts

Standalone scripts for building, testing, and managing EnvHaven development.

These scripts are the **single source of truth** for local build/test operations. The TUI (`eh`) calls them; CI runs `test-extension.ts` directly, while the image build and its checks run via Buildx and inline steps.

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
| `test-image.ts` | Run image health checks (runtimes, tools) | |
| `test-ai-tools.ts` | Verify all AI CLI tools (--version) | |
| `test-cli.ts` | Haven CLI integration tests | `--ci` (non-interactive) |
| `test-extension.ts` | Build extension and verify artifacts | |
| `extension-build.ts` | Build extension host and webview | `--webview-only`, `--host-only` |
| `extension-install.ts` | Package and install extension in container | |

## Configuration

Scripts read from `dev/.env.dev`:

```bash
cp dev/.env.example dev/.env.dev
```

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVHAVEN_CONTAINER_NAME` | `envhaven-test` | Test container name |
| `ENVHAVEN_IMAGE` | `envhaven:dev` | Docker image tag |
| `ENVHAVEN_HOST` | `localhost` | Host for access URLs |
| `ENVHAVEN_WEB_PORT` | `8443` | Web UI port |
| `ENVHAVEN_SSH_PORT` | `2222` | SSH port |
| `ENVHAVEN_HOST_REPO_PATH` | | Host path for Docker-in-Docker |

## CI Usage

EnvHaven's `ci.yml` runs `test-extension.ts` directly; the image is built and health-checked with `docker/build-push-action` plus inline steps, not `build.ts`/`test-image.ts`. A minimal script-driven pipeline looks like:

```yaml
- name: Setup Bun
  uses: oven-sh/setup-bun@v2

- name: Install dev dependencies
  run: cd dev && bun install

- name: Test extension
  run: bun dev/scripts/test-extension.ts
```

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

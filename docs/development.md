# Development

Guide for building EnvHaven from source and running tests.

## Quick Start

```bash
git clone https://github.com/envhaven/envhaven.git
cd envhaven/dev
bun run setup   # Install, build, and link globally
eh              # Launch dev TUI - press 'b' to build, 's' to start
```

Access at `http://localhost:8443` (password: `test`)

## Prerequisites

- Docker 20.10+
- Git
- [Bun](https://bun.sh) 1.1+ (for extension, CLI, and dev TUI)

## Development TUI (`eh`)

EnvHaven uses a TUI for all development tasks:

```bash
cd dev && bun run setup   # One-time: install, build, link
eh                        # Launch from anywhere
```

| Key | Action | Description |
|-----|--------|-------------|
| `s` | Start Container | Run or restart `envhaven-test` |
| `b` | Build Image | Rebuild `envhaven:dev` Docker image |
| `w` | Watch Extension | Live extension development |
| `r` | Release | Tag and push (triggers Image + CLI build) |
| `t` | Test | Submenu: Validate Image, Test CLI, Test Extension |
| `l` | Logs | Stream container logs |
| `x` | Shell | SSH into container |
| `,` | Settings | View/edit configuration |

### Configuration

Copy the example config and customize:

```bash
cp dev/.env.example dev/.env.dev
```

Settings in `dev/.env.dev`:

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVHAVEN_CONTAINER_NAME` | `envhaven-test` | Test container name |
| `ENVHAVEN_IMAGE` | `envhaven:dev` | Docker image tag |
| `ENVHAVEN_HOST` | `localhost` | Host for access URLs |
| `ENVHAVEN_WEB_PORT` | `8443` | Web UI port |
| `ENVHAVEN_SSH_PORT` | `2222` | SSH port |
| `ENVHAVEN_HOST_REPO_PATH` | - | Host path for Docker-in-Docker setups (see below) |

### Docker-in-Docker (DinD) Setup

If you develop from within a container (e.g., EnvHaven, code-server), you must configure **path translation**.

**The Problem:**
When the dev scripts run `docker run -v /path:...` from inside a container, the command is sent to the **host's** Docker daemon. The daemon resolves `/path` against the **host's** filesystem, not your container's filesystem.

**The Solution:**
Set `ENVHAVEN_HOST_REPO_PATH` to the physical path of the repository on the host machine.

```bash
# dev/.env.dev
ENVHAVEN_HOST_REPO_PATH=/home/user/projects/envhaven
ENVHAVEN_HOST=192.168.1.100
```

This single path is used for:
- Extension mounting: `${ENVHAVEN_HOST_REPO_PATH}/extension`
- Test config persistence: `${ENVHAVEN_HOST_REPO_PATH}/.test-config` (gitignored)

See [CONTRIBUTING.md](../CONTRIBUTING.md#developing-from-within-a-container) for detailed diagrams and setup steps.

## Building the Image

Via TUI: `eh` → press `b`

Or manually:
```bash
docker build -t envhaven:dev .
```

The build takes approximately 15-20 minutes due to the number of runtimes and AI tools being installed.

### Multi-Architecture Build

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t envhaven:dev .
```

## Running a Test Container

Via TUI: `eh` → press `s`

Access at `http://localhost:8443` (password: `test`)

## Running Tests

All tests can be run via TUI or standalone scripts.

### Image Validation

```bash
# Via TUI
eh    # Press 't' → 'i'

# Or standalone
bun dev/scripts/test-image.ts
```

Validates:
- code-server health
- SSH daemon
- All runtimes (Node.js, Python, Go, Rust)
- AI CLI tools
- Bundled CLI tools (ripgrep, fd, jq, ...)
- Configuration files

### Haven CLI Integration Tests

```bash
# Via TUI
eh    # Press 't' → 'c'

# Or standalone (CI mode - non-interactive)
bun dev/scripts/test-cli.ts --ci

# Or standalone (interactive mode)
bun dev/scripts/test-cli.ts
```

### Extension Build Test

```bash
# Via TUI
eh    # Press 't' → 'e'

# Or standalone
bun dev/scripts/test-extension.ts
```

### Console Server Tests

```bash
cd console && go vet ./... && go test -race -count=1 ./...
```

CI runs the same on every pull request. The suite covers both auth modes (platform JWT and web password), the session pump wire protocol, and pins the vendored xterm assets byte-for-byte (see `console/ui/assets/LICENSE`).

## Project Structure

```
envhaven/
├── .github/workflows/    # CI/CD
│   ├── ci.yml            # Tests on pull requests
│   ├── docker.yml        # Build + push image to GHCR
│   └── cli.yml           # Haven CLI binary releases
├── cli/                  # Haven CLI (local editor + remote AI)
│   ├── src/              # TypeScript source
│   ├── scripts/          # Build scripts
│   ├── test/             # Unit tests
│   └── AGENTS.md         # CLI architecture docs
├── console/              # In-container console server (Go)
│   ├── *.go              # HTTP server, auth gate, session pump
│   └── ui/               # Vendored xterm.js terminal assets
├── dev/                  # Development TUI (eh)
│   ├── scripts/          # Standalone scripts (source of truth)
│   │   ├── lib/          # Shared utilities (config, docker, log)
│   │   ├── build.ts      # docker build
│   │   ├── start.ts      # docker run
│   │   ├── stop.ts       # docker rm
│   │   ├── logs.ts       # docker logs
│   │   ├── test-*.ts     # Test scripts
│   │   └── README.md     # Script documentation
│   ├── src/              # TUI source (Ink/React)
│   ├── .env.example      # Config template
│   ├── AGENTS.md         # Dev tooling architecture
│   └── README.md
├── docs/                 # User documentation
│   ├── architecture.md
│   ├── ai-tools.md
│   ├── configuration.md
│   └── development.md
├── extension/            # VS Code extension source
│   ├── src/              # Extension host (TypeScript)
│   ├── webview/          # React webview
│   └── package.json
├── runtime/              # Files packaged INTO Docker image
│   ├── scripts/          # s6-overlay init scripts
│   ├── overrides/        # code-server UI patches
│   └── templates/        # Config templates (AGENTS.md, settings.json)
├── Dockerfile
├── docker-compose.yml
├── mise.toml             # Tool version manifest
└── README.md
```

### Directory Distinction

- **`runtime/`** — Packaged into the Docker image, runs inside the container
- **`dev/`** — Development TUI and scripts, runs on your machine

## Dockerfile Overview

The Dockerfile uses a multi-stage build. See [Architecture](architecture.md) for design rationale.

### Stage 1: Extension Builder

Compiles the VS Code extension using `oven/bun:alpine`.

### Stage 2: Main Image

Based on `linuxserver/code-server:latest`:

1. **System dependencies** - Build tools, SSH server
2. **Tool directory** - `/opt/envhaven/bin` (survives `/config` mount)
3. **mise** - Manages Node.js, Bun, Python, Go, and some AI tools (opencode, goose)
4. **Rust** - Installed via rustup (cargo, rustc)
5. **uv** - Python tool installer (aider, vibe)
6. **AI Tools** - npm globals (claude, codex, gemini, qwen, amp, auggie) + standalone installers (kiro, droid)
7. **VS Code Extension** - Pre-installed to `/app/pre-installed-extensions`
8. **s6-overlay Services** - Init scripts from `runtime/scripts/`

### Why `/opt/envhaven/bin`?

LSIO sets `HOME=/config`. Tools default to `~/.local/bin` which becomes `/config/.local/bin`. When users mount `-v /config:/config`, this directory gets shadowed.

Solution: Install tools to `/opt/envhaven/bin/` which is never mounted over. Users can override by installing to `/config/.local/bin/` (higher PATH priority).

## Extension Development

### Live Development Workflow

```bash
eh    # Press 'w' for Watch Extension
```

Edit files in `extension/` — changes auto-compile and reinstall. Reload the browser to see updates.

### Manual Extension Development

```bash
cd extension
bun install
bun run dev              # Watch mode for extension host

cd webview
bun install
bun run build            # Build webview
```

### Extension Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Bundle `src/` with esbuild (no type-check; see below) |
| `bun run dev` | Watch mode (recompile on save) |
| `bun run build:webview` | Build React webview |
| `bun run package` | Create `envhaven.vsix` package |

### Type checking the extension

`bun run build` (and the extension stage of the image build) runs **esbuild**: it bundles `src/` but does **not** type-check. Only the webview is type-checked, through its own `tsc -b && vite build`. The gate for `src/` is `bun dev/scripts/test-extension.ts`, which CI runs on every pull request: it type-checks `src/` with `tsc --noEmit` and runs the extension unit tests before building anything. Run the same checks by hand:

```bash
cd extension && ./node_modules/.bin/tsc --noEmit -p tsconfig.json && bun test
```

## Haven CLI Development

The Haven CLI is a Bun/TypeScript project in the `cli/` directory.

```bash
cd cli
bun install
bun run dev connect .    # Run in dev mode
bun test                 # Run tests
bun run typecheck        # Type check
```

### Building CLI Binaries

```bash
cd cli
bun run build            # Current platform
bun run build -- --all   # All platforms (darwin/linux, x64/arm64)
```

Outputs to `cli/dist/`.

See [cli/AGENTS.md](../cli/AGENTS.md) for architecture details, including:
- Proactive SSH key encryption detection
- Key usability analysis flow
- Connection failure handling

## Runtime Scripts

Scripts in `runtime/scripts/` run at container startup via s6-overlay:

| Script | Purpose |
|--------|---------|
| `init-extensions-run` | Install VS Code extensions |
| `init-vscode-settings-run` | Apply VS Code settings |
| `init-agents-md-run` | Generate AGENTS.md |
| `init-agent-config-run` | Seed AI agent configs (Claude, Codex) |
| `init-user-config-run` | Configure git, SSH, and user shell |
| `init-zsh-config-run` | Configure zsh |
| `svc-sshd-run` | Run SSH daemon |
| `svc-cloudflared-run` | Cloudflare tunnel (if `CLOUDFLARE_TUNNEL_TOKEN` set) |
| `svc-console-run` | In-container console server (:7681) |

User-facing scripts (installed to `/opt/envhaven/bin/`):

| Script | Command | Purpose |
|--------|---------|---------|
| `envhaven-status` | `envhaven` | Full status display |
| `envhaven-welcome.sh` | - | Shell init (auto-attach) |

## GitHub Actions

CI/CD is split across three workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Pull requests | Test suite: `cli`, `image`, `extension`, and `console` jobs |
| `docker.yml` | Push to `master`, `v*` tags | Build and push the image to GitHub Container Registry (tags get a multi-arch manifest) |
| `cli.yml` | `v*` tags (plus a `latest` artifact on `master`) | Build and release Haven CLI binaries |

CI builds `linux/amd64` only; the arm64 matrix entry is disabled pending an arm64 runner ([issue #1](https://github.com/envhaven/envhaven/issues/1)). Build multi-arch locally with `docker buildx build --platform linux/amd64,linux/arm64`.

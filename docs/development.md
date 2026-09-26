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
- An x86-64 CPU with AVX2 (Intel Haswell 2013+ / AMD Zen+). Some bundled AI CLIs ship
  binaries that require it; on older CPUs they die with `Illegal instruction`, which
  also fails the image build's tool verification.

## Development TUI (`eh`)

EnvHaven uses a TUI for all development tasks:

```bash
cd dev && bun run setup   # One-time: install, build, link
eh                        # Launch from anywhere
```

The keys are listed in `dev/README.md` under "Keybindings"; `?` inside the TUI shows the
same list.

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
| `ENVHAVEN_CONSOLE_PORT` | `7681` | Embedded console port |
| `ENVHAVEN_PASSWORD` | `test` | Container password |
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

This path is used for extension mounting: `${ENVHAVEN_HOST_REPO_PATH}/extension`. Watch Extension is the only action that needs it; build, start, test, logs and shell work without it. Test containers get an ephemeral `/config`, discarded with the container.

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

The arm64 half currently fails; [GitHub Actions](#github-actions) says why.

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

Boots two containers, one with a password and one without, and validates:
- code-server health, SSH daemon
- The browser terminal page, its login → cookie → token flow, and that the console gate
  keeps port 7681 shut when no password is set
- All runtimes (Node.js, Python, Go, Rust)
- AI CLI tools, and that the image's tool roster matches this repo's
- Bundled CLI tools (ripgrep, fd, jq, ...)
- Configuration files, read as `abc` rather than root

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
bun dev/scripts/test-console-ui.ts   # terminal runtime structure, run from the repo root
```

The browser terminal predicts where an AI CLI's input box will wrap, from a table
of measured constants in `console/ui/assets/eh-model.js`. Those applications redesign
their composers between releases, so the table has an instrument rather than a
comment vouching for it:

```bash
bun dev/scripts/measure-tui.ts                # check every row against a real terminal
bun dev/scripts/measure-tui.ts --print codex  # measure one app and print its row
```

It needs a running workspace container (`bun dev/scripts/start.ts`), drives each
application in tmux on a socket of its own, and measures at two widths. Run it
when a wrap starts looking wrong, and replace the row it reports. It is not in CI:
it drives third-party TUIs whose startup screens change, and a gate that breaks
when someone else ships an onboarding dialog would cost more than it catches.
Adding a tool to the roster is the runbook in `architecture.md` under "Adding New
Tools"; measuring its composer is step 7 there.

Prediction itself is a race, so none of it can be checked by reading the source.
`test-console-echo.ts` runs the engine against a real terminal through a proxy
that inserts a real round trip, then asks the page what it believes while it is
still wrong:

```bash
bun dev/scripts/test-console-echo.ts                    # every check
bun dev/scripts/test-console-echo.ts tailmove endreach  # named checks only
```

It needs a running container with a console password (`bun dev/scripts/start.ts`)
and a browser (`cd dev && bunx playwright install chromium`). The mimic
applications in `dev/fixtures/` are copied into the container for it; they exist
because the real CLIs cannot be driven into some of the states the checks need, a
controlled background or a self-drawn caret among them.

The implementation is split by resource: `console-rig.ts` owns Playwright,
`console-proxy.ts` owns the delay process and run-scoped fixtures, while
`console-managed-tmux.ts` owns managed token minting and a per-run grouped tmux view.
Signal cleanup shares in-flight work, retries failed disposal up to three times, and
remembers each resource only after it closes successfully.

Every check reports pass, fail or skip, and a skip exits non-zero. That
distinction carries more weight here than usual: a check that never reached the
state it guards has proved nothing, and counting it as a pass is how a suite stops
testing anything while still printing green. It stays out of CI for the same
reason `measure-tui.ts` does.

CI runs the Go suite and `test-console-ui.ts` on every pull request, and again on
the release path: `docker.yml` calls the CI workflow and publishes nothing to
ghcr unless it passes. The static test executes the shipped `eh-model.js` directly,
including the shared v1/v4 frame fixtures and deterministic controller transitions,
without loading a browser. The Go suite covers both auth modes (platform JWT and web password), the session pump wire protocol, the HTTP API guard and its CORS behavior, the tmux action allowlist, page framing (CSP `frame-ancestors` and `X-Frame-Options`), the skills domain (`console/skills.go` + `skills_test.go`), and pins the vendored xterm assets byte-for-byte (see `console/ui/assets/LICENSE`). The `/tools` and `/skills` wire shapes are pinned by `console/testdata/*.golden.json`, which the extension's `bun test` also reads for its conformance check, so a change on either side of that contract fails a test.

### Trying a console change in a live container

A console change reaches a running workspace without a release: the binary is Go and
embeds the browser runtime, so a rebuilt binary dropped into a running container is the whole
deploy: build it in Docker, so the binary carries the same golang:1.26 toolchain as the
image's console-builder stage (the workspace's mise go 1.22.5 builds it too), copy it
in, restart the service. `s6-svc -d` first; overwriting a running binary fails with `text file busy`.

```bash
docker build -f - -t envhaven-console-build . <<'EOF'
FROM golang:1.26
WORKDIR /console
COPY console/go.mod console/go.sum ./
RUN go mod download
COPY console/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/envhaven-console .
EOF
docker create --name console-extract envhaven-console-build
docker cp console-extract:/out/envhaven-console /tmp/envhaven-console
docker rm console-extract
docker cp /tmp/envhaven-console <container>:/tmp/envhaven-console
docker exec -u root <container> sh -c \
  's6-svc -d /run/service/svc-console; sleep 1; \
   cp /tmp/envhaven-console /opt/envhaven/bin/envhaven-console; \
   chmod +x /opt/envhaven/bin/envhaven-console; s6-svc -u /run/service/svc-console'
```

Verify the changed module the container serves matches the tree, for example:
`curl -s <console>/__console/assets/eh-predict-input.js | grep -c <a symbol your change adds>`.
The user reloads the console and tests; asset URLs carry a content hash, so no hard refresh
is needed. The same loop covers `envhaven-test` and a
managed workspace container; a managed console additionally fatals at startup if it cannot
fetch the platform's signing keys, and the fix is the environment file in
`/run/s6/container_environment/` rather than the binary.

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
├── skills/               # Agent skills; the console fetches these from GitHub at runtime
├── Dockerfile
├── docker-compose.yml
├── mise.toml             # Tool version manifest
├── tool-definitions.json # The AI tool roster; source of truth for every --version gate
└── README.md
```

### Directory Distinction

- **`runtime/`**: Packaged into the Docker image, runs inside the container
- **`dev/`**: Development TUI and scripts, runs on your machine

## Dockerfile Overview

The Dockerfile uses a multi-stage build. See [Architecture](architecture.md) for design rationale.

### Stage 1: Extension Builder

Compiles the VS Code extension using `oven/bun:1.3.5-alpine`.

### Stage 1b: Console Builder

Compiles the in-container console server (Go) using `golang:1.26`. Its binary is copied into the
main image.

### Stage 2: Main Image

Based on `linuxserver/code-server:latest`:

1. **System dependencies** - Build tools and base CLIs via apt
2. **Docker CLI** - 27.5.1, x86_64-pinned, when `INSTALL_DOCKER=true` (the default)
3. **SSH server** - Host keys and `sshd_config`
4. **Tool directory** - `/opt/envhaven/bin` (survives `/config` mount)
5. **mise** - Manages Node.js, Bun, Python, Go, and some AI tools (opencode, goose, fx, kimi). Once mise is installed the build switches to uid 1000 and stays there through the console binary, so each tool lands owned by the workspace user; a final `find -uid 0` sweep repairs only what the root-run verification block touches
6. **Rust** - Installed via rustup (cargo, rustc)
7. **uv** - Python tool installer (vibe, hermes)
8. **npm globals** - codex, qwen, amp, pi, openclaw
9. **Playwright** - Browser automation plus Chromium, into `/opt/envhaven/playwright`
10. **Standalone installers** - claude, kiro, droid, agy, grok, muse
11. **Console server** - The Go binary from stage 1b, into `/opt/envhaven/bin`
12. **VS Code Extension** - Pre-installed to `/app/pre-installed-extensions`
13. **s6-overlay Services** - Init scripts from `runtime/scripts/`

### Why `/opt/envhaven/bin`?

LSIO sets `HOME=/config`. Tools default to `~/.local/bin` which becomes `/config/.local/bin`. When users mount `-v /config:/config`, this directory gets shadowed.

Solution: Install tools to `/opt/envhaven/bin/` which is never mounted over. Users can override by installing to `/config/.local/bin/` (higher PATH priority).

## Extension Development

### Live Development Workflow

```bash
eh    # Press 'w' for Watch Extension
```

Edit files in `extension/`; changes auto-compile and reinstall. Reload the browser to see updates.

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
| `init-env-compat-run` | Compatibility shim for legacy container environments; no self-hosted configuration |
| `init-extensions-run` | Symlink pre-installed extensions; on first boot only (marked by `/config/.extensions-installed`) fetch the GitHub theme from Open VSX |
| `init-vscode-settings-run` | Apply VS Code settings |
| `init-agents-md-run` | Generate AGENTS.md |
| `init-agent-config-run` | Seed AI agent configs (Claude, Codex) |
| `init-user-config-run` | Configure git, SSH, and user shell; create `/config/artifacts` |
| `init-zsh-config-run` | Configure zsh, add the `.zshrc` credential store hook, and migrate legacy EnvHaven-owned rc exports into the managed credential store. Each failure is logged and startup continues, because code-server, sshd and the console wait on it |
| `svc-sshd-run` | Run SSH daemon |
| `svc-cloudflared-run` | Cloudflare tunnel (if `CLOUDFLARE_TUNNEL_TOKEN` set) |
| `svc-console-run` | In-container console server (:7681): the browser terminal and the `/__console/` HTTP API, documented in `configuration.md` |
| `svc-console-finish` | s6 finish script for the console service |

Runtime executables:

| Script | Installed to | Command | Purpose |
|--------|--------------|---------|---------|
| `envhaven-status` | `/opt/envhaven/bin/` | `envhaven` | Workspace status banner; ready tool names come from `envhaven-console --ready-tools` |
| `envhaven-tool-launcher` | `/usr/local/lib/envhaven/` with links in `/opt/envhaven/wrappers/` | Each catalog tool with `launchArgs` | Apply catalog-declared launch defaults in interactive and non-interactive shells; the build derives the links from the catalog |
| `envhaven-prepare-antigravity` | `/usr/local/lib/envhaven/` with a PATH link | - | Preserve settings while selecting Gemini for key auth |
| `envhaven-install-rc-hook` | `/usr/local/lib/envhaven/` | - | Atomically keep one EnvHaven line in `.bashrc` (the bash additions) or at the end of `.zshrc` (the credential store, for zsh that never runs the Oh My Zsh drop-in) |
| `claude-auth-helper` | `/opt/envhaven/bin/` | - | Claude's `authCommand` in `tool-definitions.json` |
| `envhaven-version-check` | `/opt/envhaven/bin/` | - | Image version check |
| `tmux-copy-hint` | `/opt/envhaven/bin/` | - | Copy-mode hint shown in tmux |
| `envhaven-welcome.sh` | `/defaults/` | - | Shell init (auto-attach), sourced by the bash and zsh rc additions |
| `bashrc-additions` | `/defaults/` | - | Bash rc additions: sources `envhaven-welcome.sh`, then the managed credential store, so the tmux server the welcome starts never inherits stored keys |
| `zshrc-additions` | `/defaults/` | - | Oh My Zsh drop-in: selects the EnvHaven theme over the stock default, then sources `envhaven-welcome.sh` and the managed credential store, in that order, so the tmux server the welcome starts never inherits stored keys |

## GitHub Actions

CI/CD is split across three workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Pull requests, plus called by `docker.yml` on every push and tag | Test suite: `cli`, `image`, `extension`, and `console` jobs |
| `docker.yml` | Push to `master`, `v*` tags | Build and push the image to GitHub Container Registry (`dev` on master; `X.Y.Z`, `X.Y` and `latest` on a tag) |
| `cli.yml` | `v*` tags (plus a `latest` artifact on `master`) | Build and release Haven CLI binaries |

CI builds `linux/amd64` only, and each tag points at a single manifest rather than an index. Adding arm64 means restoring the push-by-digest build and the manifest-merge job `docker.yml` used to carry, plus an arch case for each of the two x86_64-pinned artefacts in the `Dockerfile`: the static docker binary and grok's release asset ([issue #1](https://github.com/envhaven/envhaven/issues/1)). Until then an arm64 build fails at grok's install step.

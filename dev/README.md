# EnvHaven Dev CLI (`eh`)

A delightful TUI for EnvHaven local development.

## Quick Start

```bash
cd envhaven/dev
bun run setup    # Install, build, and link globally
eh               # Launch TUI from anywhere
```

Or run scripts directly:

```bash
bun dev/scripts/build.ts      # Build image
bun dev/scripts/start.ts      # Start container
bun dev/scripts/test-image.ts # Run tests
```

## Features

- **Persistent TUI** - Menu always visible, logs stream in real-time
- **Keyboard shortcuts** - Press hotkeys for quick actions
- **Standalone scripts** - Same scripts work in TUI, CLI, and CI
- **Zero config** - Reads `.env.dev` automatically; an exported variable overrides it

## Keybindings

| Key | Action |
|-----|--------|
| `s` | Start Container (submenu: `s` start, `r` recreate, `d` delete) |
| `b` | Build Image |
| `w` | Watch Extension |
| `r` | Release (tag → Image + CLI) |
| `t` | Test (submenu: `i` validate image, `a` AI tools, `c` Haven CLI, `e` extension) |
| `l` | View Logs |
| `x` | Open Shell (SSH) |
| `,` | Settings |
| `?` | Help (keyboard shortcuts) |
| `↑/↓` | Navigate menu |
| `Enter` | Activate the highlighted item |
| `Esc` | Cancel / Back |
| `q` | Quit |

## Standalone Scripts

Most TUI actions are backed by standalone scripts in `scripts/`; a few (watch, release, shell, and
delete container) are implemented directly in `src/actions/`. The TUI's recreate is a delete
followed by `start.ts`; the script equivalent is `start.ts --fresh`. The table below is the
subset wired to a key; `scripts/README.md` lists all of them, including `extension-build.ts`,
`extension-install.ts`, `measure-tui.ts`, `test-console-echo.ts` and `test-console-ui.ts`:

| Script | TUI Key | Description |
|--------|---------|-------------|
| `build.ts` | `b` | Build Docker image |
| `start.ts` | `s` | Start test container |
| `stop.ts` | - | Stop test container |
| `logs.ts` | `l` | Stream container logs |
| `test-image.ts` | `t` → `i` | Validate image |
| `test-ai-tools.ts` | `t` → `a` | Verify all AI CLI tools |
| `test-cli.ts` | `t` → `c` | Test Haven CLI |
| `test-extension.ts` | `t` → `e` | Test extension build |

Run any script directly:

```bash
bun dev/scripts/build.ts --no-cache
bun dev/scripts/test-cli.ts --ci
```

See [scripts/README.md](scripts/README.md) for full documentation.

## Configuration

```bash
cp .env.example .env.dev
```

Precedence is exported variable, then this file, then the default, so a one-off override
needs no edit: `ENVHAVEN_IMAGE=envhaven:test bun scripts/test-image.ts`.

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVHAVEN_CONTAINER_NAME` | `envhaven-test` | Test container name |
| `ENVHAVEN_IMAGE` | `envhaven:dev` | Docker image tag |
| `ENVHAVEN_HOST` | `localhost` | Host for access URLs |
| `ENVHAVEN_WEB_PORT` | `8443` | Web UI port |
| `ENVHAVEN_SSH_PORT` | `2222` | SSH port |
| `ENVHAVEN_CONSOLE_PORT` | `7681` | Browser terminal port (opens when a password is set) |
| `ENVHAVEN_PASSWORD` | `test` | code-server / sudo password |
| `ENVHAVEN_HOST_REPO_PATH` | | Host path to repo (required for Watch Extension inside a container) |

## Development

```bash
bun install
bun run dev       # Run TUI in dev mode
bun run typecheck # Type check
bun run build     # Build for distribution
```

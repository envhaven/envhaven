# Contributing to EnvHaven

Thank you for your interest in contributing to EnvHaven!

## Quick Start

```bash
git clone https://github.com/envhaven/envhaven.git
cd envhaven/dev
bun run setup   # Install, build, and link globally
eh              # Launch development TUI
```

Press `b` to build, `s` to start container, `t` to test.

## Prerequisites

- Docker 20.10+
- [Bun](https://bun.sh) 1.1+ (for extension, CLI, and dev TUI)
- Git

## Repository Structure

The tree and the `runtime/` versus `dev/` distinction are in `docs/development.md` under
"Project Structure".

## Development Workflow

### Using the Dev TUI

```bash
cd dev && bun run setup   # One-time: install, build, link
eh                        # Launch development TUI from anywhere
```

The keys are listed in `dev/README.md` under "Keybindings"; `?` inside the TUI shows the
same list.

### Container State

Every start gives you a clean workspace, which is what you want when testing image changes. The image declares `VOLUME /config`, and the dev scripts pass no mount for it, so each `docker run` gets a fresh anonymous volume seeded from the image. Recreating the container therefore discards code-server settings, installed extensions, shell history, and any CLI logins.

A plain `docker stop` keeps all of it. What resets the workspace is `docker rm`, which is what `bun dev/scripts/stop.ts` and the TUI's recreate and delete actions all run.

To keep state across recreates, run the container yourself with a named volume, under a name the TUI does not manage:

```bash
docker run -d --name envhaven-persistent \
  -p 8443:8443 -p 2222:22 -p 7681:7681 \
  -e PASSWORD=test -e SUDO_PASSWORD=test \
  -v envhaven-dev-config:/config \
  envhaven:dev
```

### Configuration

For custom settings (different ports, host IP, etc.):

```bash
cp dev/.env.example dev/.env.dev
# Edit dev/.env.dev
```

## Extension Development

The EnvHaven VS Code extension provides the sidebar panel. We use **Bun** for all JavaScript development.

### Live Development (Recommended)

```bash
eh    # Then press 'w' for Watch Extension
```

Edit files → watcher rebuilds → reload browser.

### Manual Development

```bash
cd extension
bun install
bun run dev              # Watch mode

cd webview
bun install
bun run build            # Build React webview
```

### Extension Commands

The `bun run` targets are described in `docs/development.md` under "Extension Commands".

## Haven CLI Development

The Haven CLI is a Bun/TypeScript project.

```bash
cd cli
bun install
bun run dev connect .    # Run in dev mode
bun test                 # Run tests
bun run typecheck        # Type check
bun run build            # Build binary
```

See [cli/AGENTS.md](cli/AGENTS.md) for architecture.

## Making Changes

### Dockerfile Changes

The stages and their order are listed in `docs/development.md` under "Dockerfile Overview".

When adding new tools, follow existing patterns and add tests. The end-to-end
procedure (install ladder, catalog, composer seeding, harness registrations, platform
roster) is the runbook in `docs/architecture.md` under "Adding New Tools".

### Runtime Scripts

Scripts in `runtime/scripts/` run at container startup via s6-overlay, or are installed for
the user; both tables live in `docs/development.md` under "Runtime Scripts".

### Templates

- `runtime/templates/AGENTS.md.template` - Template for generated AGENTS.md
- `runtime/templates/settings.json` - VS Code settings
- `runtime/templates/tmux.conf` - Terminal session configuration

## Pull Request Guidelines

1. **Test your changes**
   ```bash
   # Via TUI
   eh   # Press 't' → select test type

   # Or run scripts directly
   bun dev/scripts/test-image.ts      # Validate image
   bun dev/scripts/test-extension.ts  # Test extension build
   bun dev/scripts/test-cli.ts --ci   # Test Haven CLI
   bun dev/scripts/test-console-ui.ts # Check the terminal page structure
   ```

2. **Update documentation** if adding features

3. **Keep commits focused** with clear messages

4. **Follow existing patterns** in the codebase

## Commit Convention (MANDATORY)

All commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

### Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, whitespace (no code change) |
| `refactor` | Code change that neither fixes nor adds |
| `perf` | Performance improvement |
| `test` | Adding or correcting tests |
| `build` | Build system or external dependencies |
| `ci` | CI configuration |
| `chore` | Maintenance tasks |
| `revert` | Reverts a previous commit |

### Scopes

Common scopes for this project:

- `cli` - Haven CLI
- `console` - In-container console server and terminal page
- `extension` - VS Code extension
- `docker` - Docker image / Dockerfile
- `dev` - Development tooling (eh TUI, scripts)
- `runtime` - Runtime scripts and templates
- `skills` - Bundled agent skills

### Examples

```
feat(cli): add connect command
fix(extension): resolve sidebar crash on reload
docs: update contributing guide
build(docker): add rust toolchain
chore: bump dependencies
```

### Rules

- Use lowercase for type and description
- No period at the end of description
- Keep description under 72 characters
- Use imperative mood ("add" not "added")
- Breaking changes: add `!` after type/scope (e.g., `feat(cli)!: change config format`)

## Code Style

- Shell scripts: Use `shellcheck` for linting
- TypeScript: Follow existing patterns
- Dockerfile: Comment each section, use multi-line for readability
- CLI TypeScript: Minimal comments, self-documenting code

## Reporting Issues

When reporting issues, please include:

- Docker version (`docker --version`)
- Host OS and architecture
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs (`docker logs envhaven`)

## Developing from within a Container

You can develop EnvHaven while running inside a container (like EnvHaven itself, code-server, or a DevContainer). This is common for "dogfooding" the environment.

Since the development scripts (invoked by the `eh` TUI) need to spawn *sibling* containers (like `envhaven-test`) alongside your current container, you must configure **Docker-in-Docker (DinD)** via socket mounting.

### 1. Enable Docker Socket Access

Your development container must have access to the host's Docker socket.

**Docker Compose:**
```yaml
services:
  envhaven:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # ... other volumes
```

**Docker CLI:**
```bash
docker run -v /var/run/docker.sock:/var/run/docker.sock ...
```

### 2. Configure the Host Address

The test container's ports are published on the host, so `localhost` inside your container does not reach them. Point the scripts at the host:

```bash
cp dev/.env.example dev/.env.dev
```

Edit `dev/.env.dev`:
```bash
# 'localhost' refers to your own container. Use the host's IP for access.
ENVHAVEN_HOST=192.168.1.50
```

No dev script mounts a host path, so nothing needs to know where the repository lives on the host: images are built from the build context the CLI sends, and the extension is packaged here and copied into the test container.

### 3. Run the Dev TUI

Now you can use the `eh` TUI as normal (which invokes the configured scripts):

```bash
eh
```

- **Build (`b`)**: Builds the image using the host's Docker daemon.
- **Start (`s`)**: Starts a sibling container on the host.
- **Watch (`w`)**: Packages the extension on each change and installs it into the running test container.

### Troubleshooting

**"Cannot connect to test container"**: Make sure `ENVHAVEN_HOST` is set to your host's IP address, not `localhost`. From inside a container, `localhost` refers to the container itself.

**Password issues**: Check `ENVHAVEN_PASSWORD` in `dev/.env.dev`. Default is `test`.

## Questions?

Open an issue for questions or join the discussion in existing issues.

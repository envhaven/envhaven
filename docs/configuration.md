# Configuration Reference

Complete reference for all EnvHaven configuration options.

## Environment Variables

### Core Settings

Inherited from [linuxserver/code-server](https://docs.linuxserver.io/images/docker-code-server):

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | 1000 | User ID for file permissions |
| `PGID` | 1000 | Group ID for file permissions |
| `TZ` | Etc/UTC | Timezone (e.g., `America/New_York`) |
| `PASSWORD` | - | Web GUI password. If not set, no auth required |
| `HASHED_PASSWORD` | - | Web GUI password hash (overrides `PASSWORD`) |
| `SUDO_PASSWORD` | - | Password for sudo and SSH login |
| `SUDO_PASSWORD_HASH` | - | Sudo password hash (overrides `SUDO_PASSWORD`) |
| `DEFAULT_WORKSPACE` | /config/workspace | Directory code-server opens by default |
| `PROXY_DOMAIN` | - | If set, enables proxy domain mode |

### EnvHaven Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVHAVEN_MANAGED` | false | Set to `true` only on managed hosting: switches the extension UI and the browser terminal's auth to platform JWT mode, which needs platform-injected credentials. Do not set when self-hosting. |
| `DEFAULT_SHELL` | bash | Set to `zsh` to use zsh as default shell |
| `HAVEN_IDLE_TIMEOUT` | - | Auto-disconnect Haven CLI sessions after idle period (e.g., `30m`, `2h`, `0` to disable) |
| `ENVHAVEN_SKIP_WELCOME` | - | Set to `1` to skip auto-attach to tmux on shell start |

> **Planned features:** `ENVHAVEN_AI_TOOLS` (tool filtering) and `ENVHAVEN_AI_EXTENSION` (VS Code AI extension selection) are not yet implemented.

### AI Tool API Keys

| Variable | Used By | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Claude Code, Aider, OpenCode | Anthropic API key (`sk-ant-...`) |
| `OPENAI_API_KEY` | Codex CLI, Aider | OpenAI API key (`sk-...`) |
| `GOOGLE_API_KEY` | Gemini CLI | Google AI API key |
| `MISTRAL_API_KEY` | Mistral Vibe | Mistral AI API key |

## SSH Configuration

SSH server runs on port 22 inside the container. Map it to an external port (e.g., 2222:22) in your Docker configuration.

### Password Authentication

SSH uses `SUDO_PASSWORD` (not `PASSWORD` which is for web GUI only):

```bash
ssh abc@localhost -p 2222
# Enter SUDO_PASSWORD when prompted
```

### Key-Based Authentication (Recommended)

**The easiest way**: Import your SSH public keys directly from GitHub! GitHub stores your public keys at `https://github.com/USERNAME.keys`.

```yaml
environment:
  - PUBLIC_KEY_URL=https://github.com/yourusername.keys
```

That's it! All your GitHub-registered SSH **public** keys are automatically added to `authorized_keys` on container startup.

**Other options:**

| Variable | Description |
|----------|-------------|
| `PUBLIC_KEY_URL` | **Recommended**: URL to fetch public keys (e.g., `https://github.com/username.keys`) |
| `PUBLIC_KEY` | Paste a single SSH public key directly |
| `PUBLIC_KEY_FILE` | Path to public key file inside container |
| `PUBLIC_KEY_DIR` | Directory containing multiple public key files |

You can also add keys via the EnvHaven extension sidebar (SSH Access section) or manually to `/config/.ssh/authorized_keys`.

### SSH Troubleshooting

**"Permission denied (publickey)"**:

1. **Key not in authorized_keys**: Verify your public key is in `/config/.ssh/authorized_keys`:
   ```bash
   docker exec envhaven cat /config/.ssh/authorized_keys
   ```

2. **Wrong file permissions**: SSH is strict about permissions. Fix with:
   ```bash
   docker exec envhaven bash -c "chmod 700 /config/.ssh && chmod 600 /config/.ssh/authorized_keys && chown -R abc:abc /config/.ssh"
   ```

3. **Passphrase-protected key**: The Haven CLI uses BatchMode which can't prompt for passphrases. Either:
   - Start ssh-agent and load your key: `eval $(ssh-agent) && ssh-add`
   - Or use a passphrase-less key (if you have no SSH keys, the CLI auto-generates `~/.ssh/haven_ed25519` for you)

**Debugging SSH**:

```bash
# Verbose SSH to see what's happening
ssh -v abc@<host> -p <port>

# Test BatchMode (what Haven CLI uses)
ssh -o BatchMode=yes abc@<host> -p <port> "echo ok"

# Check container SSH logs
docker logs envhaven 2>&1 | grep -i ssh
```

**Common issues:**
- Container not started or SSH service not running
- Port not mapped correctly (should be `2222:22` or similar)
- Firewall blocking the SSH port
- Key mismatch between local and `authorized_keys`
- User shell set to `/bin/false` (SSH authenticates but commands exit immediately - fixed automatically by EnvHaven's init scripts)
- Host key changed after workspace rebuild (Haven CLI auto-detects and prompts to reconnect)

### Connection String Configuration

The EnvHaven extension and welcome banner display an SSH connection command. **You must configure these variables** for the correct command to be shown:

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVHAVEN_SSH_HOST` | *none* (shows `<host>`) | **Required.** External hostname to reach container (e.g., `myserver.com`, `192.168.1.100`) |
| `ENVHAVEN_SSH_PORT` | 22 (managed) / 2222 (self-hosted) | External SSH port (e.g., `2222` if mapping `2222:22`) |

> **Note:** If `ENVHAVEN_SSH_HOST` is not set, the SSH command will show `<host>` placeholder with a warning.

**Self-hosted example:**

```yaml
environment:
  - PUBLIC_KEY_URL=https://github.com/yourusername.keys
  - ENVHAVEN_SSH_HOST=myserver.example.com
  - ENVHAVEN_SSH_PORT=2222
ports:
  - "2222:22"
```

With the above configuration:
- SSH command: `ssh abc@myserver.example.com -p 2222`
- Haven CLI: `haven connect . abc@myserver.example.com:2222`

**With a reverse proxy or tunnel:**

If you're using a reverse proxy (nginx, Caddy) or tunnel (Cloudflare, ngrok), set the appropriate external hostname:

```yaml
environment:
  - ENVHAVEN_SSH_HOST=ssh.mydomain.com
  - ENVHAVEN_SSH_PORT=22
```

> **Note:** If using Cloudflare, SSH must use a direct A record (not proxied) since Cloudflare doesn't proxy arbitrary TCP.

## Browser Terminal

Alongside the VS Code IDE, the container serves a standalone browser terminal on port **7681**. It is a full xterm.js terminal attached to the same shared tmux session as SSH and the IDE's integrated terminal, so a session you start in one place shows up in the others.

The terminal reuses your web password. It is gated by the same `PASSWORD` or `HASHED_PASSWORD` you already set for the IDE: log in once and the page connects. If you set neither, the terminal disables itself and port 7681 never opens, so a passwordless container never exposes a shell.

Publish the port and open the terminal in a browser:

```yaml
ports:
  - "7681:7681"   # browser terminal
```

Then visit `http://<host>:7681/` and enter your web password.

> **Put TLS in front.** The login submits your password and the terminal carries live shell traffic, so run port 7681 behind the same HTTPS reverse proxy or tunnel you use for the IDE. Over plain HTTP the password and session ride the wire in the clear, exactly as they would for code-server itself.

Briefly, how the auth works: a successful login sets a `SameSite=Strict`, `HttpOnly` session cookie scoped to `/__console`, valid for 12 hours. The page exchanges that cookie for a 60-second token and presents the token when it opens the WebSocket. The password never crosses the socket, and rotating it invalidates every issued cookie and token.

### Predictive echo

Over a distant or congested link the round trip between a keystroke and its echo is visible: you press a key, then wait a beat to see it appear. The terminal can hide that lag by painting each keystroke locally the moment you type it, then reconciling against the server's real output as it arrives. It is off by default. Add `?echo=1` to the URL to turn it on:

```
http://<host>:7681/__console/ui?echo=1
```

Without the parameter, or with `?echo=0`, the terminal shows only what the server sends, exactly as a normal SSH session does.

Predictive echo is built to stay away from secrets, and it fails toward caution. The server watches the active shell and withholds local echo during standard hidden prompts (`sudo`, `passwd`, `read -s`, and anything else that turns off terminal echo), while known secret readers such as `gpg` and `pinentry` run in the foreground, and inside sessions it cannot see into (`ssh`, `docker`, a nested `tmux`). Any error on that path disables prediction rather than risking a guess.

One honest caveat. A program that draws its own masked password field while keeping the terminal in a mode indistinguishable from a normal editor, and that is not on the server's known-reader list, can have a typed character painted for a moment before the mask catches up. The list covers the common cases; if that residual risk matters for your threat model, leave predictive echo off.

Setting `ENVHAVEN_SKIP_WELCOME=1` disables predictive echo entirely. The safety gate watches the shared tmux session that shells normally auto-attach, and skipping the attach breaks that link, so the server refuses to predict rather than vouch for a pane it may not be showing.

## Docker Mods

EnvHaven uses LinuxServer.io's DOCKER_MODS system to install developer tools at startup.

**Default packages:**

- `ripgrep` (rg) - Fast text search
- `fd-find` (fd) - Fast file finder
- `jq` - JSON processor
- `sqlite3` - SQLite CLI
- `htop` - Process viewer
- `unzip` - Archive extraction
- `zsh` - Z shell
- `git` - Version control

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCKER_MODS` | `linuxserver/mods:universal-package-install\|linuxserver/mods:code-server-zsh` | Pipe-separated list of mods |
| `INSTALL_PACKAGES` | `ripgrep\|fd-find\|jq\|sqlite3\|htop\|unzip\|zsh\|git` | Apt packages to install |
| `INSTALL_PIP_PACKAGES` | - | Pip packages to install |

**Adding more packages:**

```yaml
environment:
  # Note: This REPLACES defaults, so include base packages
  - INSTALL_PACKAGES=ripgrep|fd-find|jq|sqlite3|htop|unzip|zsh|git|neovim|tmux
```

> Packages are installed on first container start, adding ~60 seconds to initial startup.

## Volumes

| Path | Description |
|------|-------------|
| `/config` | All persistent data (workspace, settings, extensions, SSH keys) |
| `/config/workspace` | Your project files |

## Ports

### EnvHaven Services (always available)

| Port | Service |
|------|---------|
| 8443 | code-server (VS Code in browser) |
| 7681 | Browser terminal (opens only when a web password is set) |
| 22 | SSH access |

### User Application Ports (optional)

These ports are commonly used for development servers. They are **not exposed by default** in the Dockerfile but can be published in your docker-compose.yml as needed:

| Port | Common Use |
|------|------------|
| 3000 | Next.js, Create React App, Express |
| 5173 | Vite dev server |
| 8080 | Alternative app port |

> **Note:** If you run a dev server inside the container, it must bind to `0.0.0.0` (not `localhost`) for published ports to be reachable from outside the container.

## Docker Compose Example

**Quick Start:**
1. Copy `.env.example` to `.env`: `cp .env.example .env`
2. Edit `.env` with your passwords and API keys
3. Run: `docker compose up -d`

```yaml
services:
  envhaven:
    image: ghcr.io/envhaven/envhaven:latest
    container_name: envhaven
    restart: unless-stopped
    ports:
      - "8443:8443"   # code-server web UI
      - "2222:22"     # SSH access
      # - "7681:7681" # browser terminal (needs PASSWORD or HASHED_PASSWORD)
      # Optional: Uncomment for dev server ports (bind to localhost for security)
      # - "127.0.0.1:3000:3000"   # Common app dev port
      # - "127.0.0.1:5173:5173"   # Vite dev server
    volumes:
      - envhaven-config:/config
    env_file:
      - .env

volumes:
  envhaven-config:
```

See `.env.example` in the repository for all available environment variables.

> **Upgrading from a pre-1.x compose file?** Early copies of `docker-compose.yml` mounted the volume as `envhaven-files` while declaring `envhaven-config`, which Compose rejects; if you fixed that locally by renaming the declaration, your data lives in a volume named `<project>_envhaven-files`. Either keep your local name, or migrate once with the container stopped:
>
> ```bash
> docker compose down
> docker run --rm -v <project>_envhaven-files:/from -v <project>_envhaven-config:/to alpine cp -a /from/. /to/
> docker compose up -d
> ```

## Development Configuration

These settings are only relevant if you're developing EnvHaven itself (not just using it).

### Path Translation for Docker-in-Docker

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVHAVEN_HOST_REPO_PATH` | - | Absolute path to the repository on the **host** filesystem. |

**Required when:** Running the dev scripts (via `eh`) from inside a container (e.g., EnvHaven, DevContainer).

**Purpose:** Enables the host Docker daemon to mount files from your workspace into sibling containers. Since the daemon cannot see files inside your container, you must provide the path as it exists on the host.

**Example:**
```bash
# dev/.env.dev
ENVHAVEN_HOST_REPO_PATH=/home/user/data/workspace/envhaven
```

See [CONTRIBUTING.md](../CONTRIBUTING.md#developing-from-within-a-container) for the full setup guide.

## Password Hashing

To use hashed passwords instead of plaintext:

```bash
# For HASHED_PASSWORD (web GUI)
echo -n "password" | npx argon2-cli -e

# For SUDO_PASSWORD_HASH (sudo/SSH)
# Use standard Linux password hash format: $type$salt$hashed
openssl passwd -6 -salt xyz yourpassword
```

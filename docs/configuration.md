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
| `ENVHAVEN_MANAGED` | false | Set to `true` for managed hosting mode (affects extension UI) |
| `ENVHAVEN_DISABLE_WEBUI` | false | Set to `true` to disable the web UI (code-server). SSH access remains available. |
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

### EnvHaven Services

| Port | Service |
|------|---------|
| 8443 | code-server (VS Code in browser) |
| 22 | SSH access |

> **Note:** The web UI can be disabled with `ENVHAVEN_DISABLE_WEBUI=true` for SSH-only deployments.

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

### SSH-Only Mode

For security-focused deployments where you only need terminal access (no web UI):

```yaml
services:
  envhaven:
    image: ghcr.io/envhaven/envhaven:latest
    container_name: envhaven
    restart: unless-stopped
    ports:
      - "2222:22"     # SSH access only
    volumes:
      - envhaven-config:/config
    environment:
      - ENVHAVEN_DISABLE_WEBUI=true
      - SUDO_PASSWORD=yourpassword
      - PUBLIC_KEY_URL=https://github.com/yourusername.keys

volumes:
  envhaven-config:
```

This disables the code-server web UI entirely. Access your environment via SSH or the Haven CLI.

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

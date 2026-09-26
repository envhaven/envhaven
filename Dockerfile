# EnvHaven Dockerfile - Batteries-included environments for AI agents
# Compatible with legacy Docker builder (no BuildKit required)

# ============================================
# STAGE 1: Build EnvHaven VS Code Extension
# ============================================
FROM oven/bun:1.3.5-alpine AS extension-builder

RUN apk add --no-cache nodejs npm

WORKDIR /extension

COPY extension/package.json extension/bun.lock* ./
RUN bun install --frozen-lockfile

COPY extension/webview/package.json extension/webview/bun.lock* ./webview/
RUN cd webview && bun install --frozen-lockfile

COPY extension/ ./
COPY tool-definitions.json ../tool-definitions.json
COPY platform-tool-catalog.generated.ts ../platform-tool-catalog.generated.ts

RUN bun run package

# ============================================
# STAGE 1b: Build in-container console server
# ============================================
# Keep this on a security-supported Go line (go.dev/doc/devel/release): the
# stdlib compiled into the binary comes from THIS toolchain, and the console is
# a network-exposed HTTP server. go.mod's `go 1.22` directive is the language
# minimum and stays put (pump.go's idle timer documents the semantics it pins);
# the toolchain here should track current.
FROM golang:1.26 AS console-builder

WORKDIR /console

COPY console/go.mod console/go.sum ./
RUN go mod download

COPY tool-definitions.json /tool-definitions.json
COPY console/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/envhaven-console .

# ============================================
# STAGE 2: Main EnvHaven Image
# ============================================
FROM linuxserver/code-server:latest

# Version tracking for updates lives at the END of this stage. See the note there.

LABEL maintainer="EnvHaven Team"
LABEL org.opencontainers.image.source="https://github.com/envhaven/envhaven"
LABEL org.opencontainers.image.description="Batteries-included environments for AI agents"
LABEL org.opencontainers.image.licenses="MIT"

# ============================================
# System Dependencies
# ============================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    ca-certificates \
    gnupg \
    openssh-server \
    gettext-base \
    unzip \
    xz-utils \
    musl \
    ripgrep \
    jq \
    sqlite3 \
    htop \
    git \
    zsh \
    tmux \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ============================================
# Docker CLI (optional, for socket-mounted Docker access)
# ============================================
ARG INSTALL_DOCKER=true
ENV INSTALL_DOCKER=$INSTALL_DOCKER
RUN if [ "$INSTALL_DOCKER" = "true" ]; then \
      curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
      | tar xz --strip-components=1 -C /usr/local/bin docker/docker; \
    fi

# ============================================
# SSH Server Configuration
# ============================================
RUN mkdir -p /var/run/sshd && \
    ssh-keygen -A && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config

# ============================================
# Tool installation directory (survives /config mount)
# ============================================
# Created empty and owned by 1000:1000 before anything is installed into them, so every tool
# below lands with its final ownership already correct. This replaces a
# `chown -R 1000:1000 /mise /opt/envhaven` that used to sit after all the installs; the
# ownership sweep at the end of this stage records what that recursive chown cost.
#
# /config is chowned too because the installers below write through $HOME before moving their
# binaries into place. It is nearly empty at build time, and runtime/scripts/init-user-config-run
# chowns /config/.local, /config/.config and /config/.cache to PUID/PGID at every boot.
RUN mkdir -p /opt/envhaven/bin /opt/envhaven/wrappers /opt/envhaven/uv-tools /opt/envhaven/claude-home /mise && \
    chown -R 1000:1000 /opt/envhaven /mise /config

# ============================================
# mise - Single tool manager for everything
# ============================================
ENV MISE_DATA_DIR="/mise"
ENV MISE_CONFIG_DIR="/mise"
ENV MISE_CACHE_DIR="/mise/cache"
ENV MISE_STATE_DIR="/mise/state"
ENV PATH="/mise/shims:$PATH"

# Still root: the symlink lands in /usr/local/bin. MISE_INSTALL_PATH is the installer's own
# knob for where the binary goes, so it lands in /opt/envhaven/bin directly instead of being
# moved out of $HOME/.local/bin afterwards. The installer chowns it 0:0 when it runs as root,
# so only the one binary needs re-owning, and doing it in the same layer that created it costs
# nothing.
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/opt/envhaven/bin/mise sh && \
    ln -sf /opt/envhaven/bin/mise /usr/local/bin/mise && \
    chown 1000:1000 /opt/envhaven/bin/mise

COPY --chown=1000:1000 mise.toml /mise/config.toml

# Everything from here to the console binary installs into /mise or /opt/envhaven, which
# 1000:1000 already owns; running as that uid is what keeps it that way.
#
# Numeric on purpose. The LinuxServer base creates `abc` as uid 911 / gid 1001 and only remaps
# it to PUID/PGID at container start, so `USER abc` here would write 911:1001 and the runtime
# would never fix it. The flip side is that uid 1000 has no passwd entry, so nothing in the
# build may depend on getpwuid: HOME comes from the base image's own env (it sets
# HOME=/config), which Docker carries across USER unchanged, not from a passwd lookup.
USER 1000:1000

RUN mise trust /mise/config.toml && mise install

ENV RUSTUP_HOME="/opt/envhaven/rustup"
ENV CARGO_HOME="/opt/envhaven/cargo"
ENV PATH="/opt/envhaven/cargo/bin:$PATH"
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path

ENV UV_TOOL_DIR="/opt/envhaven/uv-tools"
ENV UV_TOOL_BIN_DIR="/opt/envhaven/bin"
ENV PATH="/opt/envhaven/bin:$PATH"
# User-space overrides win: /config is the mounted volume, so anything a user (or a
# tool's self-updater, e.g. Claude Code's) installs into /config/.local/bin shadows
# the image-baked copy and persists across restarts. Empty at build time.
ENV PATH="/config/.local/bin:/opt/envhaven/wrappers:$PATH"
# Every install below empties its own download cache before the RUN ends, the same way the
# apt lists go at the top of this stage. $HOME is /config, so npm caches into /config/.npm and
# uv into /config/.cache/uv — a gigabyte of tarballs committed to a layer, pulled on every
# image fetch, and then shadowed the instant a workspace volume mounts over /config. A later
# cleanup RUN cannot take it back, because the layer holding it is already written. The cache
# LOCATIONS stay at their defaults on purpose: at runtime they belong on the user's volume.
# Python CLI agents via uv: mistral-vibe, hermes-agent (Nous Research's Hermes)
RUN uv tool install mistral-vibe && uv tool install hermes-agent && \
    uv cache clean

RUN npm install -g pnpm yarn && npm cache clean --force
RUN npm install -g @openai/codex @qwen-code/qwen-code && npm cache clean --force
RUN npm install -g @ampcode/cli && npm cache clean --force
# Pi's docs prescribe --ignore-scripts (the package needs no install scripts)
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent && npm cache clean --force
RUN npm install -g openclaw && npm cache clean --force

# ============================================
# Playwright (Chromium only for browser automation)
# ============================================
ENV PLAYWRIGHT_BROWSERS_PATH="/opt/envhaven/playwright"
RUN npm install -g playwright && npm cache clean --force
# `--with-deps` is two jobs in one: apt system libraries, which need root, and the browser
# download, which belongs to 1000:1000 like the rest of /opt/envhaven. Split so neither needs
# a chown afterwards; the apt half runs in the root tail below, where it costs no extra USER
# switch and nothing between here and there needs a browser to run.
RUN playwright install chromium

# Vendor installers only (kiro, droid, agy, grok, muse): the first four drop into $HOME, which is
# /config here and therefore shadowed the moment a workspace volume mounts over it, so their
# binaries are moved out. A move that misses fails on the line that caused it; a silenced one
# would only surface at the --version gate, and /config/.local/bin is first on PATH, so the gate
# would not even notice a binary left behind there. Muse accepts its permanent destination.
RUN curl -fsSL https://cli.kiro.dev/install | bash && \
    mv /config/.local/bin/kiro* /opt/envhaven/bin/
RUN curl -fsSL https://app.factory.ai/cli | sh && \
    mv /config/.local/bin/droid /opt/envhaven/bin/
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash && \
    mv /config/.local/bin/agy /opt/envhaven/bin/agy
# Grok's ~/.grok/bin/{grok,agent} are symlinks into ~/.grok/downloads, so the download is what
# moves; carrying the link would leave a dangling binary. `agent` is the same executable under a
# name too generic to put on a shared PATH, and `grok agent` is the subcommand that does the job.
# The installer also links both names from ~/.local/bin (first on PATH) into ~/.grok/bin and
# writes a fish completion, all of which point at what is removed here, so they go too.
RUN curl -fsSL https://x.ai/cli/install.sh | bash && \
    mv /config/.grok/downloads/grok-linux-x86_64 /opt/envhaven/bin/grok && \
    rm -rf /config/.grok /config/.local/bin/grok /config/.local/bin/agent /config/.config/fish
# Muse's launcher stages a versioned binary, verifies its declared size and SHA-256, then
# switches the version marker by rename. It updates the launcher itself by a checked rename too,
# so an interrupted background update leaves the current launcher and binary intact.
RUN MUSE_INSTALL_DIR=/opt/envhaven/bin bash -o pipefail -c \
    'curl -fsSL https://dev.meta.ai/install.sh | bash'
# Give every defaulted launcher one stable image-baked real path. The wrappers
# live in a separate earlier PATH directory, so they cannot recurse and a user
# executable in /config/.local/bin still wins.
RUN ln -s /mise/shims/kimi /opt/envhaven/bin/kimi
# Claude Code via its native installer: versioned binaries plus an atomic symlink flip
# (.local/share/claude/versions/<v> ← .local/bin/claude), so an interrupted self-update
# can never orphan the launcher — the npm-global install this replaces bricked its mise
# shim exactly that way when an update died between npm's delete and rename. At runtime
# the updater writes new versions under /config/.local (first on PATH), so updates
# apply per-workspace and persist; this baked copy is the always-working baseline.
RUN HOME=/opt/envhaven/claude-home bash -o pipefail -c 'curl -fsSL https://claude.ai/install.sh | bash -s -- stable' && \
    ln -s /opt/envhaven/claude-home/.local/bin/claude /opt/envhaven/bin/claude

# In-container console server (loopback terminal behind the /__console tunnel rule)
COPY --from=console-builder --chown=1000:1000 /out/envhaven-console /opt/envhaven/bin/envhaven-console

# Back to root: everything below writes to /etc, /app and /usr, none of which belongs to the
# workspace user. /mise and /opt/envhaven are already 1000:1000 and need no further work.
USER root

# The apt half of playwright's `--with-deps`, deferred from the download above so the
# 1000:1000 stage stays one contiguous block. install-deps runs its own apt-get update, and
# the lists are gone since the top of this stage, so it fetches what it needs and cleans up.
RUN playwright install-deps chromium && rm -rf /var/lib/apt/lists/*

# ============================================
# VS Code Extension
# ============================================
COPY --from=extension-builder /extension/envhaven.vsix /tmp/envhaven.vsix

RUN mkdir -p /app/pre-installed-extensions && \
    /app/code-server/bin/code-server \
        --extensions-dir /app/pre-installed-extensions \
        --install-extension /tmp/envhaven.vsix && \
    rm /tmp/envhaven.vsix

# ============================================
# s6 Services
# ============================================
RUN mkdir -p /etc/s6-overlay/s6-rc.d/init-env-compat/dependencies.d \
             /etc/s6-overlay/s6-rc.d/init-extensions/dependencies.d \
             /etc/s6-overlay/s6-rc.d/init-vscode-settings/dependencies.d \
             /etc/s6-overlay/s6-rc.d/init-agents-md/dependencies.d \
             /etc/s6-overlay/s6-rc.d/init-agent-config/dependencies.d \
             /etc/s6-overlay/s6-rc.d/init-user-config/dependencies.d \
             /etc/s6-overlay/s6-rc.d/init-zsh-config/dependencies.d \
             /etc/s6-overlay/s6-rc.d/svc-sshd/dependencies.d \
             /etc/s6-overlay/s6-rc.d/svc-cloudflared/dependencies.d \
             /etc/s6-overlay/s6-rc.d/svc-console/dependencies.d \
             /etc/s6-overlay/s6-rc.d/user/contents.d

COPY runtime/scripts/init-env-compat-run /etc/s6-overlay/s6-rc.d/init-env-compat/run
COPY runtime/scripts/init-extensions-run /etc/s6-overlay/s6-rc.d/init-extensions/run
COPY runtime/scripts/init-vscode-settings-run /etc/s6-overlay/s6-rc.d/init-vscode-settings/run
COPY runtime/scripts/init-agents-md-run /etc/s6-overlay/s6-rc.d/init-agents-md/run
COPY runtime/scripts/init-user-config-run /etc/s6-overlay/s6-rc.d/init-user-config/run
COPY runtime/scripts/init-agent-config-run /etc/s6-overlay/s6-rc.d/init-agent-config/run
COPY runtime/scripts/init-zsh-config-run /etc/s6-overlay/s6-rc.d/init-zsh-config/run
COPY runtime/scripts/svc-sshd-run /etc/s6-overlay/s6-rc.d/svc-sshd/run
COPY runtime/scripts/svc-cloudflared-run /etc/s6-overlay/s6-rc.d/svc-cloudflared/run
COPY runtime/scripts/svc-console-run /etc/s6-overlay/s6-rc.d/svc-console/run
COPY runtime/scripts/svc-console-finish /etc/s6-overlay/s6-rc.d/svc-console/finish

RUN for svc in init-env-compat init-extensions init-vscode-settings init-agents-md init-agent-config init-user-config init-zsh-config; do \
        echo "oneshot" > /etc/s6-overlay/s6-rc.d/$svc/type && \
        echo "/etc/s6-overlay/s6-rc.d/$svc/run" > /etc/s6-overlay/s6-rc.d/$svc/up && \
        chmod +x /etc/s6-overlay/s6-rc.d/$svc/run && \
        touch /etc/s6-overlay/s6-rc.d/$svc/dependencies.d/init-adduser && \
        touch /etc/s6-overlay/s6-rc.d/user/contents.d/$svc; \
    done && \
    echo "longrun" > /etc/s6-overlay/s6-rc.d/svc-sshd/type && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-sshd/run && \
    touch /etc/s6-overlay/s6-rc.d/svc-sshd/dependencies.d/init-user-config && \
    touch /etc/s6-overlay/s6-rc.d/svc-sshd/dependencies.d/init-zsh-config && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-sshd && \
    echo "longrun" > /etc/s6-overlay/s6-rc.d/svc-cloudflared/type && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-cloudflared/run && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-cloudflared && \
    echo "longrun" > /etc/s6-overlay/s6-rc.d/svc-console/type && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-console/run && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-console/finish && \
    touch /etc/s6-overlay/s6-rc.d/svc-console/dependencies.d/init-user-config && \
    touch /etc/s6-overlay/s6-rc.d/svc-console/dependencies.d/init-zsh-config && \
    touch /etc/s6-overlay/s6-rc.d/svc-console/dependencies.d/init-env-compat && \
    touch /etc/s6-overlay/s6-rc.d/init-agents-md/dependencies.d/init-env-compat && \
    touch /etc/s6-overlay/s6-rc.d/init-zsh-config/dependencies.d/init-user-config && \
    touch /etc/s6-overlay/s6-rc.d/init-zsh-config/dependencies.d/init-mods-end && \
    touch /etc/s6-overlay/s6-rc.d/svc-code-server/dependencies.d/init-env-compat && \
    touch /etc/s6-overlay/s6-rc.d/svc-code-server/dependencies.d/init-zsh-config && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-console

# ============================================
# Branding & UI Customization
# ============================================
RUN PRODUCT_JSON="/app/code-server/lib/vscode/product.json" && \
    if [ -f "$PRODUCT_JSON" ]; then \
        cp "$PRODUCT_JSON" "${PRODUCT_JSON}.bak" && \
        jq '.nameShort = "EnvHaven" | .nameLong = "EnvHaven" | .applicationName = "envhaven"' \
            "${PRODUCT_JSON}.bak" > "$PRODUCT_JSON" && \
        rm "${PRODUCT_JSON}.bak"; \
    fi

COPY runtime/overrides/workbench-init.js /tmp/workbench-init.js
COPY runtime/overrides/workbench.css /tmp/workbench.css

RUN sed -i '/<head>/r /tmp/workbench-init.js' \
    /app/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.html && \
    cat /tmp/workbench.css >> \
    /app/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.css && \
    rm /tmp/workbench-init.js /tmp/workbench.css

# Favicon & PWA icons
COPY runtime/overrides/media/favicon.png /app/code-server/src/browser/media/favicon.png
COPY runtime/overrides/media/pwa-icon-192.png /app/code-server/src/browser/media/pwa-icon-192.png
COPY runtime/overrides/media/pwa-icon-512.png /app/code-server/src/browser/media/pwa-icon-512.png
COPY runtime/overrides/media/pwa-icon-192.png /app/code-server/lib/vscode/resources/server/code-192.png
COPY runtime/overrides/media/pwa-icon-512.png /app/code-server/lib/vscode/resources/server/code-512.png
COPY runtime/overrides/manifest.json /app/code-server/lib/vscode/resources/server/manifest.json

# Update HTML meta tags and favicon references
# The tool count in the workbench copy is read from the catalog, so adding a tool cannot
# leave it stale. The catalog lands here, ahead of the branding block that reads it.
COPY --chown=1000:1000 tool-definitions.json /opt/envhaven/tool-definitions.json
RUN TOOLS="$(jq -r '.tools | length' /opt/envhaven/tool-definitions.json)" && \
    WORKBENCH_HTML="/app/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.html" && \
    sed -i 's/content="Code"/content="EnvHaven"/' "$WORKBENCH_HTML" && \
    sed -i 's|href="{{BASE}}/_static/src/browser/media/favicon-dark-support.svg"|href="{{BASE}}/_static/src/browser/media/favicon.png"|' "$WORKBENCH_HTML" && \
    sed -i 's|href="{{BASE}}/_static/src/browser/media/favicon.ico" type="image/x-icon"|href="{{BASE}}/_static/src/browser/media/favicon.png" type="image/png"|' "$WORKBENCH_HTML" && \
    sed -i "/<meta charset=\"utf-8\"/a \    <meta name=\"description\" content=\"Your AI agent workspace. $TOOLS coding tools built-in. Full filesystem access.\" />" "$WORKBENCH_HTML" && \
    LOGIN_HTML="/app/code-server/src/browser/pages/login.html" && \
    sed -i 's|href="{{CS_STATIC_BASE}}/src/browser/media/favicon-dark-support.svg"|href="{{CS_STATIC_BASE}}/src/browser/media/favicon.png"|' "$LOGIN_HTML" && \
    sed -i 's|href="{{CS_STATIC_BASE}}/src/browser/media/favicon.ico"|href="{{CS_STATIC_BASE}}/src/browser/media/favicon.png"|' "$LOGIN_HTML" && \
    VSCODE_JS="/app/code-server/out/node/routes/vscode.js" && \
    sed -i "s|Run Code on a remote server.|Your AI agent workspace. $TOOLS coding tools built-in.|" "$VSCODE_JS"

# ============================================
# Templates & Defaults
# ============================================
COPY runtime/templates/settings.json /defaults/settings.json
COPY runtime/templates/tmux.conf /etc/tmux.conf
COPY runtime/templates/AGENTS.md.template /defaults/AGENTS.md.template
COPY runtime/templates/AGENTS.md.managed.template /defaults/AGENTS.md.managed.template
COPY runtime/templates/AGENTS.md.selfhosted.template /defaults/AGENTS.md.selfhosted.template
COPY runtime/scripts/envhaven-welcome.sh /defaults/envhaven-welcome.sh
COPY --chown=1000:1000 runtime/scripts/envhaven-status /opt/envhaven/bin/envhaven
COPY --chown=1000:1000 runtime/scripts/envhaven-version-check /opt/envhaven/bin/envhaven-version-check
COPY --chown=1000:1000 runtime/scripts/tmux-copy-hint /opt/envhaven/bin/tmux-copy-hint
COPY --chown=1000:1000 runtime/scripts/claude-auth-helper /opt/envhaven/bin/claude-auth-helper
COPY runtime/scripts/envhaven-tool-launcher /usr/local/lib/envhaven/envhaven-tool-launcher
COPY runtime/scripts/envhaven-prepare-antigravity /usr/local/lib/envhaven/envhaven-prepare-antigravity
COPY runtime/scripts/envhaven-install-rc-hook /usr/local/lib/envhaven/envhaven-install-rc-hook
COPY runtime/scripts/envhaven-repair-tool-ownership /usr/local/lib/envhaven/envhaven-repair-tool-ownership
COPY runtime/templates/claude-settings.json /defaults/claude-settings.json
COPY runtime/templates/claude-config.json /defaults/claude-config.json
COPY runtime/templates/codex-config.toml /defaults/codex-config.toml
COPY runtime/scripts/bashrc-additions /defaults/bashrc-additions
COPY runtime/scripts/zshrc-additions /defaults/zshrc-additions
COPY runtime/templates/zshenv /defaults/zshenv
COPY runtime/templates/envhaven.zsh-theme /defaults/envhaven.zsh-theme
# Every catalog tool with launchArgs gets a launcher link, read from the catalog so a new
# one cannot ship without its defaults. The assignment fails the RUN when jq does, an
# empty list fails it too, and so does a tool whose real executable is not where the
# launcher looks for it.
RUN chmod +x /defaults/envhaven-welcome.sh /opt/envhaven/bin/envhaven /opt/envhaven/bin/envhaven-version-check /opt/envhaven/bin/tmux-copy-hint /opt/envhaven/bin/claude-auth-helper /usr/local/lib/envhaven/* && \
    ln -s /usr/local/lib/envhaven/envhaven-prepare-antigravity /opt/envhaven/bin/envhaven-prepare-antigravity && \
    launchers="$(jq -r '.tools[] | select((.launchArgs // []) | length > 0) | .command' /opt/envhaven/tool-definitions.json)" && \
    [ -n "$launchers" ] && \
    for tool in $launchers; do \
        [ -x "/opt/envhaven/bin/$tool" ] && \
        ln -s /usr/local/lib/envhaven/envhaven-tool-launcher "/opt/envhaven/wrappers/$tool" || exit 1; \
    done && \
    chown root:root /opt/envhaven/wrappers

# ============================================
# Environment & Runtime Configuration
# ============================================
ENV PUID=1000
ENV PGID=1000
ENV TZ=Etc/UTC
ENV DEFAULT_WORKSPACE=/config/workspace
ENV ENVHAVEN_MANAGED=false
ENV PWA_APPNAME=EnvHaven

# Agent auto-approve: container IS the sandbox, permission prompts add zero value
ENV OPENCODE_PERMISSION="{\"*\":\"allow\"}"
# fx reads this as a process override and never writes it back to ~/.fx/settings.json, so
# `unset FX_PERMISSION_MODE` restores its default. That default is `auto`, which sends every
# unresolved tool call to a reviewer model and bills the request; `yolo` skips the check.
# The one-time yolo notice is a footer line fx acknowledges into settings.json by itself,
# not a prompt (measured on 0.0.6).
ENV FX_PERMISSION_MODE=yolo

# Single source of truth for environment (used by SSH, bash, zsh)
RUN echo 'PATH="/config/.local/bin:/opt/envhaven/wrappers:/opt/envhaven/bin:/opt/envhaven/cargo/bin:/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' > /etc/environment && \
    echo 'MISE_DATA_DIR="/mise"' >> /etc/environment && \
    echo 'MISE_CONFIG_DIR="/mise"' >> /etc/environment && \
    echo 'MISE_CACHE_DIR="/mise/cache"' >> /etc/environment && \
    echo 'MISE_STATE_DIR="/mise/state"' >> /etc/environment && \
    echo 'UV_TOOL_DIR="/opt/envhaven/uv-tools"' >> /etc/environment && \
    echo 'UV_TOOL_BIN_DIR="/opt/envhaven/bin"' >> /etc/environment && \
    echo 'RUSTUP_HOME="/opt/envhaven/rustup"' >> /etc/environment && \
    echo 'CARGO_HOME="/opt/envhaven/cargo"' >> /etc/environment

ENV DOCKER_MODS=linuxserver/mods:code-server-zsh

EXPOSE 8443
EXPOSE 22
EXPOSE 7681

VOLUME /config

# ============================================
# Verification
# ============================================
# AI tools verify from tool-definitions.json, so the roster cannot drift from it. The
# count floor fails the build when jq errors or the list is empty — a bare pipe exits 0
# having tested nothing (the project's "no pipe-masked exits" rule).
RUN node --version && \
    python3 --version && \
    go version && \
    rustc --version && \
    bun --version && \
    gh --version && \
    fd --version && \
    [ "$(jq -r '.tools | length' /opt/envhaven/tool-definitions.json)" -ge 12 ] && \
    jq -r '.tools[].command' /opt/envhaven/tool-definitions.json | while read -r cmd; do "$cmd" --version || exit 1; done && \
    ([ "$INSTALL_DOCKER" != "true" ] || docker --version) && \
    ffmpeg -version && \
    playwright --version && \
    /opt/envhaven/bin/envhaven-console --version

# Final ownership sweep. Deliberately AFTER the verification above, which runs every CLI as
# root: the Python ones recompile bytecode into their own package directories, so a sweep
# placed before it is undone by it. That is exactly what happened, and the image shipped
# 1,534 root-owned files, mostly __pycache__ under /opt/envhaven/uv-tools, which is where
# `uv tool upgrade` needs to write. Every install and COPY above already lands as 1000:1000,
# so that root-run verification is the only thing this has left to repair.
#
# `-uid 0` is what makes it cheap. Chowning a whole tree copies up every file it touches, and
# in its own layer that is how the old `chown -R 1000:1000 /mise /opt/envhaven` shipped a
# second complete copy of the toolchain: 2,358 MB of a 5,647 MB image, 42%, containing no new
# software. Touching only the files that are wrong copies up ~8 MB and keeps the guarantee
# these two trees exist for: installed tools are writable by the workspace user, so they can
# self-update at runtime. The wrapper directory is pruned because users override tools through
# /config/.local/bin; the shared launch policy itself stays image-owned. `-h` retargets a
# root-owned symlink itself rather than whatever it points at, and `-exec ... +` fails the RUN
# if any chown fails, which is the assertion.
#
# runtime/scripts/init-user-config-run re-applies the same ownership at every boot for a
# non-default PUID/PGID, so the two sweeps are one policy.
RUN find /mise /opt/envhaven -path /opt/envhaven/wrappers -prune -o -uid 0 -exec chown -h 1000:1000 {} +

# ============================================
# Version
# ============================================
# Last on purpose. An ENV whose value changes every build invalidates every layer built
# after it, and this used to sit as the second instruction of the stage, above 29 RUN
# steps that install the language runtimes, the npm globals, the uv tools and a browser.
# docker.yml passes a fresh `dev-<sha>` on each master push, so every commit rebuilt the
# whole image from the first apt-get down.
#
# Nothing in the build reads this value. The only consumer is the extension, which reads
# it out of the environment at runtime (extension/src/environment.ts), so it just has to
# be present in the final image.
ARG ENVHAVEN_VERSION=dev
ENV ENVHAVEN_VERSION=$ENVHAVEN_VERSION
LABEL org.opencontainers.image.version=$ENVHAVEN_VERSION

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8443/healthz || exit 1

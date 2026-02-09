# EnvHaven Dockerfile - Batteries-included environments for AI agents
# Compatible with legacy Docker builder (no BuildKit required)

# ============================================
# STAGE 1: Build EnvHaven VS Code Extension
# ============================================
FROM oven/bun:alpine AS extension-builder

RUN apk add --no-cache nodejs npm && npm install -g @vscode/vsce

WORKDIR /extension

COPY extension/package.json extension/bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY extension/webview/package.json extension/webview/bun.lock* ./webview/
RUN cd webview && (bun install --frozen-lockfile || bun install)

COPY extension/ ./
COPY tool-definitions.json ../tool-definitions.json

RUN bun run build && bun run build:webview && vsce package --out /extension/envhaven.vsix

# ============================================
# STAGE 2: Main EnvHaven Image
# ============================================
FROM linuxserver/code-server:latest

# Version tracking for updates
ARG ENVHAVEN_VERSION=dev
ENV ENVHAVEN_VERSION=$ENVHAVEN_VERSION

LABEL maintainer="EnvHaven Team"
LABEL org.opencontainers.image.source="https://github.com/envhaven/envhaven"
LABEL org.opencontainers.image.description="Batteries-included environments for AI agents"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version=$ENVHAVEN_VERSION

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
# SSH Server Configuration
# ============================================
RUN mkdir -p /var/run/sshd && \
    ssh-keygen -A && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config

# ============================================
# Tool installation directory (survives /config mount)
# ============================================
RUN mkdir -p /opt/envhaven/bin /opt/envhaven/uv-tools

# ============================================
# mise - Single tool manager for everything
# ============================================
ENV MISE_DATA_DIR="/mise"
ENV MISE_CONFIG_DIR="/mise"
ENV MISE_CACHE_DIR="/mise/cache"
ENV MISE_STATE_DIR="/mise/state"
ENV PATH="/mise/shims:$PATH"

RUN curl https://mise.run | sh && \
    mv /config/.local/bin/mise /opt/envhaven/bin/mise && \
    ln -sf /opt/envhaven/bin/mise /usr/local/bin/mise

COPY mise.toml /mise/config.toml
RUN mise trust /mise/config.toml && mise install

ENV RUSTUP_HOME="/opt/envhaven/rustup"
ENV CARGO_HOME="/opt/envhaven/cargo"
ENV PATH="/opt/envhaven/cargo/bin:$PATH"
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path

ENV UV_TOOL_DIR="/opt/envhaven/uv-tools"
ENV UV_TOOL_BIN_DIR="/opt/envhaven/bin"
ENV PATH="/opt/envhaven/bin:$PATH"
RUN uv tool install aider-chat && uv tool install mistral-vibe

RUN npm install -g pnpm yarn
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g @openai/codex @google/gemini-cli @qwen-code/qwen-code
RUN npm install -g @sourcegraph/amp @augmentcode/auggie

# ============================================
# Playwright (Chromium only for browser automation)
# ============================================
ENV PLAYWRIGHT_BROWSERS_PATH="/opt/envhaven/playwright"
RUN npm install -g playwright
RUN playwright install --with-deps chromium

RUN curl -fsSL https://cli.kiro.dev/install | bash && \
    mv /config/.local/bin/kiro* /opt/envhaven/bin/ 2>/dev/null || true
RUN curl -fsSL https://app.factory.ai/cli | sh && \
    mv /config/.local/bin/droid /opt/envhaven/bin/ 2>/dev/null || true

# Fix permissions so all tools can auto-update at runtime (user abc, uid=1000)
# /mise: node, python, go, bun, gh, fd, opencode, uv, goose, cloudflared
# /opt/envhaven: rustup, cargo, uv-tools, playwright, kiro, droid, envhaven CLI
RUN chown -R 1000:1000 /mise /opt/envhaven

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
RUN mkdir -p /etc/s6-overlay/s6-rc.d/init-extensions/dependencies.d \
             /etc/s6-overlay/s6-rc.d/init-vscode-settings/dependencies.d \
             /etc/s6-overlay/s6-rc.d/init-agents-md/dependencies.d \
             /etc/s6-overlay/s6-rc.d/init-user-config/dependencies.d \
             /etc/s6-overlay/s6-rc.d/init-zsh-config/dependencies.d \
             /etc/s6-overlay/s6-rc.d/svc-sshd/dependencies.d \
             /etc/s6-overlay/s6-rc.d/svc-cloudflared/dependencies.d \
             /etc/s6-overlay/s6-rc.d/user/contents.d

COPY runtime/scripts/init-extensions-run /etc/s6-overlay/s6-rc.d/init-extensions/run
COPY runtime/scripts/init-vscode-settings-run /etc/s6-overlay/s6-rc.d/init-vscode-settings/run
COPY runtime/scripts/init-agents-md-run /etc/s6-overlay/s6-rc.d/init-agents-md/run
COPY runtime/scripts/init-user-config-run /etc/s6-overlay/s6-rc.d/init-user-config/run
COPY runtime/scripts/init-zsh-config-run /etc/s6-overlay/s6-rc.d/init-zsh-config/run
COPY runtime/scripts/svc-sshd-run /etc/s6-overlay/s6-rc.d/svc-sshd/run
COPY runtime/scripts/svc-cloudflared-run /etc/s6-overlay/s6-rc.d/svc-cloudflared/run

RUN for svc in init-extensions init-vscode-settings init-agents-md init-user-config init-zsh-config; do \
        echo "oneshot" > /etc/s6-overlay/s6-rc.d/$svc/type && \
        echo "/etc/s6-overlay/s6-rc.d/$svc/run" > /etc/s6-overlay/s6-rc.d/$svc/up && \
        chmod +x /etc/s6-overlay/s6-rc.d/$svc/run && \
        touch /etc/s6-overlay/s6-rc.d/$svc/dependencies.d/init-adduser && \
        touch /etc/s6-overlay/s6-rc.d/user/contents.d/$svc; \
    done && \
    echo "longrun" > /etc/s6-overlay/s6-rc.d/svc-sshd/type && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-sshd/run && \
    touch /etc/s6-overlay/s6-rc.d/svc-sshd/dependencies.d/init-user-config && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-sshd && \
    echo "longrun" > /etc/s6-overlay/s6-rc.d/svc-cloudflared/type && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-cloudflared/run && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-cloudflared

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
RUN WORKBENCH_HTML="/app/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.html" && \
    sed -i 's/content="Code"/content="EnvHaven"/' "$WORKBENCH_HTML" && \
    sed -i 's|href="{{BASE}}/_static/src/browser/media/favicon-dark-support.svg"|href="{{BASE}}/_static/src/browser/media/favicon.png"|' "$WORKBENCH_HTML" && \
    sed -i 's|href="{{BASE}}/_static/src/browser/media/favicon.ico" type="image/x-icon"|href="{{BASE}}/_static/src/browser/media/favicon.png" type="image/png"|' "$WORKBENCH_HTML" && \
    sed -i '/<meta charset="utf-8"/a \    <meta name="description" content="Your AI agent workspace. 12+ coding tools built-in. Full filesystem access." />' "$WORKBENCH_HTML" && \
    LOGIN_HTML="/app/code-server/src/browser/pages/login.html" && \
    sed -i 's|href="{{CS_STATIC_BASE}}/src/browser/media/favicon-dark-support.svg"|href="{{CS_STATIC_BASE}}/src/browser/media/favicon.png"|' "$LOGIN_HTML" && \
    sed -i 's|href="{{CS_STATIC_BASE}}/src/browser/media/favicon.ico"|href="{{CS_STATIC_BASE}}/src/browser/media/favicon.png"|' "$LOGIN_HTML" && \
    VSCODE_JS="/app/code-server/out/node/routes/vscode.js" && \
    sed -i 's|Run Code on a remote server.|Your AI agent workspace. 12+ coding tools built-in.|' "$VSCODE_JS"

# ============================================
# Templates & Defaults
# ============================================
COPY runtime/templates/settings.json /defaults/settings.json
COPY runtime/templates/tmux.conf /etc/tmux.conf
COPY runtime/templates/AGENTS.md.template /defaults/AGENTS.md.template
COPY runtime/templates/AGENTS.md.managed.template /defaults/AGENTS.md.managed.template
COPY runtime/templates/AGENTS.md.selfhosted.template /defaults/AGENTS.md.selfhosted.template
COPY runtime/scripts/envhaven-welcome.sh /defaults/envhaven-welcome.sh
COPY runtime/scripts/envhaven-status /opt/envhaven/bin/envhaven
COPY runtime/scripts/envhaven-version-check /opt/envhaven/bin/envhaven-version-check
COPY runtime/scripts/tmux-copy-hint /opt/envhaven/bin/tmux-copy-hint
COPY tool-definitions.json /opt/envhaven/tool-definitions.json
COPY runtime/scripts/bashrc-additions /defaults/bashrc-additions
COPY runtime/scripts/zshrc-additions /defaults/zshrc-additions
RUN chmod +x /defaults/envhaven-welcome.sh /opt/envhaven/bin/envhaven /opt/envhaven/bin/envhaven-version-check /opt/envhaven/bin/tmux-copy-hint

# ============================================
# Environment & Runtime Configuration
# ============================================
ENV PUID=1000
ENV PGID=1000
ENV TZ=Etc/UTC
ENV DEFAULT_WORKSPACE=/config/workspace
ENV ENVHAVEN_MANAGED=false
ENV PWA_APPNAME=EnvHaven

# Single source of truth for environment (used by SSH, bash, zsh)
RUN echo 'PATH="/config/.local/bin:/opt/envhaven/bin:/opt/envhaven/cargo/bin:/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' > /etc/environment && \
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

VOLUME /config

# ============================================
# Verification
# ============================================
RUN node --version && \
    python3 --version && \
    go version && \
    rustc --version && \
    bun --version && \
    gh --version && \
    fd --version && \
    opencode --version && \
    aider --version && \
    goose --version && \
    kiro-cli --version && \
    droid --version && \
    ffmpeg -version && \
    playwright --version

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8443/healthz || exit 1

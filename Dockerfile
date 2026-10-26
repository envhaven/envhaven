# EnvHaven Dockerfile - Batteries-included environments for AI agents
# Compatible with legacy Docker builder (no BuildKit required)
#
# Every base image is pinned by digest, with its tag kept for readability (Docker ignores a tag
# next to a digest). A moving tag would make the release a different image from the one CI
# tested, with no way to rebuild or roll back to it. Dependabot proposes digest bumps
# (.github/dependabot.yml), so each one lands as a reviewed change.

# ============================================
# STAGE 1: Build EnvHaven VS Code Extension
# ============================================
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS extension-builder

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
# a network-exposed HTTP server. go.mod's `go 1.26.0` directive is the minimum
# that golang.org/x/crypto v0.57.0 requires; pump.go's idle timer is written to be
# correct under the Go 1.23+ timer semantics it brings. The toolchain here should
# track current.
FROM golang:1.26@sha256:672c944cfd07599b5f1bb179869270cdc94c6254e41db4d431259693cb286b82 AS console-builder

WORKDIR /console

COPY console/go.mod console/go.sum ./
RUN go mod download

COPY tool-definitions.json /tool-definitions.json
COPY console/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/envhaven-console .

# ============================================
# STAGE 2: Main EnvHaven Image
# ============================================
FROM linuxserver/code-server:latest@sha256:4524d0b00478e41264f42e0e660c1819e3b7d0c460f78ce73e44fa39b2b55134

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
# Checked against a recorded SHA-256 before extraction. --no-same-owner keeps the binary root's:
# the tarball records uid 1000, which would otherwise hand abc a writable file on root's PATH.
RUN if [ "$INSTALL_DOCKER" = "true" ]; then \
      curl -fsSL -o /tmp/docker.tgz https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz && \
      echo "4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640  /tmp/docker.tgz" | sha256sum -c - && \
      tar xzf /tmp/docker.tgz --no-same-owner --strip-components=1 -C /usr/local/bin docker/docker && \
      rm /tmp/docker.tgz; \
    fi

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

# The release tarball for a pinned version, checked against the SHA-256 mise publishes in its
# release's SHASUMS256.txt, rather than whatever script mise.run serves at build time. The binary
# belongs to 1000:1000 like the rest of /opt/envhaven, and nothing links it into /usr/local/bin:
# root's PATH holds nothing abc can write (as-abc explains), and abc finds it in /opt/envhaven/bin.
# mise's shims are symlinks to the binary itself, so they need no `mise` on PATH.
RUN curl -fsSL -o /tmp/mise.tar.gz https://github.com/jdx/mise/releases/download/v2026.9.14/mise-v2026.9.14-linux-x64.tar.gz && \
    echo "343b133839d6a1d6c92daca90c4dbf7981dc28de8d308e5198a4ef24df8f5338  /tmp/mise.tar.gz" | sha256sum -c - && \
    tar xzf /tmp/mise.tar.gz --no-same-owner -C /tmp mise/bin/mise && \
    install -o 1000 -g 1000 -m 0755 /tmp/mise/bin/mise /opt/envhaven/bin/mise && \
    rm -rf /tmp/mise /tmp/mise.tar.gz

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

RUN /opt/envhaven/bin/mise trust /mise/config.toml && /opt/envhaven/bin/mise install

ENV RUSTUP_HOME="/opt/envhaven/rustup"
ENV CARGO_HOME="/opt/envhaven/cargo"
ENV PATH="/opt/envhaven/cargo/bin:$PATH"
# rustup-init itself for a pinned rustup release, checked against the SHA-256 published beside
# it. It installs the stable toolchain, whose components rustup verifies against the channel
# manifest, and `rustup update` keeps working in the workspace.
RUN curl -fsSL -o /tmp/rustup-init https://static.rust-lang.org/rustup/archive/1.29.1/x86_64-unknown-linux-gnu/rustup-init && \
    echo "dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71  /tmp/rustup-init" | sha256sum -c - && \
    chmod +x /tmp/rustup-init && \
    /tmp/rustup-init -y --no-modify-path && \
    rm /tmp/rustup-init

ENV UV_TOOL_DIR="/opt/envhaven/uv-tools"
ENV UV_TOOL_BIN_DIR="/opt/envhaven/bin"
ENV PATH="/opt/envhaven/bin:$PATH"
# User-space overrides win: /config is the mounted volume, so anything a user (or a
# tool's self-updater, e.g. Claude Code's) installs into /config/.local/bin shadows
# the image-baked copy and persists across restarts. Empty at build time. This is the
# build's PATH and abc's (/etc/environment below), never root's at runtime: the end of
# this stage puts root back on the base image's PATH.
ENV PATH="/config/.local/bin:/opt/envhaven/wrappers:$PATH"
# Every install below empties its own download cache before the RUN ends, the same way the
# apt lists go at the top of this stage. $HOME is /config, so npm caches into /config/.npm and
# uv into /config/.cache/uv — a gigabyte of tarballs committed to a layer, pulled on every
# image fetch, and then shadowed the instant a workspace volume mounts over /config. A later
# cleanup RUN cannot take it back, because the layer holding it is already written. The cache
# LOCATIONS stay at their defaults on purpose: at runtime they belong on the user's volume.
# Python CLI agents via uv: mistral-vibe, hermes-agent (Nous Research's Hermes)
RUN uv tool install mistral-vibe==3.0.2 && uv tool install hermes-agent==0.19.0 && \
    uv cache clean

# npm packages are pinned to exact versions: a release built from `latest` would be whatever the
# registry served at that minute, which CI never tested and nobody chose. Bump them deliberately
# (`npm view <package> version`). Tools that self-update still do so at runtime; the update
# contract in docs/architecture.md is unchanged.
RUN npm install -g pnpm@12.6.0 yarn@1.22.22 && npm cache clean --force
RUN npm install -g @openai/codex@0.157.1 @qwen-code/qwen-code@0.24.6 && npm cache clean --force
RUN npm install -g @ampcode/cli@0.0.1790438457-ge61352 && npm cache clean --force
# Pi's docs prescribe --ignore-scripts (the package needs no install scripts)
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1 && npm cache clean --force
RUN npm install -g openclaw@2026.9.2 skills@1.7.4 && npm cache clean --force

# ============================================
# Playwright (Chromium only for browser automation)
# ============================================
ENV PLAYWRIGHT_BROWSERS_PATH="/opt/envhaven/playwright"
RUN npm install -g playwright@1.63.0 && npm cache clean --force
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
# Cloudflare Tunnel connector
# ============================================
# From Cloudflare's signed apt repository, whose signing key is checked against a recorded
# SHA-256 first, so apt verifies the package. It lands root-owned in /usr/bin, and svc-cloudflared
# runs it as its own unprivileged user: the connector holds the workspace's tunnel token, so
# nothing abc can write may sit in its path. Not pinned to a version: this is the network-facing
# daemon, and the build should take the newest release Cloudflare has signed.
#
# The user's only group is nogroup. A group of its own would get a GID from the top of the
# system range, which is where hosts allocate their docker group too (999 on many), and a match
# would put the connector in the group that owns a mounted Docker socket.
RUN curl -fsSL -o /usr/share/keyrings/cloudflare-main.gpg https://pkg.cloudflare.com/cloudflare-main.gpg && \
    echo "1bd95f4082b320d541bee351560fc2765aa9f9cd8efa4c9e32135e63f252721d  /usr/share/keyrings/cloudflare-main.gpg" | sha256sum -c - && \
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
        > /etc/apt/sources.list.d/cloudflared.list && \
    apt-get update && apt-get install -y --no-install-recommends cloudflared && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --system --no-user-group --gid nogroup --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin cloudflared

# ============================================
# Oh My Zsh
# ============================================
# A shallow checkout of one pinned commit, copied into a fresh volume at first boot by
# init-zsh-config-run. It replaces LinuxServer's code-server-zsh mod, which root downloaded and ran
# at every container start. Fetching the commit by hash pins its content, and the checkout keeps
# its origin, so `omz update` works in the workspace as it does after Oh My Zsh's own installer.
RUN git init -q /usr/share/envhaven/oh-my-zsh && \
    cd /usr/share/envhaven/oh-my-zsh && \
    git remote add origin https://github.com/ohmyzsh/ohmyzsh.git && \
    git fetch -q --depth 1 origin 60c9a7a839b790cd905d0fd4419435124fd1bdc0 && \
    git checkout -q -b master FETCH_HEAD && \
    git config oh-my-zsh.remote origin && \
    git config oh-my-zsh.branch master && \
    [ "$(git rev-parse HEAD)" = 60c9a7a839b790cd905d0fd4419435124fd1bdc0 ]

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
             /etc/s6-overlay/s6-rc.d/init-defaults-owner/dependencies.d \
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
COPY runtime/scripts/init-defaults-owner-run /etc/s6-overlay/s6-rc.d/init-defaults-owner/run
COPY runtime/scripts/init-extensions-run /etc/s6-overlay/s6-rc.d/init-extensions/run
COPY runtime/scripts/init-vscode-settings-run /etc/s6-overlay/s6-rc.d/init-vscode-settings/run
COPY runtime/scripts/init-agents-md-run /etc/s6-overlay/s6-rc.d/init-agents-md/run
COPY runtime/scripts/init-user-config-run /etc/s6-overlay/s6-rc.d/init-user-config/run
COPY runtime/scripts/init-agent-config-run /etc/s6-overlay/s6-rc.d/init-agent-config/run
COPY runtime/scripts/init-zsh-config-run /etc/s6-overlay/s6-rc.d/init-zsh-config/run
COPY runtime/scripts/svc-sshd-run /etc/s6-overlay/s6-rc.d/svc-sshd/run
COPY runtime/scripts/svc-cloudflared-run /etc/s6-overlay/s6-rc.d/svc-cloudflared/run
COPY runtime/scripts/svc-console-run /etc/s6-overlay/s6-rc.d/svc-console/run
COPY runtime/scripts/svc-finish /etc/s6-overlay/s6-rc.d/svc-console/finish
COPY runtime/scripts/svc-finish /etc/s6-overlay/s6-rc.d/svc-sshd/finish
COPY runtime/scripts/svc-finish /etc/s6-overlay/s6-rc.d/svc-cloudflared/finish

# LinuxServer's code-server service, replaced by a copy that starts code-server through as-abc
# (runtime/scripts/svc-code-server-run says what else differs). The original is checked first, so
# a base image that changes it stops the build until someone reconciles the two.
RUN echo "08cdbcab19676bcbb144f96cefe7e458cd069edfd81db2c868f1d4fc800f5130  /etc/s6-overlay/s6-rc.d/svc-code-server/run" | sha256sum -c -
COPY runtime/scripts/svc-code-server-run /etc/s6-overlay/s6-rc.d/svc-code-server/run

# Boot order. init-env-compat runs first, after LinuxServer's init-envfile has written any
# FILE__ secrets into the s6 environment, because it makes the root-only ones unreadable to abc.
# Everything that starts an abc process waits on it, and so does svc-cron, which runs abc's
# @reboot jobs. init-defaults-owner runs right after init-adduser hands /defaults to abc, and
# LinuxServer's init-crontab-config waits for it. The other oneshots also wait on
# init-config-end, LinuxServer's last step that writes in /config as root, so they never race it
# for files in abc's home. init-agents-md, init-extensions and init-vscode-settings wait on
# init-user-config as well: its root half hands back ~/workspace, ~/extensions and ~/data, which
# they write in, when LinuxServer has recreated one as root. code-server waits on the extension
# links and the settings they write, so it never starts on a half-linked extensions folder.
RUN for svc in init-env-compat init-defaults-owner init-extensions init-vscode-settings init-agents-md init-agent-config init-user-config init-zsh-config; do \
        echo "oneshot" > /etc/s6-overlay/s6-rc.d/$svc/type && \
        echo "/etc/s6-overlay/s6-rc.d/$svc/run" > /etc/s6-overlay/s6-rc.d/$svc/up && \
        chmod +x /etc/s6-overlay/s6-rc.d/$svc/run && \
        touch /etc/s6-overlay/s6-rc.d/$svc/dependencies.d/init-adduser && \
        touch /etc/s6-overlay/s6-rc.d/user/contents.d/$svc && \
        case "$svc" in \
            init-env-compat) touch /etc/s6-overlay/s6-rc.d/$svc/dependencies.d/init-envfile ;; \
            init-defaults-owner) ;; \
            *) touch /etc/s6-overlay/s6-rc.d/$svc/dependencies.d/init-env-compat \
                     /etc/s6-overlay/s6-rc.d/$svc/dependencies.d/init-config-end ;; \
        esac; \
    done && \
    touch /etc/s6-overlay/s6-rc.d/init-crontab-config/dependencies.d/init-defaults-owner && \
    for svc in svc-sshd svc-cloudflared svc-console; do \
        echo "longrun" > /etc/s6-overlay/s6-rc.d/$svc/type && \
        chmod +x /etc/s6-overlay/s6-rc.d/$svc/run /etc/s6-overlay/s6-rc.d/$svc/finish && \
        touch /etc/s6-overlay/s6-rc.d/$svc/dependencies.d/init-env-compat && \
        touch /etc/s6-overlay/s6-rc.d/user/contents.d/$svc; \
    done && \
    touch /etc/s6-overlay/s6-rc.d/svc-sshd/dependencies.d/init-user-config && \
    touch /etc/s6-overlay/s6-rc.d/svc-sshd/dependencies.d/init-zsh-config && \
    touch /etc/s6-overlay/s6-rc.d/svc-console/dependencies.d/init-user-config && \
    touch /etc/s6-overlay/s6-rc.d/svc-console/dependencies.d/init-zsh-config && \
    touch /etc/s6-overlay/s6-rc.d/init-zsh-config/dependencies.d/init-user-config && \
    touch /etc/s6-overlay/s6-rc.d/init-zsh-config/dependencies.d/init-mods-end && \
    touch /etc/s6-overlay/s6-rc.d/init-agents-md/dependencies.d/init-user-config && \
    touch /etc/s6-overlay/s6-rc.d/init-extensions/dependencies.d/init-user-config && \
    touch /etc/s6-overlay/s6-rc.d/init-vscode-settings/dependencies.d/init-user-config && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-code-server/run && \
    touch /etc/s6-overlay/s6-rc.d/svc-code-server/dependencies.d/init-env-compat && \
    touch /etc/s6-overlay/s6-rc.d/svc-code-server/dependencies.d/init-zsh-config && \
    touch /etc/s6-overlay/s6-rc.d/svc-code-server/dependencies.d/init-extensions && \
    touch /etc/s6-overlay/s6-rc.d/svc-code-server/dependencies.d/init-vscode-settings && \
    touch /etc/s6-overlay/s6-rc.d/svc-cron/dependencies.d/init-env-compat

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
# SSH Server Configuration
# ============================================
# One drop-in holds the policy (runtime/templates/sshd_config): keys only, abc only, and host keys
# each workspace generates on first boot. Installing openssh-server generated a set during the
# build; those would be the same in every container and readable by anyone who pulls this public
# image, so they are deleted, and the build fails if any survive. abc's login shell is set here
# once rather than at every boot.
COPY runtime/templates/sshd_config /etc/ssh/sshd_config.d/envhaven.conf
RUN mkdir -p /var/run/sshd && \
    rm -f /etc/ssh/ssh_host_* && \
    ! ls /etc/ssh/ssh_host_* >/dev/null 2>&1 && \
    usermod -s /usr/bin/zsh abc

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
COPY runtime/scripts/as-abc /usr/local/lib/envhaven/as-abc
COPY runtime/scripts/envhaven-user-setup /usr/local/lib/envhaven/envhaven-user-setup
COPY runtime/scripts/envhaven-skills-launcher /usr/local/lib/envhaven/envhaven-skills-launcher
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
# launcher looks for it. The skills CLI, under both of its names, gets a link in
# /opt/envhaven/bin, ahead of mise's shims, to a launcher that runs it with its telemetry off
# (runtime/scripts/envhaven-skills-launcher); a shim that is not there fails the RUN.
RUN chmod +x /defaults/envhaven-welcome.sh /opt/envhaven/bin/envhaven /opt/envhaven/bin/envhaven-version-check /opt/envhaven/bin/tmux-copy-hint /opt/envhaven/bin/claude-auth-helper /usr/local/lib/envhaven/* && \
    ln -s /usr/local/lib/envhaven/envhaven-prepare-antigravity /opt/envhaven/bin/envhaven-prepare-antigravity && \
    for cli in skills add-skill; do \
        [ -x "/mise/shims/$cli" ] && \
        ln -s /usr/local/lib/envhaven/envhaven-skills-launcher "/opt/envhaven/bin/$cli" || exit 1; \
    done && \
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

# abc's environment, in one file: PAM loads it for SSH sessions, and as-abc for every abc process
# root starts (code-server, the console, the boot oneshots). Root never reads it; see the end of
# this stage.
RUN echo 'PATH="/config/.local/bin:/opt/envhaven/wrappers:/opt/envhaven/bin:/opt/envhaven/cargo/bin:/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' > /etc/environment && \
    echo 'MISE_DATA_DIR="/mise"' >> /etc/environment && \
    echo 'MISE_CONFIG_DIR="/mise"' >> /etc/environment && \
    echo 'MISE_CACHE_DIR="/mise/cache"' >> /etc/environment && \
    echo 'MISE_STATE_DIR="/mise/state"' >> /etc/environment && \
    echo 'UV_TOOL_DIR="/opt/envhaven/uv-tools"' >> /etc/environment && \
    echo 'UV_TOOL_BIN_DIR="/opt/envhaven/bin"' >> /etc/environment && \
    echo 'RUSTUP_HOME="/opt/envhaven/rustup"' >> /etc/environment && \
    echo 'CARGO_HOME="/opt/envhaven/cargo"' >> /etc/environment

EXPOSE 8443
EXPOSE 22
EXPOSE 7681

VOLUME /config

# ============================================
# Verification
# ============================================
# AI tools verify from tool-definitions.json, so the roster cannot drift from it. Run the whole
# gate as the workspace user: these executables came from third-party distribution channels and
# must never get a root code-execution primitive during the build that ships them.
USER 1000:1000
RUN export HOME=/tmp/envhaven-verify \
        XDG_CACHE_HOME=/tmp/envhaven-verify/cache \
        XDG_CONFIG_HOME=/tmp/envhaven-verify/config \
        XDG_DATA_HOME=/tmp/envhaven-verify/data \
        XDG_STATE_HOME=/tmp/envhaven-verify/state; \
    trap 'rm -rf /tmp/envhaven-verify' EXIT; \
    mkdir -p "$HOME"; \
    node --version && \
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
    skills --version && \
    /opt/envhaven/bin/envhaven-console --version
USER root

# Final ownership sweep. Deliberately AFTER the verification above. Python tools may write
# bytecode into their own package directories when invoked, so the ownership assertion belongs
# after that invocation; running the gate as 1000:1000 also means it cannot create root-owned
# files or modify the image outside the tool trees.
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
# Root's runtime environment
# ============================================
# Root keeps the base image's PATH and a home of its own. Every directory abc can write (the
# workspace overrides in /config/.local/bin, and the self-updating tool trees in /mise and
# /opt/envhaven) stays off it, because a root process resolving a bare command through one of
# them runs whatever abc put there: the healthcheck, every s6 service and oneshot (LinuxServer's
# included), and `docker exec` from the host all start from this environment. HOME moves off
# /config for the same reason: a root shell would otherwise source abc's own .bashrc and .zshrc.
# abc's environment comes from /etc/environment through as-abc and PAM instead. Last in the
# stage, after everything that builds or verifies tools through the tool PATH.
ENV HOME=/root
ENV PATH=/lsiopy/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

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

# Runs as root every 30 seconds, so curl is named by absolute path.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD /usr/bin/curl -f http://localhost:8443/healthz || exit 1

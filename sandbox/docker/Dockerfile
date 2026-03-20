# OrcaBot Sandbox Image
# Multi-stage build: Go server + Claude Code sandbox environment

# =============================================================================
# Stage 1: Build Go binary
# =============================================================================
FROM golang:1.23-bookworm AS builder

WORKDIR /build

# Copy go mod files first for better caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build static binaries
RUN CGO_ENABLED=0 GOOS=linux go build -o /build/orcabot-server ./cmd/server
RUN CGO_ENABLED=0 GOOS=linux go build -o /build/browser-ctl ./cmd/browser-ctl
RUN CGO_ENABLED=0 GOOS=linux go build -o /build/mcp-bridge ./cmd/mcp-bridge

# =============================================================================
# Stage 2: Sandbox runtime image
# =============================================================================
FROM debian:bookworm-slim

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# REVISION: sandbox-version-cli-v1-build-arg
ARG SANDBOX_GIT_COMMIT=unknown
ENV ORCABOT_SANDBOX_VERSION=${SANDBOX_GIT_COMMIT}

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core utilities
    ca-certificates \
    curl \
    wget \
    git \
    # Build essentials (needed for some npm packages)
    build-essential \
    # Python (useful for user scripts)
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    # Audio libraries (for talkito/pyaudio)
    portaudio19-dev \
    # Shell utilities
    bash \
    zsh \
    tmux \
    vim \
    nano \
    less \
    jq \
    # Process management
    procps \
    kmod \
    # Networking tools
    openssh-client \
    socat \
    iptables \
    # Browser stack
    chromium \
    xvfb \
    x11vnc \
    websockify \
    # Clean up
    && rm -rf /var/lib/apt/lists/*

# Install noVNC 1.6.0 from GitHub (Debian bookworm ships 1.3.0 which has
# console logging in the Tight decoder path, forcing -notight on x11vnc
# and degrading VNC to Raw encoding ~2.7MB/frame vs ~100-300KB with Tight)
RUN curl -fsSL https://github.com/novnc/noVNC/archive/refs/tags/v1.6.0.tar.gz \
    | tar -xz -C /tmp \
    && rm -rf /usr/share/novnc \
    && mv /tmp/noVNC-1.6.0 /usr/share/novnc \
    && ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

# Install Node.js 22 (required by Claude Code, Codex, Gemini CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g npm@latest

# Pre-warm npm cache with Claude Code dependencies (for fast user-initiated install)
# We install then uninstall so the package is NOT distributed, but deps remain cached.
# A lightweight wrapper script at /usr/local/bin/claude handles on-demand installation.
RUN npm install -g @anthropic-ai/claude-code \
    && npm uninstall -g @anthropic-ai/claude-code
COPY docker/claude-wrapper.sh /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude

# Suppress Claude Code's "switched from npm to native installer" banner.
# We use npm intentionally (1.3s pre-warmed vs 19s native installer).
ENV DISABLE_INSTALLATION_CHECKS=1

# Install Codex CLI (OpenAI)
RUN npm cache clean --force && npm install -g @openai/codex@latest

# Install Gemini CLI (Google)
RUN npm cache clean --force && npm install -g @google/gemini-cli@latest

# --- Temporarily disabled agents (may re-enable later) ---
# Keeping Claude Code, Gemini CLI, and Codex CLI for now.
# OpenCode, Droid, and OpenClaw are commented out to reduce image size (~800MB savings).

# # Install OpenCode CLI and move to shared location
# RUN curl -fsSL https://opencode.ai/install | bash \
#     && mv /root/.opencode/bin/opencode /usr/local/bin/opencode

# # Install Droid CLI (Factory)
# RUN curl -fsSL https://app.factory.ai/cli | sh \
#     && if [ -x /root/.local/bin/droid ]; then mv /root/.local/bin/droid /usr/local/bin/droid; fi

# # Install OpenClaw CLI
# RUN npm install -g openclaw@latest

# Install Talkito (voice assistant) - cached, no submodules
# To force update: rebuild with --no-cache or bump a comment here
RUN git clone --depth 1 --no-recurse-submodules https://github.com/robdmac/talkito.git /tmp/talkito \
    && cd /tmp/talkito \
    && pip3 install --break-system-packages . \
    && rm -rf /tmp/talkito

# Install Playwright (browser automation) without bundled browsers
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g playwright

# Strip build-only packages to reduce image size (~300MB savings)
# build-essential/gcc/g++ were needed for native npm modules; python3-dev for pip install.
# Neither is needed at runtime.
# NOTE: Keep /root/.npm — it contains the warmed cache for Claude Code on-demand install.
RUN apt-get update && apt-get purge -y --auto-remove \
    build-essential cpp gcc g++ make python3-dev \
    && rm -rf /var/lib/apt/lists/* /tmp/*

# Install xdg-open wrapper to route URLs into the sandbox browser
COPY docker/xdg-open.sh /usr/local/bin/xdg-open
COPY docker/gio /usr/local/bin/gio
COPY docker/chromium-wrapper.sh /usr/local/bin/chromium-wrapper
COPY docker/orcabot /usr/local/bin/orcabot
RUN chmod +x /usr/local/bin/xdg-open /usr/local/bin/gio /usr/local/bin/chromium-wrapper \
    /usr/local/bin/orcabot \
    && ln -sf /usr/local/bin/xdg-open /usr/local/bin/open \
    && ln -sf /usr/local/bin/xdg-open /usr/local/bin/x-www-browser \
    && ln -sf /usr/local/bin/xdg-open /usr/local/bin/sensible-browser \
    && ln -sf /usr/local/bin/xdg-open /usr/local/bin/google-chrome \
    && ln -sf /usr/local/bin/xdg-open /usr/local/bin/google-chrome-stable \
    && ln -sf /usr/local/bin/xdg-open /usr/local/bin/chrome \
    && ln -sf /usr/local/bin/xdg-open /usr/local/bin/chromium-browser \
    && if [ -x /usr/bin/xdg-open ]; then mv /usr/bin/xdg-open /usr/bin/xdg-open.real; fi \
    && ln -sf /usr/local/bin/xdg-open /usr/bin/xdg-open \
    && ln -sf /usr/local/bin/xdg-open /bin/xdg-open \
    && if [ -x /usr/bin/gio ]; then mv /usr/bin/gio /usr/bin/gio.real; fi \
    && ln -sf /usr/local/bin/gio /usr/bin/gio \
    && if [ -x /usr/bin/gnome-open ]; then mv /usr/bin/gnome-open /usr/bin/gnome-open.real; fi \
    && if [ -x /usr/bin/gnome-open.real ]; then ln -sf /usr/local/bin/xdg-open /usr/bin/gnome-open; fi \
    # Wrap /usr/bin/chromium so CLI tools that exec chromium with a URL get routed
    # through xdg-open, while the browser block (which passes --no-sandbox etc.) still
    # reaches the real binary.
    && if [ -x /usr/bin/chromium ]; then mv /usr/bin/chromium /usr/bin/chromium.real; fi \
    && ln -sf /usr/local/bin/chromium-wrapper /usr/bin/chromium

# Create non-root user for sandbox operations
RUN useradd -m -s /bin/bash sandbox

# Create workspace with group-write + setgid so all pty-NNN users (GID=sandbox)
# can read/write the shared workspace. setgid ensures new files inherit sandbox
# group, keeping the directory self-consistent across multiple PTY UIDs.
# Mode 2775: owner=rwx, group=rwx, others=r-x, setgid bit set.
# (777 is intentionally avoided; the sandbox group is the write boundary.)
RUN mkdir -p /workspace \
    && chown sandbox:sandbox /workspace \
    && chmod 2775 /workspace

# Create PTY UID pool: 100 unprivileged users (pty-000…pty-099, UIDs 2000–2099).
# All are members of the "sandbox" group so they can access group-writable workspace files.
# These are created at build time so there is zero runtime cost for PTY user allocation.
# The iptables range rule targets UIDs 2000–2099; any change here must match main.go.
RUN for i in $(seq 0 99); do \
        useradd --system --no-create-home --no-user-group \
                --uid $((2000 + $i)) \
                --gid sandbox \
                $(printf 'pty-%03d' $i); \
    done

# Set umask 0002 for all PTY shell sessions.
# Without this, files created by pty-000 land at 0644/0755 (umask 0022) so
# pty-001 can read them but not modify them — breaking the shared-workspace model.
# umask 0002 → new files 0664, new dirs 0775; combined with the setgid /workspace
# (GID=sandbox propagated to all new entries) every pty-NNN can read and write
# files created by any other pty-NNN in the same sandbox VM.
#
# /etc/profile.d/ is sourced by login shells (bash, sh, dash).
# /etc/bash.bashrc covers interactive non-login bash.
# /etc/zsh/zshrc covers interactive zsh sessions.
RUN echo 'umask 0002' > /etc/profile.d/orcabot-umask.sh \
    && chmod 644 /etc/profile.d/orcabot-umask.sh \
    && echo 'umask 0002' >> /etc/bash.bashrc \
    && mkdir -p /etc/zsh && echo 'umask 0002' >> /etc/zsh/zshrc

# Set up environment
ENV HOME=/home/sandbox
ENV TERM=xterm-256color
ENV PATH="/home/sandbox/.local/bin:${PATH}"

# Copy Go binaries from builder
COPY --from=builder /build/orcabot-server /usr/local/bin/orcabot-server
COPY --from=builder /build/browser-ctl /usr/local/bin/browser-ctl
COPY --from=builder /build/mcp-bridge /usr/local/bin/mcp-bridge

# Working directory
WORKDIR /workspace

# Expose HTTP/WebSocket port
EXPOSE 8080

# Health check for container orchestration
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://127.0.0.1:8080/health || exit 1

# Run as root (needed for PTY creation and process management)
# The sandbox user is used for spawned shell processes, not the server itself
# NOTE: Consider using capability-based approach (CAP_SYS_PTRACE, CAP_SETUID) in future
USER root

# Start the Go server
CMD ["/usr/local/bin/orcabot-server"]

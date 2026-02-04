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
    # Browser stack
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    # Clean up
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 (required by OpenClaw)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Pre-warm npm cache with Claude Code dependencies (for fast user-initiated install)
# We install then uninstall so the package is NOT distributed, but deps remain cached.
# A lightweight wrapper script at /usr/local/bin/claude handles on-demand installation.
RUN npm install -g @anthropic-ai/claude-code \
    && npm uninstall -g @anthropic-ai/claude-code
COPY docker/claude-wrapper.sh /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude

# Install Codex CLI (OpenAI)
RUN npm install -g @openai/codex

# Install Gemini CLI (Google)
RUN npm install -g @google/gemini-cli

# Install OpenCode CLI and move to shared location
RUN curl -fsSL https://opencode.ai/install | bash \
    && mv /root/.opencode/bin/opencode /usr/local/bin/opencode

# Install Droid CLI (Factory)
RUN curl -fsSL https://app.factory.ai/cli | sh \
    && if [ -x /root/.local/bin/droid ]; then mv /root/.local/bin/droid /usr/local/bin/droid; fi

# Install OpenClaw CLI
RUN npm install -g openclaw@latest

# Install Talkito (voice assistant) - cached, no submodules
# To force update: rebuild with --no-cache or bump a comment here
RUN git clone --depth 1 --no-recurse-submodules https://github.com/robdmac/talkito.git /tmp/talkito \
    && cd /tmp/talkito \
    && pip3 install --break-system-packages . \
    && rm -rf /tmp/talkito

# Install Playwright (browser automation) without bundled browsers
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g playwright

# Install xdg-open wrapper to route URLs into the sandbox browser
COPY docker/xdg-open.sh /usr/local/bin/xdg-open
COPY docker/gio /usr/local/bin/gio
COPY docker/chromium-wrapper.sh /usr/local/bin/chromium-wrapper
RUN chmod +x /usr/local/bin/xdg-open /usr/local/bin/gio /usr/local/bin/chromium-wrapper \
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

# Create workspace directory
RUN mkdir -p /workspace && chmod 777 /workspace

# Create non-root user for sandbox operations
RUN useradd -m -s /bin/bash sandbox \
    && chown -R sandbox:sandbox /workspace

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

# Run as root (needed for PTY creation and process management)
# The sandbox user is used for spawned shell processes, not the server itself
USER root

# Start the Go server
CMD ["/usr/local/bin/orcabot-server"]

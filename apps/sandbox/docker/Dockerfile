# Hyper Sandbox Image
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

# Build static binary
RUN CGO_ENABLED=0 GOOS=linux go build -o /build/hyper-server ./cmd/server

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
    # Python (for Codex CLI)
    python3 \
    python3-pip \
    python3-venv \
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
    # Networking tools
    openssh-client \
    # Clean up
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install Codex CLI (OpenAI)
RUN pip3 install --break-system-packages openai-codex-cli || true

# Create workspace directory
RUN mkdir -p /workspace && chmod 777 /workspace

# Create non-root user for sandbox operations
RUN useradd -m -s /bin/bash sandbox \
    && chown -R sandbox:sandbox /workspace

# Set up environment
ENV HOME=/home/sandbox
ENV TERM=xterm-256color
ENV PATH="/home/sandbox/.local/bin:${PATH}"

# Copy Go server binary from builder
COPY --from=builder /build/hyper-server /usr/local/bin/hyper-server

# Working directory
WORKDIR /workspace

# Expose HTTP/WebSocket port
EXPOSE 8080

# Run as root (needed for PTY creation and process management)
# The sandbox user is used for spawned shell processes, not the server itself
USER root

# Start the Go server
CMD ["/usr/local/bin/hyper-server"]

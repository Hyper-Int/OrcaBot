# Hyper Sandbox Image
# Base image for running Claude Code and Codex CLI in sandboxed terminals

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

# Create non-root user for sandbox
RUN useradd -m -s /bin/bash sandbox \
    && chown -R sandbox:sandbox /workspace

# Set up environment
ENV HOME=/home/sandbox
ENV TERM=xterm-256color
ENV PATH="/home/sandbox/.local/bin:${PATH}"

# Working directory
WORKDIR /workspace

# Default to non-root user
USER sandbox

# Default command - bash shell
CMD ["/bin/bash"]

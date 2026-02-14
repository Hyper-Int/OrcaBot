#!/bin/bash
# On-demand installer for Claude Code.
# The real binary goes to /usr/bin/claude (npm prefix is /usr).
# This wrapper lives at /usr/local/bin/claude and is only invoked
# when the real binary hasn't been installed yet.

# If the real claude is already installed, just exec it
if [ -x /usr/bin/claude ]; then
  exec /usr/bin/claude "$@"
fi

# Serialize concurrent installs — only one npm install at a time
LOCKFILE="/tmp/claude-install.lock"
exec 9>"$LOCKFILE"
flock 9

# Re-check after acquiring lock (another process may have installed it)
if [ -x /usr/bin/claude ]; then
  exec /usr/bin/claude "$@"
fi

printf "\n"
printf "Installing Claude Code from npm...\n"
printf "By continuing, you agree to Anthropic's Terms of Service.\n"
for i in 3 2 1; do printf "\rInstalling in %d..." "$i"; sleep 1; done
printf "\rInstalling now...  \n"

if npm install -g @anthropic-ai/claude-code; then
  # Install succeeded — remove this wrapper so /usr/bin/claude takes priority
  rm -f /usr/local/bin/claude
  exec claude "$@"
else
  printf "\nFailed to install Claude Code.\n" >&2
  exit 1
fi

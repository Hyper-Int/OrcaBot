#!/usr/bin/env sh
set -eu

# TODO: generate and store per-install secrets in the OS keychain.
# Placeholder prints a random token for now.

if command -v openssl >/dev/null 2>&1; then
  openssl rand -base64 32
else
  head -c 32 /dev/urandom | base64
fi

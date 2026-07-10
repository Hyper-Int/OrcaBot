#!/usr/bin/env bash
# Build-time smoke for the sandbox VM image.
#
# Runs INSIDE the freshly-built orcabot-sandbox container (invoked by
# build-images.sh via `docker run` right after `docker build`, BEFORE the rootfs is
# exported/assembled). A non-zero exit aborts the build (build-images.sh runs with
# `set -e`), so a regressed dependency FAILS THE BUILD instead of silently shipping a
# broken VM image that replaces a working one.
#
# It catches the exact classes that silently broke real images, which a plain
# `--version` check does NOT:
#   - chromium that installs and reports a version but IMMEDIATE_CRASHes on launch
#     (Debian 150.0.7871.46 SIGTRAP) → browser block "Browser failed to start".
#     → we actually LAUNCH chromium headless and require its DevTools to answer.
#   - claude installed only for root / a per-user launcher that can't resolve for the
#     no-home pty-NNN users that run PTYs → "exec format error" / "Failed to install".
#     → we run claude (and the other agents) as a no-home, empty-$HOME user.
#
# Deps used (all present in the image): bash, curl, su, useradd, seq.
set -uo pipefail

FAIL=0
ok()  { echo "  OK:   $1"; }
bad() { echo "  FAIL: $1"; FAIL=1; }

# A no-own-home, sandbox-group user with a FRESH empty $HOME — mirrors how PTYs run
# agents (pty-NNN system users, gid=sandbox, $HOME set to a fresh session dir). If
# claude were installed per-user (into root's home) this $HOME wouldn't have it, so
# this catches that regression. NOTE: $HOME must NOT be under /tmp — codex refuses to
# create its helper binaries in a temp dir and would false-fail here.
id ptysmoke >/dev/null 2>&1 || useradd --system --no-create-home --gid sandbox ptysmoke 2>/dev/null || true
PTY_HOME=/home/ptysmoke-home
rm -rf "$PTY_HOME"; mkdir -p "$PTY_HOME"; chown ptysmoke "$PTY_HOME" 2>/dev/null || true
as_pty() { su ptysmoke -s /bin/bash -c "HOME=$PTY_HOME $1" 2>&1; }
# First MAJOR.MINOR(.PATCH) token in a --version output (agents prepend banners/warnings).
ver_of() { grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1; }

echo "[validate-image] 1. chromium LAUNCHES (not just --version)"
CHROME="$(command -v chromium.real || command -v chromium)"
rm -rf /tmp/csmoke
"$CHROME" --headless=new --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 --user-data-dir=/tmp/csmoke about:blank \
  >/tmp/chrome-smoke.log 2>&1 &
CPID=$!
UP=0
for _ in $(seq 1 25); do
  if curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; then UP=1; break; fi
  kill -0 "$CPID" 2>/dev/null || break   # chromium already exited → crashed on launch
  sleep 1
done
kill "$CPID" 2>/dev/null || true
if [ "$UP" = 1 ]; then
  ok "chromium up + DevTools answered: $("$CHROME" --version 2>&1 | head -1)"
else
  bad "chromium did NOT come up: $("$CHROME" --version 2>&1 | head -1) — crashes on launch"
  echo "     --- last chromium output ---"; tail -5 /tmp/chrome-smoke.log | sed 's/^/     /'
fi

echo "[validate-image] 2. agents run as a no-own-home pty user (claude first — its regression)"
for a in claude opencode gemini codex; do
  OUT="$(as_pty "$a --version 2>&1")"
  V="$(printf '%s' "$OUT" | ver_of)"
  if [ -n "$V" ]; then ok "$a: $V"; else bad "$a: no version — $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-100)"; fi
done

echo
if [ "$FAIL" = 0 ]; then
  echo "[validate-image] PASS — image is shippable"
  exit 0
else
  echo "[validate-image] FAIL — refusing to assemble/ship this image (a dependency regressed)"
  exit 1
fi

#!/usr/bin/env sh
set -eu
# One-shot desktop release: bump (optional) -> build resources (bakes OAuth) ->
# signed+notarized `cargo tauri build` -> preflight gate + publish to GitHub.
#
# This is a thin orchestrator over the individual scripts; see desktop/RELEASE.md
# for the manual sequence and prerequisites.
#
# Usage:
#   [ORCABOT_RELEASE_ENV=~/.orcabot-release.env] sh desktop/scripts/release.sh [VERSION]
#
#   VERSION  optional (e.g. 0.5.0). If given and different from the current
#            tauri.conf.json version, the three version files are bumped IN THE
#            WORKING TREE (not committed - open a bump PR separately; we never
#            push to main). If omitted, the current version is released as-is.
#
# Env:
#   ORCABOT_RELEASE_ENV  path to a file (sourced) exporting the Apple signing +
#                        notarization creds, the Tauri minisign key, and the
#                        OAuth client IDs/secrets. Default: ~/.orcabot-release.env
#   ALLOW_UNSIGNED=1     skip the signing-identity check (produces an UNSHIPPABLE
#                        build - updater/notarization will be wrong; dev only).
#   SKIP_PREFLIGHT=1     passed through to publish-release.sh (not recommended).
#   BUILD_VM=force       passed through to build-desktop-resources.sh (only when
#                        the VM image actually changed; see RELEASE.md §6).

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC_TAURI="$SCRIPT_DIR/../app/src-tauri"
CONF="$SRC_TAURI/tauri.conf.json"

read_version() {
  grep -m1 '"version"' "$CONF" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

# --- 1. Source signing/OAuth secrets --------------------------------------
ENV_FILE="${ORCABOT_RELEASE_ENV:-$HOME/.orcabot-release.env}"
if [ -f "$ENV_FILE" ]; then
  echo "== sourcing release env: $ENV_FILE"
  # shellcheck disable=SC1090
  . "$ENV_FILE"
else
  echo "== no env file at $ENV_FILE - assuming signing/OAuth vars are already exported"
fi

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ] && [ "${ALLOW_UNSIGNED:-0}" != "1" ]; then
  echo "ERROR: APPLE_SIGNING_IDENTITY is not set - the build wouldn't be signable/notarizable." >&2
  echo "       Point ORCABOT_RELEASE_ENV at your secrets file, or set ALLOW_UNSIGNED=1 for a throwaway build." >&2
  exit 1
fi

# --- 2. Optional version bump (working tree only) -------------------------
CURRENT=$(read_version)
WANT="${1:-$CURRENT}"
if [ "$WANT" != "$CURRENT" ]; then
  echo "== bumping version $CURRENT -> $WANT (working tree only; open a bump PR - do not push to main)"
  # tauri.conf.json + Cargo.toml
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$WANT\"/" "$CONF"
    sed -i '' "s/^version = \"$CURRENT\"/version = \"$WANT\"/" "$SRC_TAURI/Cargo.toml"
  else
    sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$WANT\"/" "$CONF"
    sed -i "s/^version = \"$CURRENT\"/version = \"$WANT\"/" "$SRC_TAURI/Cargo.toml"
  fi
  # Cargo.lock (keeps the workspace lock in sync)
  ( cd "$SRC_TAURI" && cargo update -p orcabot-desktop --precise "$WANT" >/dev/null 2>&1 ) || true
  echo "   bumped: tauri.conf.json, Cargo.toml, Cargo.lock"
else
  echo "== releasing current version: $CURRENT"
fi

VERSION=$(read_version)
echo "== target release: v$VERSION"

# --- 3. Build bundled resources (frontend + workerd; bakes OAuth) ---------
echo "== building desktop resources (frontend + control-plane workerd)..."
sh "$SCRIPT_DIR/build-desktop-resources.sh"

# --- 4. Signed + notarized app build --------------------------------------
echo "== cargo tauri build (signed + notarized; this takes a while)..."
( cd "$SRC_TAURI" && cargo tauri build )

# --- 5. Preflight gate + publish ------------------------------------------
echo "== publishing v$VERSION..."
sh "$SCRIPT_DIR/publish-release.sh"

echo
echo "== release v$VERSION done."
echo "   Verify: curl -sL https://github.com/${ORCABOT_RELEASE_REPO:-Hyper-Int/OrcaBot}/releases/latest/download/latest.json"
if [ "$WANT" != "$CURRENT" ]; then
  echo "   Reminder: commit the version bump via a PR (tauri.conf.json, Cargo.toml, Cargo.lock)."
fi

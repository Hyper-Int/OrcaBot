#!/usr/bin/env sh
set -eu
# Publish a desktop release to GitHub Releases.
#
# Uploads, for the version in tauri.conf.json:
#   - the DMG            (direct download for new installs)
#   - Orcabot.app.tar.gz (+ .sig)   updater artifacts
#   - latest.json                   updater manifest (what the app polls)
#
# Prereqs:
#   - `gh` CLI authenticated (`gh auth login`)
#   - a signed+notarized build already in app/src-tauri/target/release/bundle
#     (i.e. you've run `cargo tauri build` with the signing env)
#
# The updater endpoint (tauri.conf.json) is:
#   https://github.com/<repo>/releases/latest/download/latest.json
# so the release must be published (not draft) to become "latest".

REPO="${ORCABOT_RELEASE_REPO:-Hyper-Int/OrcaBot}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC_TAURI="$SCRIPT_DIR/../app/src-tauri"
BUNDLE="$SRC_TAURI/target/release/bundle"

VERSION=$(grep -m1 '"version"' "$SRC_TAURI/tauri.conf.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
[ -n "$VERSION" ] || { echo "could not read version from tauri.conf.json"; exit 1; }
TAG="v$VERSION"

DMG=$(ls "$BUNDLE"/dmg/*.dmg 2>/dev/null | head -1 || true)
TARBALL="$BUNDLE/macos/Orcabot.app.tar.gz"
SIG="$TARBALL.sig"
for f in "$DMG" "$TARBALL" "$SIG"; do
  [ -n "$f" ] && [ -f "$f" ] || { echo "missing artifact: ${f:-<dmg>} — run a signed \`cargo tauri build\` first"; exit 1; }
done

# The updater downloads the tarball from this versioned release URL. (arm64 only
# here; add a darwin-x86_64 entry if you also build an Intel target.)
URL="https://github.com/$REPO/releases/download/$TAG/Orcabot.app.tar.gz"
SIGNATURE=$(cat "$SIG")
PUB_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

WORK=$(mktemp -d)
LATEST="$WORK/latest.json"
cat > "$LATEST" <<JSON
{
  "version": "$VERSION",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIGNATURE",
      "url": "$URL"
    }
  }
}
JSON

echo "Publishing $TAG to $REPO:"
echo "  $(basename "$DMG")"
echo "  Orcabot.app.tar.gz (+ .sig)"
echo "  latest.json -> $URL"

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG exists — uploading/replacing assets."
  gh release upload "$TAG" --repo "$REPO" --clobber "$DMG" "$TARBALL" "$SIG" "$LATEST"
else
  gh release create "$TAG" --repo "$REPO" \
    --title "Orcabot $TAG" \
    --notes "Orcabot desktop $TAG" \
    "$DMG" "$TARBALL" "$SIG" "$LATEST"
fi

echo
echo "Done."
echo "  Direct download: https://github.com/$REPO/releases/download/$TAG/$(basename "$DMG")"
echo "  Updater manifest: https://github.com/$REPO/releases/latest/download/latest.json"

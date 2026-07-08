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

# Fresh-install download for THIS version: a DMG if present, else a
# signed+stapled .app zip (produced for salvaged builds that never reached the
# DMG step). Match the version explicitly — Tauri doesn't clean the bundle dir,
# so a bare glob could pick up a stale previous-version file while latest.json
# points at the current tarball.
set -- "$BUNDLE"/dmg/Orcabot_"$VERSION"_*.dmg
if [ "$#" -eq 1 ] && [ -f "$1" ]; then
  FRESH="$1"
elif [ -f "$BUNDLE/macos/Orcabot_${VERSION}_aarch64.zip" ]; then
  FRESH="$BUNDLE/macos/Orcabot_${VERSION}_aarch64.zip"
else
  echo "no Orcabot_${VERSION}_*.dmg or Orcabot_${VERSION}_aarch64.zip found in $BUNDLE"
  echo "(build the DMG, or create the .app zip for a salvaged release)"
  exit 1
fi
TARBALL="$BUNDLE/macos/Orcabot.app.tar.gz"
SIG="$TARBALL.sig"
for f in "$TARBALL" "$SIG"; do
  [ -f "$f" ] || { echo "missing artifact: $f — run a signed \`cargo tauri build\` first"; exit 1; }
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
echo "  $(basename "$FRESH")"
echo "  Orcabot.app.tar.gz (+ .sig)"
echo "  latest.json -> $URL"

# Create the release (or reuse it), attaching only the small manifest files via
# gh. The large assets (~1GB each) are uploaded separately below with a real
# progress bar — gh's uploader only shows a spinner, useless for big files.
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG exists — updating assets."
  gh release upload "$TAG" --repo "$REPO" --clobber "$SIG" "$LATEST"
else
  gh release create "$TAG" --repo "$REPO" \
    --title "Orcabot $TAG" \
    --notes "Orcabot desktop $TAG" \
    "$SIG" "$LATEST"
fi

RELEASE_ID=$(gh release view "$TAG" --repo "$REPO" --json databaseId --jq .databaseId)
TOKEN=$(gh auth token)

# Upload one large asset with a curl progress bar. POST is create-only (422s on a
# duplicate name), so clobber by deleting any same-named asset first. Falls back
# to `gh` if curl fails, so a bad upload never leaves the release half-published.
upload_big() {
  _f="$1"; _name=$(basename "$_f")
  echo "Uploading $_name ($(du -h "$_f" | awk '{print $1}'))..."
  _old=$(gh api "repos/$REPO/releases/$RELEASE_ID/assets" \
           --jq ".[] | select(.name==\"$_name\") | .id" 2>/dev/null || true)
  [ -n "${_old:-}" ] && gh api -X DELETE "repos/$REPO/releases/assets/$_old" >/dev/null 2>&1 || true
  if ! curl -fL --progress-bar -X POST \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/octet-stream" \
        -T "$_f" \
        "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$_name" \
        -o /dev/null; then
    echo "  curl upload failed — falling back to gh (spinner, no bar)."
    gh release upload "$TAG" --repo "$REPO" --clobber "$_f"
  fi
}
upload_big "$TARBALL"
upload_big "$FRESH"

echo
echo "Done."
echo "  Direct download: https://github.com/$REPO/releases/download/$TAG/$(basename "$FRESH")"
echo "  Updater manifest: https://github.com/$REPO/releases/latest/download/latest.json"

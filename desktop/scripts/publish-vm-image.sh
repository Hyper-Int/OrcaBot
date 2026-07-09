#!/usr/bin/env sh
set -eu
# Publish the sandbox VM disk image to its own GitHub release tag, and update the
# committed manifest (vm-image.json) with the version + checksum the app embeds.
#
# The image is NOT bundled in the app (it would bloat every ~40MB auto-update to
# ~1GB). Instead the app downloads it on demand, once per image VERSION, and
# verifies it against the SHA-256 baked into the notarized binary from the
# manifest below.
#
# Run this ONLY when the VM image content changes (rare — a sandbox rebuild).
# BUMP THE VERSION each time so existing installs know to re-download.
#
# Usage:
#   VM_IMAGE_VERSION=v2 desktop/scripts/publish-vm-image.sh [path/to/sandbox.img]
#
# Then commit vm-image.json and build + release the app as usual.

REPO="${ORCABOT_RELEASE_REPO:-Hyper-Int/OrcaBot}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IMG="${1:-$SCRIPT_DIR/../vm/image/sandbox.img}"
VER="${VM_IMAGE_VERSION:-v1}"
MANIFEST="$SCRIPT_DIR/../app/src-tauri/vm-image.json"
TAG="vm-image-$VER"

[ -f "$IMG" ] || { echo "image not found: $IMG (pass the path as arg 1)"; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "gh CLI required"; exit 1; }

GZ="$(dirname "$IMG")/sandbox.img.gz"
echo "Compressing $IMG -> $GZ (multi-GB; takes a minute)..."
gzip -c "$IMG" > "$GZ"

SHA=$(shasum -a 256 "$GZ" | awk '{print $1}')
URL="https://github.com/$REPO/releases/download/$TAG/sandbox.img.gz"
echo "gz sha256: $SHA"
echo "size:      $(du -h "$GZ" | awk '{print $1}')"

echo "Writing manifest $MANIFEST (version=$VER)"
cat > "$MANIFEST" <<JSON
{
  "version": "$VER",
  "sha256": "$SHA",
  "url": "$URL"
}
JSON

echo "Publishing $GZ to release $TAG..."
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" --repo "$REPO" --clobber "$GZ"
else
  gh release create "$TAG" --repo "$REPO" \
    --title "VM image $VER" \
    --notes "Sandbox VM disk image ($VER). Downloaded on demand + checksum-verified by the desktop app; not bundled in the app itself." \
    "$GZ"
fi

echo
echo "Done."
echo "  Now: git add $MANIFEST && commit, then build + release the app."
echo "  Existing installs on an older image version will download $VER on next launch."

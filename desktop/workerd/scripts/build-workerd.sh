#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONTROLPLANE_DIR=${CONTROLPLANE_DIR:-"$ROOT_DIR/../../controlplane"}
OUT_DIR="$ROOT_DIR/dist"
TMP_DIR="$ROOT_DIR/.tmp-build"

if [ ! -d "$CONTROLPLANE_DIR" ]; then
  printf '%s\n' "controlplane dir not found: $CONTROLPLANE_DIR" >&2
  exit 1
fi

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR" "$OUT_DIR"

# Bundle the worker using wrangler (build-time only).
# Uses a dry-run deploy to emit a single-file bundle into TMP_DIR.
(
  cd "$CONTROLPLANE_DIR"
  npx wrangler deploy --dry-run --outdir "$TMP_DIR"
)

bundle_path=""
if [ -f "$TMP_DIR/worker.js" ]; then
  bundle_path="$TMP_DIR/worker.js"
elif [ -f "$TMP_DIR/worker.mjs" ]; then
  bundle_path="$TMP_DIR/worker.mjs"
else
  bundle_path=$(find "$TMP_DIR" -maxdepth 1 -type f -name "*.js" -o -name "*.mjs" | head -n 1)
fi

if [ -z "$bundle_path" ]; then
  printf '%s\n' "worker bundle not found in $TMP_DIR" >&2
  exit 1
fi

cp "$bundle_path" "$OUT_DIR/worker.js"

if [ -f "$TMP_DIR/metadata.json" ]; then
  cp "$TMP_DIR/metadata.json" "$OUT_DIR/metadata.json"
fi

printf '%s\n' "workerd bundle written to $OUT_DIR/worker.js"

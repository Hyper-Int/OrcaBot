#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONFIG_FILE="$ROOT_DIR/config/workerd.desktop.capnp"
BUNDLE_FILE="$ROOT_DIR/dist/worker.js"
CONTROLPLANE_PORT=${CONTROLPLANE_PORT:-8787}
DESKTOP_DATA_DIR=${DESKTOP_DATA_DIR:-"$HOME/.orcabot/desktop"}
DO_STORAGE_DIR="$DESKTOP_DATA_DIR/durable_objects"
D1_HTTP_URL=${D1_HTTP_URL:-"http://d1-shim"}

WORKERD_BIN=${WORKERD_BIN:-"$ROOT_DIR/../../controlplane/node_modules/workerd/bin/workerd"}
WORKERD_IMPORT_PATH=${WORKERD_IMPORT_PATH:-"$ROOT_DIR/../../controlplane/node_modules/workerd"}

if [ ! -x "$WORKERD_BIN" ]; then
  printf '%s\n' "workerd binary not found: $WORKERD_BIN" >&2
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  printf '%s\n' "workerd config not found: $CONFIG_FILE" >&2
  exit 1
fi

if [ ! -f "$BUNDLE_FILE" ]; then
  printf '%s\n' "worker bundle not found: $BUNDLE_FILE" >&2
  printf '%s\n' "run desktop/workerd/scripts/build-workerd.sh first" >&2
  exit 1
fi

mkdir -p "$DO_STORAGE_DIR"

export D1_HTTP_URL

printf '%s\n' "Starting workerd on http://127.0.0.1:$CONTROLPLANE_PORT"
"$WORKERD_BIN" serve \
  --experimental \
  --import-path "$WORKERD_IMPORT_PATH" \
  --socket-addr "http=127.0.0.1:$CONTROLPLANE_PORT" \
  --directory-path "do-storage=$DO_STORAGE_DIR" \
  "$CONFIG_FILE"

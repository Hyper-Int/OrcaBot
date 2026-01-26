#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

D1_SHIM_ADDR=${D1_SHIM_ADDR:-"127.0.0.1:9001"}
D1_SQLITE_PATH=${D1_SQLITE_PATH:-"$HOME/.orcabot/desktop/d1/controlplane.sqlite"}

export D1_SHIM_ADDR
export D1_SQLITE_PATH

cd "$ROOT_DIR"

if [ ! -f "go.mod" ]; then
  printf '%s\n' "go.mod not found in $ROOT_DIR" >&2
  exit 1
fi

printf '%s\n' "Starting D1 shim on $D1_SHIM_ADDR using $D1_SQLITE_PATH"
if command -v nc >/dev/null 2>&1; then
  host=$(printf '%s' "$D1_SHIM_ADDR" | cut -d: -f1)
  port=$(printf '%s' "$D1_SHIM_ADDR" | cut -d: -f2)
  if nc -z "$host" "$port" >/dev/null 2>&1; then
    printf '%s\n' "D1 shim already running on $D1_SHIM_ADDR"
    exit 0
  fi
fi
go run .

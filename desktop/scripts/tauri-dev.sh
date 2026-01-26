#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR="$SCRIPT_DIR/../app"

cd "$APP_DIR"
../scripts/build-desktop-resources.sh
cargo tauri dev

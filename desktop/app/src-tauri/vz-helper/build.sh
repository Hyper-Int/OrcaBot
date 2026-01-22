#!/usr/bin/env bash
# Build the VZ helper for Virtualization.framework
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${1:-$SCRIPT_DIR/../resources/vm}"

cd "$SCRIPT_DIR"

echo "Building vz-helper..."

# Build for release
swift build -c release

# Copy to output
mkdir -p "$OUTPUT_DIR"
cp .build/release/vz-helper "$OUTPUT_DIR/vz-helper"

echo "Built: $OUTPUT_DIR/vz-helper"

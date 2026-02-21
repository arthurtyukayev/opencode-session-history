#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TARGET_DIR="${1:-$HOME/.config/opencode/plugins/history}"

mkdir -p "$TARGET_DIR"

cp "$PLUGIN_ROOT/index.ts" "$TARGET_DIR/index.ts"

echo "Installed index.ts to: $TARGET_DIR"
echo "Restart OpenCode to load the updated plugin."

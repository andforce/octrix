#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OUT_DIR="$SCRIPT_DIR/out"
mkdir -p "$OUT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm not found in PATH" >&2
  echo "Install Node.js (with npm) first: https://nodejs.org" >&2
  exit 1
fi

echo "==> Electron DMG: Apple Silicon (arm64)"
npm run electron:build:dmg:arm64

echo "==> Electron DMG: Intel (x86_64)"
npm run electron:build:dmg:x64

ELECTRON_OUT="$SCRIPT_DIR/out-electron"
for dmg in Octrix-arm64.dmg Octrix-x64.dmg; do
  src="$ELECTRON_OUT/$dmg"
  if [ ! -f "$src" ]; then
    echo "error: missing $src" >&2
    exit 1
  fi
  cp -f "$src" "$OUT_DIR/"
  echo "Copied: $dmg -> out/"
done

echo "Done. DMGs: $OUT_DIR"
ls -la "$OUT_DIR"

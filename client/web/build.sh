#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OUT_DIR="$SCRIPT_DIR/out"
mkdir -p "$OUT_DIR"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found in PATH" >&2
  echo "Install Rust via rustup first: https://rustup.rs" >&2
  echo "Then reload your shell, for example: source \"\$HOME/.cargo/env\"" >&2
  exit 1
fi

if command -v rustup >/dev/null 2>&1; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
fi

echo "==> DMG: Apple Silicon (aarch64)"
npm run tauri:build:dmg:arm64

echo "==> DMG: Intel (x86_64)"
npm run tauri:build:dmg:x64

TAURI_TARGET="$SCRIPT_DIR/src-tauri/target"
for arch in aarch64-apple-darwin x86_64-apple-darwin; do
  dmg_dir="$TAURI_TARGET/$arch/release/bundle/dmg"
  if [ ! -d "$dmg_dir" ]; then
    echo "error: missing $dmg_dir" >&2
    exit 1
  fi
  while IFS= read -r -d '' f; do
    cp -f "$f" "$OUT_DIR/"
    echo "Copied: $(basename "$f") -> out/"
  done < <(find "$dmg_dir" -maxdepth 1 -name '*.dmg' -print0)
done

echo "Done. DMGs: $OUT_DIR"
ls -la "$OUT_DIR"

#!/bin/bash
set -e

# Resolve src-tauri/target regardless of cwd (npm runs from client/web/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_DIR="$(dirname "$SCRIPT_DIR")"
TARGET_DIR="$TAURI_DIR/target"

for arch_dir in aarch64-apple-darwin x86_64-apple-darwin universal-apple-darwin; do
  case "$arch_dir" in
    aarch64-apple-darwin) cpu="arm64" ;;
    x86_64-apple-darwin) cpu="x64" ;;
    universal-apple-darwin) cpu="universal" ;;
    *) continue ;;
  esac

  dmg_dir="$TARGET_DIR/$arch_dir/release/bundle/dmg"
  [ -d "$dmg_dir" ] || continue

  for f in "$dmg_dir"/*.dmg; do
    [ -f "$f" ] || continue
    new_name="$dmg_dir/Octrix-${cpu}.dmg"
    if [ "$f" != "$new_name" ]; then
      rm -f "$new_name"
      mv "$f" "$new_name"
      echo "Renamed: $(basename "$f") -> $(basename "$new_name")"
    fi
  done
done

#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_dir="$root_dir/client/web"
cli="$HOME/.local/bin/octrix"

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "缺少命令：$1" >&2; exit 1; }
}

target_triple() {
  case "$(uname -m)" in
    arm64) echo aarch64-apple-darwin ;;
    x86_64) echo x86_64-apple-darwin ;;
    *) echo "不支持的 Mac 架构：$(uname -m)" >&2; exit 1 ;;
  esac
}

build_host() {
  require node
  require npm
  if [[ ! -d "$web_dir/node_modules" ]]; then
    echo "首次运行，正在安装构建依赖…"
    (cd "$web_dir" && npm install)
  fi
  echo "正在构建独立 Octrix Host（包含 Web 终端 TUI）…"
  (cd "$web_dir" && TAURI_ENV_TARGET_TRIPLE="$(target_triple)" npm run build:host:artifacts)
}

main() {
  require curl
  build_host
  /bin/bash "$web_dir/host/install.sh" --source-root "$web_dir"

  if (( $# == 0 )); then
    exec "$cli" auth
  fi
  local command="$1"
  if [[ "$command" == "--device-code" ]]; then
    exec "$cli" auth --device-code
  fi
  exec "$cli" "$@"
}

main "$@"

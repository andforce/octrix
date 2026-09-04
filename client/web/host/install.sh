#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_root="$(cd "$script_dir/.." && pwd)"
install_root="${OCTRIX_HOST_BASE_DIR:-$HOME/.local/share/octrix-host}"
current="$install_root/current"
releases="$install_root/releases"
user_cli="$HOME/.local/bin/octrix"
plist_path="${OCTRIX_HOST_PLIST:-$HOME/Library/LaunchAgents/work.octrix.host.plist}"
legacy_plist="$HOME/Library/LaunchAgents/com.octrix.local-dev.plist"
launchctl_bin="${OCTRIX_LAUNCHCTL:-/bin/launchctl}"
gui_domain="gui/$(id -u)"

usage() {
  echo "用法：install.sh [--source-root <包含 dist-runtime、dist-server、dist 和 host 的目录>]" >&2
}

while (( $# > 0 )); do
  case "$1" in
    --source-root)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      source_root="$(cd "$2" && pwd)"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

require_source() {
  local required
  for required in \
    "$source_root/dist-runtime/node" \
    "$source_root/dist-server/index.mjs" \
    "$source_root/dist-server/node_modules" \
    "$source_root/dist/index.html" \
    "$source_root/host/bin/octrix"; do
    if [[ ! -e "$required" ]]; then
      echo "Octrix Host 安装包不完整：$required" >&2
      exit 1
    fi
  done
}

same_as_current() {
  [[ -d "$current/runtime" && -d "$current/server" && -d "$current/web" ]] || return 1
  /usr/bin/diff -qr "$source_root/dist-runtime" "$current/runtime" >/dev/null 2>&1 &&
    /usr/bin/diff -qr "$source_root/dist-server" "$current/server" >/dev/null 2>&1 &&
    /usr/bin/diff -qr "$source_root/dist" "$current/web" >/dev/null 2>&1 &&
    /usr/bin/cmp -s "$source_root/host/bin/octrix" "$current/bin/octrix"
}

install_payload() {
  local staging="$install_root/.staging.$$"
  local release="$releases/$(date -u +%Y%m%d%H%M%S)-$$"
  rm -rf "$staging"
  mkdir -p "$staging/bin" "$releases"
  trap 'rm -rf "$staging"' EXIT

  /usr/bin/ditto "$source_root/dist-runtime" "$staging/runtime"
  /usr/bin/ditto "$source_root/dist-server" "$staging/server"
  /usr/bin/ditto "$source_root/dist" "$staging/web"
  /usr/bin/install -m 0755 "$source_root/host/bin/octrix" "$staging/bin/octrix"
  chmod 0755 "$staging/runtime/node"
  find "$staging/server/node_modules/node-pty" -name spawn-helper -type f -exec chmod 0755 {} \; 2>/dev/null || true

  mv "$staging" "$release"
  ln -sfn "$release" "$current"
  trap - EXIT
}

migrate_legacy_service() {
  [[ -f "$legacy_plist" ]] || return 0
  "$launchctl_bin" bootout "$gui_domain" "$legacy_plist" >/dev/null 2>&1 || true
  "$launchctl_bin" disable "$gui_domain/com.octrix.local-dev" >/dev/null 2>&1 || true
  echo "已停用旧的 Octrix 开发常驻服务，避免与独立 Host 重复运行。"
}

remove_old_releases() {
  local current_target candidate
  current_target="$(readlink "$current" 2>/dev/null || true)"
  [[ -n "$current_target" ]] || return 0
  for candidate in "$releases"/*; do
    [[ -e "$candidate" || -L "$candidate" ]] || continue
    [[ "$candidate" == "$current_target" ]] || rm -rf "$candidate"
  done
}

require_source
mkdir -p "$install_root" "$(dirname "$user_cli")"
migrate_legacy_service

changed=true
if same_as_current; then
  changed=false
  echo "Octrix Host 已是当前版本。"
else
  install_payload
fi

/usr/bin/install -m 0755 "$current/bin/octrix" "$user_cli"
if [[ "$changed" == true || ! -f "$plist_path" || -n "${OCTRIX_CLOUD_URL:-}" ]]; then
  "$current/bin/octrix" install-service
fi
OCTRIX_LOCAL_PORT="${OCTRIX_LOCAL_PORT:-39800}" "$current/bin/octrix" start

if [[ "$changed" == true ]]; then
  remove_old_releases
  echo "Octrix Host 安装完成；Web TUI、AI 会话和远程连接现已由后台 Host 提供。"
else
  echo "Octrix Host 服务已确认运行。"
fi

permission_marker="$install_root/.protected-folders-authorized-v1"
if [[ "${OCTRIX_INSTALL_SKIP_PERMISSIONS:-0}" != "1" && ! -f "$permission_marker" ]]; then
  "$current/bin/octrix" permissions
fi

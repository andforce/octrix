#!/usr/bin/env bash
set -euo pipefail

release_base="${OCTRIX_RELEASE_BASE_URL:-https://github.com/andforce/octrix/releases/latest/download}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Octrix Host 安装器目前只支持 macOS。" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "Octrix Host 暂不支持此 Mac 架构：$(uname -m)" >&2; exit 1 ;;
esac

archive="Octrix-Host-${arch}.tar.gz"
workspace="$(mktemp -d "${TMPDIR:-/tmp}/octrix-host.XXXXXX")"
trap 'rm -rf "$workspace"' EXIT

echo "正在下载 Octrix Host（${arch}）…"
/usr/bin/curl -fL --retry 3 --connect-timeout 20 \
  "$release_base/$archive" -o "$workspace/$archive"
/usr/bin/curl -fL --retry 3 --connect-timeout 20 \
  "$release_base/$archive.sha256" -o "$workspace/$archive.sha256"

(cd "$workspace" && /usr/bin/shasum -a 256 -c "$archive.sha256")
mkdir -p "$workspace/package"
/usr/bin/tar -xzf "$workspace/$archive" -C "$workspace/package"
if ! /bin/bash "$workspace/package/host/install.sh" --source-root "$workspace/package"; then
  echo "Octrix Host 安装失败。请保留上方日志并重新运行安装命令。" >&2
  exit 1
fi

cli="$HOME/.local/bin/octrix"
if [[ ! -x "$cli" ]]; then
  echo "Octrix Host 安装器未生成可执行命令：$cli" >&2
  exit 1
fi

if command -v octrix >/dev/null 2>&1; then
  echo "octrix 命令已就绪：$(command -v octrix)"
else
  echo "octrix 已安装到：$cli"
  echo '当前终端尚未包含 ~/.local/bin；请运行：export PATH="$HOME/.local/bin:$PATH"'
fi

if [[ "${OCTRIX_INSTALL_NO_LOGIN:-0}" != "1" ]]; then
  "$cli" login
fi

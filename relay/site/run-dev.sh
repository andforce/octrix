#!/bin/bash
set -euo pipefail

site_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
relay_dir="$(cd "$site_dir/.." && pwd)"
state_dir="$site_dir/.local-dev"
backend_pid=''
frontend_pid=''

fail() {
  echo "[run-dev] $*" >&2
  exit 1
}

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
  echo '用法：./run-dev.sh'
  echo '启动网站 http://127.0.0.1:5174 和本地后端 http://127.0.0.1:8790。'
  echo '需要 Node.js >= 22.12、npm 和 curl；按 Ctrl+C 停止两个服务。'
  echo '可用 NODE_BIN=/绝对路径/node 指定运行时。'
  exit 0
fi
[[ $# == 0 ]] || fail '不支持的参数；使用 --help 查看用法。'

for tool in npm curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "缺少命令：$tool"
done

# 固定使用检查过的 Node，避免 npm 子进程选到另一套旧版运行时。
# 非交互环境可能未加载 n 的 PATH，兼容其常用用户级安装目录。
node_candidates=("$(command -v node || true)" "$HOME/.n/bin/node")
if [[ -n "${NODE_BIN:-}" ]]; then
  node_candidates=("$NODE_BIN")
fi
node_bin=''
for candidate in "${node_candidates[@]}"; do
  if [[ -x "$candidate" ]] && "$candidate" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1);
  '; then
    node_bin="$("$candidate" -p 'process.execPath')"
    break
  fi
done
[[ -n "$node_bin" ]] || fail '未找到 Node.js >= 22.12。请先切换 Node 版本，或用 NODE_BIN 指定可执行文件。'
export PATH="$(dirname "$node_bin"):$PATH"

# 先检查端口，不接管或结束其他服务。
"$node_bin" --input-type=module - <<'NODE'
import net from 'node:net';
for (const port of [5174, 8790]) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  }).catch(error => {
    console.error(`[run-dev] 无法使用本地端口 ${port}（${error.code}），请先停止占用它的服务。`);
    process.exit(1);
  });
}
NODE

for project_dir in "$relay_dir" "$site_dir"; do
  if ! (cd "$project_dir" && npm ls --depth=0 >/dev/null 2>&1); then
    echo "[run-dev] 安装依赖：$project_dir"
    (cd "$project_dir" && npm ci --no-audit --no-fund)
  fi
done

# 开发数据库与 pepper 一起持久化，重启后已有本地账号和凭证仍然有效。
umask 077
mkdir -p "$state_dir"
if [[ -z "${OCTRIX_TOKEN_PEPPER:-}" ]]; then
  OCTRIX_TOKEN_PEPPER="$("$node_bin" - "$state_dir/token-pepper" <<'NODE'
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const filename = process.argv[2];
try {
  fs.writeFileSync(filename, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
process.stdout.write(fs.readFileSync(filename, 'utf8').trim());
NODE
  )"
fi
export OCTRIX_TOKEN_PEPPER
export OCTRIX_DATABASE_URL="${OCTRIX_DATABASE_URL:-file:$state_dir/octrix.sqlite3}"
export OCTRIX_PUBLIC_URL='http://127.0.0.1:5174'
export RELAY_HOST='127.0.0.1'
export RELAY_PORT='8790'

cleanup() {
  trap - EXIT INT TERM
  for child_pid in "$frontend_pid" "$backend_pid"; do
    if [[ -n "$child_pid" ]]; then
      kill "$child_pid" 2>/dev/null || true
    fi
  done
  for child_pid in "$frontend_pid" "$backend_pid"; do
    if [[ -n "$child_pid" ]]; then
      wait "$child_pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_ready() {
  local url="$1" child_pid="$2" label="$3"
  local attempt
  for ((attempt = 0; attempt < 60; attempt++)); do
    kill -0 "$child_pid" 2>/dev/null || fail "$label 启动失败，请查看上方日志。"
    if curl --fail --silent --max-time 1 "$url" >/dev/null; then
      return
    fi
    sleep 0.5
  done
  fail "$label 就绪检查超时：$url"
}

echo "[run-dev] Node $("$node_bin" --version)；本地数据：$state_dir"
(
  cd "$relay_dir"
  exec "$node_bin" --watch --import tsx src/index.ts
) &
backend_pid=$!
wait_ready 'http://127.0.0.1:8790/readyz' "$backend_pid" '后端'

(
  cd "$site_dir"
  exec "$node_bin" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort --clearScreen false
) &
frontend_pid=$!
wait_ready 'http://127.0.0.1:5174/readyz' "$frontend_pid" '网站 API 代理'

echo '[run-dev] 网站已就绪：http://127.0.0.1:5174/'
echo '[run-dev] 前后端均支持修改后自动重载；按 Ctrl+C 停止。'
echo '[run-dev] 登录需另外配置 Apple、Google 或短信凭据；配置说明见 relay/README.md。'

while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
  sleep 1
done
fail '开发服务已退出，正在停止另一服务。'

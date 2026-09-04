#!/usr/bin/env bash
# OpenCode 侧的消息监听脚本
#
# 在独立终端中运行此脚本，它会持续轮询 CLI Bridge 的收件箱，
# 收到消息后将内容写入一个约定文件，供 opencode 读取。
#
# 用法:
#   ./opencode-watcher.sh
#
# 当收到消息后，内容写入 /tmp/cli-bridge-opencode-inbox.txt，
# 你可以在 opencode 的 AGENTS.md 或配置中添加：
#   "定期检查 /tmp/cli-bridge-opencode-inbox.txt，若有新内容则读取并处理。"

set -euo pipefail
PORT=${CLI_BRIDGE_PORT:-9800}
PEER="opencode"
INTERVAL=2
LAST_TS=0
INBOX_FILE="/tmp/cli-bridge-${PEER}-inbox.txt"

echo "[watcher] 监听 ${PEER} 的消息 → ${INBOX_FILE}"

while true; do
  RESULT=$(curl -sS "http://127.0.0.1:${PORT}/v1/inbox?peer=${PEER}&after=${LAST_TS}" 2>/dev/null || echo "[]")
  if [ "$RESULT" != "[]" ] && [ -n "$RESULT" ]; then
    echo "$RESULT" | python3 -c "
import sys, json
for msg in json.load(sys.stdin):
    print(f'[{msg[\"from\"]}] {msg[\"body\"]}')
" >> "$INBOX_FILE"
    LAST_TS=$(python3 -c "import time; print(int(time.time()))")
    echo "[watcher] 收到新消息，已追加到 ${INBOX_FILE}"
  fi
  sleep "$INTERVAL"
done

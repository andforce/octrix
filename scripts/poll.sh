#!/usr/bin/env bash
# 轮询 CLI Bridge 的收件箱
# 用法: ./poll.sh <peer> [interval_seconds]
# 环境变量: CLI_BRIDGE_PORT (默认 9800)

set -euo pipefail
PORT=${CLI_BRIDGE_PORT:-9800}
PEER=${1:?"用法: poll.sh <peer> [interval]"}
INTERVAL=${2:-2}
LAST_TS=0

while true; do
  RESULT=$(curl -sS "http://127.0.0.1:${PORT}/v1/inbox?peer=${PEER}&after=${LAST_TS}" 2>/dev/null || echo "[]")
  if [ "$RESULT" != "[]" ] && [ -n "$RESULT" ]; then
    echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
    LAST_TS=$(python3 -c "import time; print(int(time.time()))")
  fi
  sleep "$INTERVAL"
done

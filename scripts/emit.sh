#!/usr/bin/env bash
# 向 CLI Bridge 发送一条消息
# 用法: ./emit.sh <from> <to> <message...>
# 环境变量: CLI_BRIDGE_PORT (默认 9800)

set -euo pipefail
PORT=${CLI_BRIDGE_PORT:-9800}

FROM=${1:?"用法: emit.sh <from> <to> <message>"}
TO=${2:?"用法: emit.sh <from> <to> <message>"}
shift 2
BODY="$*"

curl -sS -X POST "http://127.0.0.1:${PORT}/v1/emit" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"${FROM}\",\"to\":\"${TO}\",\"body\":\"${BODY}\"}"
echo

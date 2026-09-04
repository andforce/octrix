#!/usr/bin/env bash
# Agent 工作流步骤完成上报
# 用法: ./agent-task-done.sh <agent_name> <group_id> [result_message...]
# 环境变量: CLI_BRIDGE_PORT (默认 9800)

set -euo pipefail
PORT=${CLI_BRIDGE_PORT:-9800}

AGENT=${1:?"用法: agent-task-done.sh <agent_name> <group_id> [result]"}
GROUP_ID=${2:?"用法: agent-task-done.sh <agent_name> <group_id> [result]"}
shift 2
RESULT="${*:-done}"

curl -sS -X POST "http://127.0.0.1:${PORT}/v1/emit" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"${AGENT}\",\"to\":\"system\",\"body\":\"/wf done ${RESULT}\",\"groupId\":\"${GROUP_ID}\"}"
echo

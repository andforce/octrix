#!/usr/bin/env bash
# Claude Code Post-Tool Hook 示例
#
# 将此脚本配置到 Claude Code 的 hook 或自定义 skill 中，
# 在每次工具调用完成后通知 opencode。
#
# 配置方式（以 .claude/settings.json 为例）:
#   "hooks": {
#     "PostToolUse": [
#       { "command": "/path/to/claude-post-tool-hook.sh" }
#     ]
#   }
#
# 或在 CLAUDE.md 中指示 Claude Code：
#   "每完成一个任务步骤后，执行:
#    bash /path/to/scripts/emit.sh claude opencode <完成内容摘要>"

set -euo pipefail
PORT=${CLI_BRIDGE_PORT:-9800}
TOOL_NAME=${CLAUDE_TOOL_NAME:-"unknown"}

curl -sS -X POST "http://127.0.0.1:${PORT}/v1/emit" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"claude\",\"to\":\"opencode\",\"body\":\"tool=${TOOL_NAME} done\"}" \
  >/dev/null 2>&1 || true

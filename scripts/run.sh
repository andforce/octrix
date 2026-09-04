#!/bin/zsh
# 模拟 Xcode 编译并运行 CLIBridge.app

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$PROJECT_DIR/CLIBridge.xcodeproj"
SCHEME="CLIBridge"
CONFIGURATION="${1:-Debug}"
BUILD_DIR="$PROJECT_DIR/.build/xcode"

# ── 颜色输出 ──────────────────────────────────────────────────
BOLD=$'\033[1m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
RED=$'\033[0;31m'
CYAN=$'\033[0;36m'
RESET=$'\033[0m'

step()  { echo "${CYAN}▶ $*${RESET}"; }
ok()    { echo "${GREEN}✔ $*${RESET}"; }
warn()  { echo "${YELLOW}⚠ $*${RESET}"; }
fail()  { echo "${RED}✘ $*${RESET}" >&2; exit 1; }

# ── 环境检查 ──────────────────────────────────────────────────
step "检查环境..."
command -v xcodebuild &>/dev/null || fail "未找到 xcodebuild，请安装 Xcode"
[[ -d "$PROJECT" ]] || fail "未找到项目文件：$PROJECT"
ok "环境正常（Configuration: ${BOLD}$CONFIGURATION${RESET}）"

# ── 编译 ──────────────────────────────────────────────────────
step "开始编译 $SCHEME ($CONFIGURATION)..."
echo "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

BUILD_LOG=$(mktemp)

xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -derivedDataPath "$BUILD_DIR" \
    build \
    2>&1 | tee "$BUILD_LOG" | xcbeautify 2>/dev/null \
    || xcodebuild \
        -project "$PROJECT" \
        -scheme "$SCHEME" \
        -configuration "$CONFIGURATION" \
        -derivedDataPath "$BUILD_DIR" \
        build \
        2>&1 || { fail "编译失败，请查看上方日志"; }

echo "${BOLD}━━━━━━━━━━━━OG"


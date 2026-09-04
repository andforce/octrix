#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
FASTLANE_ENV_FILE="$PROJECT_DIR/fastlane/.env"

if [[ -x "/opt/homebrew/opt/ruby/bin/ruby" ]]; then
  export PATH="/opt/homebrew/opt/ruby/bin:$PATH"
elif [[ -x "/usr/local/opt/ruby/bin/ruby" ]]; then
  export PATH="/usr/local/opt/ruby/bin:$PATH"
fi

usage() {
  cat <<'EOF'
Usage:
  ./sign-build.sh                 Build, sign, notarize arm64 + x64 DMGs
  ./sign-build.sh arm64           Build, sign, notarize arm64 DMG
  ./sign-build.sh x64             Build, sign, notarize x64 DMG
  ./sign-build.sh both            Build, sign, notarize arm64 + x64 DMGs
  ./sign-build.sh universal       Build, sign, notarize universal DMG
  ./sign-build.sh aarch64-apple-darwin
  ./sign-build.sh x86_64-apple-darwin
  ./sign-build.sh --targets aarch64-apple-darwin,x86_64-apple-darwin
EOF
}

resolve_targets() {
  local input="${1:-}"

  case "$input" in
    ""|"both")
      echo "aarch64-apple-darwin,x86_64-apple-darwin"
      ;;
    "arm64")
      echo "aarch64-apple-darwin"
      ;;
    "x64")
      echo "x86_64-apple-darwin"
      ;;
    "universal")
      echo "universal-apple-darwin"
      ;;
    "aarch64-apple-darwin"|"x86_64-apple-darwin"|"universal-apple-darwin")
      echo "$input"
      ;;
    *)
      echo "$input"
      ;;
  esac
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "$FASTLANE_ENV_FILE" ]]; then
  echo "Missing $FASTLANE_ENV_FILE"
  echo "Create it first, for example:"
  echo "  cp fastlane/.env.example fastlane/.env"
  exit 1
fi

if ! command -v bundle >/dev/null 2>&1; then
  echo "bundler is not available in PATH"
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is not available in PATH"
  exit 1
fi

if [[ "${1:-}" == "--targets" ]]; then
  TARGETS="${2:-}"
  if [[ -z "$TARGETS" ]]; then
    echo "--targets requires a comma-separated value"
    exit 1
  fi
else
  TARGETS="$(resolve_targets "${1:-}")"
fi

if [[ -z "$TARGETS" ]]; then
  echo "Unable to resolve targets"
  exit 1
fi

echo "Using targets: $TARGETS"

cd "$PROJECT_DIR"

bundle check >/dev/null 2>&1 || bundle install
bundle exec fastlane mac release "targets:$TARGETS" "include_applications_link:true"

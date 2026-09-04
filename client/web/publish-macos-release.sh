#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./publish-macos-release.sh [<version>] [build-target]

Examples:
  ./publish-macos-release.sh
  ./publish-macos-release.sh arm64
  ./publish-macos-release.sh 2026.07.16.13.34
  ./publish-macos-release.sh 2026.07.16.13.34 arm64
  ./publish-macos-release.sh 2026.07.16.13.34 x64
  ./publish-macos-release.sh 2026.07.16.13.34 both
  ./publish-macos-release.sh 2026.07.16.13.34 universal

Notes:
  - This is the paused, explicit macOS App/DMG release path
  - Versions use the Asia/Shanghai timestamp format YYYY.MM.DD.HH.mm
  - If version is omitted, the current Asia/Shanghai minute is used
  - Cargo keeps a compatible three-part internal version derived from the release version
  - The working tree must be clean before publishing
  - build-target defaults to "both" when omitted
  - The script publishes assets to GitHub repo: andforce/octrix
  - After upload succeeds, the version files are committed and pushed separately
  - The release tag is exactly the version string, e.g. "2026.07.16.13.34"
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

PUBLIC_REPO="andforce/octrix"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DMG_DIR="${SCRIPT_DIR}/release-dmg"
HOST_DIR="${SCRIPT_DIR}/release-host"
CARGO_TOML="${SCRIPT_DIR}/src-tauri/Cargo.toml"
CARGO_LOCK="${SCRIPT_DIR}/src-tauri/Cargo.lock"
RELEASE_VERSION_FILE="${SCRIPT_DIR}/RELEASE_VERSION"

is_release_version() {
  [[ "$1" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}$ ]]
}

cargo_version_for_release() {
  local release_version="$1"
  local year month day hour minute
  IFS=. read -r year month day hour minute <<< "$release_version"
  printf '%d.%d.%d' \
    "$((10#${year}))" \
    "$((10#${month} * 100 + 10#${day}))" \
    "$((10#${hour} * 100 + 10#${minute}))"
}

is_build_target_token() {
  case "$1" in
    arm64|x64|both|universal|aarch64-apple-darwin|x86_64-apple-darwin|universal-apple-darwin)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

VERSION=""
BUILD_TARGET="both"

if [[ -n "${1:-}" ]]; then
  if is_release_version "$1"; then
    VERSION="$1"
    BUILD_TARGET="${2:-both}"
  elif is_build_target_token "$1"; then
    BUILD_TARGET="$1"
  else
    echo "Invalid first argument: expected YYYY.MM.DD.HH.mm or build-target, got: $1"
    usage
    exit 1
  fi
else
  BUILD_TARGET="${2:-both}"
fi

if [[ -z "$VERSION" ]]; then
  VERSION="$(TZ=Asia/Shanghai date '+%Y.%m.%d.%H.%M')"
  echo "==> No version argument: using ${VERSION} (Asia/Shanghai)"
fi

TAG="${VERSION}"
CARGO_VERSION="$(cargo_version_for_release "${VERSION}")"

if [[ ! -f "${CARGO_TOML}" ]]; then
  echo "Cargo.toml not found: ${CARGO_TOML}"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is not available in PATH"
  exit 1
fi

if ! command -v bash >/dev/null 2>&1; then
  echo "bash is not available in PATH"
  exit 1
fi

if [[ -n "$(git -C "${REPO_ROOT}" status --porcelain)" ]]; then
  echo "Working tree must be clean before publishing. Commit or stash existing changes first."
  git -C "${REPO_ROOT}" status --short
  exit 1
fi

CURRENT_BRANCH="$(git -C "${REPO_ROOT}" branch --show-current)"
if [[ -z "${CURRENT_BRANCH}" ]]; then
  echo "Publishing from a detached HEAD is not supported"
  exit 1
fi

echo "==> Record release version ${VERSION}"
printf '%s\n' "${VERSION}" > "${RELEASE_VERSION_FILE}"

echo "==> Update Cargo internal version to ${CARGO_VERSION}"
TMP_FILE="$(mktemp)"
if ! awk -v version="${CARGO_VERSION}" '
  BEGIN { updated = 0 }
  /^version = ".*"/ && updated == 0 {
    print "version = \"" version "\""
    updated = 1
    next
  }
  { print }
  END {
    if (updated == 0) {
      exit 2
    }
  }
' "${CARGO_TOML}" > "${TMP_FILE}"; then
  rm -f "${TMP_FILE}"
  echo "Failed to update version in ${CARGO_TOML}"
  exit 1
fi
mv "${TMP_FILE}" "${CARGO_TOML}"

echo "==> Build and sign DMG (target: ${BUILD_TARGET})"
"${SCRIPT_DIR}/sign-build.sh" "${BUILD_TARGET}"

build_host() {
  local target="$1"
  echo "==> Build Octrix Host (${target})"
  (cd "${SCRIPT_DIR}" && OCTRIX_HOST_VERSION="${VERSION}" TAURI_ENV_TARGET_TRIPLE="${target}" npm run build:host)
}

rm -rf "${HOST_DIR}"
case "${BUILD_TARGET}" in
  arm64|aarch64-apple-darwin)
    build_host aarch64-apple-darwin
    ;;
  x64|x86_64-apple-darwin)
    build_host x86_64-apple-darwin
    ;;
  both|universal|universal-apple-darwin)
    build_host aarch64-apple-darwin
    build_host x86_64-apple-darwin
    ;;
esac

echo "==> Collect DMG artifacts from ${DMG_DIR}"
if [[ ! -d "${DMG_DIR}" ]]; then
  echo "DMG directory not found: ${DMG_DIR}"
  exit 1
fi

shopt -s nullglob
DMG_FILES=("${DMG_DIR}"/*.dmg)
HOST_FILES=("${HOST_DIR}"/*.tar.gz "${HOST_DIR}"/*.tar.gz.sha256)
shopt -u nullglob

if [[ ${#DMG_FILES[@]} -eq 0 ]]; then
  echo "No DMG artifact found in: ${DMG_DIR}"
  exit 1
fi

if [[ ${#HOST_FILES[@]} -eq 0 ]]; then
  echo "No Host artifact found in: ${HOST_DIR}"
  exit 1
fi

ASSET_FILES=("${DMG_FILES[@]}" "${HOST_FILES[@]}")

echo "==> Assets to upload:"
for file in "${ASSET_FILES[@]}"; do
  echo " - ${file}"
done

echo "==> Ensure release ${TAG} exists in ${PUBLIC_REPO}"
if gh release view "${TAG}" --repo "${PUBLIC_REPO}" >/dev/null 2>&1; then
  echo "Release exists, uploading assets with overwrite"
  gh release upload "${TAG}" "${ASSET_FILES[@]}" --repo "${PUBLIC_REPO}" --clobber
else
  echo "Release does not exist, creating release and uploading assets"
  gh release create "${TAG}" "${ASSET_FILES[@]}" \
    --repo "${PUBLIC_REPO}" \
    --target main \
    --title "${VERSION}" \
    --notes "Release ${VERSION}"
fi

echo "==> Done"
echo "Release URL: https://github.com/${PUBLIC_REPO}/releases/tag/${TAG}"

echo "==> Commit and push release version"
VERSION_PATHS=(
  "client/web/RELEASE_VERSION"
  "client/web/src-tauri/Cargo.toml"
)
if [[ -f "${CARGO_LOCK}" ]]; then
  VERSION_PATHS+=("client/web/src-tauri/Cargo.lock")
fi

git -C "${REPO_ROOT}" add -- "${VERSION_PATHS[@]}"
git -C "${REPO_ROOT}" diff --cached --check
if git -C "${REPO_ROOT}" diff --cached --quiet -- "${VERSION_PATHS[@]}"; then
  echo "Version ${VERSION} is already recorded; no version commit is needed"
else
  git -C "${REPO_ROOT}" commit -m "chore(release): ${VERSION}" -- "${VERSION_PATHS[@]}"
fi
git -C "${REPO_ROOT}" push origin "${CURRENT_BRANCH}"

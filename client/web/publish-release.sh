#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./publish-release.sh [<version>] [build-target]

Examples:
  ./publish-release.sh
  ./publish-release.sh 2026.07.16.18.10
  ./publish-release.sh 2026.07.16.18.10 arm64
  ./publish-release.sh 2026.07.16.18.10 x64
  ./publish-release.sh 2026.07.16.18.10 both

Notes:
  - This is the default Host-only release path; it never builds or uploads a DMG
  - Versions use the Asia/Shanghai timestamp format YYYY.MM.DD.HH.mm
  - If version is omitted, the current Asia/Shanghai minute is used
  - build-target defaults to "both"
  - The working tree must be clean before publishing
  - The script publishes Host archives and checksums to andforce/octrix
  - After upload succeeds, client/web/RELEASE_VERSION is committed and pushed
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

PUBLIC_REPO="andforce/octrix"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOST_DIR="${SCRIPT_DIR}/release-host"
RELEASE_VERSION_FILE="${SCRIPT_DIR}/RELEASE_VERSION"

is_release_version() {
  [[ "$1" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}$ ]]
}

is_build_target_token() {
  case "$1" in
    arm64|x64|both|aarch64-apple-darwin|x86_64-apple-darwin)
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
fi

if ! is_build_target_token "${BUILD_TARGET}"; then
  echo "Invalid build-target: ${BUILD_TARGET}"
  usage
  exit 1
fi

if [[ -z "${VERSION}" ]]; then
  VERSION="$(TZ=Asia/Shanghai date '+%Y.%m.%d.%H.%M')"
  echo "==> No version argument: using ${VERSION} (Asia/Shanghai)"
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is not available in PATH"
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
  both)
    build_host aarch64-apple-darwin
    build_host x86_64-apple-darwin
    ;;
esac

shopt -s nullglob
HOST_FILES=("${HOST_DIR}"/*.tar.gz "${HOST_DIR}"/*.tar.gz.sha256)
shopt -u nullglob

expected_assets=2
[[ "${BUILD_TARGET}" == "both" ]] && expected_assets=4
if [[ ${#HOST_FILES[@]} -ne ${expected_assets} ]]; then
  echo "Expected ${expected_assets} Host artifacts, found ${#HOST_FILES[@]} in ${HOST_DIR}"
  exit 1
fi

for file in "${HOST_FILES[@]}"; do
  case "${file}" in
    *.dmg)
      echo "Host-only release must not contain a DMG: ${file}"
      exit 1
      ;;
  esac
done

verify_host_archive() {
  local archive="$1"
  local listing manifest
  listing="$(/usr/bin/tar -tzf "${archive}")"
  grep -qx './dist/index.html' <<< "${listing}" || { echo "Missing Web TUI in ${archive}"; exit 1; }
  grep -qx './host/bin/octrix' <<< "${listing}" || { echo "Missing octrix CLI in ${archive}"; exit 1; }
  manifest="$(/usr/bin/tar -xOzf "${archive}" ./host-manifest.json)"
  grep -q "\"version\": \"${VERSION}\"" <<< "${manifest}" || {
    echo "Host/Web TUI version mismatch in ${archive}"
    exit 1
  }
}

for checksum in "${HOST_DIR}"/*.tar.gz.sha256; do
  (cd "${HOST_DIR}" && /usr/bin/shasum -a 256 -c "$(basename "${checksum}")")
done
for archive in "${HOST_DIR}"/*.tar.gz; do
  verify_host_archive "${archive}"
done

echo "==> Host assets to upload:"
for file in "${HOST_FILES[@]}"; do
  echo " - ${file}"
done

printf '%s\n' "${VERSION}" > "${RELEASE_VERSION_FILE}"
git -C "${REPO_ROOT}" add -- client/web/RELEASE_VERSION
git -C "${REPO_ROOT}" diff --cached --check
if ! git -C "${REPO_ROOT}" diff --cached --quiet -- client/web/RELEASE_VERSION; then
  git -C "${REPO_ROOT}" commit -m "chore(release): ${VERSION}" -- client/web/RELEASE_VERSION
fi
git -C "${REPO_ROOT}" push origin "${CURRENT_BRANCH}"

TAG="${VERSION}"
RELEASE_NOTES="$(printf 'Octrix Host %s\n\nHost-only release for the local Web TUI and iPhone remote access. No macOS App or DMG is included.' "${VERSION}")"
if gh release view "${TAG}" --repo "${PUBLIC_REPO}" >/dev/null 2>&1; then
  gh release upload "${TAG}" "${HOST_FILES[@]}" --repo "${PUBLIC_REPO}" --clobber
  gh release edit "${TAG}" --repo "${PUBLIC_REPO}" --latest
else
  gh release create "${TAG}" "${HOST_FILES[@]}" \
    --repo "${PUBLIC_REPO}" \
    --target main \
    --title "${VERSION}" \
    --latest \
    --notes "${RELEASE_NOTES}"
fi

echo "==> Host-only release published"
echo "Release URL: https://github.com/${PUBLIC_REPO}/releases/tag/${TAG}"

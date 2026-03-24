/** Octrix macOS 安装包（GitHub Releases）— 更新版本时改此处即可 */
export const OCTRIX_RELEASE_VERSION = '1.0.1'

const releaseBase = `https://github.com/andforce/octrix/releases/download/${OCTRIX_RELEASE_VERSION}`

export const OCTRIX_MACOS_DMGS = {
  appleSilicon: `${releaseBase}/Octrix_${OCTRIX_RELEASE_VERSION}_aarch64.dmg`,
  intel: `${releaseBase}/Octrix_${OCTRIX_RELEASE_VERSION}_x64.dmg`,
} as const

export const OCTRIX_GITHUB_REPO = 'andforce/octrix'

/** GitHub API 不可用时，退回到这组固定版本下载地址 */
export const OCTRIX_RELEASE_VERSION = '1.0.1'

const releaseBase = `https://github.com/andforce/octrix/releases/download/${OCTRIX_RELEASE_VERSION}`

export const OCTRIX_MACOS_DMGS = {
  appleSilicon: `${releaseBase}/Octrix_${OCTRIX_RELEASE_VERSION}_aarch64.dmg`,
  intel: `${releaseBase}/Octrix_${OCTRIX_RELEASE_VERSION}_x64.dmg`,
} as const

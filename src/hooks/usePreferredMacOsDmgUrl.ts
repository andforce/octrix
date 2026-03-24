import { useEffect, useState } from 'react'
import { OCTRIX_MACOS_DMGS } from '../constants/download'

function initialPreferredUrl(): string {
  if (typeof navigator === 'undefined') {
    return OCTRIX_MACOS_DMGS.appleSilicon
  }
  const ua = navigator.userAgent
  if (/arm64|aarch64/i.test(ua)) {
    return OCTRIX_MACOS_DMGS.appleSilicon
  }
  // Chrome / Firefox 等在 Intel Mac 上通常带 x86_64 且不含 arm64
  if (/Mac OS X/.test(ua) && /\bx86_64\b/i.test(ua)) {
    return OCTRIX_MACOS_DMGS.intel
  }
  return OCTRIX_MACOS_DMGS.appleSilicon
}

/**
 * 优先 Apple Silicon DMG；可结合 UA 与 Client Hints 在客户端修正（例如 Safari 在部分 Apple 芯片机型上 UA 仍写 Intel）。
 */
export function usePreferredMacOsDmgUrl(): string {
  const [url, setUrl] = useState(initialPreferredUrl)

  useEffect(() => {
    const ua = navigator.userAgent
    if (/arm64|aarch64/i.test(ua)) {
      setUrl(OCTRIX_MACOS_DMGS.appleSilicon)
      return
    }

    type UACH = { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> }
    const uad = (navigator as Navigator & { userAgentData?: UACH }).userAgentData
    if (uad?.getHighEntropyValues) {
      uad
        .getHighEntropyValues(['architecture'])
        .then((values) => {
          const arch = values.architecture?.toLowerCase()
          if (arch === 'arm' || arch === 'aarch64') {
            setUrl(OCTRIX_MACOS_DMGS.appleSilicon)
          } else if (arch === 'x86' || arch === 'x86-64' || arch === 'amd64') {
            setUrl(OCTRIX_MACOS_DMGS.intel)
          }
        })
        .catch(() => {})
    }
  }, [])

  return url
}

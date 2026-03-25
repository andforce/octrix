import { useEffect, useState } from 'react'
import { useLatestMacOsDmgs } from './useLatestMacOsDmgs'

function initialPreferredUrl(appleSiliconUrl: string, intelUrl: string): string {
  if (typeof navigator === 'undefined') {
    return appleSiliconUrl
  }
  const ua = navigator.userAgent
  if (/arm64|aarch64/i.test(ua)) {
    return appleSiliconUrl
  }
  // Chrome / Firefox 等在 Intel Mac 上通常带 x86_64 且不含 arm64
  if (/Mac OS X/.test(ua) && /\bx86_64\b/i.test(ua)) {
    return intelUrl
  }
  return appleSiliconUrl
}

/**
 * 优先 Apple Silicon DMG；可结合 UA 与 Client Hints 在客户端修正（例如 Safari 在部分 Apple 芯片机型上 UA 仍写 Intel）。
 */
export function usePreferredMacOsDmgUrl(): string {
  const dmgs = useLatestMacOsDmgs()
  const [url, setUrl] = useState(() => initialPreferredUrl(dmgs.appleSilicon, dmgs.intel))

  useEffect(() => {
    setUrl(initialPreferredUrl(dmgs.appleSilicon, dmgs.intel))

    const ua = navigator.userAgent
    if (/arm64|aarch64/i.test(ua)) {
      setUrl(dmgs.appleSilicon)
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
            setUrl(dmgs.appleSilicon)
          } else if (arch === 'x86' || arch === 'x86-64' || arch === 'amd64') {
            setUrl(dmgs.intel)
          }
        })
        .catch(() => {})
    }
  }, [dmgs.appleSilicon, dmgs.intel])

  return url
}

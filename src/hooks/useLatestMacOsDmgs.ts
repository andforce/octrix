import { useEffect, useState } from 'react'
import { OCTRIX_GITHUB_REPO, OCTRIX_MACOS_DMGS } from '../constants/download'

type MacOsDmgs = {
  appleSilicon: string
  intel: string
}

type GitHubReleaseAsset = {
  name: string
  browser_download_url: string
}

type GitHubRelease = {
  assets?: GitHubReleaseAsset[]
}

let cachedDmgs: MacOsDmgs | null = null
let inFlightRequest: Promise<MacOsDmgs> | null = null

function isAppleSiliconDmg(asset: GitHubReleaseAsset): boolean {
  return /\.dmg$/i.test(asset.name) && /(aarch64|arm64|apple)/i.test(asset.name)
}

function isIntelDmg(asset: GitHubReleaseAsset): boolean {
  return /\.dmg$/i.test(asset.name) && /(x64|x86_64|amd64|intel)/i.test(asset.name)
}

function pickLatestMacOsDmgs(assets: GitHubReleaseAsset[]): MacOsDmgs | null {
  const appleSilicon = assets.find(isAppleSiliconDmg)
  const intel = assets.find(isIntelDmg)

  if (!appleSilicon || !intel) {
    return null
  }

  return {
    appleSilicon: appleSilicon.browser_download_url,
    intel: intel.browser_download_url,
  }
}

async function fetchLatestMacOsDmgs(): Promise<MacOsDmgs> {
  if (cachedDmgs) {
    return cachedDmgs
  }

  if (!inFlightRequest) {
    inFlightRequest = fetch(`https://api.github.com/repos/${OCTRIX_GITHUB_REPO}/releases/latest`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`GitHub latest release request failed: ${response.status}`)
        }

        const release = (await response.json()) as GitHubRelease
        const latestDmgs = pickLatestMacOsDmgs(release.assets ?? [])

        if (!latestDmgs) {
          throw new Error('Latest release is missing macOS DMG assets')
        }

        cachedDmgs = latestDmgs
        return latestDmgs
      })
      .catch(() => OCTRIX_MACOS_DMGS)
      .finally(() => {
        inFlightRequest = null
      })
  }

  return inFlightRequest
}

export function useLatestMacOsDmgs(): MacOsDmgs {
  const [dmgs, setDmgs] = useState<MacOsDmgs>(cachedDmgs ?? OCTRIX_MACOS_DMGS)

  useEffect(() => {
    let cancelled = false

    fetchLatestMacOsDmgs().then((latestDmgs) => {
      if (!cancelled) {
        setDmgs(latestDmgs)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  return dmgs
}

export type ChromeForTestingPlatform = 'win64' | 'win32' | 'linux64' | 'linux-arm64' | 'mac-x64' | 'mac-arm64'

export function chromeForTestingPlatform(nodePlatform = process.platform, arch = process.arch): ChromeForTestingPlatform {
  if (nodePlatform === 'win32') {
    if (arch === 'arm64') throw new Error('Windows ARM64 Chrome for Testing is not certified')
    return arch === 'ia32' ? 'win32' : 'win64'
  }
  if (nodePlatform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux64'
  if (nodePlatform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  throw new Error(`Unsupported browser platform: ${nodePlatform}/${arch}`)
}

export function chromeExecutableRelPath(platform: ChromeForTestingPlatform): string {
  switch (platform) {
    case 'win64':
    case 'win32':
      return platform === 'win32' ? 'chrome-win32/chrome.exe' : 'chrome-win64/chrome.exe'
    case 'linux64':
      return 'chrome-linux64/chrome'
    case 'linux-arm64':
      return 'chrome-linux-arm64/chrome'
    case 'mac-x64':
      return 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    case 'mac-arm64':
      return 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  }
}

export const CHROME_FOR_TESTING_LAST_KNOWN_GOOD =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'

export const CERTIFIED_CHROME_CHANNEL = 'Stable' as const
export const CERTIFIED_CHROME_VERSION = '153.0.8010.36'
export const CERTIFIED_CHROME_REVISION = '1681091'
export const CERTIFIED_CHROME_DOWNLOAD_ROOT = 'https://storage.googleapis.com/chrome-for-testing-public'

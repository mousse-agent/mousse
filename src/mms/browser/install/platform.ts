import type { ManagedBrowserPlatform, ManagedBrowserPlatformInfo } from '../../../shared/browser/install'

export const CHROME_FOR_TESTING_LAST_KNOWN_GOOD =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
export const CHROME_FOR_TESTING_KNOWN_GOOD =
  'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json'
export const CHROME_FOR_TESTING_DOWNLOAD_ORIGIN = 'https://storage.googleapis.com'

export function detectManagedBrowserPlatform(
  nodePlatform = process.platform,
  arch = process.arch
): ManagedBrowserPlatformInfo {
  let platform: ManagedBrowserPlatform | undefined
  if (nodePlatform === 'win32' && (arch === 'x64' || arch === 'ia32')) platform = arch === 'ia32' ? 'win32' : 'win64'
  else if (nodePlatform === 'linux' && (arch === 'x64' || arch === 'arm64')) platform = arch === 'arm64' ? 'linux-arm64' : 'linux64'
  else if (nodePlatform === 'darwin' && (arch === 'x64' || arch === 'arm64')) platform = arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (!platform) {
    return {
      platform: 'linux64',
      nodePlatform,
      arch,
      supported: false,
      executableRelativePath: '',
      reason: `Chrome for Testing is not supported for ${nodePlatform}/${arch}.`
    }
  }
  return { platform, nodePlatform, arch, supported: true, executableRelativePath: executableRelativePath(platform) }
}

export function executableRelativePath(platform: ManagedBrowserPlatform): string {
  switch (platform) {
    case 'win64': return 'chrome-win64/chrome.exe'
    case 'win32': return 'chrome-win32/chrome.exe'
    case 'linux64': return 'chrome-linux64/chrome'
    case 'linux-arm64': return 'chrome-linux-arm64/chrome'
    case 'mac-x64': return 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    case 'mac-arm64': return 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  }
}

function archiveName(platform: ManagedBrowserPlatform): string {
  return platform.startsWith('win') ? `chrome-${platform}.zip` :
    platform.startsWith('linux') ? `chrome-${platform}.zip` : `chrome-${platform}.zip`
}

export function officialDownloadUrl(version: string, platform: ManagedBrowserPlatform): string {
  return `${CHROME_FOR_TESTING_DOWNLOAD_ORIGIN}/chrome-for-testing-public/${version}/${platform}/${archiveName(platform)}`
}

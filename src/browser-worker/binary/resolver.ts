import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CERTIFIED_CHROME_CHANNEL, CERTIFIED_CHROME_VERSION, chromeExecutableRelPath, chromeForTestingPlatform } from './platform'
import type { BrowserBinaryResolution, CertifiedBrowserMetadata } from './types'

export function certifiedMetadataPath(browserRoot: string): string {
  return join(browserRoot, 'binaries', 'certified', 'metadata.json')
}

export function certifiedInstallDir(browserRoot: string): string {
  return join(browserRoot, 'binaries', 'certified')
}

export function readCertifiedMetadata(browserRoot: string): CertifiedBrowserMetadata | null {
  const path = certifiedMetadataPath(browserRoot)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as CertifiedBrowserMetadata
    if (parsed.source !== 'chrome-for-testing' || typeof parsed.version !== 'string' || typeof parsed.sha256 !== 'string' || typeof parsed.executable !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function resolveCertifiedBrowser(browserRoot: string): BrowserBinaryResolution {
  let platform: ReturnType<typeof chromeForTestingPlatform>
  try {
    platform = chromeForTestingPlatform()
  } catch (error) {
    return { status: 'setup_required', message: error instanceof Error ? error.message : String(error) }
  }
  const metadata = readCertifiedMetadata(browserRoot)
  if (!metadata) {
    return {
      status: 'setup_required',
      message: `Managed Chrome for Testing ${CERTIFIED_CHROME_CHANNEL} ${CERTIFIED_CHROME_VERSION} (${platform}) is not installed under the injected browser root.`
    }
  }
  const executablePath = join(certifiedInstallDir(browserRoot), metadata.executable)
  if (!existsSync(executablePath)) {
    return {
      status: 'setup_required',
      metadata,
      message: `Certified metadata is present but the executable is missing: ${metadata.executable}`
    }
  }
  if (metadata.platform !== platform) {
    return {
      status: 'setup_required',
      metadata,
      executablePath,
      message: `Certified binary platform ${metadata.platform} does not match this host (${platform}).`
    }
  }
  return {
    status: 'ready',
    metadata,
    executablePath,
    message: `Certified Chrome for Testing ${metadata.version} (${metadata.platform})`
  }
}

export function expectedExecutableRelPath(): string {
  return chromeExecutableRelPath(chromeForTestingPlatform())
}

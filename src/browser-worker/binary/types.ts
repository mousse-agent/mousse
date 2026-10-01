import type { ChromeForTestingPlatform } from './platform'

export interface CertifiedBrowserMetadata {
  source: 'chrome-for-testing'
  channel: 'Stable' | 'Beta' | 'Dev' | 'Canary'
  version: string
  revision: string
  platform: ChromeForTestingPlatform
  url: string
  sha256: string
  executable: string
  certifiedAt: string
  probe?: CertifiedBrowserProbe
}

export interface CertifiedBrowserProbe {
  product: string
  userAgent: string
  protocolVersion: string
  jsVersion?: string
  revision?: string
  remoteDebuggingPipe: true
  headless: boolean
  probedAt: string
}

export interface ActiveManagedBrowserMetadata {
  source: 'chrome-for-testing-catalog' | 'injected-fixture'
  channel: 'Stable' | 'Beta' | 'Dev' | 'Canary'
  version: string
  revision?: string
  platform: ChromeForTestingPlatform
  url: string
  sha256: string
  expectedSha256?: string
  hashVerified: boolean
  executableRelativePath: string
  installedAt: string
  archiveBytes: number
  extractedBytes: number
  probe?: CertifiedBrowserProbe
}

export type BrowserBinaryMetadata = CertifiedBrowserMetadata | ActiveManagedBrowserMetadata

export interface BrowserBinaryResolution {
  status: 'ready' | 'setup_required'
  metadata?: BrowserBinaryMetadata
  executablePath?: string
  message: string
}

export interface ChromeDownloadDescriptor {
  channel: CertifiedBrowserMetadata['channel']
  version: string
  revision: string
  platform: ChromeForTestingPlatform
  url: string
}

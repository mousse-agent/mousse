export type ManagedBrowserChannel = 'Stable' | 'Beta' | 'Dev' | 'Canary'
export type ManagedBrowserPlatform = 'win64' | 'win32' | 'linux64' | 'linux-arm64' | 'mac-x64' | 'mac-arm64'

export interface ManagedBrowserPlatformInfo {
  platform: ManagedBrowserPlatform
  nodePlatform: string
  arch: string
  supported: boolean
  executableRelativePath: string
  reason?: string
}

export interface ManagedBrowserDownload {
  channel: ManagedBrowserChannel
  version: string
  revision?: string
  platform: ManagedBrowserPlatform
  url: string
  source: 'chrome-for-testing-catalog' | 'injected-fixture'
  expectedSha256?: string
}

export interface ManagedBrowserMetadata extends ManagedBrowserDownload {
  installedAt: string
  sha256: string
  hashVerified: boolean
  executableRelativePath: string
  archiveBytes: number
  extractedBytes: number
}

export interface ManagedBrowserAvailability {
  status: 'ready' | 'setup-required' | 'installing' | 'unsupported' | 'blocked'
  message: string
  platform: ManagedBrowserPlatformInfo
  version?: string
  executablePath?: string
  metadata?: ManagedBrowserMetadata
  activeSessions: number
  canInstall: boolean
}

export interface ManagedBrowserInstallProgress {
  phase: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'activating' | 'complete'
  receivedBytes: number
  totalBytes?: number
  fraction?: number
  version?: string
}

export interface ManagedBrowserInstallOptions {
  root: string
  channel?: ManagedBrowserChannel
  version?: string
  signal?: AbortSignal
  expectedSha256?: string
  maxDownloadBytes?: number
  maxExtractedBytes?: number
  lockWaitMs?: number
  activeSessions?: () => number
  fetch?: typeof globalThis.fetch
  onProgress?: (progress: ManagedBrowserInstallProgress) => void
  /** Test-only/local mirror origins; official installs remain origin-pinned. */
  allowedOrigins?: readonly string[]
}

export type ManagedBrowserExecutableProbe = (executablePath: string, signal?: AbortSignal, expectedVersion?: string) => Promise<{ version: string }>

export interface ManagedBrowserInstallResult {
  metadata: ManagedBrowserMetadata
  executablePath: string
  previousVersion?: string
}

export interface ManagedBrowserInstaller {
  platform(): ManagedBrowserPlatformInfo
  availability(root: string, activeSessions?: number): Promise<ManagedBrowserAvailability>
  resolveDownload(options?: Pick<ManagedBrowserInstallOptions, 'channel' | 'version' | 'fetch' | 'allowedOrigins' | 'signal'>): Promise<ManagedBrowserDownload>
  install(options: ManagedBrowserInstallOptions): Promise<ManagedBrowserInstallResult>
  rollback(root: string, version?: string, options?: { activeSessions?: number; lockWaitMs?: number }): Promise<ManagedBrowserAvailability>
  cleanup(root: string, options?: { activeSessions?: number; keepVersions?: number }): Promise<string[]>
  resolveExecutable(root: string): Promise<string | undefined>
}

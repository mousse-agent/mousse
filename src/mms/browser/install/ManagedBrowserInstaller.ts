import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, rm, writeFile, rename, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, join, resolve, relative } from 'node:path'
import type {
  ManagedBrowserAvailability,
  ManagedBrowserChannel,
  ManagedBrowserDownload,
  ManagedBrowserInstallOptions,
  ManagedBrowserInstallResult,
  ManagedBrowserInstaller,
  ManagedBrowserMetadata,
  ManagedBrowserPlatformInfo
} from '../../../shared/browser/install'
import { extractChromeZip } from './archive'
import {
  CHROME_FOR_TESTING_DOWNLOAD_ORIGIN,
  CHROME_FOR_TESTING_KNOWN_GOOD,
  CHROME_FOR_TESTING_LAST_KNOWN_GOOD,
  detectManagedBrowserPlatform,
  officialDownloadUrl
} from './platform'
import { activePointer, lockDir, metadataPath, stagingRoot, versionDir, versionsRoot } from './paths'

const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_LOCK_WAIT_MS = 30_000
const OFFICIAL_CATALOG_ORIGIN = 'https://googlechromelabs.github.io'

interface ActivePointer { version: string; platform: string; previousVersion?: string; activatedAt: string }

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Browser installation was cancelled.', 'AbortError')
}
function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !rel.includes('..' + '/') && !/^[A-Za-z]:/.test(rel))
}
function isSafeVersion(version: string): boolean { return /^\d+(?:\.\d+){3}$/.test(version) }
function assertSafeVersion(version: string): void {
  if (!isSafeVersion(version)) throw new Error(`Invalid Chrome for Testing version: ${version}`)
}

export class ManagedBrowserInstallerService implements ManagedBrowserInstaller {
  private readonly installing = new Set<string>()

  constructor(private readonly platformInfo: ManagedBrowserPlatformInfo = detectManagedBrowserPlatform()) {}

  platform(): ManagedBrowserPlatformInfo { return { ...this.platformInfo } }

  async resolveDownload(options: Pick<ManagedBrowserInstallOptions, 'channel' | 'version' | 'fetch' | 'allowedOrigins'> = {}): Promise<ManagedBrowserDownload> {
    if (!this.platformInfo.supported) throw new Error(this.platformInfo.reason)
    const fetcher = options.fetch ?? globalThis.fetch
    const channel = options.channel ?? 'Stable'
    const allowedOrigins = options.allowedOrigins ?? [CHROME_FOR_TESTING_DOWNLOAD_ORIGIN]
    const catalogUrl = options.version ? CHROME_FOR_TESTING_KNOWN_GOOD : CHROME_FOR_TESTING_LAST_KNOWN_GOOD
    const catalog = await fetchJson(fetcher, catalogUrl, allowedOrigins, undefined)
    const chosen = options.version
      ? findKnownVersion(catalog, options.version, this.platformInfo.platform)
      : findChannel(catalog, channel, this.platformInfo.platform)
    if (!chosen) throw new Error(`Chrome for Testing ${options.version ?? channel} has no ${this.platformInfo.platform} download.`)
    const version = chosen.version
    assertSafeVersion(version)
    const url = chosen.url ?? officialDownloadUrl(version, this.platformInfo.platform)
    assertAllowedOrigin(url, allowedOrigins)
    return {
      channel,
      version,
      revision: chosen.revision,
      platform: this.platformInfo.platform,
      url,
      source: new URL(url).origin === CHROME_FOR_TESTING_DOWNLOAD_ORIGIN ? 'chrome-for-testing-catalog' : 'injected-fixture'
    }
  }

  async install(options: ManagedBrowserInstallOptions): Promise<ManagedBrowserInstallResult> {
    if (!this.platformInfo.supported) throw new Error(this.platformInfo.reason)
    const root = resolve(options.root)
    const fetcher = options.fetch ?? globalThis.fetch
    const release = await acquireInstallLock(root, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS)
    this.installing.add(root)
    const staging = join(stagingRoot(root), `mousse-${randomUUID()}`)
    let versionPath: string | undefined
    try {
      await mkdir(staging, { recursive: true })
      options.onProgress?.({ phase: 'resolving', receivedBytes: 0 })
      const descriptor = await this.resolveDownload(options)
      const expectedSha256 = options.expectedSha256?.toLowerCase()
      const version = descriptor.version
      assertSafeVersion(version)
      const existing = await readMetadata(root, this.platformInfo.platform, version)
      if (existing && await isValidExecutable(join(versionDir(root, this.platformInfo.platform, version), existing.executableRelativePath), root)) {
        const active = await readActive(root)
        if (active?.version !== version) await activate(root, { version, platform: this.platformInfo.platform, previousVersion: active?.version })
        return { metadata: existing, executablePath: join(versionDir(root, this.platformInfo.platform, version), existing.executableRelativePath), previousVersion: active?.version }
      }
      const archive = await downloadArchive(fetcher, descriptor.url, options)
      options.onProgress?.({ phase: 'verifying', receivedBytes: archive.bytes, totalBytes: archive.bytes, fraction: 1, version })
      if (expectedSha256 && archive.sha256 !== expectedSha256) throw new Error(`Chrome archive SHA-256 mismatch: expected ${expectedSha256}, received ${archive.sha256}.`)
      const extracted = join(staging, 'extracted')
      options.onProgress?.({ phase: 'extracting', receivedBytes: archive.bytes, totalBytes: archive.bytes, fraction: 1, version })
      const extractResult = await extractChromeZip(archive.bytesData, extracted, {
        maxEntries: 100_000,
        maxExtractedBytes: options.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES
      })
      const executable = join(extracted, this.platformInfo.executableRelativePath)
      if (!await isValidExecutable(executable, extracted)) throw new Error(`Chrome archive is missing executable ${this.platformInfo.executableRelativePath}.`)
      const metadata: ManagedBrowserMetadata = {
        ...descriptor,
        expectedSha256,
        installedAt: new Date().toISOString(),
        sha256: archive.sha256,
        hashVerified: Boolean(expectedSha256),
        executableRelativePath: this.platformInfo.executableRelativePath,
        archiveBytes: archive.bytes,
        extractedBytes: extractResult.extractedBytes
      }
      versionPath = versionDir(root, this.platformInfo.platform, version)
      await mkdir(versionsRoot(root), { recursive: true })
      await rm(versionPath, { recursive: true, force: true })
      await rename(extracted, versionPath)
      await writeFile(metadataPath(root, this.platformInfo.platform, version), JSON.stringify(metadata, null, 2), 'utf8')
      const active = await readActive(root)
      options.onProgress?.({ phase: 'activating', receivedBytes: archive.bytes, totalBytes: archive.bytes, fraction: 1, version })
      await activate(root, { version, platform: this.platformInfo.platform, previousVersion: active?.version })
      options.onProgress?.({ phase: 'complete', receivedBytes: archive.bytes, totalBytes: archive.bytes, fraction: 1, version })
      return { metadata, executablePath: join(versionPath, metadata.executableRelativePath), previousVersion: active?.version }
    } catch (error) {
      if (versionPath && !(await isActiveVersion(root, versionPath))) await rm(versionPath, { recursive: true, force: true }).catch(() => undefined)
      throw error
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      await release()
      this.installing.delete(root)
    }
  }

  async availability(root: string, activeSessions = 0): Promise<ManagedBrowserAvailability> {
    const platform = this.platform()
    if (!platform.supported) return { status: 'unsupported', message: platform.reason!, platform, activeSessions, canInstall: false }
    if (this.installing.has(resolve(root))) return { status: 'installing', message: 'Managed browser installation is in progress.', platform, activeSessions, canInstall: false }
    const active = await readActive(root)
    if (!active) return { status: 'setup-required', message: 'No managed Chrome version is active.', platform, activeSessions, canInstall: true }
    if (active.platform !== platform.platform) return { status: 'blocked', message: `Active browser platform ${active.platform} does not match ${platform.platform}.`, platform, activeSessions, canInstall: false }
    if (!isSafeVersion(active.version)) return { status: 'blocked', message: 'Active browser pointer contains an invalid version.', platform, activeSessions, canInstall: false }
    const metadata = await readMetadata(root, active.platform, active.version)
    const executablePath = metadata ? join(versionDir(root, active.platform, active.version), metadata.executableRelativePath) : undefined
    if (!metadata || !executablePath || !await isValidExecutable(executablePath, root)) {
      return { status: 'setup-required', message: 'Managed browser metadata or executable is missing.', platform, version: active.version, activeSessions, canInstall: true }
    }
    return { status: 'ready', message: `Managed Chrome for Testing ${metadata.version} (${metadata.platform}).`, platform, version: metadata.version, executablePath, metadata, activeSessions, canInstall: true }
  }

  async resolveExecutable(root: string): Promise<string | undefined> {
    const report = await this.availability(root)
    return report.status === 'ready' ? report.executablePath : undefined
  }

  async rollback(root: string, version?: string): Promise<ManagedBrowserAvailability> {
    const active = await readActive(root)
    const target = version ?? active?.previousVersion
    if (!target) throw new Error('No previous managed browser version is available for rollback.')
    assertSafeVersion(target)
    const metadata = await readMetadata(root, this.platformInfo.platform, target)
    if (!metadata || !await isValidExecutable(join(versionDir(root, this.platformInfo.platform, target), metadata.executableRelativePath), root)) throw new Error(`Managed browser version ${target} is unavailable for rollback.`)
    await activate(root, { version: target, platform: this.platformInfo.platform, previousVersion: active?.version })
    return this.availability(root)
  }

  async cleanup(root: string, options: { activeSessions?: number; keepVersions?: number } = {}): Promise<string[]> {
    if ((options.activeSessions ?? 0) > 0) return []
    const removed: string[] = []
    const stagingEntries = await readdir(stagingRoot(root), { withFileTypes: true }).catch(() => [])
    for (const entry of stagingEntries) {
      if (!entry.name.startsWith('mousse-')) continue
      const path = join(stagingRoot(root), entry.name)
      if (!isInside(stagingRoot(root), path)) continue
      await rm(path, { recursive: true, force: true })
      removed.push(path)
    }
    const active = await readActive(root)
    const entries = await readdir(versionsRoot(root), { withFileTypes: true }).catch(() => [])
    const candidates: Array<{ name: string; installedAt: string }> = []
    for (const entry of entries) {
      const activeDirectory = active ? `${active.platform}-${active.version}` : undefined
      if (!entry.isDirectory() || entry.name === activeDirectory) continue
      const metadata = await readMetadataByDirectory(join(versionsRoot(root), entry.name))
      if (!metadata || !entry.name.startsWith(`${this.platformInfo.platform}-`)) continue
      candidates.push({ name: entry.name, installedAt: metadata.installedAt })
    }
    candidates.sort((a, b) => b.installedAt.localeCompare(a.installedAt))
    const keep = options.keepVersions ?? 1
    for (const candidate of candidates.slice(keep)) {
      const path = join(versionsRoot(root), candidate.name)
      if (!isInside(versionsRoot(root), path)) continue
      await rm(path, { recursive: true, force: true })
      removed.push(path)
    }
    return removed
  }
}

interface DownloadedArchive { bytesData: Uint8Array; bytes: number; sha256: string }

async function downloadArchive(fetcher: typeof fetch, url: string, options: ManagedBrowserInstallOptions): Promise<DownloadedArchive> {
  assertAllowedOrigin(url, options.allowedOrigins ?? [CHROME_FOR_TESTING_DOWNLOAD_ORIGIN])
  assertNotAborted(options.signal)
  const response = await fetcher(url, { signal: options.signal })
  if (!response.ok || !response.body) throw new Error(`Chrome download failed with HTTP ${response.status} from ${url}.`)
  const declared = Number(response.headers.get('content-length') ?? 0) || undefined
  const max = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
  if (declared && declared > max) throw new Error(`Chrome download exceeds the configured size limit (${declared} > ${max}).`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const hash = createHash('sha256')
  let bytes = 0
  try {
    for (;;) {
      assertNotAborted(options.signal)
      const part = await reader.read()
      if (part.done) break
      const value = part.value
      bytes += value.byteLength
      if (bytes > max) throw new Error(`Chrome download exceeds the configured size limit (${bytes} > ${max}).`)
      hash.update(value)
      chunks.push(value)
      options.onProgress?.({ phase: 'downloading', receivedBytes: bytes, totalBytes: declared, fraction: declared ? bytes / declared : undefined })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const sha256 = hash.digest('hex')
  return { bytesData: concat(chunks, bytes), bytes, sha256 }
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

async function fetchJson(fetcher: typeof fetch, url: string, allowedOrigins: readonly string[], signal?: AbortSignal): Promise<any> {
  assertAllowedOrigin(url, allowedOrigins.length ? [...allowedOrigins, OFFICIAL_CATALOG_ORIGIN] : [OFFICIAL_CATALOG_ORIGIN])
  const response = await fetcher(url, { signal })
  if (!response.ok) throw new Error(`Chrome for Testing catalog HTTP ${response.status}.`)
  return response.json()
}

function findChannel(catalog: any, channel: ManagedBrowserChannel, platform: string): { version: string; revision?: string; url?: string } | undefined {
  const record = catalog?.channels?.[channel]
  const download = record?.downloads?.chrome?.find((entry: any) => entry.platform === platform)
  return record?.version && download?.url ? { version: record.version, revision: record.revision, url: download.url } : undefined
}
function findKnownVersion(catalog: any, version: string, platform: string): { version: string; revision?: string; url?: string } | undefined {
  const record = catalog?.versions?.find((entry: any) => entry.version === version)
  const download = record?.downloads?.chrome?.find((entry: any) => entry.platform === platform)
  return record && download?.url ? { version, revision: record.revision, url: download.url } : undefined
}
function assertAllowedOrigin(url: string, allowedOrigins: readonly string[]): void {
  const origin = new URL(url).origin
  if (!allowedOrigins.includes(origin) && origin !== CHROME_FOR_TESTING_DOWNLOAD_ORIGIN) throw new Error(`Browser download origin is not trusted: ${origin}`)
}

async function acquireInstallLock(root: string, waitMs: number): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true })
  const lock = lockDir(root)
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      await mkdir(lock)
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8')
      return async () => { await rm(lock, { recursive: true, force: true }) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw new Error(`Managed browser installation is busy for ${root}.`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
  }
}

async function readActive(root: string): Promise<ActivePointer | undefined> {
  try { return JSON.parse(await readFile(activePointer(root), 'utf8')) as ActivePointer } catch { return undefined }
}
async function readMetadata(root: string, platform: string, version: string): Promise<ManagedBrowserMetadata | undefined> { return readMetadataByDirectory(versionDir(root, platform, version)) }
async function readMetadataByDirectory(dir: string): Promise<ManagedBrowserMetadata | undefined> {
  try { return JSON.parse(await readFile(join(dir, 'mousse-browser.json'), 'utf8')) as ManagedBrowserMetadata } catch { return undefined }
}
async function activate(root: string, pointer: Omit<ActivePointer, 'activatedAt'> & { activatedAt?: string }): Promise<void> {
  await mkdir(root, { recursive: true })
  const temp = join(root, `.active-${randomUUID()}.tmp`)
  await writeFile(temp, JSON.stringify({ ...pointer, activatedAt: pointer.activatedAt ?? new Date().toISOString() }, null, 2), 'utf8')
  await rename(temp, activePointer(root))
}
async function isActiveVersion(root: string, path: string): Promise<boolean> {
  const active = await readActive(root)
  return Boolean(active && isInside(versionsRoot(root), path) && basename(path) === `${active.platform}-${active.version}`)
}
async function isValidExecutable(path: string, root: string): Promise<boolean> {
  if (!isInside(root, path)) return false
  try {
    const details = await lstat(path)
    if (!details.isFile() || details.size === 0) return false
    await access(path, constants.R_OK)
    return true
  } catch { return false }
}

export function createManagedBrowserInstaller(platformInfo?: ManagedBrowserPlatformInfo): ManagedBrowserInstaller {
  return new ManagedBrowserInstallerService(platformInfo)
}

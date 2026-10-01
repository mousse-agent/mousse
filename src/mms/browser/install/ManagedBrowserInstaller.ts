import { ensureWindowsBrowserSandboxAccess } from '../../../shared/browser/windowsSandboxPermissions.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, readdir, writeFile, rename, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  ManagedBrowserAvailability,
  ManagedBrowserChannel,
  ManagedBrowserDownload,
  ManagedBrowserExecutableProbe,
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
import { assertOwnedPath, assertSafeTree, contained, ensureOwnedDirectory, removeOwnedTree } from './fsSafety'
import { probeManagedBrowserExecutable } from './probe'

const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
const MAX_CATALOG_BYTES = 16 * 1024 * 1024
const DEFAULT_LOCK_WAIT_MS = 30_000
const OFFICIAL_CATALOG_ORIGIN = 'https://googlechromelabs.github.io'

interface ActivePointer { version: string; platform: string; previousVersion?: string; activatedAt: string }

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Browser installation was cancelled.', 'AbortError')
}
function isSafeVersion(version: string): boolean { return /^\d+(?:\.\d+){3}$/.test(version) }
function assertSafeVersion(version: string): void {
  if (!isSafeVersion(version)) throw new Error(`Invalid Chrome for Testing version: ${version}`)
}

export class ManagedBrowserInstallerService implements ManagedBrowserInstaller {
  private readonly installing = new Set<string>()

  constructor(private readonly platformInfo: ManagedBrowserPlatformInfo = detectManagedBrowserPlatform(), private readonly probe: ManagedBrowserExecutableProbe = probeManagedBrowserExecutable) {}

  platform(): ManagedBrowserPlatformInfo { return { ...this.platformInfo } }

  async resolveDownload(options: Pick<ManagedBrowserInstallOptions, 'channel' | 'version' | 'fetch' | 'allowedOrigins' | 'signal'> = {}): Promise<ManagedBrowserDownload> {
    if (!this.platformInfo.supported) throw new Error(this.platformInfo.reason)
    const fetcher = options.fetch ?? globalThis.fetch
    const channel = options.channel ?? 'Stable'
    const allowedOrigins = options.allowedOrigins ?? [CHROME_FOR_TESTING_DOWNLOAD_ORIGIN]
    const catalogUrl = options.version ? CHROME_FOR_TESTING_KNOWN_GOOD : CHROME_FOR_TESTING_LAST_KNOWN_GOOD
    assertNotAborted(options.signal)
    const catalog = await fetchJson(fetcher, catalogUrl, allowedOrigins, options.signal)
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
    const release = await acquireInstallLock(root, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS, options.signal)
    this.installing.add(root)
    const staging = join(stagingRoot(root), `mousse-${randomUUID()}`)
    let versionPath: string | undefined
    let backupPath: string | undefined
    try {
      await ensureOwnedDirectory(staging, root)
      options.onProgress?.({ phase: 'resolving', receivedBytes: 0 })
      const descriptor = await this.resolveDownload(options)
      const expectedSha256 = options.expectedSha256?.toLowerCase()
      const version = descriptor.version
      assertSafeVersion(version)
      const existing = await readMetadata(root, this.platformInfo.platform, version)
      const active = await readActive(root)
      if (existing && metadataMatches(existing, descriptor, expectedSha256, this.platformInfo.executableRelativePath) && await isValidExecutable(join(versionDir(root, this.platformInfo.platform, version), existing.executableRelativePath), root)) {
        if (this.platformInfo.platform === 'win32' || this.platformInfo.platform === 'win64') ensureWindowsBrowserSandboxAccess(root, dirname(join(versionDir(root, this.platformInfo.platform, version), existing.executableRelativePath)))
        assertProbeVersion(await this.probe(join(versionDir(root, this.platformInfo.platform, version), existing.executableRelativePath), options.signal, version), version)
        if (active?.version !== version) await activate(root, { version, platform: this.platformInfo.platform, previousVersion: active?.version })
        return { metadata: existing, executablePath: join(versionDir(root, this.platformInfo.platform, version), existing.executableRelativePath), previousVersion: active?.version }
      }
      if (active?.version === version && (options.activeSessions?.() ?? 0) > 0) throw new Error('Cannot replace the active managed browser while sessions are using it.')
      const archive = await downloadArchive(fetcher, descriptor.url, join(staging, 'chrome.zip'), options)
      options.onProgress?.({ phase: 'verifying', receivedBytes: archive.bytes, totalBytes: archive.bytes, fraction: 1, version })
      if (expectedSha256 && archive.sha256 !== expectedSha256) throw new Error(`Chrome archive SHA-256 mismatch: expected ${expectedSha256}, received ${archive.sha256}.`)
      const extracted = join(staging, 'extracted')
      options.onProgress?.({ phase: 'extracting', receivedBytes: archive.bytes, totalBytes: archive.bytes, fraction: 1, version })
      const extractResult = await extractChromeZip(archive.bytesData, extracted, {
        maxEntries: 100_000,
        maxExtractedBytes: options.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES,
        signal: options.signal
      })
      const executable = join(extracted, this.platformInfo.executableRelativePath)
      if (!await isValidExecutable(executable, extracted)) throw new Error(`Chrome archive is missing executable ${this.platformInfo.executableRelativePath}.`)
      if (this.platformInfo.platform === 'win32' || this.platformInfo.platform === 'win64') ensureWindowsBrowserSandboxAccess(root, dirname(executable))
      assertProbeVersion(await this.probe(executable, options.signal, version), version)
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
      await ensureOwnedDirectory(versionsRoot(root), root)
      if (active?.version === version && await pathExists(versionPath)) {
        backupPath = join(staging, 'previous-active')
        await assertSafeTree(versionPath, root)
        await assertOwnedPath(backupPath, root)
        await rename(versionPath, backupPath)
      } else {
        await removeOwnedTree(versionPath, root)
      }
      await assertSafeTree(extracted, root)
      await assertOwnedPath(versionPath, root)
      await rename(extracted, versionPath)
      await assertOwnedPath(metadataPath(root, this.platformInfo.platform, version), root)
      await writeFile(metadataPath(root, this.platformInfo.platform, version), JSON.stringify(metadata, null, 2), { encoding: 'utf8', flag: 'wx' })
      options.onProgress?.({ phase: 'activating', receivedBytes: archive.bytes, totalBytes: archive.bytes, fraction: 1, version })
      await activate(root, { version, platform: this.platformInfo.platform, previousVersion: active?.version })
      options.onProgress?.({ phase: 'complete', receivedBytes: archive.bytes, totalBytes: archive.bytes, fraction: 1, version })
      return { metadata, executablePath: join(versionPath, metadata.executableRelativePath), previousVersion: active?.version }
    } catch (error) {
      let restoreError: unknown
      if (backupPath && versionPath) {
        try {
          await removeOwnedTree(versionPath, root)
          await assertSafeTree(backupPath, root)
          await rename(backupPath, versionPath)
          backupPath = undefined
        } catch (caught) { restoreError = caught }
      } else if (versionPath && !(await isActiveVersion(root, versionPath))) {
        await removeOwnedTree(versionPath, root).catch(() => undefined)
      }
      if (restoreError) throw new AggregateError([error, restoreError], 'Managed browser replacement failed and the active version could not be restored.')
      throw error
    } finally {
      await removeOwnedTree(staging, root).catch(() => undefined)
      await release()
      this.installing.delete(root)
    }
  }

  async availability(root: string, activeSessions = 0): Promise<ManagedBrowserAvailability> {
    const platform = this.platform()
    if (!platform.supported) return { status: 'unsupported', message: platform.reason!, platform, activeSessions, canInstall: false }
    if (this.installing.has(resolve(root))) return { status: 'installing', message: 'Managed browser installation is in progress.', platform, activeSessions, canInstall: false }
    try {
      const rootDetails = await lstat(resolve(root))
      if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) return { status: 'blocked', message: 'Managed browser root is not a real directory.', platform, activeSessions, canInstall: false }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'setup-required', message: 'No managed Chrome version is active.', platform, activeSessions, canInstall: true }
      return { status: 'blocked', message: 'Managed browser root cannot be inspected safely.', platform, activeSessions, canInstall: false }
    }
    const active = await readActive(root)
    if (!active) return { status: 'setup-required', message: 'No managed Chrome version is active.', platform, activeSessions, canInstall: true }
    if (active.platform !== platform.platform) return { status: 'blocked', message: `Active browser platform ${active.platform} does not match ${platform.platform}.`, platform, activeSessions, canInstall: false }
    if (!isSafeVersion(active.version)) return { status: 'blocked', message: 'Active browser pointer contains an invalid version.', platform, activeSessions, canInstall: false }
    const metadata = await readMetadata(root, active.platform, active.version)
    const executablePath = metadata ? join(versionDir(root, active.platform, active.version), metadata.executableRelativePath) : undefined
    const identity = metadata ? { version: active.version, platform: platform.platform, channel: metadata.channel, url: metadata.url } : undefined
    if (!metadata || !identity || !metadataMatches(metadata, identity, undefined, platform.executableRelativePath) || !executablePath || !await isValidExecutable(executablePath, root)) {
      return { status: 'setup-required', message: 'Managed browser metadata or executable is missing.', platform, version: active.version, activeSessions, canInstall: true }
    }
    return { status: 'ready', message: `Managed Chrome for Testing ${metadata.version} (${metadata.platform}).`, platform, version: metadata.version, executablePath, metadata, activeSessions, canInstall: true }
  }

  async resolveExecutable(root: string): Promise<string | undefined> {
    const report = await this.availability(root)
    if (report.status !== 'ready' || !report.executablePath) return undefined
    if (this.platformInfo.platform === 'win32' || this.platformInfo.platform === 'win64') ensureWindowsBrowserSandboxAccess(root, dirname(report.executablePath))
    return report.executablePath
  }

  async rollback(root: string, version?: string, options: { activeSessions?: number; lockWaitMs?: number } = {}): Promise<ManagedBrowserAvailability> {
    if ((options.activeSessions ?? 0) > 0) throw new Error('Cannot roll back the managed browser while sessions are active.')
    const resolvedRoot = resolve(root)
    const release = await acquireInstallLock(resolvedRoot, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS)
    this.installing.add(resolvedRoot)
    try {
      const active = await readActive(root)
      const target = version ?? active?.previousVersion
      if (!target) throw new Error('No previous managed browser version is available for rollback.')
      assertSafeVersion(target)
      const metadata = await readMetadata(root, this.platformInfo.platform, target)
      if (!metadata || !metadataMatches(metadata, { version: target, platform: this.platformInfo.platform, channel: metadata.channel, url: metadata.url }, undefined, this.platformInfo.executableRelativePath) || !await isValidExecutable(join(versionDir(root, this.platformInfo.platform, target), metadata.executableRelativePath), root)) throw new Error(`Managed browser version ${target} is unavailable for rollback.`)
      await activate(root, { version: target, platform: this.platformInfo.platform, previousVersion: active?.version })
      this.installing.delete(resolvedRoot)
      return this.availability(root)
    } finally { this.installing.delete(resolvedRoot); await release() }
  }

  async cleanup(root: string, options: { activeSessions?: number; keepVersions?: number } = {}): Promise<string[]> {
    if ((options.activeSessions ?? 0) > 0) return []
    const resolvedRoot = resolve(root)
    const release = await acquireInstallLock(resolvedRoot, DEFAULT_LOCK_WAIT_MS)
    this.installing.add(resolvedRoot)
    try {
      const removed: string[] = []
      const stagingEntries = await readdir(stagingRoot(root), { withFileTypes: true }).catch(() => [])
      for (const entry of stagingEntries) {
        if (!entry.name.startsWith('mousse-') || !entry.isDirectory()) continue
        const path = join(stagingRoot(root), entry.name)
        await removeOwnedTree(path, root)
        removed.push(path)
      }
      const active = await readActive(root)
      const entries = await readdir(versionsRoot(root), { withFileTypes: true }).catch(() => [])
      const candidates: Array<{ name: string; installedAt: string }> = []
      for (const entry of entries) {
        const activeDirectory = active ? `${active.platform}-${active.version}` : undefined
        if (!entry.isDirectory() || entry.name === activeDirectory || !entry.name.startsWith(`${this.platformInfo.platform}-`)) continue
        const version = entry.name.slice(`${this.platformInfo.platform}-`.length)
        if (!isSafeVersion(version)) continue
        const metadata = await readMetadata(root, this.platformInfo.platform, version)
        if (!metadata) continue
        candidates.push({ name: entry.name, installedAt: metadata.installedAt })
      }
      candidates.sort((a, b) => b.installedAt.localeCompare(a.installedAt))
      for (const candidate of candidates.slice(options.keepVersions ?? 1)) {
        const path = join(versionsRoot(root), candidate.name)
        await removeOwnedTree(path, root)
        removed.push(path)
      }
      return removed
    } finally { this.installing.delete(resolvedRoot); await release() }
  }
}

interface DownloadedArchive { bytesData: Uint8Array; bytes: number; sha256: string }

async function downloadArchive(fetcher: typeof fetch, url: string, archivePath: string, options: ManagedBrowserInstallOptions): Promise<DownloadedArchive> {
  assertAllowedOrigin(url, options.allowedOrigins ?? [CHROME_FOR_TESTING_DOWNLOAD_ORIGIN])
  assertNotAborted(options.signal)
  const response = await fetcher(url, { signal: options.signal })
  if (!response.ok || !response.body) throw new Error(`Chrome download failed with HTTP ${response.status} from ${url}.`)
  const declared = Number(response.headers.get('content-length') ?? 0) || undefined
  const max = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
  if (declared && declared > max) throw new Error(`Chrome download exceeds the configured size limit (${declared} > ${max}).`)
  const reader = response.body.getReader()
  const hash = createHash('sha256')
  const output = await open(archivePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
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
      let offset = 0
      while (offset < value.byteLength) {
        const result = await output.write(value, offset, value.byteLength - offset)
        if (result.bytesWritten === 0) throw new Error('Chrome download could not make progress while writing the archive.')
        offset += result.bytesWritten
      }
      options.onProgress?.({ phase: 'downloading', receivedBytes: bytes, totalBytes: declared, fraction: declared ? bytes / declared : undefined })
    }
    await output.sync()
  } finally {
    await reader.cancel().catch(() => undefined)
    await output.close()
  }
  const streamSha256 = hash.digest('hex')
  const bytesData = await readFile(archivePath)
  const sha256 = createHash('sha256').update(bytesData).digest('hex')
  if (bytesData.byteLength !== bytes || sha256 !== streamSha256) throw new Error('Downloaded Chrome archive changed before extraction.')
  return { bytesData, bytes, sha256 }
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
  if (!response.ok || !response.body) throw new Error(`Chrome for Testing catalog HTTP ${response.status}.`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_CATALOG_BYTES) throw new Error('Chrome for Testing catalog exceeds the configured size limit.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      assertNotAborted(signal)
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_CATALOG_BYTES) throw new Error('Chrome for Testing catalog exceeds the configured size limit.')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concat(chunks, bytes)))
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
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

async function acquireInstallLock(root: string, waitMs: number, signal?: AbortSignal): Promise<() => Promise<void>> {
  await ensureOwnedDirectory(root, root)
  assertNotAborted(signal)
  const lock = lockDir(root)
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      await mkdir(lock)
      await assertOwnedPath(lock, root)
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' })
      return async () => { await removeOwnedTree(lock, root).catch(() => undefined) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await assertOwnedPath(lock, root)
      const owner = await readLockOwner(lock)
      if (owner && owner.pid !== process.pid && !isProcessAlive(owner.pid)) {
        await removeOwnedTree(lock, root)
        continue
      }
      if (!owner) {
        const lockStat = await lstat(lock).catch(() => undefined)
        if (lockStat && Date.now() - lockStat.mtimeMs > 5_000) { await removeOwnedTree(lock, root); continue }
      }
      if (Date.now() >= deadline) throw new Error(`Managed browser installation is busy for ${root}.`)
      await waitForLock(signal)
    }
  }
}

async function waitForLock(signal?: AbortSignal): Promise<void> {
  if (!signal) { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); return }
  await new Promise<void>((resolveWait, reject) => {
    if (signal.aborted) { reject(new DOMException('Browser installation was cancelled.', 'AbortError')); return }
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new DOMException('Browser installation was cancelled.', 'AbortError')) }
    const done = () => { signal.removeEventListener('abort', onAbort); resolveWait() }
    timer = setTimeout(done, 50)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function readLockOwner(lock: string): Promise<{ pid: number; acquiredAt: string } | undefined> {
  try {
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as { pid?: number; acquiredAt?: string }
    return typeof owner.pid === 'number' && typeof owner.acquiredAt === 'string' ? { pid: owner.pid, acquiredAt: owner.acquiredAt } : undefined
  } catch { return undefined }
}
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

async function readActive(root: string): Promise<ActivePointer | undefined> {
  try { await assertOwnedPath(activePointer(root), root); return JSON.parse(await readFile(activePointer(root), 'utf8')) as ActivePointer } catch { return undefined }
}
async function readMetadata(root: string, platform: string, version: string): Promise<ManagedBrowserMetadata | undefined> {
  if (!isSafeVersion(version)) return undefined
  const dir = versionDir(root, platform, version)
  try {
    await assertOwnedPath(dir, root)
    const metadata = join(dir, 'mousse-browser.json')
    await assertOwnedPath(metadata, root)
    const parsed = JSON.parse(await readFile(metadata, 'utf8')) as ManagedBrowserMetadata
    return parsed
  } catch { return undefined }
}
async function activate(root: string, pointer: Omit<ActivePointer, 'activatedAt'> & { activatedAt?: string }): Promise<void> {
  await ensureOwnedDirectory(root, root)
  const temp = join(root, `.active-${randomUUID()}.tmp`)
  await assertOwnedPath(temp, root)
  await writeFile(temp, JSON.stringify({ ...pointer, activatedAt: pointer.activatedAt ?? new Date().toISOString() }, null, 2), { encoding: 'utf8', flag: 'wx' })
  await assertOwnedPath(activePointer(root), root)
  await rename(temp, activePointer(root))
}
async function isActiveVersion(root: string, path: string): Promise<boolean> {
  const active = await readActive(root)
  return Boolean(active && contained(versionsRoot(root), path) && basename(path) === `${active.platform}-${active.version}`)
}
async function isValidExecutable(path: string, root: string): Promise<boolean> {
  if (!contained(root, path)) return false
  try {
    await assertOwnedPath(path, root)
    const details = await lstat(path)
    if (!details.isFile() || details.size === 0) return false
    await access(path, constants.R_OK)
    return true
  } catch { return false }
}

function metadataMatches(metadata: ManagedBrowserMetadata, descriptor: Pick<ManagedBrowserDownload, 'version' | 'platform' | 'channel' | 'url'>, expectedSha256: string | undefined, executableRelativePath: string): boolean {
  if (metadata.version !== descriptor.version || metadata.platform !== descriptor.platform || metadata.channel !== descriptor.channel || metadata.url !== descriptor.url || metadata.executableRelativePath !== executableRelativePath) return false
  if (!/^[a-f0-9]{64}$/i.test(metadata.sha256)) return false
  if (!metadata.hashVerified && metadata.expectedSha256) return false
  if (metadata.hashVerified && metadata.expectedSha256 !== metadata.sha256) return false
  return !expectedSha256 || (metadata.hashVerified && metadata.sha256 === expectedSha256 && metadata.expectedSha256 === expectedSha256)
}

function assertProbeVersion(result: { version: string }, expected: string): void {
  const actual = result.version.match(/\d+(?:\.\d+){3}/)?.[0]
  if (actual !== expected) throw new Error(`Managed browser executable reported ${result.version || 'no version'}; expected ${expected}.`)
}

export function createManagedBrowserInstaller(platformInfo?: ManagedBrowserPlatformInfo, probe?: ManagedBrowserExecutableProbe): ManagedBrowserInstaller {
  return new ManagedBrowserInstallerService(platformInfo, probe)
}

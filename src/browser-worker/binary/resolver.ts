import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { CERTIFIED_CHROME_CHANNEL, CERTIFIED_CHROME_VERSION, chromeExecutableRelPath, chromeForTestingPlatform } from './platform'
import type { ActiveManagedBrowserMetadata, BrowserBinaryResolution, CertifiedBrowserMetadata } from './types'

const METADATA_MAX_BYTES = 64 * 1024
const SAFE_VERSION = /^\d+(?:\.\d+){3}$/

function readBoundedJson(path: string): unknown {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > METADATA_MAX_BYTES) throw new Error('Browser metadata is not a bounded regular file')
  const fd = openSync(path, 'r')
  try {
    const current = fstatSync(fd)
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.size > METADATA_MAX_BYTES) {
      throw new Error('Browser metadata changed while opening')
    }
    const bytes = Buffer.alloc(current.size + 1)
    const count = readSync(fd, bytes, 0, bytes.length, 0)
    if (count !== current.size) throw new Error('Browser metadata changed while reading')
    return JSON.parse(bytes.subarray(0, count).toString('utf8'))
  } finally {
    closeSync(fd)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function safeExecutable(root: string, executablePath: string): boolean {
  const base = resolve(root)
  const target = resolve(executablePath)
  const rel = relative(base, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  try {
    const rootStat = lstatSync(base)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false
    let current = base
    for (const part of rel.split(/[\\/]/).filter(Boolean)) {
      current = join(current, part)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) return false
    }
    const file = lstatSync(target)
    if (!file.isFile() || file.size <= 0) return false
    const canonicalRoot = realpathSync.native(base)
    const canonicalTarget = realpathSync.native(target)
    const canonicalRel = relative(canonicalRoot, canonicalTarget)
    return canonicalRel !== '' && !canonicalRel.startsWith('..') && !isAbsolute(canonicalRel)
  } catch {
    return false
  }
}

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
    const parsed = readBoundedJson(path) as CertifiedBrowserMetadata
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
  const active = resolveActiveManagedBrowser(browserRoot, platform)
  if (active) return active
  const metadata = readCertifiedMetadata(browserRoot)
  if (!metadata) {
    return {
      status: 'setup_required',
      message: `Managed Chrome for Testing ${CERTIFIED_CHROME_CHANNEL} ${CERTIFIED_CHROME_VERSION} (${platform}) is not installed under the injected browser root.`
    }
  }
  const executablePath = join(certifiedInstallDir(browserRoot), metadata.executable)
  if (metadata.executable !== chromeExecutableRelPath(platform) || !safeExecutable(browserRoot, executablePath)) {
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

function resolveActiveManagedBrowser(
  browserRoot: string,
  platform: ReturnType<typeof chromeForTestingPlatform>
): BrowserBinaryResolution | null {
  const pointerPath = join(browserRoot, 'active.json')
  if (!pathEntryExists(pointerPath)) return null
  try {
    const pointer = readBoundedJson(pointerPath)
    if (!isRecord(pointer) || typeof pointer.version !== 'string' || !SAFE_VERSION.test(pointer.version) || pointer.platform !== platform ||
      (pointer.previousVersion !== undefined && (typeof pointer.previousVersion !== 'string' || !SAFE_VERSION.test(pointer.previousVersion))) ||
      typeof pointer.activatedAt !== 'string' || !Number.isFinite(Date.parse(pointer.activatedAt))) {
      throw new Error('Active browser pointer has invalid identity fields')
    }
    const versionRoot = join(browserRoot, 'versions', `${platform}-${pointer.version}`)
    const metadataPath = join(versionRoot, 'mousse-browser.json')
    const metadata = readBoundedJson(metadataPath)
    const expectedExecutable = chromeExecutableRelPath(platform)
    if (!isRecord(metadata) || metadata.version !== pointer.version || metadata.platform !== platform ||
      (metadata.source !== 'chrome-for-testing-catalog' && metadata.source !== 'injected-fixture') ||
      !['Stable', 'Beta', 'Dev', 'Canary'].includes(String(metadata.channel)) ||
      typeof metadata.url !== 'string' || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(metadata.sha256) ||
      typeof metadata.hashVerified !== 'boolean' || metadata.executableRelativePath !== expectedExecutable ||
      (metadata.revision !== undefined && typeof metadata.revision !== 'string') ||
      (metadata.expectedSha256 !== undefined && (typeof metadata.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(metadata.expectedSha256))) ||
      typeof metadata.installedAt !== 'string' || !Number.isFinite(Date.parse(metadata.installedAt)) ||
      !Number.isSafeInteger(metadata.archiveBytes) || Number(metadata.archiveBytes) < 0 ||
      !Number.isSafeInteger(metadata.extractedBytes) || Number(metadata.extractedBytes) < 0) {
      throw new Error('Active browser metadata does not match its platform and version')
    }
    if ((metadata.hashVerified && metadata.expectedSha256 !== metadata.sha256) || (!metadata.hashVerified && metadata.expectedSha256 !== undefined)) {
      throw new Error('Active browser verified digest does not match its expected digest')
    }
    const executablePath = join(versionRoot, expectedExecutable)
    if (!safeExecutable(browserRoot, executablePath)) throw new Error('Active browser executable is missing or leaves its owned root')
    return {
      status: 'ready',
      metadata: metadata as unknown as ActiveManagedBrowserMetadata,
      executablePath,
      message: `Managed Chrome for Testing ${pointer.version} (${platform})`
    }
  } catch (error) {
    return {
      status: 'setup_required',
      message: `Active managed browser installation is invalid: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export function expectedExecutableRelPath(): string {
  return chromeExecutableRelPath(chromeForTestingPlatform())
}

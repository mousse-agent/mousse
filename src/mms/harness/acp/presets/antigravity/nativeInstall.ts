import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../../../../data/AtomicFs'
import { compareVersions } from '../../../driver'
import { extractArchive } from '../../../agents/archive'
import { killProcessTree } from '../../../../execution/processTree'
import { scrubbedAntigravityEnv } from '../antigravity'
import {
  NATIVE_AGENT_NAME, NATIVE_MAX_DOWNLOAD_BYTES, NATIVE_MAX_EXECUTABLE_BYTES, WITHDRAWN_NATIVE_VERSIONS, isNativeAssetUrl,
  nativeExecutableName, nativeReleaseRefusal, type NativeRelease, type NativeTarget
} from './nativeRelease'

/**
 * Installs of Google's native Antigravity CLI live in `<installationHome>/providers/antigravity/native`:
 * one folder per verified release under `versions/`, and `active.json`, which names the release that
 * runs and the one that ran before it (the last good one, kept on disk for a running turn and for a
 * fall back). The 1.1.1 ACP server's own folder beside it is never touched.
 */
export const nativeRoot = (installationHome: string): string => join(installationHome, 'providers', 'antigravity', 'native')
const versionsDir = (installationHome: string) => join(nativeRoot(installationHome), 'versions')
const activePath = (installationHome: string) => join(nativeRoot(installationHome), 'active.json')

/** What `verified.json` in a release folder records: written only after every check passed. */
interface VerifiedRecord { version: string; sha512: string; target: NativeTarget; executable: string; executableSize: number }
interface ActiveRef { id: string; version: string }
interface ActiveFile extends ActiveRef { target: NativeTarget; previous?: ActiveRef }

export interface NativeRuntime { binary: string; version: string; id: string }

/** How long the `initialize` check may take: the CLI unpacks its bundled files on a first start. */
const VERIFY_TIMEOUT_MS = 90_000
/** How long the check waits for the ended agent to exit before giving up on it. */
const EXIT_WAIT_MS = 10_000
/** Free space kept beyond the download and the executable while installing. */
const SPACE_MARGIN_BYTES = 256 * 1024 * 1024
/** Space an install takes at most while it runs: the download, and for an archive the executable too. */
const INSTALL_SPACE_BYTES: Record<NativeRelease['format'], number> = { exe: 320 * 1024 * 1024, 'tar.gz': 448 * 1024 * 1024 }

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return undefined }
}

/** The release in `versions/<id>` when its record matches and its executable has the recorded size. */
function verifiedRelease(installationHome: string, ref: ActiveRef | undefined, target: NativeTarget, withdrawn: readonly string[]): NativeRuntime | undefined {
  if (!ref || !/^[0-9a-f]{32}$/.test(ref.id) || withdrawn.includes(ref.version)) return undefined
  const dir = join(versionsDir(installationHome), ref.id)
  const record = readJson<VerifiedRecord>(join(dir, 'verified.json'))
  if (!record || record.version !== ref.version || record.target !== target || record.sha512.slice(0, 32) !== ref.id) return undefined
  if (record.executable !== nativeExecutableName(target)) return undefined
  const binary = join(dir, record.executable)
  try {
    const info = statSync(binary)
    if (!info.isFile() || info.size !== record.executableSize) return undefined
  } catch { return undefined }
  return { binary, version: record.version, id: ref.id }
}

/**
 * The native release that runs: the active one, else the last good one when the active one is
 * missing, damaged or withdrawn. Undefined when neither is usable.
 */
export function activeNativeRuntime(installationHome: string, target: NativeTarget | undefined, withdrawn: readonly string[] = WITHDRAWN_NATIVE_VERSIONS): NativeRuntime | undefined {
  if (!target) return undefined
  const active = readJson<ActiveFile>(activePath(installationHome))
  if (!active || active.target !== target) return undefined
  return verifiedRelease(installationHome, active, target, withdrawn) ?? verifiedRelease(installationHome, active.previous, target, withdrawn)
}

/** Starts `binary acp` on a private profile, answers `initialize` once, and returns its `agentInfo`. */
export type NativeVerifier = (binary: string, scratch: string, signal: AbortSignal) => Promise<{ name?: string; version?: string }>

/**
 * The real check: `agy acp` with a private `--gemini-dir` in the staging folder, `initialize` only,
 * then the whole process tree is ended. Nothing signs in and no session opens.
 */
export const verifyNativeHandshake: NativeVerifier = (binary, scratch, signal) => new Promise((resolve, reject) => {
  const profile = join(scratch, 'profile')
  const temp = join(scratch, 'tmp')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  mkdirSync(temp, { recursive: true, mode: 0o700 })
  const env = scrubbedAntigravityEnv(process.env)
  if (process.platform === 'win32') { env.TEMP = temp; env.TMP = temp } else env.TMPDIR = temp
  const child = spawn(binary, ['acp', '--gemini-dir', profile, '--app-data-dir', 'antigravity-acp'], { cwd: scratch, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' })
  let settled = false
  let buffered = ''
  const exited = new Promise<void>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) resolveExit()
    else {
      child.once('exit', () => resolveExit())
      // A process that never started has nothing to wait for.
      child.once('error', () => resolveExit())
    }
  })
  const finish = (error: Error | undefined, info?: { name?: string; version?: string }) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    if (child.pid) killProcessTree(child.pid)
    // Windows locks a running executable: the release can be moved into place only once it exited.
    const gone = AbortSignal.timeout(EXIT_WAIT_MS)
    void Promise.race([exited, new Promise<void>((resolveWait) => gone.addEventListener('abort', () => resolveWait(), { once: true }))])
      .then(() => { if (error) reject(error); else resolve(info ?? {}) })
  }
  const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('Antigravity install cancelled'))
  const timer = setTimeout(() => finish(new Error('The Antigravity CLI did not answer its start-up check in time.')), VERIFY_TIMEOUT_MS)
  signal.addEventListener('abort', onAbort, { once: true })
  child.once('error', (error) => finish(error))
  child.once('exit', () => finish(new Error('The Antigravity CLI stopped during its start-up check.')))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    if (buffered.length > 1024 * 1024) { finish(new Error('The Antigravity CLI answered its start-up check with too much output.')); return }
    let end: number
    while ((end = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      let message: { id?: unknown; result?: { agentInfo?: { name?: unknown; version?: unknown } }; error?: unknown }
      try { message = JSON.parse(line) } catch { continue }
      if (message.id !== 1) continue
      if (!message.result) { finish(new Error('The Antigravity CLI refused its start-up check.')); return }
      const agent = message.result.agentInfo
      finish(undefined, { ...(typeof agent?.name === 'string' ? { name: agent.name } : {}), ...(typeof agent?.version === 'string' ? { version: agent.version } : {}) })
      return
    }
  })
  child.stdin.on('error', () => undefined)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'Mousse', version: 'install-check' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } })}\n`)
})

export interface NativeInstallOptions {
  /** The release Google's update feed names now. */
  release: NativeRelease
  target: NativeTarget
  fetch?: typeof fetch
  verify?: NativeVerifier
  withdrawn?: readonly string[]
  /** Free bytes where the install goes; undefined when the system cannot tell. */
  freeBytes?: (dir: string) => number | undefined
  signal?: AbortSignal
  progress?: (message: string, fraction?: number, bytes?: { receivedBytes: number; totalBytes: number }) => void
}

const defaultFreeBytes = (dir: string): number | undefined => {
  try {
    const stats = statfsSync(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch { return undefined }
}

/** Installs running now, by installation: one at a time. */
const running = new Set<string>()

/**
 * Installs the feed's release and makes it the active one. Refuses a withdrawn release, an older
 * version than the one that runs, a URL off Google's exact path, a download over the size cap, and
 * one whose SHA-512 differs from the feed's. The executable must then answer `initialize` with
 * Google's name and this exact version. Only then does `active.json` move to it, in one atomic write that keeps the release before
 * it as the last good one. On any failure or cancel nothing changes and the staging folder is gone.
 */
export async function installNativeAntigravity(installationHome: string, options: NativeInstallOptions): Promise<NativeRuntime> {
  const { release, target } = options
  const withdrawn = options.withdrawn ?? WITHDRAWN_NATIVE_VERSIONS
  const refusal = nativeReleaseRefusal(release, withdrawn)
  if (refusal) throw new Error(refusal)
  if (!isNativeAssetUrl(release.url, release.version, target) || !/^[0-9a-f]{128}$/.test(release.sha512)) throw new Error('This Antigravity download is not on Google\'s release path.')
  const current = activeNativeRuntime(installationHome, target, withdrawn)
  if (current && compareVersions(current.version, release.version) > 0) throw new Error(`Antigravity ${current.version} is newer than ${release.version}; Mousse does not install an older version.`)
  const id = release.sha512.slice(0, 32)
  if (current?.id === id) return current
  const root = nativeRoot(installationHome)
  if (running.has(root)) throw new Error('Antigravity is already being installed')
  running.add(root)
  const signal = options.signal ?? new AbortController().signal
  const progress = options.progress ?? (() => undefined)
  const staging = join(root, `.stage-${randomUUID()}`)
  try {
    mkdirSync(versionsDir(installationHome), { recursive: true })
    // Staging an earlier install left when Mousse stopped mid-way: only one install runs at a time.
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('.stage-')) {
        try { rmSync(join(root, entry), { recursive: true, force: true }) } catch { /* in use: left for later */ }
      }
    }
    mkdirSync(staging)
    const free = (options.freeBytes ?? defaultFreeBytes)(root)
    const needed = INSTALL_SPACE_BYTES[release.format] + SPACE_MARGIN_BYTES
    if (free !== undefined && free < needed) throw new Error(`Antigravity needs ${Math.ceil(needed / 1_048_576)} MB free to install.`)
    signal.throwIfAborted()
    progress('Downloading Google Antigravity…')
    const download = join(staging, 'download')
    await fetchVerified(release, download, signal, progress, options.fetch ?? fetch)
    progress('Checking Antigravity…')
    const releaseDir = join(staging, 'release')
    const executable = nativeExecutableName(target)
    if (release.format === 'exe') {
      mkdirSync(releaseDir)
      renameSync(download, join(releaseDir, executable))
    } else {
      // One plain file named `antigravity`; links, other entries and an oversized file are refused.
      await extractArchive(download, releaseDir, { format: 'tar.gz', signal, maxEntries: 1, maxBytes: NATIVE_MAX_EXECUTABLE_BYTES })
      rmSync(download, { force: true })
    }
    const binary = join(releaseDir, executable)
    const entries = readdirSync(releaseDir)
    const executableSize = entries.length === 1 && entries[0] === executable && statSync(binary).isFile() ? statSync(binary).size : 0
    if (!executableSize) throw new Error('Google\'s Antigravity download does not hold the expected executable.')
    if (process.platform !== 'win32') chmodSync(binary, 0o755)
    signal.throwIfAborted()
    const agent = await (options.verify ?? verifyNativeHandshake)(binary, join(staging, 'check'), signal)
    if (agent.name !== NATIVE_AGENT_NAME || agent.version !== release.version)
      throw new Error(`The downloaded Antigravity reports ${agent.name ?? 'no name'} ${agent.version ?? 'without a version'}, not ${release.version}.`)
    // The last point to stop: past here the release is published.
    signal.throwIfAborted()
    const record: VerifiedRecord = { version: release.version, sha512: release.sha512, target, executable, executableSize }
    atomicWriteJsonSync(join(releaseDir, 'verified.json'), record)
    const destination = join(versionsDir(installationHome), id)
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true })
    renameSync(releaseDir, destination)
    const active: ActiveFile = { id, version: release.version, target, ...(current ? { previous: { id: current.id, version: current.version } } : {}) }
    atomicWriteJsonSync(activePath(installationHome), active)
    pruneNativeReleases(installationHome)
    const installed = activeNativeRuntime(installationHome, target, withdrawn)
    if (installed?.id !== id) throw new Error('The installed Antigravity could not be verified.')
    return installed
  } finally {
    rmSync(staging, { recursive: true, force: true })
    running.delete(root)
  }
}

async function fetchVerified(release: NativeRelease, path: string, signal: AbortSignal, progress: NonNullable<NativeInstallOptions['progress']>, fetchFile: typeof fetch): Promise<void> {
  const response = await fetchFile(release.url, { signal, redirect: 'error' })
  if (!response.ok || !response.body) throw new Error(`Google download failed (${response.status})`)
  const announced = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(announced) && announced > NATIVE_MAX_DOWNLOAD_BYTES) throw new Error('Google\'s Antigravity download is larger than Mousse accepts.')
  const total = Number.isFinite(announced) && announced > 0 ? announced : undefined
  const writer = createWriteStream(path, { flags: 'wx' })
  // Settles once the file is closed, so a failed download never outlives its staging folder.
  const closed = new Promise<void>((resolveClose, reject) => { writer.once('close', resolveClose); writer.once('error', reject) })
  closed.catch(() => undefined)
  const hash = createHash('sha512')
  let size = 0
  let reported = -1
  const reader = response.body.getReader()
  const mb = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      // Staging never holds more than the announced size, nor more than the cap.
      if (size > (total ?? NATIVE_MAX_DOWNLOAD_BYTES)) throw new Error('Google\'s Antigravity download is larger than Mousse accepts.')
      hash.update(value)
      const step = total ? Math.floor((size / total) * 100) : Math.floor(size / 10_485_760)
      if (step > reported) {
        reported = step
        if (total) progress(`Downloading ${mb(size)} of ${mb(total)}`, size / total, { receivedBytes: size, totalBytes: total })
        else progress(`Downloading ${mb(size)}`)
      }
      if (!writer.write(value)) await new Promise<void>((resolveDrain) => writer.once('drain', resolveDrain))
    }
  } catch (error) {
    writer.destroy()
    await closed.catch(() => undefined)
    throw error
  } finally {
    reader.cancel().catch(() => undefined)
  }
  writer.end()
  await closed
  signal.throwIfAborted()
  if ((total !== undefined && size !== total) || hash.digest('hex') !== release.sha512) throw new Error('Google\'s Antigravity download failed its SHA-512 check.')
}

/**
 * Removes release folders that are neither active nor the last good one. A folder whose executable
 * is still running (Windows locks it) stays until a later install.
 */
export function pruneNativeReleases(installationHome: string): void {
  const active = readJson<ActiveFile>(activePath(installationHome))
  const keep = new Set([active?.id, active?.previous?.id].filter(Boolean))
  const versions = versionsDir(installationHome)
  let entries: string[] = []
  try { entries = readdirSync(versions) } catch { return }
  for (const entry of entries) {
    if (keep.has(entry)) continue
    try { rmSync(join(versions, entry), { recursive: true, force: true }) } catch { /* in use: kept for now */ }
  }
}

/** Reads Google's feed entry for `target`; undefined when it cannot be read in time. */
export async function readVendorFeed(feedUrl: string, fetchFile: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  try {
    const response = await fetchFile(feedUrl, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) })
    if (!response.ok) return undefined
    const text = await response.text()
    return text.length > 64 * 1024 ? undefined : JSON.parse(text)
  } catch { return undefined }
}

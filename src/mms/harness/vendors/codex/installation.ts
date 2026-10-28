/**
 * The Codex that managed ChatGPT entries run, shared by every profile of the installation:
 *
 *   <installationHome>/managed/codex/<version>/          the unpacked package and `.install-complete.json`
 *   <installationHome>/managed/codex/active.json         the version new processes start
 *   <installationHome>/managed/codex/.install-<random>/  an install in progress
 *   <installationHome>/managed/codex/lock.db             the publish lock (SQLite, never deleted)
 *
 * It is apart from `agents/`, where registry agents live, so neither installer can touch the
 * other's files.
 *
 * The package is downloaded into a staging folder, checked against the pinned size and digest,
 * unpacked, checked again (its files, its manifest and `codex --version`) and only then renamed
 * into place under the lock. A version folder already on disk is checked like a new one, never
 * trusted. The previous version keeps running until the new one is published.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoveInstallResult } from '../../../../shared/harness/types'
import { atomicWriteJsonSync } from '../../../data/AtomicFs'
import { containedFile, extractArchive } from '../../agents/archive'
import { downloadArtifact } from '../../agents/install'
import { LOCK_FILE, withLock } from '../../agents/lock'
import { changedFile, hashFile, hashTree } from '../../agents/receipt'
import type { InstallProgress } from '../../driver'
import { instanceEnv } from '../../env'
import { runHarness } from '../../spawn'
import {
  CODEX_LAYOUT_VERSION,
  CODEX_MANIFEST,
  codexEntrypoint,
  codexFileset,
  codexReleaseFor,
  expectedVersionLine,
  unsupportedPlatformMessage,
  type CodexRelease
} from './release'

export const CODEX_DOWNLOAD_TIMEOUT_MS = 45 * 60_000
export const CODEX_VERSION_TIMEOUT_MS = 90_000
/** Staging older than this belongs to no live install (another profile may be installing now). */
export const CODEX_STAGING_STALE_MS = 24 * 60 * 60_000
export const ACTIVE_FILE = 'active.json'
export const COMPLETE_FILE = '.install-complete.json'
const STAGING_PREFIXES = ['.install-', '.active-']
const RENAME_TRIES = 10
const RENAME_WAIT_MS = 100
/** The lock is held only to publish or delete; a download never holds it. */
const LOCK_WAIT_MS = 60_000

interface ActiveRecord {
  version: string
  target: string
  sha256: string
}

interface CompleteRecord extends ActiveRecord {
  /** Size of the unpacked files. */
  bytes: number
  /** SHA-256 of every unpacked file, checked by `verify`. */
  files: Record<string, string>
}

export interface CodexInstalled {
  /** The absolute `bin/codex[.exe]`. */
  path: string
  version: string
  bytes?: number
  /** Why the install cannot run as it is (Reinstall fixes it). */
  broken?: string
}

export interface CodexInstallationOptions {
  installationHome: string
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof fetch
  /** Runs `<binary> --version` and returns its output (tests substitute it). */
  runVersion?: (binary: string, signal: AbortSignal) => Promise<string>
  release?: CodexRelease
}

/** App-servers running from a version folder in this process; their files are never deleted. */
const leases = new Map<string, number>()
/**
 * A version folder whose last full check (`verify`) failed records why beside it
 * (`<version>.check-failed.json`), for every process and across restarts. Such a folder stays
 * broken, and never runs, until a later check passes or a reinstall replaces it.
 */
const failedCheckFile = (root: string): string => `${root}.check-failed.json`

function readFailedCheck(root: string): string | undefined {
  const record = readJson(failedCheckFile(root))
  return record && typeof record.reason === 'string' && record.reason ? record.reason : undefined
}

function writeFailedCheck(root: string, reason: string): void {
  atomicWriteJsonSync(failedCheckFile(root), { reason })
}

function clearFailedCheck(root: string): void {
  rmSync(failedCheckFile(root), { force: true })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function readComplete(root: string): CompleteRecord | undefined {
  const value = readJson(join(root, COMPLETE_FILE))
  if (!value || typeof value.version !== 'string' || typeof value.target !== 'string' || typeof value.sha256 !== 'string') return undefined
  if (typeof value.bytes !== 'number' || !isRecord(value.files) || Object.values(value.files).some((digest) => typeof digest !== 'string')) return undefined
  return value as unknown as CompleteRecord
}

const segments = (path: string) => path.split('/')

/** Why the package under `root` is not the pinned one (files, manifest), or undefined. */
function layoutProblem(root: string, release: CodexRelease): string | undefined {
  for (const file of codexFileset(release)) {
    try {
      containedFile(root, segments(file.path), { executable: file.executable })
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const manifest = readJson(join(root, CODEX_MANIFEST))
  if (
    !manifest ||
    manifest.layoutVersion !== CODEX_LAYOUT_VERSION ||
    manifest.version !== release.version ||
    manifest.target !== release.target ||
    manifest.entrypoint !== codexEntrypoint(release)
  )
    return `The Codex package is not version ${release.version} for ${release.target}.`
  return undefined
}

async function renameWithRetry(from: string, to: string, platform: NodeJS.Platform): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      // Antivirus scans and process rundown hold a fresh `codex.exe` open for a moment on Windows.
      const code = (error as NodeJS.ErrnoException).code
      if (platform !== 'win32' || attempt >= RENAME_TRIES || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      await new Promise((resolve) => setTimeout(resolve, RENAME_WAIT_MS))
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class CodexInstallation {
  /** `<installationHome>/managed/codex`. */
  readonly dir: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private controller?: AbortController

  constructor(private readonly options: CodexInstallationOptions) {
    this.dir = join(options.installationHome, 'managed', 'codex')
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
  }

  /** The pinned package for this machine, when OpenAI publishes one. */
  release(): CodexRelease | undefined {
    return this.options.release ?? codexReleaseFor(this.platform, this.arch)
  }

  unsupportedMessage(): string | undefined {
    return this.release() ? undefined : unsupportedPlatformMessage(this.platform, this.arch)
  }

  private root(version: string): string {
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version)) throw new Error(`Invalid Codex version ${version}`)
    return join(this.dir, version)
  }

  private binaryOf(root: string, release: CodexRelease): string {
    return join(root, ...segments(codexEntrypoint(release)))
  }

  /**
   * The published install new processes start, from `active.json`; no hashing, no process. It is
   * `broken` when it is not the pinned version, is incomplete, or failed its last full check.
   */
  installed(): CodexInstalled | undefined {
    const inspected = this.inspect()
    if (!inspected || inspected.installed.broken) return inspected?.installed
    const failed = readFailedCheck(inspected.root)
    return failed ? { ...inspected.installed, broken: failed } : inspected.installed
  }

  /** `installed()` without the result of the last full check. */
  private inspect(): { root: string; installed: CodexInstalled } | undefined {
    const release = this.release()
    const active = readJson(join(this.dir, ACTIVE_FILE))
    if (!release || !active || typeof active.version !== 'string') return undefined
    let root: string
    try {
      root = this.root(active.version)
    } catch {
      return undefined
    }
    const path = this.binaryOf(root, release)
    const complete = readComplete(root)
    const base = { path, version: active.version, ...(complete ? { bytes: complete.bytes } : {}) }
    const broken = (reason: string) => ({ root, installed: { ...base, broken: reason } })
    // An `active.json` naming another version (another Mousse build, or edited by hand) is never
    // run: Reinstall puts the pin back.
    if (active.version !== release.version) return broken(`Mousse runs Codex ${release.version}, not ${active.version}. Reinstall it.`)
    if (!complete || complete.version !== release.version || complete.target !== release.target || complete.sha256 !== release.sha256 || active.sha256 !== release.sha256)
      return broken('The Codex install is incomplete. Reinstall it.')
    for (const file of codexFileset(release))
      if (!existsSync(join(root, ...segments(file.path)))) return broken(`The Codex install has no ${file.path}. Reinstall it.`)
    return { root, installed: base }
  }

  /**
   * Checks every file of the active install against what was unpacked, and that it runs as the
   * pinned version. Returns why it cannot run, or undefined. A failure is kept: `installed()`
   * reports it as `broken` until a later check passes or a reinstall replaces the files.
   */
  async verify(signal: AbortSignal): Promise<string | undefined> {
    const release = this.release()
    if (!release) return this.unsupportedMessage()
    const inspected = this.inspect()
    if (!inspected) return 'Codex is not installed.'
    if (inspected.installed.broken) return inspected.installed.broken
    const problem = await this.check(inspected.root, release, signal)
    if (problem) writeFailedCheck(inspected.root, problem)
    else clearFailedCheck(inspected.root)
    return problem
  }

  /** A published version folder: its record, its files and `--version`. */
  private async check(root: string, release: CodexRelease, signal: AbortSignal): Promise<string | undefined> {
    const complete = readComplete(root)
    if (!complete || complete.version !== release.version || complete.target !== release.target || complete.sha256 !== release.sha256)
      return 'The Codex install is incomplete. Reinstall it.'
    const layout = layoutProblem(root, release)
    if (layout) return layout
    const changed = await changedFile(root, { files: { ...complete.files, [COMPLETE_FILE]: await hashFile(join(root, COMPLETE_FILE), signal) } }, signal)
    if (changed) return `The Codex files changed since install (${changed}). Reinstall it.`
    return this.versionProblem(this.binaryOf(root, release), release, signal)
  }

  private async versionProblem(binary: string, release: CodexRelease, signal: AbortSignal): Promise<string | undefined> {
    let output: string
    try {
      output = await (this.options.runVersion ?? ((path, abort) => this.runVersion(path, abort)))(binary, signal)
    } catch (error) {
      signal.throwIfAborted()
      return `Codex did not start: ${errorText(error)}`
    }
    const line = output.trim().split(/\r?\n/)[0]?.trim()
    return line === expectedVersionLine(release) ? undefined : `Codex reported "${(line ?? '').slice(0, 80)}" instead of ${expectedVersionLine(release)}.`
  }

  /** `codex --version` with a private, empty home and no inherited OpenAI credentials. */
  private async runVersion(binary: string, signal: AbortSignal): Promise<string> {
    const home = join(this.dir, '.check-home')
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const env = instanceEnv({ instanceId: 'codex-install', driver: 'codex', configRevision: 0, home, searchPath: [] })
    const result = await runHarness(env, 'codex-version', binary, ['--version'], { timeoutMs: CODEX_VERSION_TIMEOUT_MS, signal })
    if (result.spawnError) throw new Error(result.spawnError)
    if (result.timedOut) throw new Error('it did not answer --version in time')
    if (result.code !== 0) throw new Error(`--version exited with ${result.code}`)
    return result.stdout
  }

  installing(): boolean {
    return this.controller !== undefined
  }

  cancel(): boolean {
    if (!this.controller) return false
    this.controller.abort(new Error('Codex install cancelled'))
    return true
  }

  /**
   * Marks the active version as in use by a running app-server; call the result when it exits.
   * A broken install is never leased: it never runs.
   */
  acquire(): () => void {
    const installed = this.installed()
    if (!installed || installed.broken) return () => {}
    const root = this.root(installed.version)
    leases.set(root, (leases.get(root) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (leases.get(root) ?? 1) - 1
      if (left > 0) leases.set(root, left)
      else leases.delete(root)
    }
  }

  /** Deletes staging folders an install that ended long ago left behind; never a fresh one. */
  sweep(now: number = Date.now()): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!STAGING_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
      const path = join(this.dir, name)
      try {
        if (now - statSync(path).mtimeMs >= CODEX_STAGING_STALE_MS) rmSync(path, { recursive: true, force: true })
      } catch {
        // Gone already, or still held open: the next sweep tries again.
      }
    }
  }

  /**
   * Installs the pinned version (or re-verifies the one on disk) and makes it the active one.
   * Cancel aborts the download and deletes the staging folder; the previous version keeps running.
   */
  async install(onProgress: (progress: InstallProgress) => void, signal?: AbortSignal): Promise<{ path: string; version: string }> {
    const release = this.release()
    if (!release) throw new Error(unsupportedPlatformMessage(this.platform, this.arch))
    if (this.controller) throw new Error('Codex is already being installed.')
    const controller = new AbortController()
    this.controller = controller
    const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      this.sweep()
      const root = this.root(release.version)
      if (existsSync(root)) {
        onProgress({ message: `Checking Codex ${release.version}` })
        if (!(await this.check(root, release, abort))) {
          await withLock(join(this.dir, LOCK_FILE), () => this.activate(release), { signal: abort, timeoutMs: LOCK_WAIT_MS })
          clearFailedCheck(root)
          return { path: this.binaryOf(root, release), version: release.version }
        }
      }
      const staging = join(this.dir, `.install-${randomBytes(6).toString('hex')}`)
      mkdirSync(staging, { mode: 0o700 })
      try {
        const runtime = await this.stage(staging, release, onProgress, abort)
        await withLock(join(this.dir, LOCK_FILE), async () => {
          abort.throwIfAborted()
          // Another profile may have published it meanwhile; a good copy stays, a bad one goes.
          if (existsSync(root)) {
            if (!(await this.check(root, release, abort))) return
            if ((leases.get(root) ?? 0) > 0) throw new Error('The Codex files in use changed. Stop the chats using them, then install again.')
            rmSync(root, { recursive: true, force: true })
          }
          await renameWithRetry(runtime, root, this.platform)
        }, { signal: abort, timeoutMs: LOCK_WAIT_MS })
        await withLock(join(this.dir, LOCK_FILE), () => this.activate(release), { signal: abort, timeoutMs: LOCK_WAIT_MS })
        clearFailedCheck(root)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
      return { path: this.binaryOf(root, release), version: release.version }
    } finally {
      this.controller = undefined
    }
  }

  /** Downloads, checks and unpacks the package into `<staging>/runtime`; returns that folder. */
  private async stage(staging: string, release: CodexRelease, onProgress: (progress: InstallProgress) => void, signal: AbortSignal): Promise<string> {
    const archive = join(staging, 'codex.tar.gz')
    const total = release.bytes
    const download = await downloadArtifact(release.url, archive, {
      signal,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      maxBytes: total,
      timeoutMs: CODEX_DOWNLOAD_TIMEOUT_MS,
      label: 'Codex',
      onProgress: (progress) => {
        const received = progress.receivedBytes ?? 0
        onProgress({
          message: `Downloading Codex ${progress.message.replace(/^Downloading /, '')}`,
          fraction: Math.min(1, received / total),
          receivedBytes: received,
          totalBytes: progress.totalBytes ?? total
        })
      }
    })
    if (download.bytes !== release.bytes || download.sha256 !== release.sha256)
      throw new Error('The Codex download does not match the package OpenAI published. Try again.')
    onProgress({ message: `Unpacking Codex ${release.version}`, fraction: 1 })
    const runtime = join(staging, 'runtime')
    await extractArchive(archive, runtime, { format: 'tar.gz', signal })
    rmSync(archive, { force: true })
    const layout = layoutProblem(runtime, release)
    if (layout) throw new Error(layout)
    const problem = await this.versionProblem(this.binaryOf(runtime, release), release, signal)
    if (problem) throw new Error(problem)
    const tree = await hashTree(runtime, signal)
    const complete: CompleteRecord = { version: release.version, target: release.target, sha256: release.sha256, bytes: tree.bytes, files: tree.files }
    writeFileSync(join(runtime, COMPLETE_FILE), JSON.stringify(complete), { flag: 'wx', mode: 0o600 })
    return runtime
  }

  private activate(release: CodexRelease): void {
    const record: ActiveRecord = { version: release.version, target: release.target, sha256: release.sha256 }
    atomicWriteJsonSync(join(this.dir, ACTIVE_FILE), record)
  }

  /**
   * Deletes the active version's files. A process running from them here blocks it; `force`
   * changes nothing about that (a running Codex must never lose its files).
   */
  async removeInstall(_options: { force: boolean }): Promise<RemoveInstallResult> {
    const installed = this.installed()
    if (!installed) return { removed: true, bytes: 0 }
    const root = this.root(installed.version)
    return withLock(join(this.dir, LOCK_FILE), (): RemoveInstallResult => {
      if ((leases.get(root) ?? 0) > 0) throw new Error('A chat is still running on these files. Stop it, then delete them.')
      rmSync(join(this.dir, ACTIVE_FILE), { force: true })
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        throw new Error('Mousse could not delete the Codex files. Close anything using them, then try again.')
      }
      if (existsSync(root)) throw new Error('Mousse could not delete the Codex files. Close anything using them, then try again.')
      clearFailedCheck(root)
      return { removed: true, bytes: installed.bytes ?? 0 }
    }, { timeoutMs: LOCK_WAIT_MS })
  }
}

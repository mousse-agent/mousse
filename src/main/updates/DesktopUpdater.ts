import { channelForVersion, type UpdateChannel, type UpdateState } from '../../shared/updates'
import { normalizeReleaseNotes, type RawReleaseNotes } from './releaseNotes'
import type { UpdaterRecordStore } from './updaterRecord'

/** The part of electron-updater's `AppUpdater` this module drives. */
export interface UpdaterBackend {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  fullChangelog: boolean
  channel: string | null
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string; releaseNotes?: RawReleaseNotes } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export const FIRST_CHECK_DELAY_MS = 15_000
export const CHECK_INTERVAL_MS = 30 * 60_000
/** A window regaining focus checks again only when the last check is at least this old. */
export const FOCUS_CHECK_MIN_GAP_MS = 10 * 60_000
const RETRY_BASE_MS = 5 * 60_000
const RETRY_MAX_MS = 2 * 60 * 60_000
const PROGRESS_EMIT_MS = 1_000

/** Failures that mean there is nothing to update to, such as a release without update files. */
const NOTHING_TO_UPDATE = new Set([
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
  'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
  'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
])

export interface DesktopUpdaterOptions {
  currentVersion: string
  /** `https://github.com/<owner>/<repo>`, for release links. */
  repositoryUrl: string
  /** Set when this build cannot update itself. */
  disabledReason?: string
  store: UpdaterRecordStore
  /** Loads electron-updater on first use, so startup never pays for it. */
  loadBackend: () => Promise<UpdaterBackend>
  /** Frees the executable for the installer: disconnects clients and stops the background service. */
  prepareInstall: () => Promise<void>
  /** Undoes `prepareInstall` after the installer could not start. */
  recoverInstall: () => Promise<void>
  onState: (state: UpdateState) => void
  now?: () => number
  random?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const firstLine = text.split('\n')[0]!.trim()
  return firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine
}

/**
 * Checks GitHub Releases for a newer build on the chosen channel, downloads it when asked and
 * hands over to the installer. Checks run 15 s after start, then every 30 min (with jitter), and
 * back off up to 2 h after failures. One action runs at a time.
 */
export class DesktopUpdater {
  private state: UpdateState
  private backendPromise: Promise<UpdaterBackend> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private timer: unknown = null
  private failures = 0
  private lastProgressEmit = 0
  private disposed = false
  private readonly now: () => number
  private readonly random: () => number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: DesktopUpdaterOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms).unref())
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    const { install, ...kept } = options.store.read()
    let notAppliedVersion: string | undefined
    if (install) {
      // Still on the version the installer was meant to replace: the update did not apply.
      if (install.from === options.currentVersion && install.to !== options.currentVersion) notAppliedVersion = install.to
      options.store.write(kept)
    }
    this.state = {
      phase: options.disabledReason ? 'disabled' : 'idle',
      currentVersion: options.currentVersion,
      channel: kept.channel ?? channelForVersion(options.currentVersion),
      ...(options.disabledReason ? { disabledReason: options.disabledReason } : {}),
      releaseNotes: [],
      omittedReleaseCount: 0,
      ...(notAppliedVersion ? { notAppliedVersion } : {})
    }
  }

  getState(): UpdateState {
    return this.state
  }

  start(): void {
    if (this.state.phase !== 'disabled') this.schedule(FIRST_CHECK_DELAY_MS)
  }

  /** A window gained focus. Checks when the last check is old enough. */
  noteFocus(): void {
    const last = this.state.lastCheckedAt
    if (this.disposed || this.state.phase === 'disabled' || last === undefined) return
    if (this.now() - last >= FOCUS_CHECK_MIN_GAP_MS) void this.check()
  }

  /** Checks now. A check the user asked for shows its progress and any failure. */
  check(manual = false): Promise<UpdateState> {
    return this.enqueue(() => this.runCheck(manual))
  }

  download(): Promise<UpdateState> {
    return this.enqueue(() => this.runDownload())
  }

  install(): Promise<UpdateState> {
    return this.enqueue(() => this.runInstall())
  }

  setChannel(channel: UpdateChannel): Promise<UpdateState> {
    return this.enqueue(async () => {
      if (['disabled', 'downloading', 'installing'].includes(this.state.phase)) return this.state
      this.options.store.write({ ...this.options.store.read(), channel })
      this.update({ channel, phase: 'idle' }, ['availableVersion', 'downloadPercent', 'error'])
      if (this.backendPromise) this.applyChannel(await this.backendPromise)
      return this.runCheck(true)
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }

  private async runCheck(manual: boolean): Promise<UpdateState> {
    // A downloaded update stays ready; a newer one is offered after it is installed.
    if (this.disposed || ['disabled', 'downloading', 'downloaded', 'installing'].includes(this.state.phase)) return this.state
    if (manual) this.update({ phase: 'checking' }, ['error'])
    try {
      const backend = await this.loadBackend()
      const result = await backend.checkForUpdates()
      this.failures = 0
      const info = result?.isUpdateAvailable ? result.updateInfo : undefined
      if (!info) {
        this.update({ phase: 'up-to-date', lastCheckedAt: this.now(), releaseNotes: [], omittedReleaseCount: 0 }, ['availableVersion', 'error'])
      } else {
        const notes = normalizeReleaseNotes(info.releaseNotes, info.version, this.options.repositoryUrl)
        this.update({ phase: 'available', availableVersion: info.version, lastCheckedAt: this.now(), ...notes }, ['error'])
      }
      this.schedule(CHECK_INTERVAL_MS)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (typeof code === 'string' && NOTHING_TO_UPDATE.has(code)) {
        this.failures = 0
        this.update({ phase: 'up-to-date', lastCheckedAt: this.now() }, ['availableVersion', 'error'])
        this.schedule(CHECK_INTERVAL_MS)
      } else {
        this.failures += 1
        this.schedule(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1)))
        // Background failures stay out of the UI (offline is normal); an offered update stays offered.
        if (!manual) console.warn(`Update check failed (retrying later): ${errorMessage(error)}`)
        if (manual) this.update({ phase: 'error', lastCheckedAt: this.now(), error: { message: errorMessage(error), during: 'check' } })
        else if (this.state.phase === 'checking') this.update({ phase: 'idle' })
      }
    }
    return this.state
  }

  private async runDownload(): Promise<UpdateState> {
    if (this.state.phase !== 'available') return this.state
    this.lastProgressEmit = this.now()
    this.update({ phase: 'downloading', downloadPercent: 0 }, ['error'])
    try {
      await (await this.loadBackend()).downloadUpdate()
      this.update({ phase: 'downloaded', downloadPercent: 100 })
    } catch (error) {
      this.update({ phase: 'error', error: { message: errorMessage(error), during: 'download' } }, ['downloadPercent'])
    }
    return this.state
  }

  private async runInstall(): Promise<UpdateState> {
    const target = this.state.availableVersion
    if (this.state.phase !== 'downloaded' || !target) return this.state
    this.update({ phase: 'installing' }, ['error', 'notAppliedVersion'])
    const record = this.options.store.read()
    this.options.store.write({ ...record, install: { from: this.state.currentVersion, to: target, at: this.now() } })
    try {
      const backend = await this.loadBackend()
      await this.options.prepareInstall()
      // Silent install, then start the new version. A failure here arrives as an 'error' event.
      backend.quitAndInstall(true, true)
    } catch (error) {
      await this.failInstall(error)
    }
    return this.state
  }

  private async failInstall(error: unknown): Promise<void> {
    const { install: _install, ...kept } = this.options.store.read()
    this.options.store.write(kept)
    try {
      await this.options.recoverInstall()
    } catch (recoverError) {
      console.error('Update install recovery failed:', errorMessage(recoverError))
    }
    // The download is still on disk; installing again retries.
    this.update({ phase: 'downloaded', error: { message: errorMessage(error), during: 'install' } })
  }

  private loadBackend(): Promise<UpdaterBackend> {
    this.backendPromise ??= this.options.loadBackend().then((backend) => {
      backend.autoDownload = false
      backend.autoInstallOnAppQuit = false
      backend.on('download-progress', ({ percent }) => this.onProgress(percent))
      // electron-updater also rejects the call that failed; this listener only has to catch
      // installer failures, which have no call to reject.
      backend.on('error', (error) => {
        if (this.state.phase === 'installing') void this.failInstall(error)
      })
      this.applyChannel(backend)
      return backend
    })
    this.backendPromise.catch(() => {
      this.backendPromise = null
    })
    return this.backendPromise
  }

  private applyChannel(backend: UpdaterBackend): void {
    const nightly = this.state.channel === 'nightly'
    backend.channel = nightly ? 'nightly' : 'latest'
    backend.allowPrerelease = nightly
    backend.fullChangelog = nightly
    // Setting the channel turns downgrades on. Moving from a nightly to stable therefore waits
    // for a stable release newer than this build instead of going back, which could leave saved
    // data newer than the app can read.
    backend.allowDowngrade = false
  }

  private onProgress(percent: number): void {
    if (this.state.phase !== 'downloading') return
    const rounded = Math.max(0, Math.min(100, Math.floor(percent)))
    if (rounded === this.state.downloadPercent) return
    const now = this.now()
    if (now - this.lastProgressEmit < PROGRESS_EMIT_MS && rounded < 100) {
      this.state = { ...this.state, downloadPercent: rounded }
      return
    }
    this.lastProgressEmit = now
    this.update({ downloadPercent: rounded })
  }

  private schedule(baseMs: number): void {
    if (this.disposed) return
    if (this.timer !== null) this.clearTimer(this.timer)
    const ms = Math.round(baseMs * (0.9 + this.random() * 0.2))
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.check()
    }, ms)
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action, action)
    this.queue = run.catch(() => undefined)
    return run
  }

  private update(patch: Partial<UpdateState>, clear: Array<keyof UpdateState> = []): void {
    const next: UpdateState = { ...this.state, ...patch }
    for (const key of clear) delete next[key]
    this.state = next
    this.options.onState(next)
  }
}

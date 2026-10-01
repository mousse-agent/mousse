import { randomUUID } from 'node:crypto'
import type {
  ManagedBrowserAvailability,
  ManagedBrowserInstallProgress,
  ManagedBrowserInstaller
} from '../../shared/browser/install'
import {
  BROWSER_SETUP_CHANNEL,
  BROWSER_SETUP_IN_APP_NOTE,
  BROWSER_SETUP_OPERATION_ID_PATTERN,
  DEFAULT_BROWSER_SETUP_MAX_DURATION_MS,
  DEFAULT_BROWSER_SETUP_SHUTDOWN_TIMEOUT_MS,
  type BrowserSetupHostActivity,
  type BrowserSetupOperation,
  type BrowserSetupOperationState,
  type BrowserSetupProgress,
  type BrowserSetupShutdownRemaining,
  type BrowserSetupStatus,
  type ManagedBrowserLaunchAdmission
} from '../../shared/browser/setup'

export class BrowserSetupError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'BrowserSetupError'
  }
}

export class BrowserSetupAdmissionError extends BrowserSetupError {
  constructor(
    readonly code: 'admission_closed' | 'install_in_progress' | 'replace_blocked',
    message: string
  ) {
    super(code, message)
    this.name = 'BrowserSetupAdmissionError'
  }
}

export class BrowserSetupShutdownError extends Error {
  readonly code = 'shutdown_timeout' as const

  constructor(
    readonly timeoutMs: number,
    readonly remaining: BrowserSetupShutdownRemaining
  ) {
    super(`managed browser setup shutdown timed out after ${timeoutMs}ms`)
    this.name = 'BrowserSetupShutdownError'
  }
}

export interface BrowserSetupServiceOptions {
  /** Installation-shared managed browser root. Injected by the host. */
  root: string
  installer: ManagedBrowserInstaller
  activity: BrowserSetupHostActivity
  maxDurationMs?: number
  now?: () => number
  fetch?: typeof globalThis.fetch
  /** Test-only local mirror origins. Production omits this. */
  allowedOrigins?: readonly string[]
  createId?: () => string
}

type SetupPhase = 'idle' | 'shutting-down' | 'stopped'

interface LiveOperation {
  id: string
  state: BrowserSetupOperationState
  startedAt: string
  updatedAt: string
  completedAt?: string
  progress: BrowserSetupProgress
  error?: { code: string; message: string }
  version?: string
  controller: AbortController
  deadline?: ReturnType<typeof setTimeout>
  abortReason?: 'cancel' | 'deadline' | 'shutdown'
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: string }).name
  return name === 'AbortError' || (error instanceof DOMException && error.name === 'AbortError')
}

function isUuid(value: string): boolean {
  return BROWSER_SETUP_OPERATION_ID_PATTERN.test(value)
}

function publicProgress(progress: ManagedBrowserInstallProgress | BrowserSetupProgress): BrowserSetupProgress {
  return {
    phase: progress.phase,
    receivedBytes: progress.receivedBytes,
    ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
    ...(progress.fraction === undefined ? {} : { fraction: progress.fraction }),
    ...(progress.version === undefined ? {} : { version: progress.version })
  }
}

function redact(message: string, root: string): string {
  const variants = [root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')]
  let result = message
  for (const variant of variants) {
    if (variant) result = result.split(variant).join('[managed-browser]')
  }
  return result
}

function terminal(state: BrowserSetupOperationState): boolean {
  return state === 'succeeded' || state === 'cancelled' || state === 'failed'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Installation-owned managed Chrome setup. One active install is shared across
 * every profile. Caller disconnect never cancels the operation.
 */
export class BrowserSetupService {
  private phase: SetupPhase = 'idle'
  private live: LiveOperation | undefined
  private work: Promise<void> | undefined
  private lastTerminal: BrowserSetupOperation | undefined
  private admitted = 0
  private pendingStarts = 0
  private launchGeneration = 0
  private startChain: Promise<unknown> = Promise.resolve()
  private shutdownWork: Promise<void> | undefined
  private readonly root: string
  private readonly installer: ManagedBrowserInstaller
  private readonly activity: BrowserSetupHostActivity
  private readonly maxDurationMs: number
  private readonly now: () => number
  private readonly createId: () => string

  constructor(private readonly options: BrowserSetupServiceOptions) {
    this.root = options.root
    this.installer = options.installer
    this.activity = options.activity
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_BROWSER_SETUP_MAX_DURATION_MS
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  /**
   * Root must call this immediately before managed Chrome start (broker.start /
   * first managed dispatch). Release after start settles or fails. Attached
   * in-app tabs must not use this fence.
   */
  admitManagedLaunch(): ManagedBrowserLaunchAdmission {
    this.assertAdmits('launch')
    if (this.hasUnsettledInstall()) {
      throw new BrowserSetupAdmissionError(
        'install_in_progress',
        'Cannot start managed Chrome while a managed browser install is in progress.'
      )
    }
    this.admitted += 1
    const generation = ++this.launchGeneration
    let released = false
    return {
      generation,
      release: () => {
        if (released) return
        released = true
        this.admitted = Math.max(0, this.admitted - 1)
      }
    }
  }

  async status(): Promise<BrowserSetupStatus> {
    return this.project()
  }

  async install(): Promise<{ operationId: string; status: BrowserSetupStatus }> {
    this.assertAdmits('install')
    this.pendingStarts += 1
    try {
      return await this.serializeStart(async () => {
        this.assertAdmits('install')
        if (this.live && !terminal(this.live.state)) {
          return { operationId: this.live.id, status: await this.project() }
        }
        const availability = await this.readAvailability()
        // Availability may be slow. Re-check the synchronous admission gate
        // before creating or recording installation-owned work.
        this.assertAdmits('install')
        if (availability.status === 'unsupported') {
          throw new BrowserSetupError('unsupported', availability.message)
        }
        if (availability.status === 'blocked') {
          throw new BrowserSetupError('blocked', availability.message)
        }
        if (availability.status === 'ready') {
          const operation = this.rememberReady(availability.version)
          return { operationId: operation.id, status: await this.project() }
        }
        const activity = this.managedActivity()
        if (activity > 0) {
          throw new BrowserSetupAdmissionError(
            'replace_blocked',
            'Cannot install the managed browser while a managed launch or session is active.'
          )
        }
        const id = this.createId()
        if (!isUuid(id)) throw new BrowserSetupError('internal', 'Setup operation id is not a UUID.')
        const startedAt = new Date(this.now()).toISOString()
        const controller = new AbortController()
        const live: LiveOperation = {
          id,
          state: 'running',
          startedAt,
          updatedAt: startedAt,
          progress: { phase: 'resolving', receivedBytes: 0 },
          controller
        }
        this.live = live
        this.lastTerminal = undefined
        live.deadline = setTimeout(() => this.abortLive('deadline'), this.maxDurationMs)
        this.work = this.runInstall(live)
        return { operationId: id, status: await this.project() }
      })
    } finally {
      this.pendingStarts = Math.max(0, this.pendingStarts - 1)
    }
  }

  async cancel(operationId: string): Promise<{ operationId: string; status: BrowserSetupStatus }> {
    if (!isUuid(operationId)) throw new BrowserSetupError('invalid_params', 'Invalid operationId')
    const live = this.live
    if (!live || live.id !== operationId) {
      if (this.lastTerminal?.id === operationId) {
        throw new BrowserSetupError('operation_not_running', 'That managed browser install is no longer running.')
      }
      throw new BrowserSetupError('operation_not_found', 'Unknown managed browser install operation.')
    }
    if (terminal(live.state)) {
      throw new BrowserSetupError('operation_not_running', 'That managed browser install is no longer running.')
    }
    this.abortLive('cancel')
    return { operationId: live.id, status: await this.project() }
  }

  beginShutdown(): void {
    if (this.phase === 'stopped' || this.phase === 'shutting-down') return
    this.phase = 'shutting-down'
    if (this.live && !terminal(this.live.state)) this.abortLive('shutdown')
  }

  getActiveCount(): number {
    return (this.hasUnsettledInstall() ? 1 : 0) + this.admitted
  }

  snapshotRemaining(): BrowserSetupShutdownRemaining {
    return { install: this.hasUnsettledInstall(), admittedLaunches: this.admitted }
  }

  shutdown(options?: { timeoutMs?: number }): Promise<void> {
    this.beginShutdown()
    if (this.phase === 'stopped' && this.getActiveCount() === 0) return Promise.resolve()
    if (this.shutdownWork) return this.shutdownWork
    const timeoutMs = normalizeTimeoutMs(options?.timeoutMs)
    const drain = this.runDrain(timeoutMs)
    this.shutdownWork = drain
    return drain
  }

  private async runDrain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    try {
      while (this.getActiveCount() > 0) {
        if (Date.now() >= deadline) {
          throw new BrowserSetupShutdownError(timeoutMs, this.snapshotRemaining())
        }
        await (this.work ? Promise.race([this.work, sleep(50)]) : sleep(50))
      }
      if (this.getActiveCount() !== 0) {
        throw new BrowserSetupShutdownError(timeoutMs, this.snapshotRemaining())
      }
      this.phase = 'stopped'
      this.shutdownWork = undefined
    } catch (error) {
      if (error instanceof BrowserSetupShutdownError) this.shutdownWork = undefined
      throw error
    }
  }

  private hasUnsettledInstall(): boolean {
    return this.pendingStarts > 0 || this.work !== undefined || (this.live !== undefined && !terminal(this.live.state))
  }

  private assertAdmits(operation: 'install' | 'launch'): void {
    if (this.phase === 'idle') return
    throw new BrowserSetupAdmissionError(
      'admission_closed',
      `Managed browser setup ${operation} rejected: setup is ${this.phase}.`
    )
  }

  private managedActivity(): number {
    let host = 0
    try {
      host = this.activity.activeManagedSessions()
    } catch {
      throw new BrowserSetupAdmissionError(
        'replace_blocked',
        'Managed browser activity could not be determined.'
      )
    }
    if (!Number.isSafeInteger(host) || host < 0) {
      throw new BrowserSetupAdmissionError('replace_blocked', 'Managed browser activity is invalid.')
    }
    return host + this.admitted
  }

  private async readAvailability(): Promise<ManagedBrowserAvailability> {
    return this.installer.availability(this.root, this.managedActivity())
  }

  private rememberReady(version?: string): BrowserSetupOperation {
    if (this.lastTerminal?.state === 'succeeded' && this.lastTerminal.version === version) {
      return this.lastTerminal
    }
    const at = new Date(this.now()).toISOString()
    const operation: BrowserSetupOperation = {
      id: this.createId(),
      state: 'succeeded',
      startedAt: at,
      updatedAt: at,
      completedAt: at,
      progress: { phase: 'complete', receivedBytes: 0, ...(version === undefined ? {} : { version }) },
      ...(version === undefined ? {} : { version })
    }
    this.lastTerminal = operation
    this.live = undefined
    return operation
  }

  private abortLive(reason: LiveOperation['abortReason']): void {
    const live = this.live
    if (!live || terminal(live.state)) return
    live.abortReason = reason
    if (reason === 'cancel' || reason === 'shutdown') live.state = 'cancelling'
    live.progress = { ...live.progress, phase: 'cancelling' }
    live.updatedAt = new Date(this.now()).toISOString()
    if (!live.controller.signal.aborted) live.controller.abort()
  }

  private async runInstall(live: LiveOperation): Promise<void> {
    try {
      const result = await this.installer.install({
        root: this.root,
        channel: BROWSER_SETUP_CHANNEL,
        signal: live.controller.signal,
        activeSessions: () => this.managedActivity(),
        onProgress: (progress) => {
          if (this.live !== live || terminal(live.state)) return
          live.progress = publicProgress(progress)
          live.updatedAt = new Date(this.now()).toISOString()
          if (progress.version) live.version = progress.version
        },
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(this.options.allowedOrigins ? { allowedOrigins: this.options.allowedOrigins } : {})
      })
      if (this.live !== live) return
      live.state = 'succeeded'
      live.version = result.metadata.version
      live.progress = {
        phase: 'complete',
        receivedBytes: live.progress.receivedBytes,
        ...(live.progress.totalBytes === undefined ? {} : { totalBytes: live.progress.totalBytes }),
        fraction: 1,
        version: result.metadata.version
      }
      live.completedAt = new Date(this.now()).toISOString()
      live.updatedAt = live.completedAt
      this.lastTerminal = this.snapshotOperation(live)
    } catch (error) {
      if (this.live !== live) return
      const aborted = isAbortError(error) || live.controller.signal.aborted
      if (aborted && live.abortReason === 'deadline') {
        live.state = 'failed'
        live.error = {
          code: 'deadline_exceeded',
          message: `Managed browser install exceeded the ${this.maxDurationMs}ms limit.`
        }
        live.progress = { ...live.progress, phase: 'failed' }
      } else if (aborted) {
        live.state = 'cancelled'
        live.error = {
          code: live.abortReason === 'shutdown' ? 'shutdown' : 'cancelled',
          message: live.abortReason === 'shutdown'
            ? 'Managed browser install was cancelled because the daemon is shutting down.'
            : 'Managed browser install was cancelled.'
        }
        live.progress = { ...live.progress, phase: 'cancelled' }
      } else {
        live.state = 'failed'
        live.error = {
          code: 'install_failed',
          message: redact(error instanceof Error ? error.message : String(error), this.root)
        }
        live.progress = { ...live.progress, phase: 'failed' }
      }
      live.completedAt = new Date(this.now()).toISOString()
      live.updatedAt = live.completedAt
      this.lastTerminal = this.snapshotOperation(live)
    } finally {
      if (live.deadline) clearTimeout(live.deadline)
      live.deadline = undefined
      if (this.work && this.live === live) this.work = undefined
      if (this.live === live && terminal(live.state)) this.live = undefined
    }
  }

  private snapshotOperation(live: LiveOperation): BrowserSetupOperation {
    return {
      id: live.id,
      state: live.state,
      startedAt: live.startedAt,
      updatedAt: live.updatedAt,
      ...(live.completedAt === undefined ? {} : { completedAt: live.completedAt }),
      progress: { ...live.progress },
      ...(live.error === undefined ? {} : { error: { ...live.error } }),
      ...(live.version === undefined ? {} : { version: live.version })
    }
  }

  private async project(): Promise<BrowserSetupStatus> {
    const availability = await this.readAvailability()
    const live = this.live
    const operation = live ? this.snapshotOperation(live) : this.lastTerminal
    const installing = live !== undefined && !terminal(live.state)
    const availabilityStatus = installing ? 'installing' : availability.status
    const platform = this.installer.platform()
    const canInstall =
      this.phase === 'idle' &&
      !installing &&
      availability.status === 'setup-required' &&
      platform.supported
    const message = installing
      ? live.state === 'cancelling'
        ? 'Managed browser installation is cancelling.'
        : 'Managed browser installation is in progress.'
      : stripPrivate(availability.message, this.root)
    return {
      availability: availabilityStatus,
      message,
      channel: BROWSER_SETUP_CHANNEL,
      platform: {
        id: platform.platform,
        supported: platform.supported,
        ...(platform.reason === undefined ? {} : { reason: platform.reason })
      },
      ...(availability.version === undefined && live?.version === undefined
        ? {}
        : { version: live?.version ?? availability.version }),
      canInstall,
      activeManagedSessions: Math.max(0, this.managedActivity() - this.admitted),
      admittedLaunches: this.admitted,
      inAppNote: BROWSER_SETUP_IN_APP_NOTE,
      ...(operation === undefined ? {} : { operation })
    }
  }

  private serializeStart<T>(work: () => Promise<T>): Promise<T> {
    const run = this.startChain.then(work, work)
    this.startChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

function stripPrivate(message: string, root: string): string {
  return redact(message, root)
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_BROWSER_SETUP_SHUTDOWN_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return DEFAULT_BROWSER_SETUP_SHUTDOWN_TIMEOUT_MS
  return Math.floor(timeoutMs)
}

export function createBrowserSetupService(options: BrowserSetupServiceOptions): BrowserSetupService {
  return new BrowserSetupService(options)
}

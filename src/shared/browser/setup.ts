/**
 * Installation-owned managed Chrome setup contract.
 * GUI/CLI only. Never a model tool, never an attached in-app download.
 */

import type { ManagedBrowserAvailability, ManagedBrowserInstallProgress, ManagedBrowserPlatform } from './install'

export const BROWSER_SETUP_CAPABILITY = 'browser.setup.v1' as const

export const BROWSER_SETUP_METHODS = [
  'browser.setup.status',
  'browser.setup.install',
  'browser.setup.cancel'
] as const

export type BrowserSetupMethod = (typeof BROWSER_SETUP_METHODS)[number]

export const BROWSER_SETUP_CHANNEL = 'Stable' as const

/** First product path is official Stable Chrome for Testing only. */
export const DEFAULT_BROWSER_SETUP_MAX_DURATION_MS = 15 * 60_000
export const DEFAULT_BROWSER_SETUP_SHUTDOWN_TIMEOUT_MS = 30_000
export const DEFAULT_BROWSER_SETUP_POLL_MS = 750

export const BROWSER_SETUP_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const BROWSER_SETUP_IN_APP_NOTE =
  'Managed Chrome serves CLI and background automation. Current in-app browser tabs work without it.'

export interface BrowserSetupRequestApi {
  request<T = unknown>(method: BrowserSetupMethod, params?: unknown): Promise<T>
}

export type BrowserSetupAvailabilityStatus = ManagedBrowserAvailability['status']

export type BrowserSetupOperationState = 'running' | 'cancelling' | 'succeeded' | 'cancelled' | 'failed'

export type BrowserSetupPhase =
  | ManagedBrowserInstallProgress['phase']
  | 'idle'
  | 'cancelling'
  | 'cancelled'
  | 'failed'

export interface BrowserSetupProgress {
  phase: BrowserSetupPhase
  receivedBytes: number
  totalBytes?: number
  fraction?: number
  version?: string
}

export interface BrowserSetupErrorShape {
  code: string
  message: string
}

export interface BrowserSetupOperation {
  id: string
  state: BrowserSetupOperationState
  startedAt: string
  updatedAt: string
  completedAt?: string
  progress: BrowserSetupProgress
  error?: BrowserSetupErrorShape
  version?: string
}

export interface BrowserSetupPlatformPublic {
  id: ManagedBrowserPlatform
  supported: boolean
  reason?: string
}

/**
 * Public status DTO. Never includes executable paths, archive URLs, hashes,
 * or other private filesystem locations.
 */
export interface BrowserSetupStatus {
  availability: BrowserSetupAvailabilityStatus
  message: string
  channel: typeof BROWSER_SETUP_CHANNEL
  platform: BrowserSetupPlatformPublic
  version?: string
  canInstall: boolean
  activeManagedSessions: number
  admittedLaunches: number
  inAppNote: string
  operation?: BrowserSetupOperation
}

export interface BrowserSetupInstallResult {
  operationId: string
  status: BrowserSetupStatus
}

export interface BrowserSetupCancelParams {
  operationId: string
}

export interface BrowserSetupCancelResult {
  operationId: string
  status: BrowserSetupStatus
}

export interface ManagedBrowserLaunchAdmission {
  readonly generation: number
  release(): void
}

export interface BrowserSetupShutdownRemaining {
  install: boolean
  admittedLaunches: number
}

/** Host-supplied managed Chromium activity. Attached in-app tabs are excluded. */
export interface BrowserSetupHostActivity {
  activeManagedSessions(): number
}

/**
 * Sequential status poller: one in-flight request at a time, generation-fenced
 * dispose, and a fresh cycle when the caller identity changes.
 */
export class BrowserSetupStatusPoller {
  private disposed = false
  private generation = 0
  private inflight: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly request: BrowserSetupRequestApi['request'],
    private readonly intervalMs = DEFAULT_BROWSER_SETUP_POLL_MS
  ) {}

  start(handlers: {
    onStatus: (status: BrowserSetupStatus) => void
    onError?: (error: Error) => void
  }): () => void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    const generation = ++this.generation
    this.disposed = false
    const live = () => !this.disposed && this.generation === generation
    const tick = (): void => {
      if (!live() || this.inflight) return
      this.inflight = this.request('browser.setup.status', {})
        .then((status) => {
          if (live()) handlers.onStatus(status as BrowserSetupStatus)
        })
        .catch((error) => {
          if (live()) handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
        })
        .finally(() => {
          this.inflight = undefined
        })
    }
    tick()
    this.timer = setInterval(tick, this.intervalMs)
    return () => {
      if (this.generation !== generation) return
      this.dispose()
    }
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}

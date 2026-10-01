export const DEFAULT_BROWSER_BROKER_SHUTDOWN_TIMEOUT_MS = 15_000
export const MAX_BROWSER_WORKER_PENDING = 128

export type BrowserBrokerPhase = 'idle' | 'starting' | 'ready' | 'shutting-down' | 'stopped'

export interface BrowserBrokerRemaining {
  rawPending: number
  workerAlive: boolean
  hostRunning: boolean
  disconnectCleanup: boolean
  phase: BrowserBrokerPhase
}

export class BrowserBrokerAdmissionError extends Error {
  readonly code = 'admission_closed' as const

  constructor(
    readonly operation: string,
    readonly phase: BrowserBrokerPhase
  ) {
    super(`browser broker ${operation} rejected: broker is ${phase}`)
    this.name = 'BrowserBrokerAdmissionError'
  }
}

export class BrowserBrokerShutdownError extends Error {
  readonly code = 'shutdown_timeout' as const

  constructor(
    readonly timeoutMs: number,
    readonly remaining: BrowserBrokerRemaining,
    readonly phase: BrowserBrokerPhase
  ) {
    super(`browser broker shutdown timed out after ${timeoutMs}ms`)
    this.name = 'BrowserBrokerShutdownError'
  }
}

export function normalizeBrokerShutdownTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_BROWSER_BROKER_SHUTDOWN_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return DEFAULT_BROWSER_BROKER_SHUTDOWN_TIMEOUT_MS
  return Math.floor(timeoutMs)
}

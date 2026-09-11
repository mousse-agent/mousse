import { OwnedWorkBarrier } from '../../execution/OwnedWorkBarrier'

export const DEFAULT_MCP_SHUTDOWN_TIMEOUT_MS = 30_000

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortFrom(signal.reason))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortFrom(signal?.reason))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function abortFrom(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error(reason == null ? 'Cancelled' : String(reason))
  error.name = 'AbortError'
  return error
}

export function normalizeMcpShutdownTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_MCP_SHUTDOWN_TIMEOUT_MS
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Invalid shutdown timeout')
  }
  return value
}

export function mcpBusyError(details: Record<string, number>): Error {
  return Object.assign(new Error('MCP work did not finish before the shutdown deadline'), {
    code: 'profile_busy',
    details
  })
}

export function observePromise<T>(work: Promise<T>): Promise<T> {
  void work.then(() => {}, () => {})
  return work
}

/**
 * Admission uses OwnedWorkBarrier. Raw SDK/teardown promises are retained
 * separately so a wrapper timeout cannot drop ownership, and close work can
 * still be registered after beginShutdown().
 */
export class McpOwnedWork {
  private readonly barrier = new OwnedWorkBarrier()
  private readonly retained = new Map<symbol, string>()
  private readonly idle = new Set<() => void>()

  get signal(): AbortSignal {
    return this.barrier.signal
  }

  get stopping(): boolean {
    return this.barrier.stopping
  }

  assertAccepting(): void {
    this.barrier.assertAccepting()
  }

  beginShutdown(): void {
    this.barrier.beginShutdown()
  }

  run<T>(label: string, work: () => T | Promise<T>): Promise<T> {
    return this.barrier.run(label, work)
  }

  retain<T>(label: string, work: Promise<T>): Promise<T> {
    const identity = Symbol(label)
    this.retained.set(identity, label)
    return work.finally(() => {
      this.retained.delete(identity)
      this.notifyIdle()
    })
  }

  /** Track settlement without requiring the caller to await the retained promise. */
  observe<T>(label: string, work: Promise<T>): Promise<T> {
    return observePromise(this.retain(label, work))
  }

  get count(): number {
    return this.barrier.count + this.retained.size
  }

  snapshot(): Record<string, number> {
    const result = this.barrier.snapshot()
    for (const label of this.retained.values()) {
      result[label] = (result[label] ?? 0) + 1
    }
    return result
  }

  waitForIdle(timeoutMs = DEFAULT_MCP_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    const budget = normalizeMcpShutdownTimeout(timeoutMs)
    if (this.count === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.idle.delete(onIdle)
        if (error) reject(error)
        else resolve()
      }
      const onIdle = (): void => {
        if (this.count === 0) finish()
      }
      const timer = setTimeout(() => finish(mcpBusyError(this.snapshot())), budget)
      this.idle.add(onIdle)
      void this.barrier.waitForIdle(budget).then(onIdle, onIdle)
      onIdle()
    })
  }

  private notifyIdle(): void {
    if (this.count !== 0) return
    for (const listener of [...this.idle]) listener()
  }
}

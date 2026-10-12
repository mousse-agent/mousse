import { RunStoreError } from './db/RunStoreError'

export const THREAD_MUTEX_TIMEOUT_MS = 30_000

interface Entry {
  waiters: Array<() => void>
}

/**
 * Per-key FIFO async mutex. Non-reentrant: acquiring a key you already hold waits for
 * yourself and fails with a timeout instead of deadlocking forever (SPEC §4).
 */
export class ThreadMutex {
  private readonly entries = new Map<string, Entry>()

  async withLock<T>(
    key: string,
    fn: () => Promise<T> | T,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    await this.acquire(key, opts?.timeoutMs ?? THREAD_MUTEX_TIMEOUT_MS)
    try {
      return await fn()
    } finally {
      this.release(key)
    }
  }

  /** True while some caller holds or waits for `key`. */
  isLocked(key: string): boolean {
    return this.entries.has(key)
  }

  private acquire(key: string, timeoutMs: number): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) {
      this.entries.set(key, { waiters: [] })
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const index = entry.waiters.indexOf(waiter)
        if (index !== -1) entry.waiters.splice(index, 1)
        reject(new RunStoreError('internal', 'thread mutex acquire timed out'))
      }, timeoutMs)
      entry.waiters.push(waiter)
    })
  }

  private release(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    // Hand ownership straight to the next waiter so no newcomer can overtake it.
    const next = entry.waiters.shift()
    if (next) next()
    else this.entries.delete(key)
  }
}

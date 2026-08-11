import type { ThreadActivitySnapshot, ThreadActivityState } from '../../shared/types'

export class ThreadActivityTracker {
  private activity = new Map<string, ThreadActivityState>()
  private busyThreadId: string | null = null

  getBusyThreadId(): string | null {
    return this.busyThreadId
  }

  setBusyThreadId(threadId: string | null): void {
    this.busyThreadId = threadId
  }

  getState(threadId: string): ThreadActivityState | undefined {
    return this.activity.get(threadId)
  }

  setState(threadId: string, state: ThreadActivityState): void {
    if (state === 'idle') {
      this.activity.delete(threadId)
    } else {
      this.activity.set(threadId, state)
    }
  }

  clear(threadId: string): void {
    this.activity.delete(threadId)
    if (this.busyThreadId === threadId) {
      this.busyThreadId = null
    }
  }

  /**
   * Reconcile a daemon-wide runtime snapshot without turning historical terminal
   * states into new unread notifications. A completion is only unread when this
   * process observed the thread transition from processing to completed.
   */
  reconcileSnapshot(snapshot: ThreadActivitySnapshot): void {
    const next = new Map<string, ThreadActivityState>()
    for (const [threadId, state] of Object.entries(snapshot)) {
      if (state === 'idle') continue
      const previous = this.activity.get(threadId)
      if (state === 'completed' && previous !== 'processing' && previous !== 'completed') {
        continue
      }
      next.set(threadId, state)
    }
    this.activity = next
  }

  getSnapshot(): ThreadActivitySnapshot {
    const snapshot: ThreadActivitySnapshot = {}
    for (const [threadId, state] of this.activity) {
      snapshot[threadId] = state
    }
    return snapshot
  }
}

export const threadActivityTracker = new ThreadActivityTracker()

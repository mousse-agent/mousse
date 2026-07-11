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

  getSnapshot(): ThreadActivitySnapshot {
    const snapshot: ThreadActivitySnapshot = {}
    for (const [threadId, state] of this.activity) {
      snapshot[threadId] = state
    }
    return snapshot
  }
}

export const threadActivityTracker = new ThreadActivityTracker()

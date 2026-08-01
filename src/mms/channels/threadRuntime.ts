/**
 * Feature-detection adapters for the forthcoming MMS per-thread runtime API.
 *
 * This branch ships before MMS owns durable per-thread queues. Call sites use
 * these helpers so merge integration stays localized: when MMS exposes queue /
 * control methods, prefer them; otherwise fall back to channel/CLI-local FIFO
 * serialization without introducing a second independent persisted queue.
 */

export interface ThreadQueueItem {
  id: string
  threadId: string
  content: string
  enqueuedAt: string
  intent?: 'normal' | 'steer'
}

/** Minimal surface expected from a future MMS thread-runtime module. */
export interface MmsThreadRuntime {
  isThreadTurnActive?(threadId: string): boolean
  abortThreadTurn?(threadId: string): boolean
  steerThreadTurn?(threadId: string, text: string): boolean
  /** When present, ordinary messages while busy should use this instead of a local queue. */
  enqueueThreadMessage?(
    threadId: string,
    content: string,
    opts?: { intent?: 'normal' | 'steer' }
  ): Promise<ThreadQueueItem | string | void> | ThreadQueueItem | string | void
  listThreadQueue?(threadId: string): ThreadQueueItem[] | undefined
  drainThreadQueue?(threadId: string): ThreadQueueItem[] | undefined
}

export interface ThreadTurnControls {
  isActive: (threadId: string) => boolean
  abort: (threadId: string) => boolean
  steer: (threadId: string, text: string) => boolean
  /** Prefer MMS-owned queue when available (no local persisted duplicate). */
  hasMmsQueue: boolean
  enqueue?: (
    threadId: string,
    content: string
  ) => Promise<ThreadQueueItem | string | void> | ThreadQueueItem | string | void
  listQueue?: (threadId: string) => ThreadQueueItem[] | undefined
}

type ControlHost = {
  isChannelTurnActive?: (threadId: string) => boolean
  abortChannelTurn?: (threadId: string) => boolean
  steerChannelTurn?: (threadId: string, text: string) => boolean
  isThreadTurnActive?: (threadId: string) => boolean
  abortThreadTurn?: (threadId: string) => boolean
  steerThreadTurn?: (threadId: string, text: string) => boolean
  enqueueThreadMessage?: MmsThreadRuntime['enqueueThreadMessage']
  listThreadQueue?: MmsThreadRuntime['listThreadQueue']
  threadRuntime?: MmsThreadRuntime
}

/**
 * Detect thread-scoped turn controls / queue on an orchestrator, runner, or
 * explicit `threadRuntime` bag. Safe against plain objects and partial shims.
 */
export function detectThreadRuntime(host: unknown): ThreadTurnControls {
  const h = (host ?? {}) as ControlHost
  const runtime = h.threadRuntime

  const isActive = (threadId: string): boolean => {
    if (runtime?.isThreadTurnActive?.(threadId)) return true
    if (h.isThreadTurnActive?.(threadId)) return true
    if (h.isChannelTurnActive?.(threadId)) return true
    return false
  }

  const abort = (threadId: string): boolean => {
    if (runtime?.abortThreadTurn?.(threadId)) return true
    if (h.abortThreadTurn?.(threadId)) return true
    if (h.abortChannelTurn?.(threadId)) return true
    return false
  }

  const steer = (threadId: string, text: string): boolean => {
    if (runtime?.steerThreadTurn?.(threadId, text)) return true
    if (h.steerThreadTurn?.(threadId, text)) return true
    if (h.steerChannelTurn?.(threadId, text)) return true
    return false
  }

  const enqueue =
    runtime?.enqueueThreadMessage?.bind(runtime) ??
    h.enqueueThreadMessage?.bind(h)
  const listQueue =
    runtime?.listThreadQueue?.bind(runtime) ?? h.listThreadQueue?.bind(h)

  return {
    isActive,
    abort,
    steer,
    hasMmsQueue: typeof enqueue === 'function',
    enqueue: enqueue
      ? (threadId, content) => enqueue(threadId, content, { intent: 'normal' })
      : undefined,
    listQueue: listQueue ? (threadId) => listQueue(threadId) : undefined
  }
}

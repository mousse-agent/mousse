import type { ChatMessage } from '../../shared/types'

/** Holds message updates of the selected thread and applies them once per frame. */
export interface MessageUpdateBatcher {
  /** Queues an update; a later update of the same message replaces it. */
  push(threadId: string, message: ChatMessage): void
  /** Applies what is queued now. Call before anything else changes the transcript. */
  flush(): void
  /** Drops what is queued (the thread or profile went away). */
  clear(): void
  /**
   * `handler`, applying held updates before it runs: for events that change how the transcript
   * reads, such as a turn ending, which must not show while its last text is still held.
   */
  flushBefore<A extends unknown[]>(handler: (...args: A) => void): (...args: A) => void
}

export interface MessageUpdateBatcherOptions {
  /** Applies one frame's updates, oldest first, for the thread they belong to. */
  apply(threadId: string, messages: ChatMessage[]): void
  /** True while updates of `threadId` still belong on screen. */
  isCurrent(threadId: string): boolean
  /** Runs `run` before the next frame. Defaults to `requestAnimationFrame`. */
  schedule?(run: () => void): () => void
}

/**
 * The longest an update waits when no frame comes, as in a hidden window, which gets no animation
 * frames: the store still follows the thread a few times a second.
 */
const FALLBACK_MS = 100

function nextFrame(run: () => void): () => void {
  let done = false
  const once = () => {
    if (done) return
    done = true
    cancelAnimationFrame(frame)
    clearTimeout(timer)
    run()
  }
  const frame = requestAnimationFrame(once)
  const timer = setTimeout(once, FALLBACK_MS)
  return () => {
    done = true
    cancelAnimationFrame(frame)
    clearTimeout(timer)
  }
}

/**
 * Streamed updates arrive many times a frame when the daemon sends a burst. Applying each one
 * re-renders the transcript each time; this applies the latest version of each message once per
 * frame instead, in one store write.
 */
export function createMessageUpdateBatcher(options: MessageUpdateBatcherOptions): MessageUpdateBatcher {
  const schedule = options.schedule ?? nextFrame
  let threadId: string | null = null
  const pending = new Map<string, ChatMessage>()
  let cancel: (() => void) | null = null

  const flush = () => {
    cancel?.()
    cancel = null
    if (threadId === null || pending.size === 0) return
    const target = threadId
    const messages = [...pending.values()]
    pending.clear()
    threadId = null
    if (options.isCurrent(target)) options.apply(target, messages)
  }

  return {
    push(target, message) {
      if (threadId !== null && threadId !== target) flush()
      threadId = target
      // Re-inserted so the batch keeps the order of the latest updates.
      pending.delete(message.id)
      pending.set(message.id, message)
      cancel ??= schedule(() => {
        cancel = null
        flush()
      })
    },
    flush,
    flushBefore(handler) {
      return (...args) => {
        flush()
        handler(...args)
      }
    },
    clear() {
      cancel?.()
      cancel = null
      pending.clear()
      threadId = null
    }
  }
}

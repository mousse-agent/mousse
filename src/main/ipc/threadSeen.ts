import type { ThreadActivitySnapshot } from '../../shared/types'

/**
 * Whether the thread a window shows looks Done in `activity`: it finished, or a subagent listed under it did (its
 * row shows theirs rolled up). `listedAs` names the row a thread is listed under (itself, or for a subagent its
 * nearest listed ancestor).
 */
export function showsDone(activity: ThreadActivitySnapshot, shownId: string, listedAs: (threadId: string) => string | undefined): boolean {
  for (const [threadId, state] of Object.entries(activity)) {
    if (state === 'completed' && (threadId === shownId || listedAs(threadId) === shownId)) return true
  }
  return false
}

/**
 * Tells the service that a window has seen a thread (`threads.markSeen`), which clears its Done in every window.
 * One call at a time per window and thread; a failure (an older service, a thread that went away) is ignored.
 */
export function seenReporter(send: (senderId: number, threadId: string) => Promise<unknown>): (senderId: number, threadId: string | null | undefined) => void {
  const inFlight = new Set<string>()
  return (senderId, threadId) => {
    if (!threadId) return
    const key = `${senderId}\u0000${threadId}`
    if (inFlight.has(key)) return
    inFlight.add(key)
    void Promise.resolve()
      .then(() => send(senderId, threadId))
      .catch(() => undefined)
      .finally(() => inFlight.delete(key))
  }
}

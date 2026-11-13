import type { ProtocolEvent } from '../../mms/protocol/types'
import { isTurnStoppable, type TurnState } from '../../shared/types'

/** How long into a turn its window still hears about it, as in the fault this reproduces (#1042). */
export const DEV_DROP_AFTER_MS = 1_000

/**
 * Development only: reproduces a window that stops hearing about a turn about a second into it, so the catch-up can be
 * seen working by hand. Main drops every update of a thread from one second after its turn started until another turn
 * starts. Turned on by `MOUSSE_DEV_DROP_TURN_END=1` in a development build (`!app.isPackaged`); an installed build
 * never reads it, and nothing in the app sets it.
 */
export function createDevTurnEndDropper(now: () => number = Date.now): (event: ProtocolEvent) => boolean {
  /** The turn being cut off, per thread, and when this window first heard of it. */
  const turns = new Map<string, { turnId: string | null; key: string; startedAt: number }>()
  return (event) => {
    const threadId = event.threadId
    // Every thread's activity at once would tell the window the turn ended.
    if (!threadId) return event.type === 'activity.snapshot' && turns.size > 0
    if (event.type === 'turn.state') {
      const raw = event.data as (TurnState & { state?: TurnState }) | null
      const state = raw?.state ?? raw
      if (state && isTurnStoppable(state)) {
        const key = `${state.turnId ?? ''}\u0000${state.startedAt ?? ''}`
        const held = turns.get(threadId)
        if (!held || (held.key !== key && held.turnId !== state.turnId)) {
          turns.set(threadId, { turnId: state.turnId ?? null, key, startedAt: now() })
          return false
        }
      }
    }
    const held = turns.get(threadId)
    return Boolean(held && now() - held.startedAt > DEV_DROP_AFTER_MS)
  }
}

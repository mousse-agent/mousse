import type { ProtocolEvent } from '../../mms/protocol/types'
import { isTurnStoppable, type TurnState } from '../../shared/types'

/** How long into a turn its window still hears about it, as in the fault this reproduces (#1042). */
export const DEV_DROP_AFTER_MS = 1_000

export interface DevTurnEndDropper {
  /** Whether main should drop this update instead of handing it to the window. */
  drop(event: ProtocolEvent): boolean
  /**
   * A turn is being cut off. Gaps in live events are then not answered either: the window should hear nothing at
   * all, as in the fault, so only the quiet-turn check can bring it back.
   */
  cutting(): boolean
}

/**
 * Development only: reproduces a window that stops hearing about a turn about a second into it, so the catch-up can be
 * seen working by hand. Main drops every update of a thread from one second after its turn started until another turn
 * starts. Turned on by `MOUSSE_DEV_DROP_TURN_END=1` in a development build (`!app.isPackaged`); an installed build
 * never reads it, and nothing in the app sets it.
 */
export function createDevTurnEndDropper(now: () => number = Date.now): DevTurnEndDropper {
  /** The turn being cut off, per thread, and when this window first heard of it. */
  const turns = new Map<string, { turnId: string | null; key: string; startedAt: number }>()
  const cutting = (): boolean => [...turns.values()].some((turn) => now() - turn.startedAt > DEV_DROP_AFTER_MS)
  return {
    cutting,
    drop(event) {
      const threadId = event.threadId
      // Every thread's activity at once would tell the window the turn ended.
      if (!threadId) return event.type === 'activity.snapshot' && cutting()
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
}

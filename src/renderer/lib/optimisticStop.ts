import { isTurnStoppable, type TurnState } from '../../shared/types'

/**
 * Stop shows the thread stopped at the click, before the daemon answers. The daemon's own turn state then confirms it
 * (its stopped, or any end of the turn), or takes over again when the Stop stopped nothing or the turn is still going
 * after `STOP_RECONCILE_MS`.
 */

/** How long a Stop's stopped state stands on its own while the daemon still reports the turn running. */
export const STOP_RECONCILE_MS = 10_000

/** A Stop that has not been confirmed yet: the turn it was for, and the daemon's latest state of the thread. */
export interface StopRequest {
  turnId: string | null
  daemon: TurnState
  /** Tells this request from a later Stop of the same thread. */
  requestedAt: number
}

/** The state shown at the click: the turn's own state, stopped. Undefined when there is nothing to stop. */
export function stoppedAtClick(current: TurnState | undefined, now = new Date()): TurnState | undefined {
  if (!current || !isTurnStoppable(current)) return undefined
  const { activeMessageId: _shownMessage, pause: _pause, ...rest } = current
  return { ...rest, phase: 'stopped', updatedAt: now.toISOString() }
}

/**
 * A daemon state for a thread with a pending Stop. While the daemon still reports the stopped turn running, the thread
 * keeps showing stopped and the request keeps the daemon's state; anything else (the turn ended, or a new turn
 * started) is shown and ends the request.
 */
export function applyDaemonTurnState(request: StopRequest, incoming: TurnState): { shown: TurnState | undefined; request: StopRequest | undefined } {
  const sameTurn = incoming.turnId === null || request.turnId === null || incoming.turnId === request.turnId
  if (sameTurn && isTurnStoppable(incoming)) return { shown: undefined, request: { ...request, daemon: incoming } }
  return { shown: incoming, request: undefined }
}

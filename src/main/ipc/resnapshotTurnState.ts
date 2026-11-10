import type { TurnState } from '../../shared/types'

/** What a thread snapshot says about the thread's turn (`thread.snapshot`). */
export interface SnapshotTurn {
  activeTurn?: { active?: boolean; running?: boolean }
  turnState?: TurnState | null
}

/**
 * The turn state a window gets again after a gap in its events: the daemon's own turn state (its phase) when the
 * snapshot has one. The older shape (`state: 'processing' | 'idle'`, no phase) is only a fallback: sent over a
 * turn that runs but has not streamed yet, it read as no turn at all, so the composer showed idle and its steer
 * key queued instead of steering.
 */
export function resnapshotTurnState(threadId: string, snap: SnapshotTurn): TurnState {
  if (snap.turnState && snap.turnState.threadId === threadId && 'phase' in snap.turnState && snap.turnState.phase) return snap.turnState
  const legacy = snap.activeTurn?.active ? { threadId, state: snap.activeTurn.running ? 'processing' : 'idle' } : { threadId, state: 'idle' }
  return legacy as unknown as TurnState
}

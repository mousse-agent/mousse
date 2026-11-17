import { isTurnStoppable, type TurnState } from '../../shared/types'

/**
 * The turn state a window gets for its open thread when it reads the thread again after missing events (a sequence
 * gap). The service's own state comes first. Without it (an older service, another computer's thread), the state the
 * window already has stays while it agrees with whether a turn is active, so the line under Working keeps its phase and
 * step; otherwise a running turn reads as thinking and anything else as idle. A turn counts as running when either
 * flag says so: at its start, before it streams, the service reports it running before it is active. Always a whole
 * `TurnState`: a state without a phase reads as no turn at all, so the transcript dropped Working while the turn ran,
 * the composer read idle, and its steer key queued the text instead of steering.
 */
export function resnapshotTurnState(
  threadId: string,
  snapshot: { turnState?: unknown; activeTurn?: { active?: boolean; running?: boolean } },
  current: TurnState | undefined,
  now = new Date()
): TurnState {
  const own = snapshot.turnState as TurnState | undefined
  if (own && typeof own === 'object' && own.threadId === threadId && typeof own.phase === 'string') return own
  const running = Boolean(snapshot.activeTurn?.running)
  const active = Boolean(snapshot.activeTurn?.active) || running
  if (current?.threadId === threadId && typeof current.phase === 'string' && isTurnStoppable(current) === active) return current
  return {
    threadId,
    turnId: active ? current?.turnId ?? null : null,
    phase: running ? 'thinking' : 'idle',
    updatedAt: now.toISOString()
  }
}

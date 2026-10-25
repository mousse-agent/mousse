import { isTurnActivePhase, type TurnStateSnapshot } from '../../shared/types'

/** Whether any turn went from running to finished between two snapshots. */
export function anyTurnEnded(previous: TurnStateSnapshot, next: TurnStateSnapshot): boolean {
  if (previous === next) return false
  return Object.values(previous).some((turn) => {
    const after = next[turn.threadId]
    return isTurnActivePhase(turn.phase) && after !== undefined && !isTurnActivePhase(after.phase)
  })
}

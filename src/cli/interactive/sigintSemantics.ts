/**
 * Pure helpers for interactive CLI Ctrl+C double-press semantics.
 * First press stops the active turn only; second within the window exits.
 */

export const DEFAULT_SIGINT_EXIT_WINDOW_MS = 1500

export type SigintAction = 'stop_turn' | 'exit'

export interface SigintState {
  lastSigintAt: number
}

export function createSigintState(): SigintState {
  return { lastSigintAt: 0 }
}

/**
 * Classify a Ctrl+C / SIGINT press.
 * - First press (or after the exit window): stop_turn
 * - Second press within windowMs: exit
 * Does not mutate any shutdown flag; callers apply the action.
 */
export function classifySigint(
  state: SigintState,
  now = Date.now(),
  windowMs = DEFAULT_SIGINT_EXIT_WINDOW_MS
): SigintAction {
  if (state.lastSigintAt > 0 && now - state.lastSigintAt < windowMs) {
    return 'exit'
  }
  state.lastSigintAt = now
  return 'stop_turn'
}

/** Reset the double-press window (e.g. after a successful stop or new turn). */
export function resetSigintWindow(state: SigintState): void {
  state.lastSigintAt = 0
}

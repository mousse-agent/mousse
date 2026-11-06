import type { BotError, BotState } from './chat'

/**
 * A bot's state from what `bots.db` holds (Bot Phase 1 §5.7). The order is fixed: paused, then
 * stuck (an error), then needs you (any open ask), then working (any queued or running
 * activation), then idle. Browser-safe.
 */
export function botState(input: { paused: boolean; error?: BotError; openAsks: number; liveActivations: number }): BotState {
  if (input.paused) return 'paused'
  if (input.error) return 'stuck'
  if (input.openAsks > 0) return 'needs_you'
  if (input.liveActivations > 0) return 'working'
  return 'idle'
}

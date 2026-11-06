import type { BotChip } from './chat'

/**
 * Activity chips (Bot Phase 1 §5.8, bot-ui C3). Mousse makes them from the calls the authority
 * allowed, never from model text: a live chip is worded as an attempt ("searching the web"), and the
 * calls of one dispatch roll up into settled chips when it ends ("searched the web · 3"). App tools,
 * whose results pass through Mousse, may give outcome chips ("every weekday · 09:00"). Browser-safe.
 */

/** Where a call happened, for highlights: the bot's files folder and the owner's home (`~`). */
export interface BotChipContext {
  filesFolder?: string
  home?: string
}

/** One allowed call of a dispatch, in the order it was made. */
export interface BotChipCall {
  /** Neutral built-in name (`read`, `edit` …) or app-tool name (`web_search`, `schedule_add` …). */
  tool: string
  input: unknown
  /** An app tool's result, when it returned (outcome chips). */
  result?: unknown
}

/**
 * The live chip for a call the authority just allowed, or null when the call shows none
 * (`escalate`: its card is the chip).
 * TODO(WP3): the wording table in §5.8.
 */
export function chipForCall(_tool: string, _input: unknown, _ctx: BotChipContext = {}): BotChip | null {
  return null
}

/**
 * The settled chips of one dispatch: grouped by kind, with counts and a short highlight (a domain,
 * a folder name, a schedule label), in first-seen order.
 * TODO(WP3): the roll-up in §5.8.
 */
export function rollUpChips(_calls: readonly BotChipCall[], _ctx: BotChipContext = {}): BotChip[] {
  return []
}

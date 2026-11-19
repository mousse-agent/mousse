import type { BotTurnUsageRow } from '../store/BotStore'

/**
 * How long a bot's chat conversation may grow before it folds (docs/plans/bot-context.md §14). With chat epochs on, the
 * bot's home chat is one resumed runtime conversation per epoch: its first turn starts from a cleared context with the
 * base pack, every later turn appends a small delta and the owner's message, and the epoch ends (the next turn starts a
 * new one from the journal) when one of the rules in `chatEpochEnd` says so. The sizes come from what the runtime
 * reported (`bot_turn_usage`), never from a character count, when it reported anything.
 */

/** Starting values, in tokens (design: "Size before a fold"); the measurements of phase 0 are there to replace them. */
export const BOT_CHAT_EPOCH_MARKS = Object.freeze({
  /** The conversation (what the epoch's turns appended after its first one) folds at this size. */
  high: 48_000,
  /** A turn after the cache expired folds from this size: the rebuild costs nothing extra then (the cold fold). */
  mid: 24_000,
  /** The recent chat a new epoch's base carries verbatim; older rows are in the chat summary. */
  tail: 6_000,
  /**
   * Past the high mark the epoch waits for its digest (the model-written summary of the fold, prepared in the
   * background) up to this size; here it folds anyway, with the deterministic summary (the chat never waits).
   */
  hard: 64_000
})

/** Never more than this share of the model's window: the rest is room for tools, results and the reply. */
export const BOT_CHAT_WINDOW_SHARE = 0.4
/** Never past this share of the owner's compaction point: Mousse folds before the runtime compacts. */
export const BOT_CHAT_COMPACTION_SHARE = 0.9
/** The cache lifetime assumed when the runtime reported none: the providers' short default. */
export const BOT_CHAT_SHORT_CACHE_MS = 5 * 60_000

export interface BotContextBudget {
  high: number
  mid: number
  tail: number
  hard: number
  /** The largest whole prompt (system text, tools and conversation) an epoch may reach; Infinity when unknown. */
  cap: number
  /** How long the runtime keeps the conversation's cache. */
  cacheTtlMs: number
}

/**
 * The budget of a bot chat's epoch, from the model's window, the owner's compaction point (`settingCompactionPoint`) and
 * the cache lifetime the runtime reported (an hour where it keeps it that long, `promptCacheHourOn`).
 */
export function contextBudget(input: { contextWindow?: number | null; compactAt?: number; cacheTtlMs?: number | null }): BotContextBudget {
  const window = input.contextWindow && input.contextWindow > 0 ? input.contextWindow * BOT_CHAT_WINDOW_SHARE : Infinity
  const compaction = input.compactAt && input.compactAt > 0 ? input.compactAt * BOT_CHAT_COMPACTION_SHARE : Infinity
  return {
    high: BOT_CHAT_EPOCH_MARKS.high,
    mid: BOT_CHAT_EPOCH_MARKS.mid,
    tail: BOT_CHAT_EPOCH_MARKS.tail,
    hard: BOT_CHAT_EPOCH_MARKS.hard,
    cap: Math.floor(Math.min(window, compaction)),
    cacheTtlMs: input.cacheTtlMs && input.cacheTtlMs > 0 ? input.cacheTtlMs : BOT_CHAT_SHORT_CACHE_MS
  }
}

/** A bot chat's epoch as `bots.db` keeps it (`bot_memory_state`, key `chat_epoch`). */
export interface BotChatEpoch {
  /** Kept as each of its turns' `context_gen` in `bot_turn_usage`. */
  id: string
  startedAt: string
  instanceId: string
  model: string
  /** The journal rows up to here reached the conversation (in the base, a delta or a turn of the epoch). */
  deliveredSeq: number
  /** The chat activations whose turns ran in the epoch: their own rows are in the conversation. Newest last, bounded. */
  ran: string[]
  /** Which saved entries written outside the chat the conversation holds (ids and versions). */
  outsideMemory: string
  /** Estimated tokens of what the epoch's turns added, for a runtime that reports no sizes. */
  addedTokens: number
  /** When the newest job (the ledger, `bot_jobs`) the conversation holds last changed: later turns list only jobs changed after it. */
  jobsAt?: string
  /** The change counter of the open items (`items_rev`) the conversation holds: later turns list only items changed after it, outside it. */
  itemsRev?: number
  /** Why it ended, once it did: the next turn starts a new epoch. */
  ended?: BotChatEpochEnd
}

/**
 * Why a new epoch starts: none yet, an earlier one ended (`failed`, `stopped`, `reload`, `cleared`, `compacted`, or
 * `resume_lost`: the runtime ran a turn in a new conversation instead of the epoch's), the model changed, the conversation
 * is full (`full`), or the cache expired with the conversation past the mid mark (`cold`).
 */
export type BotChatEpochEnd = 'none' | 'failed' | 'stopped' | 'reload' | 'cleared' | 'compacted' | 'resume_lost' | 'model' | 'full' | 'cold'

/**
 * The digest of the next fold: `ready` (prepared, and what it summarised is still the start of the chat), `coming` (one
 * is being written or can be asked for now), or `none` (no model call can write one now: the fold is deterministic).
 */
export type BotChatDigestState = 'ready' | 'coming' | 'none'

/**
 * Whether the epoch goes on: undefined (it does), why it ends, or `due`: the conversation is past the high mark and its
 * digest is coming, so it goes on until the digest is ready or the hard mark.
 */
export type BotChatEpochVerdict = BotChatEpochEnd | 'due' | undefined

/**
 * Whether the bot chat's epoch goes on for the next turn: undefined, or why it ends. `turns` are the epoch's turns as
 * `bot_turn_usage` holds them, oldest first. The conversation's size is what the last turn's last request sent past what
 * the first turn's did (system text, tools, base and first message are the same for every turn of the epoch); with no
 * report, the estimate the pack kept. Past the high mark a coming digest keeps the epoch going (`due`) up to the hard
 * mark or the cap; a ready one, or none possible, folds it.
 */
export function chatEpochEnd(input: {
  epoch: BotChatEpoch | undefined
  selection: { instanceId: string; model: string }
  turns: readonly BotTurnUsageRow[]
  now: number
  budget: (last: BotTurnUsageRow | undefined) => BotContextBudget
  /** Absent: `none`, so the epoch folds at the high mark. */
  digest?: BotChatDigestState
}): BotChatEpochVerdict {
  const { epoch } = input
  if (!epoch) return 'none'
  if (epoch.ended) return epoch.ended
  if (epoch.instanceId !== input.selection.instanceId || epoch.model !== input.selection.model) return 'model'
  // A runtime that compacted rewrote the conversation the epoch holds: the next turn starts again from the journal.
  if (input.turns.some((turn) => turn.compactions > 0)) return 'compacted'
  const measured = input.turns.filter((turn) => typeof turn.lastPrompt === 'number')
  const first = measured[0]
  const last = measured[measured.length - 1]
  const budget = input.budget(last)
  const size = first && last ? Math.max(0, last.lastPrompt! - first.lastPrompt!) : epoch.addedTokens
  const capped = (last?.lastPrompt ?? 0) >= budget.cap
  if (size >= budget.high || capped) return input.digest === 'coming' && size < budget.hard && !capped ? 'due' : 'full'
  const lastAt = Math.max(0, ...input.turns.map((turn) => turn.lastRequestAt ?? 0))
  if (lastAt > 0 && input.now - lastAt > budget.cacheTtlMs && size >= budget.mid) return 'cold'
  return undefined
}

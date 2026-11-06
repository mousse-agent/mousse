/**
 * Bot memory and context (docs/plans/bot-context.md): the journal's kinds, memory entries, the
 * five `memory_*` tools' shapes, and the caps and budgets as constants. Browser-safe. WP0 created
 * it; WP6 owns it from here on.
 */

/** The bot's memory tools: always on, never grantable (bot-context.md §7). */
export const BOT_MEMORY_TOOLS = ['memory_search', 'memory_read', 'memory_list', 'memory_save', 'memory_forget'] as const
export type BotMemoryTool = (typeof BOT_MEMORY_TOOLS)[number]

/** Kinds of `bot_journal` rows (bot-context.md §3). */
export const BOT_JOURNAL_KINDS = [
  'owner_msg', 'bot_msg', 'run_start', 'run_report', 'run_end', 'tool_call', 'tool_result',
  'ask', 'answer', 'memory_op', 'model_change', 'redaction', 'notice'
] as const
export type BotJournalKind = (typeof BOT_JOURNAL_KINDS)[number]

/** Who a journal row is from. */
export type BotJournalWho = 'owner' | 'bot' | 'tool' | 'mousse'

/** `owner`: facts about the owner; `note`: standing notes; `run_note`: written by unattended runs, framed as data. */
export type BotMemoryKind = 'owner' | 'note' | 'run_note'
/** Where a memory version was written; `dream` is Phase 2 consolidation. */
export type BotMemoryWrittenIn = 'chat' | 'run' | 'owner_ui' | 'dream'
export type BotMemoryStatus = 'active' | 'superseded' | 'expired' | 'forgotten'

/** Core memory per kind, in estimated tokens. A save over its cap fails with the current list. */
export const BOT_MEMORY_CAPS: Readonly<Record<BotMemoryKind, number>> = { owner: 600, note: 1_400, run_note: 500 }
/** Core memory (owner + notes) injected into every chat turn. */
export const BOT_CORE_MEMORY_TOKENS = 2_000
/** Longest text of one `memory_save`. */
export const MAX_BOT_MEMORY_TEXT_CHARS = 400
/** A tool row keeps at most this much text, head and tail. Owner and bot messages are never cut. */
export const MAX_BOT_JOURNAL_TOOL_TEXT_BYTES = 16 * 1024

/** The chat pack's blocks, in order from stable to volatile, in estimated tokens (bot-context.md §5.1). */
export const BOT_CHAT_PACK_BUDGET = {
  protocol: 300,
  core: BOT_CORE_MEMORY_TOKENS,
  runNotes: 500,
  summary: 1_000,
  window: 8_000,
  situation: 250
} as const
/** The whole chat pack stays within about this many tokens. */
export const BOT_CHAT_PACK_TOKENS = 12_000
/** When the verbatim window passes `BOT_CHAT_PACK_BUDGET.window`, its oldest rows fold into the summary down to this. */
export const BOT_CHAT_WINDOW_KEEP_TOKENS = 4_000

/** The run brief's blocks (bot-context.md §5.2): about 6.5k tokens. */
export const BOT_RUN_PACK_BUDGET = {
  protocol: 300,
  core: BOT_CORE_MEMORY_TOKENS,
  runNotes: 500,
  summaryHead: 600,
  reports: 1_200,
  ownerMessages: 1_500,
  situation: 250
} as const
/** Reports of the same schedule a run brief carries. */
export const BOT_RUN_PACK_REPORTS = 3
/** Owner messages since the schedule last ran that a run brief carries, newest first. */
export const BOT_RUN_PACK_OWNER_MESSAGES = 8

/** `memory_search`: hits by default and at most. */
export const BOT_MEMORY_SEARCH_LIMIT = 8
export const MAX_BOT_MEMORY_SEARCH_LIMIT = 20
/** `memory_read`: rows before or after a hit at most, and the most one page carries (tokens). */
export const MAX_BOT_MEMORY_READ_AROUND = 20
export const BOT_MEMORY_READ_PAGE_TOKENS = 8_000

/** One memory entry as `memory_list` and `bots.memory.list` return it. */
export interface BotMemoryEntry {
  /** Short id the bot sees: `m12`. */
  id: string
  version: number
  /** How the bot names this version (`memoryRef`): `m12`, or `m12v2` from the second version on. */
  ref: string
  kind: BotMemoryKind
  /** Null once forgotten. */
  text: string | null
  /** When it became true (`valid_from`, else when it was learned), and when it stops being true. */
  since: string
  until?: string
  learnedAt: string
  by: 'you said' | 'a run' | 'cleanup'
  status: BotMemoryStatus
}

/** `memory_list` / `bots.memory.list`: the entries and the fill gauge ("core 1,240/2,000"). */
export interface BotMemoryListing {
  entries: BotMemoryEntry[]
  gauge: string
}

/** One `memory_search` hit. `ref` is `j<seq>` for a journal row, `m<id>` for a memory entry. */
export interface BotMemoryHit {
  ref: string
  at: string
  ago: string
  kind: string
  who: string
  snippet: string
}

export type BotMemorySearchKind = 'chat' | 'run' | 'tool' | 'memory'

export interface BotMemorySearchInput {
  /** Empty: browse the latest by date. */
  query?: string
  kinds?: BotMemorySearchKind[]
  since?: string
  until?: string
  limit?: number
}

/** One row `memory_read` returns; a redacted row shows its tombstone text. */
export interface BotMemoryRow {
  ref: string
  at: string
  kind: string
  who: string
  text: string
}

export type BotMemoryReadInput = { ref: string; before?: number; after?: number } | { activationId: string; cursor?: string }

export interface BotMemorySaveInput {
  /** At most `MAX_BOT_MEMORY_TEXT_CHARS`, absolute dates only. */
  text: string
  kind: 'owner' | 'note'
  /** The current id of the entry this replaces; an older version gets `stale`. */
  replaces?: string
  validFrom?: string
  expiresAt?: string
}

/** `ref` is how the bot names that version next (`memoryRef`). */
export type BotMemorySaveResult =
  | { id: string; version: number; ref: string; gauge: string }
  | { error: 'over_cap'; gauge: string; core: Array<{ id: string; ref: string; text: string }> }
  | { error: 'refused'; reason: string }
  | { error: 'stale'; current: { id: string; version: number; ref: string; text: string } }

export interface BotMemoryForgetInput {
  id?: string
  refs?: string[]
  reason: string
}

/** What a forget removed: the entry, and the journal rows it redacted. */
export interface BotMemoryForgetResult {
  forgotten?: string
  redacted: string[]
}

/** Local search quality notes (bot-context.md §6), kept in `bot_memory_state.search_stats`. */
export interface BotMemorySearchStats {
  searches: number
  zeroHits: number
  /** Turns with three or more searches and no `memory_read`. */
  readlessTurns: number
  /** The latest zero-hit queries, newest last (at most 20). */
  recentMisses: Array<{ at: string; query: string }>
}

/** Estimated tokens of a text: four characters a token, as the context gauge estimates. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

/** The fill gauge the bot sees: "core 1,240/2,000". */
export function memoryGauge(label: string, used: number, cap: number): string {
  return `${label} ${used.toLocaleString('en-US')}/${cap.toLocaleString('en-US')}`
}

/**
 * The ref the bot names a memory version by: `m12` for the first version, `m12v3` for the third.
 * `replaces` must name the current version, or the save returns `stale`.
 */
export function memoryRef(id: string, version: number): string {
  return version > 1 ? `${id}v${version}` : id
}

/** Reads `m12` / `m12v3` back; undefined when it is not a memory ref. */
export function parseMemoryRef(ref: string): { id: string; version?: number } | undefined {
  const match = /^(m\d{1,9})(?:v(\d{1,9}))?$/.exec(ref.trim())
  if (!match) return undefined
  return match[2] ? { id: match[1]!, version: Number(match[2]) } : { id: match[1]! }
}

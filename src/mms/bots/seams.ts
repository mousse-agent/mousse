import type { BotChip } from '../../shared/bots/personal/chat'
import type { BotLane, BotModelChoice, BotSchedule } from '../../shared/bots/personal/definition'
import type { BotJournalKind, BotJournalWho, BotMemoryForgetResult, BotMemoryListing } from '../../shared/bots/personal/memory'
import type { Enforceability, ProviderSelection, RunPolicy } from '../../shared/harness/types'
import type { BotStoreTx } from './store/BotStore'

/**
 * The seams between Bot Phase 1's work packages (docs/plans/bot-architecture.md §7.1). `BotEngine`
 * is WP2's alone; the runtime (WP1), the tools and model choice (WP3) and memory (WP6) reach it
 * only through these interfaces, and each package exports a factory that `MmsProfileServices`
 * wires. Interfaces only.
 */

export type { BotStoreTx } from './store/BotStore'

/** Process control of bot dispatches, outside the daemon's event loop. WP1 implements; WP2's engine calls. */
export interface BotProcessSupervision {
  /** Records a dispatch and its deadline before its runtime starts. */
  arm(d: { dispatchId: string; activationId: string; deadlineAt: number }): void
  /** The runtime reported its process: writes `child_pid`/`child_group` and starts the supervisor. */
  attach(dispatchId: string, proc: { pid: number; pgid: number }): void
  /** Resolves when the dispatch's process group is gone, and writes `exit_at`. */
  settled(dispatchId: string): Promise<{ exitAt: string } | { stillAlive: true }>
  /** At startup: kills the recorded groups of unfinished dispatches and folds supervisor journals in. */
  reconcile(): Promise<Array<{ dispatchId: string; exitAt?: string }>>
}

/** Why no model could be chosen. Never shown as such: it becomes a `BotError` in plain words. */
export type BotModelProblem = 'no_provider' | 'named_unavailable' | 'all_limited'

/** The hidden model choice (§5.6). WP3 implements; WP2's engine calls at the first dispatch of each activation. */
export interface BotModelResolver {
  resolve(input: { botId: string; choice: BotModelChoice; override?: BotModelChoice; policy: RunPolicy }):
    Promise<{ selection: ProviderSelection } | { problem: BotModelProblem; until?: string; instanceId?: string }>
  /** A bot turn on `instanceId` hit its usage limit; skip it until `until`. */
  markLimited(instanceId: string, until: string): void
}

/**
 * Whether an instance's runtime can hold a bot's policy: `checkPolicy` with the bot's compiled
 * policy and the driver's bot authority. WP1 adds it to the gateway; WP3's candidates call it.
 */
export interface BotRuntimeHold {
  canHoldBot(instanceId: string, policy: RunPolicy, model?: string): Enforceability
}

/** The engine's side of the bot app tools. WP2 implements; WP3's and WP6's app tools call. */
export interface BotToolHost {
  /** The bot activation a thread's turn belongs to. Lane and bot always come from here, never from tool arguments. */
  activationOf(threadId: string): { botId: string; activationId: string; lane: BotLane } | undefined
  schedules: {
    add(botId: string, s: { when: BotSchedule['when']; prompt: string }): { scheduleId: string; label: string }
    remove(botId: string, scheduleId: string): boolean
    list(botId: string): Array<{ scheduleId: string; label: string; nextAt?: string }>
  }
  setProfile(botId: string, p: { name?: string; description?: string }): void
  /** `now`: this activation only, by a reload; `always`: the definition's `main.model`, with no re-approval. */
  setModel(botId: string, activationId: string, scope: 'now' | 'always', choice: Partial<BotModelChoice>): void
}

/** Where a call happened, for the activity sink. */
export interface BotActivityContext {
  botId: string
  activationId: string
  dispatchId: string
}

/** Activity chips (§5.8). WP3 implements; WP2's engine wires it into the authority and drains it at settle. */
export interface BotActivitySink {
  /** Every call the authority allowed: a live chip, emitted as `bots.activity` at most 4 a second. */
  onAllowed(ctx: BotActivityContext, call: { tool: string; input: unknown }): void
  /** An app tool returned: its outcome chip, if it has one. */
  onAppResult(ctx: BotActivityContext, tool: string, result: unknown): void
  /** The dispatch settled: its rolled-up chips for the message row, and the list is cleared. */
  drain(dispatchId: string): BotChip[]
}

/** How a dispatch ended, for capture. */
export type BotDispatchEnd = 'settled' | 'wall' | 'reload' | 'stopped' | 'failed'

/**
 * The context packs (bot-context.md §5). WP6 implements; WP2's engine calls. Each pack is built once
 * per activation and frozen: later dispatches of the same activation get the same text.
 */
export interface BotContextProvider {
  /** The chat pack, placed in `turnPreamble` right after `clearConversationContext(homeThreadId)`. */
  chatPreamble(input: { botId: string; activationId: string }): Promise<string>
  /** The run brief. `scheduleId` absent: a manual run. */
  runPreamble(input: { botId: string; activationId: string; scheduleId?: string; input: string }): Promise<string>
  /**
   * After every dispatch, including one ended by a wall or a reload. It runs capture for the dispatch's
   * thread and moves the chat window and summary. If it throws `bot_journal_failed`, the engine fails
   * the activation and sets the stuck error "I can't save my work. Free some disk space."
   */
  afterDispatch(e: { botId: string; activationId: string; dispatchId: string; lane: BotLane; threadId: string; endedBy: BotDispatchEnd }): Promise<void>
}

/** One journal row to write. `kind` follows bot-context.md §3. */
export interface BotJournalInput {
  botId: string
  kind: BotJournalKind
  lane?: BotLane
  activationId?: string
  threadId?: string
  /** Idempotence key, unique per bot: `bm:<bot_messages.id>`, `<threadId>:<messageId>`, `act:<id>:start` … */
  sourceKey: string
  who: BotJournalWho
  /** The content came from outside (a web page, tool output). */
  external?: boolean
  text: string
  json?: unknown
}

/** The bot journal. WP6 implements; WP2 calls. It is the only writer of `bot_journal`. */
export interface BotJournal {
  /** Writes a journal row inside the caller's `bots.db` transaction (for `bot_messages` rows and engine events). */
  appendInTx(tx: BotStoreTx, row: BotJournalInput): void
  /** Copies new assistant and tool rows of one bot thread (crash-safe through cursors; idempotent). */
  syncThread(input: { botId: string; threadId: string; lane: BotLane; activationId: string }): Promise<void>
  /** At daemon start, for every bot thread, before `BotScheduler` starts or any activation is admitted. */
  catchUp(): Promise<void>
}

/** Owner-side memory operations. WP6 implements; the `bots.memory.*` handlers and the engine's purge call it. */
export interface BotMemoryAdmin {
  list(botId: string, history?: boolean): BotMemoryListing
  forget(botId: string, id: string): BotMemoryForgetResult
  export(botId: string, dir: string): Promise<{ files: string[] }>
  reindex(botId?: string): Promise<void>
  /** Removes every memory row of the bot, and nothing of another bot (the 30-day purge). */
  purge(botId: string): Promise<void>
}

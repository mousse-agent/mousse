import type { BotChip } from '../../shared/bots/personal/chat'
import type { BotDepth, BotLane, BotModelPick, BotSchedule, BotWorkLevel } from '../../shared/bots/personal/definition'
import type { BotModelRows, BotPickMiss } from '../../shared/bots/personal/modelSlots'
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

/**
 * Why no model could be chosen. Never shown as such: it becomes a `BotError` in plain words. `pick_unavailable`: a model
 * the owner picked on an entry can't run there (#673), and nothing else is tried; `all_limited` also covers a pick at
 * its usage limit.
 */
export type BotModelProblem = 'no_provider' | 'named_unavailable' | 'all_limited' | 'pick_unavailable'

/** A pick that can't run (#673), and why: the chat says so once, to the owner only (`modelSlots.ts`). */
export type { BotPickMiss, BotPickReason } from '../../shared/bots/personal/modelSlots'

export type BotModelResolution =
  | { selection: ProviderSelection }
  | { problem: BotModelProblem; until?: string; instanceId?: string; missed?: BotPickMiss }

/** The model choice (§5.6, #673). WP3 implements; WP2's engine calls at the first dispatch of each activation. */
export interface BotModelResolver {
  /**
   * A turn's model. A pick on an entry runs there, at its reasoning level, or not at all: at its usage limit
   * `all_limited` with the reset, otherwise `pick_unavailable` with `missed`. A pick by name from an older bot, and a row
   * on which Mousse chooses (null), resolve as before picks: by name across entries, else by usage at `depth`.
   */
  resolve(input: { botId: string; pick: BotModelPick | null; depth: BotDepth; policy: RunPolicy }): Promise<BotModelResolution>
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
  /**
   * The bot activation a thread's turn belongs to. Lane and bot always come from here, never from
   * tool arguments; `role` is the calling thread's (a consult calls from a `context` thread).
   */
  activationOf(threadId: string): { botId: string; activationId: string; lane: BotLane; role?: 'home' | 'activation' | 'context' } | undefined
  schedules: {
    add(botId: string, s: { when: BotSchedule['when']; prompt: string }): { scheduleId: string; label: string }
    remove(botId: string, scheduleId: string): boolean
    list(botId: string): Array<{ scheduleId: string; label: string; nextAt?: string }>
  }
  setProfile(botId: string, p: { name?: string; description?: string }): void
  /**
   * `set_depth` and `use_model` (#673). `now`: this activation only, by a reload; `always`: saved as a revision with no
   * re-approval. A depth is the activation's level (`now`) or the bot's standing level (`always`); a pick is one of the
   * Runs on choices, on this chat (`now`) or on `rows` (`always`). The answer says whether a depth changed what runs:
   * a depth moves work between its rows, and changes nothing on a pick that keeps its model and reasoning level.
   */
  setModel(botId: string, activationId: string, scope: 'now' | 'always', change: BotModelChange): { changed: boolean }
  /** The owner's own words in a chat activation: its owner messages, oldest first (`use_model` checks them). */
  ownerWords(botId: string, activationId: string): string
  /**
   * The chat's work (docs/plans/bot-always-free.md): runs beside the chat that report back. `from` is the chat
   * activation that hands it off; `key` makes a repeated call start nothing new; `level` is how hard the job is (#673).
   */
  work: {
    start(botId: string, from: string, input: { title: string; brief: string; key: string; level?: BotWorkLevel }): Promise<BotWorkStarted>
    list(botId: string): BotWorkList
    stop(botId: string, workId: string): Promise<'stopped' | 'ended' | 'not_found'>
    /** `from`: the chat activation that passes it on (its owner's message is the note's source). */
    note(botId: string, workId: string, note: string, from?: string): 'noted' | 'held' | 'ended' | 'not_found'
  }
  /** One-off reminders: said at a time, or work started then. */
  reminders: {
    add(botId: string, from: string, input: { dueAt: string; text: string; work?: { title: string; brief: string } }): { reminderId: string; dueAt: string }
    list(botId: string): Array<{ reminderId: string; dueAt: string; text: string; work?: string }>
    cancel(botId: string, reminderId: string): boolean
  }
}

/** What `set_depth` (a depth) or `use_model` (a pick among the Runs on choices, and with `always` the rows it goes on) changes. */
export type BotModelChange = { depth: BotDepth } | { pick: BotModelPick & { instanceId: string }; rows?: BotModelRows }

/** `work_start`'s answer: the work's id, and whether it runs now or waits behind others (their titles). */
export interface BotWorkStarted {
  workId: string
  status: 'started' | 'queued' | 'ended'
  ahead: string[]
}

/** `work_list`'s answer: what runs or waits now, and the last few that ended. */
export interface BotWorkList {
  now: Array<{ workId: string; title: string; status: 'running' | 'queued' | 'waiting_for_internet' | 'paused'; startedAt: string; doing?: string; kind: 'work' | 'schedule' }>
  recent: Array<{ workId: string; title: string; status: 'done' | 'failed' | 'stopped'; endedAt: string; report?: string }>
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
 * The context packs (bot-context.md §5). WP6 implements; WP2's engine calls at each main dispatch.
 * Each pack is built once per activation and frozen: later dispatches of the same activation get the
 * same text, until a memory save or forget drops the frozen packs.
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
  /**
   * At daemon start, for every bot thread, before `BotScheduler` starts or any activation is
   * admitted. `failedBots`: bots whose journal could not be written (the engine marks them stuck).
   */
  catchUp(): Promise<void | { failedBots: string[] }>
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

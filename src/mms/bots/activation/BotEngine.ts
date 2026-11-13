import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { askText } from '../../../shared/bots/personal/askText'
import { lookFields } from '../../../shared/bots/personal/look'
import type { BotAuthority, BotCheck, BotCheckDenied, BotMcpTool, BotThreadRole, BotThreads, NormalisedCall, WallReason } from '../../../shared/bots/personal/authority'
import type { BotChatMessage, BotChip, BotError } from '../../../shared/bots/personal/chat'
import type { PermissionMode } from '../../../shared/permissionMode'
import {
  BOT_ASK_DENY_COOLDOWN_MS,
  MAX_BOT_WALLS,
  askProblem,
  filesAsk,
  filesAskOf,
  isSpecialAsk,
  mcpAskTools,
  permissionText,
  withPermission,
  type BotAskRequest,
  type BotBudgetWallKey,
  type BotEscalationAnswer,
  type BotEscalationSummary,
  type BotMcpAsk,
  type BotPermissionRequest,
  type BotWallKind,
  grantRequestOf
} from '../../../shared/bots/personal/escalation'
import { findServer, installationOf, mcpAskFor, type BotMcpHost, type BotMcpServer } from '../mcp/BotMcp'
import { BOT_APP_TOOLS, BOT_BROWSER_PERMISSION, BOT_THREADS_PERMISSION, BOT_WORK_ONLY_TOOLS, botGrantTool, isAbsolutePath, manifestProblem } from '../../../shared/bots/personal/manifest'
import { checkMessage, wallMessage } from '../../../shared/bots/personal/walls'
import type { ChargeResult, CountKind, CounterScope } from '../../../shared/harness/counters'
import type { ReserveResult, SpendLimits, SpendRequest, SpendScope } from '../../../shared/harness/spend'
import { isNeutralTool } from '../../../shared/harness/tools'
import {
  ACTIVE_TIME_CHUNK_MS,
  BOT_DELETE_PURGE_MS,
  DEFAULT_BOT_ACTIVE_MS,
  OLD_DEFAULT_BOT_ACTIVE_MS,
  BOT_DEPTHS,
  BOT_MODEL_SLOT_KEYS,
  ENDED_ACTIVATION_STATUSES,
  MAX_BOT_SCHEDULES,
  MAX_QUEUED_ACTIVATIONS,
  type BotAcknowledgement,
  type BotActivationSummary,
  type BotActivationTrigger,
  type BotOwnerTurn,
  type BotDefinition,
  type BotLane,
  type BotManifest,
  type BotModelOverride,
  type BotDepth,
  type BotModelPick,
  type BotModelSlotKey,
  type BotModelSlots,
  type BotWorkLevel,
  type BotPermissionLine,
  type BotSchedule,
  type BotSummaryV1 as BotSummary,
  type BotThreadCheck,
  type BotThreadSpec
} from '../../../shared/bots/personal/definition'
import { addedPermissions, intersectManifest, manifestSubset, narrowManifest } from '../../../shared/bots/personal/manifest'
import { BOT_COMPUTER_OPEN, BOT_COMPUTER_SHUT, notOnThisComputerText, switchedOff, whatToAskText, withinComputerLimit, type BotComputerLimit } from '../../../shared/bots/personal/computerLimit'
import { allPinned, copyPick, isPinned, limitFamilyOf, limitOnPick, pickProblemText, rowName, samePick, samePickTarget, sameStoredPick, slotsOf, slotsWith, startDepthOf, stuckRowsOf, turnModelOf, UNPICKED_SLOTS, withSlots, type BotPickMiss, type BotStuckEntry, type BotTurnModel } from '../../../shared/bots/personal/modelSlots'
import type { BotModelOption } from '../../../shared/bots/personal/methods'
import type { LlmProviderOption } from '../../../shared/settings'
import { botAllowedOf, type BotAllowed } from '../instructions'
import { isProviderTurnCap, type Enforceability, type HarnessError, type ProviderSelection, type RunPolicy } from '../../../shared/harness/types'
import type { NeutralTool } from '../../../shared/harness/tools'
import type { RunEngine } from '../../run/RunEngine'
import { TERMINAL_RUN_STATUSES, type BotTurnPayload, type RunRecord } from '../../run/types'
import { createBotAuthority } from '../authority/botAuthority'
import { BotChatService, messageInput } from '../chat/BotChatService'
import { askFingerprintOf, BotChatProjection, clockTime, starterManifest } from '../chat/projection'
import { BotDefinitionError, upgradeDefinitionV1, type BotDefinitionEntry, type BotDefinitionStore } from '../definitions/BotDefinitionStore'
import { chipCallOf } from '../activity/BotActivitySink'
import { botFilesFolder, botManifestDigest, compileBotThread } from '../grants/compile'
import { BOT_RUN_REPORT_LINE } from '../memory/contextPack'
import type { BotActivityContext, BotActivitySink, BotContextProvider, BotDispatchEnd, BotJournal, BotJournalInput, BotMcpListing, BotMemoryAdmin, BotModelChange, BotModelProblem, BotModelResolution, BotModelResolver, BotProcessSupervision, BotToolHost, BotWorkList, BotWorkStarted } from '../seams'
import { workWaits, type BotActivationRow, type BotDispatchRow, type BotEntryLimit, type BotEscalationRow, type BotMessageRow, type BotModelState, type BotReminderRow, type BotStore, type BotStoredError } from '../store/BotStore'
import { BotCounterScope, BotSpendScope, type ActivationLimits } from '../store/scopes'
import { isConnectionFailure, type BotConnectivity } from './connectivity'
import { BotScheduleError, type BotScheduleBook, type BotScheduleEntry } from '../../scheduled/botJobs'
import { tellMeNotifies } from '../../../shared/automations'
import { BOT_COMPACTION_HOLD_MS, BotReloadAbort, BotRoomAbort, BotWallAbort, type BotBrowserHost, type BotTurnDispatcher, type BotTurnSteer, type PreparedBotTurn } from './dispatcher'

/**
 * The personal bot engine (PR 6 §4, unit 6c-1): one-time approval with the subset rule, manual
 * activations, and one dispatch per activation. A dispatch is written to `bots.db` first, then its
 * run, receipt and `turn.start` in one run-DB transaction (`sendWithStart`), with an inert payload.
 * The `turn.start` executor asks `prepare` for everything the turn runs with and `settle` once
 * the run ended; `settle` is the only writer of a dispatch's outcome.
 *
 * 6c-2 adds walls and escalation (a wall ends the dispatch and asks the owner), continuation
 * dispatches after an answer, a restart or the owner's Continue, all held behind the unknown-call
 * gate across the main run and every consult; consults of context threads, one at a time per
 * thread; the three-phase startup pass; and the trash and profile hooks.
 */

export class BotEngineError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'BotEngineError'
  }
}

export interface BotEngineHost {
  profileHome: string
  store: BotStore
  definitions: BotDefinitionStore
  threads: {
    ensureExecutionThread(executionKey: string, name: string, projectId?: string, ownership?: { parentTaskId: string }): { id: string }
    /** Whether a thread is in use, in the trash, or gone; absent: always `active`. */
    threadState?(threadId: string): 'active' | 'trashed' | 'missing'
  }
  /** Deletes a thread for good (a deleted bot's home thread; its owned threads go with it). */
  trashThread?(threadId: string): Promise<unknown>
  /** How long stopping a bot's runs may take before a trash or delete gives up (default 15 s). */
  quiesceTimeoutMs?: number
  /** The profile's run engine (null while it is not running). */
  runs(): RunEngine | null
  harness: {
    checkPolicy(instanceId: string, policy: RunPolicy, model?: string): Enforceability
    /** Reads the instance's policy facts again (`HarnessGateway.refreshPolicyFacts`). */
    refreshPolicyFacts?(instanceId: string): Promise<void>
    nativeToolNames(instanceId: string, tools: readonly NeutralTool[]): { ok: true; names: string[] } | { ok: false; error: HarnessError & { code: 'policy_unenforceable' } }
    /** The granted tools a bot turn on the instance would not be offered now (`HarnessGateway.botWithheldTools`). */
    botWithheldTools?(instanceId: string): readonly NeutralTool[]
  }
  /** Wakes the effect worker after a `turn.start` was written. */
  notifyEffects(): void
  /** Stops what runs on a thread (a running dispatch). */
  stopThread?(threadId: string): Promise<unknown> | void
  /** `bots.changed`. */
  changed?(event: { botId?: string; activationId?: string }): void
  /** A bot's schedules may have changed (it was resumed): the scheduler ticks now. */
  schedulesChanged?(): void
  /**
   * The bots' schedules, in the shared scheduled-job store (`BotScheduleBook`): automations whose Who is the bot. The
   * one scheduler claims each occurrence and hands it to `runScheduledOccurrence`. Absent: no bot has schedules here.
   */
  schedules?: Pick<BotScheduleBook, 'list' | 'get' | 'add' | 'remove' | 'removeAll' | 'labelOf'> & Partial<Pick<BotScheduleBook, 'skipped'>>
  /** Wall-clock milliseconds, for the times `bots.db` records (default: `Date.now`). */
  clock?(): number
  /** Monotonic milliseconds, for measured active time (default: `performance.now`). */
  monotonic?(): number
  setTimer?(fn: () => void, ms: number): { clear(): void }

  // -- Bot Phase 1 seams (docs/plans/bot-architecture.md §7.1); each is optional so a package can land alone.

  /** The hidden model (WP3). Absent: no provider can run a bot. */
  models?: BotModelResolver
  /** Process control outside the daemon loop (WP1). */
  supervision?: BotProcessSupervision
  /** Activity chips (WP3): fed from every allowed call, drained into the dispatch's message. */
  activity?: BotActivitySink
  /** The context packs and capture after each dispatch (WP6). */
  context?: BotContextProvider
  /** The journal (WP6): a row with every chat row and engine event, and the startup catch-up. */
  journal?: BotJournal
  /** Owner-side memory (WP6): the 30-day purge removes a deleted bot's memory through it. */
  memory?: BotMemoryAdmin
  /**
   * `OrchestratorService.clearConversationContext`: each chat activation's first dispatch starts
   * from a cleared home context (the transcript stays).
   */
  clearContext?(threadId: string): void
  /** Archives a thread (#681): a deleted bot's threads, kept 30 days before the purge. */
  archiveThread?(threadId: string): Promise<unknown> | void
  /** One model call on a selection (`harness.oneShot`): naming a new bot. */
  oneShot?(input: { selection: ProviderSelection; prompt: string; signal: AbortSignal }): Promise<string>
  /**
   * The bot's system text (WP3's `botInstructions`): who it is, its files folder, the base
   * instructions and what its owner allows now (`allowed`). Built at each dispatch, never stored, so
   * a rename or a changed permission applies at the next turn.
   */
  instructions?(bot: { name: string; description: string; filesFolder: string; lane?: BotLane; allowed?: BotAllowed; browserOffline?: boolean }): string
  /** A schedule in plain words ("every weekday · 09:00"; WP3's `describeSchedule`). */
  scheduleLabel?(when: BotSchedule['when']): string
  /** The provider family of an instance in plain words ("Claude"), never a model. */
  providerLabel?(instanceId: string): string
  /** The models the owner may pick by hand in About and on the create row (#673): each entry's models, with their reasoning levels. */
  modelOptions?(): Promise<BotModelOption[]>
  /** The app's model listing (`harness.llmProviders`), which Runs on narrows to `modelOptions` for the model picker. */
  modelListing?(): Promise<LlmProviderOption[]>
  /** This computer's name, the one computer a bot runs on for now. */
  computerName?(): string
  /** The person's other computers (About lists them; a bot runs on the computer that holds it). */
  otherComputers?(): Array<{ node: string; name: string; online: boolean }>
  /**
   * Whether the skill or MCP tool an ask names exists here: a run never asks the owner for one that
   * does not (the card would show the bot's own words). Absent: every name is taken as it is.
   */
  knownAsk?(permission: { skill: string } | { mcp: { serverId: string; tool?: string } }): boolean
  /**
   * The owner's MCP servers a bot may hold tools of (`BotMcp`): set up for the whole profile in Mousse. Absent: no bot
   * is offered an MCP tool, and an ask for one is refused with no card.
   */
  mcp?: BotMcpHost
  /**
   * The bot's own browser (`BotBrowsers`): a turn whose grant holds "use the browser" gets its
   * browser tools on it, and an ended activation's tabs close. Absent: no bot gets the browser.
   */
  browser?: BotBrowserHost
  /**
   * What this computer lets bots do (Settings → Agents → What bots may do here, `settings.bots.here`): a ceiling over
   * every bot's grant, read when each dispatch is prepared and on every call. Absent: everything.
   */
  computerLimit?(): BotComputerLimit
  /**
   * "Use your threads" no longer holds for this bot (Remove in About; the computer's switch is the service's to watch):
   * the messages it sent that have not started yet are withdrawn from the owner's threads. Must not throw.
   */
  threadsWithdrawn?(bot: { botId: string; homeThreadId: string; name: string }): void
  /**
   * Whether the internet is there for the bot's provider (`createBotConnectivity`): checked before
   * a dispatch is sent, while one makes no progress, and while an activation waits for it. Absent:
   * always online, never checked.
   */
  connectivity?: BotConnectivity
}

export type { BotAcknowledgement, BotSummaryV1 as BotSummary, BotThreadCheck } from '../../../shared/bots/personal/definition'

/** What a run-lane call is refused with when its permission waits for the owner (§5.4): a card for it is in the chat. */
export const BOT_ASK_REFUSED_TEXT = 'The owner has not allowed this yet. You asked them; carry on without it and say in your report what you skipped.'
/**
 * What a run's call or `escalate` is answered with for 24 hours after the owner said Not now to the permission: no new
 * card is made, and the bot is never told it asked.
 */
export const BOT_ASK_NOT_NOW_TEXT = 'The owner said not now to this. Carry on without it, don\'t ask for it again today, and say in your report what you skipped.'
/** What a run's call or `escalate` is refused with once its asks reached their cap: no new ask is written. */
export const BOT_ASK_ENOUGH_TEXT = 'You have asked the owner enough for now. Carry on without it and say in your report what you skipped.'
/** What `escalate` for a folder answers a bot that may already use files on this computer. */
export const BOT_FILES_HELD_TEXT = 'You can already use files anywhere on this computer, except Mousse\'s own data. Go ahead without asking.'
/** What an ask in a new bot's first message is answered with: nothing has been asked of it yet. */
export const BOT_ASK_NOT_YET_TEXT = "Don't ask for permissions yet: the owner hasn't asked for anything that needs one. Your files folder, memory and the web already work. Ask when they want something that needs more."

/** What a chat turn's ask for something its work already holds is answered with (commands, the web, the browser). */
export const BOT_WORK_HAS_TEXT = 'Your work already has this; the chat does not use it. Hand the job to work_start and tell the owner you are on it.'
/**
 * What a run's call or `escalate` is answered with when the owner allowed the permission after its turn started: the
 * turn keeps the permissions it started with, and the work continues with the new one once the turn ends.
 */
export const BOT_ASK_HELD_NEXT_TEXT = 'The owner already allowed this; you get it as soon as this turn ends. Do not ask again. Finish what you can without it and end your turn: you then continue in this thread with it.'
/** The same for a chat turn, for a permission the chat uses itself (file access, a skill, a Mousse tool). */
export const BOT_ASK_HELD_CHAT_TEXT = 'The owner already allowed this; you get it as soon as this reply ends. Do not ask again: finish your reply without it, and you then continue in this chat with it.'
/** The same for a consult: the bot's next turn has it, the consult does not. */
export const BOT_ASK_HELD_CONSULT_TEXT = 'The owner already allowed this, but this consult can\'t use it. Do not ask again: answer with what you have and say what needs it.'
/** What a call or `escalate` is answered with when the grant holds the permission but this turn can't use it. */
export const BOT_ASK_HELD_UNAVAILABLE_TEXT = 'The owner already allowed this, but it can\'t be used on this turn. Do not ask again. Carry on without it and say in your report what you skipped.'

/** What an ask for an MCP tool is answered with where Mousse has no MCP servers to offer (no MCP manager): no card. */
export const BOT_MCP_UNAVAILABLE_TEXT = 'Your owner has no MCP servers set up in Mousse here, so there is nothing to ask for. Carry on without it, and tell the owner plainly if that matters.'

/** What a run's ask for a skill or MCP tool that is not here is refused with. */
export const BOT_ASK_UNKNOWN_TEXT = 'There is no such skill or tool here. Carry on without it.'
/** What Allow on an MCP ask whose server has not listed its tools yet answers (the card's Allow is off meanwhile). */
const MCP_ASK_LOADING_TEXT = 'Its tools are still loading: Allow turns on once they are listed.'

/** An MCP ask that lists no tools: its server has not answered, and Allow would grant nothing the owner has seen. */
function waitsForTools(permission: BotAskRequest): boolean {
  return 'mcp' in permission && mcpAskTools(permission.mcp).length === 0
}
/** New asks one run may write; later ones are refused without asking. */
export const MAX_RUN_ASKS = 5
/** New asks a bot's runs may write in a day. */
export const MAX_BOT_ASKS_PER_DAY = 10
/** What `escalate` returns in a chat turn: the cards show together under the turn's message. */
export const BOT_ASK_DEFERRED_TEXT = 'Asked; the owner will answer after this message. Finish your message now.'
/** The stuck error after the journal could not be written (bot-context.md §4). */
export const BOT_JOURNAL_ERROR: BotError = { text: 'I can\'t save my work. Free some disk space.', action: { kind: 'retry', label: 'Try again' } }
/** Failed runs in a row that pause a bot's schedules. */
export const BOT_FAILURE_PAUSE_STREAK = 3

/** Work and reminders (docs/plans/bot-always-free.md). */
const MAX_WORK_TITLE_CHARS = 80
const MAX_WORK_NOTE_CHARS = 4_000
const MAX_REMINDER_TEXT_CHARS = 2_000
/** Most reminders one bot keeps waiting. */
export const MAX_WAITING_REMINDERS = 50
const MAX_REMINDER_AHEAD_MS = 366 * 24 * 60 * 60_000
/** The longest the reminder timer waits before it looks again (a far timer would overflow, and clocks move). */
const REMINDER_REARM_MS = 6 * 60 * 60_000
/** The outcome chips of `work_start` (`chips.ts`): a chat turn that shows one handed work off. */
const WORK_STARTED_CHIPS: ReadonlySet<string> = new Set(['started', 'will start'])

/** How long a reminder that failed to be said waits before it is tried again. */
const REMINDER_RETRY_MS = 60_000
/** A reminder said later than this (Mousse was off) says what time it was for. */
const REMINDER_LATE_MS = 2 * 60_000
/** How long a dispatch's reply waits for the executor's final message before it is posted without it. */
const REPLY_WAIT_MS = 5_000
/** Retries on another model after usage limits, per activation. */
const MAX_USAGE_RETRIES = 2
/** The end reason and stuck-error code of a picked model that can't run (#673). */
const PICK_UNAVAILABLE = 'bot_pick_unavailable'
/** The line with the first run of an automation saved with a model by name, on a bot whose rows are all picked (#673). */
export const OLD_MODEL_NAME_IGNORED = 'This automation had a model of its own saved by an earlier version of Mousse. It now runs on my Work model; change that in About → Runs on.'
/**
 * How long a usage pause lasts when the provider gave no reset time: the bot tries again then (work a usage limit
 * stopped goes on, schedules run), and pauses again for as long if the limit still holds.
 */
export const USAGE_RECHECK_MS = 30 * 60_000
/** Work that waited longer than this for more room is not carried on by an Allow: it ends, and can be asked again. */
export const MAX_ROOM_WAIT_MS = 24 * 60 * 60_000
/** Work that waits to go on (for room or a usage limit) ends after this long, whatever it waits for (`maintain`). */
export const MAX_WORK_WAIT_MS = 7 * 24 * 60 * 60_000
/**
 * Continuations after a dispatch reached its runtime's cap on model turns, in total per activation (not in a row: a
 * note or an Allow in between does not start the count again). Each one worked up to the cap (300 turns on Claude
 * Code), so with the activation's own work time this only bounds a runtime that keeps reaching the cap.
 */
export const MAX_TURN_CAP_CONTINUATIONS = 10
/** How often deleted bots are swept for the 30-day purge. */
const SWEEP_EVERY_MS = 24 * 60 * 60_000
/** The chat's one notice while an activation waits for the internet. */
export const BOT_OFFLINE_TEXT = 'Waiting for internet. I\'ll carry on when it\'s back.'
/** How long a dispatch may go without a call before Mousse checks whether the internet is there. */
export const BOT_OFFLINE_STALL_MS = 60_000
/**
 * How often a live dispatch is looked at: it is still working (its time so far is recorded, `checkpoint_at`), and, when
 * it made no call for a while, whether the internet is there.
 */
export const BOT_OFFLINE_WATCH_MS = 20_000
/** Failed checks in a row, one watch apart, that end a dispatch to wait for the internet. */
const OFFLINE_CHECKS_TO_STOP = 2
/** The first wait before a waiting activation checks the internet again; it doubles up to the maximum. */
export const BOT_OFFLINE_POLL_MS = 15_000
export const BOT_OFFLINE_POLL_MAX_MS = 60_000
/** How often a live dispatch's last working moment is written to `bots.db` at most (`checkpoint_at`). */
export const BOT_CHECKPOINT_EVERY_MS = 1_000

/** What an answer to a limit ask did to the work that waited on it (`settleRoomInTx`). */
interface RoomSettled {
  ended: BotActivationRow[]
  continued: string[]
}

interface LiveDispatch {
  controller: AbortController
  timer: { clear(): void } | undefined
  /** When the dispatch started, on the monotonic clock: what settlement measures from. */
  startedMono: number
  /** When it started, on the wall clock (`bot_dispatches.started_at`): its recorded working moments are measured from it. */
  startedAt: number
  /** The last working moment written to `bots.db` (`checkpoint_at`), on the monotonic clock. */
  checkpointMono: number
  /** The main dispatch's number; its consults attach to it. */
  n: number
  /** Wall-clock deadline of the main dispatch, which its consults share. */
  deadline: number
  /** The main dispatch's authority scopes, which its consults share. */
  counters: CounterScope
  spend: SpendScope | null
  /** The main dispatch's id (`bot_dispatches.client_request_id`, `<activationId>:d<n>`): supervision's and the activity chips'. */
  dispatchId: string
  /** The last call of the dispatch (or its consults), on the monotonic clock: what "no progress" is measured from. */
  lastProgressMono: number
  /**
   * The last moment the dispatch is known to have been working, on the monotonic clock: a call checked or finished, or
   * a look (`watchOffline`) that found it running with the internet there. A dispatch Mousse stops is charged up to it.
   */
  workedMono: number
  /** Failed internet checks in a row while the dispatch made no progress. */
  offlineChecks: number
  /** The watch for no progress (only with `connectivity`). */
  watch?: { clear(): void }
  /** Set when the dispatch was ended to wait for the internet: only the time it worked is charged. */
  offline?: { chargeMs: number }
  /** The orchestrator wired the dispatch's steer into its runtime (`BotTurnSteer.attached`): notes reach it while it runs. */
  steerable?: boolean
  /** What the turn took (`BotTurnSteer.take`) and has not read yet, by token: the notes, and the compaction it re-gives for. */
  steering: Map<string, { ids: number[]; regiveFor?: number }>
  steerSeq: number
  /** Compactions of the turn's context the runtime reported, and the last one whose pack and brief the model read. */
  compactions: number
  regiven: number
  /** The runtime is compacting the turn's context since then (`BotTurnSteer.compacting`): a note waits for it, at most `BOT_COMPACTION_HOLD_MS`. */
  compactingSince?: number
}

/** An activation that runs or waits for its owner's answer holds a slot of its lane: what does not fit waits. */
const ACTIVE_HOLDING = ['running', 'waiting_grant'] as const
/**
 * Run-lane activations of one bot that run side by side (its work and scheduled runs). The chat lane runs one at a
 * time. Work beyond this waits in the bot's queue.
 */
export const MAX_RUN_SLOTS_PER_BOT = 3
/** Run-lane activations of every bot of a profile that run at once; what does not fit waits in its bot's queue. */
export const MAX_RUN_SLOTS_PER_PROFILE = 6
/** Of a bot's run slots, scheduled runs and a reminder's work hold at most this many: one is kept for the owner's work. */
export const MAX_BACKGROUND_SLOTS_PER_BOT = 2
/** Of the profile's run slots, scheduled runs and reminders' work hold at most this many. */
export const MAX_BACKGROUND_SLOTS_PER_PROFILE = 4
const NOT_ENDED = ['queued', 'running', 'waiting_grant', 'paused', 'blocked'] as const

/** Gate refusals that become a wall: the owner can answer them. */
const ESCALATABLE: ReadonlySet<WallReason['kind']> = new Set(['tool', 'path', 'skill', 'mcp'])

export class BotEngine implements BotTurnDispatcher, BotThreads {
  private readonly live = new Map<string, LiveDispatch>()
  /** Per context thread, the consult that runs or waits there last: consults there run one at a time. */
  private readonly lanes = new Map<string, Promise<void>>()
  /** Consults waiting for their run's final message, by `<activationId>:<n>`. */
  private readonly consultWaiters = new Map<string, { resolve(text: string): void }>()
  /** Consult dispatches whose executor took them: the executor's settle carries the final message. */
  private readonly executing = new Set<string>()
  private readonly expiryTimers = new Map<string, { clear(): void }>()
  /** Each waiting activation's next internet check. */
  private readonly offlineTimers = new Map<string, { clear(): void }>()
  /**
   * Work a usage limit stopped while the bot was under its owner's own pause (no usage pause to end): when it may try
   * again. Not kept across a restart, where it tries once at the start (`usageResumable`).
   */
  private readonly usageWaits = new Map<string, { botId: string; at: number }>()
  /**
   * The limit work that ran out of room waits on, from `budgetEnd` until it stops waiting: what `waitingOn` reads before
   * the work's notice (with the ask's card) is posted. After a restart that notice, or its own ask, says it.
   */
  private readonly roomKeys = new Map<string, BotBudgetWallKey>()
  /** The runs of live dispatches (main and consult) by run id, with their activation: a finished call is their progress. */
  private readonly liveRuns = new Map<string, string>()
  /**
   * What dispatches that reached their runtime's turn cap did, per activation, until its next message carries it: their
   * chips, and their last words for a message that has none of its own (`continueAfterTurnCap`). Kept in memory.
   */
  private readonly carried = new Map<string, { chips: BotChip[]; text?: string }>()
  /**
   * `changed` with `{botId?, activationId?}` after every change (`bots.changed`), `message` with
   * `{botId, message}` for every new or changed chat row (`bots.message`), `activity` with
   * `{botId, activationId, chip}` for the live chip (`bots.activity`), and `escalation` with a
   * `BotEscalationSummary` when a wall asks the owner (the v1 form's event; no longer bridged).
   */
  readonly events = new EventEmitter()

  /**
   * The bot threads this process knows of, kept beside `bots.db`: when a read of it fails, a
   * known bot thread stays read-only and every other thread is left alone.
   */
  private readonly known = new Map<string, { botId: string; role: 'home' | BotThreadRole }>()
  /** The startup pass has run: only then may a schedule's occurrence insert an activation (PR 6 §6). */
  private startupPassed = false
  /** The chat rows and the Bot UI's summaries (Bot Phase 1 §5.1.1). */
  readonly chat: BotChatProjection
  /** The Bot UI's methods (`bots.*` v2). */
  readonly service: BotChatService
  /** Each activation's context pack as its latest main dispatch read it (frozen by the provider, bot-context.md §5). */
  private readonly packs = new Map<string, string>()
  /**
   * Notes a live turn took and the runtime never reported read nor handed back, by activation: the model may have read
   * them before the turn ended (a Stop, a crash, a result that came first), so the continuation that carries them says
   * they may be repeats. Delivery is at least once, usually once.
   */
  private readonly offeredNotes = new Map<string, Set<number>>()
  /** Replies whose final message the executor still delivers, by `<activationId>:<n>`. */
  private readonly pendingReplies = new Map<string, { post(text?: string): void; timer: { clear(): void } }>()
  /** The live chip of each working activation (`bots.chat.list`'s `live`). */
  private readonly liveChips = new Map<string, { botId: string; chip: BotChip | null }>()
  /** The one timer for the soonest reminder of any bot (`armReminders`). */
  private reminderTimer: { clear(): void } | undefined
  private delivering: Promise<void> | undefined
  /** Until when a reminder that failed to be said is not tried again (`REMINDER_RETRY_MS`), so a failure never spins. */
  private readonly reminderRetryAt = new Map<string, number>()
  private closed = false
  /** Final messages the executor delivered while the dispatch's end was still being recorded, by `<activationId>:<n>`. */
  private readonly lateTexts = new Map<string, string>()
  /** The owner's message that answered a wall while its turn was still ending: the continuation's input. */
  private readonly ownerTexts = new Map<string, string>()
  /**
   * Per run activation, the permissions its turns were refused (by fingerprint). When the owner allows one before the
   * turn ends, the work continues in its thread with it (`advance`). Kept in memory: after a restart the continuation
   * runs under the current grant anyway.
   */
  private readonly refusedAsks = new Map<string, Map<string, BotAskRequest>>()
  /** Activations whose main dispatch settled and whose `advance` has not run yet (capture is copying it). */
  private readonly settling = new Set<string>()
  /**
   * Bot threads whose capture ran when their run ended, perhaps before the thread's last write (a
   * failed turn is saved after its run ends): copied again by the executor's settle, else at the next tick.
   */
  private readonly needsSync = new Map<string, { botId: string; threadId: string; lane: BotLane; activationId: string }>()
  /** The 30-day sweep that is running, so a tick and the daily timer never purge at once. */
  private sweeping: Promise<string[]> | undefined
  /** The rolled-up chips of each settled main dispatch, until its message is posted. */
  private readonly drained = new Map<string, BotChip[]>()
  private lastSweep = 0
  /** The owner's MCP servers this engine follows while an ask waits for a server's tools (`watchMcp`). */
  private mcpWatch?: { mcp: BotMcpHost; stop: () => void }
  /** What this computer let bots do at the last settings save (`computerLimitChanged`), as JSON. */
  private lastLimit: string | undefined

  constructor(private readonly host: BotEngineHost) {
    this.chat = new BotChatProjection({
      store: host.store,
      ...(host.journal ? { journal: host.journal } : {}),
      // The bot's name rides along: a notification for a new bot's first row comes before any list names it. A run
      // report its schedule's Tell me keeps quiet says so (`quiet`): it is in the chat, without a notification.
      emit: (event) => this.events.emit('message', { ...event, ...this.nameFor(event.botId), ...(this.quietReport(event.botId, event.message) ? { quiet: true } : {}) }),
      schedules: (botId) => this.listSchedules(botId),
      // About marks a permission this computer has switched off.
      computerLimit: () => this.limit(),
      // Where each granted MCP server stands now, for About (on, switched off, changed, gone, or MCP off). Before the
      // servers were read since Mousse started, nothing is known: they are read in the background, and About names what
      // it can.
      mcpWhere: (serverId) => {
        if (!host.mcp) return { state: 'gone' }
        if (host.mcp.listed?.() === false) {
          void host.mcp.warm()
          return undefined
        }
        if (host.mcp.where) return host.mcp.where(serverId)
        const live = host.mcp.servers().find((server) => server.serverId === serverId || server.installationId === serverId)
        return live ? { state: 'on', server: live } : { state: 'gone' }
      }
    })
    this.service = new BotChatService(this, {
      store: host.store,
      ...(host.memory ? { memory: host.memory } : {}),
      now: () => this.now(),
      ...(host.modelOptions ? { modelOptions: host.modelOptions } : {}),
      ...(host.modelListing ? { modelListing: host.modelListing } : {}),
      ...(host.computerName ? { computerName: host.computerName } : {}),
      ...(host.otherComputers ? { otherComputers: host.otherComputers } : {})
    })
    try {
      for (const row of host.store.all('SELECT thread_id, bot_id, role FROM bot_threads'))
        this.known.set(row.thread_id as string, { botId: row.bot_id as string, role: row.role as 'home' | BotThreadRole })
    } catch (error) {
      console.warn('bot threads could not be read', { error: error instanceof Error ? error.message : String(error) })
    }
    this.lastLimit = JSON.stringify(this.limit())
  }

  /**
   * Whether a run report stays out of notifications: its schedule's Tell me is Only problems, and a report is a run
   * that ended done. Every run, Only news and a failure's error row notify as before.
   */
  private quietReport(botId: string, message: { kind?: string; activationId?: string } | undefined): boolean {
    if (message?.kind !== 'run_report' || !message.activationId) return false
    try {
      const row = this.store.activation(message.activationId)
      if (row?.trigger.kind !== 'schedule') return false
      const entry = this.host.schedules?.get(botId, row.trigger.scheduleId)
      return entry ? !tellMeNotifies(entry.tellMe, 'done') : false
    } catch {
      return false
    }
  }

  private putThread(input: { threadId: string; botId: string; role: 'home' | BotThreadRole; key: string; activationId?: string }): void {
    this.store.putThread(input)
    this.known.set(input.threadId, { botId: input.botId, role: input.role })
  }

  private get store(): BotStore {
    return this.host.store
  }

  private now(): number {
    return this.host.clock?.() ?? Date.now()
  }

  private monotonic(): number {
    return this.host.monotonic?.() ?? performance.now()
  }

  private changed(event: { botId?: string; activationId?: string }): void {
    try {
      this.host.changed?.(event)
      this.events.emit('changed', event)
    } catch {
      // A listener never undoes a committed change.
    }
  }

  /**
   * What this computer lets bots do now (Settings → What bots may do here), read where a grant becomes what a turn
   * runs with and on every call. A setting that can't be read gives nothing: the ceiling fails closed.
   */
  private limit(): BotComputerLimit {
    if (!this.host.computerLimit) return BOT_COMPUTER_OPEN
    try {
      return this.host.computerLimit()
    } catch (error) {
      console.warn('what bots may do here could not be read; bots get none of it meanwhile', { error: error instanceof Error ? error.message : String(error) })
      return BOT_COMPUTER_SHUT
    }
  }

  /**
   * The settings were saved: when what bots may do here changed since the last save, every bot's About is read again
   * (it marks what is off here). What turns run with needs nothing: it is read at every dispatch and call.
   */
  computerLimitChanged(): void {
    const now = JSON.stringify(this.limit())
    const before = this.lastLimit
    this.lastLimit = now
    if (before === now) return
    for (const botId of this.host.definitions.ids()) if (!this.store.registry(botId)?.deletedAt) this.changed({ botId })
  }

  // -- Definitions ------------------------------------------------------------------------------

  list(): BotSummary[] {
    return this.host.definitions.ids().filter((id) => !this.store.registry(id)?.deletedAt).map((id) => this.summary(this.host.definitions.get(id)!))
  }

  get(botId: string): BotDefinitionEntry & { summary: BotSummary } {
    const entry = this.entry(botId)
    return { ...entry, summary: this.summary(entry) }
  }

  save(definition: BotDefinition, expectedDraftHash?: string): BotDefinitionEntry {
    if (this.store.registry(definition.id)?.deletedAt) throw new BotEngineError('bot_deleted', 'This bot was deleted.')
    const saved = this.host.definitions.save(definition, expectedDraftHash)
    this.store.ensureRegistry(definition.id)
    this.changed({ botId: definition.id })
    return saved
  }

  publish(botId: string, expectedDraftHash: string): BotDefinition {
    this.entry(botId)
    const revision = this.definitionCall(() => this.host.definitions.publish(botId, expectedDraftHash))
    this.store.ensureRegistry(botId)
    this.store.setPublished(botId, revision.revision!)
    this.changed({ botId })
    return revision
  }

  private definitionCall<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      if (error instanceof BotDefinitionError) throw new BotEngineError(error.code, error.message)
      throw error
    }
  }

  /**
   * A new revision of a bot with the same manifest (rename, look, description, model): published
   * and pointed at, with the draft kept equal to it. No approval: the grant still covers it.
   */
  publishProfile(botId: string, change: (definition: BotDefinition) => BotDefinition): BotDefinition {
    const entry = this.entry(botId)
    const base = entry.published ?? entry.draft
    const next = change({ ...base })
    if (JSON.stringify(next.permissions) !== JSON.stringify(base.permissions)) throw new BotEngineError('bot_invalid', 'A profile change cannot change permissions.')
    const revision = this.definitionCall(() => this.host.definitions.publishRevision(next))
    this.store.setPublished(botId, revision.revision!)
    try {
      this.host.definitions.save(revision, entry.draftHash)
    } catch (error) {
      console.warn('the bot draft was left as it was', { botId, error: error instanceof Error ? error.message : String(error) })
    }
    this.changed({ botId })
    return revision
  }

  /**
   * Deletes a bot (Bot Phase 1 §5.3.3): at once its activations end, its asks are withdrawn, its
   * grant is revoked and it leaves every list; its threads are archived (#681). Its chat, memory,
   * threads, schedules and files are kept 30 days, then `sweepDeleted` purges them.
   */
  async remove(botId: string): Promise<{ purgeAt: string }> {
    this.entry(botId)
    const live = this.store.db.transaction(() => {
      const running = this.store.activationsIn(botId, [...NOT_ENDED])
      for (const activation of running) {
        this.store.moveActivation(activation.id, [activation.status], 'cancelled', { endReason: 'bot_deleted' })
        this.store.closeEscalations(activation.id, 'cancelled')
      }
      this.store.withdrawAsks(botId)
      this.store.revoke(botId)
      this.store.markDeleted(botId)
      // A deleted bot says nothing more: its reminders are cancelled with it.
      this.store.cancelReminders(botId)
      return running
    })
    // Its runs end before its threads are archived; the stop is bounded, a hung provider stop included.
    const quiet = await this.stopAndWait(live)
    // Scratch folders go only once nothing runs in them (the startup pass removes the rest).
    if (quiet) for (const activation of live) this.cleanup({ ...activation, status: 'cancelled' })
    for (const row of live) this.packs.delete(row.id)
    // Its browser closes now; its sign-ins go with the purge.
    try {
      await this.host.browser?.removeBot?.(botId, false)
    } catch (error) {
      console.warn('a deleted bot\'s browser could not be closed', { botId, error: error instanceof Error ? error.message : String(error) })
    }
    await this.archiveThreads(botId)
    this.changed({ botId })
    const deletedAt = this.store.registry(botId)?.deletedAt ?? this.store.now()
    return { purgeAt: new Date(Date.parse(deletedAt) + BOT_DELETE_PURGE_MS).toISOString() }
  }

  /** A deleted bot's threads move to Archived (#681), so they leave every list but are kept. */
  private async archiveThreads(botId: string): Promise<void> {
    if (!this.host.archiveThread) return
    for (const thread of this.store.botThreads(botId)) {
      if (this.threadState(thread.threadId) !== 'active') continue
      try {
        await this.host.archiveThread(thread.threadId)
      } catch (error) {
        console.warn('a deleted bot\'s thread could not be archived', { botId, threadId: thread.threadId, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /**
   * The 30-day purge of deleted bots (§5.3.3): their memory (`BotMemoryAdmin.purge`), threads
   * (deleted for good; the home thread takes the threads it owns along), chat, schedules,
   * definition and files folder. Run history in the run database and the runtimes' session files
   * are not purged by this build; the log says so rather than claim they are gone. Each bot is
   * purged on its own: a failure is retried at the next sweep.
   */
  sweepDeleted(now: number = this.now()): Promise<string[]> {
    // One sweep at a time: a second caller gets the one that runs.
    if (this.sweeping) return this.sweeping
    const sweep = this.sweepOnce(now).finally(() => {
      if (this.sweeping === sweep) this.sweeping = undefined
    })
    this.sweeping = sweep
    return sweep
  }

  private async sweepOnce(now: number): Promise<string[]> {
    this.lastSweep = now
    const purged: string[] = []
    for (const entry of this.store.deletedRegistry(new Date(now - BOT_DELETE_PURGE_MS).toISOString())) {
      try {
        await this.purge(entry.botId)
        purged.push(entry.botId)
      } catch (error) {
        console.warn('a deleted bot could not be purged; the next sweep tries again', { botId: entry.botId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return purged
  }

  private async purge(botId: string): Promise<void> {
    if (this.store.activationsIn(botId, [...NOT_ENDED]).length) throw new Error('its last run is still stopping')
    const threads = this.store.botThreads(botId)
    for (const thread of threads) this.needsSync.delete(thread.threadId)
    const home = threads.find((thread) => thread.role === 'home')
    // The home thread owns the bot's run and context threads: they go with it. The threads go
    // before the memory, so a purge that stops between them never has capture copy them back in.
    const own = home ? [home] : threads
    if (this.host.trashThread) {
      for (const thread of own) {
        if (this.threadState(thread.threadId) === 'missing') continue
        await this.host.trashThread(thread.threadId)
      }
    }
    await this.host.memory?.purge(botId)
    await this.host.browser?.removeBot?.(botId, true)
    // Its definition and files first: a failure leaves the purge unfinished, and the next sweep tries again.
    this.host.definitions.remove(botId)
    rmSync(this.filesFolder(botId), { recursive: true, force: true })
    // Its schedules in the shared store go first: a purge stopped after this leaves nothing that runs.
    this.host.schedules?.removeAll(botId)
    this.store.db.transaction(() => {
      this.store.deleteMessages(botId)
      // The rows its schedules were moved from (`bot_schedules`), kept until now.
      this.store.deleteSchedules(botId)
      // Its asks, activations (their inputs and results), dispatches, grants and context generations go too.
      this.store.deleteBotRows(botId)
      for (const thread of threads) this.store.dropThread(thread.threadId)
      this.store.markCleaned(botId)
    })
    for (const thread of threads) this.known.delete(thread.threadId)
    console.info('a deleted bot was purged; its run history and runtime session files are kept by their own stores', { botId })
  }

  /** Purges deleted bots past their 30 days (after the profile has started). */
  async finishDeletions(): Promise<void> {
    await this.sweepDeleted()
  }

  /** `<profileHome>/bots/files/<botId>`: documents the bot makes (§5.10). */
  filesFolder(botId: string): string {
    return botFilesFolder(this.host.profileHome, botId)
  }

  /**
   * Stops the activations' runs and waits until none is live, all within one deadline that also
   * bounds the provider stops themselves (a stop that never settles included). True when quiet.
   */
  private async stopAndWait(rows: readonly BotActivationRow[], timeoutMs = this.host.quiesceTimeoutMs ?? 15_000): Promise<boolean> {
    if (!rows.length) return true
    const until = Date.now() + timeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })
    const work = (async () => {
      await Promise.all(rows.map((row) => this.stopRun(row)))
      await this.untilQuiet(rows, Math.max(0, until - Date.now()))
    })()
    await Promise.race([work, deadline])
    clearTimeout(timer)
    return rows.every((row) => this.allRunsEnded(row))
  }

  /** Waits until no run of the activations is live (bounded; the trash re-checks what is still busy). */
  private async untilQuiet(rows: readonly BotActivationRow[], timeoutMs = 15_000): Promise<void> {
    const until = Date.now() + timeoutMs
    while (rows.some((row) => !this.allRunsEnded(row)) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
  }

  private threadState(threadId: string): 'active' | 'trashed' | 'missing' {
    try {
      return this.host.threads.threadState?.(threadId) ?? 'active'
    } catch {
      return 'active'
    }
  }

  private entry(botId: string): BotDefinitionEntry {
    let entry: BotDefinitionEntry | undefined
    try {
      entry = this.host.definitions.get(botId)
    } catch (error) {
      if (error instanceof BotDefinitionError) throw new BotEngineError(error.code, error.message)
      throw error
    }
    if (!entry || this.store.registry(botId)?.deletedAt) throw new BotEngineError('bot_not_found', 'No bot with that id.')
    return entry
  }

  private summary(entry: BotDefinitionEntry): BotSummary {
    const grant = this.store.activeGrant(entry.id)
    const published = entry.published
    return {
      id: entry.id,
      name: (published ?? entry.draft).name,
      role: (published ?? entry.draft).role,
      draftHash: entry.draftHash,
      revision: published?.revision ?? null,
      grant: grant ? { digest: grant.digest, approvedAt: grant.approvedAt } : null,
      needsApproval: published ? addedPermissions(published.permissions, grant?.manifest ?? null) : [],
      openEscalations: this.store.activationsIn(entry.id, ['waiting_grant']).reduce((count, row) => count + this.store.escalations({ activationId: row.id, status: 'open' }).length, 0),
      schedules: this.schedulesOf(entry.id).map((schedule) => ({
        id: schedule.scheduleId,
        nextRunAt: schedule.nextAt ?? null,
        skipped: schedule.skip ?? null
      }))
    }
  }

  // -- Approval ---------------------------------------------------------------------------------

  /**
   * What approving the published revision means: its digest, what it adds to the active grant,
   * and whether each thread's runtime can hold it. Approve is possible only when every thread passes.
   */
  approval(botId: string): { revision: string; digest: string; added: BotPermissionLine[]; threads: BotThreadCheck[] } {
    const published = this.published(botId)
    const grant = this.store.activeGrant(botId)
    return {
      revision: published.revision!,
      digest: botManifestDigest(published.permissions),
      added: addedPermissions(published.permissions, grant?.manifest ?? null),
      threads: [published.main, ...published.context].map((thread) => this.checkThread(thread, published.permissions, botId))
    }
  }

  /**
   * Reads again the policy facts of the runtime the bot last ran on, so `approval` and `approve`
   * decide on a fresh reading. Never throws.
   */
  async refreshRuntimes(botId: string): Promise<void> {
    const instanceId = this.store.registry(botId)?.model?.selection.instanceId
    if (instanceId) await this.refreshInstance(instanceId)
  }

  private async refreshInstance(instanceId: string): Promise<void> {
    try {
      await this.host.harness.refreshPolicyFacts?.(instanceId)
    } catch {
      // Unread facts claim nothing: the check that follows refuses.
    }
  }

  /** The owner approves the published revision's permissions, once, by their digest. */
  approve(botId: string, manifestDigest: string): { digest: string; approvedAt: string } {
    const published = this.published(botId)
    const digest = botManifestDigest(published.permissions)
    if (digest !== manifestDigest) throw new BotEngineError('bot_grant_changed', 'These permissions changed since they were shown. Review them again.')
    const refused = [published.main, ...published.context].map((thread) => this.checkThread(thread, published.permissions, botId)).find((check) => !check.ok)
    if (refused) throw new BotEngineError('policy_unenforceable', refused.reason ?? 'A thread of this bot cannot hold its permissions.', { thread: refused.key })
    const grant = this.store.approve(botId, digest, published.permissions)
    // Work running under the replaced grant ends now: it never goes on under another grant.
    this.endUnderGrant(botId, 'grant_replaced', grant.digest)
    this.changed({ botId })
    return { digest: grant.digest, approvedAt: grant.approvedAt }
  }

  /** Withdraws the grant: its running dispatch is stopped, and nothing of the bot runs until it is approved again. */
  revoke(botId: string): boolean {
    this.entry(botId)
    const revoked = this.store.revoke(botId)
    this.endUnderGrant(botId, 'grant_revoked')
    this.changed({ botId })
    return revoked
  }

  /**
   * Ends the bot's queued and running activations, and its work that waits to go on, made under any grant but `keep`:
   * each is cancelled with `reason`, and a running one's dispatch is stopped (its authority refuses every call from now
   * on, since it checks the grant on each one). Waiting work's own asks are withdrawn, so no card can bring it back,
   * and its chat says why it stopped.
   */
  private endUnderGrant(botId: string, reason: string, keep?: string): void {
    const ended = this.store.db.transaction(() => {
      const rows = this.store.activationsIn(botId, ['queued', 'running', 'blocked']).filter((row) => row.grantDigest !== keep && (row.status !== 'blocked' || workWaits(row)))
      return rows.filter((row) => {
        if (!this.store.moveActivation(row.id, [row.status], 'cancelled', { endReason: reason })) return false
        if (row.status === 'blocked') this.store.withdrawActivationAsks(row.id)
        return true
      })
    })
    for (const row of ended) {
      if (row.status === 'running') void this.stopRun(row)
      else if (row.status === 'blocked') {
        // Waiting work had posted what it had, with its card: the card now says it is no longer needed, and a line why.
        for (const ask of this.store.escalations({ activationId: row.id, status: 'withdrawn' })) this.republishAsk(ask.id)
        const after = this.store.activation(row.id) ?? { ...row, status: 'cancelled' as const }
        this.recorded(after, () => this.chat.post({
          id: `bm_${row.id}_ended`, botId, author: 'bot', kind: 'notice', text: `I stopped "${this.workTitle(row)}": my permissions changed.`,
          ...(row.trigger.kind === 'work' && row.trigger.replyTo ? { replyTo: row.trigger.replyTo } : {}), activationId: row.id, lane: 'run'
        }))
        this.afterEnd(after)
      } else this.cleanup({ ...row, status: 'cancelled' })
      this.changed({ botId, activationId: row.id })
    }
  }

  private published(botId: string): BotDefinition {
    const entry = this.entry(botId)
    if (!entry.published) throw new BotEngineError('bot_not_published', 'Publish this bot before it can run.')
    return entry.published
  }

  /**
   * Whether a thread can hold `grant` at all: it compiles (no MCP, no app tool a bot may not
   * hold). Which runtime holds it is decided per activation, from the providers that can
   * (`BotModelResolver`), and checked again at each dispatch.
   */
  private checkThread(thread: BotThreadSpec, grant: BotManifest, botId?: string): BotThreadCheck {
    const base = { key: thread.key, instanceId: '', model: '' }
    const compiled = this.compileNeutral(thread, grant, undefined, botId)
    if (!compiled.ok) return { ...base, ok: false, reason: compiled.error.reason ?? compiled.error.message }
    return { ...base, ok: true }
  }

  /** The thread's policy with neutral tool names: what the model resolver asks a runtime to hold. */
  private compileNeutral(thread: BotThreadSpec, grant: BotManifest, botTools?: { escalate: boolean; consult: boolean; memory?: boolean }, botId?: string): ReturnType<typeof compileBotThread> {
    return compileBotThread({
      ...(botId ? { filesFolder: this.filesFolder(botId) } : {}),
      grant,
      digest: botManifestDigest(grant),
      thread,
      scratch: join(this.store.directory, 'scratch', '_check'),
      profileHome: this.host.profileHome,
      nativeNames: (tools) => ({ ok: true, names: [...tools] }),
      remaining: { ...countLimits(grant), deadlineMs: grant.budget.maxActiveMs },
      ...(botTools ? { botTools } : {})
    })
  }

  private nativeNames(instanceId: string, tools: readonly NeutralTool[]): { ok: true; names: string[] } | { ok: false; error: HarnessError & { code: 'policy_unenforceable' } } {
    try {
      return this.host.harness.nativeToolNames(instanceId, tools)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { code: 'policy_unenforceable', message, missing: ['toolControl'], reason: message, instanceId } }
    }
  }

  // -- Activations ------------------------------------------------------------------------------

  /**
   * A manual activation. A repeat of `clientRequestId` returns the same activation. The chat lane
   * runs one at a time and the run lane up to `MAX_RUN_SLOTS_PER_BOT`; later ones wait, at most 20 in
   * all (the oldest waiting one is dropped).
   */
  async activate(input: { botId: string; input: string; clientRequestId: string }): Promise<BotActivationSummary> {
    return this.enqueue(input.botId, `manual:${input.clientRequestId}`, { kind: 'manual', input: input.input })
  }

  /**
   * A chat activation (Bot Phase 1 §5.3.2): it runs on the bot's home thread, beside any run. A
   * repeat of `key` returns the same activation; messages in the chat lane run in order.
   */
  async enqueueChat(botId: string, key: string, input: string, activationId?: string, owner?: BotOwnerTurn): Promise<BotActivationSummary> {
    return this.enqueue(botId, key, { kind: 'manual', input, ...(owner?.limit ? { owner: { limit: owner.limit } } : {}) }, 'chat', activationId)
  }

  /**
   * The activation the owner's chat message will belong to, known before its row is written (the
   * row and its journal row carry it, so the chat pack leaves the message out: it is the request):
   * the waiting chat it answers, or a new id for `enqueueChat`.
   */
  chatActivationFor(botId: string): { activationId: string; continues: boolean } {
    const walls = this.openChatWalls(botId)
    const first = walls[0]
    // A limit answered Not now ends its turn: the message starts a chat of its own.
    if (first && !walls.some((wall) => wall.activationId === first.activationId && 'budget' in wall.permission)) return { activationId: first.activationId, continues: true }
    return { activationId: newActivationId(), continues: false }
  }

  private async enqueue(botId: string, key: string, trigger: BotActivationTrigger, lane: BotLane = 'run', presetId?: string): Promise<BotActivationSummary> {
    const existing = this.store.activationByKey(key)
    if (existing) {
      if (existing.botId !== botId) throw new BotEngineError('client_request_id_conflict', 'This request belongs to another bot.')
      return this.activationSummary(existing)
    }
    const admitted = this.admissible(botId)
    // Work for a row that can't run is not started (#673): the bot (and a reminder's line) says why, and nothing waits
    // to run later on it.
    if (lane === 'run') {
      const turn = turnModelOf(admitted.published.main, { lane, trigger })
      if (turn.pick && isPinned(turn.pick) && this.stuckOn(botId, turn.slot))
        throw new BotEngineError(PICK_UNAVAILABLE, `the model picked for ${rowName(turn.slot).toLowerCase()} can't run now. Pick one in About → Runs on.`)
    }
    const id = presetId && !this.store.activation(presetId) ? presetId : newActivationId()
    const dropped = this.store.db.transaction(() => {
      // A duplicate of the same request in flight at the same time (a chat message delivered twice)
      // finds the activation the other one inserted, and gets that one instead of an error.
      if (this.store.activationByKey(key)) return undefined
      return this.insertQueued(botId, id, key, trigger, lane, admitted)
    })
    if (dropped === undefined) {
      const raced = this.store.activationByKey(key)!
      if (raced.botId !== botId) throw new BotEngineError('client_request_id_conflict', 'This request belongs to another bot.')
      return this.activationSummary(raced)
    }
    if (dropped) this.changed({ botId })
    await this.pump(botId)
    this.changed({ botId, activationId: id })
    return this.activationSummary(this.store.activation(id)!)
  }

  /** Inserts a queued activation (inside a transaction) and drops what waits beyond the queue; how many were dropped. */
  private insertQueued(botId: string, id: string, key: string, trigger: BotActivationTrigger, lane: BotLane, admitted: ReturnType<BotEngine['admissible']>): number {
    const { published, grant } = admitted
    this.store.insertActivation({
      id,
      botId,
      revision: published.revision!,
      grantDigest: grant.digest,
      trigger,
      idempotencyKey: key,
      status: 'queued',
      createdAt: this.store.now(),
      lane
    }, limitsOf(intersectManifest(published.permissions, grant.manifest)))
    return this.dropOverQueue(botId, lane)
  }

  /**
   * Queues the chat activation of the owner's message inside the caller's `bots.db` transaction,
   * the one that writes the message (§5.3.2): a kept message always has the turn that answers it.
   * Why the bot cannot run is returned, not thrown, so the message is still kept; `startQueuedChat`
   * starts the activation after the commit.
   */
  queueChatInTx(botId: string, key: string, input: string, activationId: string, owner?: BotOwnerTurn): BotEngineError | undefined {
    if (this.store.activationByKey(key)) return undefined
    let admitted: ReturnType<BotEngine['admissible']>
    try {
      this.approveStarterIfNeeded(botId)
      admitted = this.admissible(botId)
    } catch (error) {
      if (error instanceof BotEngineError) return error
      throw error
    }
    // A message from another device holds what the turn starts or messages to that device's limit (`BotOwnerTurn`).
    const trigger: BotActivationTrigger = { kind: 'manual', input, ...(owner?.limit ? { owner: { limit: owner.limit } } : {}) }
    if (this.insertQueued(botId, activationId, key, trigger, 'chat', admitted)) this.store.db.afterCommit(() => this.changed({ botId }))
    return undefined
  }

  /** After `queueChatInTx`'s commit: the chat lane starts what waits. */
  async startQueuedChat(botId: string, activationId: string): Promise<void> {
    await this.pump(botId)
    this.changed({ botId, activationId })
  }

  /** The published revision and the grant that covers it; throws when the bot cannot run now. */
  private admissible(botId: string): { published: BotDefinition; grant: { digest: string; manifest: BotManifest } } {
    const published = this.published(botId)
    const home = this.store.registry(botId)?.homeThreadId
    if (home && this.threadState(home) === 'trashed')
      throw new BotEngineError('bot_home_trashed', 'This bot\'s thread is in the trash. Restore it, or delete the bot.')
    const grant = this.store.activeGrant(botId)
    // Nothing is ever approved automatically: a revision that asks for more needs the owner first.
    if (!grant || !manifestSubset(published.permissions, grant.manifest))
      throw new BotEngineError('bot_approval_required', 'Approve this bot\'s permissions before it runs.', { added: addedPermissions(published.permissions, grant?.manifest ?? null) })
    return { published, grant }
  }

  /**
   * A bot without a grant whose published revision asks for no more than the starter grant (a
   * draft the v4 upgrade published) is approved on the owner's first chat (§5.2): pressing send is
   * the approval of that floor, as Create bot is for a new bot. Anything wider still waits.
   */
  approveStarterIfNeeded(botId: string): void {
    const published = this.published(botId)
    if (this.store.activeGrant(botId)) return
    if (!manifestSubset(published.permissions, starterManifest())) return
    this.store.approve(botId, botManifestDigest(published.permissions), published.permissions)
    this.store.db.afterCommit(() => this.changed({ botId }))
  }

  /**
   * Cancels the oldest waiting activations of a lane beyond the queue's size (inside a transaction); how many. In the run
   * lane, the size counts the running pieces too, and work that waits to go on, which is dropped the same way when it is
   * the oldest. Running work is never dropped.
   */
  private dropOverQueue(botId: string, lane: BotLane = 'run'): number {
    const queued = this.store.laneActivations(botId, lane, ['queued'])
    const waiting = lane === 'run' ? this.store.laneActivations(botId, 'run', ['blocked']).filter(workWaits) : []
    const running = lane === 'run' ? this.holding(botId, 'run').length : 0
    const all = [...queued, ...waiting].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const over = all.slice(0, Math.max(0, all.length + running - MAX_QUEUED_ACTIVATIONS))
    for (const activation of over) {
      if (activation.status === 'blocked') {
        const ended = this.endWaitingInTx(activation, 'queue_full', `I had too much waiting, so I dropped "${this.workTitle(activation)}". Ask me again when I'm less busy.`)
        if (ended) this.store.db.afterCommit(() => this.afterEnd(ended))
        continue
      }
      if (!this.store.moveActivation(activation.id, ['queued'], 'cancelled', { endReason: 'queue_full' })) continue
      // The owner's message is never dropped without a word: its chat says so. Nor is work the chat took on.
      if (lane === 'chat')
        this.chat.post({ botId, author: 'bot', kind: 'error', text: '', error: { text: failureText('queue_full') }, activationId: activation.id, lane, id: `bm_${activation.id}_dropped` })
      else if (activation.trigger.kind === 'work')
        this.chat.post({ botId, author: 'bot', kind: 'error', text: '', error: { text: `I had too much waiting, so I dropped "${activation.trigger.title}". Ask me again when I'm less busy.` }, ...(activation.trigger.replyTo ? { replyTo: activation.trigger.replyTo } : {}), activationId: activation.id, lane, id: `bm_${activation.id}_dropped` })
      else if (activation.trigger.kind === 'schedule') this.droppedScheduledRun(botId, activation.trigger)
    }
    return over.length
  }

  /**
   * A scheduled run dropped from a full queue (inside its transaction): its automation says why, as a skipped occurrence
   * does, and the chat says scheduled runs are being dropped, at most once a day (`bm_<botId>_sched_dropped_<day>`).
   */
  private droppedScheduledRun(botId: string, trigger: Extract<BotActivationTrigger, { kind: 'schedule' }>): void {
    const day = new Date(this.now()).toISOString().slice(0, 10)
    this.chat.post({ botId, author: 'bot', kind: 'error', text: '', error: { text: 'I have too much waiting, so I\'m dropping some of my scheduled runs. They run again at their next times once I\'m less busy.' }, lane: 'run', id: `bm_${botId}_sched_dropped_${day}` })
    this.store.db.afterCommit(() => {
      try {
        this.host.schedules?.skipped?.(botId, trigger.scheduleId, { at: trigger.occurrenceAt, reason: 'dropped_queue_full' })
      } catch (error) {
        console.warn('a dropped scheduled run could not be noted on its automation', { botId, scheduleId: trigger.scheduleId, error: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  // -- Schedules (Path step 3: one scheduler) -------------------------------------------------------

  /**
   * One occurrence of a bot's schedule, handed over by the shared scheduler (`ScheduledJobService`), which owns the
   * schedule's time and moves it on. In one transaction this inserts the occurrence's run activation, keyed
   * `sched:<botId>:<scheduleId>:<occurrenceAt>`, so a repeated hand-over (after a crash) inserts nothing. It never piles
   * up copies: while the bot is paused (by its owner, after three failed runs, or by a usage limit), or the same
   * schedule's previous run still waits in the queue, runs, waits at a wall or waits for the internet, the occurrence is
   * skipped and says why. Other runs and the owner's work never skip it: they run beside it. An open ask is not a skip:
   * asks don't block. Before the startup pass nothing is inserted and the occurrence stays due.
   */
  runScheduledOccurrence(input: { botId: string; scheduleId: string; prompt: string; occurrenceAt: string; now?: Date; model?: string; pick?: BotModelPick }):
    | { kind: 'started'; activationId: string }
    | { kind: 'skipped'; reason: string }
    | { kind: 'not_ready' } {
    if (!this.startupPassed) return { kind: 'not_ready' }
    const { botId, scheduleId, prompt, occurrenceAt } = input
    const registry = this.store.registry(botId)
    if (!registry || registry.deletedAt) return { kind: 'skipped', reason: 'bot_deleted' }
    this.endUsagePauseIfDue(botId, input.now ?? new Date(this.now()))
    const paused = this.store.registry(botId)?.pausedReason
    let skip: string | undefined = paused ? (paused === 'usage_limit' ? 'usage_limited' : 'paused') : undefined
    let admitted: ReturnType<BotEngine['admissible']> | undefined
    if (!skip) {
      try {
        admitted = this.admissible(botId)
      } catch (error) {
        // A bot that cannot run now (permissions to approve, its thread in the trash) skips this occurrence; the
        // schedule still moves on, so approving later never runs a backlog.
        skip = error instanceof BotEngineError ? error.code : 'bot_unavailable'
      }
    }
    // A model the owner picked by hand for this automation (#673): this run's pick, on the entry it was saved on, and
    // like any pick it runs there or not at all. One saved by name only (before picks kept their entry) is matched by
    // name, as it was, on a bot that still runs by usage; on a bot whose rows are all picked it is ignored, and the run
    // takes its level's row (Work), which its first run says once.
    const ownPick = input.pick && isPinned(input.pick) ? copyPick(input.pick) : undefined
    const picked = admitted ? allPinned(slotsOf(admitted.published.main)) : false
    const own = ownPick ?? (input.model && !picked ? { model: input.model } : undefined)
    const ignoredName = !ownPick && Boolean(input.model) && picked
    if (admitted && !skip) {
      const depth = admitted.published.main.model.depth
      const turn = turnModelOf(admitted.published.main, { lane: 'run', trigger: { kind: 'schedule', input: prompt, scheduleId, occurrenceAt }, ...(own ? { modelOverride: { mode: 'named', ...own, depth } } : {}) })
      if (turn.pick && isPinned(turn.pick)) {
        // Its row (or its own pick) can't run: skipped with the reason, with no run thread; the chat said so once.
        if (ownPick ? this.stuckOn(botId, `schedule:${scheduleId}`, ownPick) : this.stuckOn(botId, turn.slot)) skip = 'model_unavailable'
        // Its pick's entry is at its usage limit: only what runs there waits (#673).
        else if (this.entryLimitOf(botId, turn.pick)) skip = 'usage_limited'
      }
    }
    const id = `act_${randomUUID()}`
    // The same occurrence handed over again (after a crash): it was inserted already, whatever runs now.
    const key = `sched:${botId}:${scheduleId}:${occurrenceAt}`
    const existing = this.store.activationByKey(key)
    if (existing) return { kind: 'started', activationId: existing.id }
    const made = this.store.db.transaction(() => {
      if (!admitted || skip) return false
      // Only this schedule's own previous run skips it: other runs and the owner's work run beside it.
      const same = (row: BotActivationRow) => row.trigger.kind === 'schedule' && row.trigger.scheduleId === scheduleId
      if (this.store.laneActivations(botId, 'run', ['queued']).some(same)) { skip = 'previous_run_still_queued'; return false }
      const previous = this.holding(botId, 'run').find(same)
      // A run waiting for the internet has no expiry, so its schedule's later occurrences are skipped, not stacked.
      if (previous) { skip = previous.status === 'waiting_grant' ? 'bot_waiting_for_owner' : previous.offline ? 'waiting_for_internet' : 'previous_run_still_running'; return false }
      const inserted = this.store.insertActivationOnce({
        id,
        botId,
        revision: admitted.published.revision!,
        grantDigest: admitted.grant.digest,
        trigger: { kind: 'schedule', input: prompt, scheduleId, occurrenceAt },
        idempotencyKey: key,
        status: 'queued',
        createdAt: this.store.now(),
        lane: 'run'
      }, limitsOf(intersectManifest(admitted.published.permissions, admitted.grant.manifest)))
      if (inserted && own) this.store.setModelOverride(id, { mode: 'named', ...own, depth: admitted.published.main.model.depth })
      // Said once per automation, with its first run on the bot's Work row (a fixed id: a later run posts nothing).
      if (inserted && ignoredName)
        this.chat.post({ id: `bm_${botId}_${scheduleId}_named_model`, botId, author: 'bot', kind: 'notice', text: OLD_MODEL_NAME_IGNORED, activationId: id, lane: 'run', hidden: true })
      if (inserted) this.dropOverQueue(botId, 'run')
      return inserted
    })
    if (skip) {
      this.changed({ botId })
      return { kind: 'skipped', reason: skip }
    }
    if (made) {
      this.changed({ botId, activationId: id })
      this.pumpLater(botId)
    }
    return { kind: 'started', activationId: id }
  }

  /** A usage-limit pause ends at its reset time: the bot's schedules run again. Only that pause ends; the failure streak stays. */
  private endUsagePauseIfDue(botId: string, now: Date): void {
    const registry = this.store.registry(botId)
    if (registry?.pausedReason !== 'usage_limit' || !registry.pausedUntil || Date.parse(registry.pausedUntil) > now.getTime()) return
    this.store.db.transaction(() => {
      this.store.setPaused(botId, null, undefined, { keepStreak: true })
      if (registry.error?.code === 'usage_limit') this.store.setError(botId, null)
    })
    this.changed({ botId })
  }

  /**
   * Bot upkeep after each tick of the shared scheduler: a usage-limit pause past its reset ends, what waits in a free
   * lane starts, captures that missed a thread's last write run again, and once a day deleted bots past their 30 days
   * are purged. One bot that cannot be read never stops the others. Nothing happens before the startup pass.
   */
  async maintain(now: Date = new Date(this.now())): Promise<void> {
    if (!this.startupPassed) return
    for (const botId of this.host.definitions.ids()) {
      try {
        this.endUsagePauseIfDue(botId, now)
      } catch (error) {
        console.warn('a bot\'s usage pause could not be checked', { botId, error: error instanceof Error ? error.message : String(error) })
      }
      try {
        this.forgetPastLimits(botId, now.getTime())
        // A row that can't run clears by itself once its pick can run again, without a word.
        await this.recheckStuck(botId)
      } catch (error) {
        console.warn('a bot\'s models could not be checked', { botId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    // Waiting work that nothing would wake or end ends now, with a line.
    this.settleStrandedWork()
    for (const botId of this.waitingBots()) {
      try {
        await this.pump(botId)
      } catch (error) {
        console.warn('a bot\'s queued activation could not start; the next tick tries again', { botId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    for (const ref of [...this.needsSync.values()]) this.resync(ref)
    // The reminder timer is the way they fire; each tick is a backstop for a timer a sleep or clock change missed.
    await this.deliverDueReminders(now).catch(() => {})
    if (now.getTime() - this.lastSweep >= SWEEP_EVERY_MS) await this.sweepDeleted(now.getTime()).catch(() => [])
  }

  listActivations(botId?: string): BotActivationSummary[] {
    return this.store.listActivations(botId).map((row) => this.activationSummary(row))
  }

  getActivation(activationId: string): BotActivationSummary {
    const row = this.store.activation(activationId)
    if (!row) throw new BotEngineError('activation_not_found', 'No activation with that id.')
    return this.activationSummary(row)
  }

  /** Stops an activation: a waiting one ends now, a running one once its run has stopped. */
  async stop(activationId: string): Promise<BotActivationSummary> {
    const row = this.store.activation(activationId)
    if (!row) throw new BotEngineError('activation_not_found', 'No activation with that id.')
    if (ENDED_ACTIVATION_STATUSES.has(row.status)) return this.activationSummary(row)
    this.store.db.transaction(() => {
      this.store.moveActivation(activationId, [row.status], 'cancelled', { endReason: 'stopped' })
      this.store.closeEscalations(activationId, 'cancelled')
    })
    this.clearInternetCheck(activationId)
    await this.stopRun(row)
    // A run waiting for the internet has no turn whose end would clean up after it.
    if (row.status !== 'running') this.cleanup(row)
    else if (row.offline && !this.live.has(activationId)) {
      this.cleanup(this.store.activation(activationId) ?? row)
      this.packs.delete(activationId)
    }
    this.changed({ botId: row.botId, activationId })
    // Its slot is free now: the next run starts in it, whichever of the profile's bots it is of (`nextRun`).
    await this.pump(row.botId)
    return this.activationSummary(this.store.activation(activationId)!)
  }

  private async stopRun(row: BotActivationRow): Promise<void> {
    if (row.status !== 'running' || !row.threadId) return
    this.live.get(row.id)?.controller.abort(new Error('stopped'))
    const main = this.store.lastMainDispatch(row.id)
    if (main) this.stopConsults(row, main.n)
    // A run that never started is not needed any more: it is cancelled here, not left to the executor.
    const runs = this.host.runs()
    for (const dispatch of this.store.dispatches(row.id)) {
      const run = dispatch.runId ? runs?.getRun(dispatch.runId) : undefined
      if (run?.status !== 'queued') continue
      try { runs!.markTerminal(run.runId, 'cancelled', { error: 'bot_activation_ended' }) } catch { /* it started meanwhile */ }
    }
    try {
      await this.host.stopThread?.(row.threadId)
    } catch (error) {
      console.warn('bot dispatch could not be stopped', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The bot's activations that hold a slot of `lane` now: running (waiting for the internet included) or at a wall. */
  private holding(botId: string, lane: BotLane): BotActivationRow[] {
    return this.store.laneActivations(botId, lane, [...ACTIVE_HOLDING])
  }

  /** How many run-lane activations of every bot of the profile hold a slot now, but `except`. */
  private profileRunsHeld(except?: string): number {
    const marks = ACTIVE_HOLDING.map(() => '?').join(', ')
    return Number(this.store.get(`SELECT COUNT(*) AS n FROM bot_activations WHERE lane = 'run' AND status IN (${marks}) AND id != ?`, ...ACTIVE_HOLDING, except ?? '')?.n ?? 0)
  }

  /**
   * Whether an activation of `lane` that holds no slot (`except`, when it is the one asking) may take one now: the chat
   * lane is one at a time; the run lane `MAX_RUN_SLOTS_PER_BOT` per bot and `MAX_RUN_SLOTS_PER_PROFILE` in all.
   */
  private slotFree(botId: string, lane: BotLane, except?: string): boolean {
    if (this.holding(botId, lane).filter((row) => row.id !== except).length >= laneCapacity(lane)) return false
    return lane !== 'run' || this.profileRunsHeld(except) < MAX_RUN_SLOTS_PER_PROFILE
  }

  /**
   * The owner's work that waits for a run slot now, outside the queue: work allowed to go on (more room, or its usage
   * limit's reset) whose last turn is still letting go. A scheduled run leaves the last free slot to it.
   */
  private ownerWorkWaits(botId: string, except?: string): boolean {
    return this.store.laneActivations(botId, 'run', ['blocked']).some((row) => row.id !== except && workWaits(row) && runRank(row) === 0 &&
      (row.endReason === 'room_allowed' || (row.endReason === 'usage_limit' && this.usageResumable(row))))
  }

  /**
   * Whether the run-lane activation `row` (one that holds no slot) may take one now: a free slot of its bot and of the
   * profile (`slotFree`). Scheduled runs and a reminder's work (`runRank` above 0) hold at most
   * `MAX_BACKGROUND_SLOTS_PER_BOT` of a bot's slots and `MAX_BACKGROUND_SLOTS_PER_PROFILE` of the profile's, so one slot of
   * each bot is always there for work the owner asks for; nor do they take a bot's last free slot while the owner's work
   * waits for one (`ownerWorkWaits`).
   */
  private runSlotFree(row: BotActivationRow): boolean {
    if (!this.slotFree(row.botId, 'run', row.id)) return false
    if (runRank(row) === 0) return true
    const own = this.holding(row.botId, 'run').filter((other) => other.id !== row.id)
    if (own.filter((other) => runRank(other) > 0).length >= MAX_BACKGROUND_SLOTS_PER_BOT) return false
    const profile = this.store.activationsWith([...ACTIVE_HOLDING]).filter((other) => other.lane === 'run' && other.id !== row.id && runRank(other) > 0)
    if (profile.length >= MAX_BACKGROUND_SLOTS_PER_PROFILE) return false
    return !(own.length + 1 >= MAX_RUN_SLOTS_PER_BOT && this.ownerWorkWaits(row.botId, row.id))
  }

  /**
   * The run lane's next activation across the profile's bots, inside a transaction, when a slot is free for it
   * (`runSlotFree`): work that waited and may go on now first (it was running before), then the queue in its order
   * (`runOrder`: the owner's work, a reminder's work, then scheduled runs; oldest first), whichever bot it is of. So when
   * a slot frees at the profile's limit, no bot's owner work waits behind another bot's scheduled runs. A queued one is
   * moved to running here; work that goes on moves in its continuation (`resumeWork`), with nothing awaited between.
   * `tried`: waiting work this pump already tried, which is not taken again. A bot whose journal cannot be written starts
   * nothing (it is stuck until the owner tries again).
   */
  private nextRun(tried: ReadonlySet<string>): { resume: BotActivationRow } | { start: BotActivationRow } | undefined {
    if (this.profileRunsHeld() >= MAX_RUN_SLOTS_PER_PROFILE) return undefined
    const stuck = new Map<string, boolean>()
    const may = (row: BotActivationRow): boolean => {
      if (!stuck.has(row.botId)) stuck.set(row.botId, this.store.registry(row.botId)?.error?.code === 'bot_journal_failed')
      return !stuck.get(row.botId) && this.runSlotFree(row)
    }
    const waiting = this.store.activationsWith(['blocked']).filter((row) => row.lane === 'run' && !tried.has(row.id) && workWaits(row) && this.allRunsEnded(row) &&
      (row.endReason === 'room_allowed' || (row.endReason === 'usage_limit' && this.usageResumable(row)))).sort(runOrder)
    const resume = waiting.find(may)
    if (resume) return { resume }
    const queued = this.store.activationsWith(['queued']).filter((row) => row.lane === 'run').sort(runOrder).find(may)
    if (!queued) return undefined
    this.store.moveActivation(queued.id, ['queued'], 'running')
    return { start: this.store.activation(queued.id)! }
  }

  /**
   * Starts what waits in each lane while it has a free slot: the chat lane one at a time on the home thread, the run
   * lane up to `MAX_RUN_SLOTS_PER_BOT` side by side and `MAX_RUN_SLOTS_PER_PROFILE` across the profile's bots, picked
   * across them in one order (`nextRun`). Nothing starts while the journal cannot be written (the bot is stuck until the
   * owner tries again).
   */
  private async pump(botId: string): Promise<void> {
    if (this.store.registry(botId)?.error?.code !== 'bot_journal_failed') {
      // The chat lane's thread is the home thread: a stopped activation's turn lets go of it first.
      const chatHeld = [...this.live.keys()].some((id) => {
        const live = this.store.activation(id)
        return live?.botId === botId && live.lane === 'chat' && ENDED_ACTIVATION_STATUSES.has(live.status)
      })
      if (!chatHeld) {
        const next = this.store.db.transaction((): BotActivationRow | undefined => {
          if (!this.slotFree(botId, 'chat')) return undefined
          const queued = this.store.laneActivations(botId, 'chat', ['queued'])[0]
          if (!queued) return undefined
          this.store.moveActivation(queued.id, ['queued'], 'running')
          return this.store.activation(queued.id)!
        })
        if (next) await this.startActivation(next)
      }
    }
    await this.pumpRuns()
  }

  /** The run lane of the profile's bots: what waits starts while there is a slot for it, in one order (`nextRun`). */
  private async pumpRuns(): Promise<void> {
    // Each start runs on its own; the slots are taken one transaction at a time, so two pumps never overfill them.
    const started: Promise<void>[] = []
    const tried = new Set<string>()
    for (;;) {
      const next = this.store.db.transaction(() => this.nextRun(tried))
      if (!next) break
      if ('resume' in next) {
        tried.add(next.resume.id)
        // Its continuation moves it to running before anything is awaited, so the next pick counts it.
        started.push(this.resumeWork(next.resume))
      } else started.push(this.startActivation(next.start))
    }
    await Promise.all(started)
  }


  /**
   * The activation's thread and scratch folder, its model and context pack, then its first
   * dispatch: the intent in `bots.db` first, then the run, receipt and `turn.start` in one run-DB
   * transaction. A chat activation runs on the bot's home thread; a run gets a thread of its own.
   */
  private async startActivation(row: BotActivationRow): Promise<void> {
    try {
      const definition = this.host.definitions.revision(row.botId, row.revision)
      if (!definition) throw new BotEngineError('bot_not_published', 'The revision this activation was made for is gone.')
      const home = this.ensureHome(row.botId, definition.name)
      let threadId = home
      if (row.lane === 'run') {
        const title = `${definition.name}: ${summarise(row.trigger.input)}`.slice(0, 120)
        const thread = this.host.threads.ensureExecutionThread(`bot:${row.botId}:act:${row.id}`, title, undefined, { parentTaskId: home })
        this.putThread({ threadId: thread.id, botId: row.botId, role: 'activation', key: definition.main.key, activationId: row.id })
        threadId = thread.id
      }
      const scratch = join(this.store.directory, 'scratch', row.id)
      mkdirSync(join(scratch, 'tmp'), { recursive: true, mode: 0o700 })
      mkdirSync(this.filesFolder(row.botId), { recursive: true, mode: 0o700 })
      const clientRequestId = `${row.id}:d1`
      const still = this.recorded(row, () => {
        if (!this.store.moveActivation(row.id, ['running'], 'running', { threadId, scratch })) return false
        if (!this.store.dispatch(row.id, 1)) {
          // A run's request ends with what its last message is for: the report (bot-context.md §5.2). Work that waited
          // takes what the owner added meanwhile.
          const notes = this.workNotes(row)
          if (notes) this.store.applyWorkNotes(notes.ids)
          const text = row.lane === 'run' ? `${row.trigger.input}${notes ? `\n\n${notes.text}` : ''}\n\n${BOT_RUN_REPORT_LINE}` : row.trigger.input
          this.store.insertDispatch({ activationId: row.id, n: 1, kind: 'start', clientRequestId, threadId, prompt: { text }, policyDigest: row.grantDigest })
          if (row.lane === 'run') this.journalInTx({
            botId: row.botId, kind: 'run_start', lane: 'run', activationId: row.id, threadId, sourceKey: `act:${row.id}:start`, who: 'mousse',
            text: row.trigger.input,
            json: { v: 1, trigger: row.trigger.kind, ...(row.trigger.kind === 'schedule' ? { scheduleId: row.trigger.scheduleId, occurrenceAt: row.trigger.occurrenceAt } : {}) }
          })
        }
        return true
      })
      // Stopped (or its grant ended, or its journal failed) while its threads were made: no dispatch, no folder left.
      if (!still) {
        rmSync(scratch, { recursive: true, force: true })
        return
      }
      await this.sendDispatch(this.store.activation(row.id)!, this.store.dispatch(row.id, 1)!)
    } catch (error) {
      const reason = error instanceof BotEngineError ? error.code : 'bot_start_failed'
      console.warn('bot activation could not start', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
      this.failActivation(this.store.activation(row.id) ?? row, reason)
    }
  }

  /** The bot's home thread (`bot:<id>`), made once: the chat lane's thread and the owner of its runs. */
  ensureHome(botId: string, name: string): string {
    const home = this.host.threads.ensureExecutionThread(`bot:${botId}`, name.slice(0, 120))
    this.putThread({ threadId: home.id, botId, role: 'home', key: 'home' })
    this.store.setHomeThread(botId, home.id)
    return home.id
  }

  /** A journal row in the caller's `bots.db` transaction (engine events, bot-context.md §4). */
  private journalInTx(row: BotJournalInput): void {
    this.host.journal?.appendInTx(this.store.db, row)
  }

  /**
   * Before a main dispatch is sent: the activation's model, resolved at its first dispatch (and
   * again after a usage limit or a reload), and its context pack, built once and frozen. A problem
   * ends the activation with a stuck error in plain words.
   */
  private async ready(row: BotActivationRow, dispatch: BotDispatchRow): Promise<boolean> {
    if (dispatch.kind === 'consult') return true
    const definition = this.host.definitions.revision(row.botId, row.revision)
    const grant = this.store.activeGrant(row.botId)
    if (!definition || !grant) return true // prepare refuses it with the reason
    const turn = turnModelOf(definition.main, row)
    // A pick on an entry is checked again before every main dispatch, continuations included (a restart, the internet
    // back, the turn cap, more room, an answered ask): its entry may have been turned off, or switched to another kind
    // of sign-in or account, while the activation waited. A model by name or by usage is chosen once, as before.
    const pinned = isPinned(turn.pick)
    if (!row.selection || row.reloadPending || pinned) {
      // A usage limit this picked bot already met on the pick's entry: it waits for that reset, without a call.
      const limit = pinned ? this.entryLimitOf(row.botId, turn.pick!) : undefined
      if (limit) {
        this.usagePause(row, limit.until, limit.instanceId, turn)
        return false
      }
      const resolved = await this.resolveModel(row, definition, grant.manifest, turn)
      if ('problem' in resolved) {
        this.modelProblem(row, resolved, turn)
        return false
      }
      const same = row.selection && !row.reloadPending && row.selection.instanceId === resolved.selection.instanceId && row.selection.model === resolved.selection.model
      const registry = this.store.registry(row.botId)?.model
      // Each row's last model (#673): Talk and Work on different models take turns without a journal row each time.
      const previous = registry?.rows?.[turn.slot]
      const saved = this.recorded(row, () => {
        if (!same) {
          this.store.setActivationSelection(row.id, resolved.selection)
          this.store.setModel(row.botId, { ...registry, selection: resolved.selection, activationId: row.id, rows: { ...registry?.rows, [turn.slot]: resolved.selection } })
          if (!previous || previous.instanceId !== resolved.selection.instanceId || previous.model !== resolved.selection.model || previous.effort !== resolved.selection.effort)
            this.journalInTx({
              botId: row.botId, kind: 'model_change', lane: row.lane, activationId: row.id, sourceKey: `act:${row.id}:model:${dispatch.n}`, who: 'mousse',
              text: 'The model changed.', json: { v: 1, row: turn.slot, from: previous ?? null, to: resolved.selection }
            })
        }
        // It runs again: the rows on this pick are no longer stuck, and nothing is said about it.
        if (pinned) this.clearStuckInTx(row.botId, (key, entry) => samePickTarget(entry.pick, turn.pick) && (key.startsWith('schedule:') ? row.trigger.kind === 'schedule' && key === `schedule:${row.trigger.scheduleId}` : true))
        return true
      })
      if (!saved) return false
    }
    // Read at each main dispatch: the provider freezes the pack per activation, and a memory save or forget drops it.
    if (this.host.context) {
      try {
        const pack = row.lane === 'chat'
          ? await this.host.context.chatPreamble({ botId: row.botId, activationId: row.id })
          : await this.host.context.runPreamble({ botId: row.botId, activationId: row.id, ...(row.trigger.kind === 'schedule' ? { scheduleId: row.trigger.scheduleId } : {}), input: row.trigger.input })
        this.packs.set(row.id, pack)
      } catch (error) {
        console.warn('a bot\'s context could not be read', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
        if (isJournalFailure(error)) this.journalFailed(row)
        else this.failActivation(row, 'bot_context_failed')
        return false
      }
    }
    return true
  }

  /**
   * The model for an activation (#673): its lane's row (Talk, or the work level's), or its own pick. A pick that can't
   * run is a problem (`pick_unavailable`, or `all_limited` at its usage limit); nothing else is tried for it.
   */
  private async resolveModel(row: BotActivationRow, definition: BotDefinition, grant: BotManifest, turn: BotTurnModel): Promise<BotModelResolution> {
    const models = this.host.models
    if (!models) return { problem: 'no_provider' }
    const effective = this.effectiveManifest(row, definition.permissions, grant)
    const compiled = this.compileNeutral(definition.main, effective, { escalate: true, consult: definition.context.length > 0, memory: true }, row.botId)
    if (!compiled.ok) return { problem: 'no_provider' }
    const policy: RunPolicy = { mode: 'default', origin: 'bot', ...compiled.policy }
    return models.resolve({ botId: row.botId, pick: turn.pick, depth: turn.depth, policy })
  }

  /** No model could run the activation: it ends, and the bot says why in plain words, with one action. */
  private modelProblem(row: BotActivationRow, problem: { problem: BotModelProblem; until?: string; instanceId?: string; missed?: BotPickMiss }, turn?: BotTurnModel): void {
    if (problem.problem === 'all_limited') return this.usagePause(row, problem.until, problem.instanceId, turn)
    if (problem.problem === 'pick_unavailable') return this.pickProblem(row, problem.missed, turn)
    const error: BotError = problem.instanceId
      ? { text: 'Sign in so I can work.', action: { kind: 'sign_in', label: 'Sign in', instanceId: problem.instanceId } }
      : { text: 'Set up a provider so I can work.', action: { kind: 'open_providers', label: 'Open providers' } }
    this.failActivation(row, problem.problem === 'no_provider' ? 'bot_no_provider' : 'bot_model_unavailable', { code: problem.problem, error })
  }

  /**
   * A model the owner picked can't run (#673): the activation ends, and nothing runs on another model or entry. Every
   * row that holds this pick is stuck (`BotModelState.stuck`), and so is an automation's own pick: it holds until the
   * pick runs again (`recheckStuck`, or a turn that runs on it) or the owner picks again for that row. While a work row
   * is stuck its schedules are skipped and work for it is not started; the chat says so once per stuck row. While Talk
   * is stuck every owner message gets the line, with no model call. The line names the model and its entry, is kept out
   * of everything the bot is given (`hidden`), and has one action, Pick a model. It never counts as a failed run.
   */
  private pickProblem(row: BotActivationRow, missed: BotPickMiss | undefined, turn: BotTurnModel | undefined): void {
    const text = missed ? pickProblemText(missed) : 'I can\'t use the model picked for me.'
    const error: BotError = { text, action: { kind: 'pick_model', label: 'Pick a model' } }
    const pick = turn?.pick && isPinned(turn.pick) ? turn.pick : undefined
    const own = row.modelOverride?.mode === 'named'
    const ended = this.recorded(row, () => {
      if (!this.store.moveActivation(row.id, ['running', 'queued'], 'failed', { endReason: PICK_UNAVAILABLE })) return false
      this.store.closeEscalations(row.id, 'cancelled')
      // A pick another row already waits on was said when that row became stuck.
      const before = this.stuckRows(row.botId)
      const known = pick ? before.some(([, entry]) => samePickTarget(entry.pick, pick)) : false
      if (pick) {
        const slots = this.slotsNow(row.botId)
        const keys: string[] = BOT_MODEL_SLOT_KEYS.filter((key) => samePickTarget(slots[key], pick) && !before.some(([held]) => held === key))
        if (own && row.lane === 'run' && row.trigger.kind === 'schedule') keys.push(`schedule:${row.trigger.scheduleId}`)
        const at = this.store.now()
        this.updateModelStateInTx(row.botId, (state) => {
          const stuck = { ...state.stuck }
          for (const key of keys) stuck[key] = { pick: copyPick(key.startsWith('schedule:') ? pick : (slots[key as BotModelSlotKey] ?? pick)), text, at }
          return { ...state, stuck }
        }, pick)
      }
      // Talk: every owner message is answered with the line. Work: once per stuck row.
      if (row.lane === 'chat' || !known)
        this.chat.post({ botId: row.botId, author: 'bot', kind: 'error', text: '', error, activationId: row.id, lane: row.lane, id: `bm_${row.id}_pick`, hidden: true })
      this.journalEnd(row, PICK_UNAVAILABLE)
      return true
    }) ?? false
    if (ended) this.afterEnd(this.store.activation(row.id) ?? row)
  }

  // -- A picked bot's rows that can't run, and its entries' usage limits (#673) ------------------------------------

  /** The bot's rows as published now; every row Mousse choosing when its definition can't be read. */
  private slotsNow(botId: string): BotModelSlots {
    try {
      return this.ownerSlots(botId)
    } catch {
      return { ...UNPICKED_SLOTS }
    }
  }

  /** What the engine keeps about the bot's models, changed in the caller's transaction; `placeholder` when none is kept yet. */
  private updateModelStateInTx(botId: string, change: (state: Partial<BotModelState>) => Partial<BotModelState>, placeholder?: ProviderSelection | BotModelPick): void {
    const current = this.store.registry(botId)?.model ?? undefined
    const next = change({ ...current })
    if (next.stuck && !Object.keys(next.stuck).length) delete next.stuck
    if (next.limits && !Object.keys(next.limits).length) delete next.limits
    // Older builds read `selection` whenever `model_json` is there: a bot that never ran keeps the pick there.
    const selection = next.selection ?? (placeholder?.instanceId ? { instanceId: placeholder.instanceId, model: placeholder.model } : undefined)
    if (!selection) return
    this.store.setModel(botId, { ...next, selection, activationId: next.activationId ?? '' })
  }

  /** The rows (and automations' own picks) still stuck, with their lines: each row that still holds the pick that failed. */
  stuckRows(botId: string): Array<[string, BotStuckEntry]> {
    const stuck = this.store.registry(botId)?.model?.stuck
    return stuck ? stuckRowsOf(stuck, this.slotsNow(botId)) : []
  }

  /** The line of a row that is stuck, or of an automation's own pick (`schedule:<id>`) while it is the same pick. */
  private stuckOn(botId: string, key: string, pick?: BotModelPick): BotStuckEntry | undefined {
    const found = this.stuckRows(botId).find(([held]) => held === key)?.[1]
    if (!found) return undefined
    return key.startsWith('schedule:') && !sameStoredPick(found.pick, pick) ? undefined : found
  }

  /** Clears the stuck entries `which` picks, in the caller's transaction. Nothing is said. */
  private clearStuckInTx(botId: string, which: (key: string, entry: BotStuckEntry) => boolean): boolean {
    const stuck = this.store.registry(botId)?.model?.stuck
    if (!stuck) return false
    const keep = Object.fromEntries(Object.entries(stuck).filter(([key, entry]) => entry && !which(key, entry)))
    if (Object.keys(keep).length === Object.keys(stuck).length) return false
    this.updateModelStateInTx(botId, (state) => ({ ...state, stuck: keep }))
    this.store.db.afterCommit(() => this.changed({ botId }))
    return true
  }

  /** The rows the owner picked again are no longer stuck. */
  private clearStuckRows(botId: string, keys: readonly string[]): void {
    if (!keys.length) return
    this.store.db.transaction(() => this.clearStuckInTx(botId, (key) => keys.includes(key)))
  }

  /**
   * Whether each stuck pick can run again (`maintain`, Resume): a pick that resolves now clears every entry on it,
   * without a word. Nothing runs; only the model choice is asked.
   */
  async recheckStuck(botId: string): Promise<void> {
    const models = this.host.models
    const held = this.store.registry(botId)?.model?.stuck
    if (!models || !held || !Object.keys(held).length) return
    const live = this.stuckRows(botId)
    // Entries for rows the owner picked again since are dropped here too.
    if (live.length !== Object.keys(held).length) this.store.db.transaction(() => this.clearStuckInTx(botId, (key) => !live.some(([kept]) => kept === key)))
    if (!live.length) return
    let definition: BotDefinition
    try {
      definition = this.published(botId)
    } catch {
      return
    }
    const grant = this.store.activeGrant(botId)
    if (!grant) return
    const compiled = this.compileNeutral(definition.main, intersectManifest(definition.permissions, grant.manifest), { escalate: true, consult: definition.context.length > 0, memory: true }, botId)
    if (!compiled.ok) return
    const policy: RunPolicy = { mode: 'default', origin: 'bot', ...compiled.policy }
    const tried: BotModelPick[] = []
    for (const [, entry] of live) {
      if (tried.some((pick) => samePickTarget(pick, entry.pick))) continue
      tried.push(entry.pick)
      try {
        const resolved = await models.resolve({ botId, pick: entry.pick, depth: 'normal', policy })
        if ('selection' in resolved) this.store.db.transaction(() => this.clearStuckInTx(botId, (_key, other) => samePickTarget(other.pick, entry.pick)))
      } catch {
        // The next check tries again.
      }
    }
  }

  /**
   * The usage limit this picked bot met on `pick`'s entry that still holds: the entry's own, or its family's (a limit
   * the provider names for Opus or Sonnet only blocks those models there).
   */
  private entryLimitOf(botId: string, pick: BotModelPick): BotEntryLimit | undefined {
    return limitOnPick(this.store.registry(botId)?.model?.limits, pick, this.now())
  }

  /** A picked bot's entry limits past their reset are forgotten: their rows run again (`maintain`). */
  private forgetPastLimits(botId: string, now: number): void {
    const limits = this.store.registry(botId)?.model?.limits
    if (!limits || Object.values(limits).every((limit) => Date.parse(limit.until) > now)) return
    this.store.db.transaction(() => this.updateModelStateInTx(botId, (state) => ({ ...state, limits: Object.fromEntries(Object.entries(state.limits ?? {}).filter(([, limit]) => Date.parse(limit.until) > now)) })))
    this.changed({ botId })
  }

  /** What the chat is told about rows that can't run (its situation): work for them is not started. */
  situationLines(botId: string): string[] {
    const work = this.stuckRows(botId).map(([key]) => key).filter((key): key is BotWorkLevel => key === 'light' || key === 'medium' || key === 'hard')
    if (!work.length) return []
    const names = work.length === 3 ? 'Work' : work.map((key) => rowName(key)).join(' and ')
    return [`${names} can't run now: the model picked for it can't be used. That work won't start, and its schedules are skipped. If the owner asks for such work, tell them plainly to pick a model in About → Runs on.`]
  }

  /**
   * Every candidate is at its usage limit: the bot's schedules pause until the reset, with one
   * error row ("Paused until 14:00 (your Claude usage limit)"). It names the provider family, never
   * the model. This never counts as a failed run. Work the owner asked for waits (`blocked`,
   * `usage_limit`, without holding the run lane) and goes on in its own thread when the pause ends
   * (`maintain`, or the owner's Resume); its row says so in the same line. Anything else ends.
   */
  private usagePause(row: BotActivationRow, until: string | undefined, instanceId: string | undefined, turn?: BotTurnModel, limitKind?: string): void {
    if (turn?.pick && isPinned(turn.pick)) return this.entryLimitPause(row, until, turn.pick, limitKind)
    const family = instanceId ? this.providerLabel(instanceId) : undefined
    const waits = row.lane === 'run' && row.trigger.kind === 'work'
    const limit = family ? `your ${family} usage limit` : 'a usage limit'
    // Without a reset time the pause lasts `USAGE_RECHECK_MS`, and the line says so: never "once it resets".
    const retryAt = until ?? new Date(this.now() + USAGE_RECHECK_MS).toISOString()
    const text = until
      ? `Paused until ${clockTime(until)} (${limit})${waits ? '. I\'ll carry on with this then.' : ''}`
      : `Paused (${limit}, with no reset time given). ${waits ? `I'll try this again every ${USAGE_RECHECK_MS / 60_000} minutes until it goes through.` : `I'll try again at ${clockTime(retryAt)}.`}`
    const error: BotError = { text, action: { kind: 'resume', label: 'Resume' } }
    let pauses = false
    const ended = this.recorded(row, () => {
      if (!this.store.moveActivation(row.id, ['running', 'queued'], waits ? 'blocked' : 'failed', { endReason: 'usage_limit' })) return false
      this.store.closeEscalations(row.id, 'cancelled')
      // The owner's pause, or one after failed runs, stays: the reset never lifts it.
      const paused = this.store.registry(row.botId)?.pausedReason
      pauses = !paused || paused === 'usage_limit'
      if (pauses) {
        this.store.setPaused(row.botId, 'usage_limit', retryAt)
        this.store.setError(row.botId, { code: 'usage_limit', error })
      }
      // Runs side by side on one limited entry pause the bot once: a scheduled run whose sibling already paused it adds
      // no second line. Each piece of work says it carries on, as it is the owner's.
      if (waits || paused !== 'usage_limit')
        this.chat.post({ botId: row.botId, author: 'bot', kind: 'error', text: '', error, activationId: row.id, lane: row.lane, id: `bm_${row.id}_limit` })
      // Waiting work has not ended: its end is journaled when it does.
      if (!waits) this.journalEnd(row, 'usage_limit')
      return true
    }) ?? false
    if (!ended) return
    const after = this.store.activation(row.id) ?? row
    if (!waits) return this.afterEnd(after)
    // Under the owner's own pause there is no usage pause to end: the work waits for the reset time itself.
    if (!pauses) this.usageWaits.set(row.id, { botId: row.botId, at: Date.parse(retryAt) })
    this.letGoOfBrowser(after)
    this.packs.delete(row.id)
    this.clearLiveChip(after)
    this.changed({ botId: row.botId, activationId: row.id })
    this.pumpLater(row.botId)
  }

  /**
   * A picked row met a usage limit (#673): only what runs on that entry waits, never the whole bot. The limit is kept
   * by entry, or by entry and family when the provider names a window for one family only (Claude's weekly Opus or
   * Sonnet limit), until its reset or the owner's Resume. Rows on other entries, and other models on the entry when
   * the limit is a family's, keep running, schedules included. The chat says "Paused until 14:00 (your Claude usage
   * limit)" once per limit. Work the owner asked for waits and goes on at the reset, on the same pick; anything else
   * ends. Never a failed run, and no other model or entry is tried.
   */
  private entryLimitPause(row: BotActivationRow, until: string | undefined, pick: BotModelPick & { instanceId: string }, limitKind: string | undefined): void {
    const provider = this.providerLabel(pick.instanceId)
    const waits = row.lane === 'run' && row.trigger.kind === 'work'
    const known = this.entryLimitOf(row.botId, pick)
    const family = known ? known.family : limitFamilyOf(limitKind)
    const retryAt = until ?? known?.until ?? new Date(this.now() + USAGE_RECHECK_MS).toISOString()
    const limit = provider ? `your ${provider} usage limit` : 'a usage limit'
    const text = until || known
      ? `Paused until ${clockTime(retryAt)} (${limit})${waits ? '. I\'ll carry on with this then.' : ''}`
      : `Paused (${limit}, with no reset time given). ${waits ? `I'll try this again every ${USAGE_RECHECK_MS / 60_000} minutes until it goes through.` : `I'll try again at ${clockTime(retryAt)}.`}`
    const error: BotError = { text, action: { kind: 'resume', label: 'Resume' } }
    const key = family ? `${pick.instanceId}#${family}` : pick.instanceId
    const ended = this.recorded(row, () => {
      if (!this.store.moveActivation(row.id, ['running', 'queued'], waits ? 'blocked' : 'failed', { endReason: 'usage_limit' })) return false
      this.store.closeEscalations(row.id, 'cancelled')
      const held = this.store.registry(row.botId)?.model?.limits?.[key]
      const holds = held && Date.parse(held.until) > this.now()
      const said = Boolean(holds && held!.said)
      this.updateModelStateInTx(row.botId, (state) => ({
        ...state,
        limits: { ...state.limits, [key]: { instanceId: pick.instanceId, until: holds && Date.parse(held!.until) > Date.parse(retryAt) ? held!.until : retryAt, ...(family ? { family } : {}), said: true } }
      }), pick)
      if (!said) this.chat.post({ botId: row.botId, author: 'bot', kind: 'error', text: '', error, activationId: row.id, lane: row.lane, id: `bm_${row.id}_limit` })
      if (!waits) this.journalEnd(row, 'usage_limit')
      return true
    }) ?? false
    if (!ended) return
    const after = this.store.activation(row.id) ?? row
    if (!waits) return this.afterEnd(after)
    this.letGoOfBrowser(after)
    this.packs.delete(row.id)
    this.clearLiveChip(after)
    this.changed({ botId: row.botId, activationId: row.id })
    this.pumpLater(row.botId)
  }

  /**
   * Whether work a usage limit stopped may go on: the bot's usage pause has ended (at its reset, or the owner's Resume),
   * and, under the owner's own pause, the reset time it waits for has passed. Work on a picked row waits for its own
   * entry's limit only (#673).
   */
  private usageResumable(row: BotActivationRow): boolean {
    const definition = this.host.definitions.revision(row.botId, row.revision)
    const turn = definition ? turnModelOf(definition.main, row) : undefined
    if (turn?.pick && isPinned(turn.pick)) return !this.entryLimitOf(row.botId, turn.pick)
    if (this.store.registry(row.botId)?.pausedReason === 'usage_limit') return false
    return (this.usageWaits.get(row.id)?.at ?? 0) <= this.now()
  }

  private providerLabel(instanceId: string): string {
    try {
      const label = this.host.providerLabel?.(instanceId)
      if (label) return label
    } catch {
      // Below.
    }
    const family = instanceId.split(/[:/]/)[0] ?? ''
    return family === 'claude' ? 'Claude' : family === 'codex' ? 'ChatGPT' : family === 'pi' ? 'provider' : family.charAt(0).toUpperCase() + family.slice(1)
  }

  /**
   * Ends an activation as failed, with an error row in its chat (and, for errors with an action, the
   * bot's stuck error). Run failures count toward the failure streak; chat failures never do.
   */
  private failActivation(row: BotActivationRow, reason: string, stuck?: BotStoredError): void {
    const error = stuck?.error ?? { text: failureText(reason) }
    const ended = this.recorded(row, () => {
      if (!this.store.moveActivation(row.id, ['running', 'queued'], 'failed', { endReason: reason })) return false
      this.store.closeEscalations(row.id, 'cancelled')
      if (stuck) this.store.setError(row.botId, stuck)
      this.chat.post({ botId: row.botId, author: 'bot', kind: 'error', text: '', error, activationId: row.id, lane: row.lane, id: `bm_${row.id}_failed` })
      this.journalEnd(row, reason)
      return true
    }) ?? false
    if (!ended) return
    const after = this.store.activation(row.id) ?? row
    if (after.lane === 'run') this.countFailure(after)
    this.afterEnd(after)
  }

  /**
   * An activation stopped short of its end (paused for interrupted calls, blocked by its grant or a
   * limit the owner refused): its chat says so, once per reason, as Phase 1 has no Continue.
   */
  private stoppedRow(row: BotActivationRow): void {
    const reason = row.endReason ?? row.status
    this.recorded(row, () => this.chat.post({ botId: row.botId, author: 'bot', kind: 'error', text: '', error: { text: failureText(reason) }, activationId: row.id, lane: row.lane, id: `bm_${row.id}_stop_${reason}` }))
  }

  /** What follows any end of an activation: its scratch and pack go, the lane moves on. */
  private afterEnd(row: BotActivationRow): void {
    this.clearInternetCheck(row.id)
    this.cleanup(row)
    this.packs.delete(row.id)
    this.clearLiveChip(row)
    this.changed({ botId: row.botId, activationId: row.id })
    this.pumpLater(row.botId)
  }

  private journalEnd(row: BotActivationRow, reason: string | null): void {
    if (row.lane !== 'run') return
    this.journalInTx({ botId: row.botId, kind: 'run_end', lane: 'run', activationId: row.id, sourceKey: `act:${row.id}:end`, who: 'mousse', text: reason ?? 'done', json: { v: 1, reason: reason ?? 'done' } })
  }

  /**
   * One more failed run in a row; at three the bot's schedules pause, with one notice. A usage
   * limit, a stop or a chat failure never counts.
   */
  private countFailure(row: BotActivationRow): void {
    // Three failed schedules pause the schedules; work the chat started fails on its own, in its report.
    if (row.trigger.kind === 'work') return
    const paused = this.recorded(row, () => {
      const streak = this.store.bumpFailureStreak(row.botId)
      const registry = this.store.registry(row.botId)
      if (streak < BOT_FAILURE_PAUSE_STREAK || registry?.pausedReason) return false
      this.store.setPaused(row.botId, 'failures')
      this.chat.post({ botId: row.botId, author: 'bot', kind: 'notice', text: 'I\'ve paused my schedules after three failed runs. Resume when it\'s fixed.', activationId: row.id, lane: 'run', id: `bm_${row.id}_paused` })
      return true
    }) ?? false
    if (paused) this.changed({ botId: row.botId })
  }

  /**
   * A `bots.db` transaction that writes journal rows: when the journal cannot be written, nothing of
   * it is kept, the activation fails and the bot is stuck (undefined then). A bot never runs unrecorded.
   */
  private recorded<T>(row: BotActivationRow, work: () => T): T | undefined {
    try {
      return this.store.db.transaction(work)
    } catch (error) {
      if (!isJournalFailure(error)) throw error
      console.warn('a bot\'s journal could not be written', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
      this.journalFailed(row)
      return undefined
    }
  }

  /** `bots.chat.send` could not journal the owner's message: the bot is stuck until the owner tries again. */
  journalFailedFor(botId: string): void {
    this.store.setError(botId, { code: 'bot_journal_failed', error: BOT_JOURNAL_ERROR })
    this.changed({ botId })
  }

  /** The journal could not be written: the activation fails and the bot is stuck; nothing more runs until the owner tries again. */
  private journalFailed(row: BotActivationRow): void {
    const ended = this.store.db.transaction(() => {
      this.store.setError(row.botId, { code: 'bot_journal_failed', error: BOT_JOURNAL_ERROR })
      const moved = this.store.moveActivation(row.id, ['running', 'queued', 'waiting_grant', 'paused', 'blocked'], 'failed', { endReason: 'bot_journal_failed' })
      if (moved) this.store.closeEscalations(row.id, 'cancelled')
      return moved
    })
    const after = this.store.activation(row.id) ?? row
    if (ended) this.afterEnd(after)
    else this.changed({ botId: row.botId })
  }

  // -- Execution (BotTurnDispatcher) -----------------------------------------------------------

  async refresh(payload: BotTurnPayload): Promise<void> {
    const row = this.store.activation(payload.activationId)
    const dispatch = row ? this.store.dispatch(row.id, payload.dispatchN) : undefined
    // A dispatch resent after a restart: its model and pack are made again before it is prepared.
    if (row && dispatch && row.status === 'running' && dispatch.startedAt === null) await this.ready(row, dispatch).catch(() => false)
    const current = this.store.activation(payload.activationId)
    const selection = current?.selection
    if (selection) await this.refreshInstance(selection.instanceId)
    // A turn of a bot that holds MCP tools reads the owner's servers first when the listing is cold, old or changed
    // (bounded, at most `BOT_MCP_WARM_MS`; a warm one returns at once), so work is offered the granted tools. A bot with
    // no MCP permission starts and lists nothing: it reads the servers only when it calls `mcp_servers`.
    if (this.host.mcp && current && (this.store.activeGrant(current.botId)?.manifest.mcp.length ?? 0) > 0) await this.host.mcp.warm()
  }

  prepare(payload: BotTurnPayload): PreparedBotTurn | { refused: string; code: string } {
    const row = this.store.activation(payload.activationId)
    const dispatch = row ? this.store.dispatch(row.id, payload.dispatchN) : undefined
    const refuse = (code: string, refused: string) => ({ code, refused })
    if (!row || !dispatch || dispatch.threadId !== payload.threadId || (dispatch.runId !== null && dispatch.runId !== payload.runId))
      return refuse('bot_dispatch_unknown', 'This run is not a dispatch of a bot activation.')
    if (row.status !== 'running') return refuse('bot_activation_not_running', 'The activation is not running.')
    if (dispatch.startedAt !== null) return refuse('bot_dispatch_started', 'This dispatch already started.')
    const grant = this.store.activeGrant(row.botId)
    // The grant the dispatch was made under must still be the active one.
    if (!grant || grant.digest !== dispatch.policyDigest || grant.digest !== row.grantDigest)
      return this.block(row, 'bot_grant_revoked', 'The bot\'s permissions were revoked or changed.')
    const definition = this.host.definitions.revision(row.botId, row.revision)
    if (!definition || !manifestSubset(definition.permissions, grant.manifest))
      return this.block(row, 'bot_grant_revoked', 'The bot\'s permissions no longer cover this revision.')
    if (dispatch.kind === 'consult') return this.prepareConsult(row, dispatch, definition, grant, payload)
    const selection = row.selection
    if (!selection) return refuse('bot_model_missing', 'No model was chosen for this activation.')
    // What runs: the revision's own permissions held inside the grant, so a narrower revision
    // narrows, plus what the owner allowed for this activation only, under what this computer lets bots do.
    const limit = this.limit()
    const effective = this.effectiveManifest(row, definition.permissions, grant.manifest, limit)
    const problem = manifestProblem(effective)
    if (problem) return this.block(row, 'bot_permissions_invalid', problem)
    const counters = this.store.counters(row.id)
    const remainingMs = effective.budget.maxActiveMs - counters.activeMs
    if (remainingMs < ACTIVE_TIME_CHUNK_MS) {
      // Under one 15-second slice left: a budget wall, so the owner can allow more time.
      this.raiseWall(row.id, this.timeWall(dispatch.n, effective))
      return refuse('active_time_exhausted', 'This bot used up its work time.')
    }
    const scratch = row.scratch ?? join(this.store.directory, 'scratch', row.id)
    const compiled = compileBotThread({
      grant: effective,
      digest: grant.digest,
      thread: definition.main,
      scratch,
      profileHome: this.host.profileHome,
      nativeNames: (tools) => this.nativeNames(selection.instanceId, tools),
      // The limits that run: the activation's scopes hold the shared counts and spend.
      remaining: { ...limitsOf(effective), deadlineMs: remainingMs },
      filesFolder: this.filesFolder(row.botId),
      // A chat turn is the bot's front desk: it hands what takes long to work (docs/plans/bot-always-free.md).
      // The owner's threads: reading in every lane; starting, messaging and stopping only in a chat turn the owner's own
      // message started (`chat:`), never in work, a reminder's work, a schedule or the bot's first message.
      botTools: { escalate: true, consult: definition.context.length > 0, memory: true, frontDesk: row.lane === 'chat', threads: ownerChatTurn(row) ? 'all' : 'read' },
      limit
    })
    if (!compiled.ok) return this.block(row, 'policy_unenforceable', compiled.error.reason ?? compiled.error.message)
    const checked = this.host.harness.checkPolicy(selection.instanceId, { mode: 'default', origin: 'bot', ...compiled.policy }, selection.model)
    if (!checked.ok) return this.block(row, 'policy_unenforceable', checked.error.reason ?? checked.error.message)
    // A chat activation starts from a cleared home context: the transcript stays, the turn carries
    // no thread history, and the pack supplies what it needs (bot-context.md §5.1).
    const cleared = row.lane === 'chat' && dispatch.kind === 'start'
    if (cleared) {
      try {
        if (!this.host.clearContext) throw new Error('the home context cannot be cleared here')
        this.host.clearContext(dispatch.threadId)
      } catch (error) {
        return this.block(row, 'bot_context_not_cleared', error instanceof Error ? error.message : String(error))
      }
    }
    // Active time is charged before it is used: the whole remaining allowance at the start, so a
    // crash can never leave it under-charged; settlement refunds what the dispatch did not use.
    const startedAt = this.now()
    const started = this.store.db.transaction(() => {
      const changed = this.store.run(
        'UPDATE bot_dispatches SET started_at = ?, deadline_ms = ?, prepaid_ms = ?, checkpoint_at = ?, run_id = COALESCE(run_id, ?) WHERE activation_id = ? AND n = ? AND started_at IS NULL',
        startedAt, remainingMs, remainingMs, startedAt, payload.runId, row.id, dispatch.n
      )
      if (changed) this.store.run('UPDATE bot_counters SET active_ms = active_ms + ? WHERE activation_id = ?', remainingMs, row.id)
      return changed > 0
    })
    if (!started) return refuse('bot_dispatch_started', 'This dispatch already started.')
    // A refusal this dispatch starts with the permission for is answered (a reload, a retry or a restart that began
    // after the owner's Allow): its report is the report, and no further turn follows for it.
    this.forgetRefused(row.id, effective)
    const controller = new AbortController()
    const deadline = startedAt + remainingMs
    // At the deadline the dispatch ends at a budget wall: the owner may allow more time. The timer
    // runs on the daemon loop; the supervisor (outside it) kills what is left of the process group.
    // A dispatch that made no progress for a while is checked first: with no internet it waits
    // instead, as its time went on waiting, not on work.
    const timer = (this.host.setTimer ?? defaultTimer)(() => {
      const live = this.live.get(row.id)
      if (this.host.connectivity && live?.n === dispatch.n && this.monotonic() - live.lastProgressMono >= BOT_OFFLINE_STALL_MS) {
        void this.deadlineOffline(row.id, dispatch.n, effective).catch((error: unknown) => {
          console.warn('a bot dispatch\'s internet check failed at its deadline', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
          this.raiseWall(row.id, this.timeWall(dispatch.n, effective))
        })
        return
      }
      this.raiseWall(row.id, this.timeWall(dispatch.n, effective))
    }, remainingMs)
    // Armed before the runtime starts: a process reported on a thread with nothing armed is refused.
    try {
      this.host.supervision?.arm({ dispatchId: dispatch.clientRequestId, activationId: row.id, deadlineAt: deadline })
    } catch (error) {
      console.warn('the bot supervisor could not be armed', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
    const counterScope = this.wallingCounters(new BotCounterScope(this.store, row.id), row.id, dispatch.n)
    const spendLimited = spendLimits(effective)
    const spendScope = Object.keys(spendLimited).length ? this.wallingSpend(new BotSpendScope(this.store, row.id, payload.runId), row.id, dispatch.n) : null
    const startedMono = this.monotonic()
    this.live.set(row.id, {
      controller, timer, startedMono, startedAt, checkpointMono: startedMono, n: dispatch.n, deadline, counters: counterScope, spend: spendScope, dispatchId: dispatch.clientRequestId,
      lastProgressMono: startedMono, workedMono: startedMono, offlineChecks: 0, steering: new Map(), steerSeq: 0, compactions: 0, regiven: 0
    })
    this.liveRuns.set(payload.runId, row.id)
    this.watchOffline(row.id, dispatch.n)
    const authority = this.authorityFor({
      row, mainN: dispatch.n, role: 'activation', permissions: compiled.permissions, grantDigest: grant.digest, startedWith: effective,
      controller, deadline, counters: counterScope, spend: spendScope,
      contexts: definition.context.map((thread) => ({ key: thread.key, title: thread.title })),
      dispatchId: dispatch.clientRequestId,
      mcpTools: this.offeredMcp(compiled.permissions.mcp)
    })
    const pack = this.packs.get(row.id)
    const browser = compiled.permissions.browser ? this.browserTurn(row, payload.runId, controller.signal) : undefined
    return {
      activationId: row.id,
      dispatchN: dispatch.n,
      // A leading `/` never runs a command: the trigger is text for the model.
      prompt: dispatch.prompt.text.startsWith('/') ? ` ${dispatch.prompt.text}` : dispatch.prompt.text,
      // What the owner allows now, from the permissions this dispatch runs with: a chat turn is told what its work
      // holds (it hands those jobs off), a run what it holds itself, and whether its browser could be offered.
      ...this.instructionsOf(definition, definition.main, row.lane, {
        allowed: { ...botAllowedOf(narrowManifest(effective, definition.main.narrow), (ids) => this.mcpServerNames(ids)), here: limit },
        ...(row.lane !== 'chat' && compiled.permissions.browser && !browser ? { browserOffline: true } : {})
      }),
      selection: { ...selection },
      policy: compiled.policy,
      authority,
      scratch,
      skills: compiled.permissions.skills,
      history: dispatch.kind === 'start' ? (cleared ? 'cleared' : 'none') : 'thread',
      lane: row.lane,
      ...(pack ? { preamble: pack } : {}),
      ...(browser ? { browser } : {}),
      steer: this.steerFor(row, dispatch.n)
    }
  }

  // -- What reaches a running turn (notes, and the pack again after a compaction) ----------------

  /**
   * The steer of the main dispatch `n` (`PreparedBotTurn.steer`): the owner's notes to running work, and after the
   * runtime compacted the turn's context, the memory pack and the job's brief again. It offers text only while the
   * dispatch is live and its activation runs: a Stop, a wall or the deadline ends it first. A note is marked read in
   * `bots.db` only when the model read it (`accepted`), so it is delivered once: what the turn never read waits for the
   * dispatch's end and goes on with the continuation, as before.
   */
  private steerFor(row: BotActivationRow, n: number): BotTurnSteer {
    const liveNow = (): LiveDispatch | undefined => {
      const live = this.live.get(row.id)
      if (!live || live.n !== n || live.controller.signal.aborted) return undefined
      return this.store.activation(row.id)?.status === 'running' ? live : undefined
    }
    // Read after a Stop too: what the model already read stays read.
    const ownLive = (): LiveDispatch | undefined => {
      const live = this.live.get(row.id)
      return live?.n === n ? live : undefined
    }
    return {
      attached: () => {
        const live = liveNow()
        if (live) live.steerable = true
      },
      peek: () => {
        const live = liveNow()
        return live ? this.steerNext(row, live)?.text : undefined
      },
      take: () => {
        const live = liveNow()
        const next = live ? this.steerNext(row, live) : undefined
        if (!live || !next) return undefined
        const token = `${row.id}:d${n}:s${++live.steerSeq}`
        live.steering.set(token, { ids: next.ids, ...(next.regiveFor !== undefined ? { regiveFor: next.regiveFor } : {}) })
        if (next.ids.length) {
          const offered = this.offeredNotes.get(row.id) ?? new Set<number>()
          for (const id of next.ids) offered.add(id)
          this.offeredNotes.set(row.id, offered)
        }
        return { text: next.text, token }
      },
      accepted: (token) => {
        const live = ownLive()
        const taken = live?.steering.get(token)
        if (!live || !taken) return
        live.steering.delete(token)
        if (taken.regiveFor !== undefined) live.regiven = Math.max(live.regiven, taken.regiveFor)
        if (!taken.ids.length) return
        this.notOffered(row.id, taken.ids)
        try {
          this.store.applyWorkNotes(taken.ids)
        } catch (error) {
          console.warn('a note the work read could not be marked read', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
        }
        this.changed({ botId: row.botId, activationId: row.id })
      },
      handedBack: (token) => {
        const live = ownLive()
        // The runtime says the turn never had it: it is no repeat when it goes again.
        this.notOffered(row.id, live?.steering.get(token)?.ids ?? [])
        live?.steering.delete(token)
      },
      compacted: () => {
        const live = liveNow()
        if (live) live.compactions += 1
      },
      compacting: (active) => {
        const live = ownLive()
        if (live) live.compactingSince = active ? this.now() : undefined
      }
    }
  }

  /** Notes no longer in doubt: read, or handed back unread. */
  private notOffered(activationId: string, ids: readonly number[]): void {
    const offered = this.offeredNotes.get(activationId)
    if (!offered) return
    for (const id of ids) offered.delete(id)
    if (!offered.size) this.offeredNotes.delete(activationId)
  }

  /**
   * What goes into the live turn next, if anything: the pack and brief again when a compaction since the last re-give
   * has not been answered (once per compaction, several in a row given once), then the owner's notes not taken yet. Notes
   * wait for the dispatch's end with under 30 seconds of its time left, as they did before.
   */
  private steerNext(row: BotActivationRow, live: LiveDispatch): { text: string; ids: number[]; regiveFor?: number } | undefined {
    const outstanding = [...live.steering.values()]
    const taken = new Set(outstanding.flatMap((entry) => entry.ids))
    const regive = live.compactions > live.regiven && !outstanding.some((entry) => entry.regiveFor !== undefined) ? this.regiveText(row) : undefined
    const notes = row.lane === 'run' && live.deadline - this.now() >= 2 * ACTIVE_TIME_CHUNK_MS
      ? this.store.pendingWorkNotes(row.id).filter((note) => !taken.has(note.id))
      : []
    if (!regive && !notes.length) return undefined
    const parts = [...(regive ? [regive] : []), ...(notes.length ? [noteSteerText(notes.map((note) => note.text))] : [])]
    return { text: parts.join('\n\n'), ids: notes.map((note) => note.id), ...(regive ? { regiveFor: live.compactions } : {}) }
  }

  /**
   * The activation's memory pack and its request again, for a turn whose context the runtime just compacted: what the
   * first message of the activation carried, which a compaction keeps only as a summary. Read from `bots.db` now, so a
   * message the owner forgot since is not given back.
   */
  private regiveText(row: BotActivationRow): string {
    const pack = this.packs.get(row.id)?.trim()
    const request = this.store.dispatch(row.id, 1)?.prompt.text.trim()
    const added = row.lane === 'run'
      ? this.store.all('SELECT text FROM bot_work_notes WHERE activation_id = ? AND applied_at IS NOT NULL ORDER BY id', row.id).map((entry) => String(entry.text).trim()).filter(Boolean)
      : []
    return [
      '[Mousse] Your context was just summarised to make room. Here again is your memory and what you were asked, so you keep to them. Nothing about the job changed; carry on where you left off.',
      ...(pack ? [pack] : []),
      ...(request ? [`What you were asked:\n${request}`] : []),
      ...(added.length ? [`What the owner added since:\n${added.map((text) => `- ${text}`).join('\n')}`] : [])
    ].join('\n\n')
  }

  /**
   * Where a note to work reaches it (`work_note`'s answer to the chat): `now` while it runs on a turn that takes notes
   * as it works (at its next step), `step_end` when its current turn cannot take them and gets them when it ends,
   * `start` when it waits to start or to go on.
   */
  noteReach(botId: string, workId: string): 'now' | 'after_compaction' | 'step_end' | 'start' {
    const row = this.store.activation(workId)
    if (!row || row.botId !== botId || row.status !== 'running') return 'start'
    const live = this.live.get(row.id)
    if (!(live?.steerable && !live.controller.signal.aborted && live.deadline - this.now() >= 2 * ACTIVE_TIME_CHUNK_MS)) return 'step_end'
    // The runtime is compacting the turn's context: the note goes in once it ends, or at its time limit.
    return live.compactingSince !== undefined && this.now() - live.compactingSince < BOT_COMPACTION_HOLD_MS ? 'after_compaction' : 'now'
  }

  /** The bot's own browser for one dispatch; none when it can't be offered (never a failed turn). */
  private browserTurn(row: BotActivationRow, runId: string, signal: AbortSignal): PreparedBotTurn['browser'] {
    const homeThreadId = this.store.registry(row.botId)?.homeThreadId
    if (!homeThreadId || !this.host.browser) return undefined
    try {
      return this.host.browser.turn({ botId: row.botId, activationId: row.id, lane: row.lane, homeThreadId, runId, signal })
    } catch (error) {
      console.warn('the bot browser could not be offered to a turn', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  /** The time wall of an activation's dispatch, from its current limits. */
  private timeWallAt(row: BotActivationRow, dispatchN: number): { dispatchN: number; kind: BotWallKind; permission: BotPermissionRequest; reason: string } {
    const definition = this.host.definitions.revision(row.botId, row.revision)
    const grant = this.store.activeGrant(row.botId)
    const amount = definition && grant ? this.effectiveManifest(row, definition.permissions, grant.manifest).budget.maxActiveMs : undefined
    return { dispatchN, kind: 'budget', permission: { budget: { key: 'maxActiveMs', ...(amount ? { amount } : {}) } }, reason: 'This bot used up its work time.' }
  }

  /** The time wall of a dispatch: its card offers twice the work time (the owner's Allow). */
  private timeWall(dispatchN: number, effective: BotManifest): { dispatchN: number; kind: BotWallKind; permission: BotPermissionRequest; reason: string } {
    return { dispatchN, kind: 'budget', permission: { budget: { key: 'maxActiveMs', amount: effective.budget.maxActiveMs } }, reason: 'This bot used up its work time.' }
  }

  /**
   * A thread's instructions: the bot's system text (its name, description and files folder, then
   * the base instructions), its role when that says more than its description (a bot made before the
   * Bot UI), then the thread's own. Built at each dispatch, so a rename applies at the next turn.
   */
  private instructionsOf(definition: BotDefinition, thread: BotThreadSpec, lane?: BotLane, permissions?: { allowed: BotAllowed; browserOffline?: boolean }): { instructions?: string } {
    let system: string | undefined
    try {
      system = this.host.instructions?.({ name: definition.name, description: definition.description, filesFolder: this.filesFolder(definition.id), ...(lane ? { lane } : {}), ...permissions })
    } catch {
      system = undefined
    }
    const own = 'instructions' in thread.agent ? thread.agent.instructions : undefined
    const role = system && definition.role.trim() === definition.description.trim() ? undefined : definition.role.trim()
    const parts = [system?.trim(), role, own?.trim()].filter((part): part is string => Boolean(part))
    return parts.length ? { instructions: [...new Set(parts)].join('\n\n') } : {}
  }

  /**
   * A consult (PR 6 §5): the context thread's narrowed grant, under the main dispatch's counts,
   * spend and deadline, on the main dispatch's model. It attaches to its main dispatch only while
   * that one is unsettled, and charges no time of its own.
   */
  private prepareConsult(row: BotActivationRow, dispatch: BotDispatchRow, definition: BotDefinition, grant: { digest: string; manifest: BotManifest }, payload: BotTurnPayload): PreparedBotTurn | { refused: string; code: string } {
    const refuse = (code: string, refused: string) => ({ code, refused })
    const main = this.live.get(row.id)
    const thread = this.store.allThreads().find((entry) => entry.threadId === dispatch.threadId && entry.role === 'context')
    const spec = thread ? definition.context.find((entry) => entry.key === contextKey(thread.key)[0]) : undefined
    if (!main || main.n !== dispatch.mainN || main.controller.signal.aborted) return refuse('bot_consult_orphaned', 'The dispatch this consult belongs to has ended.')
    if (!spec) return refuse('bot_consult_unknown', 'This context thread is not part of the bot.')
    const selection = row.selection
    if (!selection) return refuse('bot_model_missing', 'No model was chosen for this activation.')
    const limit = this.limit()
    const effective = this.effectiveManifest(row, definition.permissions, grant.manifest, limit)
    const remainingMs = main.deadline - this.now()
    if (remainingMs <= 0) return refuse('active_time_exhausted', 'This bot used up its work time.')
    const scratch = row.scratch ?? join(this.store.directory, 'scratch', row.id)
    const compiled = compileBotThread({
      grant: effective,
      digest: grant.digest,
      thread: spec,
      scratch,
      profileHome: this.host.profileHome,
      nativeNames: (tools) => this.nativeNames(selection.instanceId, tools),
      remaining: { ...limitsOf(effective), deadlineMs: remainingMs },
      filesFolder: this.filesFolder(row.botId),
      botTools: { escalate: true, consult: false, memory: true },
      limit
    })
    if (!compiled.ok) return refuse('policy_unenforceable', compiled.error.reason ?? compiled.error.message)
    const checked = this.host.harness.checkPolicy(selection.instanceId, { mode: 'default', origin: 'bot', ...compiled.policy }, selection.model)
    if (!checked.ok) return refuse('policy_unenforceable', checked.error.reason ?? checked.error.message)
    // The start marker, only while the main dispatch is unsettled: a consult attaches before the
    // settlement and is waited for, or is refused and starts nothing.
    const attached = this.store.db.transaction(() => {
      const open = this.store.get('SELECT 1 AS open FROM bot_dispatches WHERE activation_id = ? AND n = ? AND settled_by IS NULL', row.id, main.n)
      if (!open) return false
      return this.store.run('UPDATE bot_dispatches SET started_at = ?, run_id = COALESCE(run_id, ?) WHERE activation_id = ? AND n = ? AND started_at IS NULL', this.now(), payload.runId, row.id, dispatch.n) > 0
    })
    if (!attached) return refuse('bot_consult_orphaned', 'The dispatch this consult belongs to has ended.')
    // A consult is a dispatch of its own for supervision, under its main dispatch's deadline.
    try {
      this.host.supervision?.arm({ dispatchId: dispatch.clientRequestId, activationId: row.id, deadlineAt: main.deadline })
    } catch (error) {
      console.warn('the bot supervisor could not be armed', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
    this.executing.add(`${row.id}:${dispatch.n}`)
    this.liveRuns.set(payload.runId, row.id)
    const authority = this.authorityFor({
      row, mainN: main.n, role: 'context', permissions: compiled.permissions, grantDigest: grant.digest, startedWith: effective,
      controller: main.controller, deadline: main.deadline, counters: main.counters, spend: main.spend, contexts: [],
      // A consult's calls are chips of its main dispatch's message.
      dispatchId: main.dispatchId
    })
    return {
      activationId: row.id,
      dispatchN: dispatch.n,
      prompt: dispatch.prompt.text.startsWith('/') ? ` ${dispatch.prompt.text}` : dispatch.prompt.text,
      // A consult is never given MCP tools (its authority offers none): it is told so, never that it holds them.
      ...this.instructionsOf(definition, spec, undefined, { allowed: { ...botAllowedOf(narrowManifest(effective, spec.narrow), (ids) => this.mcpServerNames(ids)), mcpNotHere: true, here: limit } }),
      selection: { ...selection },
      policy: compiled.policy,
      authority,
      scratch,
      skills: compiled.permissions.skills,
      history: 'thread',
      lane: row.lane
    }
  }

  /**
   * What an activation runs with: the revision held inside the grant, plus its "Allow this time" overlays, under what
   * this computer lets bots do (`limit`, read now when not given). The ceiling comes last, so no overlay adds back
   * what is switched off here; the grant itself is never changed by it.
   */
  private effectiveManifest(row: BotActivationRow, revision: BotManifest, granted: BotManifest, limit: BotComputerLimit = this.limit()): BotManifest {
    let manifest = intersectManifest(revision, granted)
    for (const overlay of this.store.overlays(row.id)) manifest = withPermission(manifest, overlay.permission, overlay.amount ?? undefined)
    return withinComputerLimit(manifest, limit)
  }

  /**
   * What the activation may use now, read at call time: its revision held inside the active grant. Undefined when the
   * grant it runs under is no longer the active one (the owner removed something in About): nothing is held then.
   */
  private grantNow(activationId: string): BotManifest | undefined {
    const current = this.store.activation(activationId)
    const grant = current ? this.store.activeGrant(current.botId) : undefined
    if (!current || !grant || grant.digest !== current.grantDigest) return undefined
    const definition = this.host.definitions.revision(current.botId, current.revision)
    return definition ? this.effectiveManifest(current, definition.permissions, grant.manifest) : undefined
  }

  /** The names of the servers `ids` names that are set up now; a removed one is left out. */
  private mcpServerNames(ids: readonly string[]): string[] {
    if (!this.host.mcp) return []
    try {
      const servers = this.host.mcp.servers()
      // A grant made before identities names the bare installation.
      return ids.flatMap((id) => servers.filter((server) => server.serverId === id || server.installationId === id).map((server) => server.name))
    } catch {
      return []
    }
  }

  /**
   * `mcp_servers`: the owner's MCP servers a bot may hold tools of, each with a line of Mousse's own (how many tools,
   * and a few of their names), whether the bot holds its tools (all, some: it has new ones, or none), and whether it is
   * answering. No schema, description or other text of the server's. Read at call time against the active grant.
   */
  async mcpServerList(botId: string, lane: BotLane): Promise<BotMcpListing> {
    if (!this.host.mcp) return { servers: [], note: 'Your owner has no MCP servers set up in Mousse here.' }
    await this.host.mcp.warm()
    const grant = this.store.activeGrant(botId)?.manifest
    const held = new Set((grant?.mcp ?? []).map((pair) => `${pair.serverId}::${pair.tool}`))
    const servers = this.host.mcp.servers().map((server) => {
      // As the grant holds it: under the server's id now, or (a grant made before identities) its installation.
      const holds = server.tools.filter((tool) => held.has(`${server.serverId}::${tool.tool}`) || held.has(`${server.installationId}::${tool.tool}`)).length
      const changed = !holds && [...held].some((pair) => {
        const id = pair.slice(0, pair.indexOf('::'))
        return id !== server.serverId && id !== server.installationId && installationOf(id) === server.installationId
      })
      const names = server.tools.slice(0, 4).map((tool) => tool.tool)
      const about = server.starting
        ? 'still starting: its tools are loading'
        : server.tools.length
          ? `${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}, such as ${names.join(', ')}${server.tools.length > names.length ? ', …' : ''}`
          : server.unusable.length ? 'no tools you can use' : 'no tools known yet'
      const yours: BotMcpListing['servers'][number]['yours'] = !server.tools.length ? 'no' : holds === server.tools.length ? 'yes' : holds ? 'some: it has new tools' : changed ? 'no: it changed since you were allowed it' : 'no'
      return { server: server.name, id: server.serverId, about, yours, ...(server.failing ? { answering: false as const } : {}), ...(server.starting ? { starting: true as const } : {}) }
    })
    const read = this.host.mcp.listed?.() !== false
    const note = !servers.length
      ? read ? 'Your owner has no MCP servers set up in Mousse for you to use.' : 'Your owner\'s MCP servers are still being read. Call mcp_servers again in a moment.'
      : lane === 'chat'
        ? 'Servers marked yes are your work\'s: hand jobs that need them to work_start. For any other, ask once with escalate ({"mcp": {"server": "<name>"}}) and hand the job off once the owner has answered. A server still starting can be asked for too: the owner sees its tools once it has listed them.'
        : 'Use the tools of servers marked yes. For any other, ask once with escalate ({"mcp": {"server": "<name>"}}), carry on without it, and say so in your report. A server still starting can be asked for too: the owner sees its tools once it has listed them.'
    return { servers, note }
  }

  /** The granted MCP tools (`<server id>::<tool>`) a turn is offered: of servers set up for the whole profile now. */
  private offeredMcp(pairs: readonly string[]): BotMcpTool[] {
    if (!this.host.mcp || !pairs.length) return []
    try {
      return this.host.mcp.offered(new Set(pairs))
    } catch (error) {
      console.warn('a bot turn starts without its MCP tools: they could not be listed', { error: error instanceof Error ? error.message : String(error) })
      return []
    }
  }

  /**
   * An ask for the owner's MCP tools as Mousse asks for it (`mcpAskFor`): one per server, by the id or name the bot
   * gave, for every tool the server offers now that the activation's grant (read now) does not hold. A server whose
   * every tool the grant holds is that ask with all of them, which the callers answer as held. A server or tool that is
   * not set up here is refused, with no card.
   */
  private mcpAsk(activationId: string, named: BotMcpAsk & { server?: string }): { asked: BotPermissionRequest } | { refused: string } {
    const mcp = this.host.mcp
    if (!mcp) return { refused: BOT_MCP_UNAVAILABLE_TEXT }
    let servers: BotMcpServer[]
    let listed = true
    try {
      servers = mcp.servers()
      listed = mcp.listed?.() !== false
    } catch {
      servers = []
    }
    // Not read since Mousse started (a bot without MCP permissions does not read them at its turn's start): nothing is
    // asked now, and they are read for the bot's next try.
    if (!listed) void mcp.warm()
    const held = new Set((this.grantNow(activationId)?.mcp ?? []).map((pair) => `${pair.serverId}::${pair.tool}`))
    const resolved = mcpAskFor(servers, named, held, listed)
    if ('refused' in resolved) return resolved
    if ('held' in resolved) {
      const holds = (tool: string) => held.has(`${resolved.held.serverId}::${tool}`)
      // As the grant holds it: under the server's id now, or (a grant made before identities) its installation.
      const serverId = resolved.held.tools.every((tool) => holds(tool.tool)) ? resolved.held.serverId : resolved.held.installationId
      return { asked: { mcp: { serverId, name: resolved.held.name, tools: resolved.held.tools.map((tool) => tool.tool) } } }
    }
    // A card that waits for its server's tools: they are filled in as soon as the server answers.
    if (resolved.ask.loading) this.watchMcp()
    return { asked: { mcp: resolved.ask } }
  }

  /** Follows the owner's MCP servers while a card waits for a server's tools (`fillMcpAsks`). */
  private watchMcp(): void {
    const mcp = this.host.mcp
    if (!mcp?.onChange || this.mcpWatch?.mcp === mcp || this.closed) return
    this.mcpWatch?.stop()
    this.mcpWatch = { mcp, stop: mcp.onChange(() => this.fillMcpAsks()) }
  }

  /**
   * Every open MCP ask whose server had not answered when it was made: once the server has listed its tools, the card
   * is filled in with every tool a bot can be offered that the bot lacks (and what their hints say), and Allow turns on.
   * One whose tools the bot holds by now is settled as allowed. A server that failed, was removed, or offers no tool a
   * bot can use keeps its card open with Allow off, saying so; Not now answers it.
   */
  fillMcpAsks(): void {
    const mcp = this.host.mcp
    if (!mcp || this.closed) return
    const waiting = this.store.escalations({ status: 'open' }).filter((row) => waitsForTools(row.permission))
    if (!waiting.length) return
    let servers: BotMcpServer[]
    try {
      servers = mcp.servers()
    } catch {
      return
    }
    const walls: string[] = []
    for (const row of waiting) {
      const asked = (row.permission as { mcp: BotMcpAsk }).mcp
      const server = findServer(servers, asked.serverId)
      if (server?.starting) continue
      const grant = this.store.activeGrant(row.botId)?.manifest
      const held = new Set((grant?.mcp ?? []).map((pair) => `${pair.serverId}::${pair.tool}`))
      const resolved = server ? mcpAskFor(servers, { serverId: server.serverId }, held) : undefined
      const filled = resolved && 'ask' in resolved && !resolved.ask.loading ? { mcp: resolved.ask } as BotAskRequest : undefined
      const fingerprint = filled ? askFingerprintOf(filled) : undefined
      if (resolved && 'held' in resolved) {
        if (!this.store.answerEscalation(row.id, 'allowed_bot')) continue
        if (row.mode === 'wall') walls.push(row.activationId)
      } else if (filled && (fingerprint === row.fingerprint || !this.store.openAsk(row.botId, fingerprint!))) {
        const text = askText(filled)
        this.store.reword(row.id, { permission: filled, fingerprint: fingerprint!, title: text.title, note: text.note })
      } else {
        // Allow stays off, and the card says why.
        const name = server?.name ?? asked.name ?? 'The server'
        const note = !server ? `${name} isn't set up in Mousse any more, so there is nothing to allow.`
          : server.failing || !(server.tools.length + server.unusable.length) ? `${name} isn't answering, so its tools aren't listed yet. Allow turns on once they are.`
            : `None of ${name}'s tools can be used by a bot, so there is nothing to allow.`
        if (row.note === note) continue
        this.store.reword(row.id, { permission: row.permission, fingerprint: row.fingerprint, title: row.title ?? askText(row.permission).title, note })
      }
      this.republishAsk(row.id)
      this.changed({ botId: row.botId, activationId: row.activationId })
    }
    for (const activationId of walls) void this.advance(activationId).catch((error: unknown) => {
      console.warn('a bot chat could not go on after its MCP ask was settled', { activationId, error: error instanceof Error ? error.message : String(error) })
    })
  }

  /** A turn was refused `asked`: if the owner allows it before the turn ends, the activation continues with it. */
  private refused(activationId: string, asked: BotAskRequest): void {
    if ('budget' in asked || isSpecialAsk(asked)) return
    const permission = filesAskOf(grantRequestOf(asked))
    const asks = this.refusedAsks.get(activationId) ?? new Map<string, BotAskRequest>()
    asks.set(askFingerprintOf(permission), permission)
    this.refusedAsks.set(activationId, asks)
  }

  /** A dispatch of the activation starts with `started`: what it was refused and now holds is no longer waited for. */
  private forgetRefused(activationId: string, started: BotManifest): void {
    const asks = this.refusedAsks.get(activationId)
    if (!asks) return
    for (const [fingerprint, asked] of asks) if (grantHolds(started, asked)) asks.delete(fingerprint)
    if (!asks.size) this.refusedAsks.delete(activationId)
  }

  /**
   * What the activation's turns were refused that its next turn would have, as card titles ("run commands"): held by
   * the active grant and offered by its runtime. They are forgotten when a dispatch starts with them, or it ends.
   */
  private allowedSinceRefused(row: BotActivationRow): string[] {
    const asks = this.refusedAsks.get(row.id)
    const now = asks ? this.grantNow(row.id) : undefined
    if (!asks || !now) return []
    return [...asks.values()].filter((asked) => grantHolds(now, asked) && !this.withheld(row, asked)).map((asked) => askText(asked).title)
  }

  /**
   * Whether the runtime the activation runs on would not offer `asked` to its next turn although the grant holds it
   * (Claude Code locked for bots withholds commands where its sandbox can't run).
   */
  private withheld(row: BotActivationRow, asked: BotAskRequest): boolean {
    if (!('tool' in asked) || typeof asked.tool !== 'string' || !row.selection) return false
    try {
      return (this.host.harness.botWithheldTools?.(row.selection.instanceId) ?? []).some((tool) => tool === botGrantTool(asked.tool as string))
    } catch {
      return false
    }
  }

  /**
   * The authority a turn of the activation runs under. Every allowed call feeds the activity chips.
   * A gate refusal the owner can answer becomes an ask: in the chat lane a wall (the owner is there:
   * the dispatch ends and the answer continues it), in the run lane a refusal (the call fails, one
   * ask waits for the owner, and the run carries on). Budget walls end the dispatch in both lanes.
   */
  private authorityFor(input: {
    row: BotActivationRow
    mainN: number
    role: BotThreadRole
    permissions: Parameters<typeof createBotAuthority>[0]['permissions']
    grantDigest: string
    controller: AbortController
    deadline: number
    counters: CounterScope
    spend: SpendScope | null
    contexts: Array<{ key: string; title: string }>
    dispatchId: string
    /** What the turn's activation was allowed when the turn started (before a chat turn's front-desk narrowing). */
    startedWith: BotManifest
    /** The granted MCP tools the turn is offered (`BotMcp.offered`); none in a chat turn. */
    mcpTools?: readonly BotMcpTool[]
  }): BotAuthority {
    const { row, controller } = input
    const activity: BotActivityContext = { botId: row.botId, activationId: row.id, dispatchId: input.dispatchId }
    const base = createBotAuthority({
      activationId: row.id,
      role: input.role,
      permissions: input.permissions,
      waiting: () => this.store.activation(row.id)?.status === 'waiting_grant',
      // Every call: the grant must still be the one the activation runs under, and the dispatch live.
      live: () => {
        const current = this.store.activation(row.id)
        const digest = this.store.activeGrant(row.botId)?.digest
        // "Allow" on an ask moves the activation to the wider grant; it stays live under it.
        if (digest !== input.grantDigest && digest !== current?.grantDigest) return { kind: 'revoked' }
        const status = current?.status
        if (status === 'paused') return { kind: 'paused' }
        if (status === 'waiting_grant') return { kind: 'waiting' }
        if (controller.signal.aborted || status !== 'running') return { kind: 'ended' }
        // The model changes now (`set_depth`/`use_model`, scope now): this dispatch ends and continues on it.
        if (current?.reloadPending) {
          controller.abort(new BotReloadAbort())
          return { kind: 'ended' }
        }
        return undefined
      },
      counters: input.counters,
      time: { deadline: () => input.deadline, signal: controller.signal },
      spend: input.spend,
      // What this computer lets bots do, on every call: a switch turned off refuses this turn's next call.
      limit: () => this.limit()
    })
    const observe = (call: NormalisedCall): void => {
      const sink = this.host.activity
      if (!sink) return
      try {
        sink.onAllowed(activity, chipCallOf(call))
      } catch {
        // Chips never stop a call.
      }
    }
    // A new bot's first message (`bots.create`'s activation, every dispatch of it: a reload or a retry continues it)
    // answers no request of the owner's.
    const firstMessage = row.idempotencyKey.startsWith('create:')
    /**
     * What a turn is told about `asked` when the bot's grant holds it now, though this turn does not (issue #983): no
     * card, and no count against the ask caps. A turn keeps the permissions it started with. A chat turn hands commands,
     * the web and the browser to work, which has them (the chat is never offered them). Otherwise the activation
     * continues with it once its turn ends (`advance`), unless its runtime would not offer it then. Undefined when the
     * grant does not hold it.
     */
    const heldNow = (asked: BotAskRequest): string | undefined => {
      // Switched off on this computer: nothing to hold or ask for, whatever the grant says.
      const off = switchedOff(this.limit(), asked)
      if (off) return notOnThisComputerText(off)
      const now = this.grantNow(row.id)
      if (!now || !grantHolds(now, asked)) return undefined
      const workOnly = row.lane === 'chat' && frontDeskLacks(asked)
      if (workOnly && input.role === 'activation') return BOT_WORK_HAS_TEXT
      if (grantHolds(input.startedWith, asked) || this.withheld(row, asked)) return BOT_ASK_HELD_UNAVAILABLE_TEXT
      if (!workOnly) this.refused(row.id, asked)
      if (input.role === 'context') return BOT_ASK_HELD_CONSULT_TEXT
      return row.lane === 'chat' ? BOT_ASK_HELD_CHAT_TEXT : BOT_ASK_HELD_NEXT_TEXT
    }
    const check = (call: NormalisedCall): BotCheck => {
      this.progress(row.id)
      const decided = base.check(call)
      if (decided.ok) {
        observe(call)
        return decided
      }
      if ('refused' in decided || !ESCALATABLE.has(decided.wall.kind)) return decided
      // Only app tools a bot can be granted are worth asking for; any other is just refused.
      if (call.kind === 'app' && !BOT_APP_TOOLS.has(botGrantTool(call.tool))) return decided
      let permission = permissionOfWall(call, decided.wall)
      if (!permission) return decided
      // An MCP tool is asked for as its server, with every tool it offers now; one that is not here is refused, no card.
      if ('mcp' in permission) {
        const resolved = this.mcpAsk(row.id, permission.mcp)
        if ('refused' in resolved) return { ok: false, refused: { text: resolved.refused, askId: '' } }
        permission = resolved.asked
      }
      // No turn asks for what the bot's grant already holds, and a new bot's first message asks for nothing at all.
      const held = heldNow(permission)
      if (held) return { ok: false, refused: { text: held, askId: '' } }
      if (firstMessage) return { ok: false, refused: { text: BOT_ASK_NOT_YET_TEXT, askId: '' } }
      if (row.lane === 'run') {
        this.refused(row.id, permission)
        return this.raiseAsk(row, input.mainN, 'gate', permission, wallMessage(decided.wall))
      }
      return { ok: false, wall: this.raiseWall(row.id, { dispatchN: input.mainN, kind: 'gate', permission, reason: wallMessage(decided.wall) }) }
    }
    const readOnly = threadsReadOnlyOf(row)
    const authority: BotAuthority = {
      ...base,
      ...(input.mcpTools?.length ? { mcpTools: input.mcpTools } : {}),
      // Why a start, message or Stop of the owner's threads is refused in this turn, in its own words.
      ...(readOnly ? { threadsReadOnly: readOnly } : {}),
      // Whether the turn still holds an app tool now, asking nobody and showing no chip (a wait that ended after Remove).
      stillHolds: (tool) => {
        const decided = base.check({ kind: 'app', tool, args: {} })
        return decided.ok ? undefined : checkMessage(decided)
      },
      check,
      held: (asked) => {
        this.progress(row.id)
        return heldNow(asked as BotAskRequest)
      },
      checkAny: (calls: readonly NormalisedCall[]) => {
        this.progress(row.id)
        let refused: BotCheckDenied | undefined
        for (const call of calls) {
          const decided = base.check(call)
          if (decided.ok) {
            observe(call)
            return decided
          }
          refused ??= decided
        }
        // Every name was refused: the wall or ask is raised once, for the first.
        return calls.length ? check(calls[0]) : refused ?? { ok: false, wall: { kind: 'ended' } }
      },
      escalate: (request) => {
        this.progress(row.id)
        const problem = askProblem(request.permission)
        if (problem) return `${problem} ${whatToAskText(this.limit())}`
        // A new bot's first message answers no request: it asks once the owner wants something that needs more.
        if (firstMessage) return BOT_ASK_NOT_YET_TEXT
        const live = base.check({ kind: 'app', tool: 'escalate', args: {} })
        if (!live.ok && ('refused' in live || live.wall.kind !== 'tool')) return checkMessage(live)
        // An ask for any browser tool is the one "use the browser" ask.
        let asked = grantRequestOf(request.permission as BotAskRequest)
        // The owner's MCP tools: one ask per server, for every tool it offers now that the bot lacks. A server or tool
        // that is not set up here is refused now, with no card, in both lanes.
        if ('mcp' in asked) {
          if (!this.host.mcp) return BOT_MCP_UNAVAILABLE_TEXT
          const resolved = this.mcpAsk(row.id, asked.mcp as BotMcpAsk & { server?: string })
          if ('refused' in resolved) return resolved.refused
          asked = resolved.asked
        }
        // A Mousse tool no bot can hold is refused now, before the owner sees a card it can't grant.
        if ('tool' in asked && !isNeutralTool(asked.tool) && !BOT_APP_TOOLS.has(asked.tool))
          return `A bot can't be given the Mousse tool ${asked.tool}. Carry on without it.`
        // Switched off on this computer: no card, whatever the grant holds; asking would not help.
        const off = switchedOff(this.limit(), asked)
        if (off) return notOnThisComputerText(off)
        // File access is one permission: a bot that has it has every folder already.
        if ('path' in asked && base.workspace?.computer) return BOT_FILES_HELD_TEXT
        // What the bot already holds is no ask: a card for it would grant nothing. In a chat turn its work holds more
        // than the chat is offered (the web, the browser, commands): the chat hands that work off instead.
        if (heldAlready(base, asked)) return `The owner already allowed this (${askText(asked).title}). Use it now.`
        const held = heldNow(asked)
        if (held) return held
        const reason = request.reason.trim() || 'The bot did not say why.'
        if (row.lane === 'run') {
          this.refused(row.id, asked)
          const refused = this.raiseAsk(row, input.mainN, 'escalate', asked, reason, request.toolCallId)
          if (!('refused' in refused)) return checkMessage(refused as BotCheckDenied)
          return refused.refused.askId ? 'Asked the owner. Carry on without it and say in your report what you skipped.' : refused.refused.text
        }
        return this.deferWall(row.id, { dispatchN: input.mainN, permission: asked, reason, ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}) })
      },
      contexts: input.contexts
    }
    if (input.role === 'activation' && input.contexts.length)
      authority.consult = (request) => this.consult({ row, mainN: input.mainN, controller }, request)
    return authority
  }

  /** The activation's counter: a refused count is a budget wall. */
  private wallingCounters(scope: CounterScope, activationId: string, mainN: number): CounterScope {
    return {
      charge: (kind: CountKind, limit?: number): ChargeResult => {
        this.progress(activationId)
        const charged = scope.charge(kind, limit)
        if (!charged.ok) {
          const key: BotBudgetWallKey = kind === 'request' ? 'maxTurns' : 'maxToolCalls'
          this.raiseWall(activationId, { dispatchN: mainN, kind: 'budget', permission: { budget: { key, amount: charged.limit } }, reason: `This bot reached its limit of ${charged.limit} ${kind === 'request' ? 'model requests' : 'tool calls'}.` })
        }
        return charged
      }
    }
  }

  /** The activation's spend ledger: a refused reservation is a budget wall. */
  private wallingSpend(scope: BotSpendScope, activationId: string, mainN: number): SpendScope {
    return {
      reserve: (request: SpendRequest, limits: SpendLimits): ReserveResult => {
        this.progress(activationId)
        const reserved = scope.reserve(request, limits)
        if (!reserved.ok) {
          const key: BotBudgetWallKey = reserved.limit.kind === 'input_tokens' ? 'maxInputTokens' : reserved.limit.kind === 'output_tokens' ? 'maxOutputTokens' : 'maxUsd'
          this.raiseWall(activationId, { dispatchN: mainN, kind: 'budget', permission: { budget: { key } }, reason: 'This bot reached its spending limit.' })
        }
        return reserved
      },
      settle: (id, outcome) => {
        this.progress(activationId)
        return scope.settle(id, outcome)
      }
    }
  }

  // -- No internet (docs/bots.md) ----------------------------------------------------------------

  /**
   * The live dispatch did something (a call checked or finished, a model request): it is making progress, and working.
   */
  private progress(activationId: string): void {
    const live = this.live.get(activationId)
    if (!live) return
    live.lastProgressMono = this.monotonic()
    live.offlineChecks = 0
    this.working(activationId, live)
  }

  /**
   * The live dispatch is known to be working now. The moment is kept in `bots.db` too (`checkpoint_at`, at most once a
   * second), so a dispatch a crash ends is charged up to it at the next start, never to its deadline, and at most one
   * look (`BOT_OFFLINE_WATCH_MS`) short of its real work.
   */
  private working(activationId: string, live: LiveDispatch): void {
    live.workedMono = this.monotonic()
    if (live.workedMono - live.checkpointMono < BOT_CHECKPOINT_EVERY_MS) return
    live.checkpointMono = live.workedMono
    try {
      this.store.checkpointDispatch(activationId, live.n, live.startedAt + Math.ceil(live.workedMono - live.startedMono))
    } catch (error) {
      // A call never fails for its record: without it, a crash charges up to the previous one.
      console.warn('a bot dispatch\'s last working moment could not be recorded', { activationId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * A call of a live dispatch's run (or a consult's) finished (`tool.status` in the run log): it was working until now.
   */
  toolCallEnded(runId: string): void {
    const activationId = this.liveRuns.get(runId)
    if (activationId) this.progress(activationId)
  }

  /**
   * Until when a live dispatch was working, on the monotonic clock: its last known working moment, or, as Mousse stops
   * (`shutdown`), now, unless it was waiting for the internet then (its calls stopped and a check found it gone).
   */
  private workedUntil(live: LiveDispatch, shutdown: boolean): number {
    return shutdown && live.offlineChecks === 0 ? this.monotonic() : live.workedMono
  }

  /**
   * A dispatch Mousse stops while it runs (the profile closes) is charged up to the shutdown, the last moment it is known
   * to have worked (`workedUntil`), as the next start charges one a crash ended up to its last recorded moment. Settled
   * once: its run's end refunds nothing more.
   */
  private chargeToLastCall(activationId: string, live: LiveDispatch): void {
    const dispatch = this.store.dispatch(activationId, live.n)
    if (!dispatch || dispatch.deadlineMs === null || dispatch.prepaidMs === null) return
    const used = Math.max(0, Math.min(dispatch.deadlineMs, Math.ceil(this.workedUntil(live, true) - live.startedMono)))
    this.store.db.transaction(() => {
      if (this.store.run("UPDATE bot_dispatches SET used_ms = ?, prepaid_ms = ?, settled_by = 'run' WHERE activation_id = ? AND n = ? AND settled_by IS NULL", used, used, activationId, live.n))
        this.store.run('UPDATE bot_counters SET active_ms = active_ms + ? WHERE activation_id = ?', used - dispatch.prepaidMs!, activationId)
    })
  }

  /** Whether the internet is there for the activation's provider; always, without `connectivity`. Never throws. */
  private async online(row: BotActivationRow): Promise<boolean> {
    const connectivity = this.host.connectivity
    if (!connectivity) return true
    try {
      return await connectivity.online({ ...(row.selection ? { instanceId: row.selection.instanceId } : {}) })
    } catch {
      return false
    }
  }

  /** Looks at the live main dispatch `n` once a watch from now (`BOT_OFFLINE_WATCH_MS`), as long as it runs. */
  private watchOffline(activationId: string, n: number): void {
    const live = this.live.get(activationId)
    if (!live || live.n !== n || live.controller.signal.aborted) return
    live.watch?.clear()
    live.watch = (this.host.setTimer ?? defaultTimer)(() => {
      void this.checkStalled(activationId, n).catch((error: unknown) => {
        console.warn('a bot dispatch\'s internet check failed', { activationId, error: error instanceof Error ? error.message : String(error) })
      })
    }, BOT_OFFLINE_WATCH_MS)
  }

  /**
   * One look at a live dispatch. While it makes calls, or runs one long call with the internet there (a 40-minute
   * command), it is working: the moment is recorded (`working`), so a crash under-charges it by one look at most. A
   * dispatch that made no call for `BOT_OFFLINE_STALL_MS` is checked: two failed checks in a row end it to wait for the
   * internet, and that time is not recorded as work. Any call in between starts the count again.
   */
  private async checkStalled(activationId: string, n: number): Promise<void> {
    const live = this.live.get(activationId)
    if (!live || live.n !== n || live.controller.signal.aborted) return
    if (this.monotonic() - live.lastProgressMono < BOT_OFFLINE_STALL_MS) {
      live.offlineChecks = 0
      this.working(activationId, live)
      return this.watchOffline(activationId, n)
    }
    const row = this.store.activation(activationId)
    if (!row || row.status !== 'running') return
    // Without `connectivity` the internet always counts as there.
    const online = await this.online(row)
    if (this.live.get(activationId) !== live || live.controller.signal.aborted) return
    if (online || this.monotonic() - live.lastProgressMono < BOT_OFFLINE_STALL_MS) {
      live.offlineChecks = 0
      this.working(activationId, live)
      return this.watchOffline(activationId, n)
    }
    live.offlineChecks += 1
    if (live.offlineChecks < OFFLINE_CHECKS_TO_STOP) return this.watchOffline(activationId, n)
    this.stopForInternet(row, live)
  }

  /** The deadline of a dispatch that made no progress: with no internet it waits; otherwise the time wall. */
  private async deadlineOffline(activationId: string, n: number, effective: BotManifest): Promise<void> {
    const row = this.store.activation(activationId)
    const live = this.live.get(activationId)
    if (!row || row.status !== 'running' || !live || live.n !== n || live.controller.signal.aborted) return
    const online = await this.online(row)
    if (this.live.get(activationId) !== live || live.controller.signal.aborted) return
    if (online) {
      // A run that made no call at all in its whole time was stuck, not working: it ends without
      // asking for more time. One that worked asks, as before.
      if (row.lane === 'run' && live.lastProgressMono === live.startedMono) {
        this.budgetEnd(row, { ...this.timeWall(n, effective), reason: 'This bot made no progress.' }, { stuck: true })
        return
      }
      this.raiseWall(activationId, this.timeWall(n, effective))
      return
    }
    this.stopForInternet(this.store.activation(activationId) ?? row, live)
  }

  /**
   * Ends a live dispatch to wait for the internet: only the time up to its last call is charged,
   * the activation waits (its one notice is posted), and its run ends as at a wall. `advance`
   * then waits for the internet and continues the turn once it is back.
   */
  private stopForInternet(row: BotActivationRow, live: LiveDispatch): void {
    live.watch?.clear()
    if (!this.enterOffline(row)) return
    live.offline = { chargeMs: Math.max(0, Math.ceil(live.lastProgressMono - live.startedMono)) }
    live.controller.abort(new BotWallAbort('bot_offline'))
  }

  /**
   * The activation waits for the internet: its `end_reason` says so and its chat gets one notice
   * (once per activation, however often it waits). No error row, no failure, no time.
   */
  private enterOffline(row: BotActivationRow): boolean {
    const entered = this.recorded(row, () => {
      if (!this.store.setOffline(row.id, true)) return false
      this.chat.post({ id: `bm_${row.id}_offline`, botId: row.botId, author: 'bot', kind: 'notice', text: BOT_OFFLINE_TEXT, activationId: row.id, lane: row.lane })
      return true
    }) ?? false
    if (entered) this.changed({ botId: row.botId, activationId: row.id })
    return entered
  }

  /** The activation waits for the internet, and checks again later. */
  private awaitInternet(row: BotActivationRow): void {
    if (!this.enterOffline(row)) return
    this.armInternetCheck(row.id)
  }

  /** The next internet check of a waiting activation: after 15 s, then 30 s, then every minute. */
  private armInternetCheck(activationId: string, attempt = 0): void {
    if (this.offlineTimers.has(activationId)) return
    const delay = Math.min(BOT_OFFLINE_POLL_MAX_MS, BOT_OFFLINE_POLL_MS * 2 ** attempt)
    const timer = (this.host.setTimer ?? defaultTimer)(() => {
      if (this.offlineTimers.get(activationId) === timer) this.offlineTimers.delete(activationId)
      void this.checkInternet(activationId, attempt).catch((error: unknown) => {
        console.warn('a waiting bot could not check the internet', { activationId, error: error instanceof Error ? error.message : String(error) })
        this.armInternetCheck(activationId, attempt + 1)
      })
    }, delay)
    this.offlineTimers.set(activationId, timer)
  }

  private clearInternetCheck(activationId: string): void {
    this.offlineTimers.get(activationId)?.clear()
    this.offlineTimers.delete(activationId)
  }

  /** A waiting activation checks the internet: back, it carries on; still gone, it checks again later. */
  private async checkInternet(activationId: string, attempt: number): Promise<void> {
    const row = this.store.activation(activationId)
    if (!row || row.status !== 'running' || !row.offline) return
    if (!(await this.online(row))) return this.armInternetCheck(activationId, attempt + 1)
    await this.resumeOnline(activationId)
  }

  /**
   * The internet is back: a dispatch that was never sent is sent now; one that ended while the
   * internet was gone is continued (`advance`, then a continuation on the same thread).
   */
  private async resumeOnline(activationId: string): Promise<void> {
    const row = this.store.activation(activationId)
    if (!row || row.status !== 'running' || !row.offline) return
    if (this.live.has(row.id)) return
    const main = this.store.lastMainDispatch(row.id)
    if (main && main.runId === null && main.startedAt === null && !this.receiptRun(main.clientRequestId)) {
      await this.sendDispatch(row, main)
      return
    }
    await this.advance(row.id)
  }

  /**
   * In `advance`: a main dispatch that ended while the internet was gone (Mousse ended it, or its
   * provider could not be reached) waits for the internet instead of failing, and continues when
   * it is back. True when handled; false when the internet is there and the failure is the
   * provider's own (it fails as before).
   */
  private async offlineEnd(row: BotActivationRow, main: BotDispatchRow): Promise<boolean> {
    if (!this.host.connectivity) return false
    const online = await this.online(row)
    const current = this.store.activation(row.id)
    if (!current || current.status !== 'running') return true
    if (online && !current.offline) return false
    // The ended dispatch's own message is not posted: its turn goes on in the continuation.
    this.drained.delete(`${row.id}:${main.n}`)
    if (online) {
      this.clearInternetCheck(row.id)
      await this.continueWith(row.id, ['running'], { network: true })
      return true
    }
    this.awaitInternet(current)
    return true
  }

  // -- Walls and asks ---------------------------------------------------------------------------

  /**
   * A wall (PR 6 §5; Bot Phase 1 §5.4): in one `bots.db` transaction the ask is written (or the
   * bot's open ask for the same permission is taken over) and the activation moves to
   * `waiting_grant`; then the dispatch ends (its run ends `interrupted` by `bot_wall`, and its
   * consults stop with it). Asks never expire. The sixth wall of an activation ends it `blocked`
   * instead. The returned wall is what the refused call tells the model.
   */
  raiseWall(activationId: string, input: { dispatchN: number; kind: BotWallKind; permission: BotAskRequest; reason: string; toolCallId?: string }): WallReason {
    const current = this.store.activation(activationId)
    if (current?.lane === 'run' && input.kind === 'budget') return this.budgetEnd(current, input)
    let raised: ReturnType<BotEngine['wallInTransaction']>
    try {
      raised = this.store.db.transaction(() => this.wallInTransaction(activationId, ['running'], input))
    } catch (error) {
      const row = this.store.activation(activationId)
      if (row && isJournalFailure(error)) this.journalFailed(row)
      else throw error
      return { kind: 'ended' }
    }
    if (raised.kind === 'none') {
      const status = this.store.activation(activationId)?.status
      return status === 'waiting_grant' ? { kind: 'waiting' } : status === 'paused' ? { kind: 'paused' } : { kind: 'ended' }
    }
    this.afterWall(activationId, raised)
    // Outside a turn (before it started) no reply follows: the card is posted now.
    if (raised.kind === 'wall' && !this.live.has(activationId)) this.announceWall(raised.escalation)
    return raised.kind === 'wall' ? { kind: 'escalated', permission: this.chat.card(raised.escalation).title } : { kind: 'ended' }
  }

  /** A wall raised outside a turn (a continuation or the startup pass): its card on a notice row, once per activation. */
  private announceWall(escalation: BotEscalationRow): void {
    if (this.store.messagesForAsk(escalation.id).some((message) => message.activationId === escalation.activationId)) return
    const row = this.store.activation(escalation.activationId)
    if (!row) return
    const name = this.host.definitions.revision(row.botId, row.revision)?.name ?? 'This bot'
    this.recorded(row, () => this.chat.post({ botId: row.botId, author: 'bot', kind: 'notice', text: `${name} wants to ${this.chat.card(escalation).title}.`, askId: escalation.id, activationId: row.id, lane: row.lane }))
  }

  /**
   * A time wall found while no turn runs (the startup pass): a run ends failed with its ask; a chat
   * waits for the owner, its card posted now.
   */
  private wallAtRest(row: BotActivationRow, input: { dispatchN: number; kind: BotWallKind; permission: BotPermissionRequest; reason: string }): void {
    if (row.lane === 'run') {
      this.budgetEnd(row, input)
      return
    }
    const raised = this.store.db.transaction(() => this.wallInTransaction(row.id, ['running'], input))
    if (raised.kind === 'none') return
    this.afterWall(row.id, raised)
    if (raised.kind === 'wall') this.announceWall(raised.escalation)
  }

  /**
   * A run reached a limit (§5.7): nobody is there to allow more now. Work the owner asked for (`work`, a reminder's
   * work) waits for the answer: it is `blocked` with `budget_exhausted`, which frees the run lane, and what it had so far
   * is posted with the ask that lets it go on (by its dispatch's reply when the turn ends, else at once). Allow carries
   * it on in the same thread (`settleRoomInTx`, `resumeWork`); Not now ends it with what was posted. After
   * a Not now in the last day, and for any other run, the run ends failed (a schedule's counts toward the failure
   * streak) with one ask that offers the higher limit for later runs ("work for up to 2 hours per run"). `stuck`: the run
   * made no call in its whole time, with the internet there; it ends failed with an error row and no ask (more time
   * would not help). The dispatch ends now; its scratch goes once its run has stopped.
   */
  private budgetEnd(row: BotActivationRow, input: { dispatchN: number; kind: BotWallKind; permission: BotAskRequest; reason: string }, options: { stuck?: boolean } = {}): WallReason {
    if (row.status !== 'running') return row.status === 'waiting_grant' ? { kind: 'waiting' } : { kind: 'ended' }
    const name = this.host.definitions.revision(row.botId, row.revision)?.name ?? 'This bot'
    const live = this.live.get(row.id)
    // A turn that still runs posts what it had, with the card, when it ends; without one the notice is posted now.
    const replyComes = live !== undefined && !live.controller.signal.aborted
    let ended = false
    let waits = false
    try {
      ended = this.store.db.transaction(() => {
        const fingerprint = askFingerprintOf(input.permission)
        const open = this.store.openAsk(row.botId, fingerprint)
        const cooling = open ? undefined : this.store.coolingAsk(row.botId, fingerprint, this.store.now())
        waits = !options.stuck && row.trigger.kind === 'work' && !cooling
        if (!this.store.moveActivation(row.id, ['running'], waits ? 'blocked' : 'failed', { endReason: options.stuck ? 'no_progress' : 'budget_exhausted' })) return false
        if (options.stuck) {
          this.chat.post({ botId: row.botId, author: 'bot', kind: 'error', text: '', error: { text: failureText('no_progress') }, activationId: row.id, lane: 'run', id: `bm_${row.id}_budget` })
        } else if (waits) {
          // The bot's one open ask for this limit is the one this work waits on: a run's is taken over, or one is written.
          // A chat waiting at a wall for the same limit keeps its card, and the work waits on that card too: its notice
          // carries it, and its answer settles the work (`settleRoomInTx`).
          if (open?.mode === 'ask') this.store.moveAsk(open.id, row.id, input.dispatchN)
          else if (!open) this.insertLimitAsk(row, input)
          if ('budget' in input.permission) this.roomKeys.set(row.id, input.permission.budget.key)
          if (!replyComes) this.postRoom(this.store.activation(row.id)!, input.dispatchN)
        } else if (!open && !cooling) {
          const ask = this.insertLimitAsk(row, input)
          this.chat.post({ botId: row.botId, author: 'bot', kind: 'notice', text: `I ran out of room on this run. ${name} wants to ${ask.title}.`, askId: ask.id, activationId: row.id, lane: 'run', id: `bm_${row.id}_budget` })
        } else {
          this.chat.post({ botId: row.botId, author: 'bot', kind: 'error', text: '', error: { text: 'I ran out of room on this run, so I stopped.' }, activationId: row.id, lane: 'run', id: `bm_${row.id}_budget` })
        }
        // Waiting work has not ended: its end is journaled when it does.
        if (!waits) this.journalEnd(row, options.stuck ? 'no_progress' : 'budget_exhausted')
        return true
      })
    } catch (error) {
      if (isJournalFailure(error)) this.journalFailed(row)
      else throw error
    }
    // Work hands back what it had (its last finished reply, when it was cut right after a call); any other run as before.
    live?.controller.abort(row.trigger.kind === 'work' && !options.stuck ? new BotRoomAbort() : new BotWallAbort())
    if (ended) {
      if (waits) this.letGoOfBrowser(row)
      else {
        this.countFailure(row)
        this.carried.delete(row.id)
      }
      this.packs.delete(row.id)
      this.changed({ botId: row.botId, activationId: row.id })
      this.pumpLater(row.botId)
    }
    return { kind: 'ended' }
  }

  /** A run's limit ask (mode `ask`): the higher limit, as its card shows it and Allow grants it. */
  private insertLimitAsk(row: BotActivationRow, input: { dispatchN: number; permission: BotAskRequest; reason: string }): { id: string; title: string } {
    const permission = this.limitAsk(row.botId, input.permission)
    const text = this.askCardText(row, permission)
    const id = `esc_${randomUUID()}`
    this.store.insertEscalation({
      id, botId: row.botId, activationId: row.id, dispatchN: input.dispatchN, toolCallId: null, kind: 'budget', permission, reason: input.reason.slice(0, 2000),
      createdAt: this.store.now(), expiresAt: null, mode: 'ask', fingerprint: askFingerprintOf(permission), title: text.title, note: text.note, messageId: null
    })
    return { id, title: text.title }
  }

  /** The open limit ask that work waiting for room owns (`budgetEnd` gave it to the work). */
  private roomAsk(row: BotActivationRow): BotEscalationRow | undefined {
    return this.store.escalations({ activationId: row.id, status: 'open' }).find((ask) => ask.kind === 'budget' && ask.mode === 'ask')
  }

  /**
   * The open ask work waiting for room goes on with: its own, else the bot's open ask for the limit it waits on (taken
   * over by later work, or a chat's wall for the same limit). None when nothing is open for it (`settleStrandedWork`).
   */
  private roomAskOf(row: BotActivationRow): BotEscalationRow | undefined {
    const own = this.roomAsk(row)
    if (own) return own
    const key = this.waitingOn(row)
    return key ? this.store.openAsk(row.botId, askFingerprintOf({ budget: { key } })) : undefined
  }

  /**
   * The limit work that waits for room waits on: the one `budgetEnd` recorded, else that of its own open ask, else that
   * of the newest limit card on its messages since its last turn started (a card it shares), else the first limit it
   * has used up. Spend limits are known only from the first three.
   */
  private waitingOn(row: BotActivationRow): BotBudgetWallKey | undefined {
    const kept = this.roomKeys.get(row.id)
    if (kept) return kept
    const own = this.roomAsk(row)
    if (own && 'budget' in own.permission) return own.permission.budget.key
    const since = this.store.lastMainDispatch(row.id)?.startedAt ?? 0
    for (const entry of this.store.all('SELECT id FROM bot_messages WHERE activation_id = ? AND ask_id IS NOT NULL ORDER BY seq DESC', row.id)) {
      const message = this.store.message(entry.id as string)
      if (!message?.askId || Date.parse(message.at) < since) break
      const ask = this.store.escalation(message.askId)
      if (ask && 'budget' in ask.permission) return ask.permission.budget.key
    }
    return this.exhaustedLimit(row)
  }

  /** The limit each piece of the bot's work that waits for room waits on, read before an answer widens the grant. */
  private waitingKeys(botId: string): Map<string, BotBudgetWallKey | undefined> {
    return new Map(this.store.activationsIn(botId, ['blocked']).filter((row) => workWaits(row) && row.endReason === 'budget_exhausted').map((row) => [row.id, this.waitingOn(row)]))
  }

  /**
   * What work that ran out of room posts (inside the caller's transaction) when no turn's reply will: one notice that
   * says so, with `body` (what it had, when no message showed it yet) and the card of its ask. A turn's reply says the
   * same with what the turn had (`postReply`); either is posted once per dispatch.
   */
  private postRoom(row: BotActivationRow, dispatchN: number, body = ''): void {
    const ask = this.roomAskOf(row)
    // A turn that reached the turn cap just before (its continuation ran out at once) gave its chips and words to this.
    const carried = this.carried.get(row.id)
    this.carried.delete(row.id)
    this.chat.post({
      id: `bm_${row.id}_room_d${dispatchN}`, botId: row.botId, author: 'bot', kind: 'notice', text: roomText(body || carried?.text || ''),
      ...(carried?.chips.length ? { chips: carried.chips } : {}),
      ...(ask ? { askId: ask.id } : {}),
      ...(row.trigger.kind === 'work' && row.trigger.replyTo ? { replyTo: row.trigger.replyTo } : {}),
      activationId: row.id, lane: 'run', ...(row.threadId ? { threadId: row.threadId } : {})
    })
  }

  /**
   * Waiting work lets go of the bot's browser, so the browser closes when nothing else uses it; when it goes on, its
   * next turn opens tabs of its own again.
   */
  private letGoOfBrowser(row: BotActivationRow): void {
    try {
      this.host.browser?.activationEnded({ botId: row.botId, activationId: row.id })
    } catch (error) {
      console.warn('the bot browser could not let go of waiting work', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * An ask for more room was answered, in the answer's own transaction (Allow, Not now, a message that counts as Not
   * now, `respond`, a chat wall's answer): every piece of work that waits on that limit (`waiting`, read before the
   * answer widened the grant) is settled, so none is left waiting on an ask that is gone. After an Allow, work that has
   * room now goes on when the run lane is free (`room_allowed`, then `pump`); work that still has none ends with a line
   * that says so. After Not now it ends with what it posted: the card says Not now.
   */
  private settleRoomInTx(botId: string, key: BotBudgetWallKey, allowed: boolean, waiting: ReadonlyMap<string, BotBudgetWallKey | undefined>): RoomSettled {
    const settled: RoomSettled = { ended: [], continued: [] }
    for (const row of this.store.activationsIn(botId, ['blocked'])) {
      if (!workWaits(row) || row.endReason !== 'budget_exhausted') continue
      if ((waiting.has(row.id) ? waiting.get(row.id) : this.waitingOn(row)) !== key) continue
      // Work that waited more than a day is not picked up again by an Allow: what it had is old, and it can be asked again.
      if (allowed && this.now() - this.waitingSince(row) > MAX_ROOM_WAIT_MS) {
        const ended = this.endWaitingInTx(row, 'waited_too_long', waitedTooLong(this.workTitle(row)))
        if (ended) settled.ended.push(ended)
        continue
      }
      if (allowed && this.hasRoom(row)) {
        if (this.store.moveActivation(row.id, ['blocked'], 'blocked', { endReason: 'room_allowed' })) settled.continued.push(row.id)
        continue
      }
      const ended = this.endWaitingInTx(row, 'budget_denied', allowed ? `I couldn't carry on with "${this.workTitle(row)}": it still has no room. Ask me again if you still want it.` : undefined)
      if (ended) settled.ended.push(ended)
    }
    return settled
  }

  /**
   * Ends work that waits to go on (inside the caller's transaction): failed with `reason`, journaled, and, when `line`
   * is given, one plain chat line that says why, answering the message that asked for it.
   */
  private endWaitingInTx(row: BotActivationRow, reason: string, line?: string): BotActivationRow | undefined {
    if (!this.store.moveActivation(row.id, ['blocked'], 'failed', { endReason: reason })) return undefined
    this.roomKeys.delete(row.id)
    this.usageWaits.delete(row.id)
    if (line) this.chat.post({
      id: `bm_${row.id}_ended`, botId: row.botId, author: 'bot', kind: 'notice', text: line,
      ...(row.trigger.kind === 'work' && row.trigger.replyTo ? { replyTo: row.trigger.replyTo } : {}),
      activationId: row.id, lane: 'run'
    })
    this.journalEnd(row, reason === 'budget_denied' ? 'budget_exhausted' : reason)
    return this.store.activation(row.id)
  }

  /** After `settleRoomInTx` committed: ended work lets go of what it held; work allowed to go on starts when the lane is free. */
  private afterRoom(botId: string, settled: RoomSettled | undefined): void {
    if (!settled) return
    for (const row of settled.ended) this.afterEnd(row)
    if (settled.continued.length) this.changed({ botId })
  }

  /**
   * Waiting work that nothing would wake or end (`maintain` and the startup pass): work that waits for room with no open
   * ask for its limit (its answer was lost), or for a usage limit's reset with no reset time to wait for. It ends with
   * one plain line, so no work waits forever.
   */
  private settleStrandedWork(): void {
    for (const row of this.store.activationsWith(['blocked']).filter(workWaits)) {
      try {
        // Nothing waits more than a week, whatever it waits for.
        if (this.now() - this.waitingSince(row) > MAX_WORK_WAIT_MS) {
          const ended = this.recorded(row, () => this.endWaitingInTx(row, 'waited_too_long', waitedTooLong(this.workTitle(row))))
          if (ended) this.afterEnd(ended)
          continue
        }
        let stranded = false
        if (row.endReason === 'budget_exhausted') {
          const key = this.waitingOn(row)
          stranded = !key || !this.store.openAsk(row.botId, askFingerprintOf({ budget: { key } }))
        } else if (row.endReason === 'usage_limit') {
          const registry = this.store.registry(row.botId)
          stranded = registry?.pausedReason === 'usage_limit' && !registry.pausedUntil
        }
        if (!stranded) continue
        const ended = this.recorded(row, () => this.endWaitingInTx(row, 'nothing_to_wait_for', `I stopped "${this.workTitle(row)}": nothing could let it carry on any more. Ask me again if you still want it.`))
        if (ended) this.afterEnd(ended)
      } catch (error) {
        console.warn('waiting bot work could not be checked', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /** When work started to wait: its last turn's end (or start), else when it was asked for (its first turn never went out). */
  private waitingSince(row: BotActivationRow): number {
    const main = this.store.lastMainDispatch(row.id)
    if (main?.endedAt) return Date.parse(main.endedAt)
    return main?.startedAt ?? Date.parse(row.createdAt)
  }

  /** Whether waiting work has room to go on under what it may use now: no limit used up, spend limits included. */
  private hasRoom(row: BotActivationRow): boolean {
    return this.exhaustedLimit(row) === undefined
  }

  /**
   * The first limit the activation has used up under what it may use now (its grant and overlays); none when it has room.
   * A spend limit counts as used up once what was spent and is held reaches it.
   */
  private exhaustedLimit(row: BotActivationRow): BotBudgetWallKey | undefined {
    const definition = this.host.definitions.revision(row.botId, row.revision)
    const grant = this.store.activeGrant(row.botId)
    if (!definition || !grant) return undefined
    const budget = this.effectiveManifest(row, definition.permissions, grant.manifest).budget
    const counters = this.store.counters(row.id)
    if (budget.maxActiveMs - counters.activeMs < ACTIVE_TIME_CHUNK_MS) return 'maxActiveMs'
    if (budget.maxTurns !== undefined && counters.requests >= budget.maxTurns) return 'maxTurns'
    if (budget.maxToolCalls !== undefined && counters.toolCalls >= budget.maxToolCalls) return 'maxToolCalls'
    if (budget.maxInputTokens === undefined && budget.maxOutputTokens === undefined && budget.maxUsd === undefined) return undefined
    const spent = new BotSpendScope(this.store, row.id).used()
    if (budget.maxInputTokens !== undefined && spent.input >= budget.maxInputTokens) return 'maxInputTokens'
    if (budget.maxOutputTokens !== undefined && spent.output >= budget.maxOutputTokens) return 'maxOutputTokens'
    if (budget.maxUsd !== undefined && spent.usd >= budget.maxUsd) return 'maxUsd'
    return undefined
  }

  /**
   * Waiting work goes on in its own thread (`pump` found the run lane free for it). After a usage limit its model is
   * chosen again, and a first dispatch that never went out (no model was free) is sent as it was.
   */
  private async resumeWork(row: BotActivationRow): Promise<void> {
    // A permission the owner allowed after the work was refused it reaches it now, and the work is told.
    const allowed = this.allowedSinceRefused(row)
    if (row.endReason !== 'usage_limit') {
      await this.continueWith(row.id, ['blocked'], { moreRoom: true, ...(allowed.length ? { allowed } : {}) })
      return
    }
    this.usageWaits.delete(row.id)
    this.store.markReload(row.id)
    const main = this.store.lastMainDispatch(row.id)
    if (main && main.runId === null && main.startedAt === null && !this.receiptRun(main.clientRequestId)) {
      if (!this.store.moveActivation(row.id, ['blocked'], 'running', { endReason: null })) return
      this.changed({ botId: row.botId, activationId: row.id })
      await this.sendDispatch(this.store.activation(row.id)!, main)
      return
    }
    await this.continueWith(row.id, ['blocked'], { usageReset: true, ...(allowed.length ? { allowed } : {}) })
  }

  /** The fingerprint of an ask: one open ask per bot and permission (a limit's by its key alone). */
  private fingerprintOf(_activationId: string, _kind: BotWallKind, permission: BotAskRequest): string {
    return askFingerprintOf(permission)
  }

  /**
   * A limit ask as its card shows it and Allow grants it: the amount the bot asked for, else the
   * current limit, and never more than the current limit (Allow at most doubles a limit).
   */
  private limitAsk<T extends BotAskRequest>(botId: string, permission: T): T {
    if (!('budget' in permission)) return permission
    const held = this.store.activeGrant(botId)?.manifest.budget[permission.budget.key]
    if (held === undefined) return permission
    return { budget: { key: permission.budget.key, amount: Math.min(permission.budget.amount ?? held, held) } } as T
  }

  /**
   * Whether a run may ask for `permission`: a skill must exist here (`knownAsk`). An MCP ask was made from the servers
   * set up now (`mcpAsk`), and lists the tools it grants, or waits for them (`loading`: its server has not answered).
   */
  private askable(permission: BotAskRequest): boolean {
    if ('mcp' in permission) return Boolean(permission.mcp.name && (mcpAskTools(permission.mcp).length || permission.mcp.loading))
    if (!('skill' in permission)) return true
    try {
      return this.host.knownAsk?.(permission) ?? true
    } catch {
      return false
    }
  }

  /** An ask in plain words for its card (`askText`), with the bot's current limits. */
  private askCardText(row: BotActivationRow, permission: BotAskRequest): { title: string; note: string } {
    const budget = this.store.activeGrant(row.botId)?.manifest.budget
    return askText(permission, budget ? { budget } : {})
  }

  /** The bot's open ask for `fingerprint` becomes this activation's wall, or a new one is written. */
  private openWall(row: BotActivationRow, asked: { dispatchN: number; kind: BotWallKind; permission: BotAskRequest; reason: string; toolCallId?: string }): BotEscalationRow {
    const input = { ...asked, permission: this.limitAsk(row.botId, filesAskOf(asked.permission)) }
    const fingerprint = this.fingerprintOf(row.id, input.kind, input.permission)
    const open = this.store.openAsk(row.botId, fingerprint)
    if (open) {
      if (open.activationId !== row.id || open.mode !== 'wall') this.store.moveAskToWall(open.id, row.id, input.dispatchN)
      return this.store.escalation(open.id)!
    }
    const text = this.askCardText(row, input.permission)
    const escalation = {
      id: `esc_${randomUUID()}`,
      botId: row.botId,
      activationId: row.id,
      dispatchN: input.dispatchN,
      toolCallId: input.toolCallId ?? null,
      kind: input.kind,
      permission: input.permission,
      reason: input.reason.slice(0, 2000),
      createdAt: this.store.now(),
      expiresAt: null,
      mode: 'wall' as const,
      fingerprint,
      title: text.title,
      note: text.note,
      messageId: null
    }
    this.store.insertEscalation(escalation)
    return this.store.escalation(escalation.id)!
  }

  private wallInTransaction(activationId: string, from: readonly BotActivationRow['status'][], input: { dispatchN: number; kind: BotWallKind; permission: BotAskRequest; reason: string; toolCallId?: string }): { kind: 'wall'; escalation: BotEscalationRow } | { kind: 'blocked' } | { kind: 'none' } {
    const row = this.store.activation(activationId)
    if (!row || !from.includes(row.status)) return { kind: 'none' }
    if (this.store.countEscalations(activationId) >= MAX_BOT_WALLS) {
      this.store.moveActivation(activationId, [row.status], 'blocked', { endReason: 'asked_too_often' })
      return { kind: 'blocked' }
    }
    const escalation = this.openWall(row, input)
    this.store.moveActivation(activationId, [row.status], 'waiting_grant', { endReason: 'wall' })
    return { kind: 'wall', escalation }
  }

  private afterWall(activationId: string, raised: { kind: 'wall'; escalation: BotEscalationRow } | { kind: 'blocked' }): void {
    // The dispatch ends now: its turn (and every consult, which shares the signal) is aborted.
    this.live.get(activationId)?.controller.abort(new BotWallAbort())
    const row = this.store.activation(activationId)
    if (raised.kind === 'blocked' && row) this.pumpLater(row.botId)
    if (raised.kind === 'wall') {
      if (raised.escalation.expiresAt) this.armExpiry(raised.escalation)
      const summary = this.escalationSummary(raised.escalation)
      try { this.events.emit('escalation', summary) } catch { /* a listener never undoes a wall */ }
    }
    this.changed({ ...(row ? { botId: row.botId } : {}), activationId })
  }

  /**
   * `escalate` in a chat turn: the ask is recorded and the turn goes on, so several asks ("ask me
   * now for everything you'll need") show as cards together under the turn's message; the dispatch
   * waits for the owner once its text is complete (`advance`).
   */
  private deferWall(activationId: string, input: { dispatchN: number; permission: BotAskRequest; reason: string; toolCallId?: string }): string {
    let result: 'asked' | 'too_many' | 'ended'
    try {
      result = this.store.db.transaction(() => {
        const row = this.store.activation(activationId)
        if (!row || row.status !== 'running') return 'ended'
        if (this.store.countEscalations(activationId) >= MAX_BOT_WALLS) return 'too_many'
        this.openWall(row, { ...input, kind: 'escalate' })
        return 'asked'
      })
    } catch (error) {
      const row = this.store.activation(activationId)
      if (row && isJournalFailure(error)) this.journalFailed(row)
      else throw error
      return wallMessage({ kind: 'ended' })
    }
    if (result === 'ended') return wallMessage(this.endedWall(activationId))
    if (result === 'too_many') return 'You have asked enough for this message. Finish it now.'
    const row = this.store.activation(activationId)
    this.changed({ ...(row ? { botId: row.botId } : {}), activationId })
    return BOT_ASK_DEFERRED_TEXT
  }

  /**
   * A run's call needs a permission the owner has not given (§5.4): the call is refused with a
   * plain tool error and the run carries on. The bot's open ask for that permission is reused;
   * otherwise one is written, with a notice row carrying its card ("<name> wants to …"), unless the
   * owner said Not now to it in the last 24 hours: then no card is made, and the bot is told the owner
   * said not now (never that it asked). The bot is told it asked only when a card is there.
   */
  private raiseAsk(row: BotActivationRow, dispatchN: number, kind: BotWallKind, asked: BotAskRequest, reason: string, toolCallId?: string): BotCheck {
    const permission = this.limitAsk(row.botId, filesAskOf(asked))
    const fingerprint = this.fingerprintOf(row.id, kind, permission)
    let raised: { askId: string; created: boolean } | { refused: string }
    try {
      raised = this.store.db.transaction(() => {
        const open = this.store.openAsk(row.botId, fingerprint)
        if (open) return { askId: open.id, created: false }
        if (this.store.coolingAsk(row.botId, fingerprint, this.store.now())) return { refused: BOT_ASK_NOT_NOW_TEXT }
        // Nobody watches a run: its asks are few, and never for a skill or MCP tool that is not here.
        if (!this.askable(permission)) return { refused: BOT_ASK_UNKNOWN_TEXT }
        if (this.store.countNewAsks(row.botId, { activationId: row.id }) >= MAX_RUN_ASKS ||
          this.store.countNewAsks(row.botId, { since: new Date(this.now() - 24 * 60 * 60_000).toISOString() }) >= MAX_BOT_ASKS_PER_DAY)
          return { refused: BOT_ASK_ENOUGH_TEXT }
        const text = this.askCardText(row, permission)
        const id = `esc_${randomUUID()}`
        this.store.insertEscalation({
          id, botId: row.botId, activationId: row.id, dispatchN, toolCallId: toolCallId ?? null, kind, permission, reason: reason.slice(0, 2000),
          createdAt: this.store.now(), expiresAt: null, mode: 'ask', fingerprint, title: text.title, note: text.note, messageId: null
        })
        const name = this.host.definitions.revision(row.botId, row.revision)?.name ?? 'This bot'
        this.chat.post({ botId: row.botId, author: 'bot', kind: 'notice', text: `${name} wants to ${text.title}.`, askId: id, activationId: row.id, lane: 'run', ...(row.threadId ? { threadId: row.threadId } : {}) })
        return { askId: id, created: true }
      })
    } catch (error) {
      if (isJournalFailure(error)) {
        this.journalFailed(row)
        return { ok: false, wall: { kind: 'ended' } }
      }
      throw error
    }
    // No ask was written: the call is refused, and no card waits for the owner.
    if ('refused' in raised) return { ok: false, refused: { text: raised.refused, askId: '' } }
    if (raised.created) this.changed({ botId: row.botId, activationId: row.id })
    return { ok: false, refused: { text: BOT_ASK_REFUSED_TEXT, askId: raised.askId } }
  }

  private armExpiry(escalation: BotEscalationRow): void {
    if (!escalation.expiresAt) return
    this.expiryTimers.get(escalation.id)?.clear()
    const wait = Math.max(0, Date.parse(escalation.expiresAt) - this.now())
    this.expiryTimers.set(escalation.id, (this.host.setTimer ?? defaultTimer)(() => this.expire(escalation.id), wait))
  }

  /** An escalation of an older build that nobody answered in time ends its activation `blocked`. Asks never expire. */
  private expire(escalationId: string): void {
    this.expiryTimers.delete(escalationId)
    const escalation = this.store.escalation(escalationId)
    if (!escalation) return
    const moved = this.store.db.transaction(() => {
      if (!this.store.answerEscalation(escalationId, 'expired')) return false
      return this.store.moveActivation(escalation.activationId, ['waiting_grant'], 'blocked', { endReason: 'escalation_expired' })
    })
    if (!moved) return
    const row = this.store.activation(escalation.activationId)
    this.changed({ ...(row ? { botId: row.botId } : {}), activationId: escalation.activationId })
    // The activation no longer holds its bot: the next one waiting starts.
    if (row) this.pumpLater(row.botId)
  }

  listEscalations(activationId?: string): BotEscalationSummary[] {
    return this.store.escalations(activationId ? { activationId } : {}).map((row) => this.escalationSummary(row))
  }

  private escalationSummary(row: BotEscalationRow): BotEscalationSummary {
    const card = this.chat.card(row)
    return {
      id: row.id,
      activationId: row.activationId,
      botId: row.botId,
      dispatchN: row.dispatchN,
      kind: row.kind,
      permission: row.permission,
      permissionText: isSpecialAsk(row.permission) ? card.title : permissionText(row.permission),
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      answeredAt: row.answeredAt,
      amount: row.amount,
      mode: row.mode,
      fingerprint: row.fingerprint,
      title: card.title,
      note: card.note,
      ...(row.messageId ? { messageId: row.messageId } : {})
    }
  }

  /**
   * The owner's answer to a wall (the v1 form's). "Allow for this bot" publishes a revision with
   * the permission and approves it in one action; "Allow this time" and "Allow N more" add an overlay
   * for this activation only; "Deny" records the denial. Every answer is followed by a continuation
   * dispatch, once the walled runs ended, no other ask of the activation is open, and no unknown
   * call is unacknowledged.
   */
  async respond(input: { escalationId: string; answer: BotEscalationAnswer; amount?: number }): Promise<{ escalation: BotEscalationSummary; activation: BotActivationSummary }> {
    const escalation = this.store.escalation(input.escalationId)
    if (!escalation) throw new BotEngineError('escalation_not_found', 'No escalation with that id.')
    if (escalation.status !== 'open') throw new BotEngineError('escalation_answered', 'This request was already answered or has expired.')
    const row = this.store.activation(escalation.activationId)
    if (!row || row.status !== 'waiting_grant') throw new BotEngineError('escalation_answered', 'This bot is no longer waiting for an answer.')
    const budget = 'budget' in escalation.permission
    if (input.answer === 'allow_more' && !budget) throw new BotEngineError('invalid_answer', 'Only a limit can be raised by an amount.')
    const amount = input.amount ?? ('budget' in escalation.permission ? escalation.permission.budget.amount : undefined)
    if (budget && input.answer !== 'deny' && (amount === undefined || !Number.isFinite(amount) || amount <= 0))
      throw new BotEngineError('invalid_answer', 'Say how much more to allow.')
    const special = isSpecialAsk(escalation.permission)
    // Allow never grants tools the owner has not seen: an MCP ask whose server has not listed them waits for them.
    if (input.answer !== 'deny' && waitsForTools(escalation.permission)) throw new BotEngineError('ask_not_ready', MCP_ASK_LOADING_TEXT)
    if (input.answer !== 'deny' && !special) {
      const problem = this.answerProblem(row, escalation.permission as BotPermissionRequest, amount)
      if (problem) throw new BotEngineError('invalid_answer', problem)
    }
    // A limit: the work that waits on it, read before the answer widens the grant.
    const limit = 'budget' in escalation.permission ? escalation.permission.budget.key : undefined
    const waiting = limit ? this.waitingKeys(row.botId) : undefined
    if (input.answer === 'allow_bot' && !special) this.allowForBot(row.botId, escalation.permission as BotPermissionRequest, amount)
    const status = input.answer === 'deny' ? 'denied' : input.answer === 'allow_bot' ? 'allowed_bot' : 'allowed_once'
    let settled: RoomSettled | undefined
    const answered = this.store.db.transaction(() => {
      if (!this.store.answerEscalation(escalation.id, status, amount)) return false
      if (!special && (input.answer === 'allow_once' || input.answer === 'allow_more')) this.store.putOverlay(row.id, escalation.id, escalation.permission, amount)
      this.journalAnswer(escalation, status === 'denied' ? 'not_now' : 'allow')
      // Work that waits on the same limit is settled with the answer: an overlay for this activation gives it no room.
      if (limit) settled = this.settleRoomInTx(row.botId, limit, status !== 'denied', waiting!)
      return true
    })
    if (!answered) throw new BotEngineError('escalation_answered', 'This request was already answered or has expired.')
    this.expiryTimers.get(escalation.id)?.clear()
    this.expiryTimers.delete(escalation.id)
    this.republishAsk(escalation.id)
    const held = input.answer === 'allow_bot' && !special ? this.settleHeldAsks(row.botId) : []
    this.afterRoom(row.botId, settled)
    this.changed({ botId: row.botId, activationId: row.id })
    await this.advance(row.id)
    for (const activationId of held) if (activationId !== row.id) await this.advance(activationId)
    if (settled?.continued.length) await this.pump(row.botId)
    return { escalation: this.escalationSummary(this.store.escalation(escalation.id)!), activation: this.activationSummary(this.store.activation(row.id)!) }
  }

  /**
   * The owner's answer to an ask card (`bots.asks.answer`, §5.4). Allow publishes the widened
   * revision and approves it (an `export_memory` ask grants nothing: the renderer then exports).
   * Not now records a deny; on a run's ask no new ask follows for 24 hours. A chat wall continues
   * once its last open card is answered; a run's ask needs no follow-up (the next run uses it).
   */
  async answerAsk(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<BotChatMessage | undefined> {
    const escalation = this.store.escalation(askId)
    if (!escalation || escalation.botId !== botId) throw new BotEngineError('ask_not_found', 'No such ask.')
    if (escalation.status !== 'open') throw new BotEngineError('ask_answered', 'This was already answered.')
    // A chat turn's asks are answered once its message (with their cards) is there.
    if (escalation.mode === 'wall' && this.store.activation(escalation.activationId)?.status === 'running')
      throw new BotEngineError('ask_not_ready', 'Wait until the bot finishes its message.')
    // Allow never grants tools the owner has not seen: an MCP ask whose server has not listed them waits for them.
    if (answer === 'allow' && waitsForTools(escalation.permission)) throw new BotEngineError('ask_not_ready', MCP_ASK_LOADING_TEXT)
    const special = isSpecialAsk(escalation.permission)
    // A limit: the work that waits on it, read before the answer widens the grant.
    const limit = 'budget' in escalation.permission ? escalation.permission.budget.key : undefined
    const waiting = limit ? this.waitingKeys(botId) : undefined
    let amount: number | undefined
    if (answer === 'allow' && !special) {
      const permission = escalation.permission as BotPermissionRequest
      // A limit grows by what the card said, at most doubling (the limit may have changed since it was asked).
      amount = 'budget' in permission ? this.limitAsk(botId, permission).budget.amount : undefined
      if ('budget' in permission && amount === undefined) throw new BotEngineError('invalid_answer', 'This limit cannot be raised.')
      this.allowForBot(botId, permission, amount)
    }
    const cooldown = answer === 'not_now' && escalation.mode === 'ask' ? new Date(this.now() + BOT_ASK_DENY_COOLDOWN_MS).toISOString() : undefined
    let settled: RoomSettled | undefined
    const answered = this.store.db.transaction(() => {
      if (!this.store.answerEscalation(escalation.id, answer === 'allow' ? 'allowed_bot' : 'denied', amount, cooldown)) return false
      this.journalAnswer(escalation, answer)
      // Work that waits for room goes on with the wider grant, or ends with what it posted, with the answer.
      if (limit) settled = this.settleRoomInTx(botId, limit, answer === 'allow', waiting!)
      return true
    })
    if (!answered) throw new BotEngineError('ask_answered', 'This was already answered.')
    const message = this.republishAsk(escalation.id)
    const held = answer === 'allow' ? this.settleHeldAsks(botId) : []
    this.afterRoom(botId, settled)
    this.changed({ botId, activationId: escalation.activationId })
    if (escalation.mode === 'wall') await this.advance(escalation.activationId)
    for (const activationId of held) if (activationId !== escalation.activationId) await this.advance(activationId)
    if (settled?.continued.length) await this.pump(botId)
    return message
  }

  /**
   * The bot's open asks its grant now holds, settled as allowed with their cards updated: after an
   * Allow (the other cards of the one file ask), and at startup for an older build's folder asks
   * of a bot that has file access. Returns the activations whose walls this answered, to go on.
   */
  private settleHeldAsks(botId: string): string[] {
    const grant = this.store.activeGrant(botId)
    if (!grant) return []
    const walls = new Set<string>()
    for (const ask of this.store.openAsks(botId)) {
      if (isSpecialAsk(ask.permission) || 'budget' in ask.permission) continue
      // An MCP ask waiting for its server's tools grants nothing yet, so the grant "holds" it trivially: it stays open.
      if (waitsForTools(ask.permission)) continue
      if (!manifestSubset(withPermission(grant.manifest, ask.permission), grant.manifest)) continue
      if (!this.store.answerEscalation(ask.id, 'allowed_bot')) continue
      if (ask.mode === 'wall') walls.add(ask.activationId)
      this.republishAsk(ask.id)
    }
    return [...walls]
  }

  /**
   * An older build asked for one folder at a time; file access is now one permission (§3.7). Each
   * open folder ask is worded as the one file ask, so its card and the bot's continuation say what
   * Allow grants. A bot that has file access already has it: its folder asks are settled as allowed,
   * and the startup pass continues the walls among them. Otherwise one stays open (the wall the
   * chat waits at, else the oldest) and the rest are withdrawn: one ask per permission is open.
   */
  upgradeFileAsks(): void {
    const ask = filesAsk()
    const fingerprint = askFingerprintOf(ask)
    const text = askText(ask)
    const reworded = { permission: ask, fingerprint, title: text.title, note: text.note }
    this.store.db.transaction(() => {
      const older = this.store.escalations({ status: 'open' }).filter((row) => 'path' in row.permission && row.fingerprint !== fingerprint)
      for (const botId of new Set(older.map((row) => row.botId))) {
        const mine = older.filter((row) => row.botId === botId)
        if (this.store.activeGrant(botId)?.manifest.workspace) {
          // Settled first: only an open ask's fingerprint is unique.
          for (const row of mine) if (this.store.answerEscalation(row.id, 'allowed_bot')) this.store.reword(row.id, reworded)
          continue
        }
        const keep = this.store.openAsk(botId, fingerprint) ? undefined : mine.find((row) => row.mode === 'wall') ?? mine[0]
        for (const row of mine) if (row !== keep) this.store.answerEscalation(row.id, 'withdrawn')
        if (keep) this.store.reword(keep.id, reworded)
      }
    })
  }

  /** Every chat row carrying an ask's card, again (its status changed); the newest one is returned. */
  private republishAsk(askId: string): BotChatMessage | undefined {
    let last: BotChatMessage | undefined
    for (const row of this.store.messagesForAsk(askId)) last = this.chat.republish(row.id) ?? last
    return last
  }

  private journalAnswer(escalation: BotEscalationRow, answer: 'allow' | 'not_now'): void {
    const title = escalation.title ?? permissionTextOf(escalation.permission)
    this.journalInTx({
      botId: escalation.botId, kind: 'answer', activationId: escalation.activationId, sourceKey: `ask:${escalation.id}:answer`, who: 'owner',
      text: `${answer === 'allow' ? 'Allowed' : 'Not now'}: ${title}`, json: { v: 1, askId: escalation.id, answer }
    })
  }

  /** The bot's open chat-lane walls, oldest first (a message sent instead of answering counts as Not now for them). */
  openChatWalls(botId: string): BotEscalationRow[] {
    const waiting = new Set(this.store.laneActivations(botId, 'chat', ['waiting_grant']).map((row) => row.id))
    return this.store.openAsks(botId).filter((ask) => ask.mode === 'wall' && waiting.has(ask.activationId))
  }

  /**
   * The owner wrote while the chat waited at a wall (§5.3.2): its open asks count as Not now, and
   * the walled dispatch continues with the owner's message as its next input. False when the chat
   * was not waiting.
   */
  async continueChatWith(botId: string, text: string, owner?: BotOwnerTurn): Promise<boolean> {
    const walls = this.openChatWalls(botId)
    if (!walls.length) return false
    const activationId = walls[0]!.activationId
    // A limit answered Not now ends the walled turn: the message starts a chat of its own.
    const limit = walls.some((wall) => wall.activationId === activationId && 'budget' in wall.permission)
    const waiting = limit ? this.waitingKeys(botId) : undefined
    const settled: RoomSettled[] = []
    const answered = this.store.db.transaction(() => {
      let any = false
      for (const wall of walls.filter((entry) => entry.activationId === activationId))
        if (this.store.answerEscalation(wall.id, 'denied')) {
          this.journalAnswer(wall, 'not_now')
          // Work that waits on the same limit as this wall ends with it: the message counts as Not now for it too.
          if ('budget' in wall.permission) settled.push(this.settleRoomInTx(botId, wall.permission.budget.key, false, waiting!))
          any = true
        }
      // A message from another device continues the turn: the rest of it is held to that device's limit too ("use your
      // threads"). One re-admitted after a restart carries no device and leaves the turn as it was.
      if (any && !limit && owner?.limit) this.store.narrowOwnerLimit(activationId, owner.limit)
      return any
    })
    if (!answered) return false
    for (const wall of walls) this.republishAsk(wall.id)
    for (const entry of settled) this.afterRoom(botId, entry)
    this.changed({ botId, activationId })
    if (limit) {
      await this.advance(activationId)
      return false
    }
    const row = this.store.activation(activationId)
    if (!row || row.status !== 'waiting_grant') return true
    // The walled turn is still letting go, or its end is still being recorded (its message not
    // written yet): its continuation, with this message, follows when it has.
    if (!this.allRunsEnded(row) || this.store.lastMainDispatch(row.id)?.endedAt == null || this.settling.has(row.id)) {
      this.ownerTexts.set(activationId, text)
      return true
    }
    const answers = this.store.pendingAnswers(activationId)
    // Only a continuation that was sent carries the message. One that paused, ended blocked (its grant changed while
    // it waited) or met a time wall did not: the caller then gives the message a turn of its own.
    return (await this.continueWith(activationId, ['waiting_grant'], { answers, ownerText: text })) === 'sent'
  }

  /**
   * The owner's message written while the chat waited at a wall, whose answer to the wall never ran
   * (Mousse stopped between the two): the walls count as Not now and the turn continues with it,
   * as `continueChatWith` would have. At startup, and when the owner sends the same message again.
   */
  async admitWallMessage(message: BotMessageRow): Promise<void> {
    if (message.author !== 'owner' || message.kind !== 'text' || !message.activationId) return
    const walled = this.openChatWalls(message.botId).some((wall) => wall.activationId === message.activationId && wall.createdAt <= message.at)
    if (walled) await this.continueChatWith(message.botId, messageInput(message, (id) => this.store.message(id)))
  }

  /**
   * The owner's message that answered a chat's wall by being sent (`continueChatWith`), read from
   * its rows, for when the copy kept in memory is gone (a restart): the newest owner row of the
   * activation, other than the one that started it, written while one of the denied `answers` was open.
   */
  private wallReplyOf(row: BotActivationRow, answers: readonly BotEscalationRow[]): string | undefined {
    if (row.lane !== 'chat') return undefined
    const denied = answers.filter((answer) => answer.status === 'denied' && answer.answeredAt)
    if (!denied.length) return undefined
    const owned = this.store.all("SELECT id FROM bot_messages WHERE activation_id = ? AND author = 'owner' AND kind = 'text' ORDER BY seq", row.id)
      .map((entry) => this.store.message(entry.id as string)).filter((message): message is BotMessageRow => message !== undefined)
    const input = (message: BotMessageRow) => messageInput(message, (id) => this.store.message(id))
    // The message that started the activation is its request, not a reply to its wall: found by its request id, as
    // its rebuilt input can differ from the one sent (a quoted message forgotten since).
    if (owned[0] && (row.idempotencyKey === `chat:${owned[0].clientRequestId}` || input(owned[0]) === row.trigger.input)) owned.shift()
    // A message an earlier continuation already carried is not sent twice.
    const sent = this.store.dispatches(row.id).filter((dispatch) => dispatch.kind === 'continue').map((dispatch) => dispatch.prompt.text)
    const reply = owned.reverse().find((message) => !sent.some((prompt) => prompt.endsWith(`\n\n${input(message)}`)) &&
      denied.some((answer) => answer.createdAt <= message.at && message.at <= answer.answeredAt!))
    return reply ? input(reply) : undefined
  }

  /** Why an answer cannot grant `permission`: the result would not be a valid manifest. */
  private answerProblem(row: BotActivationRow, permission: BotPermissionRequest, amount: number | undefined): string | undefined {
    const definition = this.host.definitions.revision(row.botId, row.revision)
    const grant = this.store.activeGrant(row.botId)
    if (!definition || !grant) return 'This bot\'s permissions changed; it cannot continue under them.'
    return manifestProblem(withPermission(this.effectiveManifest(row, definition.permissions, grant.manifest), permission, amount))
  }

  /**
   * "Allow": a revision with the permission is published and its grant approved, after every
   * thread is checked as at approval; the rest of the grant is not approved again. Unfinished
   * activations move to the wider grant. The draft gets the same permission; its other edits stay.
   */
  private allowForBot(botId: string, permission: BotPermissionRequest, amount: number | undefined): void {
    const entry = this.entry(botId)
    const published = entry.published
    const grant = this.store.activeGrant(botId)
    if (!published || !grant) throw new BotEngineError('bot_approval_required', 'Approve this bot\'s permissions first.')
    const wider = withPermission(grant.manifest, permission, amount)
    const problem = manifestProblem(wider)
    if (problem) throw new BotEngineError('invalid_answer', problem)
    const next: BotDefinition = { ...published, permissions: withPermission(published.permissions, permission, amount) }
    const refused = [next.main, ...next.context].map((thread) => this.checkThread(thread, wider, botId)).find((check) => !check.ok)
    if (refused) throw new BotEngineError('policy_unenforceable', refused.reason ?? 'A thread of this bot cannot hold its permissions.', { thread: refused.key })
    let revision: BotDefinition
    try {
      revision = this.host.definitions.publishRevision(next)
    } catch (error) {
      if (error instanceof BotDefinitionError) throw new BotEngineError('invalid_answer', error.message)
      throw error
    }
    const digest = botManifestDigest(wider)
    this.store.db.transaction(() => {
      this.store.setPublished(botId, revision.revision!)
      this.store.approve(botId, digest, wider)
      // The activations and their queued siblings move to the wider grant; nothing else changes for them.
      this.store.regrant(botId, grant.digest, digest, revision.revision!)
    })
    try {
      const draft = entry.draftHash === published.revision ? next : { ...entry.draft, permissions: withPermission(entry.draft.permissions, permission, amount) }
      this.host.definitions.save(draft, entry.draftHash)
    } catch (error) {
      console.warn('the bot draft was left as it was', { botId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * About → Remove (§5.4): the manifest narrows, the revision is published and the narrower grant
   * approved at once (narrowing never needs consent). A run under the wider grant ends at its next
   * call; queued work moves to the narrower grant.
   */
  narrowGrant(botId: string, narrower: (manifest: BotManifest) => BotManifest): void {
    const entry = this.entry(botId)
    const published = entry.published
    const grant = this.store.activeGrant(botId)
    if (!published || !grant) throw new BotEngineError('bot_approval_required', 'This bot has no permissions to remove.')
    const granted = narrower(grant.manifest)
    const next: BotDefinition = { ...published, permissions: intersectManifest(narrower(published.permissions), granted) }
    const revision = this.definitionCall(() => this.host.definitions.publishRevision(next))
    const digest = botManifestDigest(granted)
    // A running dispatch keeps the wider grant's digest, so its next call is refused as revoked;
    // queued work moves to the narrower grant, and so does work that waits to go on (with a dispatch it has not sent
    // yet): it goes on under what is approved now, never under the wider grant.
    this.store.db.transaction(() => {
      this.store.setPublished(botId, revision.revision!)
      this.store.approve(botId, digest, granted)
      for (const row of this.store.activationsIn(botId, ['queued', 'blocked'])) {
        if (row.status === 'blocked' && !workWaits(row)) continue
        this.store.run('UPDATE bot_activations SET grant_digest = ?, revision = ? WHERE id = ?', digest, revision.revision!, row.id)
        this.store.run('UPDATE bot_dispatches SET policy_digest = ? WHERE activation_id = ? AND started_at IS NULL', digest, row.id)
      }
    })
    try {
      this.host.definitions.save({ ...entry.draft, permissions: intersectManifest(narrower(entry.draft.permissions), granted) }, entry.draftHash)
    } catch (error) {
      console.warn('the bot draft was left as it was', { botId, error: error instanceof Error ? error.message : String(error) })
    }
    this.changed({ botId })
  }

  /**
   * Moves an activation on once nothing of it runs: settles a finished main dispatch to its result
   * and posts its message (the chat reply, the run report, or the cards of its asks), or sends the
   * continuation its answers, a reload or a usage-limit retry wait for. The unknown-call gate comes
   * first: no result and no continuation passes an unacknowledged unknown call.
   */
  private async advance(activationId: string, text?: string, options: { expectText?: boolean } = {}): Promise<void> {
    const row = this.store.activation(activationId)
    if (!row) return
    if (ENDED_ACTIVATION_STATUSES.has(row.status)) {
      // Work that ran out of room right after a Not now to that limit ends at once, with no ask: what its turn had is
      // still posted, after the line that says it stopped.
      if (row.trigger.kind === 'work' && row.endReason === 'budget_exhausted') {
        const main = this.store.lastMainDispatch(row.id)
        if (main?.endedAt) this.postReply(row, main, text, options.expectText === true)
      }
      this.cleanup(row)
      this.packs.delete(row.id)
      // A chat activation that ended while its turn ran held the home thread until now.
      if (row.lane === 'chat') this.pumpLater(row.botId)
      return
    }
    if (!this.allRunsEnded(row)) return
    this.collectUnknownCalls(row)
    const main = this.store.lastMainDispatch(row.id)
    if (text === undefined && main) {
      const late = this.lateTexts.get(`${row.id}:${main.n}`)
      if (late !== undefined) text = late
    }
    if (row.status === 'running') {
      const run = main?.runId ? this.host.runs()?.getRun(main.runId) : undefined
      if (!main || main.endedAt === null || !run) return
      // Mousse stopped while the turn ran (the profile is closing): the next start carries the activation on, with the
      // time it has left (`reconcileActivation`); it never fails here. One that waits for the internet waits as before.
      if (stoppedByMousse(run) && !row.offline) return
      // A usage limit: the instance is skipped until its reset, and the dispatch is tried again on
      // the next candidate; with none left the bot pauses until the reset (never a failure).
      const limitUntil = run.status === 'failed' ? run.outcome?.usageLimitUntil : undefined
      if (limitUntil && row.selection) {
        // A pick runs on its own entry or not at all (#673): its row waits for this entry's limit, and no other model or
        // entry is tried. The limit is kept by the engine for this bot, by entry (and family), not the whole bot.
        const revision = this.host.definitions.revision(row.botId, row.revision)
        const turn = revision ? turnModelOf(revision.main, row) : undefined
        if (turn?.pick && isPinned(turn.pick)) return this.usagePause(row, limitUntil, row.selection.instanceId, turn, run.outcome?.usageLimitKind)
        try { this.host.models?.markLimited(row.selection.instanceId, limitUntil) } catch { /* the resolve below decides */ }
        const retries = this.store.dispatches(row.id).filter((dispatch) => dispatch.send.usageRetry).length
        if (this.host.models && retries < MAX_USAGE_RETRIES) {
          this.store.markReload(row.id)
          await this.continueWith(row.id, ['running'], { usageRetry: true })
          return
        }
        return this.usagePause(row, limitUntil, row.selection.instanceId)
      }
      // Only a turn the reload stopped continues on the new model; one that finished first is done.
      const reload = row.reloadPending && run.status === 'interrupted' && run.outcome?.interruptedBy === 'bot_wall'
      if (run.status === 'failed' || (run.status !== 'completed' && run.status !== 'uncertain' && !reload)) {
        const unknown = this.store.unknownCalls(row.id).some((call) => !call.acknowledged)
        if (!unknown) {
          const error = typeof run.outcome?.error === 'string' ? run.outcome.error : undefined
          // Ended while the internet was gone: it waits and continues, never a failure.
          if ((row.offline || (run.status === 'failed' && isConnectionFailure(error))) && await this.offlineEnd(row, main)) return
          // The turn reached its runtime's cap on model turns: the turn ended, not the work, which goes on while it has room.
          if (run.status === 'failed' && isProviderTurnCap(error)) return this.continueAfterTurnCap(row, main, text)
          return this.failActivation(row, error ?? run.status)
        }
      }
      const openWalls = this.store.escalations({ activationId: row.id, status: 'open' }).filter((ask) => ask.mode === 'wall')
      // Work the owner added to while it ran posts what it has, then takes the notes and reports again, if it has time
      // left for them; without the time it reports what it has, and the notes stay unread (work_list shows it ended).
      // The same holds, in either lane, for a permission the owner allowed after the turn was refused it (issue #983).
      const allowed = !reload && run.status === 'completed' ? this.allowedSinceRefused(row) : []
      let noted = false
      const next = this.recorded(row, () => {
        noted = !reload && run.status === 'completed' && ((row.lane === 'run' && this.store.pendingWorkNotes(row.id).length > 0) || allowed.length > 0) && (this.remainingMs(row) ?? 0) >= 2 * ACTIVE_TIME_CHUNK_MS
        const unknown = this.store.unknownCalls(row.id).some((call) => !call.acknowledged)
        if (unknown || run.status === 'uncertain') {
          this.store.moveActivation(row.id, ['running'], 'paused', { endReason: run.status === 'uncertain' && !unknown ? 'uncertain' : 'unknown_calls', ...(text !== undefined ? { result: text } : {}) })
        } else if (openWalls.length) {
          // The chat turn asked (`escalate`): it waits for the owner with every card on its message.
          this.store.moveActivation(row.id, ['running'], 'waiting_grant', { endReason: 'wall', ...(text !== undefined ? { result: text } : {}) })
        } else if (noted) {
          // What this turn found is its result for now: a late final message replaces it, never an older turn's text.
          this.store.moveActivation(row.id, ['running'], 'running', { result: text ?? '' })
        } else if (!reload) {
          this.store.moveActivation(row.id, ['running'], 'done', { endReason: null, result: text ?? '' })
          // A successful dispatch resets the automatic-restart allowance, the failure streak (refused
          // asks included) and the bot's stuck error. Work is not a schedule: it never moves the streak.
          this.store.setAutoRestarts(row.id, 0)
          if (row.lane === 'run' && row.trigger.kind !== 'work') this.store.bumpFailureStreak(row.botId, true)
          this.store.setError(row.botId, null)
          this.journalEnd(row, null)
        }
        return this.store.activation(row.id)!
      })
      if (!next) return
      // What it has is posted first, so a continuation that fails or is stopped never loses it; then the notes continue
      // the same thread, and its report follows with the change.
      this.postReply(next, main, text, options.expectText === true)
      if (noted && next.status === 'running') {
        await this.continueWith(row.id, ['running'], { afterReport: true, ...(allowed.length ? { allowed } : {}) })
        return
      }
      if (reload && next.status === 'running') {
        await this.continueWith(row.id, ['running'], { reload: true })
        return
      }
      if (next.status === 'waiting_grant') {
        this.changed({ botId: row.botId, activationId: row.id })
        try { for (const wall of openWalls) this.events.emit('escalation', this.escalationSummary(wall)) } catch { /* listeners never undo it */ }
        return
      }
      if (ENDED_ACTIVATION_STATUSES.has(next.status)) return this.afterEnd(next)
      if (next.status === 'paused') this.stoppedRow(next)
      this.cleanup(next)
      this.changed({ botId: row.botId, activationId: row.id })
      this.pumpLater(row.botId)
      return
    }
    if (row.status === 'waiting_grant') {
      // A wall ended the dispatch: its message carries the cards (once).
      if (main?.endedAt) this.postReply(row, main, text, options.expectText === true)
      // Every card of the wall answered: the continuation carries all the answers.
      if (this.store.escalations({ activationId: row.id, status: 'open' }).some((ask) => ask.mode === 'wall')) return
      const answers = this.store.pendingAnswers(row.id)
      const ownerText = this.ownerTexts.get(row.id) ?? this.wallReplyOf(row, answers)
      this.ownerTexts.delete(row.id)
      if (answers.length) await this.continueWith(row.id, ['waiting_grant'], { answers, ...(ownerText !== undefined ? { ownerText } : {}) })
      return
    }
    if (workWaits(row)) {
      // Work that ran out of room during this turn: its reply waits for the turn's last words, and carries its ask (or,
      // when the owner already allowed more on an earlier card, is an update with what it had).
      if (main?.endedAt) this.postReply(row, main, text, options.expectText === true)
      // Allowed while its turn was still ending: it goes on now that the turn let go.
      if (row.endReason === 'room_allowed') this.pumpLater(row.botId)
      return
    }
    if (main?.endedAt && text !== undefined) this.postReply(row, main, text, false)
  }

  /**
   * The message of a main dispatch that ended (§5.3.2): in the chat a `text` row, for a run a
   * `run_report` once it is done (a `notice` while it waits at a wall), with the dispatch's chips
   * and the cards of the asks it raised; each further card gets a notice row of its own. Written
   * once (its id is the dispatch's). When the executor's final message is still on its way, the row
   * waits for it, at most `REPLY_WAIT_MS`.
   */
  private postReply(row: BotActivationRow, dispatch: BotDispatchRow, text: string | undefined, expectText: boolean): void {
    const key = `${row.id}:${dispatch.n}`
    if (this.store.message(`bm_${row.id}_d${dispatch.n}`)) return
    // Work that ran out of room says so with what it had and the ask that lets it go on, once (`postRoom` may have).
    const waiting = workWaits(row) && row.endReason === 'budget_exhausted'
    if (waiting && this.store.message(`bm_${row.id}_room_d${dispatch.n}`)) return
    if (text === undefined) text = this.lateTexts.get(key)
    if (text === undefined && expectText) {
      if (this.pendingReplies.has(key)) return
      const timer = (this.host.setTimer ?? defaultTimer)(() => this.pendingReplies.get(key)?.post(undefined), REPLY_WAIT_MS)
      this.pendingReplies.set(key, {
        timer,
        post: (late) => {
          this.pendingReplies.get(key)?.timer.clear()
          this.pendingReplies.delete(key)
          const current = this.store.activation(row.id) ?? row
          this.postReply(current, dispatch, late ?? current.result ?? '', false)
        }
      })
      return
    }
    this.pendingReplies.get(key)?.timer.clear()
    this.pendingReplies.delete(key)
    this.lateTexts.delete(key)
    // What turns that reached the turn cap did before this one: their chips first, and their words when it has none.
    const carried = this.carried.get(row.id)
    this.carried.delete(row.id)
    const chips = [...(carried?.chips ?? []), ...(this.drained.get(key) ?? [])]
    this.drained.delete(key)
    if (!text?.trim() && carried?.text) text = carried.text
    // Its open walls, unless a card for them was posted in this activation already (a moved run ask keeps its old card too).
    const asks = this.store.escalations({ activationId: row.id }).filter((ask) => ask.mode === 'wall' && ask.dispatchN === dispatch.n && ask.status === 'open' &&
      !this.store.messagesForAsk(ask.id).some((message) => message.activationId === row.id))
    // A chat turn that handed work off and says its one line twice (before the work_start call and after it) says it
    // once. Any other reply is posted as written.
    const handedOff = row.lane === 'chat' && chips.some((chip) => WORK_STARTED_CHIPS.has(chip.text))
    const body = handedOff ? sayOnce((text ?? '').trim()) : (text ?? '').trim()
    // Only the last turn of a run reports; an earlier one (work that went on with the owner's notes) is an update.
    const report = row.lane === 'run' && row.status === 'done' && (this.store.lastMainDispatch(row.id)?.n ?? dispatch.n) === dispatch.n
    if (!body && !chips.length && !asks.length && !report && !waiting) return
    const kind = row.lane === 'chat' ? 'text' : report ? 'run_report' : 'notice'
    const name = this.host.definitions.revision(row.botId, row.revision)?.name ?? 'This bot'
    const room = waiting ? this.roomAskOf(row) : undefined
    const [first, ...more] = room ? [room] : asks
    // What the message answers: the owner's message a chat turn holds, or the one that asked for the work.
    const replyTo = row.lane === 'chat' ? this.ownerMessageOf(row.id) : row.trigger.kind === 'work' ? row.trigger.replyTo : undefined
    try {
      this.store.db.transaction(() => {
        this.chat.post({
          id: `bm_${row.id}_d${dispatch.n}`,
          botId: row.botId,
          author: 'bot',
          kind,
          text: waiting ? roomText(body) : body || (first ? `${name} wants to ${this.chat.card(first).title}.` : report ? 'Done.' : ''),
          chips,
          ...(first ? { askId: first.id } : {}),
          ...(replyTo ? { replyTo } : {}),
          activationId: row.id,
          lane: row.lane,
          threadId: dispatch.threadId
        })
        for (const ask of more)
          this.chat.post({ botId: row.botId, author: 'bot', kind: 'notice', text: `${name} wants to ${this.chat.card(ask).title}.`, askId: ask.id, activationId: row.id, lane: row.lane, threadId: dispatch.threadId })
      })
    } catch (error) {
      console.warn('a bot message could not be saved', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
      if (isJournalFailure(error)) this.journalFailed(row)
    }
  }

  /**
   * A main dispatch that reached its runtime's cap on model turns (`provider_turn_cap`): the activation carries on in
   * the same thread, as after a restart, under its own limits. Its turn budget, when the grant has one, is checked
   * first, and `continueWith` checks its work time, so a used-up budget ends it as any limit does (a run's ask, a chat's
   * wall), never as a failure. What the capped turn did (its chips and last words) goes into the activation's next
   * message, so a continuation that runs out at once still posts it. After `MAX_TURN_CAP_CONTINUATIONS` in total, work
   * ends as out of room with what it had (`endAtTurnCap`); any other activation fails as before.
   */
  private async continueAfterTurnCap(row: BotActivationRow, main: BotDispatchRow, text?: string): Promise<void> {
    // The ended turn's own message is not posted: its work goes on in the continuation, whose message carries it.
    const key = `${row.id}:${main.n}`
    const before = this.carried.get(row.id)
    const words = text?.trim()
    this.carried.set(row.id, { chips: [...(before?.chips ?? []), ...(this.drained.get(key) ?? [])], ...(words ? { text: words } : before?.text ? { text: before.text } : {}) })
    this.drained.delete(key)
    this.lateTexts.delete(key)
    if (this.store.dispatches(row.id).filter((dispatch) => dispatch.send.turnCap).length >= MAX_TURN_CAP_CONTINUATIONS)
      return row.lane === 'run' && row.trigger.kind === 'work' ? this.endAtTurnCap(row, main) : this.failActivation(row, 'turn_cap_repeated')
    const counters = this.store.counters(row.id)
    const maxTurns = counters.limits.maxTurns
    if (maxTurns !== undefined && counters.requests >= maxTurns) {
      this.raiseWall(row.id, { dispatchN: main.n, kind: 'budget', permission: { budget: { key: 'maxTurns', amount: maxTurns } }, reason: `This bot reached its limit of ${maxTurns} model requests.` })
      return
    }
    const allowed = this.allowedSinceRefused(row)
    await this.continueWith(row.id, ['running'], { turnCap: true, ...(allowed.length ? { allowed } : {}) })
  }

  /**
   * Work that kept reaching its runtime's turn cap ends as out of room, never as a failure: done, with its report saying
   * it stopped short and what it had (the capped turns' words and chips), answering the message that asked for it.
   */
  private endAtTurnCap(row: BotActivationRow, main: BotDispatchRow): void {
    const carried = this.carried.get(row.id)
    const body = carried?.text ?? ''
    const ended = this.recorded(row, () => {
      if (!this.store.moveActivation(row.id, ['running'], 'done', { endReason: 'turn_cap_repeated', result: body })) return false
      this.chat.post({
        id: `bm_${row.id}_d${main.n}`, botId: row.botId, author: 'bot', kind: 'run_report', text: stoppedShortText(body), chips: carried?.chips ?? [],
        ...(row.trigger.kind === 'work' && row.trigger.replyTo ? { replyTo: row.trigger.replyTo } : {}),
        activationId: row.id, lane: 'run', threadId: main.threadId
      })
      this.journalEnd(row, 'turn_cap_repeated')
      return true
    }) ?? false
    if (!ended) return
    this.carried.delete(row.id)
    this.afterEnd(this.store.activation(row.id) ?? row)
  }

  /** Every run of the activation (main and consult) has ended, so nothing of it is live. */
  private allRunsEnded(row: BotActivationRow): boolean {
    const runs = this.host.runs()
    if (!runs) return false
    for (const dispatch of this.store.dispatches(row.id)) {
      const runId = dispatch.runId ?? this.receiptRun(dispatch.clientRequestId)
      if (!runId) continue
      const run = runs.getRun(runId)
      if (run && !TERMINAL_RUN_STATUSES.has(run.status)) return false
    }
    return true
  }

  private receiptRun(clientRequestId: string): string | undefined {
    const receipt = this.host.runs()?.store.getReceipt(clientRequestId)
    const runId = (receipt?.result as { runId?: unknown } | undefined)?.runId
    return receipt?.status === 'accepted' && typeof runId === 'string' ? runId : undefined
  }

  /**
   * The unknown-call gate's collection (PR 6 §4): every non-idempotent ledger row of a run of the
   * activation that ended (or whose processes are confirmed gone) without an outcome. Rows the
   * ledger now shows finished leave the list. Live runs are never scanned.
   */
  private collectUnknownCalls(row: BotActivationRow): void {
    const runs = this.host.runs()
    if (!runs) return
    let changed = 0
    for (const dispatch of this.store.dispatches(row.id)) {
      const runId = dispatch.runId ?? this.receiptRun(dispatch.clientRequestId)
      if (!runId) continue
      const run = runs.getRun(runId)
      if (!run || (!TERMINAL_RUN_STATUSES.has(run.status) && dispatch.exitAt === null)) continue
      const role = dispatch.kind === 'consult' ? 'consult' : 'main'
      for (const call of runs.tools.listForRun(runId)) {
        if (call.idempotent) continue
        if (call.status === 'outcome_unknown' || call.status === 'started')
          changed += this.store.putUnknownCall({ activationId: row.id, runId, invocationId: call.invocationId, tool: call.tool, role })
        else changed += this.store.dropUnknownCall(row.id, call.invocationId)
      }
    }
    // The Bots tab lists exactly these rows: every change is shown before anyone acknowledges them.
    if (changed) this.changed({ botId: row.botId, activationId: row.id })
  }

  /**
   * A continuation dispatch (PR 6 §5): after the owner's answers, a restart, the owner's Continue,
   * a model reload or a usage-limit retry. In one transaction it checks the unknown-call gate
   * (unacknowledged calls pause the activation, and a recorded answer waits for the acknowledged
   * Continue) and the remaining time (under 15 s is a budget wall), then writes the dispatch; the
   * run follows through `sendWithStart`, continuing the previous main run.
   */
  private async continueWith(activationId: string, from: readonly BotActivationRow['status'][], input: { answers?: BotEscalationRow[]; restart?: boolean; acknowledgeUncertain?: boolean; reload?: boolean; usageRetry?: boolean; ownerText?: string; network?: boolean; afterReport?: boolean; allowed?: string[]; turnCap?: boolean; moreRoom?: boolean; usageReset?: boolean }): Promise<'sent' | 'paused' | 'wall' | 'none'> {
    const row = this.store.activation(activationId)
    if (!row || !from.includes(row.status)) return 'none'
    const definition = this.host.definitions.revision(row.botId, row.revision)
    const grant = this.store.activeGrant(row.botId)
    const previous = this.store.lastMainDispatch(row.id)
    const runs = this.host.runs()
    if (!runs) return 'none'
    const previousRun = previous?.runId ? runs.getRun(previous.runId) : undefined
    const uncertain = previousRun?.status === 'uncertain'
    const effective = definition && grant ? this.effectiveManifest(row, definition.permissions, grant.manifest) : undefined
    const answers = input.answers ?? []
    const decided = this.store.db.transaction((): { kind: 'paused' | 'wall' | 'blocked' | 'budget' | 'none' } | { kind: 'fail'; reason: string } | { kind: 'sent'; dispatch: BotDispatchRow } => {
      const current = this.store.activation(row.id)
      if (!current || !from.includes(current.status)) return { kind: 'none' }
      // One that holds no slot of its lane (it waited, or was paused) goes on only into a free one (`slotFree`); a scheduled
      // run or a reminder's work also leaves the slot kept for the owner's work (`runSlotFree`).
      if (!(ACTIVE_HOLDING as readonly string[]).includes(current.status) && !(current.lane === 'run' ? this.runSlotFree(current) : this.slotFree(row.botId, current.lane, row.id)))
        return { kind: 'none' }
      if (!definition || !grant || !effective || grant.digest !== current.grantDigest) {
        // A run going on by itself ends failed (after this transaction): nobody waits to continue it.
        if (current.lane === 'run' && current.status === 'running') return { kind: 'fail', reason: 'bot_grant_revoked' }
        this.store.moveActivation(row.id, [current.status], 'blocked', { endReason: 'bot_grant_revoked' })
        return { kind: 'blocked' }
      }
      // A denied limit is not asked again: the activation ends blocked.
      if (answers.some((answer) => answer.status === 'denied' && 'budget' in answer.permission)) {
        for (const answer of answers) this.store.markApplied(answer.id)
        this.store.moveActivation(row.id, [current.status], 'blocked', { endReason: 'budget_denied' })
        return { kind: 'blocked' }
      }
      const unknown = this.store.unknownCalls(row.id).some((call) => !call.acknowledged)
      if (unknown || (uncertain && !input.acknowledgeUncertain)) {
        this.store.moveActivation(row.id, [current.status], 'paused', { endReason: unknown ? 'unknown_calls' : 'uncertain' })
        return { kind: 'paused' }
      }
      const remaining = effective.budget.maxActiveMs - this.store.counters(row.id).activeMs
      if (remaining < ACTIVE_TIME_CHUNK_MS) {
        for (const answer of answers) this.store.markApplied(answer.id)
        // A run has nobody to allow more: it ends with its ask (after this transaction).
        if (current.lane === 'run' && current.status === 'running') return { kind: 'budget' }
        // Work that waited for room and still has none (its grant narrowed meanwhile) waits for the next answer; work
        // that waited for a usage limit's reset with no time left ends at its limit with its ask.
        if (input.moreRoom) {
          this.store.moveActivation(row.id, [current.status], 'blocked', { endReason: 'budget_exhausted' })
          return { kind: 'none' }
        }
        if (input.usageReset) {
          this.store.moveActivation(row.id, [current.status], 'running', { endReason: null })
          return { kind: 'budget' }
        }
        const wall = this.wallInTransaction(row.id, [current.status], this.timeWall(previous?.n ?? 0, effective))
        return { kind: wall.kind === 'wall' ? 'wall' : wall.kind === 'blocked' ? 'blocked' : 'none' }
      }
      const n = this.store.nextDispatchN(row.id)
      const neverRan = previous && previousRun && !previousRun.activeAttemptId ? previous.prompt.text : undefined
      // A run takes what the owner added since its last dispatch with whatever continues it.
      const notes = input.usageRetry ? undefined : this.workNotes(current, input.restart === true)
      if (notes) this.store.applyWorkNotes(notes.ids)
      const dispatch = {
        activationId: row.id,
        n,
        kind: 'continue' as const,
        clientRequestId: `${row.id}:d${n}`,
        threadId: current.threadId!,
        prompt: { text: input.usageRetry && previous ? `[Mousse] The last try did not go through. Answer this again:\n\n${previous.prompt.text}` : this.continuationPrompt(row, { ...input, answers, ...(notes ? { notes: notes.text } : {}) }, neverRan) },
        policyDigest: grant.digest,
        // Kept with the intent, so a resend after a crash sends exactly this.
        send: input.usageRetry
          ? { usageRetry: true }
          : { ...(previous?.runId ? { continuationOfRunId: previous.runId } : {}), ...(uncertain ? { acknowledgeUncertain: true } : {}), ...(input.turnCap ? { turnCap: true } : {}) }
      }
      this.store.insertDispatch(dispatch)
      for (const answer of answers) this.store.markApplied(answer.id)
      this.store.setLimits(row.id, limitsOf(effective))
      if (input.restart) this.store.setAutoRestarts(row.id, current.autoRestarts + 1)
      if (input.network) this.store.setOffline(row.id, false)
      this.store.moveActivation(row.id, [current.status], 'running', { endReason: null })
      return { kind: 'sent', dispatch: this.store.dispatch(row.id, n)! }
    })
    if (decided.kind === 'budget') {
      this.budgetEnd(this.store.activation(row.id) ?? row, this.timeWall(previous?.n ?? 0, effective!))
      return 'none'
    }
    if (decided.kind === 'fail') {
      this.failActivation(this.store.activation(row.id) ?? row, decided.reason)
      return 'none'
    }
    if (decided.kind === 'wall') {
      const escalation = this.store.escalations({ activationId: row.id, status: 'open' }).at(-1)
      if (escalation) {
        this.afterWall(row.id, { kind: 'wall', escalation })
        this.announceWall(escalation)
      }
      return 'wall'
    }
    this.changed({ botId: row.botId, activationId: row.id })
    if (decided.kind !== 'sent') {
      // Paused or blocked: the activation no longer holds its lane, and its chat says why.
      if (decided.kind === 'paused' || decided.kind === 'blocked') {
        this.stoppedRow(this.store.activation(row.id) ?? row)
        this.pumpLater(row.botId)
      }
      return decided.kind === 'paused' ? 'paused' : 'none'
    }
    await this.sendDispatch(this.store.activation(row.id)!, decided.dispatch)
    return 'sent'
  }

  private continuationPrompt(row: BotActivationRow, input: { answers: BotEscalationRow[]; restart?: boolean; reload?: boolean; ownerText?: string; network?: boolean; notes?: string; afterReport?: boolean; allowed?: string[]; turnCap?: boolean; moreRoom?: boolean; usageReset?: boolean }, neverRan?: string): string {
    const answerLine = (answer: BotEscalationRow): string => {
      const title = this.chat.card(answer).title
      if (answer.status === 'denied') return input.ownerText !== undefined
        ? `The owner wrote instead of answering, so the answer is not now: ${title}. Carry on without it.`
        : `The owner said not now: ${title}. Carry on without it and say what you couldn't do.`
      if (isSpecialAsk(answer.permission)) return `The owner allowed: ${title}. Mousse saves it now.`
      // A chat turn is not offered what takes long: the work it hands off has it now.
      if (row.lane === 'chat' && 'tool' in answer.permission && (BOT_WORK_ONLY_TOOLS.includes(botGrantTool(answer.permission.tool)) || botGrantTool(answer.permission.tool) === BOT_BROWSER_PERMISSION))
        return `The owner allowed: ${title}. Your work has it now: hand the job to work_start.`
      return `The owner allowed: ${title}.`
    }
    const depth = row.modelOverride?.depth
    const lead = input.answers.length
      ? input.answers.map(answerLine).join(' ')
      : input.reload ? (depth === 'deep' ? 'You now have more time to think.' : depth === 'quick' ? 'You now answer more quickly.' : 'Your settings changed.')
        : input.restart ? 'Mousse restarted while you were working.'
          : input.turnCap ? 'You reached the most steps one turn may take; what you did so far is kept.'
          : input.moreRoom ? 'You have more room now; what you had so far was already sent to the owner.'
          : input.usageReset ? 'A usage limit stopped you while you were working; it has reset now.'
          : input.network ? 'The internet connection dropped while you were working; it is back now.'
            : input.afterReport ? 'The owner added something while you worked; what you had so far was already sent to them.'
              : input.notes ? 'The owner added something while you worked.' : 'The owner asked you to continue.'
    const calls = this.store.unknownCalls(row.id)
    const interrupted = calls.length
      ? ` Interrupted tool calls (their effects are unknown; check before repeating them): ${calls.map((call) => `${call.tool} (${call.role} run ${call.runId}, call ${call.invocationId})`).join('; ')}.`
      : ''
    // A turn that the owner allowed something while it ran (issue #983): this turn has it (`allowedSinceRefused`). Work
    // that goes on after it waited, or after the turn cap, hears it with why it goes on.
    if (input.allowed?.length && (input.moreRoom || input.usageReset || input.turnCap))
      return `[Mousse] ${lead} The owner also allowed you to ${input.allowed.join(' and ')}; you have it now.${interrupted}${input.notes ? `\n\n${input.notes}\n\nTake it into account as you continue.` : ''} ${input.moreRoom ? 'Carry on where you left off' : 'Continue where you left off'}, and do what you skipped without it.`
    if (input.allowed?.length) {
      if (row.lane === 'chat') return `[Mousse] The owner allowed you to ${input.allowed.join(' and ')} while you answered; you have it now. Your reply so far was already sent.${interrupted}\n\nDo now what you skipped without it, and tell the owner what you found.`
      const allowedLine = `The owner allowed you to ${input.allowed.join(' and ')} while you worked; you have it now.`
      const notes = input.notes ? `\n\n${input.notes}` : ''
      const sent = input.afterReport ? ' What you had so far was already sent to them.' : ''
      return `[Mousse] ${allowedLine}${sent}${interrupted}${notes}\n\nDo now what you skipped without it${notes ? ', and take the owner\'s notes into account' : ''}. Your last message is your updated report: lead with what changed, in plain words.`
    }
    // The owner's notes to a run: they change the work, so the run reports again on all of it.
    if (input.notes) return `[Mousse] ${lead}${interrupted}\n\n${input.notes}\n\n${neverRan !== undefined ? `${neverRan}\n\n` : ''}${input.afterReport ? 'Update your work for it. Your last message is your updated report: lead with what changed, in plain words.' : `Take it into account as you continue. ${BOT_RUN_REPORT_LINE}`}`
    // The owner's message is the next input.
    if (input.ownerText !== undefined) return `[Mousse] ${lead}${interrupted}\n\n${input.ownerText}`
    // The walled dispatch never ran (a time wall before it started): its own prompt is sent now.
    if (neverRan !== undefined) return `[Mousse] ${lead}${interrupted}\n\n${neverRan}`
    return `[Mousse] ${lead} ${input.moreRoom ? 'Carry on where you left off.' : input.reload || input.usageReset ? 'Continue where you left off.' : 'Continue.'}${interrupted}`
  }

  /**
   * Sends a written dispatch: first its activation's model and context pack (`ready`), then its
   * run, receipt and `turn.start` in one run-DB transaction.
   */
  private async sendDispatch(row: BotActivationRow, dispatch: BotDispatchRow): Promise<void> {
    try {
      if (!(await this.ready(row, dispatch))) return
      let current = this.store.activation(row.id) ?? row
      // With no internet the dispatch is not sent: the activation waits, charged nothing, and
      // sends it once the internet is back. A consult runs inside its live main dispatch.
      if (dispatch.kind !== 'consult' && this.host.connectivity) {
        const online = await this.online(current)
        current = this.store.activation(row.id) ?? current
        if (current.status !== 'running') return
        if (!online) return this.awaitInternet(current)
        if (current.offline) {
          this.clearInternetCheck(row.id)
          this.store.setOffline(row.id, false)
          this.changed({ botId: row.botId, activationId: row.id })
        }
      }
      await this.sendOnly(this.store.activation(row.id) ?? current, dispatch)
    } catch (error) {
      const reason = error instanceof BotEngineError ? error.code : 'bot_start_failed'
      console.warn('bot dispatch could not be sent', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
      this.failActivation(this.store.activation(row.id) ?? row, reason)
    }
  }

  /** Sends a written dispatch, with the send options kept on its intent; throws on refusal. */
  private async sendOnly(row: BotActivationRow, dispatch: BotDispatchRow): Promise<void> {
    {
      const runs = this.host.runs()
      if (!runs) throw new BotEngineError('bots_unavailable', 'The run engine is not running.')
      const sent = await runs.sendWithStart(
        { kind: 'send', threadId: dispatch.threadId, clientRequestId: dispatch.clientRequestId, source: 'bot', ...dispatch.send },
        (runId): BotTurnPayload => ({ kind: 'bot', runId, threadId: dispatch.threadId, activationId: row.id, dispatchN: dispatch.n })
      )
      if (sent.status !== 'accepted') throw new BotEngineError('bot_dispatch_refused', `The bot's run was refused (${sent.reason}).`)
      this.store.setDispatchRun(row.id, dispatch.n, sent.runId)
      this.host.notifyEffects()
    }
  }

  /**
   * The owner's Continue (`bots.activations.continue`) of a paused or blocked activation. Unknown
   * calls must be acknowledged first ("I've checked what these calls did"), which also covers an
   * `uncertain` main run. A recorded wall answer is applied by this continuation.
   */
  async continueActivation(activationId: string, options: { acknowledge?: BotAcknowledgement } = {}): Promise<BotActivationSummary> {
    const row = this.store.activation(activationId)
    if (!row) throw new BotEngineError('activation_not_found', 'No activation with that id.')
    if (row.status !== 'paused' && row.status !== 'blocked') throw new BotEngineError('bot_not_paused', 'Only a paused or blocked activation can be continued.')
    // Work that waits to go on goes on by its own way: its ask's answer, or the usage limit's reset (or Resume).
    if (workWaits(row)) {
      throw new BotEngineError('bot_work_waiting', row.endReason === 'usage_limit'
        ? 'This work waits for a usage limit to reset. It carries on then, or press Resume to try now.'
        : row.endReason === 'room_allowed'
          ? 'This work already has more room. It carries on when the work before it is done.'
          : 'This work ran out of room. Answer its ask to let it carry on, or stop it.')
    }
    if (!row.threadId || !this.store.lastMainDispatch(row.id)) throw new BotEngineError('bot_not_started', 'This activation never started; run the bot again.')
    if (!(row.lane === 'run' ? this.runSlotFree(row) : this.slotFree(row.botId, row.lane, row.id)))
      throw new BotEngineError('bot_busy', row.lane === 'run'
        ? 'This bot already runs as much as it can at once. Continue this one when one of them has finished.'
        : 'Another run of this bot is in progress. Continue this one when it has finished.')
    if (!this.allRunsEnded(row)) throw new BotEngineError('bot_still_running', 'This bot\'s last run has not stopped yet.')
    const uncertain = this.acknowledge(row, options.acknowledge)
    const answers = this.store.pendingAnswers(row.id)
    await this.continueWith(row.id, ['paused', 'blocked'], { answers, ...(uncertain ? { acknowledgeUncertain: true } : {}) })
    return this.activationSummary(this.store.activation(row.id)!)
  }

  /**
   * "I've checked what these calls did": the acknowledgement names exactly the calls (and the
   * `uncertain` run) the owner was shown. When the set changed since, nothing is acknowledged and
   * the request is refused with the current list. True when an `uncertain` main run was acknowledged.
   */
  private acknowledge(row: BotActivationRow, shown: BotAcknowledgement | undefined): boolean {
    this.collectUnknownCalls(row)
    const calls = this.store.unknownCalls(row.id)
    const pending = calls.filter((call) => !call.acknowledged)
    const main = this.store.lastMainDispatch(row.id)
    const run = main?.runId ? this.host.runs()?.getRun(main.runId) : undefined
    const uncertainRunId = run?.status === 'uncertain' ? run.runId : null
    if (!shown) {
      if (pending.length) throw new BotEngineError('unknown_calls_not_acknowledged', 'Check what the interrupted tool calls did first.', { calls, uncertainRunId })
      if (uncertainRunId) throw new BotEngineError('uncertain_not_acknowledged', 'Check what the interrupted tool calls did first.', { calls, uncertainRunId })
      return false
    }
    const names = new Set(shown.calls)
    const same = names.size === pending.length && pending.every((call) => names.has(call.invocationId)) && (shown.uncertainRunId ?? null) === uncertainRunId
    if (!same) throw new BotEngineError('unknown_calls_changed', 'The interrupted tool calls changed since they were shown. Check them again.', { calls, uncertainRunId })
    this.store.acknowledgeUnknownCalls(row.id, pending.map((call) => call.invocationId))
    return uncertainRunId !== null
  }

  /** "Mark done": a paused activation whose run completed keeps its draft result as the result. */
  markDone(activationId: string, options: { acknowledge?: BotAcknowledgement } = {}): BotActivationSummary {
    const row = this.store.activation(activationId)
    if (!row) throw new BotEngineError('activation_not_found', 'No activation with that id.')
    const main = this.store.lastMainDispatch(row.id)
    const run = main?.runId ? this.host.runs()?.getRun(main.runId) : undefined
    if (row.status !== 'paused' || run?.status !== 'completed') throw new BotEngineError('bot_not_done', 'Only a paused activation whose run completed can be marked done.')
    this.acknowledge(row, options.acknowledge)
    this.store.moveActivation(row.id, ['paused'], 'done', { endReason: null })
    const next = this.store.activation(row.id)!
    this.cleanup(next)
    this.changed({ botId: row.botId, activationId: row.id })
    this.pumpLater(row.botId)
    return this.activationSummary(next)
  }

  // -- Consults ---------------------------------------------------------------------------------

  /**
   * `consult` (PR 6 §5): asks a context thread and returns its final message. Consults of one
   * context thread run one after the other: each waits until the previous consult's run there has
   * ended before it writes anything. The wait ends with the main dispatch, and then nothing is sent.
   */
  private async consult(main: { row: BotActivationRow; mainN: number; controller: AbortController }, request: { context: string; question: string; signal?: AbortSignal }): Promise<string> {
    const { row, controller } = main
    const definition = this.host.definitions.revision(row.botId, row.revision)
    const spec = definition?.context.find((thread) => thread.key === request.context)
    if (!definition || !spec) throw new Error(`No context thread named ${request.context}. Context threads: ${(definition?.context ?? []).map((thread) => thread.key).join(', ') || 'none'}.`)
    const lane = `${row.botId}:${spec.key}`
    const previous = this.lanes.get(lane) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((resolve) => { release = resolve })
    const chained = previous.then(() => mine)
    this.lanes.set(lane, chained)
    void chained.then(() => { if (this.lanes.get(lane) === chained) this.lanes.delete(lane) })
    let sent: Promise<string> | undefined
    try {
      await untilAborted(previous, controller.signal)
      if (controller.signal.aborted) return wallMessage(this.endedWall(row.id))
      // The gate before a new consult: runs that already ended only, never the live main run.
      this.collectUnknownCalls(this.store.activation(row.id) ?? row)
      if (this.store.unknownCalls(row.id).some((call) => !call.acknowledged)) {
        if (this.store.moveActivation(row.id, ['running'], 'paused', { endReason: 'unknown_calls' })) {
          controller.abort(new BotWallAbort('bot_paused'))
          this.changed({ botId: row.botId, activationId: row.id })
          this.pumpLater(row.botId)
        }
        return wallMessage({ kind: 'paused' })
      }
      const home = this.store.registry(row.botId)?.homeThreadId
      const gen = this.store.contextGen(row.botId, spec.key)
      const thread = this.host.threads.ensureExecutionThread(`bot:${row.botId}:ctx:${spec.key}:${gen}`, `${definition.name}: ${spec.title}`.slice(0, 120), undefined, home ? { parentTaskId: home } : undefined)
      this.putThread({ threadId: thread.id, botId: row.botId, role: 'context', key: `${spec.key}:${gen}` })
      const written = this.store.db.transaction(() => {
        const current = this.store.activation(row.id)
        if (current?.status !== 'running') return undefined
        const n = this.store.nextDispatchN(row.id)
        this.store.insertDispatch({ activationId: row.id, n, kind: 'consult', mainN: main.mainN, clientRequestId: `${row.id}:c${n}`, threadId: thread.id, prompt: { text: request.question }, policyDigest: current.grantDigest })
        return this.store.dispatch(row.id, n)
      })
      if (!written) return wallMessage(this.endedWall(row.id))
      const key = `${row.id}:${written.n}`
      sent = new Promise<string>((resolve) => this.consultWaiters.set(key, { resolve }))
      try {
        await this.sendOnly(row, written)
      } catch (error) {
        // A consult that could not be sent fails alone: the main dispatch goes on, and the lane opens.
        const message = error instanceof Error ? error.message : String(error)
        this.store.run('UPDATE bot_dispatches SET ended_at = ?, outcome = ? WHERE activation_id = ? AND n = ? AND ended_at IS NULL', this.store.now(), 'not_sent', row.id, written.n)
        this.consultWaiters.delete(key)
        sent = Promise.resolve('')
        return `The consult could not be sent: ${message}`
      }
      const answer = await untilAborted(sent, controller.signal)
      if (answer === undefined) return wallMessage(this.endedWall(row.id))
      return answer || '(The context thread gave no answer.)'
    } finally {
      // The lane opens for the next consult once this one's run has ended (or it sent nothing).
      if (sent) void sent.then(release, release)
      else release()
    }
  }

  private endedWall(activationId: string): WallReason {
    const status = this.store.activation(activationId)?.status
    if (status === 'waiting_grant') {
      const open = this.store.escalations({ activationId, status: 'open' }).at(-1)
      return open ? { kind: 'escalated', permission: this.chat.card(open).title } : { kind: 'waiting' }
    }
    return status === 'paused' ? { kind: 'paused' } : { kind: 'ended' }
  }

  /** "Reset context": the next consult of `key` starts a new context thread. */
  resetContext(botId: string, key: string): { gen: number } {
    const definition = this.published(botId)
    if (!definition.context.some((thread) => thread.key === key)) throw new BotEngineError('bot_context_unknown', 'This bot has no context thread with that key.')
    return { gen: this.store.bumpContextGen(botId, key) }
  }

  /**
   * Settles a dispatch once its run is terminal. A main dispatch: its active time (unconditionally),
   * its chips, then its end; its consults are stopped. Capture runs for its thread
   * (`afterDispatch`), and only then does the activation move on, once its consults have ended too.
   * A consult: its end, and its final message for the waiting `consult` call. Idempotent; the
   * executor's final message may come after the run's terminal event settled the dispatch.
   */
  settle(payload: BotTurnPayload, outcome: { text?: string }): void {
    const runs = this.host.runs()
    const run = runs?.getRun(payload.runId)
    if (!runs || !run || !TERMINAL_RUN_STATUSES.has(run.status)) return
    const row = this.store.activation(payload.activationId)
    const dispatch = row ? this.store.dispatch(row.id, payload.dispatchN) : undefined
    if (!row || !dispatch) return
    if (dispatch.kind === 'consult') return this.settleConsult(row, dispatch, run, outcome, true)
    const key = `${row.id}:${dispatch.n}`
    // A failed turn's final message is the provider's error, never the bot's words: it is not a reply. The exception is a
    // turn that reached its runtime's turn cap: its work goes on, and what it said last is kept (`continueAfterTurnCap`).
    const capped = run.status === 'failed' && isProviderTurnCap(run.outcome?.error)
    const text = run.status === 'failed' && !capped ? undefined : outcome.text
    if (dispatch.endedAt !== null) {
      // A capped turn's words that arrive after its end: its work already went on (its next message carries them), or
      // it is still moving on (`advance` reads them as a late text).
      if (capped && text?.trim()) {
        const carried = this.carried.get(row.id)
        if (!carried) this.lateTexts.set(key, text)
        else if (!carried.text) carried.text = text.trim()
      }
      // Settled from the run's terminal event first: the executor's final message still lands.
      if (text !== undefined && !capped) {
        this.store.run("UPDATE bot_activations SET result = ? WHERE id = ? AND status IN ('done', 'paused', 'waiting_grant', 'blocked') AND (result IS NULL OR result = '')", text, row.id)
        // Capture may still be running for this dispatch: its reply takes this text when it is written.
        if (!this.pendingReplies.has(key) && !this.store.message(`bm_${row.id}_d${dispatch.n}`)) this.lateTexts.set(key, text)
      }
      this.pendingReplies.get(key)?.post(text)
      // The executor settles after the thread's last write: capture copies what the first pass missed.
      this.resync({ botId: row.botId, threadId: dispatch.threadId, lane: row.lane, activationId: row.id })
      return
    }
    const live = this.live.get(row.id)?.n === dispatch.n ? this.live.get(row.id) : undefined
    this.liveRuns.delete(payload.runId)
    if (live) {
      this.live.delete(row.id)
      live.timer?.clear()
      live.watch?.clear()
      live.controller.abort(new Error('dispatch_ended'))
    }
    // Measured on the monotonic clock of the process that ran the dispatch. Without that measure
    // (another process started it), nothing is refunded: the whole prepaid allowance stays charged.
    // A dispatch ended to wait for the internet is charged up to its last call only; one Mousse stopped, up to the last
    // moment it was known to work (the shutdown itself, unless it was waiting for the internet then).
    const measured = live ? live.offline?.chargeMs ?? (stoppedByMousse(run) ? this.workedUntil(live, true) - live.startedMono : this.monotonic() - live.startedMono) : undefined
    this.store.db.transaction(() => {
      // Time: the measured window, never above the deadline, applied once as a signed difference.
      // `exit_at` is the supervisor's evidence that the processes are gone, never written here.
      if (dispatch.startedAt !== null && dispatch.deadlineMs !== null && dispatch.prepaidMs !== null) {
        const used = measured === undefined ? dispatch.deadlineMs : Math.max(0, Math.min(dispatch.deadlineMs, Math.ceil(measured)))
        const changed = this.store.run(
          'UPDATE bot_dispatches SET used_ms = ?, prepaid_ms = ?, settled_by = ? WHERE activation_id = ? AND n = ? AND settled_by IS NULL',
          used, used, 'run', row.id, dispatch.n
        )
        if (changed) this.store.run('UPDATE bot_counters SET active_ms = active_ms + ? WHERE activation_id = ?', used - dispatch.prepaidMs, row.id)
      }
      this.store.run('UPDATE bot_dispatches SET ended_at = ?, outcome = ?, run_id = COALESCE(run_id, ?) WHERE activation_id = ? AND n = ? AND ended_at IS NULL', this.store.now(), run.status, run.runId, row.id, dispatch.n)
    })
    // Ending the main dispatch stops its consults; the activation moves on when they have ended.
    this.stopConsults(row, dispatch.n)
    this.drainChips(row, key, dispatch.clientRequestId)
    this.settleProcesses(dispatch)
    // The executor's final message is on its way when this process ran the dispatch.
    const expectText = live !== undefined && text === undefined
    // Capture below may run before the thread's last write: the thread is copied once more later.
    if (this.host.journal) this.needsSync.set(dispatch.threadId, { botId: row.botId, threadId: dispatch.threadId, lane: row.lane, activationId: row.id })
    this.settling.add(row.id)
    const moveOn = (): Promise<void> => {
      this.settling.delete(row.id)
      return this.advance(row.id, text, { expectText })
    }
    const failed = (error: unknown): void => {
      this.settling.delete(row.id)
      console.warn('bot activation could not move on', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
    if (!this.host.context) {
      void moveOn().catch(failed)
      return
    }
    const endedBy = this.endedBy(this.store.activation(row.id) ?? row, run)
    void this.afterDispatch(row, dispatch.threadId, dispatch.clientRequestId, endedBy).then((ok) => {
      if (ok) return moveOn()
      this.settling.delete(row.id)
      return undefined
    }).catch(failed)
  }

  /** Copies a bot thread into the journal again (`needsSync`); it stays listed until a copy succeeds. */
  private resync(ref: { botId: string; threadId: string; lane: BotLane; activationId: string }): void {
    const journal = this.host.journal
    if (!journal) return
    this.needsSync.set(ref.threadId, ref)
    void journal.syncThread(ref).then(() => {
      if (this.needsSync.get(ref.threadId) === ref) this.needsSync.delete(ref.threadId)
    }, (error: unknown) => {
      console.warn('a bot thread could not be copied into the journal; the next tick tries again', { threadId: ref.threadId, error: error instanceof Error ? error.message : String(error) })
      if (isJournalFailure(error)) this.journalFailedFor(ref.botId)
    })
  }

  /** The dispatch's processes are confirmed gone (`exit_at`), outside the turn's own end. */
  private settleProcesses(dispatch: BotDispatchRow): void {
    if (dispatch.startedAt === null || !this.host.supervision) return
    void this.host.supervision.settled(dispatch.clientRequestId).catch((error: unknown) => console.warn('a bot dispatch\'s processes could not be confirmed gone', { dispatchId: dispatch.clientRequestId, error: error instanceof Error ? error.message : String(error) }))
  }

  /** How a main dispatch ended, for capture. */
  private endedBy(row: BotActivationRow, run: RunRecord): BotDispatchEnd {
    if (run.status === 'completed') return 'settled'
    if (run.status === 'interrupted' && run.outcome?.interruptedBy === 'bot_wall') return row.status === 'waiting_grant' || !row.reloadPending ? 'wall' : 'reload'
    if (run.status === 'failed') return 'failed'
    return 'stopped'
  }

  /**
   * Capture after a dispatch (bot-context.md §4): the dispatch's thread is copied into the journal
   * before anything else of the activation happens. A journal that cannot be written makes the bot
   * stuck; false then, and nothing more runs.
   */
  private async afterDispatch(row: BotActivationRow, threadId: string, dispatchId: string, endedBy: BotDispatchEnd): Promise<boolean> {
    try {
      await this.host.context?.afterDispatch({ botId: row.botId, activationId: row.id, dispatchId, lane: row.lane, threadId, endedBy })
      return true
    } catch (error) {
      console.warn('a bot dispatch could not be recorded', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
      if (isJournalFailure(error)) {
        this.journalFailed(this.store.activation(row.id) ?? row)
        return false
      }
      // Any other capture failure is retried by the next capture (cursors); the activation goes on.
      return true
    }
  }

  /** The dispatch's chips for its message, and the live chip is cleared. */
  private drainChips(row: BotActivationRow, key: string, dispatchId: string): void {
    const sink = this.host.activity
    if (sink) {
      try {
        const chips = sink.drain(dispatchId)
        // A chip of a thread the bot started, messaged or stopped keeps that thread, which its Open shows.
        if (chips.length) this.drained.set(key, chips.map((chip) => ({ icon: chip.icon, text: chip.text, ...(chip.highlight ? { highlight: chip.highlight } : {}), ...(chip.thread ? { thread: chip.thread } : {}), ...(chip.said ? { said: chip.said } : {}) })))
      } catch {
        // No chips; the message still posts.
      }
    }
    this.clearLiveChip(row)
  }

  /**
   * The live chip of a working activation (`BotActivitySink` calls this, at most 4 a second):
   * `bots.activity`, and what `bots.chat.list` returns as `live`. Null clears it.
   */
  publishActivity(event: { botId: string; activationId: string; chip: BotChip | null }): void {
    if (event.chip) this.liveChips.set(event.activationId, { botId: event.botId, chip: event.chip })
    else this.liveChips.delete(event.activationId)
    try { this.events.emit('activity', event) } catch { /* a listener never stops a call */ }
  }

  private clearLiveChip(row: BotActivationRow): void {
    if (!this.liveChips.has(row.id)) return
    this.publishActivity({ botId: row.botId, activationId: row.id, chip: null })
  }

  /** The bot's working activation and its live chip, chat lane first (each piece of work's chip comes as `activity`). */
  liveActivity(botId: string): { activationId: string; chip?: BotChip } | undefined {
    const working = [...this.store.laneActivations(botId, 'chat', ['running']), ...this.store.laneActivations(botId, 'run', ['running'])][0]
    if (!working) return undefined
    const chip = this.liveChips.get(working.id)?.chip
    return { activationId: working.id, ...(chip ? { chip } : {}) }
  }

  private settleConsult(row: BotActivationRow, dispatch: BotDispatchRow, run: RunRecord, outcome: { text?: string }, fromExecutor: boolean): void {
    const key = `${row.id}:${dispatch.n}`
    this.liveRuns.delete(run.runId)
    // The executor's settle carries the final message; the terminal event settles one it never ran.
    if (!fromExecutor && this.executing.has(key)) return
    this.executing.delete(key)
    this.store.run('UPDATE bot_dispatches SET ended_at = ?, outcome = ?, run_id = COALESCE(run_id, ?) WHERE activation_id = ? AND n = ? AND ended_at IS NULL', this.store.now(), run.status, run.runId, row.id, dispatch.n)
    const waiter = this.consultWaiters.get(key)
    this.consultWaiters.delete(key)
    waiter?.resolve(run.status === 'completed' ? outcome.text ?? '' : `The consult ended without an answer (${run.status}).`)
    this.settleProcesses(dispatch)
    if (!fromExecutor && this.host.journal) this.needsSync.set(dispatch.threadId, { botId: row.botId, threadId: dispatch.threadId, lane: row.lane, activationId: row.id })
    if (this.host.context) void this.afterDispatch(row, dispatch.threadId, dispatch.clientRequestId, run.status === 'completed' ? 'settled' : run.status === 'failed' ? 'failed' : 'stopped').catch(() => false)
    void this.advance(row.id).catch(() => {})
  }

  /** Stops every consult of a main dispatch that is still running. */
  private stopConsults(row: BotActivationRow, mainN: number): void {
    const runs = this.host.runs()
    for (const consult of this.store.dispatches(row.id)) {
      if (consult.kind !== 'consult' || consult.mainN !== mainN) continue
      const runId = consult.runId ?? this.receiptRun(consult.clientRequestId)
      const run = runId ? runs?.getRun(runId) : undefined
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) continue
      if (run.status === 'queued') {
        try { runs!.markTerminal(run.runId, 'cancelled', { error: 'bot_dispatch_ended' }) } catch { /* it started meanwhile */ }
        continue
      }
      void Promise.resolve(this.host.stopThread?.(consult.threadId)).catch(() => {})
    }
  }

  /**
   * Settles the dispatch of a bot run that reached a terminal state (the run engine's terminal
   * event): whatever path the turn took, no activation is left running after its run ended.
   */
  settleRun(runId: string): void {
    const dispatch = this.store.dispatchByRun(runId)
    if (!dispatch || dispatch.endedAt !== null) return
    // A run the last process left, ended by the boot, is the startup pass's: it charges the dispatch up to its last
    // recorded working moment and carries the activation on.
    const ended = this.host.runs()?.getRun(runId)
    if (ended && stoppedByMousse(ended) && this.live.get(dispatch.activationId)?.n !== dispatch.n) return
    if (dispatch.kind === 'consult') {
      const row = this.store.activation(dispatch.activationId)
      const run = this.host.runs()?.getRun(runId)
      if (row && run && TERMINAL_RUN_STATUSES.has(run.status)) this.settleConsult(row, dispatch, run, {}, false)
      return
    }
    this.settle({ kind: 'bot', runId, threadId: dispatch.threadId, activationId: dispatch.activationId, dispatchN: dispatch.n }, {})
  }

  /** The bot's lanes start what waits; the run lane picks across the profile's bots (`nextRun`). */
  private pumpLater(botId: string): void {
    void this.pump(botId).catch((error) => console.warn('next bot activation could not start', { botId, error: error instanceof Error ? error.message : String(error) }))
  }

  /** The scratch folder goes when the activation has ended (it stays while it waits or is paused). */
  private cleanup(row: BotActivationRow): void {
    if (!ENDED_ACTIVATION_STATUSES.has(row.status)) return
    this.refusedAsks.delete(row.id)
    this.roomKeys.delete(row.id)
    this.carried.delete(row.id)
    this.offeredNotes.delete(row.id)
    // Its browser tabs close too, and the bot's browser once nothing else uses it.
    try {
      this.host.browser?.activationEnded({ botId: row.botId, activationId: row.id })
    } catch (error) {
      console.warn('the bot browser could not let go of an activation', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
    if (!row.scratch) return
    try {
      rmSync(row.scratch, { recursive: true, force: true })
    } catch (error) {
      console.warn('bot scratch folder could not be removed', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The activation cannot go on under its grant or on its runtime: it stops `blocked`, and the
   * chat says so in plain words (a runtime that cannot hold the bot is the bot's stuck error).
   */
  private block(row: BotActivationRow, code: string, reason: string): { refused: string; code: string } {
    const stuck: BotStoredError | undefined = code === 'policy_unenforceable'
      ? { code, error: { text: 'I can\'t run on the providers set up here.', action: { kind: 'open_providers', label: 'Open providers' } } }
      : undefined
    // Nobody waits on a run to continue it: it ends failed, and counts toward the failure pause.
    if (row.lane === 'run') {
      this.failActivation(row, code, stuck)
      return { code, refused: reason }
    }
    try {
      this.store.db.transaction(() => {
        if (!this.store.moveActivation(row.id, ['running'], 'blocked', { endReason: code })) return
        if (stuck) this.store.setError(row.botId, stuck)
        this.chat.post({ botId: row.botId, author: 'bot', kind: 'error', text: '', error: stuck?.error ?? { text: failureText(code) }, activationId: row.id, lane: row.lane, id: `bm_${row.id}_blocked_${this.store.nextDispatchN(row.id)}` })
      })
    } catch (error) {
      if (isJournalFailure(error)) this.journalFailed(row)
      else this.store.moveActivation(row.id, ['running'], 'blocked', { endReason: code })
    }
    this.packs.delete(row.id)
    this.changed({ botId: row.botId, activationId: row.id })
    this.pumpLater(row.botId)
    return { code, refused: reason }
  }

  // -- Trash, profile removal and startup (PR 6 §4, §5a) -----------------------------------------

  /**
   * The lifecycle coordinator is about to trash `threadIds` (a thread and every thread it owns):
   * every unfinished activation whose own, home or context thread is among them ends `cancelled`
   * with `thread_trashed`, its escalations close, and its dispatch and consults stop. Idempotent,
   * so the index projection runs it again after the move. Restoring never revives an activation.
   */
  beforeTrash(threadIds: readonly string[], options: { retireContexts?: boolean } = {}): BotActivationRow[] {
    // Ordinary threads never touch bots.db, so an unreadable bots.db never blocks their trash.
    const ours = threadIds.filter((threadId) => this.known.has(threadId) || this.roleOrHomeOf(threadId))
    if (!ours.length) return []
    const trashed = new Set(ours)
    const threads = this.store.allThreads()
    // A trashed context thread is retired: the next consult of its key starts a new one. During a
    // trash this waits until the thread has moved (`afterTrash`), so a refused trash resets nothing.
    if (options.retireContexts !== false)
      for (const thread of threads) if (thread.role === 'context' && trashed.has(thread.threadId)) {
        this.store.retireContextThread(thread.threadId)
        this.known.delete(thread.threadId)
      }
    const touched = new Set(threads.filter((thread) => trashed.has(thread.threadId) && thread.role !== 'activation').map((thread) => thread.botId))
    const ended = this.store.db.transaction(() => {
      const rows = this.store.activationsWith([...NOT_ENDED]).filter((row) => touched.has(row.botId) || (row.threadId !== null && trashed.has(row.threadId)))
      for (const row of rows) {
        this.store.moveActivation(row.id, [row.status], 'cancelled', { endReason: 'thread_trashed' })
        this.store.closeEscalations(row.id, 'cancelled')
      }
      return rows
    })
    for (const row of ended) {
      void this.stopRun(row)
      this.cleanup({ ...row, status: 'cancelled' })
      this.changed({ botId: row.botId, activationId: row.id })
    }
    for (const botId of new Set(ended.map((row) => row.botId))) this.pumpLater(botId)
    return ended
  }

  afterTrash(threadIds: readonly string[]): void {
    this.beforeTrash(threadIds)
  }

  /**
   * Before a thread goes to the trash: ends the activations it belongs to and waits until their
   * runs have stopped, so the trash's own idle check does not refuse it. Never throws.
   */
  async quiesceForTrash(threadIds: readonly string[]): Promise<boolean> {
    let ended: BotActivationRow[]
    try {
      ended = this.beforeTrash(threadIds, { retireContexts: false })
    } catch (error) {
      console.warn('bot activations could not be ended for the trash', { error: error instanceof Error ? error.message : String(error) })
      return true
    }
    return this.stopAndWait(ended)
  }

  /**
   * The bot threads among `threadIds` (its home, activation and context threads). A trash accepted
   * for them ends their activations and stops their runs in its drain, so the trash's idle check
   * does not count those threads' bot turns as other work. Never throws.
   */
  botThreadsAmong(threadIds: readonly string[]): string[] {
    return threadIds.filter((threadId) => this.known.has(threadId) || this.roleOrHomeOf(threadId))
  }

  /** Whether a thread is any bot thread (home included), read from bots.db. */
  private roleOrHomeOf(threadId: string): boolean {
    try {
      return this.store.threadRole(threadId) !== undefined
    } catch {
      return false
    }
  }

  /** What a profile removal ends: unfinished activations (running, waiting, paused, queued). */
  ownedActivity(): number {
    try {
      return this.store.activationsWith([...NOT_ENDED]).length
    } catch {
      return 0
    }
  }

  /**
   * The startup pass (PR 6 §5a), after the run engine's boot recovery and before its workers, so
   * nothing that could change a bot run is running yet. Phase 1 settles and cleans up whatever the
   * activation's state; phase 2 collects unknown calls; phase 3 decides each unfinished
   * activation's state, first matching row wins. Every step is idempotent: a crash during the pass
   * is repaired by the next one. A failure pauses the activation with `reconcile_failed`.
   */
  async reconcileOnStartup(): Promise<void> {
    try {
      // Capture first (bot-context.md §4): every bot thread is copied into the journal past its
      // cursor before any activation is admitted or the scheduler starts.
      try {
        const caught = await this.host.journal?.catchUp()
        // A bot whose journal cannot be written is stuck until the owner tries again; the others go on.
        for (const botId of caught?.failedBots ?? []) this.journalFailedFor(botId)
      } catch (error) {
        console.warn('bot threads could not be caught up into the journal', { error: error instanceof Error ? error.message : String(error) })
      }
      // The supervisor's records: what it killed, and when the processes were gone (`exit_at`).
      try {
        await this.host.supervision?.reconcile()
      } catch (error) {
        console.warn('bot supervisor records could not be read', { error: error instanceof Error ? error.message : String(error) })
      }
      await this.reconcileAll()
    } finally {
      this.startupPassed = true
    }
    // Reminders that fell due while Mousse was off are said now, with their time; then the next one is armed.
    await this.deliverDueReminders().catch((error: unknown) => {
      console.warn('bot reminders could not be delivered at startup', { error: error instanceof Error ? error.message : String(error) })
    })
    // A card that waited for a server's tools when Mousse stopped: the servers are read, and it is filled in as they answer.
    try {
      if (this.host.mcp && this.store.escalations({ status: 'open' }).some((row) => waitsForTools(row.permission))) {
        this.watchMcp()
        void this.host.mcp.warm().then(() => this.fillMcpAsks())
      }
    } catch (error) {
      console.warn('bot MCP asks could not be checked at startup', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async reconcileAll(): Promise<void> {
    const runs = this.host.runs()
    if (!runs) return
    this.reconcilePhaseOne(runs)
    for (const row of this.store.activationsWith([...NOT_ENDED])) {
      try {
        await this.reconcileActivation(row, runs)
      } catch (error) {
        console.warn('bot activation could not be reconciled', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
        const current = this.store.activation(row.id)
        if (current && !ENDED_ACTIVATION_STATUSES.has(current.status) && current.status !== 'queued')
          this.store.moveActivation(row.id, [current.status], 'paused', { endReason: 'reconcile_failed' })
      }
    }
    // A dispatch's message Mousse stopped before writing (its id is the dispatch's, so it is written once).
    this.postMissingReplies()
    // An owner's message that answered a chat's wall, written just before Mousse stopped.
    for (const row of this.store.activationsWith(['waiting_grant']).filter((activation) => activation.lane === 'chat')) {
      const latest = this.store.get("SELECT id FROM bot_messages WHERE activation_id = ? AND author = 'owner' ORDER BY seq DESC LIMIT 1", row.id)
      const message = latest ? this.store.message(latest.id as string) : undefined
      if (message) await this.admitWallMessage(message).catch((error: unknown) => {
        console.warn('an owner message could not be answered at startup', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
      })
    }
    // Waiting work whose answer was lost (Mousse stopped between it and the work's own update) ends with a line.
    this.settleStrandedWork()
    for (const botId of this.waitingBots()) this.pumpLater(botId)
  }

  /** The bots with something that waits for its lane: a queued activation, or work that waits to go on. */
  private waitingBots(): Set<string> {
    return new Set([...this.store.activationsWith(['queued']), ...this.store.activationsWith(['blocked']).filter(workWaits)].map((row) => row.botId))
  }

  /**
   * Work that ran out of room whose notice with its ask was never posted (Mousse stopped as its turn ended): posted now,
   * without the turn's last words, which only its thread kept.
   */
  private repostRoom(row: BotActivationRow): void {
    const ask = this.roomAskOf(row)
    const main = this.store.lastMainDispatch(row.id)
    if (!ask || !main || this.store.messagesForAsk(ask.id).some((message) => message.activationId === row.id)) return
    this.recorded(row, () => this.postRoom(row, main.n))
  }

  /**
   * The message of a main dispatch whose activation moved on (done, at a wall, or paused) but whose
   * reply, run report or cards were not written before Mousse stopped: written now from the
   * activation's result. Only the latest finished activations of each lane can be missing one (the
   * chat's last, and the run lane's last `MAX_RUN_SLOTS_PER_BOT`, which may have run side by side);
   * activations from before the chat (no selection) never had one.
   */
  private postMissingReplies(): void {
    const rows = this.store.all(`SELECT id FROM bot_activations a WHERE selection_json IS NOT NULL AND (status IN ('waiting_grant', 'paused')
      OR (status = 'done' AND (SELECT COUNT(*) FROM bot_activations b WHERE b.bot_id = a.bot_id AND b.lane = a.lane AND b.status = 'done' AND b.ended_at > a.ended_at) < CASE a.lane WHEN 'run' THEN ? ELSE 1 END))`, MAX_RUN_SLOTS_PER_BOT)
    for (const { id } of rows) {
      try {
        const row = this.store.activation(id as string)
        const main = row ? this.store.lastMainDispatch(row.id) : undefined
        if (!row || !main?.endedAt || this.store.message(`bm_${row.id}_d${main.n}`)) continue
        this.postReply(row, main, row.result ?? '', false)
      } catch (error) {
        console.warn('a bot message could not be written at startup', { activationId: id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  private reconcilePhaseOne(runs: RunEngine): void {
    // P1: a dispatch whose run was written but whose id was not: the receipt names it.
    for (const dispatch of this.store.all('SELECT * FROM bot_dispatches WHERE run_id IS NULL').map((row) => this.store.dispatch(row.activation_id as string, Number(row.n))!)) {
      const runId = this.receiptRun(dispatch.clientRequestId)
      if (runId) this.store.setDispatchRun(dispatch.activationId, dispatch.n, runId)
    }
    // P2: the supervisor's `reconcile` (above) killed the recorded process groups of unfinished
    // dispatches and wrote their `exit_at`.
    // P3: main dispatches whose time window was never settled (Mousse stopped while they ran): charged up to the last
    // moment they were known to work (`checkpoint_at`: a call checked or finished, its consults' included, or a look
    // every `BOT_OFFLINE_WATCH_MS` while it ran), never past their deadline. The time Mousse was down is not the bot's work.
    for (const row of this.store.all("SELECT activation_id, n FROM bot_dispatches WHERE kind IN ('start', 'continue') AND started_at IS NOT NULL AND settled_by IS NULL")) {
      const main = this.store.dispatch(row.activation_id as string, Number(row.n))!
      const deadline = main.deadlineMs ?? 0
      const prepaid = main.prepaidMs ?? 0
      const charge = Math.max(0, Math.min(deadline, (main.checkpointAt ?? main.startedAt!) - main.startedAt!))
      this.store.db.transaction(() => {
        if (this.store.run("UPDATE bot_dispatches SET used_ms = ?, prepaid_ms = ?, settled_by = 'startup' WHERE activation_id = ? AND n = ? AND settled_by IS NULL", charge, charge, main.activationId, main.n))
          this.store.run('UPDATE bot_counters SET active_ms = active_ms + ? WHERE activation_id = ?', charge - prepaid, main.activationId)
      })
    }
    // P4: a reservation open at the crash stays charged at its full amount.
    for (const held of this.store.all('SELECT * FROM bot_spend_reservations WHERE settled_at IS NULL')) {
      this.store.db.transaction(() => {
        if (!this.store.run('UPDATE bot_spend_reservations SET settled_at = ? WHERE id = ? AND settled_at IS NULL', this.store.now(), held.id as string)) return
        this.store.run(
          'UPDATE bot_spend SET committed_input = committed_input + ?, committed_output = committed_output + ?, committed_usd_micros = committed_usd_micros + ? WHERE activation_id = ?',
          Number(held.input_bound), Number(held.wire_cap), Number(held.usd_micros), held.activation_id as string
        )
        this.store.run('UPDATE bot_counters SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE activation_id = ?', Number(held.input_bound), Number(held.wire_cap), held.activation_id as string)
      })
    }
    // P5: a consult of a settled main dispatch that is still not terminal (boot has already ended
    // it; this is defensive).
    for (const row of this.store.all("SELECT c.* FROM bot_dispatches c JOIN bot_dispatches m ON m.activation_id = c.activation_id AND m.n = c.main_n WHERE c.kind = 'consult' AND m.settled_by IS NOT NULL")) {
      const consult = this.store.dispatch(row.activation_id as string, Number(row.n))!
      const run = consult.runId ? runs.getRun(consult.runId) : undefined
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) continue
      try {
        runs.markTerminal(run.runId, run.status === 'queued' ? 'cancelled' : 'interrupted', { interruptedBy: 'daemon_restart' })
      } catch (error) {
        console.warn('a bot consult could not be ended at startup', { runId: run.runId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    // P6: a context thread in the trash or gone is forgotten; the next consult starts a new one.
    for (const thread of this.store.allThreads()) {
      if (thread.role !== 'context' || this.threadState(thread.threadId) === 'active') continue
      this.store.retireContextThread(thread.threadId)
      this.known.delete(thread.threadId)
    }
    // P7: the scratch folders of ended activations.
    for (const row of this.store.activationsWith(['done', 'failed', 'cancelled'])) if (row.scratch && existsSync(row.scratch)) this.cleanup(row)
  }

  private async reconcileActivation(row: BotActivationRow, runs: RunEngine): Promise<void> {
    // Phase 2: unknown calls across the main runs and every consult (all ended after boot recovery).
    this.collectUnknownCalls(row)
    const end = (status: 'cancelled' | 'failed', reason: string): void => {
      this.store.db.transaction(() => {
        this.store.moveActivation(row.id, [row.status], status, { endReason: reason })
        this.store.closeEscalations(row.id, 'cancelled')
        for (const dispatch of this.store.dispatches(row.id)) {
          const run = dispatch.runId ? runs.getRun(dispatch.runId) : undefined
          if (run?.status === 'queued') runs.markTerminal(run.runId, 'cancelled', { error: reason })
        }
      })
      this.cleanup(this.store.activation(row.id)!)
      this.changed({ botId: row.botId, activationId: row.id })
    }
    // Row 1: the bot was deleted (a crash during its deletion): its threads are archived again.
    if (this.store.registry(row.botId)?.deletedAt) {
      end('cancelled', 'bot_deleted')
      await this.archiveThreads(row.botId)
      return
    }
    // Row 2: the activation's thread or the bot's home thread is in the trash or gone.
    const home = this.store.registry(row.botId)?.homeThreadId
    const states = [row.threadId, home].filter((id): id is string => Boolean(id)).map((id) => this.threadState(id))
    if (states.includes('trashed')) return end('cancelled', 'thread_trashed')
    if (states.includes('missing')) return end('failed', 'thread_missing')
    // Row 13: a queued activation starts when its bot is free. Paused and blocked ones wait for the owner; work that
    // waits to go on gets the notice Mousse stopped before posting, and goes on when its lane is free (`pump`).
    if (row.status === 'queued' || row.status === 'paused' || row.status === 'blocked') {
      if (workWaits(row) && row.endReason === 'budget_exhausted') this.repostRoom(row)
      return
    }
    // Row 3: an open escalation keeps the activation waiting, whatever its run's state; never continued here.
    if (row.status === 'waiting_grant') {
      const open = this.store.escalations({ activationId: row.id, status: 'open' }).filter((ask) => ask.mode === 'wall').at(-1)
      if (open) {
        // Asks never expire; only an older build's escalation carries a time.
        if (open.expiresAt && Date.parse(open.expiresAt) <= this.now()) this.expire(open.id)
        else if (open.expiresAt) this.armExpiry(open)
        return
      }
      // Answered before the crash, but its continuation was never sent: send it now, behind the
      // unknown-call gate (every run ended at boot).
      const answers = this.store.pendingAnswers(row.id)
      if (answers.length) {
        // The owner's message that answered it goes on as the next input, as before the restart.
        const ownerText = this.wallReplyOf(row, answers)
        await this.continueWith(row.id, ['waiting_grant'], { answers, ...(ownerText !== undefined ? { ownerText } : {}) })
        return
      }
      // Neither an open wall nor an answer: the owner decides.
      this.store.moveActivation(row.id, ['waiting_grant'], 'paused', { endReason: 'wall_lost' })
      this.changed({ botId: row.botId, activationId: row.id })
      return
    }
    const main = this.store.lastMainDispatch(row.id)
    // Claimed from the queue, but its first dispatch was never written: start it again; its threads
    // and dispatch have fixed identities, so nothing is made twice.
    if (!main) return this.startActivation(row)
    // A queued run of an earlier main dispatch (a restart replaced it) never starts.
    for (const earlier of this.store.dispatches(row.id))
      if (earlier.kind !== 'consult' && earlier.n < main.n && earlier.runId && runs.getRun(earlier.runId)?.status === 'queued')
        runs.markTerminal(earlier.runId, 'cancelled', { error: 'bot_dispatch_restarted' })
    for (const dispatch of this.store.dispatches(row.id))
      if (dispatch.endedAt === null && dispatch.runId) {
        const ended = runs.getRun(dispatch.runId)
        if (ended && TERMINAL_RUN_STATUSES.has(ended.status))
          this.store.run('UPDATE bot_dispatches SET ended_at = ?, outcome = ? WHERE activation_id = ? AND n = ? AND ended_at IS NULL', this.store.now(), ended.status, row.id, dispatch.n)
      }
    const run = main.runId ? runs.getRun(main.runId) : undefined
    // Row 4: the owner's Stop.
    if (run && (run.status === 'cancelled' || run.status === 'interrupted') && run.outcome?.interruptedBy === 'user') return end('cancelled', 'stopped')
    // Row 5: unacknowledged unknown calls (main or consult), or an `uncertain` main run.
    const unknown = this.store.unknownCalls(row.id).some((call) => !call.acknowledged)
    if (unknown || run?.status === 'uncertain') {
      this.store.moveActivation(row.id, ['running'], 'paused', { endReason: unknown ? 'unknown_calls' : 'uncertain' })
      this.stoppedRow(this.store.activation(row.id) ?? row)
      this.changed({ botId: row.botId, activationId: row.id })
      return
    }
    // Row 6: the dispatch intent was written, its run never was: send it again with the same request id.
    if (!run) {
      if (!this.grantHolds(row)) return void this.block(row, 'bot_grant_revoked', 'The bot\'s permissions were revoked or changed.')
      // The same options the intent was written with (the run it continues, the owner's acknowledgement).
      await this.sendDispatch(row, main)
      return
    }
    // Row 7: the run never left `queued` (its `turn.start` was cancelled by boot).
    if (run.status === 'queued') {
      if (!this.grantHolds(row)) {
        runs.markTerminal(run.runId, 'cancelled', { error: 'bot_grant_revoked' })
        return void this.block(row, 'bot_grant_revoked', 'The bot\'s permissions were revoked or changed.')
      }
      if (main.startedAt === null) {
        runs.outbox.enqueue({ threadId: main.threadId, runId: run.runId, kind: 'turn.start', payload: { kind: 'bot', runId: run.runId, threadId: main.threadId, activationId: row.id, dispatchN: main.n } satisfies BotTurnPayload })
        return
      }
      // Its time window was already settled (up to its last working moment): too little left is a budget wall, as for an
      // interrupted run.
      const left = this.remainingMs(row)
      if (left !== undefined && left < ACTIVE_TIME_CHUNK_MS) {
        runs.markTerminal(run.runId, 'cancelled', { error: 'bot_dispatch_restarted' })
        this.wallAtRest(row, this.timeWallAt(row, main.n))
        return
      }
      // Otherwise a new dispatch with the same prompt, never the old row again. The new intent is
      // written first; the old run is cancelled after, so a crash between them is a plain resend (row 6).
      const n = this.store.nextDispatchN(row.id)
      this.store.insertDispatch({ activationId: row.id, n, kind: 'continue', clientRequestId: `${row.id}:d${n}`, threadId: main.threadId, prompt: main.prompt, policyDigest: row.grantDigest, send: main.send })
      runs.markTerminal(run.runId, 'cancelled', { error: 'bot_dispatch_restarted' })
      await this.sendDispatch(row, this.store.dispatch(row.id, n)!)
      return
    }
    // A run that ended while the activation waited for the internet: it waits again, and carries
    // on once the internet is back (`advance`); never an automatic restart or a budget wall.
    if (row.offline && (run.status === 'interrupted' || run.status === 'failed')) {
      await this.advance(row.id)
      return
    }
    // Rows 8 and 9: the run ended before bots.db was updated.
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      if (run.status === 'cancelled') return end('cancelled', typeof run.outcome?.error === 'string' ? run.outcome.error : 'cancelled')
      await this.advance(row.id)
      return
    }
    if (run.status !== 'interrupted') return
    // Row 10: under 15 s of work time left after P3 (it worked up to its deadline): a budget wall, as at a
    // deadline (work the owner asked for waits for the answer with what it had).
    const remaining = this.remainingMs(row)
    if (remaining !== undefined && remaining < ACTIVE_TIME_CHUNK_MS) {
      this.wallAtRest(row, this.timeWallAt(row, main.n))
      return
    }
    // Rows 11 and 12: one automatic continuation, then the owner decides.
    if (row.autoRestarts >= 1) {
      this.store.moveActivation(row.id, ['running'], 'paused', { endReason: 'restarted_twice' })
      this.stoppedRow(this.store.activation(row.id) ?? row)
      this.changed({ botId: row.botId, activationId: row.id })
      return
    }
    await this.continueWith(row.id, ['running'], { restart: true })
  }

  private grantHolds(row: BotActivationRow): boolean {
    const grant = this.store.activeGrant(row.botId)
    const definition = this.host.definitions.revision(row.botId, row.revision)
    return Boolean(grant && definition && grant.digest === row.grantDigest && manifestSubset(definition.permissions, grant.manifest))
  }

  private remainingMs(row: BotActivationRow): number | undefined {
    const grant = this.store.activeGrant(row.botId)
    const definition = this.host.definitions.revision(row.botId, row.revision)
    if (!grant || !definition) return undefined
    return this.effectiveManifest(row, definition.permissions, grant.manifest).budget.maxActiveMs - this.store.counters(row.id).activeMs
  }

  // -- Threads ----------------------------------------------------------------------------------

  roleOf(threadId: string): BotThreadRole | undefined {
    let role: 'home' | BotThreadRole | undefined
    try {
      role = this.store.threadRole(threadId)
    } catch {
      role = this.known.get(threadId)?.role
    }
    // The home thread runs the chat lane's turns: as bot turns, like an activation thread's.
    return role === 'home' ? 'activation' : role === 'activation' || role === 'context' ? role : undefined
  }

  /** The bot `threadId` belongs to, with its name now (`BotThreads.botOf`). Never throws. */
  botOf(threadId: string): { botId: string; name: string } | undefined {
    let botId: string | undefined
    try {
      botId = this.store.threadBot(threadId)
    } catch {
      botId = this.known.get(threadId)?.botId
    }
    if (!botId) return undefined
    return { botId, name: this.ownerOf(threadId) ?? botId }
  }

  /**
   * "Use your threads" was removed (About → Remove) or switched off on this computer: the bot's messages still waiting
   * in its owner's threads are withdrawn (`BotEngineHost.threadsWithdrawn`). A bot with no chat thread yet sent none.
   */
  withdrawThreadMessages(botId: string): void {
    const homeThreadId = this.store.registry(botId)?.homeThreadId
    if (!homeThreadId || !this.host.threadsWithdrawn) return
    let name = botId
    try {
      name = this.definitionOf(botId).name
    } catch {
      // A bot without its definition still has its messages withdrawn, under its id.
    }
    try {
      this.host.threadsWithdrawn({ botId, homeThreadId, name })
    } catch (error) {
      console.warn('a bot\'s waiting thread messages could not be withdrawn', { botId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The chat turn `activationId` when its owner's own message started it (`BotThreads.ownerTurn`), with the
   * limit of the other device that message came from; undefined for any other turn, or when it can't be read.
   */
  ownerTurn(activationId: string): { limit?: PermissionMode } | undefined {
    let row: BotActivationRow | undefined
    try {
      row = this.store.activation(activationId)
    } catch {
      return undefined
    }
    if (!row || !ownerChatTurn(row)) return undefined
    const limit = row.trigger.kind === 'manual' ? row.trigger.owner?.limit : undefined
    return limit ? { limit } : {}
  }

  /** Never throws: a failed read answers from the threads this process knows of. */
  ownerOf(threadId: string): string | undefined {
    let botId: string | undefined
    try {
      botId = this.store.threadBot(threadId)
    } catch {
      botId = this.known.get(threadId)?.botId
    }
    if (!botId) return undefined
    try {
      const entry = this.host.definitions.get(botId)
      return (entry?.published ?? entry?.draft)?.name ?? botId
    } catch {
      return botId
    }
  }

  // -- The Bot UI (Bot Phase 1 §5.3) ------------------------------------------------------------

  /** The ids of the bots that are not deleted, oldest first. */
  botIds(): string[] {
    return this.store.listRegistry().map((row) => row.botId).filter((botId) => {
      try {
        return this.host.definitions.get(botId) !== undefined
      } catch {
        return false
      }
    })
  }

  /** The bot as it runs (its published revision, else its draft); throws for a deleted or unknown bot. */
  definitionOf(botId: string): BotDefinition {
    const entry = this.entry(botId)
    return entry.published ?? entry.draft
  }

  /** `{ botName }` for a `bots.message` event, or nothing for a bot that is gone. */
  private nameFor(botId: string): { botName?: string } {
    try {
      return { botName: this.definitionOf(botId).name }
    } catch {
      return {}
    }
  }

  /**
   * A new bot (§5.3.1): its revision is published and its starter grant approved in one go
   * (pressing Create bot is that approval), its home thread and files folder are made.
   */
  createBot(definition: BotDefinition): void {
    if (this.store.registry(definition.id)) throw new BotEngineError('bot_exists', 'A bot with that id exists already.')
    const revision = this.definitionCall(() => this.host.definitions.publishRevision(definition))
    this.host.definitions.save(revision)
    this.store.db.transaction(() => {
      this.store.ensureRegistry(definition.id)
      this.store.setPublished(definition.id, revision.revision!)
      this.store.approve(definition.id, botManifestDigest(revision.permissions), revision.permissions)
    })
    this.ensureHome(definition.id, definition.name)
    mkdirSync(this.filesFolder(definition.id), { recursive: true, mode: 0o700 })
    this.changed({ botId: definition.id })
  }

  /**
   * One model call for a bot (naming it): on the model its chat will run on (`pick`, the Talk row the owner picked; a bot
   * made without picks by usage), within `timeoutMs`. Undefined when that model can't run it or the call failed.
   */
  async oneShotFor(botId: string, prompt: string, timeoutMs: number, pick: BotModelPick | null = null): Promise<string | undefined> {
    const models = this.host.models
    const oneShot = this.host.oneShot
    if (!models || !oneShot) return undefined
    const signal = AbortSignal.timeout(timeoutMs)
    const timedOut = new Promise<undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }))
    const call = (async () => {
      const compiled = this.compileNeutral({ key: 'main', title: 'Main', agent: { instructions: '' }, model: { mode: 'auto', depth: 'normal' } }, starterManifest(), { escalate: true, consult: false, memory: true }, botId)
      if (!compiled.ok) return undefined
      const resolved = await models.resolve({ botId, pick, depth: 'quick', policy: { mode: 'default', origin: 'bot', ...compiled.policy } })
      if ('problem' in resolved || signal.aborted) return undefined
      return oneShot({ selection: resolved.selection, prompt, signal })
    })().catch(() => undefined)
    return Promise.race([call, timedOut])
  }

  /** `bots.personal.pause`: the owner pauses the bot's schedules. Chat still works. */
  pauseBot(botId: string): void {
    this.entry(botId)
    this.store.setPaused(botId, 'owner')
    this.changed({ botId })
  }

  /** `bots.personal.resume`: every pause ends (the owner's, three failures, a usage limit), with the failure streak and the stuck error. */
  async resumeBot(botId: string): Promise<void> {
    this.entry(botId)
    // The usage limits this bot met on its entries go too, here and in the model choice: the next turn tries again.
    const limited = Object.values(this.store.registry(botId)?.model?.limits ?? {}).map((limit) => limit.instanceId)
    this.store.db.transaction(() => {
      this.store.setPaused(botId, null)
      this.store.setError(botId, null)
      if (limited.length) this.updateModelStateInTx(botId, (state) => ({ ...state, limits: {} }))
    })
    for (const instanceId of new Set(limited)) {
      try { this.host.models?.clearLimited?.(instanceId) } catch { /* the next limit marks it again */ }
    }
    // Work a usage limit stopped tries again now, as the owner asked.
    for (const [activationId, wait] of this.usageWaits) if (wait.botId === botId) this.usageWaits.delete(activationId)
    this.changed({ botId })
    try { this.host.schedulesChanged?.() } catch { /* the next tick reads it */ }
    // A row that can't run is not paused: it clears when its pick can run again, which is checked now too.
    await this.recheckStuck(botId).catch(() => {})
    await this.pump(botId)
  }

  /** The owner's message could not start the chat: an error row says why. */
  chatError(botId: string, code: string): void {
    try {
      this.chat.post({ botId, author: 'bot', kind: 'error', text: '', error: { text: failureText(code) }, lane: 'chat' })
    } catch (error) {
      console.warn('a bot error could not be shown', { botId, error: error instanceof Error ? error.message : String(error) })
    }
    this.changed({ botId })
  }

  /** `bots.chat.stop`: the chat lane's running or waiting activation stops. */
  async stopChat(botId: string): Promise<void> {
    this.entry(botId)
    for (const row of this.store.laneActivations(botId, 'chat', ['running', 'waiting_grant'])) await this.stop(row.id)
  }

  /** `bots.chat.markRead`: the unread count drops to what follows `seq`. */
  markRead(botId: string, seq: number): void {
    this.entry(botId)
    this.store.setReadSeq(botId, seq)
    this.changed({ botId })
  }

  // -- The bot app tools' host (BotToolHost, §7.1) ----------------------------------------------

  /** What the bot app tools (WP3, WP6) reach the engine through. Lane and bot come from the thread, never from arguments. */
  readonly tools: BotToolHost & { activationOf(threadId: string): ({ botId: string; activationId: string; lane: BotLane; role: 'home' | BotThreadRole; dispatchId?: string }) | undefined } = {
    activationOf: (threadId) => this.activationOf(threadId),
    schedules: {
      add: (botId, schedule) => {
        const added = this.addSchedule(botId, schedule, 'bot')
        return { scheduleId: added.scheduleId, label: added.label }
      },
      remove: (botId, scheduleId) => this.removeSchedule(botId, scheduleId),
      list: (botId) => this.listSchedules(botId)
    },
    setProfile: (botId, profile) => this.setProfile(botId, profile),
    setModel: (botId, activationId, scope, choice) => this.setModel(botId, activationId, scope, choice),
    ownerWords: (botId, activationId) => this.ownerWords(botId, activationId),
    rows: (botId) => this.ownerSlots(botId),
    mcpServers: (botId, lane) => this.mcpServerList(botId, lane),
    work: {
      start: (botId, from, input) => this.startWork(botId, from, input),
      list: (botId) => this.listWork(botId),
      stop: (botId, workId) => this.stopWork(botId, workId),
      note: (botId, workId, note, from) => this.noteWork(botId, workId, note, from),
      reach: (botId, workId) => this.noteReach(botId, workId)
    },
    reminders: {
      add: (botId, from, input) => this.addReminder(botId, from, input),
      list: (botId) => this.store.waitingReminders(botId).map((reminder) => ({ reminderId: reminder.id, dueAt: reminder.dueAt, text: reminder.text, ...(reminder.work ? { work: reminder.work.title } : {}) })),
      cancel: (botId, reminderId) => {
        const reminder = this.store.reminder(reminderId)
        if (!reminder || reminder.botId !== botId) return false
        const cancelled = this.store.settleReminder(reminderId, 'cancelled')
        if (cancelled) {
          this.armReminders()
          this.changed({ botId })
        }
        return cancelled
      }
    }
  }

  // -- Work and reminders (docs/plans/bot-always-free.md) ---------------------------------------
  //
  // The chat is the bot's front desk: it talks, decides and hands longer work to a run of its own, so the
  // owner can keep talking while it works. Work is a run-lane activation (trigger `work`) on its own thread;
  // its report answers the owner's message that asked for it. Reminders are the bot's one-off times.

  /** The owner's message a chat activation answers: the newest one it holds (a message sent at a wall continues it). */
  ownerMessageOf(activationId: string): string | undefined {
    const row = this.store.get("SELECT id FROM bot_messages WHERE activation_id = ? AND author = 'owner' ORDER BY seq DESC LIMIT 1", activationId)
    return row ? row.id as string : undefined
  }

  /**
   * The owner's own words in a chat activation (#673, `use_model always`): the messages it holds (the one it answers,
   * and any sent at a wall that continued it), oldest first. Empty for a run, which has no owner message of its own.
   */
  ownerWords(botId: string, activationId: string): string {
    const row = this.store.activation(activationId)
    if (!row || row.botId !== botId || row.lane !== 'chat') return ''
    const rows = this.store.all("SELECT text FROM bot_messages WHERE activation_id = ? AND author = 'owner' ORDER BY seq", activationId)
    return rows.map((message) => (typeof message.text === 'string' ? message.text : '')).join('\n')
  }

  /** What a run is about, in a few words: the work's title, else its request's first line. */
  workTitle(row: BotActivationRow): string {
    if (row.trigger.kind === 'work') return row.trigger.title
    return summarise(row.trigger.input)
  }

  /**
   * `work_start`: the chat hands work off. It runs in the run lane beside the chat, up to `MAX_RUN_SLOTS_PER_BOT` pieces
   * at once, and reports to the owner, answering the message that asked for it. Work that does not fit waits, and says
   * what it waits behind: the bot's own running pieces and what starts before it, or, when the bot has room but the
   * profile does not, the other bots' work.
   */
  async startWork(botId: string, from: string, input: { title: string; brief: string; key: string; level?: BotWorkLevel }): Promise<BotWorkStarted> {
    const brief = input.brief.trim()
    if (!brief) throw new BotEngineError('invalid_params', 'work_start needs a brief.')
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, MAX_WORK_TITLE_CHARS) || summarise(brief)
    const replyTo = this.ownerMessageOf(from)
    // Its level picks its Work row (#673); absent, the bot's standing level.
    const summary = await this.enqueue(botId, `work:${input.key}`, { kind: 'work', input: brief, title, ...(replyTo ? { replyTo } : {}), from, ...(input.level ? { level: input.level } : {}) }, 'run')
    const row = this.store.activation(summary.id)!
    if (ENDED_ACTIVATION_STATUSES.has(row.status)) return { workId: row.id, status: 'ended', ahead: [] }
    if (row.status !== 'queued') return { workId: row.id, status: 'started', ahead: [] }
    return { workId: row.id, status: 'queued', ahead: this.waitsBehind(row) }
  }

  /** What queued run work waits behind, in titles: the queue before it, and what fills the slots it waits for. */
  private waitsBehind(row: BotActivationRow): string[] {
    const before = this.store.laneActivations(row.botId, 'run', ['queued']).sort(runOrder)
    const queued = before.slice(0, before.findIndex((other) => other.id === row.id)).map((other) => this.workTitle(other))
    const running = this.holding(row.botId, 'run')
    if (running.length >= MAX_RUN_SLOTS_PER_BOT) return [...running.map((other) => this.workTitle(other)), ...queued]
    if (this.profileRunsHeld() >= MAX_RUN_SLOTS_PER_PROFILE) return [`your other bots' work (at most ${MAX_RUN_SLOTS_PER_PROFILE} pieces run at once)`, ...queued]
    return queued
  }

  /** `work_list`: what runs or waits in the run lane now (work and scheduled runs), and the last few that ended. */
  listWork(botId: string): BotWorkList {
    // Work that waits to go on is listed too: held while it waits for the owner, waiting its turn once allowed.
    const now = this.store.laneActivations(botId, 'run', ['running', 'waiting_grant', 'queued', 'paused', 'blocked']).filter((row) => row.status !== 'blocked' || workWaits(row)).sort(workOrder).map((row) => {
      const chip = this.liveChips.get(row.id)?.chip
      const status = row.status === 'queued' || row.endReason === 'room_allowed' ? 'queued' as const : row.status === 'paused' || row.status === 'blocked' ? 'paused' as const : row.offline ? 'waiting_for_internet' as const : 'running' as const
      return {
        workId: row.id,
        title: this.workTitle(row),
        status,
        startedAt: row.createdAt,
        ...(chip ? { doing: `${chip.text}${chip.highlight ? ` ${chip.highlight}` : ''}` } : {}),
        kind: row.trigger.kind === 'schedule' ? 'schedule' as const : 'work' as const
      }
    })
    const recent = this.store.all(
      "SELECT id FROM bot_activations WHERE bot_id = ? AND lane = 'run' AND status IN ('done', 'failed', 'cancelled', 'blocked') ORDER BY COALESCE(ended_at, created_at) DESC LIMIT 3",
      botId
    ).flatMap((entry) => {
      const row = this.store.activation(entry.id as string)
      // Work that waits to go on is listed with what runs now, not as ended.
      if (!row || workWaits(row)) return []
      const report = row.result ? cutText(row.result, 300) : undefined
      return [{ workId: row.id, title: this.workTitle(row), status: row.status === 'done' ? 'done' as const : row.status === 'failed' ? 'failed' as const : 'stopped' as const, endedAt: row.endedAt ?? row.createdAt, ...(report ? { report } : {}) }]
    })
    return { now, recent }
  }

  /** `work_stop` (and the work line's Stop): one run of this bot ends; the chat is never stopped this way. */
  async stopWork(botId: string, workId: string): Promise<'stopped' | 'ended' | 'not_found'> {
    const row = this.store.activation(workId)
    if (!row || row.botId !== botId || row.lane !== 'run') return 'not_found'
    if (ENDED_ACTIVATION_STATUSES.has(row.status)) return 'ended'
    await this.stop(workId)
    return 'stopped'
  }

  /**
   * `work_note`: something the owner added, for work that runs or waits. Waiting work gets it with its request. Running
   * work gets it at its turn's next step when its runtime takes notes while it runs (`steerFor`), else when its current
   * turn ends, before it reports (`advance`); `noteReach` says which. Ended work can't take it.
   */
  noteWork(botId: string, workId: string, note: string, from?: string): 'noted' | 'held' | 'ended' | 'not_found' {
    const text = note.trim().slice(0, MAX_WORK_NOTE_CHARS)
    const row = this.store.activation(workId)
    if (!row || row.botId !== botId || row.lane !== 'run' || !text) return 'not_found'
    return this.store.db.transaction(() => {
      const current = this.store.activation(workId)
      if (!current || ENDED_ACTIVATION_STATUSES.has(current.status)) return 'ended' as const
      // Only work that will take it: waiting, running, or waiting to go on. Other paused or blocked work may never continue.
      if (!['queued', 'running', 'waiting_grant'].includes(current.status) && !workWaits(current)) return 'held' as const
      // The note keeps the owner's message it came from (the chat turn's), so a forget of that message reaches it.
      this.store.addWorkNote(workId, botId, text, from ? this.ownerMessageOf(from) : undefined)
      return 'noted' as const
    })
  }

  /**
   * The notes a run takes with its next dispatch, as prompt text, and their ids (marked applied in that dispatch's
   * transaction). A note the last turn took but never reported read may have reached the model already (`offeredNotes`;
   * after a restart, any note: what the process before knew is gone), so it says it may be a repeat.
   */
  private workNotes(row: BotActivationRow, restart = false): { text: string; ids: number[] } | undefined {
    if (row.lane !== 'run') return undefined
    // A note a live turn took and has not read yet is that turn's until it reads it or hands it back.
    const taken = new Set([...(this.live.get(row.id)?.steering.values() ?? [])].flatMap((entry) => entry.ids))
    const notes = this.store.pendingWorkNotes(row.id).filter((note) => !taken.has(note.id))
    if (!notes.length) return undefined
    const offered = this.offeredNotes.get(row.id)
    const repeat = (id: number): boolean => restart || offered?.has(id) === true
    const lines = notes.map((note) => `- ${repeat(note.id) ? '(may be a repeat) ' : ''}${note.text}`)
    const ids = notes.map((note) => note.id)
    const repeats = ids.some(repeat)
    this.notOffered(row.id, ids)
    return {
      text: `The owner added while you worked:\n${lines.join('\n')}${repeats ? `\n${NOTE_REPEAT_LINE}` : ''}`,
      ids
    }
  }

  /** `remind`: a one-off reminder of this bot, said (or its work started) at `dueAt`. */
  addReminder(botId: string, from: string, input: { dueAt: string; text: string; work?: { title: string; brief: string } }): { reminderId: string; dueAt: string } {
    this.entry(botId)
    const due = Date.parse(input.dueAt)
    if (!Number.isFinite(due)) throw new BotEngineError('invalid_params', 'The reminder time is not a date and time.')
    if (due < this.now() - 60_000) throw new BotEngineError('invalid_params', 'That time has passed. Pick a time from now on.')
    if (due > this.now() + MAX_REMINDER_AHEAD_MS) throw new BotEngineError('invalid_params', 'A reminder is at most a year ahead.')
    const text = input.text.trim().slice(0, MAX_REMINDER_TEXT_CHARS)
    if (!text) throw new BotEngineError('invalid_params', 'A reminder needs its text.')
    if (this.store.waitingReminders(botId).length >= MAX_WAITING_REMINDERS) throw new BotEngineError('reminder_limit', `You already have ${MAX_WAITING_REMINDERS} reminders waiting. Cancel one first.`)
    const work = input.work?.brief.trim() ? { title: (input.work.title.trim() || summarise(input.work.brief)).slice(0, MAX_WORK_TITLE_CHARS), brief: input.work.brief.trim() } : null
    const replyTo = this.ownerMessageOf(from) ?? null
    const reminderId = `rem_${randomUUID()}`
    const dueAt = new Date(Math.max(due, this.now())).toISOString()
    this.store.insertReminder({ id: reminderId, botId, dueAt, text, work, replyTo, createdAt: this.store.now() })
    this.armReminders()
    this.changed({ botId })
    return { reminderId, dueAt }
  }

  /** Arms the one timer for the soonest waiting reminder (long waits re-arm, so a far timer never overflows). */
  private armReminders(): void {
    this.reminderTimer?.clear()
    this.reminderTimer = undefined
    if (!this.startupPassed || this.closed) return
    const next = this.store.nextReminder()
    if (!next) return
    // One that failed waits for its retry time; the others behind it are said at the next pass.
    const at = Math.max(Date.parse(next.dueAt), this.reminderRetryAt.get(next.id) ?? 0)
    const wait = Math.min(Math.max(0, at - this.now()), REMINDER_REARM_MS)
    this.reminderTimer = (this.host.setTimer ?? defaultTimer)(() => {
      this.reminderTimer = undefined
      void this.deliverDueReminders().catch((error: unknown) => {
        console.warn('bot reminders could not be delivered', { error: error instanceof Error ? error.message : String(error) })
      })
    }, wait)
  }

  /**
   * Says every reminder that is due (one pass at a time), then arms the next. A message reminder is written with no
   * model call, in the same transaction that marks it delivered, so it is said once. A work reminder starts its work.
   * One that fell due while Mousse was off says when it was for.
   */
  async deliverDueReminders(now: Date = new Date(this.now())): Promise<void> {
    if (!this.startupPassed) return
    if (this.delivering) return this.delivering
    let pass: Promise<void> | undefined
    pass = (async () => {
      // Never synchronous: the pass is held below before any of it runs, so its end always lets go of it.
      await Promise.resolve()
      try {
        // Reminders cancelled, forgotten or purged since they failed are no longer tried.
        for (const id of this.reminderRetryAt.keys()) if (this.store.reminder(id)?.status !== 'waiting') this.reminderRetryAt.delete(id)
        for (const reminder of this.store.dueReminders(now.toISOString())) {
          if ((this.reminderRetryAt.get(reminder.id) ?? 0) > now.getTime()) continue
          try {
            await this.deliverReminder(reminder, now)
            this.reminderRetryAt.delete(reminder.id)
          } catch (error) {
            // Tried again in a minute (a full disk clears, a journal comes back), never in a tight loop.
            this.reminderRetryAt.set(reminder.id, now.getTime() + REMINDER_RETRY_MS)
            console.warn('a bot reminder could not be delivered; trying again in a minute', { reminderId: reminder.id, error: error instanceof Error ? error.message : String(error) })
          }
        }
      } finally {
        if (this.delivering === pass) this.delivering = undefined
        this.armReminders()
      }
    })()
    this.delivering = pass
    return pass
  }

  private async deliverReminder(reminder: BotReminderRow, now: Date): Promise<void> {
    const registry = this.store.registry(reminder.botId)
    if (!registry || registry.deletedAt) {
      this.store.settleReminder(reminder.id, 'cancelled')
      return
    }
    const late = now.getTime() - Date.parse(reminder.dueAt) > REMINDER_LATE_MS
    let couldNot: string | undefined
    // The pass works from a list read before it began: one cancelled or forgotten since is not said or started.
    // Nothing awaits between this read and the work's insert below, so a cancel can't slip in between.
    if (this.store.reminder(reminder.id)?.status !== 'waiting') return
    if (reminder.work) {
      try {
        const summary = await this.enqueue(reminder.botId, `reminder:${reminder.id}`, { kind: 'work', input: late ? `${reminder.work.brief}\n\n(This was due at ${clockTime(reminder.dueAt)}; Mousse was off then.)` : reminder.work.brief, title: reminder.work.title, ...(reminder.replyTo ? { replyTo: reminder.replyTo } : {}), from: reminder.id }, 'run')
        this.store.settleReminder(reminder.id, 'delivered', { activationId: summary.id })
        return
      } catch (error) {
        // The bot can't run now (its permissions wait for approval, its thread is in the trash): the reminder is
        // still said, with why its work didn't start, so it is never lost and never retried forever.
        if (!(error instanceof BotEngineError)) throw error
        couldNot = error.message
      }
    }
    const id = `bm_${reminder.id}`
    const posted = this.store.db.transaction(() => {
      if (!this.store.settleReminder(reminder.id, 'delivered', { messageId: id })) return false
      this.chat.post({
        id,
        botId: reminder.botId,
        author: 'bot',
        kind: 'run_report',
        text: `${late ? `(For ${clockTime(reminder.dueAt)}) ` : ''}${reminder.text}${couldNot ? `\n\nI couldn't start on it: ${couldNot}` : ''}`,
        ...(reminder.replyTo ? { replyTo: reminder.replyTo } : {}),
        lane: 'run'
      })
      return true
    })
    if (posted) this.changed({ botId: reminder.botId })
  }

  /**
   * The activation a thread's turn belongs to: the chat's on the home thread, a run's on its own, a
   * consult's on a context thread (`role` says which thread called).
   */
  activationOf(threadId: string): { botId: string; activationId: string; lane: BotLane; role: 'home' | BotThreadRole; dispatchId?: string } | undefined {
    try {
      const thread = this.store.get('SELECT bot_id, role, activation_id FROM bot_threads WHERE thread_id = ?', threadId)
      if (!thread) return undefined
      const botId = thread.bot_id as string
      let row: BotActivationRow | undefined
      if (thread.role === 'home') row = this.store.laneActivations(botId, 'chat', ['running', 'waiting_grant'])[0]
      else if (thread.role === 'activation' && typeof thread.activation_id === 'string') row = this.store.activation(thread.activation_id)
      else {
        const consult = this.store.get('SELECT activation_id FROM bot_dispatches WHERE thread_id = ? AND ended_at IS NULL ORDER BY n DESC LIMIT 1', threadId)
        row = consult ? this.store.activation(consult.activation_id as string) : undefined
      }
      if (!row || row.botId !== botId || ENDED_ACTIVATION_STATUSES.has(row.status)) return undefined
      const dispatchId = this.live.get(row.id)?.dispatchId
      const role = thread.role === 'home' ? 'home' : thread.role === 'activation' ? 'activation' : 'context'
      return { botId, activationId: row.id, lane: row.lane, role, ...(dispatchId ? { dispatchId } : {}) }
    } catch {
      return undefined
    }
  }

  /** One of a bot's schedules changed in the shared store (an edit on the Automations page): its chat and About read it again. */
  schedulesEdited(botId: string): void {
    this.changed({ botId })
  }

  /** The bot's schedules in the shared store; none when this profile has no scheduler for them. */
  schedulesOf(botId: string): BotScheduleEntry[] {
    return this.host.schedules?.list(botId) ?? []
  }

  private scheduleBook(): NonNullable<BotEngineHost['schedules']> {
    if (!this.host.schedules) throw new BotEngineError('schedules_unavailable', 'Schedules are not available here.')
    return this.host.schedules
  }

  /**
   * A schedule (§5.5): an automation whose Who is the bot, in the shared store. At most 8 per bot, at least 5 minutes
   * apart. The bot adds its own with `bot_schedule_add`, the owner from the Automations page; it needs no approval
   * (schedules are not permissions) and changes no revision.
   */
  addSchedule(botId: string, input: { when: BotSchedule['when']; prompt: string; model?: string; pick?: BotModelPick }, createdBy: 'owner' | 'bot'): BotScheduleEntry {
    this.entry(botId)
    let added: BotScheduleEntry
    try {
      added = this.scheduleBook().add(botId, input, createdBy)
    } catch (error) {
      if (error instanceof BotScheduleError) throw new BotEngineError(error.code, error.message)
      throw error
    }
    this.changed({ botId })
    return added
  }

  /** A schedule in plain words, for a schedule a format-1 definition carried. */
  private scheduleLabel(when: BotSchedule['when']): string {
    try {
      const label = this.host.schedules?.labelOf(when)
      if (label) return label
    } catch {
      // Below.
    }
    try {
      const label = this.host.scheduleLabel?.(when)
      if (label) return label
    } catch {
      // Below.
    }
    if (when.kind === 'interval') return when.minutes % 60 === 0 ? `every ${when.minutes === 60 ? 'hour' : `${when.minutes / 60} hours`}` : `every ${when.minutes} minutes`
    return when.expr
  }

  removeSchedule(botId: string, scheduleId: string): boolean {
    this.entry(botId)
    const removed = this.host.schedules?.remove(botId, scheduleId) ?? false
    if (removed) this.changed({ botId })
    return removed
  }

  listSchedules(botId: string): Array<{ scheduleId: string; label: string; nextAt?: string }> {
    return this.schedulesOf(botId).map((schedule) => ({ scheduleId: schedule.scheduleId, label: schedule.label, ...(schedule.nextAt ? { nextAt: schedule.nextAt } : {}) }))
  }

  /** The bot renames itself or changes its description (`set_profile`), or the owner renames it or changes its look. */
  setProfile(botId: string, profile: { name?: string; description?: string; look?: { colour: string; accessory: string; kind?: string; eyes?: string } }): BotDefinition {
    const name = profile.name?.trim()
    if (profile.name !== undefined && (!name || name.length > 60)) throw new BotEngineError('invalid_profile', 'A name is 1 to 60 characters.')
    const description = profile.description?.trim()
    if (profile.description !== undefined && (!description || description.length > 500)) throw new BotEngineError('invalid_profile', 'A description is 1 to 500 characters.')
    return this.publishProfile(botId, (definition) => ({
      ...definition,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(profile.look ? { look: lookFields(profile.look) } : {})
    }))
  }

  /**
   * The owner's rows by hand (#673: About → Runs on): the rows given, each a pick on an entry, saved over the bot's rows
   * as they are at the moment of saving, so a change the bot made meanwhile (`use_model`) stays. A revision with the same
   * grant, so no approval is needed; the standing level stays. The bot is no longer stuck on a pick that couldn't run:
   * its next turn tries the rows as they are now.
   */
  setOwnerSlots(botId: string, rows: Partial<BotModelSlots>): void {
    this.entry(botId)
    this.publishProfile(botId, (next) => ({ ...next, main: withSlots(next.main, { ...slotsOf(next.main), ...rows }) }))
    this.clearPickProblem(botId, Object.keys(rows))
  }

  /** The rows the owner (or `use_model always`) just set are no longer stuck; other rows stay as they are. */
  private clearPickProblem(botId: string, rows: readonly string[]): void {
    this.clearStuckRows(botId, rows)
    // A stuck error from an earlier build of this branch, kept bot-wide.
    if (this.store.registry(botId)?.error?.code === PICK_UNAVAILABLE) {
      this.store.setError(botId, null)
      this.changed({ botId })
    }
  }

  /** The bot's rows, upgraded on read (`slotsOf`): a bot from before rows has its one model on each. */
  ownerSlots(botId: string): BotModelSlots {
    return slotsOf(this.published(botId).main)
  }

  /**
   * The rows of the owner's newest bot whose every row is a pick (#673): New bot starts from them. Undefined when no bot
   * has picks.
   */
  lastPicks(): BotModelSlots | undefined {
    const bots = this.store.listRegistry().filter((entry) => !entry.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const entry of bots) {
      try {
        const slots = this.ownerSlots(entry.botId)
        if (allPinned(slots)) return slots
      } catch {
        // A bot whose definition can't be read is skipped.
      }
    }
    return undefined
  }

  /**
   * `set_depth`/`use_model` (§5.6, #673). `now`: this activation's next dispatch runs on the change (the dispatch ends
   * at its next call or turn end and continues): a depth is this activation's level, a pick replaces its row (chat
   * only). `always`: saved as a revision with the same manifest, so no approval is needed: a depth is the standing level
   * (work that names none, and the chat of a bot from before picks), a pick goes on `rows`. The answer says whether what
   * runs changed: a pick keeps its model and reasoning level at any depth, so a depth that leaves a turn on the same pick
   * changes nothing (and `now` then sets nothing, so the turn does not restart).
   */
  setModel(botId: string, activationId: string, scope: 'now' | 'always', change: BotModelChange): { changed: boolean } {
    if ('depth' in change && !BOT_DEPTHS.includes(change.depth)) throw new BotEngineError('invalid_model', 'That is not a model choice.')
    if ('pick' in change && (!change.pick.instanceId || !change.pick.model)) throw new BotEngineError('invalid_model', 'That is not a model choice.')
    if ('slots' in change && (scope !== 'always' || Object.entries(change.slots).some(([key, pick]) => !(BOT_MODEL_SLOT_KEYS as readonly string[]).includes(key) || !pick?.instanceId || !pick.model)))
      throw new BotEngineError('invalid_model', 'That is not a model choice.')
    if (scope === 'always') {
      const before = this.published(botId).main
      const rowsOf = (change: Exclude<BotModelChange, { depth: BotDepth }>): Partial<BotModelSlots> => 'slots' in change
        ? Object.fromEntries(Object.entries(change.slots).map(([key, pick]) => [key, copyPick(pick!)]))
        : slotsWith(slotsOf(before), change.rows ?? 'all', copyPick(change.pick))
      const set = 'depth' in change ? undefined : rowsOf(change)
      const after = this.publishProfile(botId, (next) => !set
        ? { ...next, main: { ...next.main, model: { ...next.main.model, depth: (change as { depth: BotDepth }).depth } } }
        : { ...next, main: withSlots(next.main, { ...slotsOf(next.main), ...set }) }).main
      if (set) {
        this.clearPickProblem(botId, BOT_MODEL_SLOT_KEYS.filter((key) => !samePick(slotsOf(before)[key], slotsOf(after)[key])))
        return { changed: BOT_MODEL_SLOT_KEYS.some((key) => !samePick(slotsOf(before)[key], slotsOf(after)[key])) }
      }
      // Work that names no level, and the chat of a bot from before picks (its Talk follows the depth).
      const standing = (spec: BotThreadSpec) => turnModelOf(spec, { lane: 'run', trigger: { kind: 'schedule', input: '', scheduleId: '', occurrenceAt: '' } })
      const talk = (spec: BotThreadSpec) => turnModelOf(spec, { lane: 'chat', trigger: { kind: 'manual', input: '' } })
      return { changed: runsDifferently(standing(before), standing(after)) || runsDifferently(talk(before), talk(after)) }
    }
    const row = this.store.activation(activationId)
    if (!row || row.botId !== botId || ENDED_ACTIVATION_STATUSES.has(row.status)) throw new BotEngineError('activation_not_found', 'This work has ended.')
    // A run may change its depth, never its model: only the owner names one, in the chat.
    if (row.lane === 'run' && 'pick' in change) throw new BotEngineError('invalid_model', 'Only the owner can change this, in your chat.')
    const definition = this.host.definitions.revision(botId, row.revision) ?? this.published(botId)
    const current: BotModelOverride = row.modelOverride ?? { mode: 'auto', depth: startDepthOf(definition.main, row) }
    if ('slots' in change) throw new BotEngineError('invalid_model', 'That is not a model choice.')
    const next: BotModelOverride = 'depth' in change
      ? { ...current, depth: change.depth }
      : { mode: 'named', ...copyPick(change.pick), model: change.pick.model, depth: current.depth }
    if (!runsDifferently(turnModelOf(definition.main, row), turnModelOf(definition.main, { ...row, modelOverride: next }))) return { changed: false }
    this.store.setModelOverride(activationId, next)
    return { changed: true }
  }

  /**
   * Format-1 definitions become format 2 (§5.2), once, when the profile opens: each draft is
   * written back with its look; a published revision is published again in format 2 (the same
   * manifest, so the grant's digest still holds) and its schedules move to `bot_schedules` (from
   * where `migrateBotSchedules` moves them on to the shared store); a draft
   * that was never published is published with the starter grant only, approved on first chat.
   * The draft is written last, so an upgrade that stopped before it resumes at the next open.
   */
  upgradeDefinitions(): void {
    for (const botId of this.host.definitions.ids()) {
      try {
        if (!this.host.definitions.isFormat1(botId)) continue
        this.upgradeOne(botId)
      } catch (error) {
        console.warn('a bot definition could not be upgraded', { botId, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /**
   * The base work time went from 15 minutes to an hour: a bot whose grant still holds the old
   * default gets the new one, once, when the profile opens (a grant the owner raised stays). Like
   * Allow, a revision with the longer time is published and its grant approved; unfinished
   * activations move to it. Only the old default is changed, so this runs again harmlessly.
   */
  upgradeWorkTime(): string[] {
    const upgraded: string[] = []
    for (const botId of this.host.definitions.ids()) {
      try {
        if (this.store.registry(botId)?.deletedAt) continue
        const grant = this.store.activeGrant(botId)
        if (grant?.manifest.budget.maxActiveMs !== OLD_DEFAULT_BOT_ACTIVE_MS) continue
        const entry = this.host.definitions.get(botId)
        const published = entry?.published
        if (!entry || !published) continue
        const longer = (manifest: BotManifest): BotManifest => manifest.budget.maxActiveMs <= OLD_DEFAULT_BOT_ACTIVE_MS
          ? { ...manifest, budget: { ...manifest.budget, maxActiveMs: DEFAULT_BOT_ACTIVE_MS } }
          : manifest
        const wider = longer(grant.manifest)
        const revision = this.host.definitions.publishRevision({ ...published, permissions: longer(published.permissions) })
        const digest = botManifestDigest(wider)
        this.store.db.transaction(() => {
          this.store.setPublished(botId, revision.revision!)
          this.store.approve(botId, digest, wider)
          this.store.regrant(botId, grant.digest, digest, revision.revision!)
        })
        try {
          const draft = entry.draftHash === published.revision ? revision : { ...entry.draft, permissions: longer(entry.draft.permissions) }
          this.host.definitions.save(draft, entry.draftHash)
        } catch (error) {
          console.warn('the bot draft was left as it was', { botId, error: error instanceof Error ? error.message : String(error) })
        }
        upgraded.push(botId)
      } catch (error) {
        console.warn('a bot\'s work time could not be upgraded', { botId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return upgraded
  }

  private upgradeOne(botId: string): void {
    const entry = this.host.definitions.get(botId)
    if (!entry) return
    const look = entry.draft.look
    const registry = this.store.registry(botId)
    const raw = registry?.revision ? this.host.definitions.rawRevision(botId, registry.revision) : undefined
    const legacy = raw && !('format' in raw) ? raw : undefined
    // Stopped after its published revision and schedules moved, before the draft was written back:
    // that revision stays (its permissions too), and only the draft is left to write.
    const resumed = raw && 'format' in raw ? entry.published : undefined
    this.store.ensureRegistry(botId)
    let published: BotDefinition
    if (resumed) {
      published = resumed
    } else if (legacy) {
      published = this.host.definitions.publishRevision(upgradeDefinitionV1(legacy, look))
      this.store.db.transaction(() => {
        for (const schedule of legacy.triggers.schedules ?? [])
          this.store.putSchedule({ id: schedule.id, botId, when: schedule.when, prompt: schedule.prompt, label: this.scheduleLabel(schedule.when), createdBy: 'owner', createdAt: this.store.now() })
        this.store.setPublished(botId, published.revision!)
      })
    } else {
      // Never published: published now with the starter grant only.
      published = this.host.definitions.publishRevision({ ...entry.draft, permissions: starterManifest() })
      this.store.setPublished(botId, published.revision!)
    }
    // The draft follows: unchanged since it was published, it becomes the new revision.
    const draft = resumed ? entry.draft : entry.published && entry.draftHash === registry?.revision ? published : legacy ? entry.draft : published
    this.host.definitions.save(draft)
    mkdirSync(this.filesFolder(botId), { recursive: true, mode: 0o700 })
  }

  private activationSummary(row: BotActivationRow): BotActivationSummary {
    const counters = this.store.counters(row.id)
    const open = row.status === 'waiting_grant' ? this.store.escalations({ activationId: row.id, status: 'open' }).at(-1) : undefined
    const main = this.store.lastMainDispatch(row.id)
    const run = main?.runId ? this.host.runs()?.getRun(main.runId) : undefined
    return {
      id: row.id,
      botId: row.botId,
      revision: row.revision,
      status: row.status,
      threadId: row.threadId,
      trigger: row.trigger,
      createdAt: row.createdAt,
      endedAt: row.endedAt,
      endReason: row.endReason,
      result: row.result,
      counters: { requests: counters.requests, toolCalls: counters.toolCalls, activeMs: counters.activeMs },
      unknownCalls: this.store.unknownCalls(row.id),
      openEscalation: open ? this.escalationSummary(open) : null,
      canContinue: (row.status === 'paused' || row.status === 'blocked') && !workWaits(row) && Boolean(main),
      canMarkDone: row.status === 'paused' && run?.status === 'completed',
      uncertain: run?.status === 'uncertain',
      uncertainRunId: run?.status === 'uncertain' ? run.runId : null
    }
  }

  /**
   * Stops the active-time timers (profile shutdown). A dispatch still running is charged up to the shutdown, so the
   * next start carries its activation on with the time it really has left.
   */
  close(): void {
    for (const [activationId, live] of this.live) {
      live.timer?.clear()
      live.watch?.clear()
      try {
        this.chargeToLastCall(activationId, live)
      } catch (error) {
        console.warn('a bot dispatch\'s time could not be settled as the profile closed; the next start settles it', { activationId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.live.clear()
    for (const timer of this.expiryTimers.values()) timer.clear()
    this.expiryTimers.clear()
    for (const timer of this.offlineTimers.values()) timer.clear()
    this.offlineTimers.clear()
    for (const reply of this.pendingReplies.values()) reply.timer.clear()
    this.pendingReplies.clear()
    this.closed = true
    this.reminderTimer?.clear()
    this.reminderTimer = undefined
    this.mcpWatch?.stop()
    this.mcpWatch = undefined
  }
}

/** A new activation's id. */
export function newActivationId(): string {
  return `act_${randomUUID()}`
}

function defaultTimer(fn: () => void, ms: number): { clear(): void } {
  const handle = setTimeout(fn, ms)
  handle.unref?.()
  return { clear: () => clearTimeout(handle) }
}

/** How many activations of a lane run side by side: the chat one at a time, the run lane `MAX_RUN_SLOTS_PER_BOT`. */
export function laneCapacity(lane: BotLane): number {
  return lane === 'run' ? MAX_RUN_SLOTS_PER_BOT : 1
}

/**
 * Which queued run starts first: work the owner asked for in the chat (or by hand), then a reminder's work, then
 * scheduled runs. Oldest first within each (`runOrder`).
 */
export function runRank(row: Pick<BotActivationRow, 'trigger' | 'idempotencyKey'>): 0 | 1 | 2 {
  if (row.trigger.kind === 'schedule') return 2
  return row.trigger.kind === 'work' && row.idempotencyKey.startsWith('reminder:') ? 1 : 0
}

/** Queued runs in the order they start (`runRank`, then oldest first). */
export function runOrder(a: Pick<BotActivationRow, 'trigger' | 'idempotencyKey' | 'createdAt' | 'id'>, b: Pick<BotActivationRow, 'trigger' | 'idempotencyKey' | 'createdAt' | 'id'>): number {
  return runRank(a) - runRank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

/** Work in the order it is done: what runs first, oldest first, then what waits in the order it starts (`runOrder`). */
export function workOrder(a: Pick<BotActivationRow, 'status' | 'createdAt' | 'id' | 'trigger' | 'idempotencyKey'>, b: Pick<BotActivationRow, 'status' | 'createdAt' | 'id' | 'trigger' | 'idempotencyKey'>): number {
  const rank = (row: Pick<BotActivationRow, 'status'>) => (row.status === 'queued' ? 1 : 0)
  return rank(a) - rank(b) || (a.status === 'queued' && b.status === 'queued' ? runOrder(a, b) : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/**
 * A short reply of two paragraphs that open the same way ("On it — checking…" written before a tool call, then
 * "On it — checking … now." after it) keeps the last one. Anything longer, or saying different things, is left as it is.
 */
export function sayOnce(text: string): string {
  const parts = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)
  if (parts.length !== 2 || parts.some((part) => part.length > 240 || part.includes('\n'))) return text
  const opening = (part: string) => part.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ')
  return opening(parts[0]!) && opening(parts[0]!) === opening(parts[1]!) ? parts[1]! : text
}

/** `text` cut to `max` characters at most, with an ellipsis when cut. */
function cutText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function summarise(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 57)}...` : line || 'manual run'
}

function countLimits(manifest: BotManifest): ActivationLimits {
  const limits: ActivationLimits = {}
  if (manifest.budget.maxTurns !== undefined) limits.maxTurns = manifest.budget.maxTurns
  if (manifest.budget.maxToolCalls !== undefined) limits.maxToolCalls = manifest.budget.maxToolCalls
  return limits
}

function limitsOf(manifest: BotManifest): ActivationLimits {
  return { ...countLimits(manifest), ...spendLimits(manifest) }
}

function spendLimits(manifest: BotManifest): ActivationLimits {
  const limits: ActivationLimits = {}
  for (const key of ['maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const)
    if (manifest.budget[key] !== undefined) limits[key] = manifest.budget[key]
  return limits
}


/**
 * Whether a grant (`BotManifest`, before a chat turn's front-desk narrowing) holds the permission `asked` names: a tool
 * (any browser tool is the browser), file access, a skill, or every tool an MCP ask lists. Limits and special asks
 * never count.
 */
function grantHolds(manifest: BotManifest, asked: BotAskRequest): boolean {
  if ('path' in asked) return manifest.workspace !== null
  if ('skill' in asked) return manifest.skills.includes(asked.skill)
  if ('mcp' in asked) {
    const tools = mcpAskTools(asked.mcp)
    return tools.length > 0 && tools.every((tool) => manifest.mcp.some((pair) => pair.serverId === asked.mcp.serverId && pair.tool === tool))
  }
  if (!('tool' in asked) || typeof asked.tool !== 'string') return false
  const tool = botGrantTool(asked.tool)
  // The web tools are neutral tools that a grant keeps with the app tools (the starter grant does): either holds them.
  return (isNeutralTool(tool) && (manifest.tools as readonly string[]).includes(tool)) || manifest.appTools.includes(tool)
}

/**
 * Whether `asked` is something a chat turn is never offered, which its work has (`frontDeskManifest`): commands, the
 * web, the browser, the owner's MCP tools.
 */
function frontDeskLacks(asked: BotAskRequest): boolean {
  if ('mcp' in asked) return true
  if (!('tool' in asked) || typeof asked.tool !== 'string') return false
  const tool = botGrantTool(asked.tool)
  return BOT_WORK_ONLY_TOOLS.includes(tool) || tool === BOT_BROWSER_PERMISSION
}

/** Whether `authority` already holds the tool, skill or MCP tool `asked` names (a folder or a limit never counts). */
function heldAlready(authority: Pick<BotAuthority, 'tools' | 'appTools' | 'skills' | 'mcp'>, asked: BotAskRequest): boolean {
  if ('tool' in asked) {
    // The web tools are neutral tools that a grant keeps with the app tools (the starter grant does): either holds them.
    if (isNeutralTool(asked.tool)) return authority.tools.has(asked.tool) || authority.appTools.has(asked.tool)
    // The browser is held as its tools, and the owner's threads as theirs (reading them, in every lane that has them).
    if (asked.tool === BOT_BROWSER_PERMISSION) return authority.appTools.has('browser_open')
    return asked.tool === BOT_THREADS_PERMISSION ? authority.appTools.has('thread_list') : authority.appTools.has(asked.tool)
  }
  if ('skill' in asked) return authority.skills.has(asked.skill)
  if ('mcp' in asked) {
    const tools = mcpAskTools(asked.mcp)
    return tools.length > 0 && tools.every((tool) => authority.mcp.has(`${asked.mcp.serverId}::${tool}`))
  }
  return false
}

/**
 * Whether the activation is a chat turn its owner's own message started (`bots.chat.send`, keyed `chat:`): the only
 * turn that may start, message or stop the owner's threads. The bot's first message (`create:`) is not one. It never
 * waits at a wall the owner's reply continues (it asks for nothing, and at a limit the reply starts a turn of its own).
 */
export function ownerChatTurn(row: Pick<BotActivationRow, 'lane' | 'idempotencyKey'>): boolean {
  return row.lane === 'chat' && row.idempotencyKey.startsWith('chat:')
}

/** Why a turn holds the owner's threads to reading only (`BotAuthority.threadsReadOnly`); undefined when it may act. */
function threadsReadOnlyOf(row: Pick<BotActivationRow, 'lane' | 'idempotencyKey'>): 'work' | 'not_owner' | undefined {
  if (ownerChatTurn(row)) return undefined
  return row.lane === 'chat' ? 'not_owner' : 'work'
}

/** What a gate refusal asks the owner for. */
function permissionOfWall(call: NormalisedCall, wall: WallReason): BotPermissionRequest | undefined {
  switch (wall.kind) {
    // File access is one permission (§3.7): any folder asks for all of them, once.
    case 'path': return filesAsk()
    case 'skill': return { skill: wall.skill }
    case 'mcp': return { mcp: { serverId: wall.server, tool: wall.tool } }
    case 'tool':
      if (call.kind === 'builtin') return { tool: call.tool }
      // A browser tool asks for the browser as a whole.
      return isNeutralTool(wall.tool) || BOT_APP_TOOLS.has(botGrantTool(wall.tool)) ? { tool: botGrantTool(wall.tool) } : undefined
    default: return undefined
  }
}

/** `promise`'s value, or undefined as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise<T | undefined>((resolve) => {
    const done = (): void => resolve(undefined)
    signal.addEventListener('abort', done, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', done)
      resolve(value)
    }, () => {
      signal.removeEventListener('abort', done)
      resolve(undefined)
    })
  })
}

/** A context thread's `bot_threads` key, `<key>:<generation>`. */
function contextKey(stored: string): [string, number] {
  const at = stored.lastIndexOf(':')
  const gen = at > 0 ? Number(stored.slice(at + 1)) : 1
  return at > 0 && Number.isSafeInteger(gen) ? [stored.slice(0, at), gen] : [stored, 1]
}

/** What a continuation says of notes that may have reached the work already (delivery is at least once). */
export const NOTE_REPEAT_LINE = 'A note marked "may be a repeat" may have reached you already while you worked: if you already acted on it, don\'t do it again.'

/**
 * The owner's notes as they reach running work in the middle of its turn: framed as the owner's addition to the job,
 * never as a new task, and with what its report must lead with.
 */
export function noteSteerText(notes: readonly string[]): string {
  return `[Mousse] The owner added this to your job while you work:\n${notes.map((note) => `- ${note}`).join('\n')}\n\nTake it into account from here on. If it changes what you found so far, update it. When you report, lead with what changed because of it, in plain words.`
}

/** The one line work that waited too long to go on ends with. */
function waitedTooLong(title: string): string {
  return `"${title}" waited too long, so I stopped it. Ask me again if you still want it.`
}

/** What work that ran out of room says with its ask: that it stopped short and goes on when allowed, then what it had. */
export function roomText(body: string): string {
  const lead = 'I ran out of room before finishing. Allow more and I\'ll carry on.'
  return body.trim() ? `${lead} Here is what I have so far:\n\n${body.trim()}` : lead
}

/** A run Mousse itself ended by stopping (a profile closing, or the boot after a crash): never the bot's own end. */
function stoppedByMousse(run: Pick<RunRecord, 'status' | 'outcome'>): boolean {
  return run.status === 'interrupted' && run.outcome?.interruptedBy === 'daemon_restart'
}

/** What work that kept reaching its runtime's turn cap reports as it ends: it stopped short, then what it had. */
export function stoppedShortText(body: string): string {
  const lead = 'I ran out of room before finishing, so I stopped here.'
  return body.trim() ? `${lead} Here is what I have so far:\n\n${body.trim()}` : lead
}

/** A journal that cannot be written (bot-context.md §4): capture's `bot_journal_failed`, or a full disk. */
function isJournalFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'bot_journal_failed' || code === 'storage_full'
}

/** Why an activation stopped, in plain words for its chat; never a provider's own message (it may name a model). */
function failureText(reason: string): string {
  switch (reason) {
    case 'bot_grant_revoked': return 'My permissions changed, so I stopped.'
    case 'bot_context_failed': return 'I couldn\'t read my notes, so I stopped. Try again.'
    case 'bot_context_not_cleared': return 'I couldn\'t start fresh, so I stopped. Try again.'
    case 'bot_home_trashed': return 'My chat is in the trash. Restore it to keep going.'
    case 'budget_denied': return 'I stopped here: I ran out of time for this.'
    case 'asked_too_often': return 'I stopped: I asked too many times in one go.'
    case 'bot_permissions_invalid': return 'My permissions are broken, so I stopped.'
    case 'bots_unavailable': return 'Mousse isn\'t ready to run me yet. Try again in a moment.'
    case 'unknown_calls':
    case 'uncertain': return 'I was interrupted and can\'t tell what my last step did, so I stopped here.'
    case 'restarted_twice': return 'Mousse restarted twice while I was working, so I stopped here.'
    case 'queue_full': return 'Too many messages were waiting, so I skipped this one. Send it again if it still matters.'
    case 'no_progress': return 'I couldn\'t get anything done on this run, so I stopped.'
    case 'turn_cap_repeated': return 'I kept going without finishing, so I stopped here.'
    default: return 'Something went wrong, so I stopped. Try again.'
  }
}

/** An ask in plain words where no card title was stored (rows of an older build). */
function permissionTextOf(request: BotAskRequest): string {
  return isSpecialAsk(request) ? 'save its memory to a folder' : permissionText(request)
}

/**
 * Whether two turns run differently (#673): another pick, or the same row on which Mousse chooses (a bot from before
 * picks) at another depth. A pick keeps its model and reasoning level at any depth.
 */
function runsDifferently(a: BotTurnModel, b: BotTurnModel): boolean {
  if (!samePick(a.pick, b.pick)) return true
  return !isPinned(a.pick) && a.depth !== b.depth
}

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { askText } from '../../../shared/bots/personal/askText'
import type { BotAuthority, BotCheck, BotCheckDenied, BotThreadRole, BotThreads, NormalisedCall, WallReason } from '../../../shared/bots/personal/authority'
import type { BotChatMessage, BotChip, BotError } from '../../../shared/bots/personal/chat'
import {
  BOT_ASK_DENY_COOLDOWN_MS,
  MAX_BOT_WALLS,
  askProblem,
  isSpecialAsk,
  permissionText,
  withPermission,
  type BotAskRequest,
  type BotBudgetWallKey,
  type BotEscalationAnswer,
  type BotEscalationSummary,
  type BotPermissionRequest,
  type BotWallKind
} from '../../../shared/bots/personal/escalation'
import { BOT_APP_TOOLS, isAbsolutePath, manifestProblem } from '../../../shared/bots/personal/manifest'
import { checkMessage, wallMessage } from '../../../shared/bots/personal/walls'
import type { ChargeResult, CountKind, CounterScope } from '../../../shared/harness/counters'
import type { ReserveResult, SpendLimits, SpendRequest, SpendScope } from '../../../shared/harness/spend'
import { isNeutralTool } from '../../../shared/harness/tools'
import {
  ACTIVE_TIME_CHUNK_MS,
  BOT_DELETE_PURGE_MS,
  BOT_DEPTHS,
  ENDED_ACTIVATION_STATUSES,
  MAX_BOT_SCHEDULES,
  MAX_QUEUED_ACTIVATIONS,
  type BotAcknowledgement,
  type BotActivationSummary,
  type BotActivationTrigger,
  type BotDefinition,
  type BotLane,
  type BotManifest,
  type BotModelChoice,
  type BotPermissionLine,
  type BotSchedule,
  type BotSummaryV1 as BotSummary,
  type BotThreadCheck,
  type BotThreadSpec
} from '../../../shared/bots/personal/definition'
import { addedPermissions, intersectManifest, manifestSubset } from '../../../shared/bots/personal/manifest'
import type { Enforceability, HarnessError, ProviderSelection, RunPolicy } from '../../../shared/harness/types'
import type { NeutralTool } from '../../../shared/harness/tools'
import type { RunEngine } from '../../run/RunEngine'
import { TERMINAL_RUN_STATUSES, type BotTurnPayload, type RunRecord } from '../../run/types'
import { createBotAuthority } from '../authority/botAuthority'
import { BotChatService, chatInput } from '../chat/BotChatService'
import { askFingerprintOf, BotChatProjection, clockTime, starterManifest } from '../chat/projection'
import { BotDefinitionError, upgradeDefinitionV1, type BotDefinitionEntry, type BotDefinitionStore } from '../definitions/BotDefinitionStore'
import { chipCallOf } from '../activity/BotActivitySink'
import { botFilesFolder, botManifestDigest, compileBotThread } from '../grants/compile'
import { BOT_RUN_REPORT_LINE } from '../memory/contextPack'
import type { BotActivityContext, BotActivitySink, BotContextProvider, BotDispatchEnd, BotJournal, BotJournalInput, BotMemoryAdmin, BotModelProblem, BotModelResolver, BotProcessSupervision, BotToolHost } from '../seams'
import type { BotActivationRow, BotDispatchRow, BotEscalationRow, BotMessageRow, BotStore, BotStoredError } from '../store/BotStore'
import { BotCounterScope, BotSpendScope, type ActivationLimits } from '../store/scopes'
import { firstOccurrence, nextOccurrence, scheduleProblem, scheduleSpec } from '../triggers/scheduler'
import { BotReloadAbort, BotWallAbort, type BotTurnDispatcher, type PreparedBotTurn } from './dispatcher'

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
  }
  /** Wakes the effect worker after a `turn.start` was written. */
  notifyEffects(): void
  /** Stops what runs on a thread (a running dispatch). */
  stopThread?(threadId: string): Promise<unknown> | void
  /** `bots.changed`. */
  changed?(event: { botId?: string; activationId?: string }): void
  /** A bot's schedules may have changed (it was published): the scheduler ticks now. */
  schedulesChanged?(): void
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
  /**
   * Adds the bot runner entry when the owner's setup calls for one (`harness.ensureBotRunner`,
   * §5.9 item 7): awaited at each bot's creation, before its model is chosen. A failure only logs.
   */
  botRunner?(): Promise<unknown>
  /** One model call on a selection (`harness.oneShot`): naming a new bot. */
  oneShot?(input: { selection: ProviderSelection; prompt: string; signal: AbortSignal }): Promise<string>
  /**
   * The bot's system text (WP3's `botInstructions`): who it is, its files folder and the base
   * instructions. Built at each dispatch, never stored, so a rename applies at the next turn.
   */
  instructions?(bot: { name: string; description: string; filesFolder: string }): string
  /** A schedule in plain words ("every weekday · 09:00"; WP3's `describeSchedule`). */
  scheduleLabel?(when: BotSchedule['when']): string
  /** The provider family of an instance in plain words ("Claude"), never a model. */
  providerLabel?(instanceId: string): string
}

export type { BotAcknowledgement, BotSummaryV1 as BotSummary, BotThreadCheck } from '../../../shared/bots/personal/definition'

/** What a run-lane call is refused with when its permission waits for the owner (§5.4). */
export const BOT_ASK_REFUSED_TEXT = 'The owner has not allowed this yet. You asked them; carry on without it and say in your report what you skipped.'
/** What `escalate` returns in a chat turn: the cards show together under the turn's message. */
export const BOT_ASK_DEFERRED_TEXT = 'Asked; the owner will answer after this message. Finish your message now.'
/** The stuck error after the journal could not be written (bot-context.md §4). */
export const BOT_JOURNAL_ERROR: BotError = { text: 'I can\'t save my work. Free some disk space.', action: { kind: 'retry', label: 'Try again' } }
/** Failed runs in a row that pause a bot's schedules. */
export const BOT_FAILURE_PAUSE_STREAK = 3
/** The shortest interval a bot may schedule itself at. */
export const MIN_BOT_SCHEDULE_MINUTES = 5
/** How long a dispatch's reply waits for the executor's final message before it is posted without it. */
const REPLY_WAIT_MS = 5_000
/** Retries on another model after usage limits, per activation. */
const MAX_USAGE_RETRIES = 2
/** How often deleted bots are swept for the 30-day purge. */
const SWEEP_EVERY_MS = 24 * 60 * 60_000

interface LiveDispatch {
  controller: AbortController
  timer: { clear(): void } | undefined
  /** When the dispatch started, on the monotonic clock: what settlement measures from. */
  startedMono: number
  /** The main dispatch's number; its consults attach to it. */
  n: number
  /** Wall-clock deadline of the main dispatch, which its consults share. */
  deadline: number
  /** The main dispatch's authority scopes, which its consults share. */
  counters: CounterScope
  spend: SpendScope | null
  /** The main dispatch's id (`bot_dispatches.client_request_id`, `<activationId>:d<n>`): supervision's and the activity chips'. */
  dispatchId: string
}

/** An activation that runs or waits for its owner's answer holds its bot: the next one waits. */
const ACTIVE_HOLDING = ['running', 'waiting_grant'] as const
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
  /** The startup pass has run: only then may the schedule tick insert activations (PR 6 §6). */
  private startupPassed = false
  /** The chat rows and the Bot UI's summaries (Bot Phase 1 §5.1.1). */
  readonly chat: BotChatProjection
  /** The Bot UI's methods (`bots.*` v2). */
  readonly service: BotChatService
  /** Each activation's context pack as its latest main dispatch read it (frozen by the provider, bot-context.md §5). */
  private readonly packs = new Map<string, string>()
  /** Replies whose final message the executor still delivers, by `<activationId>:<n>`. */
  private readonly pendingReplies = new Map<string, { post(text?: string): void; timer: { clear(): void } }>()
  /** The live chip of each working activation (`bots.chat.list`'s `live`). */
  private readonly liveChips = new Map<string, { botId: string; chip: BotChip | null }>()
  /** Final messages the executor delivered while the dispatch's end was still being recorded, by `<activationId>:<n>`. */
  private readonly lateTexts = new Map<string, string>()
  /** The owner's message that answered a wall while its turn was still ending: the continuation's input. */
  private readonly ownerTexts = new Map<string, string>()
  /** The rolled-up chips of each settled main dispatch, until its message is posted. */
  private readonly drained = new Map<string, BotChip[]>()
  private lastSweep = 0

  constructor(private readonly host: BotEngineHost) {
    this.chat = new BotChatProjection({
      store: host.store,
      ...(host.journal ? { journal: host.journal } : {}),
      // The bot's name rides along: a notification for a new bot's first row comes before any list names it.
      emit: (event) => this.events.emit('message', { ...event, ...this.nameFor(event.botId) })
    })
    this.service = new BotChatService(this, { store: host.store, ...(host.memory ? { memory: host.memory } : {}), now: () => this.now() })
    try {
      for (const row of host.store.all('SELECT thread_id, bot_id, role FROM bot_threads'))
        this.known.set(row.thread_id as string, { botId: row.bot_id as string, role: row.role as 'home' | BotThreadRole })
    } catch (error) {
      console.warn('bot threads could not be read', { error: error instanceof Error ? error.message : String(error) })
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
      return running
    })
    // Its runs end before its threads are archived; the stop is bounded, a hung provider stop included.
    const quiet = await this.stopAndWait(live)
    // Scratch folders go only once nothing runs in them (the startup pass removes the rest).
    if (quiet) for (const activation of live) this.cleanup({ ...activation, status: 'cancelled' })
    for (const row of live) this.packs.delete(row.id)
    await this.archiveThreads(botId)
    this.changed({ botId })
    try { this.host.schedulesChanged?.() } catch { /* the next tick reads it */ }
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
  async sweepDeleted(now: number = this.now()): Promise<string[]> {
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
    await this.host.memory?.purge(botId)
    const threads = this.store.botThreads(botId)
    const home = threads.find((thread) => thread.role === 'home')
    // The home thread owns the bot's run and context threads: they go with it.
    const own = home ? [home] : threads
    if (this.host.trashThread) {
      for (const thread of own) {
        if (this.threadState(thread.threadId) === 'missing') continue
        await this.host.trashThread(thread.threadId)
      }
    }
    // Its definition and files first: a failure leaves the purge unfinished, and the next sweep tries again.
    this.host.definitions.remove(botId)
    rmSync(this.filesFolder(botId), { recursive: true, force: true })
    this.store.db.transaction(() => {
      this.store.deleteMessages(botId)
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
      schedules: this.store.scheduleStates(entry.id).map((state) => ({
        id: state.scheduleId,
        nextRunAt: state.nextRunAt,
        skipped: state.lastSkipReason && state.lastSkipAt ? { at: state.lastSkipAt, reason: state.lastSkipReason } : null
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
   * Ends the bot's queued and running activations made under any grant but `keep`: each is
   * cancelled with `reason`, and a running one's dispatch is stopped (its authority refuses every
   * call from now on, since it checks the grant on each one).
   */
  private endUnderGrant(botId: string, reason: string, keep?: string): void {
    const ended = this.store.db.transaction(() => {
      const rows = this.store.activationsIn(botId, ['queued', 'running']).filter((row) => row.grantDigest !== keep)
      return rows.filter((row) => this.store.moveActivation(row.id, [row.status], 'cancelled', { endReason: reason }))
    })
    for (const row of ended) {
      if (row.status === 'running') void this.stopRun(row)
      else this.cleanup({ ...row, status: 'cancelled' })
      this.changed({ botId, activationId: row.id })
    }
  }

  private published(botId: string): BotDefinition {
    const entry = this.entry(botId)
    if (!entry.published) throw new BotEngineError('bot_not_published', 'Publish this bot before it can run.')
    return entry.published
  }

  /**
   * Whether a thread can hold `grant` at all: it compiles (no shell, no MCP, no folder that
   * overlaps Mousse's data). Which runtime holds it is decided per activation, from the providers
   * that can (`BotModelResolver`), and checked again at each dispatch.
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
   * A manual activation. A repeat of `clientRequestId` returns the same activation. One activation
   * per bot and lane runs at a time; later ones wait, at most 20 (the oldest waiting one is dropped).
   */
  async activate(input: { botId: string; input: string; clientRequestId: string }): Promise<BotActivationSummary> {
    return this.enqueue(input.botId, `manual:${input.clientRequestId}`, { kind: 'manual', input: input.input })
  }

  /**
   * A chat activation (Bot Phase 1 §5.3.2): it runs on the bot's home thread, beside any run. A
   * repeat of `key` returns the same activation; messages in the chat lane run in order.
   */
  async enqueueChat(botId: string, key: string, input: string, activationId?: string): Promise<BotActivationSummary> {
    return this.enqueue(botId, key, { kind: 'manual', input }, 'chat', activationId)
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
  queueChatInTx(botId: string, key: string, input: string, activationId: string): BotEngineError | undefined {
    if (this.store.activationByKey(key)) return undefined
    let admitted: ReturnType<BotEngine['admissible']>
    try {
      this.approveStarterIfNeeded(botId)
      admitted = this.admissible(botId)
    } catch (error) {
      if (error instanceof BotEngineError) return error
      throw error
    }
    if (this.insertQueued(botId, activationId, key, { kind: 'manual', input }, 'chat', admitted)) this.store.db.afterCommit(() => this.changed({ botId }))
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

  /** Cancels the oldest waiting activations of a lane beyond the queue's size (inside a transaction); how many. */
  private dropOverQueue(botId: string, lane: BotLane = 'run'): number {
    const queued = this.store.laneActivations(botId, lane, ['queued'])
    const over = queued.slice(0, Math.max(0, queued.length - MAX_QUEUED_ACTIVATIONS))
    for (const activation of over) this.store.moveActivation(activation.id, ['queued'], 'cancelled', { endReason: 'queue_full' })
    return over.length
  }

  // -- Schedules (PR 6 §6, Bot Phase 1 §5.5) ----------------------------------------------------

  /**
   * One scheduler tick. Schedules live in `bots.db` (`bot_schedules`). For each due occurrence,
   * one transaction inserts its activation (`INSERT OR IGNORE` on
   * `sched:<botId>:<scheduleId>:<occurrenceAt>`) and moves the schedule to its next occurrence;
   * occurrences missed while Mousse was closed collapse into one. A repeated tick, or one after a
   * crash, finds the key and inserts nothing. The tick only inserts, and never piles up copies: while
   * the bot is paused (by its owner, after failed runs, or by a usage limit), its run waits at a
   * wall, or the same schedule already has a run waiting in the queue, the occurrence is skipped (the
   * schedule still moves on) and the reason is recorded. An open ask is not a skip: asks don't block.
   * One bot that cannot be read never stops the others. Every tick also starts what waits in a free
   * lane, and once a day deleted bots past their 30 days are purged. Nothing happens before the
   * startup pass has run.
   */
  async tickSchedules(now: Date = new Date(this.now())): Promise<{ inserted: string[] }> {
    const inserted: string[] = []
    if (!this.startupPassed) return { inserted }
    for (const botId of this.host.definitions.ids()) {
      try {
        inserted.push(...this.tickBot(botId, now))
      } catch (error) {
        console.warn('a bot\'s schedules could not be checked', { botId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    for (const botId of new Set(this.store.activationsWith(['queued']).map((row) => row.botId))) {
      try {
        await this.pump(botId)
      } catch (error) {
        console.warn('a bot\'s queued activation could not start; the next tick tries again', { botId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (now.getTime() - this.lastSweep >= SWEEP_EVERY_MS) await this.sweepDeleted(now.getTime()).catch(() => [])
    return { inserted }
  }

  private tickBot(botId: string, now: Date): string[] {
    const inserted: string[] = []
    const registry = this.store.registry(botId)
    if (!registry || registry.deletedAt) return inserted
    // A usage-limit pause ends at its reset time: the bot's schedules run again.
    if (registry.pausedReason === 'usage_limit' && registry.pausedUntil && Date.parse(registry.pausedUntil) <= now.getTime()) {
      this.store.db.transaction(() => {
        this.store.setPaused(botId, null)
        if (registry.error?.code === 'usage_limit') this.store.setError(botId, null)
      })
      this.changed({ botId })
    }
    const paused = this.store.registry(botId)!.pausedReason
    const schedules = this.store.schedules(botId)
    const states = new Map(this.store.scheduleStates(botId).map((state) => [state.scheduleId, state]))
    for (const id of states.keys()) if (!schedules.some((schedule) => schedule.id === id)) this.store.dropScheduleState(botId, id)
    for (const row of schedules) {
      const schedule: BotSchedule = { id: row.id, when: row.when, prompt: row.prompt }
      const spec = scheduleSpec(schedule)
      const state = states.get(schedule.id)
      // A new or edited schedule starts from now: it never runs for times before it existed.
      if (!state || state.spec !== spec) {
        this.store.putScheduleState(botId, schedule.id, spec, firstOccurrence(schedule, now))
        continue
      }
      if (!state.nextRunAt || Date.parse(state.nextRunAt) > now.getTime()) continue
      const occurrenceAt = state.nextRunAt
      const next = nextOccurrence(schedule, occurrenceAt, now)
      let admitted: ReturnType<BotEngine['admissible']> | undefined
      let skip: string | undefined = paused ? (paused === 'usage_limit' ? 'usage_limited' : 'paused') : undefined
      if (!skip) {
        try {
          admitted = this.admissible(botId)
        } catch (error) {
          // A bot that cannot run now (permissions to approve, its thread in the trash) skips this
          // occurrence; the schedule still moves on, so approving later never runs a backlog.
          skip = error instanceof BotEngineError ? error.code : 'bot_unavailable'
        }
      }
      const id = `act_${randomUUID()}`
      const made = this.store.db.transaction(() => {
        let made = false
        if (admitted && !skip) {
          if (this.store.laneActivations(botId, 'run', ['waiting_grant']).length) skip = 'bot_waiting_for_owner'
          else if (this.store.laneActivations(botId, 'run', ['queued']).some((row) => row.trigger.kind === 'schedule' && row.trigger.scheduleId === schedule.id)) skip = 'previous_run_still_queued'
        }
        if (admitted && !skip) {
          made = this.store.insertActivationOnce({
            id,
            botId,
            revision: admitted.published.revision!,
            grantDigest: admitted.grant.digest,
            trigger: { kind: 'schedule', input: schedule.prompt, scheduleId: schedule.id, occurrenceAt },
            idempotencyKey: `sched:${botId}:${schedule.id}:${occurrenceAt}`,
            status: 'queued',
            createdAt: this.store.now(),
            lane: 'run'
          }, limitsOf(intersectManifest(admitted.published.permissions, admitted.grant.manifest)))
          if (made) this.dropOverQueue(botId, 'run')
        }
        this.store.putScheduleState(botId, schedule.id, spec, next)
        return made
      })
      // The skip is recorded once per reason: a skip repeated for the same reason changes nothing.
      const reason = skip ?? null
      if (reason !== state.lastSkipReason) {
        this.store.setScheduleSkip(botId, schedule.id, reason, reason ? occurrenceAt : null)
        if (reason) console.warn('a bot schedule occurrence was skipped', { botId, scheduleId: schedule.id, occurrenceAt, reason })
        this.changed({ botId })
      }
      if (made) {
        inserted.push(id)
        this.changed({ botId, activationId: id })
      }
    }
    return inserted
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
    await this.stopRun(row)
    if (row.status !== 'running') this.cleanup(row)
    this.changed({ botId: row.botId, activationId })
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

  /**
   * Starts each lane's oldest waiting activation when none of that lane's activations holds it: a
   * bot has a chat lane and a run lane, side by side. Nothing starts while the journal cannot be
   * written (the bot is stuck until the owner tries again).
   */
  private async pump(botId: string): Promise<void> {
    if (this.store.registry(botId)?.error?.code === 'bot_journal_failed') return
    for (const lane of ['chat', 'run'] as const) {
      // The chat lane's thread is the home thread: a stopped activation's turn lets go of it first.
      if (lane === 'chat' && [...this.live.keys()].some((id) => {
        const live = this.store.activation(id)
        return live?.botId === botId && live.lane === 'chat' && ENDED_ACTIVATION_STATUSES.has(live.status)
      })) continue
      const next = this.store.db.transaction(() => {
        if (this.store.laneActivations(botId, lane, [...ACTIVE_HOLDING]).length) return undefined
        const queued = this.store.laneActivations(botId, lane, ['queued'])[0]
        if (!queued) return undefined
        this.store.moveActivation(queued.id, ['queued'], 'running')
        return this.store.activation(queued.id)
      })
      if (next) await this.startActivation(next)
    }
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
          // A run's request ends with what its last message is for: the report (bot-context.md §5.2).
          const text = row.lane === 'run' ? `${row.trigger.input}\n\n${BOT_RUN_REPORT_LINE}` : row.trigger.input
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
    if (!row.selection || row.reloadPending) {
      const resolved = await this.resolveModel(row, definition, grant.manifest)
      if ('problem' in resolved) {
        this.modelProblem(row, resolved)
        return false
      }
      const previous = this.store.registry(row.botId)?.model?.selection
      const saved = this.recorded(row, () => {
        this.store.setActivationSelection(row.id, resolved.selection)
        this.store.setModel(row.botId, { selection: resolved.selection, activationId: row.id })
        if (!previous || previous.instanceId !== resolved.selection.instanceId || previous.model !== resolved.selection.model || previous.effort !== resolved.selection.effort)
          this.journalInTx({
            botId: row.botId, kind: 'model_change', lane: row.lane, activationId: row.id, sourceKey: `act:${row.id}:model:${dispatch.n}`, who: 'mousse',
            text: 'The model changed.', json: { v: 1, from: previous ?? null, to: resolved.selection }
          })
        return true
      })
      if (!saved) return false
    }
    // Read at each main dispatch: the provider freezes the pack per activation, and a forget drops it.
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

  /** The model for an activation: its own override first, else the definition's choice; an unavailable named model falls back to auto. */
  private async resolveModel(row: BotActivationRow, definition: BotDefinition, grant: BotManifest): Promise<{ selection: ProviderSelection } | { problem: BotModelProblem; until?: string; instanceId?: string }> {
    const models = this.host.models
    if (!models) return { problem: 'no_provider' }
    const effective = this.effectiveManifest(row, definition.permissions, grant)
    const compiled = this.compileNeutral(definition.main, effective, { escalate: true, consult: definition.context.length > 0, memory: true }, row.botId)
    if (!compiled.ok) return { problem: 'no_provider' }
    const policy: RunPolicy = { mode: 'default', origin: 'bot', ...compiled.policy }
    const choice = definition.main.model
    const override = row.modelOverride ?? undefined
    const first = await models.resolve({ botId: row.botId, choice, ...(override ? { override } : {}), policy })
    if (!('problem' in first) || first.problem !== 'named_unavailable') return first
    // "I can't use that model here": the bot stays on auto at the same depth.
    const depth = (override ?? choice).depth
    return models.resolve({ botId: row.botId, choice: { mode: 'auto', depth }, policy })
  }

  /** No model could run the activation: it ends, and the bot says why in plain words, with one action. */
  private modelProblem(row: BotActivationRow, problem: { problem: BotModelProblem; until?: string; instanceId?: string }): void {
    if (problem.problem === 'all_limited') return this.usagePause(row, problem.until, problem.instanceId)
    const error: BotError = problem.instanceId
      ? { text: 'Sign in so I can work.', action: { kind: 'sign_in', label: 'Sign in', instanceId: problem.instanceId } }
      : { text: 'Set up a provider so I can work.', action: { kind: 'open_providers', label: 'Open providers' } }
    this.failActivation(row, problem.problem === 'no_provider' ? 'bot_no_provider' : 'bot_model_unavailable', { code: problem.problem, error })
  }

  /**
   * Every candidate is at its usage limit: the bot's schedules pause until the reset, with one
   * error row ("Paused until 14:00 (your Claude usage limit)"). It names the provider family, never
   * the model. The activation ends; this never counts as a failed run.
   */
  private usagePause(row: BotActivationRow, until: string | undefined, instanceId: string | undefined): void {
    const family = instanceId ? this.providerLabel(instanceId) : undefined
    const text = until ? `Paused until ${clockTime(until)} (${family ? `your ${family} usage limit` : 'a usage limit'})` : `Paused (${family ? `your ${family} usage limit` : 'a usage limit'})`
    const error: BotError = { text, action: { kind: 'resume', label: 'Resume' } }
    const ended = this.recorded(row, () => {
      if (!this.store.moveActivation(row.id, ['running', 'queued'], 'failed', { endReason: 'usage_limit' })) return false
      this.store.closeEscalations(row.id, 'cancelled')
      this.store.setPaused(row.botId, 'usage_limit', until)
      this.store.setError(row.botId, { code: 'usage_limit', error })
      this.chat.post({ botId: row.botId, author: 'bot', kind: 'error', text: '', error, activationId: row.id, lane: row.lane, id: `bm_${row.id}_limit` })
      this.journalEnd(row, 'usage_limit')
      return true
    }) ?? false
    if (!ended) return
    this.afterEnd(this.store.activation(row.id) ?? row)
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
    const selection = this.store.activation(payload.activationId)?.selection
    if (selection) await this.refreshInstance(selection.instanceId)
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
    // narrows, plus what the owner allowed for this activation only.
    const effective = this.effectiveManifest(row, definition.permissions, grant.manifest)
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
      botTools: { escalate: true, consult: definition.context.length > 0, memory: true }
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
    const controller = new AbortController()
    const deadline = startedAt + remainingMs
    // At the deadline the dispatch ends at a budget wall: the owner may allow more time. The timer
    // runs on the daemon loop; the supervisor (outside it) kills what is left of the process group.
    const timer = (this.host.setTimer ?? defaultTimer)(() => {
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
    this.live.set(row.id, { controller, timer, startedMono: this.monotonic(), n: dispatch.n, deadline, counters: counterScope, spend: spendScope, dispatchId: dispatch.clientRequestId })
    const authority = this.authorityFor({
      row, mainN: dispatch.n, role: 'activation', permissions: compiled.permissions, grantDigest: grant.digest,
      controller, deadline, counters: counterScope, spend: spendScope,
      contexts: definition.context.map((thread) => ({ key: thread.key, title: thread.title })),
      dispatchId: dispatch.clientRequestId
    })
    const pack = this.packs.get(row.id)
    return {
      activationId: row.id,
      dispatchN: dispatch.n,
      // A leading `/` never runs a command: the trigger is text for the model.
      prompt: dispatch.prompt.text.startsWith('/') ? ` ${dispatch.prompt.text}` : dispatch.prompt.text,
      ...this.instructionsOf(definition, definition.main),
      selection: { ...selection },
      policy: compiled.policy,
      authority,
      scratch,
      skills: compiled.permissions.skills,
      history: dispatch.kind === 'start' ? (cleared ? 'cleared' : 'none') : 'thread',
      lane: row.lane,
      ...(pack ? { preamble: pack } : {})
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
  private instructionsOf(definition: BotDefinition, thread: BotThreadSpec): { instructions?: string } {
    let system: string | undefined
    try {
      system = this.host.instructions?.({ name: definition.name, description: definition.description, filesFolder: this.filesFolder(definition.id) })
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
    const effective = this.effectiveManifest(row, definition.permissions, grant.manifest)
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
      botTools: { escalate: true, consult: false, memory: true }
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
    const authority = this.authorityFor({
      row, mainN: main.n, role: 'context', permissions: compiled.permissions, grantDigest: grant.digest,
      controller: main.controller, deadline: main.deadline, counters: main.counters, spend: main.spend, contexts: [],
      // A consult's calls are chips of its main dispatch's message.
      dispatchId: main.dispatchId
    })
    return {
      activationId: row.id,
      dispatchN: dispatch.n,
      prompt: dispatch.prompt.text.startsWith('/') ? ` ${dispatch.prompt.text}` : dispatch.prompt.text,
      ...this.instructionsOf(definition, spec),
      selection: { ...selection },
      policy: compiled.policy,
      authority,
      scratch,
      skills: compiled.permissions.skills,
      history: 'thread',
      lane: row.lane
    }
  }

  /** What an activation runs with: the revision held inside the grant, plus its "Allow this time" overlays. */
  private effectiveManifest(row: BotActivationRow, revision: BotManifest, granted: BotManifest): BotManifest {
    let manifest = intersectManifest(revision, granted)
    for (const overlay of this.store.overlays(row.id)) manifest = withPermission(manifest, overlay.permission, overlay.amount ?? undefined)
    return manifest
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
      spend: input.spend
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
    const check = (call: NormalisedCall): BotCheck => {
      const decided = base.check(call)
      if (decided.ok) {
        observe(call)
        return decided
      }
      if ('refused' in decided || !ESCALATABLE.has(decided.wall.kind)) return decided
      // Only app tools a bot can be granted are worth asking for; any other is just refused.
      if (call.kind === 'app' && !BOT_APP_TOOLS.has(call.tool)) return decided
      const permission = permissionOfWall(call, decided.wall)
      if (!permission) return decided
      if (row.lane === 'run') return this.raiseAsk(row, input.mainN, 'gate', permission, wallMessage(decided.wall))
      return { ok: false, wall: this.raiseWall(row.id, { dispatchN: input.mainN, kind: 'gate', permission, reason: wallMessage(decided.wall) }) }
    }
    const authority: BotAuthority = {
      ...base,
      check,
      checkAny: (calls: readonly NormalisedCall[]) => {
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
        const problem = askProblem(request.permission)
        if (problem) return `${problem} Ask for a tool, a folder, a skill, an MCP tool, a limit, or to export your memory.`
        const live = base.check({ kind: 'app', tool: 'escalate', args: {} })
        if (!live.ok && ('refused' in live || live.wall.kind !== 'tool')) return checkMessage(live)
        const asked = request.permission as BotAskRequest
        const reason = request.reason.trim() || 'The bot did not say why.'
        if (row.lane === 'run') {
          const refused = this.raiseAsk(row, input.mainN, 'escalate', asked, reason, request.toolCallId)
          return 'refused' in refused ? 'Asked the owner. Carry on without it and say in your report what you skipped.' : checkMessage(refused as BotCheckDenied)
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
        const reserved = scope.reserve(request, limits)
        if (!reserved.ok) {
          const key: BotBudgetWallKey = reserved.limit.kind === 'input_tokens' ? 'maxInputTokens' : reserved.limit.kind === 'output_tokens' ? 'maxOutputTokens' : 'maxUsd'
          this.raiseWall(activationId, { dispatchN: mainN, kind: 'budget', permission: { budget: { key } }, reason: 'This bot reached its spending limit.' })
        }
        return reserved
      },
      settle: (id, outcome) => scope.settle(id, outcome)
    }
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
   * A run reached a limit (§5.7): nobody is there to allow more, so the run ends failed (it counts
   * toward the failure streak) and one ask offers the higher limit for later runs ("work for up to
   * 30 minutes per run"). The dispatch ends now; its scratch goes once its run has stopped.
   */
  private budgetEnd(row: BotActivationRow, input: { dispatchN: number; kind: BotWallKind; permission: BotAskRequest; reason: string }): WallReason {
    if (row.status !== 'running') return row.status === 'waiting_grant' ? { kind: 'waiting' } : { kind: 'ended' }
    const name = this.host.definitions.revision(row.botId, row.revision)?.name ?? 'This bot'
    let ended = false
    try {
      ended = this.store.db.transaction(() => {
        if (!this.store.moveActivation(row.id, ['running'], 'failed', { endReason: 'budget_exhausted' })) return false
        const fingerprint = askFingerprintOf(input.permission)
        const open = this.store.openAsk(row.botId, fingerprint) ?? this.store.coolingAsk(row.botId, fingerprint, this.store.now())
        if (!open) {
          const text = this.askCardText(row, input.permission)
          const id = `esc_${randomUUID()}`
          this.store.insertEscalation({
            id, botId: row.botId, activationId: row.id, dispatchN: input.dispatchN, toolCallId: null, kind: 'budget', permission: input.permission, reason: input.reason.slice(0, 2000),
            createdAt: this.store.now(), expiresAt: null, mode: 'ask', fingerprint, title: text.title, note: text.note, messageId: null
          })
          this.chat.post({ botId: row.botId, author: 'bot', kind: 'notice', text: `I ran out of room on this run. ${name} wants to ${text.title}.`, askId: id, activationId: row.id, lane: 'run', id: `bm_${row.id}_budget` })
        } else {
          this.chat.post({ botId: row.botId, author: 'bot', kind: 'error', text: '', error: { text: 'I ran out of room on this run, so I stopped.' }, activationId: row.id, lane: 'run', id: `bm_${row.id}_budget` })
        }
        this.journalEnd(row, 'budget_exhausted')
        return true
      })
    } catch (error) {
      if (isJournalFailure(error)) this.journalFailed(row)
      else throw error
    }
    this.live.get(row.id)?.controller.abort(new BotWallAbort())
    if (ended) {
      this.countFailure(row)
      this.packs.delete(row.id)
      this.changed({ botId: row.botId, activationId: row.id })
      this.pumpLater(row.botId)
    }
    return { kind: 'ended' }
  }

  /** The fingerprint of an ask: one open ask per bot and permission (a limit's by its key alone). */
  private fingerprintOf(_activationId: string, _kind: BotWallKind, permission: BotAskRequest): string {
    return askFingerprintOf(permission)
  }

  /** An ask in plain words for its card (`askText`), with the bot's current limits. */
  private askCardText(row: BotActivationRow, permission: BotAskRequest): { title: string; note: string } {
    const budget = this.store.activeGrant(row.botId)?.manifest.budget
    return askText(permission, { home: this.chat.home, ...(budget ? { budget } : {}) })
  }

  /** The bot's open ask for `fingerprint` becomes this activation's wall, or a new one is written. */
  private openWall(row: BotActivationRow, input: { dispatchN: number; kind: BotWallKind; permission: BotAskRequest; reason: string; toolCallId?: string }): BotEscalationRow {
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
   * owner said Not now to it in the last 24 hours. Later runs get the same refusal and no new ask.
   */
  private raiseAsk(row: BotActivationRow, dispatchN: number, kind: BotWallKind, permission: BotAskRequest, reason: string, toolCallId?: string): BotCheck {
    const fingerprint = this.fingerprintOf(row.id, kind, permission)
    let raised: { askId: string; created: boolean }
    try {
      raised = this.store.db.transaction(() => {
        const open = this.store.openAsk(row.botId, fingerprint)
        if (open) return { askId: open.id, created: false }
        const cooling = this.store.coolingAsk(row.botId, fingerprint, this.store.now())
        if (cooling) return { askId: cooling.id, created: false }
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
    if (input.answer !== 'deny' && !special) {
      const problem = this.answerProblem(row, escalation.permission as BotPermissionRequest, amount)
      if (problem) throw new BotEngineError('invalid_answer', problem)
    }
    if (input.answer === 'allow_bot' && !special) this.allowForBot(row.botId, escalation.permission as BotPermissionRequest, amount)
    const status = input.answer === 'deny' ? 'denied' : input.answer === 'allow_bot' ? 'allowed_bot' : 'allowed_once'
    const answered = this.store.db.transaction(() => {
      if (!this.store.answerEscalation(escalation.id, status, amount)) return false
      if (!special && (input.answer === 'allow_once' || input.answer === 'allow_more')) this.store.putOverlay(row.id, escalation.id, escalation.permission, amount)
      this.journalAnswer(escalation, status === 'denied' ? 'not_now' : 'allow')
      return true
    })
    if (!answered) throw new BotEngineError('escalation_answered', 'This request was already answered or has expired.')
    this.expiryTimers.get(escalation.id)?.clear()
    this.expiryTimers.delete(escalation.id)
    this.republishAsk(escalation.id)
    this.changed({ botId: row.botId, activationId: row.id })
    await this.advance(row.id)
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
    const special = isSpecialAsk(escalation.permission)
    let amount: number | undefined
    if (answer === 'allow' && !special) {
      const permission = escalation.permission as BotPermissionRequest
      amount = 'budget' in permission ? permission.budget.amount ?? this.store.activeGrant(botId)?.manifest.budget[permission.budget.key] : undefined
      if ('budget' in permission && amount === undefined) throw new BotEngineError('invalid_answer', 'This limit cannot be raised.')
      this.allowForBot(botId, permission, amount)
    }
    const cooldown = answer === 'not_now' && escalation.mode === 'ask' ? new Date(this.now() + BOT_ASK_DENY_COOLDOWN_MS).toISOString() : undefined
    const answered = this.store.db.transaction(() => {
      if (!this.store.answerEscalation(escalation.id, answer === 'allow' ? 'allowed_bot' : 'denied', amount, cooldown)) return false
      this.journalAnswer(escalation, answer)
      return true
    })
    if (!answered) throw new BotEngineError('ask_answered', 'This was already answered.')
    const message = this.republishAsk(escalation.id)
    this.changed({ botId, activationId: escalation.activationId })
    if (escalation.mode === 'wall') await this.advance(escalation.activationId)
    return message
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
  async continueChatWith(botId: string, text: string): Promise<boolean> {
    const walls = this.openChatWalls(botId)
    if (!walls.length) return false
    const activationId = walls[0]!.activationId
    // A limit answered Not now ends the walled turn: the message starts a chat of its own.
    const limit = walls.some((wall) => wall.activationId === activationId && 'budget' in wall.permission)
    const answered = this.store.db.transaction(() => {
      let any = false
      for (const wall of walls.filter((entry) => entry.activationId === activationId))
        if (this.store.answerEscalation(wall.id, 'denied')) {
          this.journalAnswer(wall, 'not_now')
          any = true
        }
      return any
    })
    if (!answered) return false
    for (const wall of walls) this.republishAsk(wall.id)
    this.changed({ botId, activationId })
    if (limit) {
      await this.advance(activationId)
      return false
    }
    const row = this.store.activation(activationId)
    if (!row || row.status !== 'waiting_grant') return true
    // The walled turn is still letting go: its continuation, with this message, follows when it has.
    if (!this.allRunsEnded(row)) {
      this.ownerTexts.set(activationId, text)
      return true
    }
    const answers = this.store.pendingAnswers(activationId)
    await this.continueWith(activationId, ['waiting_grant'], { answers, ownerText: text })
    return true
  }

  /**
   * The owner's message written while the chat waited at a wall, whose answer to the wall never ran
   * (Mousse stopped between the two): the walls count as Not now and the turn continues with it,
   * as `continueChatWith` would have. At startup, and when the owner sends the same message again.
   */
  async admitWallMessage(message: BotMessageRow): Promise<void> {
    if (message.author !== 'owner' || message.kind !== 'text' || !message.activationId) return
    const walled = this.openChatWalls(message.botId).some((wall) => wall.activationId === message.activationId && wall.createdAt <= message.at)
    if (walled) await this.continueChatWith(message.botId, chatInput(message.text, message.attachments ?? undefined))
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
    // queued work moves to the narrower grant.
    this.store.db.transaction(() => {
      this.store.setPublished(botId, revision.revision!)
      this.store.approve(botId, digest, granted)
      for (const row of this.store.activationsIn(botId, ['queued']))
        this.store.run('UPDATE bot_activations SET grant_digest = ?, revision = ? WHERE id = ?', digest, revision.revision!, row.id)
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
      // A usage limit: the instance is skipped until its reset, and the dispatch is tried again on
      // the next candidate; with none left the bot pauses until the reset (never a failure).
      const limitUntil = run.status === 'failed' ? run.outcome?.usageLimitUntil : undefined
      if (limitUntil && row.selection) {
        try { this.host.models?.markLimited(row.selection.instanceId, limitUntil) } catch { /* the resolve below decides */ }
        const retries = this.store.dispatches(row.id).filter((dispatch) => dispatch.send.usageRetry).length
        if (this.host.models && retries < MAX_USAGE_RETRIES) {
          this.store.markReload(row.id)
          await this.continueWith(row.id, ['running'], { usageRetry: true })
          return
        }
        return this.usagePause(row, limitUntil, row.selection.instanceId)
      }
      const reload = row.reloadPending && (run.status === 'completed' || (run.status === 'interrupted' && run.outcome?.interruptedBy === 'bot_wall'))
      if (run.status === 'failed' || (run.status !== 'completed' && run.status !== 'uncertain' && !reload)) {
        const unknown = this.store.unknownCalls(row.id).some((call) => !call.acknowledged)
        if (!unknown) {
          const error = typeof run.outcome?.error === 'string' ? run.outcome.error : undefined
          return this.failActivation(row, error ?? run.status)
        }
      }
      const openWalls = this.store.escalations({ activationId: row.id, status: 'open' }).filter((ask) => ask.mode === 'wall')
      const next = this.recorded(row, () => {
        const unknown = this.store.unknownCalls(row.id).some((call) => !call.acknowledged)
        if (unknown || run.status === 'uncertain') {
          this.store.moveActivation(row.id, ['running'], 'paused', { endReason: run.status === 'uncertain' && !unknown ? 'uncertain' : 'unknown_calls', ...(text !== undefined ? { result: text } : {}) })
        } else if (openWalls.length) {
          // The chat turn asked (`escalate`): it waits for the owner with every card on its message.
          this.store.moveActivation(row.id, ['running'], 'waiting_grant', { endReason: 'wall', ...(text !== undefined ? { result: text } : {}) })
        } else if (!reload) {
          this.store.moveActivation(row.id, ['running'], 'done', { endReason: null, result: text ?? '' })
          // A successful dispatch resets the automatic-restart allowance, the failure streak (refused
          // asks included) and the bot's stuck error.
          this.store.setAutoRestarts(row.id, 0)
          if (row.lane === 'run') this.store.bumpFailureStreak(row.botId, true)
          this.store.setError(row.botId, null)
          this.journalEnd(row, null)
        }
        return this.store.activation(row.id)!
      })
      if (!next) return
      this.postReply(next, main, text, options.expectText === true)
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
      const ownerText = this.ownerTexts.get(row.id)
      this.ownerTexts.delete(row.id)
      if (answers.length) await this.continueWith(row.id, ['waiting_grant'], { answers, ...(ownerText !== undefined ? { ownerText } : {}) })
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
    const chips = this.drained.get(key) ?? []
    this.drained.delete(key)
    // Its open walls, unless a card for them was posted in this activation already (a moved run ask keeps its old card too).
    const asks = this.store.escalations({ activationId: row.id }).filter((ask) => ask.mode === 'wall' && ask.dispatchN === dispatch.n && ask.status === 'open' &&
      !this.store.messagesForAsk(ask.id).some((message) => message.activationId === row.id))
    const body = (text ?? '').trim()
    const report = row.lane === 'run' && row.status === 'done'
    if (!body && !chips.length && !asks.length && !report) return
    const kind = row.lane === 'chat' ? 'text' : report ? 'run_report' : 'notice'
    const name = this.host.definitions.revision(row.botId, row.revision)?.name ?? 'This bot'
    const [first, ...more] = asks
    try {
      this.store.db.transaction(() => {
        this.chat.post({
          id: `bm_${row.id}_d${dispatch.n}`,
          botId: row.botId,
          author: 'bot',
          kind,
          text: body || (first ? `${name} wants to ${this.chat.card(first).title}.` : report ? 'Done.' : ''),
          chips,
          ...(first ? { askId: first.id } : {}),
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
  private async continueWith(activationId: string, from: readonly BotActivationRow['status'][], input: { answers?: BotEscalationRow[]; restart?: boolean; acknowledgeUncertain?: boolean; reload?: boolean; usageRetry?: boolean; ownerText?: string }): Promise<'sent' | 'paused' | 'wall' | 'none'> {
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
    const decided = this.store.db.transaction((): { kind: 'paused' | 'wall' | 'blocked' | 'budget' | 'none' } | { kind: 'sent'; dispatch: BotDispatchRow } => {
      const current = this.store.activation(row.id)
      if (!current || !from.includes(current.status)) return { kind: 'none' }
      if (!definition || !grant || !effective || grant.digest !== current.grantDigest) {
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
        const wall = this.wallInTransaction(row.id, [current.status], this.timeWall(previous?.n ?? 0, effective))
        return { kind: wall.kind === 'wall' ? 'wall' : wall.kind === 'blocked' ? 'blocked' : 'none' }
      }
      const n = this.store.nextDispatchN(row.id)
      const neverRan = previous && previousRun && !previousRun.activeAttemptId ? previous.prompt.text : undefined
      const dispatch = {
        activationId: row.id,
        n,
        kind: 'continue' as const,
        clientRequestId: `${row.id}:d${n}`,
        threadId: current.threadId!,
        prompt: { text: input.usageRetry && previous ? `[Mousse] The last try did not go through. Answer this again:\n\n${previous.prompt.text}` : this.continuationPrompt(row, { ...input, answers }, neverRan) },
        policyDigest: grant.digest,
        // Kept with the intent, so a resend after a crash sends exactly this.
        send: input.usageRetry
          ? { usageRetry: true }
          : { ...(previous?.runId ? { continuationOfRunId: previous.runId } : {}), ...(uncertain ? { acknowledgeUncertain: true } : {}) }
      }
      this.store.insertDispatch(dispatch)
      for (const answer of answers) this.store.markApplied(answer.id)
      this.store.setLimits(row.id, limitsOf(effective))
      if (input.restart) this.store.setAutoRestarts(row.id, current.autoRestarts + 1)
      this.store.moveActivation(row.id, [current.status], 'running', { endReason: null })
      return { kind: 'sent', dispatch: this.store.dispatch(row.id, n)! }
    })
    if (decided.kind === 'budget') {
      this.budgetEnd(this.store.activation(row.id) ?? row, this.timeWall(previous?.n ?? 0, effective!))
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

  private continuationPrompt(row: BotActivationRow, input: { answers: BotEscalationRow[]; restart?: boolean; reload?: boolean; ownerText?: string }, neverRan?: string): string {
    const answerLine = (answer: BotEscalationRow): string => {
      const title = this.chat.card(answer).title
      if (answer.status === 'denied') return input.ownerText !== undefined
        ? `The owner wrote instead of answering, so the answer is not now: ${title}. Carry on without it.`
        : `The owner said not now: ${title}. Carry on without it and say what you couldn't do.`
      if (isSpecialAsk(answer.permission)) return `The owner allowed: ${title}. Mousse saves it now.`
      return `The owner allowed: ${title}.`
    }
    const depth = row.modelOverride?.depth
    const lead = input.answers.length
      ? input.answers.map(answerLine).join(' ')
      : input.reload ? (depth === 'deep' ? 'You now have more time to think.' : depth === 'quick' ? 'You now answer more quickly.' : 'Your settings changed.')
        : input.restart ? 'Mousse restarted while you were working.' : 'The owner asked you to continue.'
    const calls = this.store.unknownCalls(row.id)
    const interrupted = calls.length
      ? ` Interrupted tool calls (their effects are unknown; check before repeating them): ${calls.map((call) => `${call.tool} (${call.role} run ${call.runId}, call ${call.invocationId})`).join('; ')}.`
      : ''
    // The owner's message is the next input.
    if (input.ownerText !== undefined) return `[Mousse] ${lead}${interrupted}\n\n${input.ownerText}`
    // The walled dispatch never ran (a time wall before it started): its own prompt is sent now.
    if (neverRan !== undefined) return `[Mousse] ${lead}${interrupted}\n\n${neverRan}`
    return `[Mousse] ${lead} ${input.reload ? 'Continue where you left off.' : 'Continue.'}${interrupted}`
  }

  /**
   * Sends a written dispatch: first its activation's model and context pack (`ready`), then its
   * run, receipt and `turn.start` in one run-DB transaction.
   */
  private async sendDispatch(row: BotActivationRow, dispatch: BotDispatchRow): Promise<void> {
    try {
      if (!(await this.ready(row, dispatch))) return
      await this.sendOnly(this.store.activation(row.id) ?? row, dispatch)
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
    if (!row.threadId || !this.store.lastMainDispatch(row.id)) throw new BotEngineError('bot_not_started', 'This activation never started; run the bot again.')
    if (this.store.laneActivations(row.botId, row.lane, [...ACTIVE_HOLDING]).some((other) => other.id !== row.id))
      throw new BotEngineError('bot_busy', 'Another run of this bot is in progress. Continue this one when it has finished.')
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
    if (dispatch.endedAt !== null) {
      // Settled from the run's terminal event first: the executor's final message still lands.
      if (outcome.text !== undefined) {
        this.store.run("UPDATE bot_activations SET result = ? WHERE id = ? AND status IN ('done', 'paused', 'waiting_grant') AND (result IS NULL OR result = '')", outcome.text, row.id)
        // Capture may still be running for this dispatch: its reply takes this text when it is written.
        if (!this.pendingReplies.has(key) && !this.store.message(`bm_${row.id}_d${dispatch.n}`)) this.lateTexts.set(key, outcome.text)
      }
      this.pendingReplies.get(key)?.post(outcome.text)
      return
    }
    const live = this.live.get(row.id)?.n === dispatch.n ? this.live.get(row.id) : undefined
    if (live) {
      this.live.delete(row.id)
      live.timer?.clear()
      live.controller.abort(new Error('dispatch_ended'))
    }
    // Measured on the monotonic clock of the process that ran the dispatch. Without that measure
    // (another process started it), nothing is refunded: the whole prepaid allowance stays charged.
    const measured = live ? this.monotonic() - live.startedMono : undefined
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
    const expectText = live !== undefined && outcome.text === undefined
    const moveOn = (): Promise<void> => this.advance(row.id, outcome.text, { expectText })
    const failed = (error: unknown): void => console.warn('bot activation could not move on', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
    if (!this.host.context) {
      void moveOn().catch(failed)
      return
    }
    const endedBy = this.endedBy(this.store.activation(row.id) ?? row, run)
    void this.afterDispatch(row, dispatch.threadId, dispatch.clientRequestId, endedBy).then((ok) => (ok ? moveOn() : undefined)).catch(failed)
  }

  /** The dispatch's processes are confirmed gone (`exit_at`), outside the turn's own end. */
  private settleProcesses(dispatch: BotDispatchRow): void {
    if (dispatch.startedAt === null || !this.host.supervision) return
    void this.host.supervision.settled(dispatch.clientRequestId).catch((error: unknown) => console.warn('a bot dispatch\'s processes could not be confirmed gone', { dispatchId: dispatch.clientRequestId, error: error instanceof Error ? error.message : String(error) }))
  }

  /** How a main dispatch ended, for capture. */
  private endedBy(row: BotActivationRow, run: RunRecord): BotDispatchEnd {
    if (run.status === 'completed') return row.reloadPending ? 'reload' : 'settled'
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
        if (chips.length) this.drained.set(key, chips.map((chip) => ({ icon: chip.icon, text: chip.text, ...(chip.highlight ? { highlight: chip.highlight } : {}) })))
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

  /** The bot's working activation and its live chip, chat lane first. */
  liveActivity(botId: string): { activationId: string; chip?: BotChip } | undefined {
    const working = [...this.store.laneActivations(botId, 'chat', ['running']), ...this.store.laneActivations(botId, 'run', ['running'])][0]
    if (!working) return undefined
    const chip = this.liveChips.get(working.id)?.chip
    return { activationId: working.id, ...(chip ? { chip } : {}) }
  }

  private settleConsult(row: BotActivationRow, dispatch: BotDispatchRow, run: RunRecord, outcome: { text?: string }, fromExecutor: boolean): void {
    const key = `${row.id}:${dispatch.n}`
    // The executor's settle carries the final message; the terminal event settles one it never ran.
    if (!fromExecutor && this.executing.has(key)) return
    this.executing.delete(key)
    this.store.run('UPDATE bot_dispatches SET ended_at = ?, outcome = ?, run_id = COALESCE(run_id, ?) WHERE activation_id = ? AND n = ? AND ended_at IS NULL', this.store.now(), run.status, run.runId, row.id, dispatch.n)
    const waiter = this.consultWaiters.get(key)
    this.consultWaiters.delete(key)
    waiter?.resolve(run.status === 'completed' ? outcome.text ?? '' : `The consult ended without an answer (${run.status}).`)
    this.settleProcesses(dispatch)
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
    if (dispatch.kind === 'consult') {
      const row = this.store.activation(dispatch.activationId)
      const run = this.host.runs()?.getRun(runId)
      if (row && run && TERMINAL_RUN_STATUSES.has(run.status)) this.settleConsult(row, dispatch, run, {}, false)
      return
    }
    this.settle({ kind: 'bot', runId, threadId: dispatch.threadId, activationId: dispatch.activationId, dispatchN: dispatch.n }, {})
  }

  private pumpLater(botId: string): void {
    void this.pump(botId).catch((error) => console.warn('next bot activation could not start', { botId, error: error instanceof Error ? error.message : String(error) }))
  }

  /** The scratch folder goes when the activation has ended (it stays while it waits or is paused). */
  private cleanup(row: BotActivationRow): void {
    if (!ENDED_ACTIVATION_STATUSES.has(row.status) || !row.scratch) return
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
    try {
      this.store.db.transaction(() => {
        if (!this.store.moveActivation(row.id, ['running'], 'blocked', { endReason: code })) return
        const stuck: BotStoredError | undefined = code === 'policy_unenforceable'
          ? { code, error: { text: 'I can\'t run on the providers set up here.', action: { kind: 'open_providers', label: 'Open providers' } } }
          : undefined
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
        await this.host.journal?.catchUp()
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
    for (const botId of new Set(this.store.activationsWith(['queued']).map((row) => row.botId))) this.pumpLater(botId)
  }

  /**
   * The message of a main dispatch whose activation moved on (done, at a wall, or paused) but whose
   * reply, run report or cards were not written before Mousse stopped: written now from the
   * activation's result. Only the latest finished activation of each lane can be missing one;
   * activations from before the chat (no selection) never had one.
   */
  private postMissingReplies(): void {
    const rows = this.store.all(`SELECT id FROM bot_activations a WHERE selection_json IS NOT NULL AND (status IN ('waiting_grant', 'paused')
      OR (status = 'done' AND NOT EXISTS (SELECT 1 FROM bot_activations b WHERE b.bot_id = a.bot_id AND b.lane = a.lane AND b.status = 'done' AND b.ended_at > a.ended_at)))`)
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
    // P3: main dispatches whose time window was never settled. Without exit evidence on the main row
    // and on every attached consult row, the main dispatch's whole remaining allowance is charged.
    for (const row of this.store.all("SELECT activation_id, n FROM bot_dispatches WHERE kind IN ('start', 'continue') AND started_at IS NOT NULL AND settled_by IS NULL")) {
      const main = this.store.dispatch(row.activation_id as string, Number(row.n))!
      const attached = this.store.dispatches(main.activationId).filter((other) => other.kind === 'consult' && other.mainN === main.n && other.startedAt !== null)
      const evidence = [main, ...attached].every((entry) => entry.exitAt !== null)
      const deadline = main.deadlineMs ?? 0
      const prepaid = main.prepaidMs ?? 0
      const endAt = Math.max(...[main, ...attached].map((entry) => entry.exitAt ?? 0))
      const charge = evidence ? Math.max(prepaid, Math.min(deadline, endAt - main.startedAt!)) : deadline
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
    // Row 13: a queued activation starts when its bot is free. Paused and blocked ones wait for the owner.
    if (row.status === 'queued' || row.status === 'paused' || row.status === 'blocked') return
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
        await this.continueWith(row.id, ['waiting_grant'], { answers })
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
      // Its time window was already settled (the whole allowance, without exit evidence): too little
      // left is a budget wall, as for an interrupted run.
      const left = this.remainingMs(row)
      if (left !== undefined && left < ACTIVE_TIME_CHUNK_MS) {
        runs.markTerminal(run.runId, 'cancelled', { error: 'bot_dispatch_restarted' })
        this.wallAtRest(row, { ...this.timeWallAt(row, main.n), reason: 'Mousse stopped unexpectedly before this bot\'s run began, and its work time was counted as used. Allow more time to continue.' })
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
    // Rows 8 and 9: the run ended before bots.db was updated.
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      if (run.status === 'cancelled') return end('cancelled', typeof run.outcome?.error === 'string' ? run.outcome.error : 'cancelled')
      await this.advance(row.id)
      return
    }
    if (run.status !== 'interrupted') return
    // Row 10: under 15 s of work time left after P3: a budget wall that says why.
    const remaining = this.remainingMs(row)
    if (remaining !== undefined && remaining < ACTIVE_TIME_CHUNK_MS) {
      this.wallAtRest(row, {
        ...this.timeWallAt(row, main.n),
        reason: 'Mousse stopped unexpectedly while this bot was working. Its remaining work time was counted as used, because Mousse can\'t tell how long its commands kept running. Allow more time to continue.'
      })
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
   * One model call for a bot (naming it): on the model its activations would resolve to, within
   * `timeoutMs`. Undefined when no model can run it or the call failed.
   */
  /** At a bot's creation: the bot runner entry, when the owner's setup calls for one (`BotEngineHost.botRunner`). */
  async prepareBotRunner(): Promise<void> {
    try {
      await this.host.botRunner?.()
    } catch (error) {
      console.warn('[bots] could not add the bot runner entry', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  async oneShotFor(botId: string, prompt: string, timeoutMs: number): Promise<string | undefined> {
    const models = this.host.models
    const oneShot = this.host.oneShot
    if (!models || !oneShot) return undefined
    const signal = AbortSignal.timeout(timeoutMs)
    const timedOut = new Promise<undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }))
    const call = (async () => {
      const compiled = this.compileNeutral({ key: 'main', title: 'Main', agent: { instructions: '' }, model: { mode: 'auto', depth: 'normal' } }, starterManifest(), { escalate: true, consult: false, memory: true }, botId)
      if (!compiled.ok) return undefined
      const resolved = await models.resolve({ botId, choice: { mode: 'auto', depth: 'quick' }, policy: { mode: 'default', origin: 'bot', ...compiled.policy } })
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
    this.store.db.transaction(() => {
      this.store.setPaused(botId, null)
      this.store.setError(botId, null)
    })
    this.changed({ botId })
    try { this.host.schedulesChanged?.() } catch { /* the next tick reads it */ }
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
  readonly tools: BotToolHost & { activationOf(threadId: string): ({ botId: string; activationId: string; lane: BotLane; dispatchId?: string }) | undefined } = {
    activationOf: (threadId) => this.activationOf(threadId),
    schedules: {
      add: (botId, schedule) => this.addSchedule(botId, schedule, 'bot'),
      remove: (botId, scheduleId) => this.removeSchedule(botId, scheduleId),
      list: (botId) => this.listSchedules(botId)
    },
    setProfile: (botId, profile) => this.setProfile(botId, profile),
    setModel: (botId, activationId, scope, choice) => this.setModel(botId, activationId, scope, choice)
  }

  /** The activation a thread's turn belongs to: the chat's on the home thread, a run's on its own, a consult's on a context thread. */
  activationOf(threadId: string): { botId: string; activationId: string; lane: BotLane; dispatchId?: string } | undefined {
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
      return { botId, activationId: row.id, lane: row.lane, ...(dispatchId ? { dispatchId } : {}) }
    } catch {
      return undefined
    }
  }

  /**
   * A schedule (§5.5): at most 8 per bot, at least 5 minutes apart. The bot adds its own with
   * `bot_schedule_add`; it needs no approval (schedules are not permissions) and changes no revision.
   */
  addSchedule(botId: string, input: { when: BotSchedule['when']; prompt: string }, createdBy: 'owner' | 'bot'): { scheduleId: string; label: string } {
    this.entry(botId)
    if (this.store.schedules(botId).length >= MAX_BOT_SCHEDULES)
      throw new BotEngineError('schedule_limit', `A bot can have at most ${MAX_BOT_SCHEDULES} schedules. Remove one first.`)
    const schedule: BotSchedule = { id: `s-${randomUUID().slice(0, 8)}`, when: input.when, prompt: typeof input.prompt === 'string' ? input.prompt.trim() : '' }
    const problem = scheduleProblem(schedule) ?? this.tooOften(schedule)
    if (problem) throw new BotEngineError('schedule_invalid', problem)
    const label = this.scheduleLabel(schedule.when)
    this.store.putSchedule({ id: schedule.id, botId, when: schedule.when, prompt: schedule.prompt, label, createdBy, createdAt: this.store.now() })
    this.changed({ botId })
    try { this.host.schedulesChanged?.() } catch { /* the next tick reads it */ }
    return { scheduleId: schedule.id, label }
  }

  /** Why a schedule runs more often than every 5 minutes, or undefined. */
  private tooOften(schedule: BotSchedule): string | undefined {
    const message = `The shortest schedule is every ${MIN_BOT_SCHEDULE_MINUTES} minutes.`
    if (schedule.when.kind === 'interval') return schedule.when.minutes < MIN_BOT_SCHEDULE_MINUTES ? message : undefined
    // A cron expression: no two of its next runs may be closer than 5 minutes.
    let at = firstOccurrence(schedule, new Date(this.now()))
    for (let i = 0; at && i < 48; i += 1) {
      const next = nextOccurrence(schedule, at, new Date(Date.parse(at)))
      if (!next) return undefined
      if (Date.parse(next) - Date.parse(at) < MIN_BOT_SCHEDULE_MINUTES * 60_000) return message
      at = next
    }
    return undefined
  }

  private scheduleLabel(when: BotSchedule['when']): string {
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
    const removed = this.store.db.transaction(() => {
      const done = this.store.removeSchedule(botId, scheduleId)
      if (done) this.store.dropScheduleState(botId, scheduleId)
      return done
    })
    if (removed) {
      this.changed({ botId })
      try { this.host.schedulesChanged?.() } catch { /* the next tick reads it */ }
    }
    return removed
  }

  listSchedules(botId: string): Array<{ scheduleId: string; label: string; nextAt?: string }> {
    const states = new Map(this.store.scheduleStates(botId).map((state) => [state.scheduleId, state.nextRunAt]))
    return this.store.schedules(botId).map((schedule) => {
      const next = states.get(schedule.id)
      return { scheduleId: schedule.id, label: schedule.label, ...(next ? { nextAt: next } : {}) }
    })
  }

  /** The bot renames itself or changes its description (`set_profile`), or the owner renames it or changes its look. */
  setProfile(botId: string, profile: { name?: string; description?: string; look?: { colour: string; accessory: string } }): BotDefinition {
    const name = profile.name?.trim()
    if (profile.name !== undefined && (!name || name.length > 60)) throw new BotEngineError('invalid_profile', 'A name is 1 to 60 characters.')
    const description = profile.description?.trim()
    if (profile.description !== undefined && (!description || description.length > 500)) throw new BotEngineError('invalid_profile', 'A description is 1 to 500 characters.')
    return this.publishProfile(botId, (definition) => ({
      ...definition,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(profile.look ? { look: { colour: profile.look.colour, accessory: profile.look.accessory } } : {})
    }))
  }

  /**
   * `set_depth`/`use_model` (§5.6). `now`: this activation's next dispatch runs on the new choice
   * (the dispatch ends at its next call or turn end and continues). `always`: the definition's
   * `main.model`, through a revision with the same manifest, so no approval is needed.
   */
  setModel(botId: string, activationId: string, scope: 'now' | 'always', choice: Partial<BotModelChoice>): void {
    const definition = this.published(botId)
    const row = this.store.activation(activationId)
    const current = scope === 'now' && row?.modelOverride ? row.modelOverride : definition.main.model
    const merged = mergeChoice(current, choice)
    if (!merged) throw new BotEngineError('invalid_model', 'That is not a model choice.')
    if (scope === 'always') {
      this.publishProfile(botId, (next) => ({ ...next, main: { ...next.main, model: merged } }))
      return
    }
    if (!row || row.botId !== botId || ENDED_ACTIVATION_STATUSES.has(row.status)) throw new BotEngineError('activation_not_found', 'This work has ended.')
    this.store.setModelOverride(activationId, merged)
  }

  /**
   * Format-1 definitions become format 2 (§5.2), once, when the profile opens: each draft is
   * written back with its look; a published revision is published again in format 2 (the same
   * manifest, so the grant's digest still holds) and its schedules move to `bot_schedules`; a draft
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
      canContinue: (row.status === 'paused' || row.status === 'blocked') && Boolean(main),
      canMarkDone: row.status === 'paused' && run?.status === 'completed',
      uncertain: run?.status === 'uncertain',
      uncertainRunId: run?.status === 'uncertain' ? run.runId : null
    }
  }

  /** Stops the active-time timers (profile shutdown). */
  close(): void {
    for (const live of this.live.values()) live.timer?.clear()
    this.live.clear()
    for (const timer of this.expiryTimers.values()) timer.clear()
    this.expiryTimers.clear()
    for (const reply of this.pendingReplies.values()) reply.timer.clear()
    this.pendingReplies.clear()
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


/** What a gate refusal asks the owner for. */
function permissionOfWall(call: NormalisedCall, wall: WallReason): BotPermissionRequest | undefined {
  switch (wall.kind) {
    // A folder is asked for only by its absolute path: a relative one is refused, never resolved.
    case 'path': {
      // Only an absolute path is asked for, shown resolved (`..` removed); a relative one is refused.
      if (!isAbsolute(wall.path)) return undefined
      const path = resolve(wall.path)
      // A file is asked for by its folder ("read files in ~/Documents/Invoices"), a folder as itself.
      const folder = isDirectory(path) ? path : dirname(path)
      return isAbsolutePath(folder) && folder !== dirname(folder) ? { path: folder, access: wall.access } : undefined
    }
    case 'skill': return { skill: wall.skill }
    case 'mcp': return { mcp: { serverId: wall.server, tool: wall.tool } }
    case 'tool':
      if (call.kind === 'builtin') return { tool: call.tool }
      return isNeutralTool(wall.tool) || BOT_APP_TOOLS.has(wall.tool) ? { tool: wall.tool } : undefined
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
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
    default: return 'Something went wrong, so I stopped. Try again.'
  }
}

/** An ask in plain words where no card title was stored (rows of an older build). */
function permissionTextOf(request: BotAskRequest): string {
  return isSpecialAsk(request) ? 'save its memory to a folder' : permissionText(request)
}

/** `current` changed by `change` (`set_depth` keeps the mode, `use_model` names one); undefined when not a choice. */
function mergeChoice(current: BotModelChoice, change: Partial<BotModelChoice>): BotModelChoice | undefined {
  const depth = change.depth ?? current.depth
  if (!BOT_DEPTHS.includes(depth)) return undefined
  const mode = change.mode ?? current.mode
  if (mode === 'auto') return { mode: 'auto', depth }
  const model = 'model' in change && typeof change.model === 'string' ? change.model.trim() : current.mode === 'named' ? current.model : ''
  return mode === 'named' && model && model.length <= 200 ? { mode: 'named', model, depth } : undefined
}

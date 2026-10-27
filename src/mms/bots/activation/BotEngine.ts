import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { BotAuthority, BotThreadRole, BotThreads, NormalisedCall, WallReason } from '../../../shared/bots/personal/authority'
import {
  BOT_ESCALATION_TTL_MS,
  MAX_BOT_WALLS,
  permissionProblem,
  permissionText,
  withPermission,
  type BotBudgetWallKey,
  type BotEscalationAnswer,
  type BotEscalationSummary,
  type BotPermissionRequest,
  type BotWallKind
} from '../../../shared/bots/personal/escalation'
import { BOT_APP_TOOLS } from '../../../shared/bots/personal/manifest'
import { wallMessage } from '../../../shared/bots/personal/walls'
import type { ChargeResult, CountKind, CounterScope } from '../../../shared/harness/counters'
import type { ReserveResult, SpendLimits, SpendRequest, SpendScope } from '../../../shared/harness/spend'
import { isNeutralTool } from '../../../shared/harness/tools'
import {
  ACTIVE_TIME_CHUNK_MS,
  ENDED_ACTIVATION_STATUSES,
  MAX_QUEUED_ACTIVATIONS,
  type BotActivationSummary,
  type BotDefinition,
  type BotManifest,
  type BotPermissionLine,
  type BotSummary,
  type BotThreadCheck,
  type BotThreadSpec
} from '../../../shared/bots/personal/definition'
import { addedPermissions, intersectManifest, manifestSubset } from '../../../shared/bots/personal/manifest'
import type { Enforceability, HarnessError, RunPolicy } from '../../../shared/harness/types'
import type { NeutralTool } from '../../../shared/harness/tools'
import type { RunEngine } from '../../run/RunEngine'
import { TERMINAL_RUN_STATUSES, type BotTurnPayload, type RunRecord } from '../../run/types'
import { createBotAuthority } from '../authority/botAuthority'
import { BotDefinitionError, type BotDefinitionEntry, type BotDefinitionStore } from '../definitions/BotDefinitionStore'
import { botManifestDigest, compileBotThread } from '../grants/compile'
import type { BotActivationRow, BotDispatchRow, BotEscalationRow, BotStore } from '../store/BotStore'
import { BotCounterScope, BotSpendScope, type ActivationLimits } from '../store/scopes'
import { BotWallAbort, type BotTurnDispatcher, type PreparedBotTurn } from './dispatcher'

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
  /** Moves a thread to the trash (a deleted bot's home thread; its owned threads follow). */
  trashThread?(threadId: string): Promise<unknown>
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
  /** Wall-clock milliseconds, for the times `bots.db` records (default: `Date.now`). */
  clock?(): number
  /** Monotonic milliseconds, for measured active time (default: `performance.now`). */
  monotonic?(): number
  setTimer?(fn: () => void, ms: number): { clear(): void }
}

export type { BotSummary, BotThreadCheck } from '../../../shared/bots/personal/definition'

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
   * `changed` with `{botId?, activationId?}` after every change (`bots.changed`), and `escalation`
   * with a `BotEscalationSummary` when a wall asks the owner (`bots.escalation`).
   */
  readonly events = new EventEmitter()

  /**
   * The bot threads this process knows of, kept beside `bots.db`: when a read of it fails, a
   * known bot thread stays read-only and every other thread is left alone.
   */
  private readonly known = new Map<string, { botId: string; role: 'home' | BotThreadRole }>()

  constructor(private readonly host: BotEngineHost) {
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
    const revision = this.host.definitions.publish(botId, expectedDraftHash)
    this.store.ensureRegistry(botId)
    this.store.setPublished(botId, revision.revision!)
    this.changed({ botId })
    return revision
  }

  /**
   * Ends the bot's activations, forgets it, then trashes its home thread; ownership takes its
   * activation and context threads along. A crash in between is finished by the startup pass.
   */
  async remove(botId: string): Promise<void> {
    this.entry(botId)
    const live = this.store.db.transaction(() => {
      const running = this.store.activationsIn(botId, [...NOT_ENDED])
      for (const activation of running) {
        this.store.moveActivation(activation.id, [activation.status], 'cancelled', { endReason: 'bot_deleted' })
        this.store.closeEscalations(activation.id, 'cancelled')
      }
      this.store.revoke(botId)
      this.store.markDeleted(botId)
      return running
    })
    this.host.definitions.remove(botId)
    for (const activation of live) {
      await this.stopRun(activation)
      this.cleanup({ ...activation, status: 'cancelled' })
    }
    await this.trashHome(botId)
    this.changed({ botId })
  }

  private async trashHome(botId: string): Promise<void> {
    const home = this.store.registry(botId)?.homeThreadId
    if (!home || !this.host.trashThread || this.threadState(home) !== 'active') return
    try {
      await this.host.trashThread(home)
    } catch (error) {
      console.warn('a deleted bot\'s thread could not be trashed', { botId, error: error instanceof Error ? error.message : String(error) })
    }
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
      openEscalations: this.store.activationsIn(entry.id, ['waiting_grant']).reduce((count, row) => count + this.store.escalations({ activationId: row.id, status: 'open' }).length, 0)
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
      threads: [published.main].map((thread) => this.checkThread(thread, published.permissions))
    }
  }

  /**
   * Reads again the policy facts of every runtime the published revision runs on, so `approval`
   * and `approve` decide on a fresh reading. Never throws.
   */
  async refreshRuntimes(botId: string): Promise<void> {
    let instanceIds: string[]
    try {
      const published = this.published(botId)
      instanceIds = [...new Set([published.main].map((thread) => thread.selection.instanceId))]
    } catch {
      return
    }
    await Promise.all(instanceIds.map((instanceId) => this.refreshInstance(instanceId)))
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
    const refused = [published.main].map((thread) => this.checkThread(thread, published.permissions)).find((check) => !check.ok)
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

  private checkThread(thread: BotThreadSpec, grant: BotManifest): BotThreadCheck {
    const base = { key: thread.key, instanceId: thread.selection.instanceId, model: thread.selection.model }
    const compiled = compileBotThread({
      grant,
      digest: botManifestDigest(grant),
      thread,
      scratch: join(this.store.directory, 'scratch', '_check'),
      profileHome: this.host.profileHome,
      nativeNames: (tools) => this.nativeNames(thread.selection.instanceId, tools),
      remaining: { ...countLimits(grant), deadlineMs: grant.budget.maxActiveMs }
    })
    if (!compiled.ok) return { ...base, ok: false, reason: compiled.error.reason ?? compiled.error.message }
    const checked = this.host.harness.checkPolicy(thread.selection.instanceId, { mode: 'default', origin: 'bot', ...compiled.policy }, thread.selection.model)
    return checked.ok ? { ...base, ok: true } : { ...base, ok: false, reason: checked.error.reason ?? checked.error.message }
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
   * per bot runs at a time; later ones wait, at most 20 (the oldest waiting one is dropped).
   */
  async activate(input: { botId: string; input: string; clientRequestId: string }): Promise<BotActivationSummary> {
    const key = `manual:${input.clientRequestId}`
    const existing = this.store.activationByKey(key)
    if (existing) {
      if (existing.botId !== input.botId) throw new BotEngineError('client_request_id_conflict', 'This request belongs to another bot.')
      return this.activationSummary(existing)
    }
    const published = this.published(input.botId)
    const home = this.store.registry(input.botId)?.homeThreadId
    if (home && this.threadState(home) === 'trashed')
      throw new BotEngineError('bot_home_trashed', 'This bot\'s thread is in the trash. Restore it, or delete the bot.')
    const grant = this.store.activeGrant(input.botId)
    // Nothing is ever approved automatically: a revision that asks for more needs the owner first.
    if (!grant || !manifestSubset(published.permissions, grant.manifest))
      throw new BotEngineError('bot_approval_required', 'Approve this bot\'s permissions before it runs.', { added: addedPermissions(published.permissions, grant?.manifest ?? null) })
    const id = `act_${randomUUID()}`
    const dropped = this.store.db.transaction(() => {
      this.store.insertActivation({
        id,
        botId: input.botId,
        revision: published.revision!,
        grantDigest: grant.digest,
        trigger: { kind: 'manual', input: input.input },
        idempotencyKey: key,
        status: 'queued',
        createdAt: this.store.now()
      }, limitsOf(intersectManifest(published.permissions, grant.manifest)))
      const queued = this.store.activationsIn(input.botId, ['queued'])
      const over = queued.slice(0, Math.max(0, queued.length - MAX_QUEUED_ACTIVATIONS))
      for (const activation of over) this.store.moveActivation(activation.id, ['queued'], 'cancelled', { endReason: 'queue_full' })
      return over
    })
    if (dropped.length) this.changed({ botId: input.botId })
    await this.pump(input.botId)
    this.changed({ botId: input.botId, activationId: id })
    return this.activationSummary(this.store.activation(id)!)
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
    try {
      await this.host.stopThread?.(row.threadId)
    } catch (error) {
      console.warn('bot dispatch could not be stopped', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Starts the bot's oldest waiting activation when none of its activations is running. */
  private async pump(botId: string): Promise<void> {
    const next = this.store.db.transaction(() => {
      if (this.store.activationsIn(botId, [...ACTIVE_HOLDING]).length) return undefined
      const queued = this.store.activationsIn(botId, ['queued'])[0]
      if (!queued) return undefined
      this.store.moveActivation(queued.id, ['queued'], 'running')
      return this.store.activation(queued.id)
    })
    if (next) await this.startActivation(next)
  }

  /**
   * The activation's threads and scratch folder, then its one dispatch: the intent in `bots.db`
   * first, then the run, receipt and `turn.start` in one run-DB transaction.
   */
  private async startActivation(row: BotActivationRow): Promise<void> {
    try {
      const definition = this.host.definitions.revision(row.botId, row.revision)
      if (!definition) throw new BotEngineError('bot_not_published', 'The revision this activation was made for is gone.')
      const home = this.host.threads.ensureExecutionThread(`bot:${row.botId}`, definition.name.slice(0, 120))
      this.putThread({ threadId: home.id, botId: row.botId, role: 'home', key: 'home' })
      this.store.setHomeThread(row.botId, home.id)
      const title = `${definition.name}: ${summarise(row.trigger.input)}`.slice(0, 120)
      const thread = this.host.threads.ensureExecutionThread(`bot:${row.botId}:act:${row.id}`, title, undefined, { parentTaskId: home.id })
      this.putThread({ threadId: thread.id, botId: row.botId, role: 'activation', key: definition.main.key, activationId: row.id })
      const scratch = join(this.store.directory, 'scratch', row.id)
      mkdirSync(join(scratch, 'tmp'), { recursive: true, mode: 0o700 })
      const clientRequestId = `${row.id}:d1`
      const still = this.store.db.transaction(() => {
        if (!this.store.moveActivation(row.id, ['running'], 'running', { threadId: thread.id, scratch })) return false
        if (!this.store.dispatch(row.id, 1))
          this.store.insertDispatch({ activationId: row.id, n: 1, kind: 'start', clientRequestId, threadId: thread.id, prompt: { text: row.trigger.input }, policyDigest: row.grantDigest })
        return true
      })
      // Stopped (or its grant ended) while its threads were made: no dispatch, no folder left.
      if (!still) {
        rmSync(scratch, { recursive: true, force: true })
        return
      }
      await this.sendDispatch(this.store.activation(row.id)!, this.store.dispatch(row.id, 1)!)
    } catch (error) {
      const reason = error instanceof BotEngineError ? error.code : 'bot_start_failed'
      console.warn('bot activation could not start', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
      this.store.moveActivation(row.id, ['running'], 'failed', { endReason: reason })
      this.cleanup(this.store.activation(row.id) ?? row)
      this.changed({ botId: row.botId, activationId: row.id })
    }
  }

  // -- Execution (BotTurnDispatcher) -----------------------------------------------------------

  async refresh(payload: BotTurnPayload): Promise<void> {
    const row = this.store.activation(payload.activationId)
    const definition = row ? this.host.definitions.revision(row.botId, row.revision) : undefined
    if (definition) await this.refreshInstance(definition.main.selection.instanceId)
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
    // What runs: the revision's own permissions held inside the grant, so a narrower revision
    // narrows, plus what the owner allowed for this activation only.
    const effective = this.effectiveManifest(row, definition.permissions, grant.manifest)
    const counters = this.store.counters(row.id)
    const remainingMs = effective.budget.maxActiveMs - counters.activeMs
    if (remainingMs < ACTIVE_TIME_CHUNK_MS) return this.pause(row, 'active_time_exhausted', 'This bot used up its work time.')
    const scratch = row.scratch ?? join(this.store.directory, 'scratch', row.id)
    const compiled = compileBotThread({
      grant: effective,
      digest: grant.digest,
      thread: definition.main,
      scratch,
      profileHome: this.host.profileHome,
      nativeNames: (tools) => this.nativeNames(definition.main.selection.instanceId, tools),
      // The limits that run: the activation's scopes hold the shared counts and spend.
      remaining: { ...limitsOf(effective), deadlineMs: remainingMs },
      botTools: { escalate: true, consult: definition.context.length > 0 }
    })
    if (!compiled.ok) return this.block(row, 'policy_unenforceable', compiled.error.reason ?? compiled.error.message)
    const checked = this.host.harness.checkPolicy(definition.main.selection.instanceId, { mode: 'default', origin: 'bot', ...compiled.policy }, definition.main.selection.model)
    if (!checked.ok) return this.block(row, 'policy_unenforceable', checked.error.reason ?? checked.error.message)
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
    // runs on the daemon loop; bots stay refused until a supervisor outside it exists (`BOT_RUNTIME_GAPS`).
    const timer = (this.host.setTimer ?? defaultTimer)(() => {
      this.raiseWall(row.id, { dispatchN: dispatch.n, kind: 'budget', permission: { budget: { key: 'maxActiveMs' } }, reason: 'This bot used up its work time.' })
    }, remainingMs)
    const counterScope = this.wallingCounters(new BotCounterScope(this.store, row.id), row.id, dispatch.n)
    const spendLimited = spendLimits(effective)
    const spendScope = Object.keys(spendLimited).length ? this.wallingSpend(new BotSpendScope(this.store, row.id, payload.runId), row.id, dispatch.n) : null
    this.live.set(row.id, { controller, timer, startedMono: this.monotonic(), n: dispatch.n, deadline, counters: counterScope, spend: spendScope })
    const authority = this.authorityFor({
      row, mainN: dispatch.n, role: 'activation', permissions: compiled.permissions, grantDigest: grant.digest,
      controller, deadline, counters: counterScope, spend: spendScope,
      contexts: definition.context.map((thread) => ({ key: thread.key, title: thread.title }))
    })
    return {
      activationId: row.id,
      dispatchN: dispatch.n,
      // A leading `/` never runs a command: the trigger is text for the model.
      prompt: dispatch.prompt.text.startsWith('/') ? ` ${dispatch.prompt.text}` : dispatch.prompt.text,
      ...instructionsOf(definition.role, definition.main),
      selection: { ...definition.main.selection },
      policy: compiled.policy,
      authority,
      scratch,
      skills: compiled.permissions.skills,
      history: dispatch.kind === 'start' ? 'none' : 'thread'
    }
  }

  /**
   * A consult (PR 6 §5): the context thread's narrowed grant, under the main dispatch's counts,
   * spend and deadline. It attaches to its main dispatch only while that one is unsettled, and
   * charges no time of its own.
   */
  private prepareConsult(row: BotActivationRow, dispatch: BotDispatchRow, definition: BotDefinition, grant: { digest: string; manifest: BotManifest }, payload: BotTurnPayload): PreparedBotTurn | { refused: string; code: string } {
    const refuse = (code: string, refused: string) => ({ code, refused })
    const main = this.live.get(row.id)
    const thread = this.store.allThreads().find((entry) => entry.threadId === dispatch.threadId && entry.role === 'context')
    const spec = thread ? definition.context.find((entry) => entry.key === contextKey(thread.key)[0]) : undefined
    if (!main || main.n !== dispatch.mainN || main.controller.signal.aborted) return refuse('bot_consult_orphaned', 'The dispatch this consult belongs to has ended.')
    if (!spec) return refuse('bot_consult_unknown', 'This context thread is not part of the bot.')
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
      nativeNames: (tools) => this.nativeNames(spec.selection.instanceId, tools),
      remaining: { ...limitsOf(effective), deadlineMs: remainingMs },
      botTools: { escalate: true, consult: false }
    })
    if (!compiled.ok) return refuse('policy_unenforceable', compiled.error.reason ?? compiled.error.message)
    const checked = this.host.harness.checkPolicy(spec.selection.instanceId, { mode: 'default', origin: 'bot', ...compiled.policy }, spec.selection.model)
    if (!checked.ok) return refuse('policy_unenforceable', checked.error.reason ?? checked.error.message)
    // The start marker, only while the main dispatch is unsettled: a consult attaches before the
    // settlement and is waited for, or is refused and starts nothing.
    const attached = this.store.db.transaction(() => {
      const open = this.store.get('SELECT 1 AS open FROM bot_dispatches WHERE activation_id = ? AND n = ? AND settled_by IS NULL', row.id, main.n)
      if (!open) return false
      return this.store.run('UPDATE bot_dispatches SET started_at = ?, run_id = COALESCE(run_id, ?) WHERE activation_id = ? AND n = ? AND started_at IS NULL', this.now(), payload.runId, row.id, dispatch.n) > 0
    })
    if (!attached) return refuse('bot_consult_orphaned', 'The dispatch this consult belongs to has ended.')
    this.executing.add(`${row.id}:${dispatch.n}`)
    const authority = this.authorityFor({
      row, mainN: main.n, role: 'context', permissions: compiled.permissions, grantDigest: grant.digest,
      controller: main.controller, deadline: main.deadline, counters: main.counters, spend: main.spend, contexts: []
    })
    return {
      activationId: row.id,
      dispatchN: dispatch.n,
      prompt: dispatch.prompt.text.startsWith('/') ? ` ${dispatch.prompt.text}` : dispatch.prompt.text,
      ...instructionsOf(definition.role, spec),
      selection: { ...spec.selection },
      policy: compiled.policy,
      authority,
      scratch,
      skills: compiled.permissions.skills,
      history: 'thread'
    }
  }

  /** What an activation runs with: the revision held inside the grant, plus its "Allow this time" overlays. */
  private effectiveManifest(row: BotActivationRow, revision: BotManifest, granted: BotManifest): BotManifest {
    let manifest = intersectManifest(revision, granted)
    for (const overlay of this.store.overlays(row.id)) manifest = withPermission(manifest, overlay.permission, overlay.amount ?? undefined)
    return manifest
  }

  /**
   * The authority a turn of the activation runs under. A gate refusal the owner can answer becomes
   * a wall: the owner is asked, the dispatch ends, and the refused call tells the model to stop.
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
  }): BotAuthority {
    const { row, controller } = input
    const base = createBotAuthority({
      activationId: row.id,
      role: input.role,
      permissions: input.permissions,
      waiting: () => this.store.activation(row.id)?.status === 'waiting_grant',
      // Every call: the grant must still be the one the dispatch started under, and the dispatch live.
      live: () => {
        if (this.store.activeGrant(row.botId)?.digest !== input.grantDigest) return { kind: 'revoked' }
        const status = this.store.activation(row.id)?.status
        if (status === 'paused') return { kind: 'paused' }
        if (status === 'waiting_grant') return { kind: 'waiting' }
        if (controller.signal.aborted || status !== 'running') return { kind: 'ended' }
        return undefined
      },
      counters: input.counters,
      time: { deadline: () => input.deadline, signal: controller.signal },
      spend: input.spend
    })
    const check = (call: NormalisedCall): { ok: true } | { ok: false; wall: WallReason } => {
      const decided = base.check(call)
      if (decided.ok || !ESCALATABLE.has(decided.wall.kind)) return decided
      // Only app tools a bot can be granted are worth asking for; any other is just refused.
      if (call.kind === 'app' && !BOT_APP_TOOLS.has(call.tool)) return decided
      const permission = permissionOfWall(call, decided.wall)
      if (!permission) return decided
      return { ok: false, wall: this.raiseWall(row.id, { dispatchN: input.mainN, kind: 'gate', permission, reason: wallMessage(decided.wall) }) }
    }
    const authority: BotAuthority = {
      ...base,
      check,
      escalate: (request) => {
        const problem = permissionProblem(request.permission)
        if (problem) return `${problem} Ask for a tool, a folder, a skill, an MCP tool or a limit.`
        const live = base.check({ kind: 'app', tool: 'escalate', args: {} })
        if (!live.ok && live.wall.kind !== 'tool') return wallMessage(live.wall)
        const wall = this.raiseWall(row.id, {
          dispatchN: input.mainN,
          kind: 'escalate',
          permission: request.permission as BotPermissionRequest,
          reason: request.reason.trim() || 'The bot did not say why.',
          ...(request.toolCallId ? { toolCallId: request.toolCallId } : {})
        })
        return wallMessage(wall)
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
          this.raiseWall(activationId, { dispatchN: mainN, kind: 'budget', permission: { budget: { key } }, reason: `This bot reached its limit of ${charged.limit} ${kind === 'request' ? 'model requests' : 'tool calls'}.` })
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

  // -- Walls ------------------------------------------------------------------------------------

  /**
   * A wall (PR 6 §5): in one `bots.db` transaction the escalation is written and the activation
   * moves to `waiting_grant`; then the dispatch ends (its run ends `interrupted` by `bot_wall`, and
   * its consults stop with it). The sixth wall of an activation ends it `blocked` instead. Nothing
   * is held during the wait. The returned wall is what the refused call tells the model.
   */
  raiseWall(activationId: string, input: { dispatchN: number; kind: BotWallKind; permission: BotPermissionRequest; reason: string; toolCallId?: string }): WallReason {
    const raised = this.store.db.transaction(() => this.wallInTransaction(activationId, ['running'], input))
    if (raised.kind === 'none') {
      const status = this.store.activation(activationId)?.status
      return status === 'waiting_grant' ? { kind: 'waiting' } : status === 'paused' ? { kind: 'paused' } : { kind: 'ended' }
    }
    this.afterWall(activationId, raised)
    return raised.kind === 'wall' ? { kind: 'escalated', permission: permissionText(input.permission) } : { kind: 'ended' }
  }

  private wallInTransaction(activationId: string, from: readonly BotActivationRow['status'][], input: { dispatchN: number; kind: BotWallKind; permission: BotPermissionRequest; reason: string; toolCallId?: string }): { kind: 'wall'; escalation: BotEscalationRow } | { kind: 'blocked' } | { kind: 'none' } {
    const row = this.store.activation(activationId)
    if (!row || !from.includes(row.status)) return { kind: 'none' }
    if (this.store.countEscalations(activationId) >= MAX_BOT_WALLS) {
      this.store.moveActivation(activationId, [row.status], 'blocked', { endReason: 'asked_too_often' })
      return { kind: 'blocked' }
    }
    const createdAt = this.now()
    const escalation: BotEscalationRow = {
      id: `esc_${randomUUID()}`,
      activationId,
      dispatchN: input.dispatchN,
      toolCallId: input.toolCallId ?? null,
      kind: input.kind,
      permission: input.permission,
      reason: input.reason.slice(0, 2000),
      status: 'open',
      amount: null,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + BOT_ESCALATION_TTL_MS).toISOString(),
      answeredAt: null,
      appliedAt: null
    }
    this.store.insertEscalation(escalation)
    this.store.moveActivation(activationId, [row.status], 'waiting_grant', { endReason: 'wall' })
    return { kind: 'wall', escalation }
  }

  private afterWall(activationId: string, raised: { kind: 'wall'; escalation: BotEscalationRow } | { kind: 'blocked' }): void {
    // The dispatch ends now: its turn (and every consult, which shares the signal) is aborted.
    this.live.get(activationId)?.controller.abort(new BotWallAbort())
    const row = this.store.activation(activationId)
    if (raised.kind === 'wall') {
      this.armExpiry(raised.escalation)
      const summary = this.escalationSummary(raised.escalation)
      try { this.events.emit('escalation', summary) } catch { /* a listener never undoes a wall */ }
    }
    this.changed({ ...(row ? { botId: row.botId } : {}), activationId })
  }

  private armExpiry(escalation: BotEscalationRow): void {
    this.expiryTimers.get(escalation.id)?.clear()
    const wait = Math.max(0, Date.parse(escalation.expiresAt) - this.now())
    this.expiryTimers.set(escalation.id, (this.host.setTimer ?? defaultTimer)(() => this.expire(escalation.id), wait))
  }

  /** An escalation nobody answered in time ends its activation `blocked`. Nothing is auto-approved. */
  private expire(escalationId: string): void {
    this.expiryTimers.delete(escalationId)
    const escalation = this.store.escalation(escalationId)
    if (!escalation) return
    const moved = this.store.db.transaction(() => {
      if (!this.store.answerEscalation(escalationId, 'expired')) return false
      return this.store.moveActivation(escalation.activationId, ['waiting_grant'], 'blocked', { endReason: 'escalation_expired' })
    })
    if (moved) this.changed({ activationId: escalation.activationId })
  }

  listEscalations(activationId?: string): BotEscalationSummary[] {
    return this.store.escalations(activationId ? { activationId } : {}).map((row) => this.escalationSummary(row))
  }

  private escalationSummary(row: BotEscalationRow): BotEscalationSummary {
    const activation = this.store.activation(row.activationId)
    return {
      id: row.id,
      activationId: row.activationId,
      botId: activation?.botId ?? '',
      dispatchN: row.dispatchN,
      kind: row.kind,
      permission: row.permission,
      permissionText: permissionText(row.permission),
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      answeredAt: row.answeredAt,
      amount: row.amount
    }
  }

  /**
   * The owner's answer to a wall. "Allow for this bot" publishes a revision with the permission
   * and approves it in one action; "Allow this time" and "Allow N more" add an overlay for this
   * activation only; "Deny" records the denial. Every answer but expiry is followed by a
   * continuation dispatch, once the walled runs ended and no unknown call is unacknowledged.
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
    if (input.answer === 'allow_bot') this.allowForBot(row, escalation.permission, amount)
    const status = input.answer === 'deny' ? 'denied' : input.answer === 'allow_bot' ? 'allowed_bot' : 'allowed_once'
    const answered = this.store.db.transaction(() => {
      if (!this.store.answerEscalation(escalation.id, status, amount)) return false
      if (input.answer === 'allow_once' || input.answer === 'allow_more') this.store.putOverlay(row.id, escalation.id, escalation.permission, amount)
      return true
    })
    if (!answered) throw new BotEngineError('escalation_answered', 'This request was already answered or has expired.')
    this.expiryTimers.get(escalation.id)?.clear()
    this.expiryTimers.delete(escalation.id)
    this.changed({ botId: row.botId, activationId: row.id })
    await this.advance(row.id)
    return { escalation: this.escalationSummary(this.store.escalation(escalation.id)!), activation: this.activationSummary(this.store.activation(row.id)!) }
  }

  /** "Allow for this bot": a revision with the permission is published and its grant approved. */
  private allowForBot(row: BotActivationRow, permission: BotPermissionRequest, amount: number | undefined): void {
    const entry = this.entry(row.botId)
    const published = entry.published
    const grant = this.store.activeGrant(row.botId)
    if (!published || !grant) throw new BotEngineError('bot_approval_required', 'Approve this bot\'s permissions first.')
    const next: BotDefinition = { ...published, permissions: withPermission(published.permissions, permission, amount) }
    delete next.revision
    const draftChanged = entry.draftHash !== published.revision
    const saved = this.host.definitions.save(next, entry.draftHash)
    const revision = this.host.definitions.publish(row.botId, saved.draftHash)
    this.store.setPublished(row.botId, revision.revision!)
    // Unpublished edits stay a draft, with the same permission added.
    if (draftChanged) this.host.definitions.save({ ...entry.draft, permissions: withPermission(entry.draft.permissions, permission, amount) }, saved.draftHash)
    const wider = withPermission(grant.manifest, permission, amount)
    const digest = botManifestDigest(wider)
    this.store.db.transaction(() => {
      this.store.approve(row.botId, digest, wider)
      // The activation and its queued siblings move to the wider grant; nothing else changes for them.
      this.store.regrant(row.botId, grant.digest, digest, revision.revision!)
    })
  }

  /**
   * Moves an activation on once nothing of it runs: settles a finished main dispatch to its
   * result, or sends the continuation an answer is waiting for. The unknown-call gate comes first:
   * no result and no continuation passes an unacknowledged unknown call.
   */
  private async advance(activationId: string, text?: string): Promise<void> {
    const row = this.store.activation(activationId)
    if (!row) return
    if (ENDED_ACTIVATION_STATUSES.has(row.status)) {
      this.cleanup(row)
      return
    }
    if (!this.allRunsEnded(row)) return
    this.collectUnknownCalls(row)
    if (row.status === 'running') {
      const main = this.store.lastMainDispatch(row.id)
      const run = main?.runId ? this.host.runs()?.getRun(main.runId) : undefined
      if (!main || main.endedAt === null || !run) return
      const next = this.store.db.transaction(() => {
        const unknown = this.store.unknownCalls(row.id).some((call) => !call.acknowledged)
        if (unknown || run.status === 'uncertain')
          this.store.moveActivation(row.id, ['running'], 'paused', { endReason: run.status === 'uncertain' && !unknown ? 'uncertain' : 'unknown_calls', ...(text !== undefined ? { result: text } : {}) })
        else if (run.status === 'completed') {
          this.store.moveActivation(row.id, ['running'], 'done', { endReason: null, result: text ?? '' })
          // A successful dispatch resets the automatic-restart allowance.
          this.store.setAutoRestarts(row.id, 0)
        } else {
          const error = typeof run.outcome?.error === 'string' ? run.outcome.error : undefined
          this.store.moveActivation(row.id, ['running'], 'failed', { endReason: error ?? run.status })
        }
        return this.store.activation(row.id)!
      })
      this.cleanup(next)
      this.changed({ botId: row.botId, activationId: row.id })
      this.pumpLater(row.botId)
      return
    }
    if (row.status === 'waiting_grant') {
      const answer = this.store.pendingAnswer(row.id)
      if (answer) await this.continueWith(row.id, ['waiting_grant'], { answer })
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
    for (const dispatch of this.store.dispatches(row.id)) {
      const runId = dispatch.runId ?? this.receiptRun(dispatch.clientRequestId)
      if (!runId) continue
      const run = runs.getRun(runId)
      if (!run || (!TERMINAL_RUN_STATUSES.has(run.status) && dispatch.exitAt === null)) continue
      const role = dispatch.kind === 'consult' ? 'consult' : 'main'
      for (const call of runs.tools.listForRun(runId)) {
        if (call.idempotent) continue
        if (call.status === 'outcome_unknown' || call.status === 'started')
          this.store.putUnknownCall({ activationId: row.id, runId, invocationId: call.invocationId, tool: call.tool, role })
        else this.store.dropUnknownCall(row.id, call.invocationId)
      }
    }
  }

  /**
   * A continuation dispatch (PR 6 §5): after an answer, a restart or the owner's Continue. In one
   * transaction it checks the unknown-call gate (unacknowledged calls pause the activation, and a
   * recorded answer waits for the acknowledged Continue) and the remaining time (under 15 s is a
   * budget wall), then writes the dispatch; the run follows through `sendWithStart`, continuing
   * the previous main run.
   */
  private async continueWith(activationId: string, from: readonly BotActivationRow['status'][], input: { answer?: BotEscalationRow; restart?: boolean; acknowledgeUncertain?: boolean }): Promise<'sent' | 'paused' | 'wall' | 'none'> {
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
    const decided = this.store.db.transaction((): { kind: 'paused' | 'wall' | 'blocked' | 'none' } | { kind: 'sent'; dispatch: BotDispatchRow } => {
      const current = this.store.activation(row.id)
      if (!current || !from.includes(current.status)) return { kind: 'none' }
      if (!definition || !grant || !effective || grant.digest !== current.grantDigest) {
        this.store.moveActivation(row.id, [current.status], 'blocked', { endReason: 'bot_grant_revoked' })
        return { kind: 'blocked' }
      }
      const unknown = this.store.unknownCalls(row.id).some((call) => !call.acknowledged)
      if (unknown || (uncertain && !input.acknowledgeUncertain)) {
        this.store.moveActivation(row.id, [current.status], 'paused', { endReason: unknown ? 'unknown_calls' : 'uncertain' })
        return { kind: 'paused' }
      }
      const remaining = effective.budget.maxActiveMs - this.store.counters(row.id).activeMs
      if (remaining < ACTIVE_TIME_CHUNK_MS) {
        const wall = this.wallInTransaction(row.id, [current.status], { dispatchN: previous?.n ?? 0, kind: 'budget', permission: { budget: { key: 'maxActiveMs' } }, reason: 'This bot used up its work time.' })
        if (input.answer) this.store.markApplied(input.answer.id)
        return { kind: wall.kind === 'wall' ? 'wall' : wall.kind === 'blocked' ? 'blocked' : 'none' }
      }
      const n = this.store.nextDispatchN(row.id)
      const dispatch = {
        activationId: row.id,
        n,
        kind: 'continue' as const,
        clientRequestId: `${row.id}:d${n}`,
        threadId: current.threadId!,
        prompt: { text: this.continuationPrompt(row.id, input) },
        policyDigest: grant.digest
      }
      this.store.insertDispatch(dispatch)
      if (input.answer) this.store.markApplied(input.answer.id)
      this.store.setLimits(row.id, limitsOf(effective))
      if (input.restart) this.store.setAutoRestarts(row.id, current.autoRestarts + 1)
      this.store.moveActivation(row.id, [current.status], 'running', { endReason: null })
      return { kind: 'sent', dispatch: this.store.dispatch(row.id, n)! }
    })
    if (decided.kind === 'wall') {
      const escalation = this.store.escalations({ activationId: row.id, status: 'open' }).at(-1)
      if (escalation) this.afterWall(row.id, { kind: 'wall', escalation })
      return 'wall'
    }
    this.changed({ botId: row.botId, activationId: row.id })
    if (decided.kind !== 'sent') return decided.kind === 'paused' ? 'paused' : 'none'
    await this.sendDispatch(this.store.activation(row.id)!, decided.dispatch, {
      ...(previous?.runId ? { continuationOfRunId: previous.runId } : {}),
      ...(uncertain ? { acknowledgeUncertain: true } : {})
    })
    return 'sent'
  }

  private continuationPrompt(activationId: string, input: { answer?: BotEscalationRow; restart?: boolean }): string {
    const answer = input.answer
    const lead = answer
      ? `${answer.status === 'denied' ? 'The owner denied' : 'The owner allowed'}: ${permissionText(answer.permission)}${answer.amount !== null && 'budget' in answer.permission ? ` (${answer.amount} more)` : ''}.`
      : input.restart ? 'Mousse restarted while you were working.' : 'The owner asked you to continue.'
    const calls = this.store.unknownCalls(activationId)
    const interrupted = calls.length
      ? ` Interrupted tool calls (their effects are unknown; check before repeating them): ${calls.map((call) => `${call.tool} (${call.role} run ${call.runId}, call ${call.invocationId})`).join('; ')}.`
      : ''
    return `[Mousse] ${lead} Continue the task.${interrupted}`
  }

  /** Sends a written dispatch: its run, receipt and `turn.start` in one run-DB transaction. */
  private async sendDispatch(row: BotActivationRow, dispatch: BotDispatchRow, options: { continuationOfRunId?: string; acknowledgeUncertain?: boolean } = {}): Promise<void> {
    try {
      const runs = this.host.runs()
      if (!runs) throw new BotEngineError('bots_unavailable', 'The run engine is not running.')
      const sent = await runs.sendWithStart(
        { kind: 'send', threadId: dispatch.threadId, clientRequestId: dispatch.clientRequestId, source: 'bot', ...options },
        (runId): BotTurnPayload => ({ kind: 'bot', runId, threadId: dispatch.threadId, activationId: row.id, dispatchN: dispatch.n })
      )
      if (sent.status !== 'accepted') throw new BotEngineError('bot_dispatch_refused', `The bot's run was refused (${sent.reason}).`)
      this.store.setDispatchRun(row.id, dispatch.n, sent.runId)
      this.host.notifyEffects()
    } catch (error) {
      const reason = error instanceof BotEngineError ? error.code : 'bot_start_failed'
      console.warn('bot dispatch could not be sent', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
      this.store.moveActivation(row.id, ['running'], 'failed', { endReason: reason })
      this.cleanup(this.store.activation(row.id) ?? row)
      this.changed({ botId: row.botId, activationId: row.id })
    }
  }

  /**
   * The owner's Continue (`bots.activations.continue`) of a paused or blocked activation. Unknown
   * calls must be acknowledged first ("I've checked what these calls did"), which also covers an
   * `uncertain` main run. A recorded wall answer is applied by this continuation.
   */
  async continueActivation(activationId: string, options: { acknowledgeUncertain?: boolean } = {}): Promise<BotActivationSummary> {
    const row = this.store.activation(activationId)
    if (!row) throw new BotEngineError('activation_not_found', 'No activation with that id.')
    if (row.status !== 'paused' && row.status !== 'blocked') throw new BotEngineError('bot_not_paused', 'Only a paused or blocked activation can be continued.')
    if (!row.threadId || !this.store.lastMainDispatch(row.id)) throw new BotEngineError('bot_not_started', 'This activation never started; run the bot again.')
    if (this.store.activationsIn(row.botId, [...ACTIVE_HOLDING]).some((other) => other.id !== row.id))
      throw new BotEngineError('bot_busy', 'Another run of this bot is in progress. Continue this one when it has finished.')
    if (!this.allRunsEnded(row)) throw new BotEngineError('bot_still_running', 'This bot\'s last run has not stopped yet.')
    this.collectUnknownCalls(row)
    if (options.acknowledgeUncertain) this.store.acknowledgeUnknownCalls(row.id)
    if (this.store.unknownCalls(row.id).some((call) => !call.acknowledged))
      throw new BotEngineError('unknown_calls_not_acknowledged', 'Check what the interrupted tool calls did before continuing.', { calls: this.store.unknownCalls(row.id) })
    const main = this.store.lastMainDispatch(row.id)
    if (main?.runId && this.host.runs()?.getRun(main.runId)?.status === 'uncertain' && !options.acknowledgeUncertain)
      throw new BotEngineError('uncertain_not_acknowledged', 'Check what the interrupted tool calls did before continuing.')
    const answer = this.store.pendingAnswer(row.id)
    await this.continueWith(row.id, ['paused', 'blocked'], { ...(answer ? { answer } : {}), ...(options.acknowledgeUncertain ? { acknowledgeUncertain: true } : {}) })
    return this.activationSummary(this.store.activation(row.id)!)
  }

  /** "Mark done": a paused activation whose run completed keeps its draft result as the result. */
  markDone(activationId: string, options: { acknowledgeUncertain?: boolean } = {}): BotActivationSummary {
    const row = this.store.activation(activationId)
    if (!row) throw new BotEngineError('activation_not_found', 'No activation with that id.')
    const main = this.store.lastMainDispatch(row.id)
    const run = main?.runId ? this.host.runs()?.getRun(main.runId) : undefined
    if (row.status !== 'paused' || run?.status !== 'completed') throw new BotEngineError('bot_not_done', 'Only a paused activation whose run completed can be marked done.')
    if (options.acknowledgeUncertain) this.store.acknowledgeUnknownCalls(row.id)
    if (this.store.unknownCalls(row.id).some((call) => !call.acknowledged))
      throw new BotEngineError('unknown_calls_not_acknowledged', 'Check what the interrupted tool calls did first.')
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
      await this.sendDispatch(row, written)
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
      return open ? { kind: 'escalated', permission: permissionText(open.permission) } : { kind: 'waiting' }
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
   * then its end; its consults are stopped, and the activation moves on once they have ended too. A
   * consult: its end, and its final message for the waiting `consult` call. Idempotent.
   */
  settle(payload: BotTurnPayload, outcome: { text?: string }): void {
    const runs = this.host.runs()
    const run = runs?.getRun(payload.runId)
    if (!runs || !run || !TERMINAL_RUN_STATUSES.has(run.status)) return
    const row = this.store.activation(payload.activationId)
    const dispatch = row ? this.store.dispatch(row.id, payload.dispatchN) : undefined
    if (!row || !dispatch) return
    if (dispatch.kind === 'consult') return this.settleConsult(row, dispatch, run, outcome, true)
    if (dispatch.endedAt !== null) {
      // Settled from the run's terminal event first: the executor's final message still lands.
      if (outcome.text !== undefined)
        this.store.run("UPDATE bot_activations SET result = ? WHERE id = ? AND status IN ('done', 'paused') AND (result IS NULL OR result = '')", outcome.text, row.id)
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
      // `exit_at` stays empty: it is the evidence that the processes are gone, which only the
      // active-time supervisor can give.
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
    void this.advance(row.id, outcome.text).catch((error) => console.warn('bot activation could not move on', { activationId: row.id, error: error instanceof Error ? error.message : String(error) }))
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

  private block(row: BotActivationRow, code: string, reason: string): { refused: string; code: string } {
    this.store.moveActivation(row.id, ['running'], 'blocked', { endReason: code })
    this.changed({ botId: row.botId, activationId: row.id })
    return { code, refused: reason }
  }

  private pause(row: BotActivationRow, code: string, reason: string): { refused: string; code: string } {
    this.store.moveActivation(row.id, ['running'], 'paused', { endReason: code })
    this.changed({ botId: row.botId, activationId: row.id })
    return { code, refused: reason }
  }

  // -- Trash, profile removal and startup (PR 6 §4, §5a) -----------------------------------------

  /**
   * The lifecycle coordinator is about to trash `threadIds` (a thread and every thread it owns):
   * every unfinished activation whose own, home or context thread is among them ends `cancelled`
   * with `thread_trashed`, its escalations close, and its dispatch and consults stop. Idempotent,
   * so the index projection runs it again after the move. Restoring never revives an activation.
   */
  beforeTrash(threadIds: readonly string[]): void {
    const trashed = new Set(threadIds)
    if (!trashed.size) return
    const threads = this.store.allThreads()
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
  }

  afterTrash(threadIds: readonly string[]): void {
    this.beforeTrash(threadIds)
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
    for (const botId of new Set(this.store.activationsWith(['queued']).map((row) => row.botId))) this.pumpLater(botId)
  }

  private reconcilePhaseOne(runs: RunEngine): void {
    // P1: a dispatch whose run was written but whose id was not: the receipt names it.
    for (const dispatch of this.store.all('SELECT * FROM bot_dispatches WHERE run_id IS NULL').map((row) => this.store.dispatch(row.activation_id as string, Number(row.n))!)) {
      const runId = this.receiptRun(dispatch.clientRequestId)
      if (runId) this.store.setDispatchRun(dispatch.activationId, dispatch.n, runId)
    }
    // P2 needs the recorded children of the active-time supervisor, which this build does not have
    // (`BOT_RUNTIME_GAPS`); no child is recorded, so there is nothing to kill.
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
      this.store.dropThread(thread.threadId)
      this.known.delete(thread.threadId)
      const [key, gen] = contextKey(thread.key)
      if (this.store.contextGen(thread.botId, key) <= gen) this.store.bumpContextGen(thread.botId, key)
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
    // Row 1: the bot was deleted (a crash between its deletion and trashing its home thread).
    if (this.store.registry(row.botId)?.deletedAt) {
      end('cancelled', 'bot_deleted')
      await this.trashHome(row.botId)
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
      const open = this.store.escalations({ activationId: row.id, status: 'open' }).at(-1)
      if (open) {
        if (Date.parse(open.expiresAt) <= this.now()) this.expire(open.id)
        else this.armExpiry(open)
      }
      return
    }
    const main = this.store.lastMainDispatch(row.id)
    if (!main) return
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
      this.changed({ botId: row.botId, activationId: row.id })
      return
    }
    // Row 6: the dispatch intent was written, its run never was: send it again with the same request id.
    if (!run) {
      if (!this.grantHolds(row)) return void this.block(row, 'bot_grant_revoked', 'The bot\'s permissions were revoked or changed.')
      const previous = this.store.dispatches(row.id).filter((dispatch) => dispatch.kind !== 'consult' && dispatch.n < main.n).at(-1)
      await this.sendDispatch(row, main, previous?.runId ? { continuationOfRunId: previous.runId } : {})
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
      // Its time window was already settled: a new dispatch with the same prompt, never the old row again.
      runs.markTerminal(run.runId, 'cancelled', { error: 'bot_dispatch_restarted' })
      const n = this.store.nextDispatchN(row.id)
      this.store.insertDispatch({ activationId: row.id, n, kind: 'continue', clientRequestId: `${row.id}:d${n}`, threadId: main.threadId, prompt: main.prompt, policyDigest: row.grantDigest })
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
      const raised = this.store.db.transaction(() => this.wallInTransaction(row.id, ['running'], {
        dispatchN: main.n,
        kind: 'budget',
        permission: { budget: { key: 'maxActiveMs' } },
        reason: 'Mousse stopped unexpectedly while this bot was working. Its remaining work time was counted as used, because Mousse can\'t tell how long its commands kept running. Allow more time to continue.'
      }))
      if (raised.kind !== 'none') this.afterWall(row.id, raised)
      return
    }
    // Rows 11 and 12: one automatic continuation, then the owner decides.
    if (row.autoRestarts >= 1) {
      this.store.moveActivation(row.id, ['running'], 'paused', { endReason: 'restarted_twice' })
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
    return role === 'activation' || role === 'context' ? role : undefined
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
      uncertain: run?.status === 'uncertain'
    }
  }

  /** Stops the active-time timers (profile shutdown). */
  close(): void {
    for (const live of this.live.values()) live.timer?.clear()
    this.live.clear()
    for (const timer of this.expiryTimers.values()) timer.clear()
    this.expiryTimers.clear()
  }
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


function instructionsOf(role: string, thread: BotThreadSpec): { instructions?: string } {
  const instructions = 'instructions' in thread.agent ? thread.agent.instructions : undefined
  const parts = [role.trim(), instructions].filter(Boolean)
  return parts.length ? { instructions: parts.join('\n\n') } : {}
}

/** What a gate refusal asks the owner for. */
function permissionOfWall(call: NormalisedCall, wall: WallReason): BotPermissionRequest | undefined {
  switch (wall.kind) {
    case 'path': return { path: wall.path, access: wall.access }
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

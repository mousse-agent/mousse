import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { BotThreadRole, BotThreads } from '../../../shared/bots/personal/authority'
import {
  ACTIVE_TIME_CHUNK_MS,
  ENDED_ACTIVATION_STATUSES,
  MAX_QUEUED_ACTIVATIONS,
  type BotActivationSummary,
  type BotDefinition,
  type BotManifest,
  type BotPermissionLine,
  type BotThreadSpec
} from '../../../shared/bots/personal/definition'
import { addedPermissions, intersectManifest, manifestSubset } from '../../../shared/bots/personal/manifest'
import type { Enforceability, HarnessError, RunPolicy } from '../../../shared/harness/types'
import type { NeutralTool } from '../../../shared/harness/tools'
import type { RunEngine } from '../../run/RunEngine'
import { TERMINAL_RUN_STATUSES, type BotTurnPayload } from '../../run/types'
import { createBotAuthority } from '../authority/botAuthority'
import { BotDefinitionError, type BotDefinitionEntry, type BotDefinitionStore } from '../definitions/BotDefinitionStore'
import { botManifestDigest, compileBotThread } from '../grants/compile'
import type { BotActivationRow, BotStore } from '../store/BotStore'
import { BotCounterScope, BotSpendScope, type ActivationLimits } from '../store/scopes'
import type { BotTurnDispatcher, PreparedBotTurn } from './dispatcher'

/**
 * The personal bot engine (PR 6 §4, unit 6c-1): one-time approval with the subset rule, manual
 * activations, and one dispatch per activation. A dispatch is written to `bots.db` first, then its
 * run, receipt and `turn.start` in one run-DB transaction (`sendWithStart`), with an inert payload.
 * The `turn.start` executor asks `prepare` for everything the turn runs with and `settle` once
 * the run ended; `settle` is the only writer of a dispatch's outcome.
 *
 * Not here (6c-2): walls and escalation, continuations, restarts, consults, the startup pass and
 * the trash and profile hooks.
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
  }
  /** The profile's run engine (null while it is not running). */
  runs(): RunEngine | null
  harness: {
    checkPolicy(instanceId: string, policy: RunPolicy, model?: string): Enforceability
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

/** One thread's check result, as the approval dialog shows it. */
export interface BotThreadCheck {
  key: string
  instanceId: string
  model: string
  ok: boolean
  reason?: string
}

export interface BotSummary {
  id: string
  name: string
  role: string
  draftHash: string
  revision: string | null
  grant: { digest: string; approvedAt: string } | null
  /** Permissions the published revision asks for beyond the active grant (empty: it runs without asking). */
  needsApproval: BotPermissionLine[]
}

interface LiveDispatch {
  controller: AbortController
  timer: { clear(): void } | undefined
  /** When the dispatch started, on the monotonic clock: what settlement measures from. */
  startedMono: number
}

const ACTIVE_HOLDING = ['running'] as const

export class BotEngine implements BotTurnDispatcher, BotThreads {
  private readonly live = new Map<string, LiveDispatch>()
  /** `changed` with `{botId?, activationId?}` after every change (`bots.changed`). */
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

  /** Ends the bot's activations, then forgets it. Its threads stay until the owner trashes them. */
  async remove(botId: string): Promise<void> {
    this.entry(botId)
    const live = this.store.db.transaction(() => {
      const running = this.store.activationsIn(botId, ['queued', 'running', 'waiting_grant', 'paused', 'blocked'])
      for (const activation of running) this.store.moveActivation(activation.id, [activation.status], 'cancelled', { endReason: 'bot_deleted' })
      this.store.revoke(botId)
      this.store.markDeleted(botId)
      return running
    })
    this.host.definitions.remove(botId)
    for (const activation of live) await this.stopRun(activation)
    this.changed({ botId })
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
      needsApproval: published ? addedPermissions(published.permissions, grant?.manifest ?? null) : []
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
    this.store.moveActivation(activationId, [row.status], 'cancelled', { endReason: 'stopped' })
    await this.stopRun(row)
    if (row.status !== 'running') this.cleanup(row)
    this.changed({ botId: row.botId, activationId })
    await this.pump(row.botId)
    return this.activationSummary(this.store.activation(activationId)!)
  }

  private async stopRun(row: BotActivationRow): Promise<void> {
    if (row.status !== 'running' || !row.threadId) return
    this.live.get(row.id)?.controller.abort(new Error('stopped'))
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
      const runs = this.host.runs()
      if (!runs) throw new BotEngineError('bots_unavailable', 'The run engine is not running.')
      const sent = await runs.sendWithStart(
        { kind: 'send', threadId: thread.id, clientRequestId, source: 'bot' },
        (runId): BotTurnPayload => ({ kind: 'bot', runId, threadId: thread.id, activationId: row.id, dispatchN: 1 })
      )
      if (sent.status !== 'accepted') throw new BotEngineError('bot_dispatch_refused', `The bot's run was refused (${sent.reason}).`)
      this.store.setDispatchRun(row.id, 1, sent.runId)
      this.host.notifyEffects()
    } catch (error) {
      const reason = error instanceof BotEngineError ? error.code : 'bot_start_failed'
      console.warn('bot activation could not start', { activationId: row.id, error: error instanceof Error ? error.message : String(error) })
      this.store.moveActivation(row.id, ['running'], 'failed', { endReason: reason })
      this.cleanup(this.store.activation(row.id) ?? row)
      this.changed({ botId: row.botId, activationId: row.id })
    }
  }

  // -- Execution (BotTurnDispatcher) -----------------------------------------------------------

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
    // What runs: the revision's own permissions held inside the grant, so a narrower revision narrows.
    const effective = intersectManifest(definition.permissions, grant.manifest)
    const counters = this.store.counters(row.id)
    const remainingMs = effective.budget.maxActiveMs - counters.activeMs
    if (remainingMs < ACTIVE_TIME_CHUNK_MS) return this.pause(row, 'active_time_exhausted', 'This bot used up its work time.')
    const scratch = row.scratch ?? join(this.store.directory, 'scratch', row.id)
    const compiled = compileBotThread({
      grant: grant.manifest,
      revision: definition.permissions,
      digest: grant.digest,
      thread: definition.main,
      scratch,
      profileHome: this.host.profileHome,
      nativeNames: (tools) => this.nativeNames(definition.main.selection.instanceId, tools),
      // The limits that run: the activation's scopes hold the shared counts and spend.
      remaining: { ...limitsOf(effective), deadlineMs: remainingMs }
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
    const threadId = dispatch.threadId
    // At the deadline the turn is aborted and its run stopped (the gateway's `maxWallMs` stops the
    // attempt too). Both run on the daemon loop: bots stay refused until a supervisor outside it
    // exists (`BOT_RUNTIME_GAPS`).
    const timer = (this.host.setTimer ?? defaultTimer)(() => {
      controller.abort(new Error('active_time_deadline'))
      void Promise.resolve(this.host.stopThread?.(threadId)).catch(() => {})
    }, remainingMs)
    this.live.set(row.id, { controller, timer, startedMono: this.monotonic() })
    const spendLimited = spendLimits(effective)
    const grantDigest = grant.digest
    const authority = createBotAuthority({
      activationId: row.id,
      role: 'activation',
      permissions: compiled.permissions,
      waiting: () => this.store.activation(row.id)?.status === 'waiting_grant',
      // Every call: the grant must still be the one the dispatch started under, and the dispatch live.
      live: () => {
        if (this.store.activeGrant(row.botId)?.digest !== grantDigest) return { kind: 'revoked' }
        const status = this.store.activation(row.id)?.status
        if (controller.signal.aborted || (status !== 'running' && status !== 'waiting_grant')) return { kind: 'ended' }
        return undefined
      },
      counters: new BotCounterScope(this.store, row.id),
      time: { deadline: () => deadline, signal: controller.signal },
      spend: Object.keys(spendLimited).length ? new BotSpendScope(this.store, row.id, payload.runId) : null
    })
    const instructions = 'instructions' in definition.main.agent ? definition.main.agent.instructions : undefined
    const role = definition.role.trim()
    return {
      activationId: row.id,
      dispatchN: dispatch.n,
      // A leading `/` never runs a command: the trigger is text for the model.
      prompt: dispatch.prompt.text.startsWith('/') ? ` ${dispatch.prompt.text}` : dispatch.prompt.text,
      ...([role, instructions].some(Boolean) ? { instructions: [role, instructions].filter(Boolean).join('\n\n') } : {}),
      selection: { ...definition.main.selection },
      policy: compiled.policy,
      authority,
      scratch,
      skills: compiled.permissions.skills
    }
  }

  /**
   * Settles a dispatch once its run is terminal, in this order: its active time (unconditionally),
   * then its tool calls whose outcome is unknown, then the activation's state. Idempotent: a
   * second call changes nothing.
   */
  settle(payload: BotTurnPayload, outcome: { text?: string }): void {
    const runs = this.host.runs()
    const run = runs?.getRun(payload.runId)
    if (!runs || !run || !TERMINAL_RUN_STATUSES.has(run.status)) return
    const row = this.store.activation(payload.activationId)
    const dispatch = row ? this.store.dispatch(row.id, payload.dispatchN) : undefined
    if (!row || !dispatch) return
    if (dispatch.endedAt !== null) {
      // Settled from the run's terminal event first: the executor's final message still lands.
      if (outcome.text !== undefined)
        this.store.run("UPDATE bot_activations SET result = ? WHERE id = ? AND status IN ('done', 'paused') AND (result IS NULL OR result = '')", outcome.text, row.id)
      return
    }
    const ledger = runs.tools.listForRun(run.runId)
    const live = this.live.get(row.id)
    this.live.delete(row.id)
    live?.timer?.clear()
    live?.controller.abort(new Error('dispatch_ended'))
    // Measured on the monotonic clock of the process that ran the dispatch. Without that measure
    // (another process started it), nothing is refunded: the whole prepaid allowance stays charged.
    const measured = live ? this.monotonic() - live.startedMono : undefined
    const next = this.store.db.transaction(() => {
      // 1. Time: the measured window, never above the deadline, applied once as a signed difference.
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
      // 2. Tool calls whose execution ended without an outcome: the owner checks them first.
      for (const call of ledger) {
        if (call.idempotent) continue
        if (call.status === 'outcome_unknown' || call.status === 'started')
          this.store.putUnknownCall({ activationId: row.id, runId: run.runId, invocationId: call.invocationId, tool: call.tool, role: 'main' })
        else this.store.dropUnknownCall(row.id, call.invocationId)
      }
      this.store.run('UPDATE bot_dispatches SET ended_at = ?, outcome = ? WHERE activation_id = ? AND n = ? AND ended_at IS NULL', this.store.now(), run.status, row.id, dispatch.n)
      // 3. State, only for an activation still running (a stopped one stays cancelled).
      const unknown = this.store.unknownCalls(row.id).some((call) => !call.acknowledged)
      if (unknown || run.status === 'uncertain')
        this.store.moveActivation(row.id, ['running'], 'paused', { endReason: 'unknown_calls', ...(outcome.text !== undefined ? { result: outcome.text } : {}) })
      else if (run.status === 'completed')
        this.store.moveActivation(row.id, ['running'], 'done', { endReason: null, result: outcome.text ?? '' })
      else {
        const error = typeof run.outcome?.error === 'string' ? run.outcome.error : undefined
        this.store.moveActivation(row.id, ['running'], 'failed', { endReason: error ?? run.status })
      }
      return this.store.activation(row.id)!
    })
    this.cleanup(next)
    this.changed({ botId: row.botId, activationId: row.id })
    void this.pump(row.botId).catch((error) => console.warn('next bot activation could not start', { botId: row.botId, error: error instanceof Error ? error.message : String(error) }))
  }

  /**
   * Settles the dispatch of a bot run that reached a terminal state (the run engine's terminal
   * event): whatever path the turn took, no activation is left running after its run ended.
   */
  settleRun(runId: string): void {
    const dispatch = this.store.dispatchByRun(runId)
    if (!dispatch || dispatch.endedAt !== null) return
    this.settle({ kind: 'bot', runId, threadId: dispatch.threadId, activationId: dispatch.activationId, dispatchN: dispatch.n }, {})
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
      unknownCalls: this.store.unknownCalls(row.id)
    }
  }

  /** Stops the active-time timers (profile shutdown). */
  close(): void {
    for (const live of this.live.values()) live.timer?.clear()
    this.live.clear()
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


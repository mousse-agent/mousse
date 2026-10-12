import { EventEmitter } from 'node:events'
import { DaemonEpoch } from './DaemonEpoch'
import { fail, reject, RunStoreError } from './db/RunStoreError'
import { cancelAcknowledgedWakes, recoverWakesOnBoot } from './delegation/wake'
import { Delegations } from './Delegations'
import { EffectOutbox } from './EffectOutbox'
import { HandoffService } from './handoff/HandoffService'
import { ContextTransfers } from './handoff/Transfers'
import { Inbox } from './Inbox'
import { DEFAULT_HEARTBEAT_MS } from './Reconciler'
import type { RestartNote } from './restartNote'
import type { RunStore } from './RunStore'
import { strandedQueuedRuns } from './strandedRuns'
import { writeTerminalRun, type RunTerminalStatus } from './terminal'
import { ThreadMutex } from './ThreadMutex'
import { ToolInvocations } from './ToolInvocations'
import {
  TERMINAL_RUN_STATUSES,
  leaseOwner,
  type AttemptRecord,
  type DelegationRecord,
  type DelegationWake,
  type ModeCeiling,
  type ProviderRef,
  type ReceiptRecord,
  type RunOutcome,
  type RunRecord,
  type RunStatus,
  type ThreadEvent,
  type TransferRecord
} from './types'

export type RunCommand =
  | {
      kind: 'send'
      threadId: string
      clientRequestId: string
      source: string
      userMessageId?: string
      /** SPEC §16.4: the terminal run this send continues; recorded as `outcome.continuationOf`. */
      continuationOfRunId?: string
      /** Required with `continuationOfRunId` when that run is `uncertain`. */
      acknowledgeUncertain?: boolean
    }
  | { kind: 'stop'; threadId: string; clientRequestId: string; runId: string }
  | { kind: 'steer'; threadId: string; clientRequestId: string; runId: string }

export type CommandResult =
  | { status: 'accepted'; runId: string; sequence: number; replayed: boolean }
  | { status: 'rejected'; reason: string; sequence: number; replayed?: boolean }
  | {
      status: 'ignored'
      reason: string
      runId?: string
      activeRunId?: string | null
      sequence: number
      replayed?: boolean
    }

export type { RunTerminalStatus } from './terminal'

export interface BootReport {
  interrupted: string[]
  /** Runs cut off by a crash while a non-idempotent tool was `started` (SPEC §12.5 step 4). */
  uncertain: string[]
  /** The daemon epoch this boot opened. */
  epoch: number
  /** Queued delegated child runs whose `turn.start` died with the daemon; they publish a failure. */
  orphanedChildren: string[]
  /** Queued wake runs whose `turn.start` died; their rows are pending again (rule 4 re-wakes). */
  recoveredWakes: string[]
  /** Queued runs whose `turn.start` died before they began; reconciler rule 5 settles them. */
  strandedQueued: string[]
}

/** A `delegate_task` request (SPEC §14.2), already validated by the tool host. */
export interface DelegationRequest {
  parentThreadId: string
  parentRunId: string
  /** `delegation:<parentRunId>:<toolCallId>`; a retry replays the first receipt. */
  clientRequestId: string
  prompt: string
  provider?: string
  model?: string
  role?: string
  workspace: 'isolated' | 'shared'
  wake: DelegationWake
  title?: string
  /** The most the child may do (SPEC §15.1); the caller has already checked it against its own. */
  modeCeiling?: ModeCeiling
}

export interface DelegationAccepted {
  delegationId: string
  childThreadId: string
  childRunId: string
  replayed: boolean
}

/** `thread.fork` (SPEC §16.2). */
export interface ForkThreadRequest {
  sourceThreadId: string
  /** The source run the fork starts after; the latest forkable run when absent or `latest_stable`. */
  atRunOrdinal?: number | 'latest_stable'
  title?: string
  /** A retry with the same id replays the first result. */
  clientRequestId: string
}

export interface ForkAccepted {
  threadId: string
  transferId: string
  sourceRunId: string
  replayed: boolean
}

/** `thread.merge_back` (SPEC §16.2). */
export interface MergeBackRequest {
  forkThreadId: string
  clientRequestId: string
}

export interface MergeBackAccepted {
  transferId: string
  parentThreadId: string
  replayed: boolean
}

/** A thread the engine asks its host to create: a delegated child or a fork. */
export type ThreadCreation =
  | { kind: 'delegation'; request: DelegationRequest }
  | { kind: 'fork'; sourceThreadId: string; sourceRunId: string; title?: string }

/** Source runs a fork may start after (SPEC §16.2): never `running` or `uncertain`. */
export const FORKABLE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'failed',
  'interrupted',
  'cancelled'
])

/**
 * What the engine needs from the thread owner to create threads and child turns (it does not own
 * thread storage, transcripts or turn payloads). Every callback is synchronous. `createThread`
 * runs before the engine's transaction (thread storage is not the run database); when that
 * transaction fails the engine calls `deleteThread` to remove the orphan.
 */
export interface DelegationHost {
  /**
   * Creates a thread: a delegated child (project and model selection copied from the parent or the
   * request) or a fork (project and model selection copied from the source).
   */
  createThread(input: ThreadCreation): { threadId: string }
  /** Removes a thread `createThread` made whose engine rows never committed. Best effort. */
  deleteThread(threadId: string): void
  /** The `turn.start` payload that runs `prompt` as the child run's turn (inside the transaction). */
  buildChildTurnPayload(input: { childThreadId: string; childRunId: string; prompt: string; request: DelegationRequest }): unknown
  /** The final assistant text `runId` left in its thread's transcript, when it has one. */
  readRunResultText?(runId: string): string | undefined
}

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'starting',
  'running',
  'finalizing'
])

/**
 * Durable command entry point for runs (docs/run-engine/SPEC.md §4-§5).
 *
 * `dispatch` serialises commands per thread, replays receipts, and commits rows, events and the
 * receipt in one transaction. The `mark*` hooks are the Phase 1 bridge for the legacy
 * orchestrator: synchronous CAS writes against the epoch this engine last wrote for the run.
 *
 * Events: `event` (every ThreadEvent appended to the store, including outbox, tool-ledger and
 * reconciler events, after its commit and in `seq` order), `stop-requested` and `steer-accepted`
 * (`{threadId, runId}`, after the accepting commit).
 */
export class RunEngine extends EventEmitter {
  readonly store: RunStore
  private readonly mutex: ThreadMutex
  private readonly now: () => string
  /** Epoch this engine last wrote per non-terminal run; mark hooks CAS against it. */
  private readonly epochs = new Map<string, number>()
  readonly outbox: EffectOutbox
  readonly tools: ToolInvocations
  readonly daemonEpochs: DaemonEpoch
  readonly inbox: Inbox
  readonly delegations: Delegations
  /** Context handoffs (SPEC §16.1). */
  readonly handoffs: HandoffService
  /** Fork and merge-back transfers (SPEC §16.2). */
  readonly transfers: ContextTransfers
  private delegationHost: DelegationHost | null = null
  private readonly pid: number
  /** Liveness interval of runs this engine executes itself (local actions; SPEC §12.4 rule 2). */
  private readonly heartbeatMs: number
  private daemonEpoch: number | null = null

  constructor(opts: {
    store: RunStore
    mutex?: ThreadMutex
    now?: () => string
    outbox?: EffectOutbox
    tools?: ToolInvocations
    /** Process id recorded in `daemon_epochs` and lease owners. Defaults to `process.pid`. */
    pid?: number
    /** The reconciler's heartbeat interval; local actions touch their run twice per interval. */
    heartbeatMs?: number
  }) {
    super()
    this.store = opts.store
    this.mutex = opts.mutex ?? new ThreadMutex()
    this.now = opts.now ?? (() => new Date(opts.store.db.clock()).toISOString())
    this.outbox = opts.outbox ?? new EffectOutbox(opts.store, { now: this.now })
    this.tools = opts.tools ?? new ToolInvocations(opts.store)
    this.daemonEpochs = new DaemonEpoch(opts.store)
    this.inbox = new Inbox(opts.store)
    this.delegations = new Delegations(opts.store, this.inbox)
    this.handoffs = new HandoffService(opts.store)
    this.transfers = new ContextTransfers(opts.store)
    this.pid = opts.pid ?? process.pid
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    opts.store.onEvent((event) => this.emit('event', event))
  }

  /** The epoch opened by `reconcileOnBoot`, or null before boot. */
  get epoch(): number | null {
    return this.daemonEpoch
  }

  /** Effect lease owner for this daemon, `"<epoch>:<pid>"`. Requires `reconcileOnBoot` first. */
  get leaseOwner(): string {
    if (this.daemonEpoch === null) fail('internal', 'Run engine has not booted.')
    return leaseOwner(this.daemonEpoch, this.pid)
  }

  dispatch(command: RunCommand, opts?: { expectedSequence?: number }): Promise<CommandResult> {
    return this.mutex.withLock(command.threadId, () => this.decide(command, opts ?? {}))
  }

  /** queued -> starting. Creates the `initial` attempt when the run has none. */
  markStarting(runId: string): RunRecord {
    return this.mark(runId, true, (run, expectedEpoch) => {
      requireStatus(run, ['queued'])
      const active = this.store.getActiveRun(run.threadId)
      if (active && active.runId !== run.runId)
        fail('conflict', `Thread ${run.threadId} already has active run ${active.runId}.`)
      const attemptId =
        run.activeAttemptId ??
        this.store.createAttempt({ runId: run.runId, reason: 'initial' }).attemptId
      return this.store.casRunStatus({
        runId: run.runId,
        expectedEpoch,
        status: 'starting',
        patch: { startedAt: this.now(), activeAttemptId: attemptId }
      })
    })
  }

  /** starting -> running; the active attempt becomes running. */
  markRunning(runId: string): RunRecord {
    return this.mark(runId, false, (run, expectedEpoch) => {
      requireStatus(run, ['starting'])
      const next = this.store.casRunStatus({ runId: run.runId, expectedEpoch, status: 'running' })
      if (next.activeAttemptId)
        this.store.setAttemptStatus({
          attemptId: next.activeAttemptId,
          status: 'running',
          startedAt: this.now()
        })
      return next
    })
  }

  /** running -> finalizing. */
  markFinalizing(runId: string): RunRecord {
    return this.mark(runId, false, (run, expectedEpoch) => {
      requireStatus(run, ['running'])
      return this.store.casRunStatus({ runId: run.runId, expectedEpoch, status: 'finalizing' })
    })
  }

  /**
   * Any non-terminal status -> terminal. The active attempt mirrors the run status. `resultText`
   * is the run's final assistant text; a delegated child run publishes it (SPEC §14.1).
   */
  markTerminal(
    runId: string,
    status: RunTerminalStatus,
    outcome?: RunOutcome,
    options: { resultText?: string } = {}
  ): RunRecord {
    return this.mark(runId, false, (run, expectedEpoch) =>
      this.writeTerminal(run, expectedEpoch, status, outcome, options.resultText)
    )
  }

  /**
   * Records the provider session reference on the run's active attempt (SPEC §13.1). Not a run
   * status write: the run epoch is checked against the one this engine last wrote, never bumped,
   * and the attempt keeps its status.
   */
  recordProviderRef(runId: string, ref: ProviderRef): AttemptRecord {
    return this.store.db.transaction(() => {
      const run = this.store.getRun(runId)
      if (!run) fail('bad_request', `Unknown run ${runId}.`)
      if (TERMINAL_RUN_STATUSES.has(run.status))
        fail('bad_request', `Run ${runId} is ${run.status}; its attempt is closed.`)
      const expectedEpoch = this.epochs.get(runId) ?? run.epoch
      if (run.epoch !== expectedEpoch)
        fail('stale_write', `Run ${runId} is at epoch ${run.epoch}, not ${expectedEpoch}.`)
      const attempt = run.activeAttemptId ? this.store.getAttempt(run.activeAttemptId) : null
      if (!attempt) fail('bad_request', `Run ${runId} has no active attempt.`)
      return this.store.setAttemptStatus({
        attemptId: attempt.attemptId,
        status: attempt.status,
        providerRef: ref
      })
    })
  }

  /**
   * Boot recovery (SPEC §12.5 steps 1-5), one transaction:
   * 1. open a daemon epoch and learn whether the previous daemon crashed;
   * 2. cancel process-bound effects in `pending|running` (`daemon_restart`);
   * 3. re-queue running replay-safe effects;
   * 4. every active run becomes `uncertain` when the previous daemon crashed while one of the
   *    run's non-idempotent tools was `started`, otherwise `interrupted` by `daemon_restart`;
   * 5. one `restart.note` event per affected thread. Nothing auto-resumes. A note also covers runs
   *    the previous daemon's clean shutdown interrupted (`interruptedBy: 'daemon_restart'`, completed
   *    since that epoch started, not noted yet, no later run started on the thread) and lists
   *    stranded queued runs (`queuedRunIds`, see `strandedQueuedRuns`; reconciler rule 5 restarts or
   *    cancels them). Delegated child runs and wake runs whose `turn.start` died are settled here
   *    (SPEC §14.3: a parent never waits forever): a queued child run is interrupted and publishes
   *    the failure, and a queued wake is cancelled with its rows pending again. Interrupted and
   *    uncertain child runs publish through the terminal write's publication gate.
   * Step 6 (heartbeat and reconciler) belongs to the profile that owns the worker (Phase 2b).
   */
  reconcileOnBoot(): BootReport {
    this.epochs.clear()
    const report = this.store.db.transaction((): BootReport => {
      const now = this.now()
      const { epoch, previous, previousCrashed } = this.daemonEpochs.begin(this.pid, now)
      const active = this.store
        .listNonTerminalRuns()
        .filter((run) => ACTIVE_STATUSES.has(run.status))
      this.outbox.cancelProcessBound('daemon_restart', now)
      this.outbox.requeueRunningReplaySafe(now)
      const interrupted: string[] = []
      const uncertain: string[] = []
      const notes = new Map<string, Omit<RestartNote, 'epoch'>>()
      const noteFor = (threadId: string): Omit<RestartNote, 'epoch'> => {
        const note = notes.get(threadId) ?? { runIds: [], uncertainRunIds: [], cutOffTools: [] }
        notes.set(threadId, note)
        return note
      }
      // Runs the previous daemon's shutdown already interrupted have no active row left to find.
      if (previous) for (const run of this.shutdownInterruptedRuns(previous.startedAt)) noteFor(run.threadId).runIds.push(run.runId)
      for (const run of active) {
        const started = this.tools.listStarted(run.runId)
        const unsafe = previousCrashed ? started.filter((tool) => !tool.idempotent) : []
        if (unsafe.length) {
          const names = [...new Set(unsafe.map((tool) => tool.tool))]
          this.writeTerminal(run, run.epoch, 'uncertain', {
            uncertainReason: 'non_idempotent_tool_in_flight',
            error: `Non-idempotent tools were in flight when the daemon stopped: ${names.join(', ')}.`
          })
          uncertain.push(run.runId)
        } else {
          this.writeTerminal(run, run.epoch, 'interrupted', { interruptedBy: 'daemon_restart' })
          interrupted.push(run.runId)
        }
        const note = noteFor(run.threadId)
        note.runIds.push(run.runId)
        if (unsafe.length) note.uncertainRunIds.push(run.runId)
        for (const tool of started)
          note.cutOffTools.push({
            runId: tool.runId,
            invocationId: tool.invocationId,
            tool: tool.tool,
            idempotent: tool.idempotent
          })
      }
      const orphanedChildren = this.settleOrphanedChildren()
      const recoveredWakes = recoverWakesOnBoot(this.store, this.outbox, now)
      const strandedQueued: string[] = []
      for (const { run } of strandedQueuedRuns(this.store, this.outbox)) {
        const note = noteFor(run.threadId)
        note.queuedRunIds = [...(note.queuedRunIds ?? []), run.runId]
        strandedQueued.push(run.runId)
      }
      for (const [threadId, note] of notes)
        this.store.appendEvent({ threadId, type: 'restart.note', payload: { ...note, epoch } })
      return { interrupted, uncertain, epoch, orphanedChildren, recoveredWakes, strandedQueued }
    })
    this.daemonEpoch = report.epoch
    return report
  }

  /**
   * SPEC §12.5 step 5: the latest `restart.note` of the thread, once. The note is stale when a
   * `restart.note.delivered` or another run's `starting` status follows it. Taking it appends
   * `restart.note.delivered`. `currentRunId` is the run that is starting now; its own `starting`
   * status does not make the note stale.
   */
  takeRestartNote(threadId: string, currentRunId?: string): RestartNote | null {
    return this.store.db.transaction((): RestartNote | null => {
      const note = this.store.db
        .statement(
          `SELECT seq, payload FROM thread_events WHERE thread_id = ? AND type = 'restart.note'
           ORDER BY seq DESC LIMIT 1`
        )
        .get(threadId)
      if (!note) return null
      const seq = Number(note.seq)
      const otherRun = currentRunId === undefined ? '' : 'AND run_id IS NOT ?'
      const superseded = this.store.db
        .statement(
          `SELECT 1 FROM thread_events WHERE thread_id = ? AND seq > ?
             AND (type = 'restart.note.delivered'
               OR (type = 'run.status' AND json_extract(payload, '$.status') = 'starting' ${otherRun}))
           LIMIT 1`
        )
        .get(threadId, seq, ...(currentRunId === undefined ? [] : [currentRunId]))
      if (superseded) return null
      this.store.appendEvent({
        threadId,
        runId: currentRunId ?? null,
        type: 'restart.note.delivered',
        payload: { noteSeq: seq }
      })
      return JSON.parse(String(note.payload)) as RestartNote
    })
  }

  /** The thread owner's callbacks for creating child threads and their turns (SPEC §14). */
  setDelegationHost(host: DelegationHost | null): void {
    this.delegationHost = host
  }

  /**
   * `delegate_task` (SPEC §14.1-§14.2), under the parent thread's mutex: replay the receipt of
   * `clientRequestId`, or create the child thread (host callback, before the transaction) and then,
   * in one transaction, its `subagent` lineage, the child run (`source: 'delegation'`), the `running`
   * delegation row (with the requested workspace and role) and the child's `turn.start` effect. A
   * failed transaction deletes the new thread. A retry with the same `clientRequestId` returns the
   * first result and creates nothing.
   */
  requestDelegation(input: DelegationRequest): Promise<DelegationAccepted> {
    return this.mutex.withLock(input.parentThreadId, () => {
      const host = this.delegationHost
      if (!host) fail('internal', 'No delegation host is attached to the run engine.')
      const replayed = this.replayDelegation(input)
      if (replayed) return replayed
      const parent = this.store.getRun(input.parentRunId)
      if (!parent || parent.threadId !== input.parentThreadId)
        fail('bad_request', `Run ${input.parentRunId} is not a run of thread ${input.parentThreadId}.`)
      if (!input.prompt.trim()) fail('bad_request', 'A delegated task needs a prompt.')
      const { threadId: childThreadId } = host.createThread({ kind: 'delegation', request: input })
      return this.withCreatedThread(host, childThreadId, () =>
        this.store.db.transaction(() => this.commitDelegation(host, input, childThreadId)))
    })
  }

  private replayDelegation(input: DelegationRequest): DelegationAccepted | null {
    const receipt = this.store.getReceipt(input.clientRequestId)
    if (!receipt) return null
    if (receipt.threadId !== input.parentThreadId || receipt.commandKind !== 'delegation.request')
      fail('conflict', `Request ${input.clientRequestId} belongs to another command.`)
    const stored = receipt.result as Omit<DelegationAccepted, 'replayed'>
    return { delegationId: stored.delegationId, childThreadId: stored.childThreadId, childRunId: stored.childRunId, replayed: true }
  }

  /** Runs `commit`; when it throws, the thread created for it is deleted (best effort) and the error rethrown. */
  private withCreatedThread<T>(host: DelegationHost, threadId: string, commit: () => T): T {
    try {
      return commit()
    } catch (error) {
      this.removeThread(host, threadId)
      throw error
    }
  }

  private removeThread(host: DelegationHost, threadId: string): void {
    try {
      host.deleteThread(threadId)
    } catch (error) {
      console.warn('[run-engine] could not delete an orphaned thread', {
        threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private commitDelegation(host: DelegationHost, input: DelegationRequest, childThreadId: string): DelegationAccepted {
    this.delegations.createLineage({
      threadId: childThreadId,
      parentThreadId: input.parentThreadId,
      parentRunId: input.parentRunId,
      relationship: 'subagent'
    })
    const child = this.store.createRun({
      threadId: childThreadId,
      source: 'delegation',
      clientRequestId: `${input.clientRequestId}:child`
    })
    const delegation = this.delegations.create({
      parentRunId: input.parentRunId,
      parentThreadId: input.parentThreadId,
      childThreadId,
      childRunId: child.runId,
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      wake: input.wake,
      modeCeiling: input.modeCeiling,
      workspace: input.workspace,
      role: input.role
    })
    this.outbox.enqueue({
      threadId: childThreadId,
      runId: child.runId,
      kind: 'turn.start',
      payload: host.buildChildTurnPayload({ childThreadId, childRunId: child.runId, prompt: input.prompt, request: input })
    })
    const accepted = { delegationId: delegation.delegationId, childThreadId, childRunId: child.runId }
    this.store.putReceipt({
      clientRequestId: input.clientRequestId,
      threadId: input.parentThreadId,
      commandKind: 'delegation.request',
      status: 'accepted',
      result: { ...accepted, sequence: this.store.maxSeq(input.parentThreadId) },
      createdAt: this.now()
    })
    this.store.db.checkpoint('delegation.beforeCommit')
    return { ...accepted, replayed: false }
  }

  /**
   * A follow-up delegation on an existing child thread (named-agent `recall`): the child run was
   * created by an ordinary send on the child thread; this ties it to the parent run. A child run
   * that already ended publishes at once, with the final text the host reads from its transcript
   * (`readRunResultText`).
   */
  recordDelegation(input: {
    parentThreadId: string
    parentRunId: string
    childThreadId: string
    childRunId: string
    prompt: string
    wake: DelegationWake
    modeCeiling?: ModeCeiling
  }): DelegationRecord {
    return this.store.db.transaction(() => {
      const lineage = this.delegations.getLineage(input.childThreadId)
      if (!lineage || lineage.relationship !== 'subagent' || lineage.parentThreadId !== input.parentThreadId)
        fail('bad_request', `Thread ${input.childThreadId} is not a subagent of ${input.parentThreadId}.`)
      const existing = this.delegations.getByChildRun(input.childRunId)
      if (existing) return existing
      const child = this.store.getRun(input.childRunId)
      if (!child || child.threadId !== input.childThreadId)
        fail('bad_request', `Run ${input.childRunId} is not a run of thread ${input.childThreadId}.`)
      const created = this.delegations.create({ ...input })
      if (!TERMINAL_RUN_STATUSES.has(child.status)) return created
      return this.delegations.publishResult(child, this.runResultText(child.runId)) ?? created
    })
  }

  /** The host's view of a run's final assistant text; a failing read publishes without text. */
  private runResultText(runId: string): string | undefined {
    try {
      return this.delegationHost?.readRunResultText?.(runId)
    } catch (error) {
      console.warn('[run-engine] could not read a run result', {
        runId,
        error: error instanceof Error ? error.message : String(error)
      })
      return undefined
    }
  }

  /** `task_status` read: a published result becomes `acknowledged` with its inbox rows. */
  acknowledgeDelegation(delegationId: string): DelegationRecord {
    return this.store.db.transaction(() => {
      const delegation = this.delegations.get(delegationId)
      if (!delegation) fail('bad_request', `Unknown delegation ${delegationId}.`)
      if (delegation.status !== 'result_available' && delegation.status !== 'failed') return delegation
      const next = this.delegations.setStatus({ delegationId, from: delegation.status, to: 'acknowledged' })
      this.inbox.markAcknowledged(this.inbox.listForDelegation(delegationId).map((row) => row.inboxId))
      cancelAcknowledgedWakes(this.store, this.outbox, this.now(), delegation.parentThreadId)
      return next
    })
  }

  /**
   * `task_cancel` (SPEC §14.2): the delegation becomes `cancelled` (its child can no longer
   * publish), then the child's own delegations are cancelled depth-first, then the child run is
   * stopped (a queued run ends `cancelled`; an active run gets a `stop` command and a
   * `turn.interrupt` effect). Returns every delegation cancelled, deepest first.
   */
  async cancelDelegation(delegationId: string): Promise<string[]> {
    const cancelled: string[] = []
    await this.cancelTree(delegationId, cancelled, new Set())
    return cancelled
  }

  private async cancelTree(delegationId: string, cancelled: string[], seen: Set<string>): Promise<void> {
    if (seen.has(delegationId)) return
    seen.add(delegationId)
    const delegation = this.store.db.transaction(() => {
      const current = this.delegations.get(delegationId)
      if (!current) fail('bad_request', `Unknown delegation ${delegationId}.`)
      if (current.status !== 'running' && current.status !== 'result_available') return null
      return this.delegations.setStatus({
        delegationId,
        from: current.status,
        to: 'cancelled',
        completedAt: current.completedAt ?? this.now()
      })
    })
    if (!delegation) return
    for (const child of this.delegations.listForParentThread(delegation.childThreadId))
      if (child.status === 'running' || child.status === 'result_available')
        await this.cancelTree(child.delegationId, cancelled, seen)
    await this.stopChildRun(delegation)
    cancelled.push(delegationId)
  }

  private hasLiveTurnStart(runId: string): boolean {
    return this.outbox
      .listForRun(runId)
      .some((effect) => effect.kind === 'turn.start' && (effect.status === 'pending' || effect.status === 'running'))
  }

  private async stopChildRun(delegation: DelegationRecord): Promise<void> {
    const run = this.store.getRun(delegation.childRunId)
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return
    if (run.status === 'queued') {
      this.store.db.transaction(() => {
        for (const effect of this.outbox.listForRun(run.runId))
          if (effect.kind === 'turn.start' && effect.status === 'pending')
            this.outbox.cancel(effect.effectId, this.now(), 'delegation_cancelled')
        this.writeTerminal(run, run.epoch, 'cancelled', { interruptedBy: 'user' })
      })
      this.epochs.delete(run.runId)
      return
    }
    const result = await this.dispatch({
      kind: 'stop',
      threadId: run.threadId,
      clientRequestId: `cancel:${delegation.delegationId}:${run.runId}`,
      runId: run.runId
    })
    if (result.status === 'accepted' && !result.replayed)
      this.outbox.enqueue({
        threadId: run.threadId,
        runId: run.runId,
        kind: 'turn.interrupt',
        payload: { runId: run.runId, threadId: run.threadId }
      })
  }

  /**
   * `thread.fork` (SPEC §16.2), under the source thread's mutex: replay the receipt, or resolve the
   * source run (forkable statuses only), create the fork thread (host callback, before the
   * transaction) and then, in one transaction, its `fork` lineage and a `pending` fork transfer. A
   * failed transaction deletes the new thread. Nothing reaches a provider until the fork's first
   * message consumes the transfer.
   */
  forkThread(input: ForkThreadRequest): Promise<ForkAccepted> {
    return this.mutex.withLock(input.sourceThreadId, () => {
      const replayed = this.replayFork(input)
      if (replayed) return replayed
      const host = this.delegationHost
      if (!host) fail('internal', 'No thread host is attached to the run engine.')
      const source = this.forkSourceRun(input.sourceThreadId, input.atRunOrdinal)
      const { threadId } = host.createThread({
        kind: 'fork',
        sourceThreadId: input.sourceThreadId,
        sourceRunId: source.runId,
        title: input.title
      })
      return this.withCreatedThread(host, threadId, () => this.store.db.transaction((): ForkAccepted => {
        this.delegations.createLineage({
          threadId,
          parentThreadId: input.sourceThreadId,
          parentRunId: source.runId,
          relationship: 'fork'
        })
        const transfer = this.transfers.create({
          type: 'fork',
          sourceThreadId: input.sourceThreadId,
          targetThreadId: threadId,
          sourceRunOrdinal: source.ordinal,
          payload: { sourceRunOrdinal: source.ordinal, sourceRunId: source.runId }
        })
        const accepted = { threadId, transferId: transfer.transferId, sourceRunId: source.runId }
        this.store.putReceipt({
          clientRequestId: input.clientRequestId,
          threadId: input.sourceThreadId,
          commandKind: 'thread.fork',
          status: 'accepted',
          result: { ...accepted, sequence: this.store.maxSeq(input.sourceThreadId) },
          createdAt: this.now()
        })
        this.store.db.checkpoint('fork.beforeCommit')
        return { ...accepted, replayed: false }
      }))
    })
  }

  private replayFork(input: ForkThreadRequest): ForkAccepted | null {
    const receipt = this.store.getReceipt(input.clientRequestId)
    if (!receipt) return null
    if (receipt.threadId !== input.sourceThreadId || receipt.commandKind !== 'thread.fork')
      fail('conflict', `Request ${input.clientRequestId} belongs to another command.`)
    const stored = receipt.result as Omit<ForkAccepted, 'replayed'>
    return { threadId: stored.threadId, transferId: stored.transferId, sourceRunId: stored.sourceRunId, replayed: true }
  }

  /**
   * `thread.merge_back` (SPEC §16.2): only into the fork's direct parent and only when the fork's
   * latest run `completed`. Older pending merge-backs of the pair are superseded; the new `pending`
   * transfer covers the fork's runs since the last consumed merge-back. Code is not merged: the
   * payload carries an integration hint for the explicit integration path (§14.4).
   */
  mergeBack(input: MergeBackRequest): Promise<MergeBackAccepted> {
    return this.mutex.withLock(input.forkThreadId, () => this.store.db.transaction((): MergeBackAccepted => {
      const receipt = this.store.getReceipt(input.clientRequestId)
      if (receipt) {
        if (receipt.threadId !== input.forkThreadId || receipt.commandKind !== 'thread.merge_back')
          fail('conflict', `Request ${input.clientRequestId} belongs to another command.`)
        const stored = receipt.result as Omit<MergeBackAccepted, 'replayed'>
        return { transferId: stored.transferId, parentThreadId: stored.parentThreadId, replayed: true }
      }
      const lineage = this.delegations.getLineage(input.forkThreadId)
      if (!lineage || lineage.relationship !== 'fork')
        reject('not_a_fork', `Thread ${input.forkThreadId} is not a fork; merge-back goes into a fork's direct parent only.`)
      const latest = this.store.listRuns(input.forkThreadId, { limit: 1 })[0]
      if (!latest || latest.status !== 'completed')
        reject('fork_not_completed', `The fork's latest run is ${latest?.status ?? 'missing'}; merge-back needs a completed run.`)
      const parentThreadId = lineage.parentThreadId
      const between = this.transfers.listBetween('merge_back', input.forkThreadId, parentThreadId)
      const merged = between
        .filter((transfer) => transfer.status === 'consumed')
        .reduce((max, transfer) => Math.max(max, Number(transfer.payload.toOrdinal ?? 0)), 0)
      if (latest.ordinal <= merged)
        reject('nothing_to_merge', `Runs up to ${merged} of the fork were already merged back.`)
      for (const transfer of between)
        if (transfer.status === 'pending')
          this.transfers.setStatus({ transferId: transfer.transferId, from: 'pending', to: 'superseded' })
      const transfer = this.transfers.create({
        type: 'merge_back',
        sourceThreadId: input.forkThreadId,
        targetThreadId: parentThreadId,
        sourceRunOrdinal: latest.ordinal,
        payload: {
          forkThreadId: input.forkThreadId,
          forkPointRunId: lineage.parentRunId,
          fromOrdinal: merged + 1,
          toOrdinal: latest.ordinal,
          // Code integration stays explicit (SPEC §14.4); nothing here touches the parent's files.
          integration: { kind: 'fork', forkThreadId: input.forkThreadId, through: 'integration_run', merged: false }
        }
      })
      const accepted = { transferId: transfer.transferId, parentThreadId }
      this.store.putReceipt({
        clientRequestId: input.clientRequestId,
        threadId: input.forkThreadId,
        commandKind: 'thread.merge_back',
        status: 'accepted',
        result: { ...accepted, sequence: this.store.maxSeq(input.forkThreadId) },
        createdAt: this.now()
      })
      return { ...accepted, replayed: false }
    }))
  }

  /** The thread's pending `merge_back` transfer, or null (SPEC §16.2: queueing is refused meanwhile). */
  pendingMergeBack(threadId: string): TransferRecord | null {
    return this.transfers.listPending(threadId, 'merge_back').at(-1) ?? null
  }

  /**
   * A local action as a run (SPEC §16.3: `undo` and `revert`): the run is created and marked
   * running, `action` runs while the run heartbeats every half heartbeat interval (it has no effect,
   * so the heartbeat is what keeps reconciler rule 2 away), and the run ends `completed`, or
   * `failed` when it throws (the error is rethrown). Refused while the thread has an active run. A
   * run something else already ended (the reconciler, a stop) keeps that terminal state.
   */
  async runLocalAction<T>(
    input: { threadId: string; source: string; clientRequestId?: string },
    action: (run: RunRecord) => Promise<T>
  ): Promise<{ runId: string; result: T }> {
    const created = await this.mutex.withLock(input.threadId, () => this.store.db.transaction(() => {
      const active = this.store.getActiveRun(input.threadId)
      if (active) reject('thread_busy', `Thread ${input.threadId} has active run ${active.runId}.`)
      return this.store.createRun({ threadId: input.threadId, source: input.source, clientRequestId: input.clientRequestId })
    }))
    this.markStarting(created.runId)
    const running = this.markRunning(created.runId)
    this.touchLocalAction(created.runId)
    const beat = setInterval(() => this.touchLocalAction(created.runId), Math.max(1, Math.floor(this.heartbeatMs / 2)))
    beat.unref?.()
    let result: T
    try {
      result = await action(running)
    } catch (error) {
      clearInterval(beat)
      this.settleLocalAction(created.runId, 'failed', { error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    clearInterval(beat)
    this.settleLocalAction(created.runId, 'completed')
    return { runId: created.runId, result }
  }

  private touchLocalAction(runId: string): void {
    try {
      this.heartbeat(runId)
    } catch (error) {
      console.warn('[run-engine] local action heartbeat failed', {
        runId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** The terminal write of a local action; a run that already ended keeps its stored record. */
  private settleLocalAction(runId: string, status: RunTerminalStatus, outcome?: RunOutcome): RunRecord {
    try {
      return this.markTerminal(runId, status, outcome)
    } catch (error) {
      if (!(error instanceof RunStoreError) || (error.code !== 'stale_write' && error.code !== 'bad_request')) throw error
      console.warn('[run-engine] local action run already ended', { runId, status, error: error.message })
      this.epochs.delete(runId)
      return this.store.getRun(runId)!
    }
  }

  private forkSourceRun(threadId: string, at: ForkThreadRequest['atRunOrdinal']): RunRecord {
    if (typeof at === 'number') {
      const run = this.store.listRuns(threadId).find((entry) => entry.ordinal === at)
      if (!run) reject('run_not_found', `Thread ${threadId} has no run ${at}.`)
      if (!FORKABLE_RUN_STATUSES.has(run.status))
        reject('run_not_forkable', `Run ${at} is ${run.status}; forks start after a completed, failed, interrupted or cancelled run.`)
      return run
    }
    const run = this.store.listRuns(threadId).find((entry) => FORKABLE_RUN_STATUSES.has(entry.status))
    if (!run) reject('no_forkable_run', `Thread ${threadId} has no completed, failed, interrupted or cancelled run to fork.`)
    return run
  }

  /** Liveness touch for an executing run (SPEC §12.4 rule 2). */
  heartbeat(runId: string): boolean {
    return this.store.touchHeartbeat(runId, this.now())
  }

  /** Daemon epoch heartbeat (SPEC §12.5 step 6; the timer is owned by the profile). */
  heartbeatDaemon(): boolean {
    return this.daemonEpoch !== null && this.daemonEpochs.heartbeat(this.daemonEpoch, this.now())
  }

  /** Clean shutdown: closes this daemon's epoch so the next boot does not treat it as a crash. */
  shutdown(): void {
    if (this.daemonEpoch === null) return
    this.daemonEpochs.end(this.daemonEpoch, this.now())
    this.daemonEpoch = null
  }

  getRun(runId: string): RunRecord | null {
    return this.store.getRun(runId)
  }

  getActiveRun(threadId: string): RunRecord | null {
    return this.store.getActiveRun(threadId)
  }

  listRuns(threadId: string, options: { limit?: number } = {}): RunRecord[] {
    return this.store.listRuns(threadId, options)
  }

  listEvents(threadId: string, options: { afterSeq?: number; limit?: number } = {}): ThreadEvent[] {
    return this.store.listEvents(threadId, options)
  }

  maxSeq(threadId: string): number {
    return this.store.maxSeq(threadId)
  }

  private decide(command: RunCommand, opts: { expectedSequence?: number }): CommandResult {
    const { store } = this
    const { threadId, clientRequestId } = command
    const receipt = store.getReceipt(clientRequestId)
    if (receipt) {
      if (receipt.threadId !== threadId)
        return {
          status: 'rejected',
          reason: 'client_request_id_conflict',
          sequence: store.maxSeq(threadId)
        }
      return replay(receipt)
    }
    const seqBefore = store.maxSeq(threadId)
    if (opts.expectedSequence !== undefined && opts.expectedSequence !== seqBefore)
      return { status: 'rejected', reason: 'stale_sequence', sequence: seqBefore }
    let result: CommandResult
    try {
      result = command.kind === 'send' ? this.commitSend(command) : this.commitControl(command)
    } catch (error) {
      if (command.kind === 'stop' && error instanceof RunStoreError && error.code === 'stale_write')
        return { status: 'rejected', reason: 'stale_write', sequence: store.maxSeq(threadId) }
      throw error
    }
    return result
  }

  private commitSend(command: Extract<RunCommand, { kind: 'send' }>): CommandResult {
    const { store } = this
    return store.db.transaction((): CommandResult => {
      const refusal = this.continuationRefusal(command)
      // Not stored: the same `continue:<runId>` request succeeds once the user acknowledges.
      if (refusal) return { status: 'rejected', reason: refusal, sequence: store.maxSeq(command.threadId) }
      const run = store.createRun({
        threadId: command.threadId,
        source: command.source,
        clientRequestId: command.clientRequestId,
        userMessageId: command.userMessageId,
        ...(command.continuationOfRunId ? { outcome: { continuationOf: command.continuationOfRunId } } : {})
      })
      const sequence = store.maxSeq(command.threadId)
      this.putReceipt(command, 'accepted', { runId: run.runId, sequence })
      return { status: 'accepted', runId: run.runId, sequence, replayed: false }
    })
  }

  /** SPEC §16.4: a continuation names an ended run of the same thread; `uncertain` needs acknowledgement. */
  private continuationRefusal(command: Extract<RunCommand, { kind: 'send' }>): string | null {
    if (!command.continuationOfRunId) return null
    const source = this.store.getRun(command.continuationOfRunId)
    if (!source || source.threadId !== command.threadId) return 'continuation_not_found'
    if (!TERMINAL_RUN_STATUSES.has(source.status)) return 'continuation_source_active'
    if (source.status === 'uncertain' && !command.acknowledgeUncertain) return 'uncertain_not_acknowledged'
    return null
  }

  private commitControl(command: Extract<RunCommand, { kind: 'stop' | 'steer' }>): CommandResult {
    const { store } = this
    const { threadId, runId, kind } = command
    return store.db.transaction((): CommandResult => {
      const run = store.getRun(runId)
      const activeRunId = store.getActiveRun(threadId)?.runId ?? null
      if (!run || run.threadId !== threadId || activeRunId !== runId) {
        const reason = 'run_not_active'
        store.appendEvent({
          threadId,
          runId: run?.threadId === threadId ? runId : null,
          type: 'command.ignored',
          payload: { kind, runId, activeRunId, reason }
        })
        const sequence = store.maxSeq(threadId)
        this.putReceipt(command, 'ignored', { runId, activeRunId, reason, sequence })
        return { status: 'ignored', reason, runId, activeRunId, sequence }
      }
      if (kind === 'stop') {
        const next = store.casRunOutcome({
          runId,
          expectedEpoch: run.epoch,
          outcomePatch: { stopRequested: true }
        })
        if (this.epochs.has(runId)) this.epochs.set(runId, next.epoch)
      }
      const sequence = store.maxSeq(threadId)
      this.putReceipt(command, 'accepted', { runId, sequence })
      store.db.afterCommit(() =>
        this.emit(kind === 'stop' ? 'stop-requested' : 'steer-accepted', { threadId, runId })
      )
      return { status: 'accepted', runId, sequence, replayed: false }
    })
  }

  private putReceipt(
    command: RunCommand,
    status: ReceiptRecord['status'],
    result: Record<string, unknown>
  ): void {
    this.store.putReceipt({
      clientRequestId: command.clientRequestId,
      threadId: command.threadId,
      commandKind: command.kind,
      status,
      result,
      createdAt: this.now()
    })
  }

  /**
   * One synchronous CAS write for a bridge hook. `fresh` adopts the stored epoch (the bridge is
   * taking the run over); otherwise the epoch this engine last wrote must still be current.
   */
  private mark(
    runId: string,
    fresh: boolean,
    write: (run: RunRecord, expectedEpoch: number) => RunRecord
  ): RunRecord {
    const run = this.store.getRun(runId)
    if (!run) fail('bad_request', `Unknown run ${runId}.`)
    const expectedEpoch = fresh ? run.epoch : (this.epochs.get(runId) ?? run.epoch)
    if (run.epoch !== expectedEpoch)
      fail('stale_write', `Run ${runId} is at epoch ${run.epoch}, not ${expectedEpoch}.`)
    const next = this.store.db.transaction(() => write(run, expectedEpoch))
    if (TERMINAL_RUN_STATUSES.has(next.status)) this.epochs.delete(runId)
    else this.epochs.set(runId, next.epoch)
    return next
  }

  private writeTerminal(
    run: RunRecord,
    expectedEpoch: number,
    status: RunTerminalStatus,
    outcome?: RunOutcome,
    resultText?: string
  ): RunRecord {
    return writeTerminalRun(this.store, run, expectedEpoch, status, outcome, this.now(), { resultText })
  }

  /**
   * Boot: turns the previous daemon's shutdown interrupted (`interruptedBy: 'daemon_restart'`,
   * started, completed since `since`, the previous epoch's start) that no `restart.note` lists yet
   * and that no later started run on their thread has superseded. A later run still `queued` does
   * not count: it has not seen the note. Runs that never started (a send abandoned at shutdown, a
   * child settled by the previous boot) were not cut off mid-turn.
   */
  private shutdownInterruptedRuns(since: string): RunRecord[] {
    return this.store.listInterruptedByRestartSince(since).filter((run) => {
      if (!run.startedAt) return false
      const noted = this.store.db
        .statement(
          `SELECT 1 FROM thread_events e, json_each(e.payload, '$.runIds') r
           WHERE e.thread_id = ? AND e.type = 'restart.note' AND r.value = ? LIMIT 1`
        )
        .get(run.threadId, run.runId)
      if (noted) return false
      const later = this.store.db
        .statement(`SELECT 1 FROM runs WHERE thread_id = ? AND ordinal > ? AND status <> 'queued' LIMIT 1`)
        .get(run.threadId, run.ordinal)
      return !later
    })
  }

  /**
   * Boot: queued child runs of running delegations whose `turn.start` is gone publish a failure;
   * queued `integration` runs whose effect is gone end `cancelled` (the parent may request again).
   */
  private settleOrphanedChildren(): string[] {
    for (const run of this.store.listNonTerminalRuns())
      if (run.status === 'queued' && run.source === 'integration' && !this.hasLiveTurnStart(run.runId))
        this.writeTerminal(run, run.epoch, 'cancelled', { interruptedBy: 'daemon_restart' })
    const settled: string[] = []
    const rows = this.store.db
      .statement(`SELECT child_run_id FROM delegations WHERE status = 'running' ORDER BY rowid`)
      .all()
    for (const row of rows) {
      const run = this.store.getRun(String(row.child_run_id))
      if (!run || run.status !== 'queued') continue
      if (this.hasLiveTurnStart(run.runId)) continue
      this.writeTerminal(run, run.epoch, 'interrupted', {
        interruptedBy: 'daemon_restart',
        error: 'The daemon stopped before the delegated task started.'
      })
      settled.push(run.runId)
    }
    return settled
  }
}

function requireStatus(run: RunRecord, allowed: RunStatus[]): void {
  if (!allowed.includes(run.status))
    fail('bad_request', `Run ${run.runId} is ${run.status}; expected ${allowed.join(' or ')}.`)
}

function replay(receipt: ReceiptRecord): CommandResult {
  const stored = (receipt.result ?? {}) as {
    runId?: string
    sequence?: number
    reason?: string
    activeRunId?: string | null
  }
  const sequence = stored.sequence ?? 0
  if (receipt.status === 'accepted')
    return { status: 'accepted', runId: stored.runId ?? '', sequence, replayed: true }
  if (receipt.status === 'rejected')
    return { status: 'rejected', reason: stored.reason ?? 'rejected', sequence, replayed: true }
  return {
    status: 'ignored',
    reason: stored.reason ?? 'ignored',
    ...(stored.runId !== undefined ? { runId: stored.runId } : {}),
    ...(stored.activeRunId !== undefined ? { activeRunId: stored.activeRunId } : {}),
    sequence,
    replayed: true
  }
}

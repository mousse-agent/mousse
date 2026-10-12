import { EventEmitter } from 'node:events'
import { DaemonEpoch } from './DaemonEpoch'
import { fail, RunStoreError } from './db/RunStoreError'
import { EffectOutbox } from './EffectOutbox'
import type { RestartNote } from './restartNote'
import type { RunStore } from './RunStore'
import { writeTerminalRun, type RunTerminalStatus } from './terminal'
import { ThreadMutex } from './ThreadMutex'
import { ToolInvocations } from './ToolInvocations'
import {
  TERMINAL_RUN_STATUSES,
  leaseOwner,
  type AttemptRecord,
  type ProviderRef,
  type ReceiptRecord,
  type RunOutcome,
  type RunRecord,
  type RunStatus,
  type ThreadEvent
} from './types'

export type RunCommand =
  | {
      kind: 'send'
      threadId: string
      clientRequestId: string
      source: string
      userMessageId?: string
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
  private readonly pid: number
  private daemonEpoch: number | null = null

  constructor(opts: {
    store: RunStore
    mutex?: ThreadMutex
    now?: () => string
    outbox?: EffectOutbox
    tools?: ToolInvocations
    /** Process id recorded in `daemon_epochs` and lease owners. Defaults to `process.pid`. */
    pid?: number
  }) {
    super()
    this.store = opts.store
    this.mutex = opts.mutex ?? new ThreadMutex()
    this.now = opts.now ?? (() => new Date(opts.store.db.clock()).toISOString())
    this.outbox = opts.outbox ?? new EffectOutbox(opts.store, { now: this.now })
    this.tools = opts.tools ?? new ToolInvocations(opts.store)
    this.daemonEpochs = new DaemonEpoch(opts.store)
    this.pid = opts.pid ?? process.pid
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

  /** Any non-terminal status -> terminal. The active attempt mirrors the run status. */
  markTerminal(runId: string, status: RunTerminalStatus, outcome?: RunOutcome): RunRecord {
    return this.mark(runId, false, (run, expectedEpoch) =>
      this.writeTerminal(run, expectedEpoch, status, outcome)
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
   * 5. one `restart.note` event per affected thread. Nothing auto-resumes; queued runs are untouched.
   * Step 6 (heartbeat and reconciler) belongs to the profile that owns the worker (Phase 2b).
   */
  reconcileOnBoot(): BootReport {
    this.epochs.clear()
    const report = this.store.db.transaction((): BootReport => {
      const now = this.now()
      const { epoch, previousCrashed } = this.daemonEpochs.begin(this.pid, now)
      const active = this.store
        .listNonTerminalRuns()
        .filter((run) => ACTIVE_STATUSES.has(run.status))
      this.outbox.cancelProcessBound('daemon_restart', now)
      this.outbox.requeueRunningReplaySafe(now)
      const interrupted: string[] = []
      const uncertain: string[] = []
      const notes = new Map<
        string,
        {
          runIds: string[]
          uncertainRunIds: string[]
          cutOffTools: Array<{
            runId: string
            invocationId: string
            tool: string
            idempotent: boolean
          }>
        }
      >()
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
        const note = notes.get(run.threadId) ?? { runIds: [], uncertainRunIds: [], cutOffTools: [] }
        note.runIds.push(run.runId)
        if (unsafe.length) note.uncertainRunIds.push(run.runId)
        for (const tool of started)
          note.cutOffTools.push({
            runId: tool.runId,
            invocationId: tool.invocationId,
            tool: tool.tool,
            idempotent: tool.idempotent
          })
        notes.set(run.threadId, note)
      }
      for (const [threadId, note] of notes)
        this.store.appendEvent({ threadId, type: 'restart.note', payload: { ...note, epoch } })
      return { interrupted, uncertain, epoch }
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
    return store.db.transaction(() => {
      const run = store.createRun({
        threadId: command.threadId,
        source: command.source,
        clientRequestId: command.clientRequestId,
        userMessageId: command.userMessageId
      })
      const sequence = store.maxSeq(command.threadId)
      this.putReceipt(command, 'accepted', { runId: run.runId, sequence })
      return { status: 'accepted', runId: run.runId, sequence, replayed: false }
    })
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
    outcome?: RunOutcome
  ): RunRecord {
    return writeTerminalRun(this.store, run, expectedEpoch, status, outcome, this.now())
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

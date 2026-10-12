import { EventEmitter } from 'node:events'
import { fail, RunStoreError } from './db/RunStoreError'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'
import { ThreadMutex } from './ThreadMutex'
import {
  TERMINAL_RUN_STATUSES,
  type AttemptStatus,
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

export type RunTerminalStatus = 'completed' | 'interrupted' | 'failed' | 'cancelled'

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'starting',
  'running',
  'finalizing'
])
const LIVE_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set<AttemptStatus>([
  'pending',
  'running'
])

/**
 * Durable command entry point for runs (docs/run-engine/SPEC.md §4-§5).
 *
 * `dispatch` serialises commands per thread, replays receipts, and commits rows, events and the
 * receipt in one transaction. The `mark*` hooks are the Phase 1 bridge for the legacy
 * orchestrator: synchronous CAS writes against the epoch this engine last wrote for the run.
 *
 * Events: `event` (ThreadEvent, after every commit), `stop-requested` and `steer-accepted`
 * (`{threadId, runId}`, after the accepting commit).
 */
export class RunEngine extends EventEmitter {
  readonly store: RunStore
  private readonly mutex: ThreadMutex
  private readonly now: () => string
  /** Epoch this engine last wrote per non-terminal run; mark hooks CAS against it. */
  private readonly epochs = new Map<string, number>()

  constructor(opts: { store: RunStore; mutex?: ThreadMutex; now?: () => string }) {
    super()
    this.store = opts.store
    this.mutex = opts.mutex ?? new ThreadMutex()
    this.now = opts.now ?? (() => new Date(opts.store.db.clock()).toISOString())
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
   * Phase 1 boot recovery (SPEC §5): the legacy turn loop died with the previous daemon, so every
   * active run becomes `interrupted` by `daemon_restart`. Queued runs are untouched.
   */
  reconcileOnBoot(): { interrupted: string[] } {
    this.epochs.clear()
    const active = this.store.listNonTerminalRuns().filter((run) => ACTIVE_STATUSES.has(run.status))
    if (!active.length) return { interrupted: [] }
    const seqBefore = new Map<string, number>()
    for (const run of active)
      if (!seqBefore.has(run.threadId)) seqBefore.set(run.threadId, this.store.maxSeq(run.threadId))
    this.store.db.transaction(() => {
      for (const run of active)
        this.writeTerminal(run, run.epoch, 'interrupted', { interruptedBy: 'daemon_restart' })
    })
    for (const [threadId, seq] of seqBefore) this.emitEvents(threadId, seq)
    return { interrupted: active.map((run) => run.runId) }
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
    this.emitEvents(threadId, seqBefore)
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
    const seqBefore = this.store.maxSeq(run.threadId)
    const next = this.store.db.transaction(() => write(run, expectedEpoch))
    if (TERMINAL_RUN_STATUSES.has(next.status)) this.epochs.delete(runId)
    else this.epochs.set(runId, next.epoch)
    this.emitEvents(run.threadId, seqBefore)
    return next
  }

  private writeTerminal(
    run: RunRecord,
    expectedEpoch: number,
    status: RunTerminalStatus,
    outcome?: RunOutcome
  ): RunRecord {
    const completedAt = this.now()
    const merged =
      outcome || run.outcome
        ? (JSON.parse(stableStringify({ ...(run.outcome ?? {}), ...(outcome ?? {}) })) as RunOutcome)
        : undefined
    const next = this.store.casRunStatus({
      runId: run.runId,
      expectedEpoch,
      status,
      patch: { completedAt, ...(merged ? { outcome: merged } : {}) }
    })
    const attempt = next.activeAttemptId ? this.store.getAttempt(next.activeAttemptId) : null
    if (attempt && LIVE_ATTEMPT_STATUSES.has(attempt.status))
      this.store.setAttemptStatus({ attemptId: attempt.attemptId, status, completedAt })
    return next
  }

  private emitEvents(threadId: string, afterSeq: number): void {
    for (const event of this.store.listEvents(threadId, { afterSeq })) {
      try {
        this.emit('event', event)
      } catch {
        /* A listener cannot undo a durable commit. */
      }
    }
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

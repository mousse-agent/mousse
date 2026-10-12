import { RunStoreError } from './db/RunStoreError'
import { wakeThreads, type CapabilitiesFor, type WakeReport } from './delegation/wake'
import type { EffectOutbox } from './EffectOutbox'
import type { RunStore } from './RunStore'
import { writeTerminalRun } from './terminal'
import type { ToolInvocations } from './ToolInvocations'
import { TERMINAL_EFFECT_STATUSES, TERMINAL_RUN_STATUSES, type RunRecord } from './types'

export const DEFAULT_HEARTBEAT_MS = 10_000
export const DEFAULT_RECONCILE_INTERVAL_MS = 5_000
/** Rule 3: how long a terminal `turn.interrupt` may leave a stopped run non-terminal. */
export const FORCED_INTERRUPT_AFTER_MS = 10_000

export interface RepairReport {
  /** Rule 1: effects whose expired lease was reclaimed. */
  expiredLeases: string[]
  /** Rule 2: runs interrupted for having no live effect and no heartbeat. */
  staleRuns: string[]
  /** Rule 3: stopped runs forced to `interrupted`. */
  forcedInterrupts: string[]
  /** Rule 4: threads woken (wake runs, steers) for pending inbox rows, and wakes cancelled. */
  wakes: WakeReport
  /** Rule 5 (Phase 2b): queued runs given a `turn.start`. Always empty in Phase 2a. */
  queuedStarts: string[]
  /** Rule 6: `started` tool invocations of terminal runs marked `outcome_unknown`. */
  outcomeUnknownTools: string[]
  /** Phase 5: expired Mousse MCP credentials deleted this pass (absent without a credential store). */
  prunedCredentials?: number
}

type Row = Record<string, unknown>

/**
 * Keeps stored state and reality in agreement (SPEC §12.4). Each rule reads stored state and
 * repairs it through the outbox, the tool ledger or a run CAS on the stored epoch (when nothing
 * else is live the reconciler is the authority). Every repair appends a `reconcile.<rule>`
 * event. The reconciler never calls a provider.
 *
 * Implemented: rules 1, 2, 3, 4 (Phase 4: pending inbox rows wake their thread, see
 * `delegation/wake.ts`) and 6. Rule 5 (queued run without an active run gets a `turn.start`) is a
 * stub here.
 */
export class Reconciler {
  private readonly store: RunStore
  private readonly outbox: EffectOutbox
  private readonly tools: ToolInvocations
  private readonly now: () => string
  private readonly heartbeatMs: number
  private readonly capabilitiesFor: CapabilitiesFor | undefined
  private readonly credentials: { pruneExpired(): number } | undefined
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: {
    store: RunStore
    outbox: EffectOutbox
    tools: ToolInvocations
    now?: () => string
    heartbeatMs?: number
    /** Rule 4: capabilities of the adapter serving a thread (steer delivery for wakes). */
    capabilitiesFor?: CapabilitiesFor
    /** Phase 5: Mousse MCP credentials, pruned once per pass (SPEC §15.1, 24 h idle expiry). */
    credentials?: { pruneExpired(): number }
  }) {
    this.store = options.store
    this.outbox = options.outbox
    this.tools = options.tools
    this.now = options.now ?? (() => new Date(options.store.db.clock()).toISOString())
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.capabilitiesFor = options.capabilitiesFor
    this.credentials = options.credentials
  }

  runOnce(): RepairReport {
    const now = this.now()
    return {
      expiredLeases: this.expiredLeases(now),
      staleRuns: this.staleRuns(now),
      forcedInterrupts: this.forcedInterrupts(now),
      wakes: wakeThreads(this.store, this.outbox, this.capabilitiesFor, now),
      queuedStarts: this.queuedStarts(now),
      outcomeUnknownTools: this.toolsOnTerminalRuns(now),
      ...(this.credentials ? { prunedCredentials: this.credentials.pruneExpired() } : {})
    }
  }

  start(intervalMs = DEFAULT_RECONCILE_INTERVAL_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.runOnce()
      } catch (error) {
        console.warn(
          `[reconciler] pass failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Rule 1: an expired lease on a running effect → pending (or failed when exhausted). */
  private expiredLeases(now: string): string[] {
    return this.store.db.transaction(() => {
      const ids = this.outbox.reclaimExpired(now)
      for (const effectId of ids) {
        const effect = this.outbox.get(effectId)!
        this.store.appendEvent({
          threadId: effect.threadId,
          runId: effect.runId,
          type: 'reconcile.expired_lease',
          payload: { effectId, status: effect.status, attempts: effect.attempts }
        })
      }
      return ids
    })
  }

  /**
   * Rule 2: a `running|finalizing` run with no running effect whose heartbeat (or start) is older
   * than 2× the heartbeat interval → `interrupted` by `provider`, error `no terminal event`.
   */
  private staleRuns(now: string): string[] {
    const cutoff = Date.parse(now) - 2 * this.heartbeatMs
    const repaired: string[] = []
    const candidates = this.store
      .listNonTerminalRuns()
      .filter((run) => run.status === 'running' || run.status === 'finalizing')
    for (const run of candidates) {
      const lastSign = run.heartbeatAt ?? run.startedAt ?? run.requestedAt
      if (Date.parse(lastSign) >= cutoff) continue
      if (this.outbox.listForRun(run.runId).some((effect) => effect.status === 'running')) continue
      const done = this.repairRun(run, 'reconcile.stale_run', { lastHeartbeatAt: lastSign }, () =>
        writeTerminalRun(
          this.store,
          run,
          run.epoch,
          'interrupted',
          { interruptedBy: 'provider', error: 'no terminal event' },
          now
        )
      )
      if (done) repaired.push(run.runId)
    }
    return repaired
  }

  /**
   * Rule 3: a run with `stopRequested` whose latest `turn.interrupt` effect is terminal (or that has
   * none) for more than 10 s while the run is still non-terminal → `interrupted` by `user`.
   */
  private forcedInterrupts(now: string): string[] {
    const repaired: string[] = []
    for (const run of this.store.listNonTerminalRuns()) {
      if (!run.outcome?.stopRequested) continue
      const interrupt = this.outbox
        .listForRun(run.runId)
        .filter((effect) => effect.kind === 'turn.interrupt')
        .at(-1)
      let since: string | null
      if (interrupt) {
        if (!TERMINAL_EFFECT_STATUSES.has(interrupt.status)) continue
        since = interrupt.completedAt ?? interrupt.updatedAt
      } else since = this.stopRequestedAt(run)
      if (!since || Date.parse(now) - Date.parse(since) <= FORCED_INTERRUPT_AFTER_MS) continue
      const done = this.repairRun(
        run,
        'reconcile.forced_interrupt',
        {
          severity: 'warning',
          interruptEffectId: interrupt?.effectId ?? null,
          interruptStatus: interrupt?.status ?? null,
          since
        },
        () =>
          writeTerminalRun(
            this.store,
            run,
            run.epoch,
            'interrupted',
            { interruptedBy: 'user' },
            now
          )
      )
      if (done) repaired.push(run.runId)
    }
    return repaired
  }

  /**
   * Rule 5 stub (Phase 2b): a queued run with no active run on its thread will get a
   * `turn.start` effect here, replacing the legacy drain timer. Phase 2a leaves queued runs to the
   * legacy drain, so this does nothing.
   */
  private queuedStarts(_now: string): string[] {
    return []
  }

  /** Rule 6: `started` tool invocations whose run is terminal → `outcome_unknown`. */
  private toolsOnTerminalRuns(now: string): string[] {
    const terminal = [...TERMINAL_RUN_STATUSES]
    const rows = this.store.db
      .statement(
        `SELECT t.invocation_id, r.thread_id, r.run_id, r.status AS run_status, t.tool
         FROM tool_invocations t JOIN runs r ON r.run_id = t.run_id
         WHERE t.status = 'started' AND r.status IN (${terminal.map(() => '?').join(',')})
         ORDER BY t.rowid`
      )
      .all(...terminal)
    const repaired: string[] = []
    for (const row of rows as Row[]) {
      const invocationId = String(row.invocation_id)
      const marked = this.store.db.transaction(() => {
        const record = this.tools.markOutcomeUnknown(invocationId, now)
        if (!record) return false
        this.store.appendEvent({
          threadId: String(row.thread_id),
          runId: record.runId,
          type: 'reconcile.tool_outcome_unknown',
          payload: { invocationId, tool: record.tool, runStatus: row.run_status }
        })
        return true
      })
      if (marked) repaired.push(invocationId)
    }
    return repaired
  }

  /** When the stop was recorded: the first `run.status` event carrying `stopRequested`. */
  private stopRequestedAt(run: RunRecord): string | null {
    const row = this.store.db
      .statement(
        `SELECT created_at FROM thread_events
         WHERE run_id = ? AND type = 'run.status' AND json_extract(payload, '$.outcome.stopRequested') = 1
         ORDER BY seq LIMIT 1`
      )
      .get(run.runId)
    return typeof row?.created_at === 'string' ? row.created_at : null
  }

  /** One run repair plus its `reconcile.*` event, atomically. A concurrent writer wins. */
  private repairRun(
    run: RunRecord,
    type: string,
    details: Record<string, unknown>,
    write: () => RunRecord
  ): boolean {
    try {
      this.store.db.transaction(() => {
        const next = write()
        this.store.appendEvent({
          threadId: run.threadId,
          runId: run.runId,
          type,
          payload: { ...details, runId: run.runId, fromStatus: run.status, status: next.status }
        })
      })
      return true
    } catch (error) {
      if (
        error instanceof RunStoreError &&
        (error.code === 'stale_write' || error.code === 'bad_request')
      )
        return false
      throw error
    }
  }
}

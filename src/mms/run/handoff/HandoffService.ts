import { randomUUID } from 'node:crypto'
import type { ProviderCapabilities } from '../adapters/ProviderAdapter'
import { int, json, str, type Row } from '../db/rows'
import { fail } from '../db/RunStoreError'
import { stableStringify } from '../json'
import { handoffDelivery, type HandoffDelivery } from '../policy/featureGates'
import type { RunStore } from '../RunStore'
import {
  TERMINAL_RUN_STATUSES,
  runId as makeRunId,
  type HandoffRecord,
  type HandoffStatus,
  type HandoffStrategy,
  type ProviderRef
} from '../types'
import {
  handoffBudget,
  itemTokens,
  recoveryPointer,
  selectHistory,
  type HandoffItem,
  type SelectedHandoffItem
} from './budget'

/** The thread owner's transcript of `threadId` as handoff items, oldest first. */
export type HandoffTranscriptSource = (threadId: string) => HandoffItem[]

export interface HandoffPlanInput {
  /** The thread whose turn receives the handoff. */
  threadId: string
  targetRunId: string
  /** The provider of the previous turn; null when the thread has none. */
  from: ProviderRef | null
  to: ProviderRef
  /** Capabilities of the target adapter (`featureGates.handoffDelivery`). */
  caps: ProviderCapabilities
  /** Thread whose transcript is handed over; `threadId` by default (a fork reads its source). */
  sourceThreadId?: string
  /** Fixed by a transfer: a fork's first message (`full_summary`) or a merge-back (`fork_delta_summary`). */
  strategy?: 'full_summary' | 'fork_delta_summary'
  /** Only runs with an ordinal at most this (the fork point). */
  throughOrdinal?: number
  /** Only runs after this ordinal. */
  afterOrdinal?: number
  /** The message the turn answers; counted against the budget, never cut. */
  current?: Pick<HandoffItem, 'text' | 'attachments'>
  /** Context window of the target model, when known. */
  modelWindow?: number | null
  /** What the target receives besides the handoff (its own transcript, when the handoff is added to it). */
  nativeTokens?: number
  /** `MOUSSE_HANDOFF_TOKEN_CAP` when absent. */
  cap?: number
}

export interface HandoffPlan {
  handoffId: string
  strategy: HandoffStrategy
  delivery: HandoffDelivery
  /** Selected history, oldest first (empty for `native_resume`). */
  history: SelectedHandoffItem[]
  /** Candidate items the budget left out. */
  omittedItems: number
  /** `thread_read` recovery note for the omitted items; empty when nothing was omitted. */
  pointer: string
  /** The thread `pointer` names. */
  sourceThreadId: string
  record: HandoffRecord
}

/**
 * Context handoffs as stored artifacts (docs/run-engine/SPEC.md §16.1). `plan` decides the strategy,
 * selects history within the budget and records a `pending` row; the `turn.start` executor marks it
 * `delivered` when the adapter returns or `failed` when it throws. Every write appends a
 * `handoff.status` event with the full row to the receiving thread.
 */
export class HandoffService {
  private transcript: HandoffTranscriptSource | null = null

  constructor(private readonly store: RunStore) {}

  /** The thread owner's transcript reader (the orchestrator installs it with the engine). */
  setTranscriptSource(source: HandoffTranscriptSource | null): void {
    this.transcript = source
  }

  plan(input: HandoffPlanInput): HandoffPlan {
    return this.db.transaction((): HandoffPlan => {
      const target = this.store.getRun(input.targetRunId)
      if (!target || target.threadId !== input.threadId)
        fail('bad_request', `Run ${input.targetRunId} is not a run of thread ${input.threadId}.`)
      const sourceThreadId = input.sourceThreadId ?? input.threadId
      const { strategy, afterOrdinal } = this.decide(input, target.ordinal)
      const throughOrdinal = input.throughOrdinal ?? (sourceThreadId === input.threadId ? target.ordinal - 1 : undefined)
      const candidates =
        strategy === 'native_resume'
          ? []
          : (this.transcript?.(sourceThreadId) ?? []).filter((item) => {
              if (item.current) return false
              if (item.runOrdinal === null) return afterOrdinal === undefined
              if (afterOrdinal !== undefined && item.runOrdinal <= afterOrdinal) return false
              return throughOrdinal === undefined || item.runOrdinal <= throughOrdinal
            })
      const budget = handoffBudget({
        cap: input.cap,
        modelWindow: input.modelWindow,
        nativeTokens: input.nativeTokens,
        currentTokens: input.current ? itemTokens(input.current) : 0
      })
      const selection = selectHistory(candidates, budget)
      const ordinals = candidates.map((item) => item.runOrdinal).filter((value): value is number => value !== null)
      const record: HandoffRecord = {
        handoffId: `handoff:${randomUUID()}`,
        threadId: input.threadId,
        targetRunId: input.targetRunId,
        fromRef: input.from,
        toRef: input.to,
        strategy,
        coveredFromOrdinal: ordinals.length ? Math.min(...ordinals) : null,
        coveredToOrdinal: ordinals.length ? Math.max(...ordinals) : null,
        budgetTokens: budget,
        selectedItems: selection.selected.length,
        omittedItems: selection.omitted.length,
        status: 'pending',
        createdAt: this.now(),
        deliveredAt: null
      }
      this.db
        .statement(
          `INSERT INTO context_handoffs(handoff_id, thread_id, target_run_id, from_ref, to_ref, strategy,
             covered_from_ordinal, covered_to_ordinal, budget_tokens, selected_items, omitted_items,
             status, created_at, delivered_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.handoffId,
          record.threadId,
          record.targetRunId,
          record.fromRef ? stableStringify(record.fromRef) : null,
          stableStringify(record.toRef),
          record.strategy,
          record.coveredFromOrdinal,
          record.coveredToOrdinal,
          record.budgetTokens,
          record.selectedItems,
          record.omittedItems,
          record.status,
          record.createdAt,
          null
        )
      this.recorded(record)
      return {
        handoffId: record.handoffId,
        strategy,
        delivery: handoffDelivery(input.caps),
        history: selection.selected,
        omittedItems: selection.omitted.length,
        pointer: recoveryPointer(selection.omitted, sourceThreadId),
        sourceThreadId,
        record
      }
    })
  }

  markDelivered(handoffId: string): HandoffRecord {
    return this.settle(handoffId, 'delivered')
  }

  markFailed(handoffId: string, error?: string): HandoffRecord {
    return this.settle(handoffId, 'failed', error)
  }

  get(handoffId: string): HandoffRecord | null {
    const row = this.db.statement('SELECT * FROM context_handoffs WHERE handoff_id = ?').get(handoffId)
    return row ? toHandoff(row) : null
  }

  /** Handoffs received by `threadId`, oldest first. */
  listForThread(threadId: string): HandoffRecord[] {
    return this.db
      .statement('SELECT * FROM context_handoffs WHERE thread_id = ? ORDER BY created_at, rowid')
      .all(threadId)
      .map(toHandoff)
  }

  /**
   * The thread's pending handoff whose turn is still live, or null. A pending row whose target run
   * already ended (the daemon stopped mid-turn) can never be delivered: it is marked `failed` here.
   */
  pendingForThread(threadId: string): HandoffRecord | null {
    return this.db.transaction(() => {
      const pending = this.db
        .statement(`SELECT * FROM context_handoffs WHERE thread_id = ? AND status = 'pending' ORDER BY created_at, rowid`)
        .all(threadId)
        .map(toHandoff)
      let live: HandoffRecord | null = null
      for (const record of pending) {
        const run = this.store.getRun(record.targetRunId)
        if (run && !TERMINAL_RUN_STATUSES.has(run.status)) live ??= record
        else this.settle(record.handoffId, 'failed', 'target_run_ended')
      }
      return live
    })
  }

  /**
   * SPEC §16.1 strategy. A fixed transfer strategy wins; otherwise the same provider with a live
   * native session resumes, a provider that already ran on this thread gets the runs since its last
   * turn, and anything else gets a full summary.
   */
  private decide(input: HandoffPlanInput, targetOrdinal: number): { strategy: HandoffStrategy; afterOrdinal?: number } {
    if (input.strategy === 'fork_delta_summary') return { strategy: input.strategy, afterOrdinal: input.afterOrdinal }
    if (input.strategy === 'full_summary') return { strategy: input.strategy, afterOrdinal: input.afterOrdinal }
    if (input.from && input.from.provider === input.to.provider && input.from.sessionId)
      return { strategy: 'native_resume' }
    for (let ordinal = targetOrdinal - 1; ordinal >= 1; ordinal -= 1) {
      const attempts = this.store.listAttempts(makeRunId(input.threadId, ordinal))
      if (attempts.some((attempt) => attempt.providerRef?.provider === input.to.provider))
        return { strategy: 'delta', afterOrdinal: Math.max(ordinal, input.afterOrdinal ?? 0) }
    }
    return { strategy: 'full_summary', afterOrdinal: input.afterOrdinal }
  }

  private settle(handoffId: string, status: Exclude<HandoffStatus, 'pending'>, error?: string): HandoffRecord {
    return this.db.transaction(() => {
      const current = this.get(handoffId)
      if (!current) fail('bad_request', `Unknown handoff ${handoffId}.`)
      if (current.status !== 'pending') return current
      const next: HandoffRecord = { ...current, status, deliveredAt: status === 'delivered' ? this.now() : null }
      this.db
        .statement(`UPDATE context_handoffs SET status = ?, delivered_at = ? WHERE handoff_id = ? AND status = 'pending'`)
        .run(next.status, next.deliveredAt, handoffId)
      this.recorded(next, error)
      return next
    })
  }

  private recorded(record: HandoffRecord, error?: string): void {
    this.store.appendEvent({
      threadId: record.threadId,
      runId: record.targetRunId,
      type: 'handoff.status',
      payload: error ? { ...record, error } : record
    })
  }

  private get db() {
    return this.store.db
  }

  private now(): string {
    return new Date(this.store.db.clock()).toISOString()
  }
}

function toHandoff(row: Row): HandoffRecord {
  return {
    handoffId: String(row.handoff_id),
    threadId: String(row.thread_id),
    targetRunId: String(row.target_run_id),
    fromRef: json<ProviderRef>(row.from_ref),
    toRef: json<ProviderRef>(row.to_ref)!,

    strategy: row.strategy as HandoffStrategy,
    coveredFromOrdinal: int(row.covered_from_ordinal),
    coveredToOrdinal: int(row.covered_to_ordinal),
    budgetTokens: Number(row.budget_tokens),
    selectedItems: Number(row.selected_items),
    omittedItems: Number(row.omitted_items),
    status: row.status as HandoffStatus,
    createdAt: String(row.created_at),
    deliveredAt: str(row.delivered_at)
  }
}

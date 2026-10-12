import type { ProviderCapabilities } from '../adapters/ProviderAdapter'
import { steerStrategy } from '../CommandPolicy'
import { RunStoreError } from '../db/RunStoreError'
import { Delegations } from '../Delegations'
import { toEffect, type EffectOutbox } from '../EffectOutbox'
import { Inbox } from '../Inbox'
import type { RunStore } from '../RunStore'
import { writeTerminalRun } from '../terminal'
import {
  isWakeTurnPayload,
  type ChildResultPayload,
  type EffectRecord,
  type InboxRecord,
  type WakeTurnPayload
} from '../types'
import { formatWakeNotice } from './notice'

/** Provider capabilities of the adapter that serves a thread's selected model; null when unknown. */
export type CapabilitiesFor = (threadId: string) => ProviderCapabilities | null

export interface WakeReport {
  /** Wake runs created for idle threads. */
  wakes: string[]
  /** `turn.steer` effects that delivered notices to a live native-steer run. */
  steers: string[]
  /** Pending wakes cancelled because every row was acknowledged before they started. */
  cancelled: string[]
}

/** Pending (unclaimed) wake `turn.start` effects, optionally for one thread. */
export function pendingWakeEffects(store: RunStore, threadId?: string): EffectRecord[] {
  const sql = `SELECT * FROM effects WHERE kind = 'turn.start' AND status = 'pending'
     AND json_extract(payload, '$.kind') = 'wake' ${threadId ? 'AND thread_id = ?' : ''} ORDER BY rowid`
  return store.db
    .statement(sql)
    .all(...(threadId ? [threadId] : []))
    .map(toEffect)
}

/**
 * SPEC §14.3: a pending wake whose rows were all acknowledged (`task_status`) before it started is
 * cancelled and its run ends `cancelled`. Each cancellation is one transaction with its
 * `reconcile.wake_cancelled` event.
 */
export function cancelAcknowledgedWakes(
  store: RunStore,
  outbox: EffectOutbox,
  now: string,
  threadId?: string
): string[] {
  const inbox = new Inbox(store)
  const cancelled: string[] = []
  for (const effect of pendingWakeEffects(store, threadId)) {
    const payload = effect.payload as WakeTurnPayload
    const rows = inbox.getMany(payload.inboxIds)
    if (rows.length === 0 || rows.some((row) => row.status !== 'acknowledged')) continue
    try {
      store.db.transaction(() => {
        const settled = outbox.cancel(effect.effectId, now, 'acknowledged_before_wake')
        if (!settled.settled) return
        const run = store.getRun(payload.runId)
        if (run?.status === 'queued')
          writeTerminalRun(store, run, run.epoch, 'cancelled', undefined, now)
        store.appendEvent({
          threadId: effect.threadId,
          runId: payload.runId,
          type: 'reconcile.wake_cancelled',
          payload: { effectId: effect.effectId, runId: payload.runId, inboxIds: payload.inboxIds }
        })
        cancelled.push(payload.runId)
      })
    } catch (error) {
      if (!(error instanceof RunStoreError) || (error.code !== 'stale_write' && error.code !== 'bad_request'))
        throw error
    }
  }
  return cancelled
}

/**
 * Reconciler rule 4 (SPEC §12.4, §14.3). For every thread with `pending` inbox rows:
 * - no active run and no wake already waiting → one `wake` run with a `turn.start` effect for all
 *   of the thread's pending rows, which become `delivered`;
 * - an active run that takes native steer, while every row wants `wake: 'always'` → one
 *   `turn.steer` with the formatted notice, rows `delivered`;
 * - otherwise the rows stay pending and the rule fires again on a later pass.
 * Pending wakes whose rows were all acknowledged first are cancelled.
 */
export function wakeThreads(
  store: RunStore,
  outbox: EffectOutbox,
  capabilitiesFor: CapabilitiesFor | undefined,
  now: string
): WakeReport {
  const inbox = new Inbox(store)
  const delegations = new Delegations(store, inbox)
  const report: WakeReport = { wakes: [], steers: [], cancelled: cancelAcknowledgedWakes(store, outbox, now) }
  for (const threadId of inbox.listThreadsWithPending()) {
    try {
      store.db.transaction(() => {
        const rows = inbox.listPending(threadId)
        if (rows.length === 0) return
        const active = store.getActiveRun(threadId)
        if (!active) {
          if (pendingWakeEffects(store, threadId).length) return
          const run = store.createRun({ threadId, source: 'wake', clientRequestId: `wake:${rows[0].inboxId}` })
          const payload: WakeTurnPayload = {
            kind: 'wake',
            threadId,
            runId: run.runId,
            inboxIds: rows.map((row) => row.inboxId)
          }
          outbox.enqueue({ threadId, runId: run.runId, kind: 'turn.start', payload })
          inbox.markDelivered(payload.inboxIds)
          store.appendEvent({ threadId, runId: run.runId, type: 'reconcile.wake', payload })
          report.wakes.push(run.runId)
          return
        }
        const caps = capabilitiesFor?.(threadId) ?? null
        if (!caps || steerStrategy(caps, active) !== 'native') return
        if (!rows.every((row) => wantsSteer(row, delegations))) return
        const text = formatWakeNotice(rows)
        const effect = outbox.enqueue({
          threadId,
          runId: active.runId,
          kind: 'turn.steer',
          payload: { runId: active.runId, threadId, text, inboxIds: rows.map((row) => row.inboxId) }
        })
        inbox.markDelivered(rows.map((row) => row.inboxId))
        store.appendEvent({
          threadId,
          runId: active.runId,
          type: 'reconcile.wake_steer',
          payload: { effectId: effect.effectId, inboxIds: rows.map((row) => row.inboxId) }
        })
        report.steers.push(effect.effectId)
      })
    } catch (error) {
      if (!(error instanceof RunStoreError) || (error.code !== 'stale_write' && error.code !== 'conflict'))
        throw error
    }
  }
  return report
}

/** Rows without a delegation (notices) always steer; a child result follows its delegation. */
function wantsSteer(row: InboxRecord, delegations: Delegations): boolean {
  if (row.kind !== 'child_result') return true
  const delegation = delegations.get((row.payload as ChildResultPayload).delegationId)
  return delegation?.wake === 'always'
}

/**
 * Boot recovery for wakes (SPEC §14.3, "a parent never waits forever"): a queued wake run whose
 * `turn.start` died with the previous daemon is cancelled and its delivered rows become pending
 * again, so rule 4 wakes the thread after boot. Joins the caller's transaction.
 */
export function recoverWakesOnBoot(store: RunStore, outbox: EffectOutbox, now: string): string[] {
  const inbox = new Inbox(store)
  const recovered: string[] = []
  const queuedWakes = store
    .listNonTerminalRuns()
    .filter((run) => run.status === 'queued' && run.source === 'wake')
  for (const run of queuedWakes) {
    const effects = outbox.listForRun(run.runId).filter((effect) => effect.kind === 'turn.start')
    if (effects.some((effect) => effect.status === 'pending' || effect.status === 'running')) continue
    writeTerminalRun(store, run, run.epoch, 'cancelled', { interruptedBy: 'daemon_restart' }, now)
    const ids = effects.flatMap((effect) => (isWakeTurnPayload(effect.payload) ? effect.payload.inboxIds : []))
    inbox.markPendingAgain(ids)
    recovered.push(run.runId)
  }
  return recovered
}

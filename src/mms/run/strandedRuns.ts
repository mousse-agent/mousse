import type { EffectOutbox } from './EffectOutbox'
import type { RunStore } from './RunStore'
import { isSendTurnPayload, type RunRecord, type SendTurnPayload } from './types'

/** A queued run whose `turn.start` died before the turn began (reconciler rule 5). */
export interface StrandedQueuedRun {
  run: RunRecord
  /** The id of the dead `turn.start` effect. */
  effectId: string
  /** The send its effect carried, to start the run again; null when there is none to recover. */
  payload: SendTurnPayload | null
}

/**
 * Queued runs that nothing will start (SPEC §12.4 rule 5, §12.5): the run is `queued`, its thread
 * has no active run, it has no `pending|running` `turn.start`, and its latest `turn.start` was
 * `cancelled` (boot cancels process-bound effects). A run that never had a `turn.start` is not
 * stranded: it waits on the message queue, or its send has not recorded the effect yet.
 *
 * Left to their owners: a queue item's send (`queueItemId`, re-drained by the message queue's own
 * recovery) and payloads of another kind (`wake`, `integration`: boot recovery settles those).
 */
export function strandedQueuedRuns(store: RunStore, outbox: EffectOutbox): StrandedQueuedRun[] {
  const stranded: StrandedQueuedRun[] = []
  const busyThreads = new Map<string, boolean>()
  for (const run of store.listNonTerminalRuns()) {
    if (run.status !== 'queued') continue
    const starts = outbox.listForRun(run.runId).filter((effect) => effect.kind === 'turn.start')
    const latest = starts.at(-1)
    if (!latest || latest.status !== 'cancelled') continue
    if (starts.some((effect) => effect.status === 'pending' || effect.status === 'running')) continue
    let busy = busyThreads.get(run.threadId)
    if (busy === undefined) {
      busy = store.getActiveRun(run.threadId) !== null
      busyThreads.set(run.threadId, busy)
    }
    if (busy) continue
    const payload = latest.payload
    if (isSendTurnPayload(payload)) {
      if (payload.queueItemId !== undefined) continue
      stranded.push({ run, effectId: latest.effectId, payload })
      continue
    }
    if (payload && typeof payload === 'object' && typeof (payload as { kind?: unknown }).kind === 'string') continue
    stranded.push({ run, effectId: latest.effectId, payload: null })
  }
  return stranded
}

import type { QueuedMessage } from '../../../shared/types'
import { TERMINAL_RUN_STATUSES, type RunRecord } from '../types'

/**
 * How a watch learns where the message it follows is now, on this computer: the target thread's runs and queue. A
 * follower for a thread on another computer answers the same questions from there.
 */
export interface WatchTarget {
  getRun(runId: string): RunRecord | null
  /** The run that continues `runId` after a usage-limit pause (`outcome.continuationOf`). */
  continuationOf(threadId: string, runId: string): RunRecord | undefined
  /** The newest run the queue made for item `itemId` (client request `queue:<itemId>`). */
  queueRun(threadId: string, itemId: string): RunRecord | undefined
  /** The id of the queue item that carries run `runId`, while it waits in the thread's queue. */
  queueItemForRun(threadId: string, runId: string): string | undefined
  /** The queue item `itemId` while it is still in the thread's queue. */
  queueItem(threadId: string, itemId: string): QueuedMessage | undefined
  activeRun(threadId: string): RunRecord | null
}

/** Where the message is: in a run that has not ended, waiting in the queue for its run, or done. */
export type Followed =
  | { kind: 'live'; runId: string }
  | { kind: 'awaiting'; runId: string | null }
  | { kind: 'ended'; runId: string | null; status: string }

/** Hand-offs one resolve follows at most; a chain longer than this is read again on the next event. */
const MAX_HOPS = 32

/**
 * Follows a message from the run it was last seen in (SPEC §15.1, "keyed on the message"):
 * - a run a usage-limit pause handed over goes on in the run that continues it;
 * - a queued message keeps its queue item through a person's edit (its run is cancelled and it gets a fresh one,
 *   `queue:<itemId>`, when it drains), a promotion to a steer (it joins the run it steers, or goes back to the queue and
 *   runs as its own turn when that run ends before reading it);
 * - a queued message that left the queue before it ran (removed, cleared by a Stop) ended as `removed`.
 */
export function followMessage(target: WatchTarget, threadId: string, runId: string | null, queueItemId: string | null): Followed {
  let current = runId
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const run = current ? target.getRun(current) : null
    if (run && !TERMINAL_RUN_STATUSES.has(run.status)) return { kind: 'live', runId: run.runId }
    if (run) {
      const endedBy = run.outcome?.pause?.endedBy
      if (endedBy === 'resume' || endedBy === 'resume_now') {
        const next = target.continuationOf(threadId, run.runId)
        if (next) {
          current = next.runId
          continue
        }
      }
    }
    if (queueItemId) {
      // A run the queue made for the item after this one carries the message now.
      const later = target.queueRun(threadId, queueItemId)
      if (later && (!run || later.ordinal > run.ordinal)) {
        current = later.runId
        continue
      }
      const item = target.queueItem(threadId, queueItemId)
      if (item && item.state !== 'claimed') {
        // A steer joins the run it was promoted into (the active run, for one promoted before runs were bound).
        const steered = item.state === 'steering' ? item.steerRunId ?? target.activeRun(threadId)?.runId : undefined
        const next = steered ?? item.runId
        if (next && next !== current && !TERMINAL_RUN_STATUSES.has(target.getRun(next)?.status ?? 'cancelled')) {
          current = next
          continue
        }
        return { kind: 'awaiting', runId: current }
      }
      // Cancelled with its item gone: the message left the queue before any run read it.
      if (!run || run.status === 'cancelled') return { kind: 'ended', runId: current, status: 'removed' }
    }
    if (!run) return { kind: 'ended', runId: current, status: 'removed' }
    return { kind: 'ended', runId: run.runId, status: run.status }
  }
  return { kind: 'awaiting', runId: current }
}

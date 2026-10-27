/**
 * Durable queue transactions protected by the per-thread mutation lock.
 * Prevents cross-process lost updates on queue.json RMW.
 */

import type { QueuedMessage, QueuedMessageClaim } from '../../shared/types'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { isProcessAlive } from './processLiveness'
import {
  claimNextNormal,
  completeClaim,
  normalizeQueuedMessages,
  reclaimAbandonedClaims,
  releaseClaim,
  type ClaimOwnerInput
} from './ThreadMessageQueue'
import { withQueueMutationLock } from './ThreadExecutionLease'
import { recoverQueueJournal, runQueueCommand, type PlannedQueueCommand, type QueueCommandOutcome } from './queueJournal'

/**
 * One change to a thread's durable queue under its mutation lock. Agent commands the journal holds unfinished
 * (a crash after their entry was written) are finished first, so every reader and writer of the queue meets it in
 * the state those commands left it in.
 */
export function mutateDurableQueue(
  store: ThreadDataStore,
  threadId: string,
  mutator: (items: QueuedMessage[]) => QueuedMessage[],
  options?: {
    /**
     * Runs after the queue was saved and before the queue lock is released: what must happen only once
     * the saved queue is on disk (marking inbox rows as owned by an item that just became durable) and
     * before any drain can claim the item. If it throws the save stays; the caller repeats the step.
     */
    afterSave?: (saved: QueuedMessage[]) => void
  }
): QueuedMessage[] {
  const threadDir = store.getThreadDir(threadId)
  return withQueueMutationLock(threadDir, () => {
    const current = recoverQueueJournal(store, threadId, store.loadMessageQueue(threadId))
    const next = normalizeQueuedMessages(mutator(current), threadId)
    store.saveMessageQueue(threadId, next)
    options?.afterSave?.(next)
    return next
  })
}

/** Finishes the thread's unfinished agent commands now (boot, the retry of a failed effect, a read that wants the settled queue). */
export function repairQueueJournal(store: ThreadDataStore, threadId: string): QueuedMessage[] {
  return mutateDurableQueue(store, threadId, (items) => items)
}

/** An agent command on a thread's queue, journaled and replayable by `commandKey` (see `queueJournal.ts`). */
export function runDurableQueueCommand(
  store: ThreadDataStore,
  threadId: string,
  commandKey: string,
  plan: (items: QueuedMessage[], ctx: { activeRunId: string | null }) => PlannedQueueCommand
): QueueCommandOutcome {
  const threadDir = store.getThreadDir(threadId)
  return withQueueMutationLock(threadDir, () => runQueueCommand(store, threadId, commandKey, store.loadMessageQueue(threadId), plan))
}

export function readDurableQueue(store: ThreadDataStore, threadId: string): QueuedMessage[] {
  const threadDir = store.getThreadDir(threadId)
  return withQueueMutationLock(threadDir, () => store.loadMessageQueue(threadId))
}

/** Atomically claim the next normal pending item under the queue mutation lock. */
export function claimNextNormalDurable(
  store: ThreadDataStore,
  threadId: string,
  owner: ClaimOwnerInput
): QueuedMessage | null {
  let claimed: QueuedMessage | null = null
  mutateDurableQueue(store, threadId, (items) => {
    const result = claimNextNormal(items, owner)
    claimed = result.claimed
    return result.items
  })
  return claimed
}

/** Acknowledge a claim after durable transcript acceptance — removes the item. */
export function completeClaimDurable(
  store: ThreadDataStore,
  threadId: string,
  itemId: string,
  opts?: { ownerToken?: string }
): QueuedMessage | null {
  let completed: QueuedMessage | null = null
  mutateDurableQueue(store, threadId, (items) => {
    const result = completeClaim(items, itemId, opts)
    completed = result.completed
    return result.items
  })
  return completed
}

/** Release a claim back to pending at its original order. */
export function releaseClaimDurable(
  store: ThreadDataStore,
  threadId: string,
  itemId: string,
  opts?: { ownerToken?: string }
): QueuedMessage | null {
  let released: QueuedMessage | null = null
  mutateDurableQueue(store, threadId, (items) => {
    const result = releaseClaim(items, itemId, opts)
    released = result.released
    return result.items
  })
  return released
}

export interface ReclaimAbandonedResult {
  items: QueuedMessage[]
  released: QueuedMessage[]
  completed: QueuedMessage[]
}

/**
 * Reclaim claims for a thread.
 * Accepted claims (transcript provenance) complete even while the owner is live.
 * Unaccepted claims of live owners are never disturbed.
 *
 * Default provenance is loaded **inside** the queue mutation critical section via
 * `loadThreadData` (does not take the queue lock). Transcript read errors propagate
 * so the transaction aborts without saving — never treat an unreadable transcript as
 * "no accepted ids" (that could release an accepted dead-owner claim).
 */
export function reclaimAbandonedClaimsDurable(
  store: ThreadDataStore,
  threadId: string,
  options?: {
    isOwnerLive?: (claim: QueuedMessageClaim) => boolean
    /**
     * Optional override. When omitted, accepted ids are loaded inside the mutation
     * lock. Prefer the default so provenance cannot go stale across the lock boundary.
     */
    isAccepted?: (item: QueuedMessage) => boolean
  }
): ReclaimAbandonedResult {
  const isOwnerLive =
    options?.isOwnerLive ??
    ((claim: QueuedMessageClaim) => isProcessAlive(claim.ownerPid))

  let result: ReclaimAbandonedResult = { items: [], released: [], completed: [] }
  mutateDurableQueue(store, threadId, (items) => {
    let isAccepted = options?.isAccepted
    if (!isAccepted) {
      // Fail closed: loadThreadData errors abort the mutator before saveMessageQueue.
      const data = store.loadThreadData(threadId)
      const transcriptIds = new Set(
        data.messages
          .filter((message) => typeof message.queueItemId === 'string')
          .map((message) => message.queueItemId as string)
      )
      const nativeIds = new Set(data.llmContext?.acceptedQueueItemIds ?? [])
      const ambiguous = items.find((item) => transcriptIds.has(item.id) !== nativeIds.has(item.id))
      if (ambiguous) throw new Error(`QUEUE_PROVENANCE_UNAVAILABLE:${ambiguous.id}`)
      const acceptedIds = new Set(
        data.messages
          .filter((message) =>
            typeof message.queueItemId === 'string' && nativeIds.has(message.queueItemId)
          )
          .map((message) => message.queueItemId as string)
      )
      isAccepted = (item) => acceptedIds.has(item.id)
    }
    result = reclaimAbandonedClaims(items, { isOwnerLive, isAccepted })
    return result.items
  })
  return result
}

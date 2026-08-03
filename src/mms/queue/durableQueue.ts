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

export function mutateDurableQueue(
  store: ThreadDataStore,
  threadId: string,
  mutator: (items: QueuedMessage[]) => QueuedMessage[]
): QueuedMessage[] {
  const threadDir = store.getThreadDir(threadId)
  return withQueueMutationLock(threadDir, () => {
    const current = store.loadMessageQueue(threadId)
    const next = normalizeQueuedMessages(mutator(current), threadId)
    store.saveMessageQueue(threadId, next)
    return next
  })
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
      const acceptedIds = new Set(
        data.messages
          .filter((message) => typeof message.queueItemId === 'string')
          .map((message) => message.queueItemId as string)
      )
      isAccepted = (item) => acceptedIds.has(item.id)
    }
    result = reclaimAbandonedClaims(items, { isOwnerLive, isAccepted })
    return result.items
  })
  return result
}

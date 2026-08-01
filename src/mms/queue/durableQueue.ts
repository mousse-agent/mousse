/**
 * Durable queue transactions protected by the per-thread mutation lock.
 * Prevents cross-process lost updates on queue.json RMW.
 */

import type { QueuedMessage } from '../../shared/types'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { normalizeQueuedMessages } from './ThreadMessageQueue'
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { QueuedMessage } from '../../shared/types'
import { readableError } from '../lib/errorText'

/** Waits before the first tries of a queue load that failed; after these it tries every `QUEUE_LOAD_RETRY_CAP_MS`. */
export const QUEUE_LOAD_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000]
export const QUEUE_LOAD_RETRY_CAP_MS = 5000

export interface UseThreadQueueOptions {
  threadId: string | null
  /** Messages just sent while a reply runs, shown until the daemon lists them. */
  optimisticItems?: QueuedMessage[]
  onOptimisticItemReconciled?: (id: string) => void
  /** A compaction holds the queue until it ends; null when nothing does. */
  hold?: QueueHold | null
}

/** What holds the queue: a running compaction, and the size of the history it would replace. */
export interface QueueHold {
  historyTokens?: number
}

/** The open thread's queued messages and what can be done with them. */
export interface ThreadQueue {
  threadId: string | null
  /** In send order: the daemon's list, then the optimistic items it does not list yet. Never internal items. */
  items: QueuedMessage[]
  /** Items with a change in flight. */
  busyIds: Readonly<Record<string, boolean>>
  /** The last failed change, for the composer's notice line; it stays until dismissed or a change succeeds. */
  error: string | null
  clearError: () => void
  /** While a compaction runs, the queue waits for it; Send now then skips the compaction. */
  hold: QueueHold | null
  /** Sends the item into the running reply now; while a compaction holds the queue, stops it and sends the item first. */
  steer: (itemId: string) => Promise<void>
  remove: (itemId: string) => Promise<void>
  /** Saves a new order; shown at once, put back when the save fails. */
  reorder: (orderedIds: string[]) => Promise<void>
  /** Replaces the item's text in place; resolves whether it was saved. */
  edit: (itemId: string, content: string) => Promise<boolean>
}

export const isOptimisticQueueItem = (item: QueuedMessage): boolean => item.id.startsWith('optimistic:')

export function reorderByIds(items: QueuedMessage[], orderedIds: string[]): QueuedMessage[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const next: QueuedMessage[] = []
  for (const id of orderedIds) {
    const item = byId.get(id)
    if (item) next.push(item)
  }
  // Append any missing ids (race with remote updates) in prior order.
  for (const item of items) {
    if (!orderedIds.includes(item.id)) next.push(item)
  }
  return next
}

/**
 * Loads the thread's queue, keeps it in step with `queue:updated`, and wraps the queue's changes
 * (send now, remove, reorder, edit) with busy marks and error text.
 */
export function useThreadQueue({ threadId, optimisticItems = [], onOptimisticItemReconciled, hold = null }: UseThreadQueueOptions): ThreadQueue {
  const [items, setItems] = useState<QueuedMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({})
  const itemsRef = useRef(items)
  itemsRef.current = items

  const threadIdRef = useRef(threadId)
  threadIdRef.current = threadId
  // Bumped by every load, every queue update, and when the thread changes or the component unmounts,
  // so a load that finishes or wakes late changes nothing and stops retrying.
  const loadGeneration = useRef(0)
  const retryTimer = useRef<number | null>(null)
  const loggedLoadFailure = useRef(false)
  // Bumped when the thread changes or the component unmounts, so a change that answers later (send now,
  // remove, reorder, edit) changes nothing in the thread shown now.
  const threadSession = useRef(0)
  /** Whether a change started now for `id` still belongs to the thread shown when it answers. */
  const changeScope = useCallback((id: string) => {
    const session = threadSession.current
    return () => threadSession.current === session && threadIdRef.current === id
  }, [])

  // A failed load is never shown: the last list stays, and the load keeps retrying quietly with
  // backoff until it succeeds or is superseded. Only the first failure of a streak is logged.
  const loadQueue = useCallback(async (id: string) => {
    // A load for a thread no longer shown must not supersede the shown thread's load.
    if (threadIdRef.current !== id) return
    const generation = ++loadGeneration.current
    const current = () => loadGeneration.current === generation && threadIdRef.current === id
    for (let attempt = 0; ; attempt += 1) {
      try {
        const list = await window.mousse.queue.list(id)
        if (!current()) return
        loggedLoadFailure.current = false
        setItems(list)
        return
      } catch (err) {
        if (!current()) return
        if (!loggedLoadFailure.current) {
          loggedLoadFailure.current = true
          console.warn('Loading the queued messages failed; retrying in the background.', err)
        }
        const delay = QUEUE_LOAD_RETRY_DELAYS_MS[attempt] ?? QUEUE_LOAD_RETRY_CAP_MS
        await new Promise<void>((resolve) => {
          retryTimer.current = window.setTimeout(resolve, delay)
        })
        if (!current()) return
      }
    }
  }, [])

  useEffect(() => {
    setItems([])
    setError(null)
    setBusyIds({})
    if (!threadId) return
    // Prefer the select snapshot's queue:updated so we don't race thread.snapshot with queue.list.
    let settled = false
    const unsub = window.mousse.queue.onUpdated(({ threadId: updatedId, items: next }) => {
      if (updatedId !== threadId) return
      settled = true
      loadGeneration.current += 1
      setItems(next)
    })
    const fallback = window.setTimeout(() => {
      if (!settled) void loadQueue(threadId)
    }, 120)
    return () => {
      unsub()
      window.clearTimeout(fallback)
      // Stops a load that is retrying for this thread, and makes its changes still in flight change nothing.
      loadGeneration.current += 1
      threadSession.current += 1
      loggedLoadFailure.current = false
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
  }, [threadId, loadQueue])

  useEffect(() => {
    if (!onOptimisticItemReconciled) return
    for (const optimistic of optimisticItems) {
      if (items.some((item) => item.id === optimistic.id)) onOptimisticItemReconciled(optimistic.id)
    }
  }, [items, optimisticItems, onOptimisticItemReconciled])

  const markBusy = useCallback((itemId: string, busy: boolean) => {
    setBusyIds((current) => {
      const next = { ...current }
      if (busy) next[itemId] = true
      else delete next[itemId]
      return next
    })
  }, [])

  // Every change below checks, once it answers, that its thread is still the one shown (`changeScope`):
  // the answer of a thread left behind neither shows nor reloads anything here.
  const reorder = useCallback(async (orderedIds: string[]) => {
    if (!threadId) return
    const live = changeScope(threadId)
    const previous = itemsRef.current
    setItems(reorderByIds(previous, orderedIds))
    try {
      const next = await window.mousse.queue.reorder(threadId, orderedIds)
      if (!live()) return
      setItems(next)
      setError(null)
    } catch (err) {
      if (!live()) return
      setItems(previous)
      setError(readableError(err, 'Could not reorder the queue.'))
      void loadQueue(threadId)
    }
  }, [threadId, loadQueue, changeScope])

  const remove = useCallback(async (itemId: string) => {
    if (!threadId) return
    const live = changeScope(threadId)
    markBusy(itemId, true)
    try {
      await window.mousse.queue.remove(threadId, itemId)
      if (!live()) return
      setError(null)
    } catch (err) {
      if (!live()) return
      setError(readableError(err, 'Could not remove the queued message.'))
      void loadQueue(threadId)
    } finally {
      if (live()) markBusy(itemId, false)
    }
  }, [threadId, loadQueue, markBusy, changeScope])

  const steer = useCallback(async (itemId: string) => {
    if (!threadId) return
    const live = changeScope(threadId)
    const refused = 'Could not send it now; the reply may have ended. The message is still queued.'
    markBusy(itemId, true)
    setError(null)
    try {
      const ok = await window.mousse.queue.promoteToSteer(threadId, itemId)
      if (!live()) return
      if (!ok) {
        setError(refused)
        void loadQueue(threadId)
      }
    } catch (err) {
      if (!live()) return
      setError(readableError(err, refused))
      void loadQueue(threadId)
    } finally {
      if (live()) markBusy(itemId, false)
    }
  }, [threadId, loadQueue, markBusy, changeScope])

  const edit = useCallback(async (itemId: string, content: string) => {
    if (!threadId) return false
    const live = changeScope(threadId)
    const previous = itemsRef.current
    markBusy(itemId, true)
    setItems(previous.map((item) => (item.id === itemId ? { ...item, content } : item)))
    try {
      const saved = await window.mousse.queue.edit(threadId, itemId, content)
      if (!live()) return false
      setItems((current) => current.map((item) => (item.id === saved.id ? saved : item)))
      setError(null)
      return true
    } catch (err) {
      if (!live()) return false
      setItems(previous)
      setError(readableError(err, 'Could not edit the queued message.'))
      void loadQueue(threadId)
      return false
    } finally {
      if (live()) markBusy(itemId, false)
    }
  }, [threadId, loadQueue, markBusy, changeScope])

  const clearError = useCallback(() => setError(null), [])

  const shown = useMemo(() => [
    ...items,
    ...optimisticItems.filter((optimistic) => optimistic.threadId === threadId && !items.some((item) => item.id === optimistic.id))
  ].filter((item) => !item.internal), [items, optimisticItems, threadId])

  return useMemo(
    () => ({ threadId, items: shown, busyIds, error, clearError, hold, steer, remove, reorder, edit }),
    [threadId, shown, busyIds, error, clearError, hold, steer, remove, reorder, edit]
  )
}

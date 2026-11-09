import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatImageAttachment, QueuedMessage } from '../../shared/types'
import { readableError } from '../lib/errorText'
import { canEditQueued, isOptimisticQueueItem, splitQueuedContent, type QueueEditDraft } from '../lib/queuedContent'
import { useAppStore } from '../stores/appStore'

export { isOptimisticQueueItem }
export type { QueueEditDraft }

/** Waits before the first tries of a queue load that failed; after these it tries every `QUEUE_LOAD_RETRY_CAP_MS`. */
export const QUEUE_LOAD_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000]
export const QUEUE_LOAD_RETRY_CAP_MS = 5000

/** The composer's notice when an unsaved edit of a queued message went to the composer. */
export const QUEUE_DRAFT_MOVED_NOTICE = 'Your edit is in the composer: the message had already started.'

/** The composer's text with `text` added: alone when the composer is empty, else on a new line after what it has. */
export function withDraftAppended(current: string, text: string): string {
  if (!current.trim()) return text
  return current.endsWith('\n') ? `${current}${text}` : `${current}\n${text}`
}

export interface UseThreadQueueOptions {
  threadId: string | null
  /** Messages just sent while a reply runs, shown until the daemon lists them. */
  optimisticItems?: QueuedMessage[]
  onOptimisticItemReconciled?: (id: string) => void
  /** A compaction holds the queue until it ends; null when nothing does. */
  hold?: QueueHold | null
  /**
   * Puts an unsaved edit whose message left the queue in that thread's composer, with the message's attachments
   * and references. The thread may not be the one shown.
   */
  onDraftToComposer?: (threadId: string, recovered: RecoveredQueueDraft) => void
}

/** An unsaved edit whose message left the queue, as the composer takes it. */
export interface RecoveredQueueDraft {
  text: string
  /** The message's composer markers: attached files, voice messages, browser elements, references. */
  markers: string
  images?: ChatImageAttachment[]
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
  /** What a change did that the person should know, for the composer's notice line (Send now came too late to skip a compaction). */
  notice: string | null
  clearNotice: () => void
  /** An unsaved edit of this thread went to the composer (its message had started), for the composer's notice line. */
  draftMoved: boolean
  dismissDraftMoved: () => void
  /** This thread's open edit, if any. */
  editDraft: QueueEditDraft | null
  startEdit: (item: QueuedMessage, width: number | null) => void
  updateEdit: (patch: Partial<Pick<QueueEditDraft, 'base' | 'draft' | 'images'>>) => void
  closeEdit: () => void
  /** While a compaction runs, the queue waits for it; Send now then skips the compaction. */
  hold: QueueHold | null
  /** Sends the item into the running reply now; while a compaction holds the queue, stops it and sends the item first. */
  steer: (itemId: string) => Promise<void>
  remove: (itemId: string) => Promise<void>
  /** Saves a new order; shown at once, put back when the save fails. */
  reorder: (orderedIds: string[]) => Promise<void>
  /**
   * Replaces the item's text in place. With `expectedContent` (the content the edit started from) it is not saved
   * when the text changed meanwhile: `changed`, and the item shows the new text. A save closes the open edit.
   */
  edit: (itemId: string, content: string, expectedContent?: string) => Promise<QueueEditOutcome>
}

export type QueueEditOutcome = 'saved' | 'changed' | 'failed'

/** Send now on a message held for a compaction that had just finished: it goes first, with the compacted context. */
export const COMPACTION_FINISHED_NOTICE = 'Compaction already finished · sent first with the compacted context'

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
export function useThreadQueue({ threadId, optimisticItems = [], onOptimisticItemReconciled, hold = null, onDraftToComposer }: UseThreadQueueOptions): ThreadQueue {
  const [items, setItems] = useState<QueuedMessage[]>([])
  // The thread `items` were read for; null until the shown thread's list arrives.
  const [itemsThread, setItemsThread] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Open edits and "your edit is in the composer" notices live in the app store, by thread: they outlast the thread
  // shown, and the open edits are saved with the profile's workspace, so a reload keeps them.
  const shownEdit = useAppStore((state) => (threadId ? state.queueEditDrafts[threadId] : undefined))
  const draftMoved = useAppStore((state) => Boolean(threadId && state.queueDraftNotices[threadId]))
  // The last list of each thread with an open edit seen while that thread was not shown: a save that fails there
  // decides on it.
  const hiddenLists = useRef(new Map<string, QueuedMessage[]>())
  // A list is kept only while its thread has an open edit: a save, a cancel, a recovery or the thread's deletion
  // drops it, so the lists (and their images) do not pile up over a session.
  useEffect(() => useAppStore.subscribe((state, previous) => {
    if (state.queueEditDrafts === previous.queueEditDrafts) return
    for (const thread of hiddenLists.current.keys()) {
      if (!state.queueEditDrafts[thread]) hiddenLists.current.delete(thread)
    }
  }), [])
  const toComposer = useRef(onDraftToComposer)
  toComposer.current = onDraftToComposer
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({})
  const itemsRef = useRef(items)
  itemsRef.current = items
  const itemsThreadRef = useRef(itemsThread)
  itemsThreadRef.current = itemsThread

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
        setItemsThread(id)
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

  // The message of an open edit left the queue or started (sent, or removed elsewhere), here or while its thread
  // was not shown: the edit closes, and a draft with changes of its own goes to that thread's composer with the
  // message's attachments, so it is not lost. While a save is in flight this waits for its outcome: a saved edit
  // is not recovered. The message's text changed elsewhere while the draft has no changes: the draft follows it. An
  // edit read back after a reload gets the message's images again from the queue.
  const reconcileEdit = useCallback((thread: string, list: QueuedMessage[]) => {
    const store = useAppStore.getState()
    const draft = store.queueEditDrafts[thread]
    if (!draft || draft.saving) return
    const item = list.find((entry) => entry.id === draft.itemId)
    const base = splitQueuedContent(draft.base)
    if (item && canEditQueued(item)) {
      if (item.content !== draft.base && draft.draft === base.text) {
        store.updateQueueEditDraft(thread, draft.itemId, (open) => ({ ...open, base: item.content, draft: splitQueuedContent(item.content).text, images: item.images }))
      } else if (!draft.images && item.images?.length && item.content === draft.base) {
        store.updateQueueEditDraft(thread, draft.itemId, (open) => ({ ...open, images: item.images }))
      }
      return
    }
    // Taken out of the store at once: a second update before the next render finds nothing to recover, and the
    // saved workspace no longer has it, so a reload does not recover it again.
    const taken = store.takeQueueEditDraft(thread, draft.itemId)
    hiddenLists.current.delete(thread)
    if (!taken) return
    const text = taken.draft.trim()
    const images = taken.images?.length ? taken.images : undefined
    // Changed is not the same as having text: an edit that cleared the text of a message with attachments still
    // gives the attachments back.
    if (text === base.text || (!text && !base.markers && !images)) return
    toComposer.current?.(thread, { text, markers: base.markers, ...(images ? { images } : {}) })
    store.setQueueDraftNotice(thread, true)
    // The notice says what happened; an error about the same message (its edit refused) adds nothing.
    if (thread === threadIdRef.current) setError(null)
  }, [])

  useEffect(() => {
    setItems([])
    setItemsThread(null)
    setError(null)
    setNotice(null)
    setBusyIds({})
    // Prefer the select snapshot's queue:updated so we don't race thread.snapshot with queue.list. An update of
    // another thread only matters to an edit open there.
    let settled = false
    const unsub = window.mousse.queue.onUpdated(({ threadId: updatedId, items: next }) => {
      if (updatedId !== threadId) {
        if (useAppStore.getState().queueEditDrafts[updatedId]) hiddenLists.current.set(updatedId, next)
        reconcileEdit(updatedId, next)
        return
      }
      settled = true
      loadGeneration.current += 1
      setItems(next)
      setItemsThread(updatedId)
    })
    if (!threadId) return unsub
    const fallback = window.setTimeout(() => {
      if (!settled) void loadQueue(threadId)
    }, 120)
    return () => {
      unsub()
      window.clearTimeout(fallback)
      // The list this thread had when it stopped being shown, for an edit of it still saving.
      if (useAppStore.getState().queueEditDrafts[threadId] && itemsThreadRef.current === threadId) hiddenLists.current.set(threadId, itemsRef.current)
      // Stops a load that is retrying for this thread, and makes its changes still in flight change nothing.
      loadGeneration.current += 1
      threadSession.current += 1
      loggedLoadFailure.current = false
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
  }, [threadId, loadQueue, reconcileEdit])

  useEffect(() => {
    if (threadId && itemsThread === threadId) reconcileEdit(threadId, items)
  }, [threadId, itemsThread, items, shownEdit, reconcileEdit])

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
    setNotice(null)
    try {
      const sent = await window.mousse.queue.promoteToSteer(threadId, itemId)
      if (!live()) return
      if (!sent.ok) {
        setError(refused)
        void loadQueue(threadId)
      } else if (sent.notice === 'compaction_finished') {
        setNotice(COMPACTION_FINISHED_NOTICE)
      }
    } catch (err) {
      if (!live()) return
      setError(readableError(err, refused))
      void loadQueue(threadId)
    } finally {
      if (live()) markBusy(itemId, false)
    }
  }, [threadId, loadQueue, markBusy, changeScope])

  // The editor stays open until the edit answers, so the item keeps its text until then. Its open edit learns the
  // outcome even when another thread is shown by then: saved closes it, anything else keeps the draft.
  const edit = useCallback(async (itemId: string, content: string, expectedContent?: string): Promise<QueueEditOutcome> => {
    if (!threadId) return 'failed'
    const thread = threadId
    const live = changeScope(threadId)
    markBusy(itemId, true)
    useAppStore.getState().updateQueueEditDraft(thread, itemId, (open) => ({ ...open, saving: true }))
    let outcome: QueueEditOutcome = 'failed'
    try {
      const { item, changed } = await window.mousse.queue.edit(threadId, itemId, content, expectedContent)
      outcome = changed ? 'changed' : 'saved'
      if (!live()) return 'failed'
      setItems((current) => current.map((entry) => (entry.id === item.id ? item : entry)))
      if (changed) return 'changed'
      setError(null)
      return 'saved'
    } catch (err) {
      if (!live()) return 'failed'
      // The message left the queue meanwhile (it started): its draft goes to the composer, which says so.
      if (!itemsRef.current.some((entry) => entry.id === itemId)) return 'failed'
      setError(readableError(err, 'Could not edit the queued message.'))
      void loadQueue(threadId)
      return 'failed'
    } finally {
      // A deleted thread's edit is gone from the store: nothing here brings it back.
      useAppStore.getState().updateQueueEditDraft(thread, itemId, (open) => (outcome === 'saved' ? null : { ...open, saving: false }))
      if (live()) markBusy(itemId, false)
      // Not saved while the thread is not shown: the last list seen of it decides whether the draft is recovered.
      // (The thread shown decides on its own list, in the effect above.)
      const hidden = hiddenLists.current.get(thread)
      if (outcome !== 'saved' && thread !== threadIdRef.current && hidden) reconcileEdit(thread, hidden)
    }
  }, [threadId, loadQueue, markBusy, changeScope, reconcileEdit])

  const clearError = useCallback(() => setError(null), [])
  const clearNotice = useCallback(() => setNotice(null), [])
  const dismissDraftMoved = useCallback(() => {
    const thread = threadIdRef.current
    if (thread) useAppStore.getState().setQueueDraftNotice(thread, false)
  }, [])
  const editDraft = shownEdit ?? null
  const startEdit = useCallback((item: QueuedMessage, width: number | null) => {
    const thread = threadIdRef.current
    if (!thread) return
    useAppStore.getState().setQueueEditDraft(thread, { itemId: item.id, width, base: item.content, draft: splitQueuedContent(item.content).text, ...(item.images?.length ? { images: item.images } : {}) })
  }, [])
  const updateEdit = useCallback((patch: Partial<Pick<QueueEditDraft, 'base' | 'draft' | 'images'>>) => {
    const thread = threadIdRef.current
    const store = useAppStore.getState()
    const open = thread ? store.queueEditDrafts[thread] : undefined
    if (thread && open) store.updateQueueEditDraft(thread, open.itemId, (draft) => ({ ...draft, ...patch }))
  }, [])
  const closeEdit = useCallback(() => {
    const thread = threadIdRef.current
    const store = useAppStore.getState()
    const open = thread ? store.queueEditDrafts[thread] : undefined
    if (thread && open) store.updateQueueEditDraft(thread, open.itemId, () => null)
  }, [])

  const shown = useMemo(() => [
    ...items,
    ...optimisticItems.filter((optimistic) => optimistic.threadId === threadId && !items.some((item) => item.id === optimistic.id))
  ].filter((item) => !item.internal), [items, optimisticItems, threadId])

  return useMemo(
    () => ({ threadId, items: shown, busyIds, error, clearError, notice, clearNotice, draftMoved, dismissDraftMoved, editDraft, startEdit, updateEdit, closeEdit, hold, steer, remove, reorder, edit }),
    [threadId, shown, busyIds, error, clearError, notice, clearNotice, draftMoved, dismissDraftMoved, editDraft, startEdit, updateEdit, closeEdit, hold, steer, remove, reorder, edit]
  )
}

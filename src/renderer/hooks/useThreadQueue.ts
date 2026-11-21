import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatImageAttachment, QueuedMessage } from '../../shared/types'
import { readableError } from '../lib/errorText'
import { canEditQueued, isOptimisticQueueItem, queuedWords, splitQueuedContent, type QueueEditDraft } from '../lib/queuedContent'
import { steerLanded, steerOnTheWay, type SteerOnTheWay } from '../lib/steersOnTheWay'
import { useAppStore } from '../stores/appStore'

export { isOptimisticQueueItem }
export type { QueueEditDraft }

/** Waits before the first tries of a queue load that failed; after these it tries every `QUEUE_LOAD_RETRY_CAP_MS`. */
export const QUEUE_LOAD_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000]
export const QUEUE_LOAD_RETRY_CAP_MS = 5000
/**
 * How long a message sent now stays out of the list while the daemon still lists it as waiting (the turn it joins
 * is still being set up). Past this it shows again, first in the queue, so it is never hidden for good.
 */
export const SENT_NOW_HIDE_MS = 15_000
/**
 * How long the first queued message stays in the list after the daemon takes it for its turn, waiting for its
 * prompt to show in the transcript. Its turn takes well under a second to show; past this it goes anyway.
 */
export const STARTING_ITEM_HOLD_MS = 2500

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
  onQueueObserved?: (threadId: string, items: QueuedMessage[]) => void
  /** A compaction holds the queue until it ends; null when nothing does. */
  hold?: QueueHold | null
  /**
   * Puts an unsaved edit whose message left the queue in that thread's composer, with the message's attachments
   * and references. The thread may not be the one shown.
   */
  onDraftToComposer?: (threadId: string, recovered: RecoveredQueueDraft) => void
  /**
   * The transcript's last prompt: its id, and the queued message it came from. The first queued message stays in
   * the list until its turn's prompt shows, so it moves from the queue to the transcript in one step.
   */
  lastPromptId?: string | null
  lastPromptQueueItemId?: string | null
  /** Sends whose queued message is not shown (`QueuedMessage.clientRequestId`): steers on their way into the reply. */
  hiddenRequestIds?: ReadonlySet<string>
  /**
   * Whether the transcript's last turn is the one a message sent now joins: a turn that takes steers runs, or a prompt
   * sent here is on its way. Otherwise (a turn is still being set up, a turn is ending, nothing runs) a message sent now
   * stays first in the queue, marked as sending next, until a running turn takes it. Defaults to true.
   */
  replyOpen?: boolean
  /** Whether a turn of the thread is running or being set up; when it ends, nothing is marked as sending next any more. */
  turnActive?: boolean
  /**
   * Whether the thread's next turn is being set up (phase `queued`): the message the daemon took for it stays first in
   * the list until the setup ends, however long that takes, instead of only for `STARTING_ITEM_HOLD_MS`.
   */
  turnSettingUp?: boolean
}

/** An unsaved edit whose message left the queue, as the composer takes it. */
export interface RecoveredQueueDraft {
  text: string
  /** The message's composer markers: attached files, voice messages, browser elements, references. */
  markers: string
  images?: ChatImageAttachment[]
  /** The queued message it was an edit of: its images that came by name only are fetched by this id. */
  itemId?: string
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
  steer: (itemId: string, known?: QueuedMessage) => Promise<void>
  /**
   * A steer typed in the composer is on its way; returns its key. `endComposerSteer` when its send answers: `taken`
   * when the service took it for the reply, so it stays painted there until its copy shows (or comes back after a while).
   */
  beginComposerSteer: (content: string, images?: ChatImageAttachment[]) => string | null
  endComposerSteer: (key: string, taken: boolean) => void
  /** Steers sent here that the transcript does not show yet: the conversation paints them in the reply at once. */
  steersOnTheWay: SteerOnTheWay[]
  /** Messages sent now while no running turn could take them yet: they wait first in the queue and go next. */
  sendingNext: ReadonlySet<string>
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
 * The message the daemon just took from the front of the queue for its turn: the first waiting message, when it
 * is the only one that left the list. Not one removed or sent now here (`skip`), nor a list cleared at once.
 */
export function startingItem(previous: QueuedMessage[], next: QueuedMessage[], skip: (id: string) => boolean): QueuedMessage | null {
  const shown = previous.filter((item) => !item.internal)
  const head = shown.find((item) => item.state === 'pending' && item.intent === 'normal')
  if (!head || skip(head.id) || next.some((item) => item.id === head.id)) return null
  return shown.every((item) => item === head || next.some((entry) => entry.id === item.id)) ? head : null
}

/**
 * Whether a listed item is the message a copy shown while its send is on its way stands for: the same item, or the
 * item that send queued (the same `clientRequestId`), whichever of the list and the send's answer arrives first.
 */
export function sameQueuedSend(item: QueuedMessage, optimistic: QueuedMessage): boolean {
  return item.threadId === optimistic.threadId && (item.id === optimistic.id || Boolean(optimistic.clientRequestId && item.clientRequestId === optimistic.clientRequestId))
}

/**
 * Loads the thread's queue, keeps it in step with `queue:updated`, and wraps the queue's changes
 * (send now, remove, reorder, edit) with busy marks and error text.
 */
const EMPTY_QUEUE: QueuedMessage[] = []

export function useThreadQueue({ threadId, optimisticItems = [], onQueueObserved, hold = null, onDraftToComposer, lastPromptId = null, lastPromptQueueItemId = null, hiddenRequestIds, replyOpen = true, turnActive = false, turnSettingUp = false }: UseThreadQueueOptions): ThreadQueue {
  const replyOpenRef = useRef(replyOpen)
  replyOpenRef.current = replyOpen
  const [loadedItems, setItems] = useState<QueuedMessage[]>([])
  const recentQueues = useRef(new Map<string, QueuedMessage[]>())
  const queueObserved = useRef(onQueueObserved)
  queueObserved.current = onQueueObserved
  const rememberQueue = useCallback((id: string, list: QueuedMessage[]) => {
    queueObserved.current?.(id, list)
    const cache = recentQueues.current
    cache.delete(id)
    cache.set(id, list)
    if (cache.size > 8) cache.delete(cache.keys().next().value!)
  }, [])
  // The first queued message, just taken by the daemon for its turn, kept in the list until that turn's prompt shows
  // (the transcript's last prompt is no longer `promptId`, or is this message's).
  const [starting, setStarting] = useState<{ item: QueuedMessage; promptId: string | null } | null>(null)
  const lastPromptIdRef = useRef(lastPromptId)
  lastPromptIdRef.current = lastPromptId
  // Removed here: it leaves the list at once.
  const removing = useRef(new Set<string>())
  const sentNowRef = useRef<Readonly<Record<string, SteerOnTheWay>>>({})
  // The thread `items` were read for; null until the shown thread's list arrives.
  const [itemsThread, setItemsThread] = useState<string | null>(null)
  const items = itemsThread === threadId ? loadedItems : (threadId && recentQueues.current.get(threadId)) || EMPTY_QUEUE
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Open edits and "your edit is in the composer" notices live in the app store, by thread: they outlast the thread
  // shown, and the open edits are saved with the profile's workspace, so a reload keeps them.
  const shownEdit = useAppStore((state) => (threadId ? state.queueEditDrafts[threadId] : undefined))
  const draftMoved = useAppStore((state) => Boolean(threadId && state.queueDraftNotices[threadId]))
  // The last list of each thread with an open edit seen while that thread was not shown: a save that fails there
  // decides on it.
  const hiddenLists = useRef(new Map<string, QueuedMessage[]>())
  // The queue of a thread being opened (`openingThreadId`): its select sends it before the view that shows the thread.
  const openingList = useRef<{ threadId: string; items: QueuedMessage[] } | null>(null)
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
        rememberQueue(id, list)
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
  }, [rememberQueue])

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
    const base = splitQueuedContent(queuedWords(draft.base, item?.origin))
    if (item && canEditQueued(item)) {
      if (item.content !== draft.base && draft.draft === base.text) {
        store.updateQueueEditDraft(thread, draft.itemId, (open) => ({ ...open, base: item.content, draft: splitQueuedContent(queuedWords(item.content, item.origin)).text, images: item.images }))
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
    toComposer.current?.(thread, { text, markers: base.markers, itemId: draft.itemId, ...(images ? { images } : {}) })
    store.setQueueDraftNotice(thread, true)
    // The notice says what happened; an error about the same message (its edit refused) adds nothing.
    if (thread === threadIdRef.current) setError(null)
  }, [])

  useEffect(() => {
    const cached = threadId ? recentQueues.current.get(threadId) : undefined
    setItems(cached ?? EMPTY_QUEUE)
    setStarting(null)
    removing.current.clear()
    setItemsThread(cached ? threadId : null)
    setError(null)
    setNotice(null)
    setBusyIds({})
    // Prefer the select snapshot's queue:updated so we don't race thread.snapshot with queue.list.
    // Pushes for hidden threads also reconcile sends whose acknowledgements have yet to arrive.
    let settled = false
    const unsub = window.mousse.queue.onUpdated(({ threadId: updatedId, items: next }) => {
      rememberQueue(updatedId, next)
      if (updatedId !== threadId) {
        if (updatedId === useAppStore.getState().openingThreadId) openingList.current = { threadId: updatedId, items: next }
        if (useAppStore.getState().queueEditDrafts[updatedId]) hiddenLists.current.set(updatedId, next)
        reconcileEdit(updatedId, next)
        return
      }
      settled = true
      loadGeneration.current += 1
      // Rendered with the new list, so the message is never missing from both the queue and the transcript.
      const left = itemsThreadRef.current === updatedId
        ? startingItem(itemsRef.current, next, (id) => removing.current.has(id) || Boolean(sentNowRef.current[id]))
        : null
      if (left) setStarting({ item: left, promptId: lastPromptIdRef.current })
      setItems(next)
      setItemsThread(updatedId)
    })
    if (!threadId) return unsub
    const early = openingList.current
    openingList.current = null
    if (early?.threadId === threadId) {
      settled = true
      rememberQueue(threadId, early.items)
      setItems(early.items)
      setItemsThread(threadId)
    }
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
  }, [threadId, loadQueue, reconcileEdit, rememberQueue])

  useEffect(() => {
    if (threadId && itemsThread === threadId) reconcileEdit(threadId, items)
  }, [threadId, itemsThread, items, shownEdit, reconcileEdit])

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
    removing.current.add(itemId)
    try {
      await window.mousse.queue.remove(threadId, itemId)
      if (!live()) return
      setError(null)
    } catch (err) {
      // Still listed: if it leaves later, that is not this remove.
      removing.current.delete(itemId)
      if (!live()) return
      setError(readableError(err, 'Could not remove the queued message.'))
      void loadQueue(threadId)
    } finally {
      if (live()) markBusy(itemId, false)
    }
  }, [threadId, loadQueue, markBusy, changeScope])

  // Send now requests in flight, by item: a second click before the first answers (and before the button shows
  // busy) sends nothing more.
  const steering = useRef(new Set<string>())
  // Messages sent now into a running reply leave the list at the click, and the reply shows them at once
  // (`steersOnTheWay`). One that is refused comes back; one the daemon still lists as waiting comes back after a while.
  const [sentNow, setSentNow] = useState<Readonly<Record<string, SteerOnTheWay>>>({})
  sentNowRef.current = sentNow
  const sentNowTimers = useRef(new Map<string, number>())
  const unsend = useCallback((itemId: string) => {
    const timer = sentNowTimers.current.get(itemId)
    if (timer !== undefined) window.clearTimeout(timer)
    sentNowTimers.current.delete(itemId)
    setSentNow((current) => {
      if (!current[itemId]) return current
      const { [itemId]: _gone, ...rest } = current
      return rest
    })
  }, [])
  const hideSentNowLater = useCallback((itemId: string) => {
    const previous = sentNowTimers.current.get(itemId)
    if (previous !== undefined) window.clearTimeout(previous)
    sentNowTimers.current.set(itemId, window.setTimeout(() => unsend(itemId), SENT_NOW_HIDE_MS))
  }, [unsend])
  // Messages sent now while no running turn could take them (a turn still being set up, a turn ending, nothing
  // running). The transcript's last turn is not the one they join, so they are not painted in it: they wait first in
  // the queue, marked as sending next, and move into the reply once the daemon hands them to the running turn.
  const [next, setNext] = useState<ReadonlySet<string>>(() => new Set())
  const dropNext = useCallback((ids: readonly string[]) => {
    setNext((current) => {
      if (!ids.some((id) => current.has(id))) return current
      const kept = new Set(current)
      for (const id of ids) kept.delete(id)
      return kept
    })
  }, [])
  useEffect(() => () => {
    for (const timer of sentNowTimers.current.values()) window.clearTimeout(timer)
    sentNowTimers.current.clear()
    setSentNow({})
    setNext(new Set())
  }, [threadId])
  // The service says which messages wait to join the turn being set up (`QueuedMessage.sendsNext`), whoever sent them
  // and whichever window was showing the thread: they are marked as sending next here too, also after the thread was
  // left and opened again.
  useEffect(() => {
    const marked = items.filter((item) => item.sendsNext && item.state === 'pending').map((item) => item.id)
    if (marked.length) setNext((current) => (marked.every((id) => current.has(id)) ? current : new Set([...current, ...marked])))
  }, [items])
  // Marked messages the daemon's list has shown: one sent from the composer may be marked before the list has it.
  const listedNext = useRef(new Set<string>())
  useEffect(() => {
    if (!next.size) { listedNext.current.clear(); return }
    const gone: string[] = []
    const joined: QueuedMessage[] = []
    for (const id of next) {
      const item = items.find((entry) => entry.id === id)
      if (item) listedNext.current.add(id)
      // Gone: it started as a turn of its own (its prompt shows), joined a turn whose copy already shows, or was removed.
      if (id === lastPromptQueueItemId || (!item && listedNext.current.has(id))) gone.push(id)
      else if (item?.steerMissed) gone.push(id)
      else if (item?.state === 'steering') joined.push(item)
    }
    if (!gone.length && !joined.length) return
    // The running turn took it: it shows in that turn's reply, after its prompt, until its copy there arrives.
    if (joined.length && threadId) {
      const messages = useAppStore.getState().messages
      setSentNow((current) => {
        const painted = { ...current }
        for (const item of joined) {
          painted[item.id] ??= steerOnTheWay(`item:${item.id}`, threadId, item.content, messages, { itemId: item.id, images: item.images })
        }
        return painted
      })
      for (const item of joined) hideSentNowLater(item.id)
    }
    dropNext([...gone, ...joined.map((item) => item.id)])
  }, [items, next, lastPromptQueueItemId, threadId, dropNext, hideSentNowLater])
  // The turn ended without taking them (a Stop): they are ordinary queued messages again, first in the queue.
  const wasActive = useRef(turnActive)
  useEffect(() => {
    if (wasActive.current && !turnActive) setNext((current) => (current.size ? new Set() : current))
    wasActive.current = turnActive
  }, [turnActive])
  // A turn that runs takes them as it starts; one it still lists as waiting a while after is not joining it.
  useEffect(() => {
    if (!replyOpen || !next.size) return
    const timer = window.setTimeout(() => {
      dropNext(itemsRef.current.filter((item) => next.has(item.id) && item.state === 'pending' && !item.sendsNext).map((item) => item.id))
    }, STARTING_ITEM_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [replyOpen, next, dropNext])
  // Gone from the daemon's list once its copy shows in the turn: nothing left to paint or hide. Gone before that (the
  // list is not updated yet, or dropped it before the copy arrived), it stays painted until the copy shows or the
  // timer ends, so it never leaves the reply for a moment. Listed as waiting again after it was on its way (a Stop
  // put it back first in the queue): it shows again at once.
  const seenSteering = useRef(new Set<string>())
  const transcript = useAppStore((state) => state.messages)
  useEffect(() => {
    for (const item of items) if (item.state === 'steering') seenSteering.current.add(item.id)
    for (const [id, painted] of Object.entries(sentNow)) {
      const item = items.find((entry) => entry.id === id)
      if (item ? item.state === 'pending' && seenSteering.current.has(id) : steerLanded(painted, transcript)) {
        seenSteering.current.delete(id)
        unsend(id)
      }
    }
  }, [items, sentNow, transcript, unsend])
  const steer = useCallback(async (itemId: string, known?: QueuedMessage) => {
    if (!threadId) return
    const key = `${threadId}\n${itemId}`
    if (steering.current.has(key)) return
    steering.current.add(key)
    const live = changeScope(threadId)
    const refused = 'Could not send it now; the reply may have ended. The message is still queued.'
    markBusy(itemId, true)
    // Painted in the reply only when the reply it joins is the transcript's last turn; otherwise it goes next.
    const paints = replyOpenRef.current
    const item = itemsRef.current.find((entry) => entry.id === itemId) ?? (known?.id === itemId ? known : undefined)
    if (paints) {
      const painted = steerOnTheWay(`item:${itemId}`, threadId, item?.content ?? '', useAppStore.getState().messages, { itemId, images: item?.images })
      setSentNow((current) => (current[itemId] ? current : { ...current, [itemId]: painted }))
    } else {
      setNext((current) => (current.has(itemId) ? current : new Set(current).add(itemId)))
    }
    setError(null)
    setNotice(null)
    try {
      const sent = await window.mousse.queue.promoteToSteer(threadId, itemId)
      if (!live()) return
      if (!sent.ok) {
        unsend(itemId)
        dropNext([itemId])
        setError(refused)
        void loadQueue(threadId)
      } else {
        if (sent.notice === 'compaction_finished') setNotice(COMPACTION_FINISHED_NOTICE)
        if (paints) hideSentNowLater(itemId)
      }
    } catch (err) {
      if (!live()) return
      unsend(itemId)
      dropNext([itemId])
      setError(readableError(err, refused))
      void loadQueue(threadId)
    } finally {
      steering.current.delete(key)
      if (live()) markBusy(itemId, false)
    }
  }, [threadId, loadQueue, markBusy, changeScope, unsend, dropNext, hideSentNowLater])

  // Steers typed in the composer, painted in the reply from the click. One the service took stays painted until its
  // copy shows; if it never does (its turn is still being set up), the queue shows it again after a while.
  const [composerSteers, setComposerSteers] = useState<readonly SteerOnTheWay[]>([])
  const composerSteerTimers = useRef(new Map<string, number>())
  const dropComposerSteer = useCallback((key: string) => {
    const timer = composerSteerTimers.current.get(key)
    if (timer !== undefined) window.clearTimeout(timer)
    composerSteerTimers.current.delete(key)
    setComposerSteers((current) => (current.some((steer) => steer.key === key) ? current.filter((steer) => steer.key !== key) : current))
  }, [])
  useEffect(() => () => {
    for (const timer of composerSteerTimers.current.values()) window.clearTimeout(timer)
    composerSteerTimers.current.clear()
  }, [])
  const beginComposerSteer = useCallback((content: string, images?: ChatImageAttachment[]): string | null => {
    // Not painted while the transcript's last turn is not the one it joins: it waits in the queue instead.
    if (!threadId || (!content.trim() && !images?.length) || !replyOpenRef.current) return null
    const key = `composer:${crypto.randomUUID()}`
    const painted = steerOnTheWay(key, threadId, content, useAppStore.getState().messages, { images })
    setComposerSteers((current) => [...current, painted])
    return key
  }, [threadId])
  const endComposerSteer = useCallback((key: string, taken: boolean) => {
    if (!taken) { dropComposerSteer(key); return }
    const previous = composerSteerTimers.current.get(key)
    if (previous !== undefined) window.clearTimeout(previous)
    composerSteerTimers.current.set(key, window.setTimeout(() => dropComposerSteer(key), SENT_NOW_HIDE_MS))
  }, [dropComposerSteer])
  // Its copy showed: nothing left to paint, and the queue no longer looks for it.
  useEffect(() => {
    for (const steer of composerSteers) if (steer.threadId === threadId && steerLanded(steer, transcript)) dropComposerSteer(steer.key)
  }, [composerSteers, transcript, threadId, dropComposerSteer])
  const steersOnTheWay = useMemo(
    () => (threadId ? [...composerSteers, ...Object.values(sentNow)].filter((steer) => steer.threadId === threadId) : []),
    [threadId, composerSteers, sentNow]
  )
  // A composer steer the turn takes once it runs waits in the queue meanwhile (the daemon lists it there, newest with
  // its words): it is shown in the reply, not also here.
  const composerSteerItemIds = useMemo(() => {
    const ids = new Set<string>()
    for (const steer of composerSteers) {
      if (steer.threadId !== threadId) continue
      const waiting = items.filter((item) => item.state === 'pending' && !ids.has(item.id) && item.content.trim() === steer.text)
      if (waiting.length) ids.add(waiting[waiting.length - 1]!.id)
    }
    return ids
  }, [composerSteers, items, threadId])

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
    // An agent's message opens on its words, not on the header Mousse wrote around them.
    useAppStore.getState().setQueueEditDraft(thread, { itemId: item.id, width, base: item.content, draft: splitQueuedContent(queuedWords(item.content, item.origin)).text, ...(item.images?.length ? { images: item.images } : {}) })
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

  // The message taken for its turn stays first until its turn's prompt shows in the transcript.
  const startingShown = starting && starting.item.threadId === threadId && lastPromptId === starting.promptId &&
    lastPromptQueueItemId !== starting.item.id && !items.some((item) => item.id === starting.item.id)
    ? starting.item
    : null
  useEffect(() => {
    if (!starting) return
    if (!startingShown) { setStarting(null); return }
    // Its turn's setup can take a minute: the prompt shows only after it. The wait for the prompt starts when it ends.
    if (turnSettingUp) return
    const timer = window.setTimeout(() => setStarting(null), STARTING_ITEM_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [starting, startingShown, turnSettingUp])
  // A message sent now (`steering`, or just clicked into a running reply) shows in the transcript, in the reply it
  // joined, not here, unless it is still marked as sending next (it moves there as the next render paints it); so does
  // one whose turn's prompt is in the transcript.
  const shown = useMemo(() => [
    // Taken for its turn, it waits for that turn's setup, whatever it waited for before.
    ...(startingShown ? [startingShown.waitsFor === 'setup' ? startingShown : { ...startingShown, waitsFor: 'setup' as const }] : []),
    ...items,
    ...optimisticItems.filter((optimistic) => optimistic.threadId === threadId && !items.some((item) => sameQueuedSend(item, optimistic)))
  ].filter((item) => !item.internal && (item.state !== 'steering' || next.has(item.id)) && !sentNow[item.id] && !composerSteerItemIds.has(item.id) &&
    item.id !== lastPromptQueueItemId && !(item.clientRequestId && hiddenRequestIds?.has(item.clientRequestId))),
  [startingShown, items, optimisticItems, threadId, sentNow, next, composerSteerItemIds, lastPromptQueueItemId, hiddenRequestIds])
  // The message on its way into its turn takes no change.
  const busy = useMemo(() => (startingShown ? { ...busyIds, [startingShown.id]: true } : busyIds), [busyIds, startingShown])

  return useMemo(
    () => ({ threadId, items: shown, busyIds: busy, error, clearError, notice, clearNotice, draftMoved, dismissDraftMoved, editDraft, startEdit, updateEdit, closeEdit, hold, steer, beginComposerSteer, endComposerSteer, steersOnTheWay, sendingNext: next, remove, reorder, edit }),
    [threadId, shown, busy, error, clearError, notice, clearNotice, draftMoved, dismissDraftMoved, editDraft, startEdit, updateEdit, closeEdit, hold, steer, beginComposerSteer, endComposerSteer, steersOnTheWay, next, remove, reorder, edit]
  )
}

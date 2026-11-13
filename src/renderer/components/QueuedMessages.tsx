import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type DragEvent, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { QueuedMessage } from '../../shared/types'
import { ArrowTurnForward, Check, ChevronDown, ChevronUp, GripVertical, Loader2, Pencil, Trash2, X } from '../lib/icons'
import { queueFoldCount, queueFoldLimit } from '../lib/queueFold'
import { COMPOSER_STACK_VAR } from '../chat/components/agent-elements/composer-stack-height'
import { useAfterTurnsLayout } from '../chat/components/agent-elements/after-turns'
import { shortTokens } from '../lib/promptCache'
import { mousseToUIMessages } from '../chat/adapters/mousseToUI'
import { UserMessage } from '../chat/components/agent-elements/user-message'
import { SubagentNotice } from '../chat/components/agent-elements/tools/SubagentNotice'
import { isOptimisticQueueItem, type ThreadQueue } from '../hooks/useThreadQueue'
import { canEditQueued, queuedContentWithText, splitQueuedContent } from '../lib/queuedContent'
import { formatBinding } from '../../shared/commands'
import { useAppStore } from '../stores/appStore'
import { isSteerKey, markSteerKey, STEER_BINDING, steerKeyRecently } from '../lib/steerKey'
import '../styles/queued-messages.css'

export { canEditQueued, queuedContentWithText, splitQueuedContent } from '../lib/queuedContent'


/** Send now on the first message a compaction holds: it stops the compaction and sends with the full history. */
export function skipCompactionLabel(historyTokens?: number): string {
  return historyTokens ? `Send now: skip compacting and keep the full ${shortTokens(historyTokens)} history` : 'Send now: skip compacting and keep the full history'
}

/** Threads whose long queue is shown in full. A thread is forgotten when its queue empties. */
const openQueueFolds = new Set<string>()

/** The queue as last measured: how many messages show from the top, and where the last of them ends. */
interface QueueMeasure {
  count: number
  height: number
}

/**
 * Measures the queue's messages against the transcript it sits in (see `queueFold.ts`). The composer
 * floats over the end of the transcript, so what is under it does not count as visible. Outside a
 * transcript nothing folds. While a drag reorders the list, `keepCount` holds how many show.
 */
function measureQueue(list: HTMLElement, keepCount: number | null): QueueMeasure {
  const items = Array.from(list.children)
  const top = list.getBoundingClientRect().top
  const bottoms = items.map((item) => item.getBoundingClientRect().bottom - top)
  let count = items.length
  const transcript = list.closest<HTMLElement>('.an-message-list')
  if (keepCount !== null) {
    count = Math.min(keepCount, items.length)
  } else if (transcript) {
    const heights = bottoms.map((bottom, index) => bottom - (index > 0 ? bottoms[index - 1]! : 0))
    const composer = Number.parseFloat(getComputedStyle(transcript).getPropertyValue(COMPOSER_STACK_VAR)) || 0
    count = queueFoldCount(heights, queueFoldLimit(transcript.clientHeight - composer))
  }
  return { count, height: count > 0 ? bottoms[count - 1]! : 0 }
}

/** Where in the list the message holding the focus is; -1 when the focus is elsewhere. */
function focusedIndex(list: HTMLElement): number {
  const active = document.activeElement
  const item = active && list.contains(active) ? active.closest('.queued-message') : null
  return item ? Array.prototype.indexOf.call(list.children, item) : -1
}

function moveId(ids: string[], id: string, to: number): string[] {
  const next = ids.filter((entry) => entry !== id)
  next.splice(to, 0, id)
  return next
}

/** A queued message drawn as the prompt it will be, so it reads the same once it is sent. */
const QueuedBubble = memo(function QueuedBubble({ item }: { item: QueuedMessage }) {
  const message = useMemo(
    () => mousseToUIMessages([{ id: `queued:${item.id}`, role: 'user', content: item.content, timestamp: item.enqueuedAt, images: item.images }])[0],
    [item.id, item.content, item.enqueuedAt, item.images]
  )
  if (item.subagentNotice?.length) return <SubagentNotice items={item.subagentNotice} />
  return message ? <UserMessage message={message} /> : null
})

interface EditorProps {
  draft: string
  width: number | null
  saving: boolean
  canBeEmpty: boolean
  /** The message's text changed elsewhere after this edit started, and the draft has changes of its own. */
  changed: boolean
  /** The group's "Queued" label when this is the last item. */
  label?: ReactNode
  onDraftChange: (text: string) => void
  /** Drops the draft for the text the message has now. */
  onLoadChanged: () => void
  /** Keeps the draft; saving it replaces the text the message has now. */
  onKeepDraft: () => void
  onSave: (text: string) => void
  onCancel: () => void
}

/**
 * Edit in place: a small editor where the bubble was. Enter saves, Shift+Enter adds a line, Escape cancels.
 * When the text changed elsewhere meanwhile, the line says so and nothing saves until the person loads the new
 * text or keeps their own.
 */
function QueuedEditor({ draft, width, saving, canBeEmpty, changed, label, onDraftChange, onLoadChanged, onKeepDraft, onSave, onCancel }: EditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const canSave = !saving && !changed && (canBeEmpty || draft.trim().length > 0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Measured without a scrollbar, which would narrow the text while the field is one row high.
    el.style.overflowY = 'hidden'
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    el.style.overflowY = ''
  }, [draft])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const save = () => { if (canSave) onSave(draft) }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      save()
    }
  }
  return (
    <>
      <div className="queued-message-editor" style={width ? { width } : undefined}>
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          aria-label="Edit queued message"
          disabled={saving}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="queued-message-line is-editing">
        {changed && (
          <span className="queued-message-changed" role="alert">
            <span title="This message was changed in another window or on another computer">Changed elsewhere</span>
            <button type="button" className="queued-message-text-btn" title="Discard your draft and load the new text" onClick={() => { onLoadChanged(); ref.current?.focus() }}>
              Load new
            </button>
            <button type="button" className="queued-message-text-btn" title="Keep your draft; saving replaces the new text" onClick={() => { onKeepDraft(); ref.current?.focus() }}>
              Keep mine
            </button>
          </span>
        )}
        <span className="queued-message-actions">
          <button type="button" className="queued-message-btn" title="Cancel (Esc)" aria-label="Cancel" onClick={onCancel}>
            <X size={14} strokeWidth={1.8} />
          </button>
          <button type="button" className="queued-message-btn" title="Save (Enter)" aria-label="Save" disabled={!canSave} onClick={save}>
            <Check size={14} strokeWidth={1.8} />
          </button>
        </span>
        {label}
      </div>
    </>
  )
}

/**
 * The thread's queued messages at the end of the conversation, after the last turn: each one dimmed in
 * the place it will land, with its full text. Under each bubble, like under a sent prompt, a line whose
 * buttons show on hover: reorder (drag the grip, or Alt+Up/Down on it), send now, edit in place, remove.
 * One quiet "Queued" on the last line shown speaks for the group.
 *
 * A long queue folds: past a share of the transcript's visible height it shows only the whole messages that fit
 * from the top, and "Show all N queued" under them (see `queueFold.ts`). Each thread remembers whether it was
 * opened until its queue empties. A hidden message that takes focus, or is being edited, opens it.
 *
 * While a compaction holds the queue, "Queued" has a small spinner, and Send now on the first message skips
 * the compaction: it stops (nothing is cut) and that message goes with the full history.
 */
export function QueuedMessages({ queue }: { queue: ThreadQueue }) {
  const { items, busyIds, hold } = queue
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  const steerKey = formatBinding(STEER_BINDING, platform)
  // The open edit lives in the queue (by thread), so a switch to another thread and back keeps it.
  const editing = queue.editDraft
  // Drag to reorder starts only from the grip (`armedId`), so the text stays selectable. While dragging
  // the list reorders live under the pointer (`dragOrder`); dropping on the list saves the order, and a drag
  // that ends anywhere else (Escape, let go outside) puts it back.
  const [armedId, setArmedId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const dragOrderRef = useRef<string[] | null>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  // The grip to keep focused after a keyboard move re-renders the list.
  const refocusId = useRef<string | null>(null)

  // Only items the daemon lists can move; messages still on their way stay last.
  const ids = useMemo(() => items.filter((item) => !isOptimisticQueueItem(item)).map((item) => item.id), [items])
  const shown = useMemo(() => {
    if (!dragOrder) return items
    const byId = new Map(items.map((item) => [item.id, item]))
    const ordered = dragOrder.flatMap((id) => byId.get(id) ?? [])
    return [...ordered, ...items.filter((item) => !dragOrder.includes(item.id))]
  }, [items, dragOrder])

  useLayoutEffect(() => {
    const id = refocusId.current
    if (!id) return
    refocusId.current = null
    const grip = groupRef.current?.querySelector<HTMLElement>(`[data-queued-id="${CSS.escape(id)}"] .queued-message-grip`)
    if (grip && document.activeElement !== grip) grip.focus()
  }, [items])

  // A press on the grip that ends without a drag (wherever the pointer is let go) disarms it, so the
  // bubble's text never starts a drag.
  useEffect(() => {
    if (!armedId || dragId) return
    const disarm = () => setArmedId(null)
    window.addEventListener('pointerup', disarm)
    return () => window.removeEventListener('pointerup', disarm)
  }, [armedId, dragId])

  // The fold. Sizes are read only in the resize observer's callback, never while React commits (see
  // `useTallEnoughToFold` in user-message.tsx), and the fold is applied in that same frame, before paint.
  const threadId = queue.threadId
  const listId = useId()
  const listRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [measure, setMeasure] = useState<QueueMeasure | null>(null)
  const measureRef = useRef<QueueMeasure | null>(null)
  const draggingRef = useRef(false)
  draggingRef.current = dragId !== null
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  const showAll = Boolean(threadId && openQueueFolds.has(threadId))
  const setShowAll = useCallback((open: boolean) => {
    if (!threadId) return
    if (open) openQueueFolds.add(threadId)
    else openQueueFolds.delete(threadId)
    rerender()
  }, [threadId])
  const afterTurns = useAfterTurnsLayout()
  const showAllRef = useRef(showAll)
  showAllRef.current = showAll
  const setShowAllRef = useRef(setShowAll)
  setShowAllRef.current = setShowAll

  const remeasure = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const previous = measureRef.current
    // While a drag reorders the list, as many messages show as before it started.
    const next = measureQueue(list, draggingRef.current && previous ? previous.count : null)
    // Focus that stays on a message moving past the fold (Alt+Down) gets no focus event: it opens the fold here.
    const focusHidden = !showAllRef.current && focusedIndex(list) >= next.count
    if (!focusHidden && previous && previous.count === next.count && Math.abs(previous.height - next.height) < 0.5) return
    measureRef.current = next
    flushSync(() => {
      setMeasure(next)
      if (focusHidden) setShowAllRef.current(true)
    })
    // The end follower may have run for this frame already: land on the new end before paint.
    afterTurns.resized()
  }, [afterTurns])

  // Remeasured when the list or a message in it changes size, when the transcript does (the window, the
  // composer over its end), and after every commit (a message added, removed, edited or moved).
  const listRefCallback = useCallback((list: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    listRef.current = list
    if (!list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(remeasure)
    observer.observe(list)
    const transcript = list.closest('.an-message-list')
    if (transcript) {
      observer.observe(transcript)
      // Its padding is the composer's height.
      if (transcript.firstElementChild) observer.observe(transcript.firstElementChild)
    }
    observerRef.current = observer
  }, [remeasure])
  useLayoutEffect(() => {
    const list = listRef.current
    const observer = observerRef.current
    if (!list || !observer) return
    // Observing again reports the list in this frame even when its size did not change (a reorder).
    observer.unobserve(list)
    observer.observe(list)
  })

  // A thread's open fold is forgotten when its queue empties. Right after a switch the list can still be the
  // previous thread's, so only a list of this thread's own messages counts as one that emptied.
  const ownItems = items.some((item) => item.threadId === threadId)
  const hadOwnItems = useRef<{ threadId: string | null; had: boolean }>({ threadId, had: ownItems })
  useEffect(() => {
    const previous = hadOwnItems.current
    if (threadId && previous.threadId === threadId && previous.had && items.length === 0) openQueueFolds.delete(threadId)
    hadOwnItems.current = { threadId, had: ownItems }
  }, [threadId, ownItems, items.length])

  // An edit of a message the fold hides (a thread opened with its edit in progress) opens the fold.
  const shownCount = measure?.count ?? null
  const editIndex = editing ? shown.findIndex((item) => item.id === editing.itemId) : -1
  useEffect(() => {
    if (shownCount !== null && editIndex >= shownCount) setShowAll(true)
    // Only when the edit, the thread or the fold changes, so Show less still folds afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.itemId, threadId, shownCount])

  if (items.length === 0) return null
  const firstHeldId = shown.find((item) => !isOptimisticQueueItem(item) && item.state === 'pending')?.id

  const updateDragOrder = (next: string[] | null) => {
    dragOrderRef.current = next
    setDragOrder(next)
  }
  const endDrag = () => {
    updateDragOrder(null)
    setDragId(null)
    setArmedId(null)
  }
  // `drop` comes before `dragend`, so a drop saves and the `dragend` after it finds nothing left to put back.
  const dropDrag = () => {
    const order = dragOrderRef.current
    endDrag()
    if (order && order.join('\n') !== ids.join('\n')) void queue.reorder(order)
  }
  const onDragStart = (event: DragEvent<HTMLDivElement>, id: string) => {
    if (armedId !== id) { event.preventDefault(); return }
    setDragId(id)
    updateDragOrder(ids)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
    const bubble = event.currentTarget.querySelector('.chat-user-bubble, .subagent-notice')
    if (bubble instanceof HTMLElement) event.dataTransfer.setDragImage(bubble, Math.max(bubble.offsetWidth - 24, 0), 16)
  }
  const onDragOverItem = (event: DragEvent<HTMLDivElement>, overId: string) => {
    const order = dragOrderRef.current
    if (!dragId || !order) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const to = order.indexOf(overId)
    if (overId === dragId || to < 0) return
    const next = moveId(order, dragId, to)
    if (next.join('\n') !== order.join('\n')) updateDragOrder(next)
  }
  const onGripKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const at = ids.indexOf(id)
    const to = at + (event.key === 'ArrowUp' ? -1 : 1)
    if (at < 0 || to < 0 || to >= ids.length) return
    refocusId.current = id
    void queue.reorder(moveId(ids, id, to))
  }
  const startEdit = (item: QueuedMessage) => {
    const bubble = groupRef.current?.querySelector<HTMLElement>(`[data-queued-id="${CSS.escape(item.id)}"] .chat-user-bubble`)
    // A few pixels over the bubble's width, so a line that just fits it does not wrap in the field.
    const width = bubble?.getBoundingClientRect().width
    queue.startEdit(item, width ? Math.ceil(width) + 8 : null)
  }
  const saveEdit = (item: QueuedMessage, base: string, text: string) => {
    const content = queuedContentWithText(item.content, text)
    if (content === item.content) { queue.closeEdit(); return }
    // Saved only if the message still has the text this edit started from; otherwise the line says it changed.
    // A save closes the edit; anything else keeps it open with the draft.
    void queue.edit(item.id, content, base)
  }

  // Folds when the messages that fit are fewer than all of them. Until the observer measures a commit the
  // list keeps the height it was measured at, so a message just added shows only once it is known to fit.
  const fitCount = measure?.count ?? shown.length
  const folds = fitCount < shown.length
  const folded = folds && !showAll
  const pinnedHeight = measure && !showAll && (folds || !dragId) ? measure.height : null
  const lastShown = folded ? fitCount - 1 : shown.length - 1
  const onListFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (folded && focusedIndex(event.currentTarget) >= fitCount) setShowAll(true)
  }

  return (
    <div
      ref={groupRef}
      className="queued-messages"
      data-find-ignore
      onDragOver={(event) => { if (dragId) event.preventDefault() }}
      onDrop={(event) => { if (!dragId) return; event.preventDefault(); dropDrag() }}
    >
      <div className={pinnedHeight !== null ? 'queued-messages-fold is-pinned' : 'queued-messages-fold'} style={pinnedHeight !== null ? { height: pinnedHeight } : undefined}>
      <div ref={listRefCallback} id={listId} className="queued-messages-list" role="list" aria-label="Queued messages" onFocus={onListFocus}>
      {shown.map((item, index) => {
        const optimistic = isOptimisticQueueItem(item)
        const busy = optimistic || Boolean(busyIds[item.id])
        const last = index === lastShown
        const canDrag = ids.length > 1 && !optimistic && !busy
        const edit = editing?.itemId === item.id ? editing : null
        // While a compaction holds the queue, the first message's Send now skips it.
        const skipsCompaction = hold !== null && item.id === firstHeldId
        // A pending steer item cannot be sent now: a subagent result that missed its turn runs as a turn of its own, and a
        // steer sent into another process's reply is that process's to take.
        const fixed = item.intent === 'steer'
        const sendLabel = fixed
          ? item.subagentNotice?.length || item.inboxIds?.length ? 'Runs as a turn of its own' : 'Sent into the running reply'
          : skipsCompaction ? skipCompactionLabel(hold?.historyTokens) : `Steer: send now (${steerKey})`
        const label = !last ? null : hold
          ? <span className="queued-message-state is-held" title="Sends after compacting"><Loader2 size={12} className="animate-spin" aria-hidden="true" />Queued</span>
          : <span className="queued-message-state" title="Sends when the current reply ends">Queued</span>
        return (
          <div
            key={item.id}
            role="listitem"
            className={['queued-message', dragId === item.id ? 'is-dragging' : '', edit ? 'is-editing' : ''].filter(Boolean).join(' ')}
            data-queued-id={item.id}
            // Focusable, so the steer chord can send it now (from the item or one of its buttons).
            tabIndex={edit ? undefined : 0}
            aria-label={edit ? undefined : `Queued message. ${steerKey} sends it now.`}
            onKeyDown={(event) => {
              if (edit || busy || fixed || !isSteerKey(event, platform)) return
              event.preventDefault()
              event.stopPropagation()
              // The chord pressed again a moment after a steer lands on the next message (focus moved there): it sends
              // nothing, as the second click of a double click does not.
              if (steerKeyRecently()) return
              markSteerKey()
              // This message leaves the list: focus moves on to the next queued one (or the one before, or the
              // composer), never to the page, where the same chord would answer an approval.
              const here = event.currentTarget
              const next = [here.nextElementSibling, here.previousElementSibling].find((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('queued-message'))
              ;(next ?? document.querySelector<HTMLElement>('textarea.composer-input'))?.focus()
              void queue.steer(item.id)
            }}
            draggable={armedId === item.id}
            onDragStart={(event) => onDragStart(event, item.id)}
            onDragOver={(event) => onDragOverItem(event, item.id)}
            onDragEnd={endDrag}
          >
            {edit ? (
              <QueuedEditor
                draft={edit.draft}
                width={edit.width}
                saving={Boolean(edit.saving)}
                canBeEmpty={Boolean(item.images?.length || splitQueuedContent(item.content).markers)}
                changed={!edit.saving && item.content !== edit.base && edit.draft !== splitQueuedContent(edit.base).text}
                label={label}
                onDraftChange={(draft) => queue.updateEdit({ draft })}
                onLoadChanged={() => queue.updateEdit({ base: item.content, draft: splitQueuedContent(item.content).text, images: item.images })}
                onKeepDraft={() => queue.updateEdit({ base: item.content, images: item.images })}
                onSave={(text) => saveEdit(item, edit.base, text)}
                onCancel={queue.closeEdit}
              />
            ) : (
              <>
                <div className="queued-message-bubble"><QueuedBubble item={item} /></div>
                <div className="queued-message-line">
                  <span className="queued-message-actions">
                    {canDrag && (
                      <button
                        type="button"
                        className="queued-message-btn queued-message-grip"
                        title="Drag to reorder (Alt+Up/Down)"
                        aria-label="Reorder queued message. Alt+Up or Alt+Down moves it."
                        onPointerDown={() => setArmedId(item.id)}
                        onKeyDown={(event) => onGripKeyDown(event, item.id)}
                      >
                        <GripVertical size={14} strokeWidth={1.8} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="queued-message-btn queued-message-send"
                      title={sendLabel}
                      aria-label={fixed || skipsCompaction ? sendLabel : 'Send the queued message now'}
                      disabled={busy || fixed}
                      // A message sent now leaves the list at the click, so the next one moves under the pointer:
                      // the second click of a double click must not send that one too.
                      onClick={(event) => { if (event.detail <= 1) void queue.steer(item.id) }}
                    >
                      <ArrowTurnForward size={14} strokeWidth={1.8} />
                    </button>
                    {canEditQueued(item) && (
                      <button
                        type="button"
                        className="queued-message-btn"
                        title="Edit"
                        aria-label="Edit queued message"
                        disabled={busy}
                        onClick={() => startEdit(item)}
                      >
                        <Pencil size={14} strokeWidth={1.8} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="queued-message-btn"
                      title="Remove"
                      aria-label="Remove queued message"
                      disabled={busy}
                      onClick={() => void queue.remove(item.id)}
                    >
                      <Trash2 size={14} strokeWidth={1.8} />
                    </button>
                  </span>
                  {label}
                </div>
              </>
            )}
          </div>
        )
      })}
      </div>
      </div>
      {folds && (
        <button
          type="button"
          className="queued-messages-toggle"
          aria-expanded={showAll}
          aria-controls={listId}
          onClick={() => { if (showAll) afterTurns.closing(); setShowAll(!showAll) }}
        >
          {showAll ? 'Show less' : `Show all ${shown.length} queued`}
          {showAll ? <ChevronUp size={12} strokeWidth={2} aria-hidden="true" /> : <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />}
        </button>
      )}
    </div>
  )
}

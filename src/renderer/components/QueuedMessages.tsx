import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { QueuedMessage } from '../../shared/types'
import { ArrowTurnForward, Check, GripVertical, Loader2, Pencil, Trash2, X } from '../lib/icons'
import { shortTokens } from '../lib/promptCache'
import { mousseToUIMessages } from '../chat/adapters/mousseToUI'
import { UserMessage } from '../chat/components/agent-elements/user-message'
import { SubagentNotice } from '../chat/components/agent-elements/tools/SubagentNotice'
import { isOptimisticQueueItem, type ThreadQueue } from '../hooks/useThreadQueue'
import '../styles/queued-messages.css'

// Where the composer's markers start: attached files, voice messages, browser elements, references.
// The composer writes what was typed first and these after it; the agent reads them, the bubble hides them.
const MARKER_START = /\[(?:Attached files: |Voice message \(|Selected browser element\]|Mousse references data=")/

/** A queued message's content split into the text a person typed and the composer markers after it. */
export function splitQueuedContent(content: string): { text: string; markers: string } {
  const at = content.search(MARKER_START)
  if (at < 0) return { text: content.trim(), markers: '' }
  return { text: content.slice(0, at).trim(), markers: content.slice(at).trim() }
}

/** `content` with its typed text replaced by `text`; the markers are kept as they are. */
export function queuedContentWithText(content: string, text: string): string {
  return [text.trim(), splitQueuedContent(content).markers].filter(Boolean).join('\n\n')
}

/** Whether the queue lets this item's text change: a pending message a person wrote. */
export function canEditQueued(item: QueuedMessage): boolean {
  return !isOptimisticQueueItem(item) &&
    item.state === 'pending' &&
    item.intent !== 'steer' &&
    !item.subagentNotice?.length &&
    !item.inboxIds?.length &&
    !item.workflowInvocationId
}

const isSteering = (item: QueuedMessage) => item.intent === 'steer' || item.state === 'steering'

/** Send now on the first message a compaction holds: it stops the compaction and sends with the full history. */
export function skipCompactionLabel(historyTokens?: number): string {
  return historyTokens ? `Send now: skip compacting and keep the full ${shortTokens(historyTokens)} history` : 'Send now: skip compacting and keep the full history'
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

/** An open edit: the draft, and the content it started from (`base`), which a save expects the message still has. */
interface EditState {
  id: string
  width: number | null
  base: string
  draft: string
}

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
 * One quiet "Queued" on the last line speaks for the group.
 *
 * While a compaction holds the queue, "Queued" has a small spinner, and Send now on the first message skips
 * the compaction: it stops (nothing is cut) and that message goes with the full history.
 */
export function QueuedMessages({ queue }: { queue: ThreadQueue }) {
  const { items, busyIds, hold } = queue
  const [editing, setEditing] = useState<EditState | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
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

  // The item being edited left the queue or started (it was sent, or removed elsewhere): nothing to edit, and a
  // draft with changes of its own goes to the composer, so it is not lost. Its text changed elsewhere while the
  // draft has no changes of its own: the draft follows it.
  useEffect(() => {
    if (!editing) return
    const item = items.find((entry) => entry.id === editing.id)
    if (!item || !canEditQueued(item)) {
      const draft = editing.draft.trim()
      if (draft && draft !== splitQueuedContent(editing.base).text) queue.moveDraftToComposer(draft)
      setEditing(null)
      return
    }
    if (item.content !== editing.base && editing.draft === splitQueuedContent(editing.base).text) {
      setEditing({ ...editing, base: item.content, draft: splitQueuedContent(item.content).text })
    }
  }, [items, editing, queue])

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
    setEditing({ id: item.id, width: width ? Math.ceil(width) + 8 : null, base: item.content, draft: splitQueuedContent(item.content).text })
  }
  const updateEdit = (id: string, patch: Partial<EditState>) => setEditing((current) => (current?.id === id ? { ...current, ...patch } : current))
  const saveEdit = async (item: QueuedMessage, base: string, text: string) => {
    const content = queuedContentWithText(item.content, text)
    if (content === item.content) { setEditing(null); return }
    setSavingId(item.id)
    // Saved only if the message still has the text this edit started from; otherwise the line says it changed.
    const outcome = await queue.edit(item.id, content, base)
    setSavingId(null)
    if (outcome === 'saved') setEditing((current) => (current?.id === item.id ? null : current))
  }

  return (
    <div
      ref={groupRef}
      className="queued-messages"
      role="list"
      aria-label="Queued messages"
      data-find-ignore
      onDragOver={(event) => { if (dragId) event.preventDefault() }}
      onDrop={(event) => { if (!dragId) return; event.preventDefault(); dropDrag() }}
    >
      {shown.map((item, index) => {
        const optimistic = isOptimisticQueueItem(item)
        const busy = optimistic || Boolean(busyIds[item.id])
        const steering = isSteering(item)
        const last = index === shown.length - 1
        const canDrag = ids.length > 1 && !optimistic && !busy
        const edit = editing?.id === item.id ? editing : null
        // While a compaction holds the queue, the first message's Send now skips it.
        const skipsCompaction = hold !== null && item.id === firstHeldId
        const sendLabel = steering ? 'Sending now…' : skipsCompaction ? skipCompactionLabel(hold?.historyTokens) : 'Send now'
        const label = !last ? null : hold
          ? <span className="queued-message-state is-held" title="Sends after compacting"><Loader2 size={12} className="animate-spin" aria-hidden="true" />Queued</span>
          : <span className="queued-message-state" title="Sends when the current reply ends">Queued</span>
        return (
          <div
            key={item.id}
            role="listitem"
            className={['queued-message', dragId === item.id ? 'is-dragging' : '', edit ? 'is-editing' : ''].filter(Boolean).join(' ')}
            data-queued-id={item.id}
            draggable={armedId === item.id}
            onDragStart={(event) => onDragStart(event, item.id)}
            onDragOver={(event) => onDragOverItem(event, item.id)}
            onDragEnd={endDrag}
          >
            {edit ? (
              <QueuedEditor
                draft={edit.draft}
                width={edit.width}
                saving={savingId === item.id}
                canBeEmpty={Boolean(item.images?.length || splitQueuedContent(item.content).markers)}
                changed={savingId !== item.id && item.content !== edit.base && edit.draft !== splitQueuedContent(edit.base).text}
                label={label}
                onDraftChange={(draft) => updateEdit(item.id, { draft })}
                onLoadChanged={() => updateEdit(item.id, { base: item.content, draft: splitQueuedContent(item.content).text })}
                onKeepDraft={() => updateEdit(item.id, { base: item.content })}
                onSave={(text) => void saveEdit(item, edit.base, text)}
                onCancel={() => setEditing(null)}
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
                      aria-label={steering ? 'Sending the queued message now' : skipsCompaction ? sendLabel : 'Send the queued message now'}
                      disabled={busy || steering}
                      onClick={() => void queue.steer(item.id)}
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
  )
}

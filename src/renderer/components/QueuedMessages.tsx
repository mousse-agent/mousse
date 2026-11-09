import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { QueuedMessage } from '../../shared/types'
import { ArrowTurnForward, Check, GripVertical, Pencil, Trash2, X } from '../lib/icons'
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
  initial: string
  width: number | null
  saving: boolean
  canBeEmpty: boolean
  /** The group's "Queued" label when this is the last item. */
  label?: ReactNode
  onSave: (text: string) => void
  onCancel: () => void
}

/** Edit in place: a small editor where the bubble was. Enter saves, Shift+Enter adds a line, Escape cancels. */
function QueuedEditor({ initial, width, saving, canBeEmpty, label, onSave, onCancel }: EditorProps) {
  const [draft, setDraft] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  const canSave = !saving && (canBeEmpty || draft.trim().length > 0)
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
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="queued-message-line is-editing">
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
 */
export function QueuedMessages({ queue }: { queue: ThreadQueue }) {
  const { items, busyIds } = queue
  const [editing, setEditing] = useState<{ id: string; width: number | null } | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  // Drag to reorder starts only from the grip (`armedId`), so the text stays selectable. While dragging
  // the list reorders live under the pointer (`dragOrder`); letting go saves the order.
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

  // The item being edited left the queue (it was sent or removed elsewhere): nothing to edit.
  useEffect(() => {
    if (editing && !items.some((item) => item.id === editing.id)) setEditing(null)
  }, [items, editing])

  if (items.length === 0) return null

  const updateDragOrder = (next: string[] | null) => {
    dragOrderRef.current = next
    setDragOrder(next)
  }
  const finishDrag = () => {
    const order = dragOrderRef.current
    updateDragOrder(null)
    setDragId(null)
    setArmedId(null)
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
  const startEdit = (id: string) => {
    const bubble = groupRef.current?.querySelector<HTMLElement>(`[data-queued-id="${CSS.escape(id)}"] .chat-user-bubble`)
    // A few pixels over the bubble's width, so a line that just fits it does not wrap in the field.
    const width = bubble?.getBoundingClientRect().width
    setEditing({ id, width: width ? Math.ceil(width) + 8 : null })
  }
  const saveEdit = async (item: QueuedMessage, text: string) => {
    const content = queuedContentWithText(item.content, text)
    if (content === item.content) { setEditing(null); return }
    setSavingId(item.id)
    const saved = await queue.edit(item.id, content)
    setSavingId(null)
    if (saved) setEditing((current) => (current?.id === item.id ? null : current))
  }

  return (
    <div
      ref={groupRef}
      className="queued-messages"
      role="list"
      aria-label="Queued messages"
      data-find-ignore
      onDragOver={(event) => { if (dragId) event.preventDefault() }}
      onDrop={(event) => { if (!dragId) return; event.preventDefault(); finishDrag() }}
    >
      {shown.map((item, index) => {
        const optimistic = isOptimisticQueueItem(item)
        const busy = optimistic || Boolean(busyIds[item.id])
        const steering = isSteering(item)
        const last = index === shown.length - 1
        const canDrag = ids.length > 1 && !optimistic && !busy
        const isEditing = editing?.id === item.id
        const sendLabel = steering ? 'Sending now…' : 'Send now'
        const label = last ? <span className="queued-message-state" title="Sends when the current reply ends">Queued</span> : null
        return (
          <div
            key={item.id}
            role="listitem"
            className={['queued-message', dragId === item.id ? 'is-dragging' : '', isEditing ? 'is-editing' : ''].filter(Boolean).join(' ')}
            data-queued-id={item.id}
            draggable={armedId === item.id}
            onDragStart={(event) => onDragStart(event, item.id)}
            onDragOver={(event) => onDragOverItem(event, item.id)}
            onDragEnd={finishDrag}
          >
            {isEditing ? (
              <QueuedEditor
                initial={splitQueuedContent(item.content).text}
                width={editing.width}
                saving={savingId === item.id}
                canBeEmpty={Boolean(item.images?.length || splitQueuedContent(item.content).markers)}
                label={label}
                onSave={(text) => void saveEdit(item, text)}
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
                      aria-label={steering ? 'Sending the queued message now' : 'Send the queued message now'}
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
                        onClick={() => startEdit(item.id)}
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

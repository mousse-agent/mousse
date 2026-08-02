import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { GripVertical, MoreHorizontal, Trash2, X } from 'lucide-react'
import type { QueuedMessage } from '../../shared/types'

export interface QueuedMessagesProps {
  threadId: string | null
  optimisticItems?: QueuedMessage[]
  onOptimisticItemReconciled?: (id: string) => void
  /** Insert queued text into the composer (does not remove the item). */
  onUseInComposer?: (content: string) => void
}

function previewText(item: QueuedMessage): string {
  const raw = item.content.trim() || (item.images?.length ? 'Image attachment' : 'Empty message')
  const singleLine = raw.replace(/\s+/g, ' ')
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}…` : singleLine
}

function reorderByIds(items: QueuedMessage[], orderedIds: string[]): QueuedMessage[] {
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

function moveIndex(ids: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return ids
  const next = [...ids]
  const [removed] = next.splice(from, 1)
  next.splice(to, 0, removed)
  return next
}

export function QueuedMessages({
  threadId,
  optimisticItems = [],
  onOptimisticItemReconciled,
  onUseInComposer
}: QueuedMessagesProps) {
  const listId = useId()
  const [items, setItems] = useState<QueuedMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({})
  const itemsRef = useRef(items)
  itemsRef.current = items
  const dragFromIndexRef = useRef<number | null>(null)

  const loadQueue = useCallback(async (id: string) => {
    try {
      const list = await window.mousse.queue.list(id)
      setItems(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load queue')
    }
  }, [])

  useEffect(() => {
    if (!threadId) {
      setItems([])
      setError(null)
      setMenuOpenId(null)
      return
    }
    setItems([])
    setMenuOpenId(null)
    void loadQueue(threadId)

    const unsub = window.mousse.queue.onUpdated(({ threadId: updatedId, items: next }) => {
      if (updatedId !== threadId) return
      setItems(next)
      setError(null)
    })
    return unsub
  }, [threadId, loadQueue])

  useEffect(() => {
    if (!onOptimisticItemReconciled) return
    for (const optimistic of optimisticItems) {
      if (items.some((item) => item.id === optimistic.id)) {
        onOptimisticItemReconciled(optimistic.id)
      }
    }
  }, [items, optimisticItems, onOptimisticItemReconciled])

  useEffect(() => {
    if (!menuOpenId) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest?.('[data-queue-menu-root]')) return
      setMenuOpenId(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpenId(null)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpenId])

  const applyReorder = useCallback(
    async (orderedIds: string[]) => {
      if (!threadId) return
      const previous = itemsRef.current
      setItems(reorderByIds(previous, orderedIds))
      try {
        const next = await window.mousse.queue.reorder(threadId, orderedIds)
        setItems(next)
        setError(null)
      } catch (err) {
        setItems(previous)
        setError(err instanceof Error ? err.message : 'Could not reorder queue')
        void loadQueue(threadId)
      }
    },
    [threadId, loadQueue]
  )

  const handleRemove = async (itemId: string) => {
    if (!threadId) return
    setBusyIds((current) => ({ ...current, [itemId]: true }))
    try {
      await window.mousse.queue.remove(threadId, itemId)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove queued message')
      void loadQueue(threadId)
    } finally {
      setBusyIds((current) => {
        const next = { ...current }
        delete next[itemId]
        return next
      })
    }
  }

  const handleSteer = async (itemId: string) => {
    if (!threadId) return
    setBusyIds((current) => ({ ...current, [itemId]: true }))
    setError(null)
    try {
      const ok = await window.mousse.queue.promoteToSteer(threadId, itemId)
      if (!ok) {
        setError('Could not steer — the turn may have ended. The message remains in the queue.')
        void loadQueue(threadId)
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not steer — the turn may have ended. The message remains in the queue.'
      )
      void loadQueue(threadId)
    } finally {
      setBusyIds((current) => {
        const next = { ...current }
        delete next[itemId]
        return next
      })
    }
  }

  const handleMove = async (itemId: string, direction: -1 | 1) => {
    const ids = items.map((item) => item.id)
    const index = ids.indexOf(itemId)
    if (index === -1) return
    const target = index + direction
    if (target < 0 || target >= ids.length) return
    setMenuOpenId(null)
    await applyReorder(moveIndex(ids, index, target))
  }

  const handleCopy = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setMenuOpenId(null)
    } catch {
      setError('Could not copy to clipboard')
    }
  }

  const onDragStart = (event: React.DragEvent, itemId: string, index: number) => {
    dragFromIndexRef.current = index
    setDragId(itemId)
    setDropTargetId(itemId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', itemId)
    // Improve drag image stability in Chromium.
    if (event.currentTarget instanceof HTMLElement) {
      event.dataTransfer.setDragImage(event.currentTarget, 16, 16)
    }
  }

  const onDragOver = (event: React.DragEvent, itemId: string) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropTargetId !== itemId) setDropTargetId(itemId)
  }

  const onDrop = (event: React.DragEvent, targetId: string) => {
    event.preventDefault()
    const sourceId = dragId ?? event.dataTransfer.getData('text/plain')
    setDragId(null)
    setDropTargetId(null)
    dragFromIndexRef.current = null
    if (!sourceId || sourceId === targetId) return
    const ids = items.map((item) => item.id)
    const from = ids.indexOf(sourceId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    void applyReorder(moveIndex(ids, from, to))
  }

  const onDragEnd = () => {
    setDragId(null)
    setDropTargetId(null)
    dragFromIndexRef.current = null
  }

  const displayedItems = [
    ...items,
    ...optimisticItems.filter((optimistic) =>
      optimistic.threadId === threadId && !items.some((item) => item.id === optimistic.id)
    )
  ]

  if (!threadId || displayedItems.length === 0) {
    return error ? (
      <div className="queued-messages-error" role="status">
        {error}
        <button type="button" className="queued-messages-error-dismiss" onClick={() => setError(null)} aria-label="Dismiss">
          <X size={12} strokeWidth={2} />
        </button>
      </div>
    ) : null
  }

  return (
    <div className="queued-messages" aria-label="Queued messages">
      {error && (
        <div className="queued-messages-error" role="status">
          {error}
          <button
            type="button"
            className="queued-messages-error-dismiss"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      )}
      <ul id={listId} className="queued-messages-list" role="list">
        {displayedItems.map((item, index) => {
          const optimistic = item.id.startsWith('optimistic:')
          const busy = optimistic || Boolean(busyIds[item.id])
          const isDragging = dragId === item.id
          const isDropTarget = dropTargetId === item.id && dragId !== null && dragId !== item.id
          return (
            <li
              key={item.id}
              className={[
                'queued-messages-row',
                isDragging ? 'is-dragging' : '',
                isDropTarget ? 'is-drop-target' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              draggable={!busy}
              onDragStart={(event) => onDragStart(event, item.id, index)}
              onDragOver={(event) => onDragOver(event, item.id)}
              onDrop={(event) => onDrop(event, item.id)}
              onDragEnd={onDragEnd}
              aria-grabbed={isDragging}
            >
              <span className="queued-messages-handle" aria-hidden="true" title="Drag to reorder">
                <GripVertical size={14} strokeWidth={2} />
              </span>
              <div className="queued-messages-preview" title={item.content}>
                <span className="queued-messages-preview-text">{previewText(item)}</span>
                {item.images && item.images.length > 0 && (
                  <span className="queued-messages-meta">{item.images.length} image{item.images.length === 1 ? '' : 's'}</span>
                )}
              </div>
              <div className="queued-messages-actions">
                <button
                  type="button"
                  className="queued-messages-btn queued-messages-btn-steer"
                  onClick={() => void handleSteer(item.id)}
                  disabled={busy}
                  title="Steer active turn with this message"
                  aria-label="Steer with queued message"
                >
                  Steer
                </button>
                <button
                  type="button"
                  className="queued-messages-btn queued-messages-btn-icon"
                  onClick={() => void handleRemove(item.id)}
                  disabled={busy}
                  title="Remove from queue"
                  aria-label="Remove queued message"
                >
                  <Trash2 size={14} strokeWidth={2} />
                </button>
                <div className="queued-messages-menu" data-queue-menu-root>
                  <button
                    type="button"
                    className="queued-messages-btn queued-messages-btn-icon"
                    aria-haspopup="menu"
                    aria-expanded={menuOpenId === item.id}
                    aria-label="More queue actions"
                    title="More actions"
                    disabled={busy}
                    onClick={() => setMenuOpenId((current) => (current === item.id ? null : item.id))}
                  >
                    <MoreHorizontal size={14} strokeWidth={2} />
                  </button>
                  {menuOpenId === item.id && (
                    <div className="queued-messages-menu-panel" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="queued-messages-menu-item"
                        onClick={() => void handleCopy(item.content)}
                      >
                        Copy text
                      </button>
                      {onUseInComposer && (
                        <button
                          type="button"
                          role="menuitem"
                          className="queued-messages-menu-item"
                          onClick={() => {
                            onUseInComposer(item.content)
                            setMenuOpenId(null)
                          }}
                        >
                          Use in composer
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        className="queued-messages-menu-item"
                        disabled={index === 0}
                        onClick={() => void handleMove(item.id, -1)}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="queued-messages-menu-item"
                        disabled={optimistic || index >= displayedItems.length - 1}
                        onClick={() => void handleMove(item.id, 1)}
                      >
                        Move down
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

import { v4 as uuidv4 } from 'uuid'
import type {
  ChatImageAttachment,
  ChatMode,
  QueuedMessage,
  QueuedMessageIntent,
  QueuedMessageState
} from '../../shared/types'
import { normalizeChatMode } from '../../shared/chatMode'

export interface EnqueueMessageInput {
  threadId: string
  content: string
  mode?: ChatMode
  images?: ChatImageAttachment[]
  intent?: QueuedMessageIntent
  source?: string
}

export class QueueValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueueValidationError'
  }
}

function nextOrder(items: QueuedMessage[]): number {
  if (items.length === 0) return 0
  return Math.max(...items.map((item) => item.order)) + 1
}

/** Normalize and clone a durable queue snapshot (drops invalid entries). */
export function normalizeQueuedMessages(raw: unknown, threadId?: string): QueuedMessage[] {
  if (!Array.isArray(raw)) return []
  const out: QueuedMessage[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Partial<QueuedMessage>
    if (typeof item.id !== 'string' || !item.id.trim()) continue
    if (typeof item.threadId !== 'string' || !item.threadId.trim()) continue
    if (threadId && item.threadId !== threadId) continue
    if (typeof item.content !== 'string') continue
    const intent: QueuedMessageIntent =
      item.intent === 'steer' || item.intent === 'normal' ? item.intent : 'normal'
    const state: QueuedMessageState =
      item.state === 'pending' ||
      item.state === 'steering' ||
      item.state === 'drained' ||
      item.state === 'removed'
        ? item.state
        : 'pending'
    if (state === 'drained' || state === 'removed') continue
    out.push({
      id: item.id,
      threadId: item.threadId,
      content: item.content,
      mode: item.mode !== undefined ? normalizeChatMode(item.mode) : undefined,
      images: Array.isArray(item.images) ? item.images : undefined,
      enqueuedAt:
        typeof item.enqueuedAt === 'string' && item.enqueuedAt
          ? item.enqueuedAt
          : new Date().toISOString(),
      order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : out.length,
      intent,
      state,
      source: typeof item.source === 'string' ? item.source : undefined
    })
  }
  return sortQueue(out)
}

export function sortQueue(items: QueuedMessage[]): QueuedMessage[] {
  return [...items].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return a.enqueuedAt.localeCompare(b.enqueuedAt) || a.id.localeCompare(b.id)
  })
}

export function listPendingQueue(items: QueuedMessage[]): QueuedMessage[] {
  return sortQueue(items.filter((item) => item.state === 'pending' || item.state === 'steering'))
}

export function enqueueMessage(
  items: QueuedMessage[],
  input: EnqueueMessageInput
): { items: QueuedMessage[]; item: QueuedMessage } {
  const content = input.content.trim()
  if (!content && !(input.images && input.images.length > 0)) {
    throw new QueueValidationError('Queued message content is required.')
  }
  if (!input.threadId.trim()) {
    throw new QueueValidationError('threadId is required.')
  }

  const item: QueuedMessage = {
    id: uuidv4(),
    threadId: input.threadId,
    content: input.content,
    mode: input.mode !== undefined ? normalizeChatMode(input.mode) : undefined,
    images: input.images?.filter((img) => img.data && img.mimeType),
    enqueuedAt: new Date().toISOString(),
    order: nextOrder(items),
    intent: input.intent ?? 'normal',
    state: 'pending',
    source: input.source
  }

  return { items: sortQueue([...items, item]), item }
}

export function removeQueuedMessage(
  items: QueuedMessage[],
  id: string
): { items: QueuedMessage[]; removed: QueuedMessage | null } {
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) return { items, removed: null }
  const removed = items[index]
  return {
    items: items.filter((item) => item.id !== id),
    removed
  }
}

/**
 * Reorder pending queue items. `orderedIds` must be a permutation of the current
 * pending (non-steer-in-flight optional) item ids for the thread.
 */
export function reorderQueuedMessages(
  items: QueuedMessage[],
  orderedIds: string[]
): QueuedMessage[] {
  const pending = listPendingQueue(items)
  const pendingIds = pending.map((item) => item.id)

  if (orderedIds.length !== pendingIds.length || new Set(orderedIds).size !== orderedIds.length) {
    throw new QueueValidationError(
      'Reorder requires a permutation of all pending queue item ids (no missing, extra, or duplicates).'
    )
  }
  for (const id of orderedIds) {
    if (!pendingIds.includes(id)) {
      throw new QueueValidationError(`Unknown queue item id in reorder: ${id}`)
    }
  }

  const byId = new Map(pending.map((item) => [item.id, item]))
  const reordered = orderedIds.map((id, order) => ({
    ...byId.get(id)!,
    order
  }))
  return sortQueue(reordered)
}

/** Promote a pending normal queue item to steer intent for the active turn. */
export function promoteQueuedMessageToSteer(
  items: QueuedMessage[],
  id: string
): { items: QueuedMessage[]; item: QueuedMessage } {
  const index = items.findIndex((entry) => entry.id === id)
  if (index === -1) {
    throw new QueueValidationError(`Queue item not found: ${id}`)
  }
  const current = items[index]
  if (current.state !== 'pending' && current.state !== 'steering') {
    throw new QueueValidationError(`Queue item ${id} is not pending.`)
  }
  const item: QueuedMessage = {
    ...current,
    intent: 'steer',
    state: 'steering'
  }
  const next = [...items]
  next[index] = item
  return { items: sortQueue(next), item }
}

/** Convert a free-form steer text into a transient steer queue entry (not persisted after accept). */
export function createSteerItem(threadId: string, content: string, source?: string): QueuedMessage {
  const trimmed = content.trim()
  if (!trimmed) {
    throw new QueueValidationError('Steer content is required.')
  }
  return {
    id: uuidv4(),
    threadId,
    content: trimmed,
    enqueuedAt: new Date().toISOString(),
    order: 0,
    intent: 'steer',
    state: 'steering',
    source
  }
}

/** FIFO drain of the next normal pending item (skips steer-intent entries). */
export function drainNextNormal(
  items: QueuedMessage[]
): { items: QueuedMessage[]; next: QueuedMessage | null } {
  const pending = listPendingQueue(items)
  const next = pending.find((item) => item.intent === 'normal' && item.state === 'pending') ?? null
  if (!next) return { items: listPendingQueue(items), next: null }
  return {
    items: items.filter((item) => item.id !== next.id),
    next
  }
}

/** Drop all steer-intent items after they have been injected into the active turn. */
export function dropSteerItems(items: QueuedMessage[], ids?: string[]): QueuedMessage[] {
  if (!ids || ids.length === 0) {
    return items.filter((item) => item.intent !== 'steer')
  }
  const drop = new Set(ids)
  return items.filter((item) => !(item.intent === 'steer' && drop.has(item.id)))
}

/** Clear all pending normal items (optional stop contract). */
export function clearPendingQueue(items: QueuedMessage[]): QueuedMessage[] {
  return []
}

import { v4 as uuidv4 } from 'uuid'
import type {
  ChatImageAttachment,
  ChatMode,
  QueuedMessage,
  QueuedMessageClaim,
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
  internal?: boolean
}

export interface ClaimOwnerInput {
  ownerPid: number
  ownerToken: string
  claimedAt?: string
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

function normalizeClaim(raw: unknown): QueuedMessageClaim | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const claim = raw as Partial<QueuedMessageClaim>
  if (
    typeof claim.ownerPid !== 'number' ||
    !Number.isInteger(claim.ownerPid) ||
    claim.ownerPid <= 0
  ) {
    return undefined
  }
  if (typeof claim.ownerToken !== 'string' || !claim.ownerToken.trim()) return undefined
  return {
    ownerPid: claim.ownerPid,
    ownerToken: claim.ownerToken,
    claimedAt:
      typeof claim.claimedAt === 'string' && claim.claimedAt
        ? claim.claimedAt
        : new Date().toISOString(),
    source: typeof claim.source === 'string' ? claim.source : undefined
  }
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
    const recognizedState: QueuedMessageState | null =
      item.state === 'pending' ||
      item.state === 'steering' ||
      item.state === 'claimed' ||
      item.state === 'drained' ||
      item.state === 'removed'
        ? item.state
        : null
    // Never silently coerce a recognized claimed item (or any known terminal state).
    // Unknown/missing state defaults to pending for legacy rows only.
    if (recognizedState === 'drained' || recognizedState === 'removed') continue
    const state: QueuedMessageState = recognizedState ?? 'pending'
    const claim = state === 'claimed' ? normalizeClaim(item.claim) : undefined
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
      claim,
      source: typeof item.source === 'string' ? item.source : undefined,
      internal: item.internal === true ? true : undefined
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

/** User-mutable pending work only — claimed items are excluded. */
export function listPendingQueue(items: QueuedMessage[]): QueuedMessage[] {
  return sortQueue(items.filter((item) => item.state === 'pending' || item.state === 'steering'))
}

/** Claimed normal items still reserved by an owner. */
export function listClaimedQueue(items: QueuedMessage[]): QueuedMessage[] {
  return sortQueue(items.filter((item) => item.state === 'claimed'))
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
    source: input.source,
    internal: input.internal === true ? true : undefined
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
  // Claimed and internal items are not user-mutable pending work.
  if (removed.state === 'claimed' || removed.internal) {
    return { items, removed: null }
  }
  return {
    items: items.filter((item) => item.id !== id),
    removed
  }
}

/**
 * Reorder pending queue items. `orderedIds` must be a permutation of the current
 * pending item ids. Claimed items keep their original order values.
 * Pending items are reassigned across the existing pending order slots so claimed
 * orders (including 0) never collide with a renumbered pending head.
 */
export function reorderQueuedMessages(
  items: QueuedMessage[],
  orderedIds: string[]
): QueuedMessage[] {
  const pending = listPendingQueue(items).filter((item) => !item.internal)
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

  // Preserve the multiset of pending order slots; only the id→slot assignment changes.
  const orderSlots = pending.map((item) => item.order)
  const byId = new Map(pending.map((item) => [item.id, item]))
  const reordered = orderedIds.map((id, index) => ({
    ...byId.get(id)!,
    order: orderSlots[index]!
  }))
  const preserved = items.filter((item) => item.state === 'claimed' || item.internal)
  return sortQueue([...preserved, ...reordered])
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
  if (current.internal) {
    throw new QueueValidationError(`Queue item ${id} is internal.`)
  }
  if (current.state !== 'pending' && current.state !== 'steering') {
    throw new QueueValidationError(`Queue item ${id} is not pending.`)
  }
  const item: QueuedMessage = {
    ...current,
    intent: 'steer',
    state: 'steering',
    claim: undefined
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

/**
 * Atomically claim the next normal pending item for execution.
 * Preserves original FIFO order; does not remove the item.
 */
export function claimNextNormal(
  items: QueuedMessage[],
  owner: ClaimOwnerInput
): { items: QueuedMessage[]; claimed: QueuedMessage | null } {
  const pending = listPendingQueue(items)
  const next =
    pending.find((item) => item.intent === 'normal' && item.state === 'pending') ?? null
  if (!next) return { items: sortQueue(items), claimed: null }

  const claim: QueuedMessageClaim = {
    ownerPid: owner.ownerPid,
    ownerToken: owner.ownerToken,
    claimedAt: owner.claimedAt ?? new Date().toISOString(),
    source: owner.source
  }
  const claimed: QueuedMessage = {
    ...next,
    state: 'claimed',
    claim
  }
  return {
    items: sortQueue(items.map((item) => (item.id === next.id ? claimed : item))),
    claimed
  }
}

/**
 * Release a claim back to pending at its original order.
 * When `ownerToken` is provided it must exactly match claim metadata; a claimed
 * item missing claim metadata cannot pass an ownership-checked release.
 */
export function releaseClaim(
  items: QueuedMessage[],
  id: string,
  opts?: { ownerToken?: string }
): { items: QueuedMessage[]; released: QueuedMessage | null } {
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) return { items, released: null }
  const current = items[index]
  if (current.state !== 'claimed') return { items, released: null }
  if (opts?.ownerToken !== undefined) {
    if (!current.claim || current.claim.ownerToken !== opts.ownerToken) {
      return { items, released: null }
    }
  }
  const released: QueuedMessage = {
    ...current,
    state: 'pending',
    claim: undefined
  }
  const next = [...items]
  next[index] = released
  return { items: sortQueue(next), released }
}

/**
 * Acknowledge/complete a claim after durable transcript acceptance — removes the item.
 * When `ownerToken` is provided it must exactly match claim metadata; a claimed
 * item missing claim metadata cannot pass an ownership-checked complete.
 */
export function completeClaim(
  items: QueuedMessage[],
  id: string,
  opts?: { ownerToken?: string }
): { items: QueuedMessage[]; completed: QueuedMessage | null } {
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) return { items, completed: null }
  const current = items[index]
  if (current.state !== 'claimed') return { items, completed: null }
  if (opts?.ownerToken !== undefined) {
    if (!current.claim || current.claim.ownerToken !== opts.ownerToken) {
      return { items, completed: null }
    }
  }
  return {
    items: items.filter((item) => item.id !== id),
    completed: current
  }
}

/**
 * Reclaim claims that are safe to settle.
 * Accepted provenance (durable transcript) is checked before owner liveness so a
 * failed queue-file completion can be removed while the process is still alive.
 * Unaccepted claims are released only when ownership is demonstrably stale/dead.
 */
export function reclaimAbandonedClaims(
  items: QueuedMessage[],
  options: {
    isOwnerLive: (claim: QueuedMessageClaim) => boolean
    isAccepted: (item: QueuedMessage) => boolean
  }
): {
  items: QueuedMessage[]
  released: QueuedMessage[]
  completed: QueuedMessage[]
} {
  const released: QueuedMessage[] = []
  const completed: QueuedMessage[] = []
  const next: QueuedMessage[] = []

  for (const item of items) {
    if (item.state !== 'claimed') {
      next.push(item)
      continue
    }

    // Provenance first: accepted claims complete regardless of owner liveness.
    if (options.isAccepted(item)) {
      completed.push(item)
      continue
    }

    const claim = item.claim
    if (claim && options.isOwnerLive(claim)) {
      next.push(item)
      continue
    }

    const restored: QueuedMessage = {
      ...item,
      state: 'pending',
      claim: undefined
    }
    released.push(restored)
    next.push(restored)
  }

  return { items: sortQueue(next), released, completed }
}

/**
 * FIFO drain of the next normal pending item (removes it).
 * Prefer `claimNextNormal` for durable execution paths.
 * Always preserves claimed entries in the returned items list.
 */
export function drainNextNormal(
  items: QueuedMessage[]
): { items: QueuedMessage[]; next: QueuedMessage | null } {
  const pending = listPendingQueue(items)
  const next = pending.find((item) => item.intent === 'normal' && item.state === 'pending') ?? null
  if (!next) return { items: sortQueue(items), next: null }
  return {
    items: sortQueue(items.filter((item) => item.id !== next.id)),
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

/** Recover steer intents that arrived after the active turn's final steer boundary. */
export function demoteSteerItems(items: QueuedMessage[]): QueuedMessage[] {
  return sortQueue(
    items.map((item) =>
      item.intent === 'steer' && item.state !== 'claimed'
        ? { ...item, intent: 'normal' as const, state: 'pending' as const, claim: undefined }
        : item
    )
  )
}

/**
 * Clear user-mutable pending work only.
 * Claimed entries are always retained so in-flight ownership is not clobbered.
 */
export function clearPendingQueue(items: QueuedMessage[]): QueuedMessage[] {
  return sortQueue(items.filter((item) => item.state === 'claimed' || item.internal))
}

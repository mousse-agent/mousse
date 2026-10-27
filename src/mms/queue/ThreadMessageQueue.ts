import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import type {
  AgentOrigin,
  ChatImageAttachment,
  ChatMode,
  QueuedMessage,
  QueuedMessageClaim,
  QueuedMessageIntent,
  QueuedMessageState
} from '../../shared/types'
import { normalizeChatMode } from '../../shared/chatMode'
import { isPermissionMode, type PermissionMode } from '../../shared/permissionMode'
import { WORKFLOW_UUID_PATTERN } from '../../shared/workflows'

export interface EnqueueMessageInput {
  /**
   * A fixed id for an item that must exist once however often it is written (the continue message of a
   * paused run). An item with this id already on the queue is returned unchanged.
   */
  id?: string
  /** Puts the item ahead of every pending item; claimed items keep their order. */
  atFront?: boolean
  /** The paused run this item continues (`QueuedMessage.continuationOfRunId`). */
  continuationOfRunId?: string
  threadId: string
  content: string
  workflowInvocationId?: string
  mode?: ChatMode
  images?: ChatImageAttachment[]
  intent?: QueuedMessageIntent
  source?: string
  internal?: boolean
  runId?: string
  inboxIds?: string[]
  subagentNotice?: QueuedMessage['subagentNotice']
  stopGeneration?: number
  permissionMode?: PermissionMode
  origin?: QueuedMessage['origin']
  sentFrom?: QueuedMessage['sentFrom']
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

/**
 * Why a change to the queue was refused because the queue is not as the caller last saw it. The code is
 * stable (agents act on it); `details` carry the ids and values the caller needs to read again.
 */
export type QueueConflictCode =
  | 'revision_mismatch'
  | 'queue_item_not_found'
  | 'item_steering'
  | 'run_not_active'
  | 'run_paused'
  | 'ceiling_exceeded'
  | 'questions_pending'
  | 'run_not_ready'
  | 'item_started'
  | 'request_conflict'
  | 'command_failed'

export class QueueConflictError extends Error {
  constructor(
    readonly code: QueueConflictCode,
    message: string,
    readonly details: Record<string, string | number | boolean | null> = {}
  ) {
    super(message)
    this.name = 'QueueConflictError'
  }
}

/** A change the caller's agent access does not allow (it is not a stale queue: reading again does not help). */
export class QueueAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueueAccessError'
  }
}

/**
 * A short digest of what a caller can act on: the pending, visible items with their order, intent, state,
 * modes, origin and a hash of the text. It changes with every change to those items (an add, edit, removal,
 * reorder, promotion, claim) and with nothing else (an internal item or a claimed one's heartbeat does not
 * move it), so a command that carries it fails instead of acting on a queue that changed after it was read.
 */
export function queueRevision(items: QueuedMessage[]): string {
  const rows = listPendingQueue(items)
    .filter((item) => !item.internal)
    .map((item) => [
      item.id,
      item.order,
      item.intent,
      item.state,
      item.mode ?? null,
      item.permissionMode ?? null,
      item.origin?.kind === 'agent' ? `agent:${item.origin.threadId}` : item.origin?.kind ?? null,
      createHash('sha256').update(item.content).digest('hex')
    ])
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16)
}

/** Throws a `revision_mismatch` conflict when `expected` is given and is not the queue's revision now. */
export function assertQueueRevision(items: QueuedMessage[], expected: string | undefined): void {
  if (expected === undefined) return
  const revision = queueRevision(items)
  if (revision !== expected)
    throw new QueueConflictError('revision_mismatch', 'The queue changed since you read it; read it again before changing it.', { expectedRevision: expected, revision })
}

function nextOrder(items: QueuedMessage[]): number {
  if (items.length === 0) return 0
  return Math.max(...items.map((item) => item.order)) + 1
}

/** One slot before every item, so a pending item written there is the next one claimed. */
function frontOrder(items: QueuedMessage[]): number {
  if (items.length === 0) return 0
  return Math.min(...items.map((item) => item.order)) - 1
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

/** The scheduled-job or agent origin of an item, or undefined when it is absent or malformed (dropped like any unknown field). */
function normalizeOrigin(raw: unknown): QueuedMessage['origin'] {
  if (!raw || typeof raw !== 'object') return undefined
  const kind = (raw as { kind?: unknown }).kind
  if (kind === 'agent') {
    const agent = raw as Partial<AgentOrigin>
    if (typeof agent.threadId !== 'string' || !agent.threadId || typeof agent.runId !== 'string' || !agent.runId) return undefined
    return { kind: 'agent', threadId: agent.threadId, runId: agent.runId, ...(typeof agent.hops === 'number' && Number.isSafeInteger(agent.hops) && agent.hops >= 0 ? { hops: agent.hops } : {}) }
  }
  const origin = raw as Partial<Extract<NonNullable<QueuedMessage['origin']>, { kind: 'schedule' }>>
  if (origin.kind !== 'schedule') return undefined
  if (typeof origin.jobId !== 'string' || !origin.jobId || typeof origin.occurrenceKey !== 'string' || !origin.occurrenceKey) return undefined
  const selection = origin.selection
  const validSelection = selection !== undefined && typeof selection === 'object' && selection !== null
    && typeof selection.llmProvider === 'string' && typeof selection.model === 'string'
    && (selection.instanceId === undefined || typeof selection.instanceId === 'string')
  return {
    kind: 'schedule',
    jobId: origin.jobId,
    occurrenceKey: origin.occurrenceKey,
    ...(typeof origin.jobName === 'string' && origin.jobName ? { jobName: origin.jobName } : {}),
    ...(validSelection ? { selection: structuredClone(selection) } : {})
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
    if (item.workflowInvocationId !== undefined && (typeof item.workflowInvocationId !== 'string' || !WORKFLOW_UUID_PATTERN.test(item.workflowInvocationId) || item.intent === 'steer')) throw new QueueValidationError('Invalid workflow queue receipt; refusing ordinary prompt fallback')
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
    const origin = normalizeOrigin(item.origin)
    out.push({
      id: item.id,
      threadId: item.threadId,
      content: item.content,
      workflowInvocationId: item.workflowInvocationId,
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
      internal: item.internal === true ? true : undefined,
      ...(typeof item.runId === 'string' && item.runId ? { runId: item.runId } : {}),
      ...(typeof item.continuationOfRunId === 'string' && item.continuationOfRunId ? { continuationOfRunId: item.continuationOfRunId } : {}),
      ...(Array.isArray(item.inboxIds) && item.inboxIds.length && item.inboxIds.every((id) => typeof id === 'string') ? { inboxIds: item.inboxIds } : {}),
      ...(Array.isArray(item.subagentNotice) && item.subagentNotice.length ? { subagentNotice: item.subagentNotice } : {}),
      ...(typeof item.stopGeneration === 'number' && Number.isSafeInteger(item.stopGeneration) && item.stopGeneration >= 0 ? { stopGeneration: item.stopGeneration } : {}),
      ...(isPermissionMode(item.permissionMode) ? { permissionMode: item.permissionMode } : {}),
      ...(typeof item.sentFrom?.node === 'string' && item.sentFrom.node ? { sentFrom: { node: item.sentFrom.node } } : {}),
      // Only a steering item is bound to a run.
      ...(state === 'steering' && typeof item.steerRunId === 'string' && item.steerRunId ? { steerRunId: item.steerRunId } : {}),
      ...(origin ? { origin } : {})
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

  if (input.workflowInvocationId) {
    if (!WORKFLOW_UUID_PATTERN.test(input.workflowInvocationId) || input.intent === 'steer') throw new QueueValidationError('Workflow commands cannot become steering input')
    const existing = items.find((item) => item.workflowInvocationId === input.workflowInvocationId)
    if (existing) {
      if (existing.threadId !== input.threadId || existing.content !== input.content) throw new QueueValidationError('Workflow queue identity conflict')
      return { items, item: existing }
    }
  }

  if (input.id) {
    const existing = items.find((item) => item.id === input.id)
    if (existing) return { items, item: existing }
  }

  const item: QueuedMessage = {
    id: input.id || uuidv4(),
    threadId: input.threadId,
    content: input.content,
    workflowInvocationId: input.workflowInvocationId,
    mode: input.mode !== undefined ? normalizeChatMode(input.mode) : undefined,
    images: input.images?.filter((img) => img.data && img.mimeType),
    enqueuedAt: new Date().toISOString(),
    order: input.atFront ? frontOrder(items) : nextOrder(items),
    intent: input.intent ?? 'normal',
    state: 'pending',
    source: input.source,
    internal: input.internal === true ? true : undefined,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.continuationOfRunId ? { continuationOfRunId: input.continuationOfRunId } : {}),
    ...(input.inboxIds?.length ? { inboxIds: input.inboxIds } : {}),
    ...(input.subagentNotice?.length ? { subagentNotice: input.subagentNotice } : {}),
    ...(input.stopGeneration !== undefined ? { stopGeneration: input.stopGeneration } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(input.sentFrom ? { sentFrom: input.sentFrom } : {}),
    ...(input.origin ? { origin: input.origin } : {})
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

/** What changes in an edit of a queued message; a field left out stays as it is. */
export interface QueuedMessagePatch {
  content?: string
  mode?: ChatMode
  /** Who the edited text is from: set when an agent wrote it, so the item never passes for a person's; null when a person rewrote an agent's message and it is theirs now. */
  origin?: AgentOrigin | null
  /** A mode the edited item must not exceed; it can only tighten what the item already had. */
  permissionMode?: PermissionMode
  /** The computer the edit came from: the text is theirs now. */
  sentFrom?: QueuedMessage['sentFrom']
  /**
   * The item no longer owns the queued run it had (the caller cancels it): the run was made for the earlier
   * sender, and the item gets a fresh one, with the new sender's count, when it drains.
   */
  dropRun?: boolean
}

/**
 * Why a queued item cannot be edited, or undefined when it can. A message that is already steering a live
 * turn, one a turn has claimed, an internal one, a workflow command and one that delivers subagent results
 * (rebuilt when it runs) are not text to edit.
 */
export function editRefusal(item: QueuedMessage): string | undefined {
  if (item.internal) return `Queue item ${item.id} is internal.`
  if (item.workflowInvocationId) return 'A workflow command cannot be edited.'
  if (item.inboxIds?.length) return 'A queued subagent result is rebuilt when it runs; it cannot be edited.'
  if (item.state === 'claimed') return `Queue item ${item.id} already started and can no longer be edited.`
  if (item.state !== 'pending' && item.state !== 'steering') return `Queue item ${item.id} is not pending.`
  return undefined
}

/**
 * Edit a pending queue item in place: its place in the order, id, images and state stay. Idempotent: an edit
 * that is already in effect changes nothing, which a recovered journal entry relies on.
 */
export function editQueuedMessage(
  items: QueuedMessage[],
  id: string,
  patch: QueuedMessagePatch
): { items: QueuedMessage[]; item: QueuedMessage } {
  const index = items.findIndex((entry) => entry.id === id)
  if (index === -1) throw new QueueConflictError('queue_item_not_found', `Queue item ${id} is not in the queue.`, { itemId: id })
  const current = items[index]
  if (current.state === 'steering') throw new QueueConflictError('item_steering', `Queue item ${id} is already steering the running turn; its text can no longer be edited.`, { itemId: id })
  const refusal = editRefusal(current)
  if (refusal) throw new QueueValidationError(refusal)
  let content = current.content
  if (patch.content !== undefined) {
    content = patch.content.trim()
    if (!content && !(current.images && current.images.length > 0)) throw new QueueValidationError('Queued message content is required.')
  }
  const { runId: _runId, ...withoutRun } = current
  const { origin: _origin, ...withoutOrigin } = patch.dropRun ? withoutRun : current
  const item: QueuedMessage = {
    ...(patch.origin === null ? withoutOrigin : patch.dropRun ? withoutRun : current),
    content,
    ...(patch.mode !== undefined ? { mode: normalizeChatMode(patch.mode) } : {}),
    ...(patch.origin ? { origin: patch.origin } : {}),
    ...(patch.permissionMode ? { permissionMode: patch.permissionMode } : {}),
    ...(patch.sentFrom ? { sentFrom: patch.sentFrom } : {})
  }
  const next = [...items]
  next[index] = item
  return { items: sortQueue(next), item }
}

/**
 * Promote a pending normal queue item to steer intent for the active turn. `steerRunId` binds the promotion
 * to the run it was checked against; `permissionMode` is the (narrowed) mode the item keeps from here on.
 */
export function promoteQueuedMessageToSteer(
  items: QueuedMessage[],
  id: string,
  bind?: { steerRunId?: string; permissionMode?: PermissionMode }
): { items: QueuedMessage[]; item: QueuedMessage } {
  const index = items.findIndex((entry) => entry.id === id)
  if (index === -1) {
    throw new QueueValidationError(`Queue item not found: ${id}`)
  }
  const current = items[index]
  if (current.workflowInvocationId) throw new QueueValidationError('A workflow command cannot be promoted to steering input')
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
    claim: undefined,
    ...(bind?.steerRunId ? { steerRunId: bind.steerRunId } : {}),
    ...(bind?.permissionMode ? { permissionMode: bind.permissionMode } : {})
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

/**
 * Recover steer intents that arrived after the active turn's final steer boundary: they become pending
 * messages again and run as turns of their own. `ids` limits it to those items; a demoted item keeps its
 * origin and mode but is no longer bound to a run.
 */
export function demoteSteerItems(items: QueuedMessage[], ids?: readonly string[]): QueuedMessage[] {
  const only = ids ? new Set(ids) : undefined
  return sortQueue(
    items.map((item) => {
      if (item.intent !== 'steer' || item.state === 'claimed' || (only && !only.has(item.id))) return item
      const { steerRunId: _steerRunId, ...rest } = item
      return { ...rest, intent: 'normal' as const, state: 'pending' as const, claim: undefined }
    })
  )
}

/**
 * Clear user-mutable pending work only.
 * Claimed entries are always retained so in-flight ownership is not clobbered.
 */
export function clearPendingQueue(items: QueuedMessage[]): QueuedMessage[] {
  return sortQueue(items.filter((item) => item.state === 'claimed' || item.internal))
}

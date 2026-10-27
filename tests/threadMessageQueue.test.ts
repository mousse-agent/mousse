// Pure queue tables: ordering, claims and recovery rules. No store, orchestrator or daemon.
import { describe, expect, it } from 'vitest'
import type { QueuedMessage } from '../src/shared/types'
import {
  assertQueueRevision,
  claimNextNormal,
  clearPendingQueue,
  completeClaim,
  demoteSteerItems,
  drainNextNormal,
  editQueuedMessage,
  dropSteerItems,
  enqueueMessage,
  listClaimedQueue,
  listPendingQueue,
  normalizeQueuedMessages,
  promoteQueuedMessageToSteer,
  QueueConflictError,
  queueRevision,
  QueueValidationError,
  reclaimAbandonedClaims,
  releaseClaim,
  removeQueuedMessage,
  reorderQueuedMessages
} from '../src/mms/queue/ThreadMessageQueue'

describe('ThreadMessageQueue domain', () => {
  it('enqueues FIFO with stable ids and order', () => {
    let items: ReturnType<typeof enqueueMessage>['items'] = []
    const a = enqueueMessage(items, { threadId: 't1', content: 'first' })
    items = a.items
    const b = enqueueMessage(items, { threadId: 't1', content: 'second' })
    items = b.items
    expect(listPendingQueue(items).map((i) => i.content)).toEqual(['first', 'second'])
    expect(a.item.id).not.toBe(b.item.id)
    expect(a.item.order).toBeLessThan(b.item.order)
  })

  it('keeps internal work durable but outside user queue mutations', () => {
    let items = enqueueMessage([], {
      threadId: 't1',
      content: 'automatic subagent report',
      source: 'wake',
      internal: true
    }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'user message' }).items

    const internal = items.find((item) => item.internal)!
    const visible = items.find((item) => !item.internal)!
    items = reorderQueuedMessages(items, [visible.id])

    expect(items.find((item) => item.id === internal.id)).toMatchObject({
      content: 'automatic subagent report',
      internal: true
    })
    expect(removeQueuedMessage(items, internal.id).removed).toBeNull()
    expect(() => promoteQueuedMessageToSteer(items, internal.id)).toThrow(/internal/i)
    expect(clearPendingQueue(items)).toEqual([expect.objectContaining({ id: internal.id })])
    expect(normalizeQueuedMessages(items, 't1').find((item) => item.id === internal.id)?.internal).toBe(true)
  })

  it('validates reorder and remove', () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'a' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'b' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'c' }).items
    const ids = listPendingQueue(items).map((i) => i.id)
    items = reorderQueuedMessages(items, [ids[2], ids[0], ids[1]])
    expect(listPendingQueue(items).map((i) => i.content)).toEqual(['c', 'a', 'b'])

    expect(() => reorderQueuedMessages(items, [ids[0]])).toThrow(QueueValidationError)
    expect(() => reorderQueuedMessages(items, [...ids, 'nope'])).toThrow(QueueValidationError)

    const removed = removeQueuedMessage(items, ids[0])
    expect(removed.removed?.content).toBe('a')
    expect(listPendingQueue(removed.items).map((i) => i.content)).toEqual(['c', 'b'])
  })

  it('promotes to steer and drains only normal items', () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'normal-1' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'normal-2' }).items
    const firstId = listPendingQueue(items)[0].id
    const promoted = promoteQueuedMessageToSteer(items, firstId)
    items = promoted.items
    expect(promoted.item.intent).toBe('steer')
    items = dropSteerItems(items, [firstId])
    const drained = drainNextNormal(items)
    expect(drained.next?.content).toBe('normal-2')
    expect(drainNextNormal(drained.items).next).toBeNull()
  })

  it('recovers a late steer as next-turn guidance', () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'late guidance' }).items
    items = promoteQueuedMessageToSteer(items, items[0].id).items
    const recovered = demoteSteerItems(items)
    expect(recovered[0]).toMatchObject({ intent: 'normal', state: 'pending' })
    expect(drainNextNormal(recovered).next?.content).toBe('late guidance')
  })

  it('claims, releases, and completes while preserving FIFO order', () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'first' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'second' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'third' }).items
    const firstOrder = items[0].order

    const claimed = claimNextNormal(items, {
      ownerPid: process.pid,
      ownerToken: 'tok-a',
      source: 'test'
    })
    items = claimed.items
    expect(claimed.claimed?.content).toBe('first')
    expect(claimed.claimed?.state).toBe('claimed')
    expect(claimed.claimed?.order).toBe(firstOrder)
    expect(claimed.claimed?.claim?.ownerToken).toBe('tok-a')
    expect(listPendingQueue(items).map((i) => i.content)).toEqual(['second', 'third'])
    expect(listClaimedQueue(items)).toHaveLength(1)

    // Release restores pending at original order — never a tail replacement id.
    const released = releaseClaim(items, claimed.claimed!.id, { ownerToken: 'tok-a' })
    items = released.items
    expect(released.released?.state).toBe('pending')
    expect(released.released?.order).toBe(firstOrder)
    expect(released.released?.id).toBe(claimed.claimed!.id)
    expect(listPendingQueue(items).map((i) => i.content)).toEqual(['first', 'second', 'third'])

    const claimedAgain = claimNextNormal(items, {
      ownerPid: process.pid,
      ownerToken: 'tok-b'
    })
    items = claimedAgain.items
    const completed = completeClaim(items, claimedAgain.claimed!.id, { ownerToken: 'tok-b' })
    expect(completed.completed?.id).toBe(claimedAgain.claimed!.id)
    expect(listPendingQueue(completed.items).map((i) => i.content)).toEqual(['second', 'third'])
  })

  it('does not treat claimed items as user-mutable pending work', () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'a' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'b' }).items
    const claim = claimNextNormal(items, {
      ownerPid: process.pid,
      ownerToken: 'owner'
    })
    items = claim.items
    const claimedId = claim.claimed!.id
    const pendingId = listPendingQueue(items)[0].id

    // remove / reorder / clear must leave the claim intact
    expect(removeQueuedMessage(items, claimedId).removed).toBeNull()
    expect(removeQueuedMessage(items, claimedId).items.find((i) => i.id === claimedId)?.state).toBe(
      'claimed'
    )

    items = reorderQueuedMessages(items, [pendingId])
    expect(items.find((i) => i.id === claimedId)?.state).toBe('claimed')
    expect(items.find((i) => i.id === claimedId)?.order).toBe(claim.claimed!.order)

    const cleared = clearPendingQueue(items)
    expect(cleared).toHaveLength(1)
    expect(cleared[0].id).toBe(claimedId)
    expect(cleared[0].state).toBe('claimed')
  })

  it('reorders pending across existing order slots without colliding with claimed order 0', () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'claimed-head' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'p1' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'p2' }).items
    const claimed = claimNextNormal(items, {
      ownerPid: process.pid,
      ownerToken: 'owner'
    })
    items = claimed.items
    expect(claimed.claimed?.order).toBe(0)

    const pending = listPendingQueue(items)
    expect(pending.map((i) => i.content)).toEqual(['p1', 'p2'])
    const slotsBefore = pending.map((i) => i.order)
    // Reverse pending order — must reuse slots, not renumber from 0.
    items = reorderQueuedMessages(items, [pending[1].id, pending[0].id])

    expect(items.find((i) => i.id === claimed.claimed!.id)?.order).toBe(0)
    expect(items.find((i) => i.id === claimed.claimed!.id)?.state).toBe('claimed')
    const pendingAfter = listPendingQueue(items)
    expect(pendingAfter.map((i) => i.content)).toEqual(['p2', 'p1'])
    expect(pendingAfter.map((i) => i.order)).toEqual(slotsBefore)

    // Release restores claimed head at order 0 ahead of reordered pending.
    const released = releaseClaim(items, claimed.claimed!.id, { ownerToken: 'owner' })
    expect(listPendingQueue(released.items).map((i) => i.content)).toEqual([
      'claimed-head',
      'p2',
      'p1'
    ])
  })

  it('ownership-checked release/complete require exact token and claim metadata', () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'x' }).items
    const claimed = claimNextNormal(items, {
      ownerPid: process.pid,
      ownerToken: 'real-token'
    })
    items = claimed.items

    expect(releaseClaim(items, claimed.claimed!.id, { ownerToken: 'wrong' }).released).toBeNull()
    expect(completeClaim(items, claimed.claimed!.id, { ownerToken: 'wrong' }).completed).toBeNull()

    // Malformed claimed item with no claim metadata cannot pass ownership-checked ops.
    const malformed = items.map((item) =>
      item.id === claimed.claimed!.id ? { ...item, claim: undefined } : item
    )
    expect(releaseClaim(malformed, claimed.claimed!.id, { ownerToken: 'real-token' }).released).toBeNull()
    expect(
      completeClaim(malformed, claimed.claimed!.id, { ownerToken: 'real-token' }).completed
    ).toBeNull()

    // Unchecked (no ownerToken) still works for recovery paths.
    expect(releaseClaim(malformed, claimed.claimed!.id).released?.state).toBe('pending')
  })

  it('drainNextNormal preserves claimed items when there is no next pending', () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'held' }).items
    items = claimNextNormal(items, {
      ownerPid: process.pid,
      ownerToken: 't'
    }).items
    const drained = drainNextNormal(items)
    expect(drained.next).toBeNull()
    expect(drained.items).toHaveLength(1)
    expect(drained.items[0].state).toBe('claimed')
    expect(drained.items[0].content).toBe('held')
  })

  it('never silently demotes recognized claimed state during normalization', () => {
    const raw = [
      {
        id: 'c1',
        threadId: 't1',
        content: 'held',
        enqueuedAt: '2020-01-01T00:00:00.000Z',
        order: 0,
        intent: 'normal',
        state: 'claimed',
        claim: {
          ownerPid: 42,
          ownerToken: 'alive-or-dead',
          claimedAt: '2020-01-01T00:00:01.000Z'
        }
      }
    ]
    const normalized = normalizeQueuedMessages(raw, 't1')
    expect(normalized).toHaveLength(1)
    expect(normalized[0].state).toBe('claimed')
    expect(normalized[0].claim?.ownerToken).toBe('alive-or-dead')
  })

  it('keeps a scheduled origin through a save and load, and drops a malformed one', () => {
    const origin = { kind: 'schedule' as const, jobId: 'job-1', jobName: 'Nightly', occurrenceKey: '2026-01-01T00:00:00.000Z', selection: { instanceId: 'codex', llmProvider: 'codex', model: 'm' } }
    const queued = enqueueMessage([], { threadId: 't1', content: 'run it', source: 'schedule', runId: 'run-1', origin }).items
    const [loaded] = normalizeQueuedMessages(JSON.parse(JSON.stringify(queued)), 't1')
    expect(loaded.origin).toEqual(origin)
    expect(loaded.runId).toBe('run-1')

    const base = { id: 'a', threadId: 't1', content: 'x', enqueuedAt: '2020-01-01T00:00:00.000Z', order: 0, intent: 'normal', state: 'pending' }
    expect(normalizeQueuedMessages([{ ...base, origin: { kind: 'schedule', jobId: 'job-1' } }], 't1')[0].origin).toBeUndefined()
    expect(normalizeQueuedMessages([{ ...base, origin: { kind: 'other', jobId: 'job-1', occurrenceKey: 'k' } }], 't1')[0].origin).toBeUndefined()
    expect(normalizeQueuedMessages([{ ...base, origin: 'schedule' }], 't1')[0].origin).toBeUndefined()
    // A malformed selection is dropped, the origin itself survives.
    expect(normalizeQueuedMessages([{ ...base, origin: { kind: 'schedule', jobId: 'job-1', occurrenceKey: 'k', selection: { model: 4 } } }], 't1')[0].origin)
      .toEqual({ kind: 'schedule', jobId: 'job-1', occurrenceKey: 'k' })
  })

  it('reclaims only abandoned claims; protects live unaccepted owners', () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'dead-owner' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'live-owner' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'accepted-dead' }).items

    const dead = claimNextNormal(items, {
      ownerPid: 2_147_000_010,
      ownerToken: 'dead'
    })
    items = dead.items
    const live = claimNextNormal(items, {
      ownerPid: process.pid,
      ownerToken: 'live'
    })
    items = live.items
    const accepted = claimNextNormal(items, {
      ownerPid: 2_147_000_011,
      ownerToken: 'accepted-dead'
    })
    items = accepted.items

    const acceptedId = accepted.claimed!.id
    const result = reclaimAbandonedClaims(items, {
      isOwnerLive: (claim) => claim.ownerToken === 'live',
      isAccepted: (item) => item.id === acceptedId
    })

    expect(result.released.map((i) => i.content)).toEqual(['dead-owner'])
    expect(result.completed.map((i) => i.id)).toEqual([acceptedId])
    expect(result.items.find((i) => i.id === live.claimed!.id)?.state).toBe('claimed')
    expect(result.items.find((i) => i.content === 'dead-owner')?.state).toBe('pending')
    expect(result.items.find((i) => i.id === acceptedId)).toBeUndefined()
  })

  it('completes accepted provenance before owner liveness (live owner safe to remove)', () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'accepted-live' }).items
    const claimed = claimNextNormal(items, {
      ownerPid: process.pid,
      ownerToken: 'still-alive'
    })
    items = claimed.items
    const result = reclaimAbandonedClaims(items, {
      isOwnerLive: () => true,
      isAccepted: (item) => item.id === claimed.claimed!.id
    })
    expect(result.completed.map((i) => i.id)).toEqual([claimed.claimed!.id])
    expect(result.released).toHaveLength(0)
    expect(result.items).toHaveLength(0)
  })
})

describe('ThreadMessageQueue fixed ids and the front of the queue (the continue message of a paused run)', () => {
  const owner = { ownerPid: process.pid, ownerToken: 'drain' }

  it('an item with a fixed id is written once: a second write returns the first unchanged', () => {
    const first = enqueueMessage(enqueueMessage([], { threadId: 't1', content: 'queued' }).items, { threadId: 't1', id: 'resume:run:1', content: 'Continue where you left off.', internal: true, inboxIds: ['row-1'] })
    const again = enqueueMessage(first.items, { threadId: 't1', id: 'resume:run:1', content: 'different', inboxIds: ['row-2'] })
    expect(again.item).toBe(first.item)
    expect(again.items).toBe(first.items)
    expect(again.item).toMatchObject({ id: 'resume:run:1', inboxIds: ['row-1'] })
    expect(again.items).toHaveLength(2)
  })

  it('a front insert is the next pending item, leaves claimed items where they are, and works on an empty queue', () => {
    expect(enqueueMessage([], { threadId: 't1', id: 'solo', content: 'only', atFront: true }).item.order).toBe(0)

    let items = enqueueMessage([], { threadId: 't1', content: 'a' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'b' }).items
    const claimed = claimNextNormal(items, owner)
    items = enqueueMessage(claimed.items, { threadId: 't1', id: 'resume:run:1', content: 'continue', atFront: true, continuationOfRunId: 'run:1' }).items

    expect(listPendingQueue(items).map((item) => item.content)).toEqual(['continue', 'b'])
    // The claimed item keeps its own order value.
    expect(items.find((item) => item.id === claimed.claimed!.id)).toMatchObject({ state: 'claimed', order: claimed.claimed!.order })
    expect(claimNextNormal(items, { ...owner, ownerToken: 'next' }).claimed).toMatchObject({ id: 'resume:run:1', continuationOfRunId: 'run:1' })
  })

  it('keeps the continued run through normalization, and reordering the rest still works with a negative slot', () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'a' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'b' }).items
    items = enqueueMessage(items, { threadId: 't1', id: 'resume:run:1', content: 'continue', atFront: true, internal: true, continuationOfRunId: 'run:1' }).items
    const [a, b] = items.filter((item) => !item.internal)

    expect(normalizeQueuedMessages(JSON.parse(JSON.stringify(items)), 't1').find((item) => item.id === 'resume:run:1')).toMatchObject({ continuationOfRunId: 'run:1', order: -1 })
    const reordered = reorderQueuedMessages(items, [b.id, a.id])
    expect(listPendingQueue(reordered).map((item) => item.content)).toEqual(['continue', 'b', 'a'])
  })
})

describe('editing, the queue revision and a promotion bound to a run', () => {
  const agent = { kind: 'agent' as const, threadId: 'sender', runId: 'run-s', hops: 1 }
  const seed = () => {
    let items = enqueueMessage([], { threadId: 't1', content: 'first', mode: 'agent' }).items
    items = enqueueMessage(items, { threadId: 't1', content: 'second', mode: 'plan', images: [{ data: 'aGk=', mimeType: 'image/png' }] }).items
    return { items, first: items[0], second: items[1] }
  }

  describe('queueRevision', () => {
    it('is stable for the same queue and changes with every change to what a caller can act on', () => {
      const { items, first, second } = seed()
      const revision = queueRevision(items)
      expect(queueRevision(structuredClone(items))).toBe(revision)
      expect(revision).toMatch(/^[0-9a-f]{16}$/)
      const changes: Array<[string, QueuedMessage[]]> = [
        ['an add', enqueueMessage(items, { threadId: 't1', content: 'third' }).items],
        ['an edit of the text', editQueuedMessage(items, first.id, { content: 'first, edited' }).items],
        ['an edit of the mode', editQueuedMessage(items, first.id, { mode: 'plan' }).items],
        ['a mode limit', editQueuedMessage(items, first.id, { permissionMode: 'ask' }).items],
        ['an origin', editQueuedMessage(items, first.id, { origin: agent }).items],
        ['a removal', removeQueuedMessage(items, first.id).items],
        ['a reorder', reorderQueuedMessages(items, [second.id, first.id])],
        ['a promotion', promoteQueuedMessageToSteer(items, first.id).items],
        ['a claim', claimNextNormal(items, { ownerPid: process.pid, ownerToken: 'tok' }).items]
      ]
      for (const [name, changed] of changes) expect(queueRevision(changed), name).not.toBe(revision)
      // A claim takes the item out of the pending list, as a removal does: the revision is of what can still be changed.
      expect(queueRevision(claimNextNormal(items, { ownerPid: process.pid, ownerToken: 'tok' }).items)).toBe(queueRevision(removeQueuedMessage(items, first.id).items))
    })

    it('does not move for an internal item, nor for the order the items are held in', () => {
      const { items } = seed()
      const revision = queueRevision(items)
      const withInternal = enqueueMessage(items, { threadId: 't1', content: 'automatic report', source: 'wake', internal: true }).items
      expect(queueRevision(withInternal)).toBe(revision)
      expect(queueRevision([...items].reverse())).toBe(revision)
    })

    it('assertQueueRevision refuses a stale revision with both revisions, and accepts none or the current one', () => {
      const { items } = seed()
      expect(() => assertQueueRevision(items, undefined)).not.toThrow()
      expect(() => assertQueueRevision(items, queueRevision(items))).not.toThrow()
      try {
        assertQueueRevision(items, 'deadbeefdeadbeef')
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(QueueConflictError)
        expect(error).toMatchObject({ code: 'revision_mismatch', details: { expectedRevision: 'deadbeefdeadbeef', revision: queueRevision(items) } })
      }
    })
  })

  describe('editQueuedMessage', () => {
    it('changes the text and mode in place: the item keeps its id, place, images and state', () => {
      const { items, second } = seed()
      const result = editQueuedMessage(items, second.id, { content: '  second, edited  ', mode: 'agent' })
      expect(result.item).toMatchObject({ id: second.id, content: 'second, edited', mode: 'agent', order: second.order, state: 'pending', intent: 'normal' })
      expect(result.item.images).toHaveLength(1)
      expect(listPendingQueue(result.items).map((item) => item.id)).toEqual(items.map((item) => item.id))
    })

    it('records who wrote the edited text and the limit it carries, and can drop the run the item owned', () => {
      const { items, first } = seed()
      const owned = { ...first, runId: 'run-queued' }
      const result = editQueuedMessage([owned, items[1]], first.id, { content: 'new words', origin: agent, permissionMode: 'ask', dropRun: true })
      expect(result.item).toMatchObject({ origin: agent, permissionMode: 'ask' })
      expect(result.item.runId).toBeUndefined()
      expect(editQueuedMessage([owned], first.id, { content: 'x' }).item.runId).toBe('run-queued')
    })

    it('is idempotent against its own effect', () => {
      const { items, first } = seed()
      const patch = { content: 'once', origin: agent, permissionMode: 'ask' as const, dropRun: true }
      const once = editQueuedMessage(items, first.id, patch)
      expect(editQueuedMessage(once.items, first.id, patch).items).toEqual(once.items)
    })

    it('refuses an unknown item, a started one, a steering one, an internal one, a workflow command, a notice and empty text', () => {
      const { items, first } = seed()
      expect(() => editQueuedMessage(items, 'nope', { content: 'x' })).toThrow(expect.objectContaining({ code: 'queue_item_not_found' }))
      const claimed = claimNextNormal(items, { ownerPid: process.pid, ownerToken: 'tok' })
      expect(() => editQueuedMessage(claimed.items, first.id, { content: 'x' })).toThrow(/already started/)
      const steering = promoteQueuedMessageToSteer(items, first.id).items
      expect(() => editQueuedMessage(steering, first.id, { content: 'x' })).toThrow(expect.objectContaining({ code: 'item_steering' }))
      const internal = enqueueMessage([], { threadId: 't1', content: 'automatic', internal: true, source: 'wake' })
      expect(() => editQueuedMessage(internal.items, internal.item.id, { content: 'x' })).toThrow(QueueValidationError)
      const workflow = [{ ...first, workflowInvocationId: '123e4567-e89b-42d3-a456-426614174000' }]
      expect(() => editQueuedMessage(workflow, first.id, { content: 'x' })).toThrow(/workflow command/)
      const notice = [{ ...first, inboxIds: ['inbox-1'] }]
      expect(() => editQueuedMessage(notice, first.id, { content: 'x' })).toThrow(/subagent result/)
      expect(() => editQueuedMessage(items, first.id, { content: '   ' })).toThrow(/content is required/)
      // An item with images may lose its text.
      expect(editQueuedMessage(items, items[1].id, { content: ' ' }).item.content).toBe('')
    })
  })

  describe('normalization keeps what the queue file holds', () => {
    it('keeps origin, mode limit and the run a steering item is bound to, and drops a bound run from any other state', () => {
      const { items, first } = seed()
      const steering = promoteQueuedMessageToSteer(editQueuedMessage(items, first.id, { origin: agent, permissionMode: 'ask' }).items, first.id, { steerRunId: 'run-a' }).item
      expect(steering).toMatchObject({ state: 'steering', intent: 'steer', steerRunId: 'run-a', origin: agent, permissionMode: 'ask' })
      const [loaded] = normalizeQueuedMessages(JSON.parse(JSON.stringify([steering])), 't1')
      expect(loaded).toMatchObject({ steerRunId: 'run-a', origin: agent, permissionMode: 'ask' })
      expect(normalizeQueuedMessages([{ ...steering, state: 'pending', intent: 'normal' }], 't1')[0].steerRunId).toBeUndefined()
    })
  })

  describe('promotion and demotion', () => {
    it('binds the promotion to a run and keeps the narrowed mode on the item', () => {
      const { items, first } = seed()
      const promoted = promoteQueuedMessageToSteer(items, first.id, { steerRunId: 'run-a', permissionMode: 'ask' })
      expect(promoted.item).toMatchObject({ intent: 'steer', state: 'steering', steerRunId: 'run-a', permissionMode: 'ask' })
      expect(promoteQueuedMessageToSteer(items, first.id).item.steerRunId).toBeUndefined()
    })

    it('demotes the named items only, clears the bound run, and keeps origin and mode limit', () => {
      const { items, first, second } = seed()
      const edited = editQueuedMessage(items, first.id, { origin: agent, permissionMode: 'ask' }).items
      const both = promoteQueuedMessageToSteer(promoteQueuedMessageToSteer(edited, first.id, { steerRunId: 'run-a' }).items, second.id, { steerRunId: 'run-a' }).items
      const some = demoteSteerItems(both, [first.id])
      expect(some.find((item) => item.id === first.id)).toMatchObject({ intent: 'normal', state: 'pending', origin: agent, permissionMode: 'ask' })
      expect(some.find((item) => item.id === first.id)!.steerRunId).toBeUndefined()
      expect(some.find((item) => item.id === second.id)).toMatchObject({ intent: 'steer', state: 'steering', steerRunId: 'run-a' })
      expect(demoteSteerItems(both).every((item) => item.intent === 'normal' && item.steerRunId === undefined)).toBe(true)
    })
  })
})

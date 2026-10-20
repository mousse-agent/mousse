// Pure queue tables: ordering, claims and recovery rules. No store, orchestrator or daemon.
import { describe, expect, it } from 'vitest'
import {
  claimNextNormal,
  clearPendingQueue,
  completeClaim,
  demoteSteerItems,
  drainNextNormal,
  dropSteerItems,
  enqueueMessage,
  listClaimedQueue,
  listPendingQueue,
  normalizeQueuedMessages,
  promoteQueuedMessageToSteer,
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

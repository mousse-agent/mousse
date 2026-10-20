// The queue as persisted on ThreadDataStore (queue.json, durable claims).
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { enqueueMessage, listPendingQueue } from '../src/mms/queue/ThreadMessageQueue'
import {
  claimNextNormalDurable,
  completeClaimDurable,
  mutateDurableQueue,
  readDurableQueue,
  reclaimAbandonedClaimsDurable,
  releaseClaimDurable
} from '../src/mms/queue/durableQueue'

describe('queue persistence on ThreadDataStore', () => {
  let home: string
  let store: ThreadDataStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-queue-'))
    process.env.MOUSSE_HOME = home
    const projects = new ProjectManager()
    store = new ThreadDataStore(projects)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('persists and reloads queue.json without losing pending messages', () => {
    const thread = store.createThread('Queue Test')
    const queued = enqueueMessage([], {
      threadId: thread.id,
      content: 'pending hello'
    }).item
    store.saveMessageQueue(thread.id, [queued])
    const reloaded = store.loadMessageQueue(thread.id)
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0].content).toBe('pending hello')
    expect(reloaded[0].id).toBe(queued.id)

    const data = store.loadThreadData(thread.id)
    expect(data.messageQueue?.[0].content).toBe('pending hello')
  })

  it('saveThreadData does not overwrite concurrent queue.json mutations', () => {
    const thread = store.createThread('No Stale Queue')
    const first = enqueueMessage([], {
      threadId: thread.id,
      content: 'from-queue-api'
    }).item
    store.saveMessageQueue(thread.id, [first])

    // Simulate ScheduledJobService-style snapshot that still carries a stale/empty queue.
    store.saveThreadData(thread.id, {
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'scheduled note',
          timestamp: new Date().toISOString()
        }
      ],
      agents: [],
      tasks: [],
      messageQueue: []
    })

    expect(store.loadMessageQueue(thread.id).map((i) => i.content)).toEqual(['from-queue-api'])
    expect(store.loadThreadData(thread.id).messages[0].content).toBe('scheduled note')
  })

  it('durable claim APIs preserve FIFO and support reclaim of abandoned claims', () => {
    const thread = store.createThread('Durable Claim')
    mutateDurableQueue(store, thread.id, (items) => {
      let next = enqueueMessage(items, { threadId: thread.id, content: 'a' }).items
      next = enqueueMessage(next, { threadId: thread.id, content: 'b' }).items
      return next
    })

    const claimed = claimNextNormalDurable(store, thread.id, {
      ownerPid: 2_147_000_020,
      ownerToken: 'stale',
      source: 'peer'
    })
    expect(claimed?.content).toBe('a')
    expect(claimed?.order).toBe(0)
    expect(readDurableQueue(store, thread.id).find((i) => i.id === claimed!.id)?.state).toBe(
      'claimed'
    )

    // Live foreign token cannot release our claim without matching token.
    expect(
      releaseClaimDurable(store, thread.id, claimed!.id, { ownerToken: 'other' })
    ).toBeNull()

    const reclaimed = reclaimAbandonedClaimsDurable(store, thread.id, {
      isOwnerLive: () => false,
      isAccepted: () => false
    })
    expect(reclaimed.released.map((i) => i.content)).toEqual(['a'])
    expect(listPendingQueue(reclaimed.items).map((i) => i.content)).toEqual(['a', 'b'])

    const claimed2 = claimNextNormalDurable(store, thread.id, {
      ownerPid: process.pid,
      ownerToken: 'mine'
    })
    completeClaimDurable(store, thread.id, claimed2!.id, { ownerToken: 'mine' })
    expect(listPendingQueue(readDurableQueue(store, thread.id)).map((i) => i.content)).toEqual([
      'b'
    ])
  })
})

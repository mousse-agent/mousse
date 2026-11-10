// The queue as persisted on ThreadDataStore (queue.json). Durable claims are tested in threadExecutionLease.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { enqueueMessage } from '../src/mms/queue/ThreadMessageQueue'

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

  it("keeps another person's author across a reload, and drops one that is not well formed", () => {
    const thread = store.createThread('Authors')
    const author = { user: 'usr_0000000000000000000000000a', node: 'nod_0000000000000000000000000a', displayName: 'Ana' } as const
    const theirs = enqueueMessage([], { threadId: thread.id, content: 'from Ana', author }).item
    const owners = enqueueMessage([theirs], { threadId: thread.id, content: 'mine' }).item
    const forged = { ...enqueueMessage([], { threadId: thread.id, content: 'bad' }).item, author: { user: 'not-a-user', displayName: 'Eve' } } as never
    store.saveMessageQueue(thread.id, [theirs, owners, forged])
    const reloaded = store.loadMessageQueue(thread.id)
    expect(reloaded.find((item) => item.id === theirs.id)?.author).toEqual(author)
    // The owner's item, and the one whose author is not a user id, have no author field at all.
    expect('author' in reloaded.find((item) => item.id === owners.id)!).toBe(false)
    expect(reloaded.filter((item) => 'author' in item)).toHaveLength(1)
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
})

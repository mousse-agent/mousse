import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSubagentsSync } from '../src/renderer/lib/subagentsSync'
import type { SubagentSummary, SubagentsUpdatedEvent } from '../src/shared/subagents'

const row = (id: string): SubagentSummary => ({
  childThreadId: id, title: id, activity: 'idle', state: 'done', latestDelegationId: `d-${id}`, unread: false,
  provider: null, model: null, workspace: null, role: null, createdAt: 't', updatedAt: 't', waitingOn: [], tasks: []
})

function harness(lists: Record<string, SubagentSummary[][]>) {
  const listeners = new Set<(event: SubagentsUpdatedEvent) => void>()
  const calls: string[] = []
  const applied: Array<[string, string[]]> = []
  const sync = createSubagentsSync({
    list: async (threadId) => {
      calls.push(threadId)
      const queue = lists[threadId] ?? [[]]
      return queue.length > 1 ? queue.shift()! : queue[0]
    },
    onUpdated: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    apply: (threadId, subagents) => applied.push([threadId, subagents.map((entry) => entry.childThreadId)]),
    debounceMs: 100
  })
  const emit = (parentThreadId: string) => listeners.forEach((cb) => cb({ parentThreadId }))
  return { sync, listeners, calls, applied, emit }
}

describe('subagents sync', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fetches once when a thread gains its first watcher and not again for the second', async () => {
    const h = harness({ p: [[row('a')]] })
    h.sync.watch('p')
    h.sync.watch('p')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls).toEqual(['p'])
    expect(h.applied).toEqual([['p', ['a']]])
  })

  it('turns a burst of updates for a watched parent into one refetch', async () => {
    const h = harness({ p: [[row('a')], [row('a'), row('b')]] })
    h.sync.watch('p')
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i += 1) {
      h.emit('p')
      await vi.advanceTimersByTimeAsync(30)
    }
    expect(h.calls).toEqual(['p'])
    await vi.advanceTimersByTimeAsync(100)
    expect(h.calls).toEqual(['p', 'p'])
    expect(h.applied.at(-1)).toEqual(['p', ['a', 'b']])
  })

  it('ignores updates for parents nothing watches', async () => {
    const h = harness({ p: [[]] })
    h.sync.watch('p')
    await vi.advanceTimersByTimeAsync(0)
    h.emit('someone-else')
    await vi.advanceTimersByTimeAsync(500)
    expect(h.calls).toEqual(['p'])
  })

  it('stops listening and cancels a pending refetch when the last watcher leaves', async () => {
    const h = harness({ p: [[row('a')]] })
    const release = h.sync.watch('p')
    await vi.advanceTimersByTimeAsync(0)
    h.emit('p')
    release()
    release() // releasing twice does nothing
    expect(h.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(h.calls).toEqual(['p'])
  })

  it('keeps listening while another thread is still watched', async () => {
    const h = harness({ p: [[]], q: [[]] })
    const releaseP = h.sync.watch('p')
    h.sync.watch('q')
    releaseP()
    expect(h.listeners.size).toBe(1)
    h.emit('q')
    await vi.advanceTimersByTimeAsync(150)
    expect(h.calls.filter((id) => id === 'q')).toHaveLength(2)
  })

  it('drops a reply that a newer request outran', async () => {
    const resolvers: Array<(value: SubagentSummary[]) => void> = []
    const applied: string[][] = []
    const sync = createSubagentsSync({
      list: () => new Promise((resolve) => resolvers.push(resolve)),
      onUpdated: () => () => undefined,
      apply: (_id, subagents) => applied.push(subagents.map((entry) => entry.childThreadId))
    })
    const release = sync.watch('p')
    release()
    sync.watch('p') // a second request for the same thread
    resolvers[0]([row('old')])
    resolvers[1]([row('new')])
    await vi.advanceTimersByTimeAsync(0)
    expect(applied).toEqual([['new']])
  })

  it('leaves the last list in place when the daemon cannot answer', async () => {
    const applied: unknown[] = []
    const sync = createSubagentsSync({
      list: async () => { throw new Error('unknown method') },
      onUpdated: () => () => undefined,
      apply: (...args) => applied.push(args)
    })
    sync.watch('p')
    await vi.advanceTimersByTimeAsync(0)
    expect(applied).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import { arrangeThreadFeed, sortSidebarThreads, sortThreadFeed } from '../src/shared/threadSidebarSort'

function thread(partial: Partial<Thread> & Pick<Thread, 'id'>): Thread {
  return {
    name: partial.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    order: 0,
    ...partial
  }
}

describe('sortSidebarThreads', () => {
  it('orders by persisted order, not recency or activity', () => {
    const olderFront = thread({
      id: 'older',
      order: -2,
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    const newerBack = thread({
      id: 'newer',
      order: -1,
      updatedAt: '2026-03-01T00:00:00.000Z'
    })

    expect(sortSidebarThreads([newerBack, olderFront]).map((entry) => entry.id)).toEqual([
      'older',
      'newer'
    ])
  })

  it('puts pinned threads first, each part by persisted order', () => {
    const front = thread({ id: 'front', order: 0 })
    const pinnedBack = thread({ id: 'pinned-back', order: 5, pinnedAt: '2026-01-02T00:00:00.000Z' })
    const pinnedFront = thread({ id: 'pinned-front', order: 1, pinnedAt: '2026-01-03T00:00:00.000Z' })
    const back = thread({ id: 'back', order: 3 })
    expect(sortSidebarThreads([back, pinnedBack, front, pinnedFront]).map((entry) => entry.id)).toEqual([
      'pinned-front',
      'pinned-back',
      'front',
      'back'
    ])
  })

  it('breaks order ties with id', () => {
    const laterId = thread({ id: 'b', order: 0 })
    const earlierId = thread({ id: 'a', order: 0 })
    expect(sortSidebarThreads([laterId, earlierId]).map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('puts the threads of other computers among this computer’s by the same order', () => {
    // A thread of another computer lists by its place here (see the merged lists), not by its own computer.
    const mine = thread({ id: 'mine', order: 2 })
    const first = thread({ id: 'nod_b:first', node: 'nod_b', order: 1 })
    const last = thread({ id: 'nod_c:last', node: 'nod_c', order: 3 })
    const offline = thread({ id: 'nod_b:offline', node: 'nod_b', offline: true, order: 2.5 })
    expect(sortSidebarThreads([last, offline, mine, first]).map((entry) => entry.id)).toEqual([
      'nod_b:first',
      'mine',
      'nod_b:offline',
      'nod_c:last'
    ])
  })

  it('does not mutate the input array', () => {
    const threads = [
      thread({ id: 'second', order: 1 }),
      thread({ id: 'first', order: 0 })
    ]
    sortSidebarThreads(threads)
    expect(threads.map((entry) => entry.id)).toEqual(['second', 'first'])
  })
})

describe('sortThreadFeed', () => {
  it('puts the newest started thread first, whatever its project order or later activity', () => {
    const busy = thread({ id: 'busy', projectId: 'p1', order: -46, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' })
    const fresh = thread({ id: 'fresh', projectId: 'p2', order: -1, startedAt: '2026-02-01T00:00:00.000Z' })
    expect(sortThreadFeed([busy, fresh]).map((entry) => entry.id)).toEqual(['fresh', 'busy'])
  })

  it('falls back to creation for a thread without startedAt, and breaks ties with id', () => {
    const legacy = thread({ id: 'legacy', createdAt: '2026-01-05T00:00:00.000Z' })
    const b = thread({ id: 'b', startedAt: '2026-01-02T00:00:00.000Z' })
    const a = thread({ id: 'a', startedAt: '2026-01-02T00:00:00.000Z' })
    expect(sortThreadFeed([b, a, legacy]).map((entry) => entry.id)).toEqual(['legacy', 'a', 'b'])
  })
})

describe('dragging rows in the Threads tab', () => {
  const started = (id: string, day: number, projectId?: string) =>
    thread({ id, ...(projectId ? { projectId } : {}), startedAt: `2026-01-0${day}T00:00:00.000Z` })

  it('keeps the dragged order across projects, with threads started since on top', () => {
    const rows = [started('a', 1, 'p1'), started('b', 2, 'p2'), started('c', 3), started('d', 4, 'p1')]
    // Dragged earlier into a, c, b; d started afterwards.
    expect(sortThreadFeed(rows, ['a', 'c', 'b']).map((entry) => entry.id)).toEqual(['d', 'a', 'c', 'b'])
    // Ids of threads that are gone do not matter.
    expect(sortThreadFeed(rows, ['gone', 'b', 'a', 'd', 'c']).map((entry) => entry.id)).toEqual(['b', 'a', 'd', 'c'])
  })

  it('moves a row before or after another, or to the end', () => {
    const shown = ['a', 'b', 'c', 'd']
    expect(arrangeThreadFeed(shown, 'd', 'a')).toEqual(['d', 'a', 'b', 'c'])
    expect(arrangeThreadFeed(shown, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd'])
    expect(arrangeThreadFeed(shown, 'a', 'd', true)).toEqual(['b', 'c', 'd', 'a'])
    expect(arrangeThreadFeed(shown, 'b')).toEqual(['a', 'c', 'd', 'b'])
  })
})

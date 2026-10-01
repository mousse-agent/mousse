import { describe, expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import { sortSidebarThreads } from '../src/shared/threadSidebarSort'

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

  it('breaks order ties with id', () => {
    const laterId = thread({ id: 'b', order: 0 })
    const earlierId = thread({ id: 'a', order: 0 })
    expect(sortSidebarThreads([laterId, earlierId]).map((entry) => entry.id)).toEqual(['a', 'b'])
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

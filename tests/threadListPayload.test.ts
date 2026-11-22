import { describe, expect, it } from 'vitest'
import { bridgeProtocolEvent, listGeneration, threadListPayload } from '../src/main/mms/protocolEventBridge'
import { NotificationThreadIndex } from '../src/main/notifications/threadNotificationTarget'
import { PresentationState } from '../src/main/mms/PresentationState'
import { isOlderThreadList, threadRowAction } from '../src/shared/types'

describe('a thread list reaches the window with its version', () => {
  const rows = [{ id: 'a' }]
  it('keeps the service version of a push or a threads.list reply, and sends a list without one as before', () => {
    expect(threadListPayload({ threads: rows, version: { epoch: 'e', seq: 3 } })).toEqual({ threads: rows, version: { epoch: 'e', seq: 3, generation: listGeneration('e') } })
    // A reorder's reply carries the whole list as `all`.
    expect(threadListPayload({ threads: [], all: rows, version: { epoch: 'e', seq: 4 } }, 'all')).toEqual({ threads: rows, version: { epoch: 'e', seq: 4, generation: listGeneration('e') } })
    expect(threadListPayload({ threads: rows })).toEqual(rows)
    expect(threadListPayload(rows)).toEqual(rows)
    expect(threadListPayload({ threads: rows, version: { epoch: 3 } })).toEqual(rows)
  })

  it('bridges a pushed threads.updated with its version', () => {
    const sent: Array<{ channel: string; data: unknown }> = []
    bridgeProtocolEvent({ type: 'threads.updated', sequence: 1, data: { threads: rows, version: { epoch: 'e', seq: 4 } } } as never,
      (channel, data) => sent.push({ channel, data }), new PresentationState())
    expect(sent).toEqual([{ channel: 'threads:updated', data: { threads: rows, version: { epoch: 'e', seq: 4, generation: listGeneration('e') } } }])
  })

  it('numbers service stores in the order it first sees them, so a replaced store is always older', () => {
    const first = listGeneration('store-first-' + Math.random())
    const second = listGeneration('store-second-' + Math.random())
    expect(second).toBeGreaterThan(first)
    expect(isOlderThreadList({ epoch: 'x', seq: 99, generation: first }, { epoch: 'y', seq: 1, generation: second })).toBe(true)
    expect(isOlderThreadList({ epoch: 'y', seq: 1, generation: second }, { epoch: 'x', seq: 99, generation: first })).toBe(false)
  })

  it('bridges a save that moved only threads times as a small push', () => {
    const sent: Array<{ channel: string; data: unknown }> = []
    const touches = [{ id: 'a', updatedAt: '2026-11-10T10:00:00.000Z' }]
    bridgeProtocolEvent({ type: 'threads.touched', sequence: 2, data: { touches } } as never, (channel, data) => sent.push({ channel, data }), new PresentationState())
    expect(sent).toEqual([{ channel: 'threads:touched', data: touches }])
  })

  it('calls a list older only within one epoch of the service', () => {
    expect(isOlderThreadList({ epoch: 'e', seq: 2 }, { epoch: 'e', seq: 3 })).toBe(true)
    expect(isOlderThreadList({ epoch: 'e', seq: 3 }, { epoch: 'e', seq: 3 })).toBe(false)
    expect(isOlderThreadList({ epoch: 'f', seq: 1 }, { epoch: 'e', seq: 9 })).toBe(false)
    expect(isOlderThreadList(undefined, { epoch: 'e', seq: 9 })).toBe(false)
    expect(isOlderThreadList({ epoch: 'e', seq: 1 }, undefined)).toBe(false)
  })
})

describe("one thread's row reaches the window and the notifications with its version", () => {
  it('bridges a pushed threads.row, a row or a removal, with its version numbered like a list', () => {
    const sent: Array<{ channel: string; data: unknown }> = []
    const push = (data: unknown) => bridgeProtocolEvent({ type: 'threads.row', sequence: 5, data } as never, (channel, payload) => sent.push({ channel, data: payload }), new PresentationState())
    push({ thread: { id: 'a', name: 'A' }, version: { epoch: 'e', seq: 5 } })
    push({ removed: 'b', version: { epoch: 'e', seq: 6 } })
    push({ thread: { id: 'c' } })
    expect(sent).toEqual([
      { channel: 'threads:row', data: { thread: { id: 'a', name: 'A' }, version: { epoch: 'e', seq: 5, generation: listGeneration('e') } } },
      { channel: 'threads:row', data: { removed: 'b', version: { epoch: 'e', seq: 6, generation: listGeneration('e') } } }
    ])
  })

  it('applies a row the list held does not have yet, drops one it has, and reads again without a list of the same service', () => {
    const held = { epoch: 'e', seq: 5, generation: 1 }
    expect(threadRowAction({ epoch: 'e', seq: 6, generation: 1 }, held)).toBe('apply')
    expect(threadRowAction({ epoch: 'e', seq: 5, generation: 1 }, held)).toBe('drop')
    expect(threadRowAction({ epoch: 'e', seq: 4, generation: 1 }, held)).toBe('drop')
    // A retired service's late row.
    expect(threadRowAction({ epoch: 'd', seq: 90, generation: 0 }, held)).toBe('drop')
    // A restarted service's row, and a row with no list held.
    expect(threadRowAction({ epoch: 'f', seq: 1, generation: 2 }, held)).toBe('refresh')
    expect(threadRowAction({ epoch: 'e', seq: 6, generation: 1 }, undefined)).toBe('refresh')
  })

  it('keeps the notification index in step with rows: a renamed row and a removal', () => {
    const index = new NotificationThreadIndex()
    index.note('p', { threads: [{ id: 'a', name: 'Old' }, { id: 'b', name: 'B' }] })
    index.noteRow('p', { thread: { id: 'a', name: 'New' }, version: { epoch: 'e', seq: 2 } })
    index.noteRow('p', { removed: 'b', version: { epoch: 'e', seq: 3 } })
    expect(index.resolve('p', 'a', 'completed')?.threadName).toBe('New')
    expect(index.resolve('p', 'b', 'completed')?.threadName).toBeUndefined()
  })
})

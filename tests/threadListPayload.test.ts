import { describe, expect, it } from 'vitest'
import { bridgeProtocolEvent, threadListPayload } from '../src/main/mms/protocolEventBridge'
import { PresentationState } from '../src/main/mms/PresentationState'
import { isOlderThreadList } from '../src/shared/types'

describe('a thread list reaches the window with its version', () => {
  const rows = [{ id: 'a' }]
  it('keeps the service version of a push or a threads.list reply, and sends a list without one as before', () => {
    expect(threadListPayload({ threads: rows, version: { epoch: 'e', seq: 3 } })).toEqual({ threads: rows, version: { epoch: 'e', seq: 3 } })
    expect(threadListPayload({ threads: rows })).toEqual(rows)
    expect(threadListPayload(rows)).toEqual(rows)
    expect(threadListPayload({ threads: rows, version: { epoch: 3 } })).toEqual(rows)
  })

  it('bridges a pushed threads.updated with its version', () => {
    const sent: Array<{ channel: string; data: unknown }> = []
    bridgeProtocolEvent({ type: 'threads.updated', sequence: 1, data: { threads: rows, version: { epoch: 'e', seq: 4 } } } as never,
      (channel, data) => sent.push({ channel, data }), new PresentationState())
    expect(sent).toEqual([{ channel: 'threads:updated', data: { threads: rows, version: { epoch: 'e', seq: 4 } } }])
  })

  it('calls a list older only within one epoch of the service', () => {
    expect(isOlderThreadList({ epoch: 'e', seq: 2 }, { epoch: 'e', seq: 3 })).toBe(true)
    expect(isOlderThreadList({ epoch: 'e', seq: 3 }, { epoch: 'e', seq: 3 })).toBe(false)
    expect(isOlderThreadList({ epoch: 'f', seq: 1 }, { epoch: 'e', seq: 9 })).toBe(false)
    expect(isOlderThreadList(undefined, { epoch: 'e', seq: 9 })).toBe(false)
    expect(isOlderThreadList({ epoch: 'e', seq: 1 }, undefined)).toBe(false)
  })
})

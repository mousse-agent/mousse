import { describe, expect, it } from 'vitest'
import { EventSequenceRing } from '../src/mms/protocol/eventRing'

const message = (id: string, content: string) => ({ message: { id, role: 'assistant', content } })

describe('EventSequenceRing', () => {
  it('keeps one copy of a streaming message, however many updates it sends', () => {
    const ring = new EventSequenceRing(512)
    ring.push('thread.message', message('a', ''), 't1')
    let content = ''
    for (let i = 0; i < 2_000; i++) {
      content += `word ${i} `
      ring.push('thread.message-updated', message('a', content), 't1')
    }
    expect(ring.size).toBe(2)
    const { gap, events } = ring.replayAfter(0)
    expect(gap).toBe(false)
    expect(events.map((event) => event.type)).toEqual(['thread.message', 'thread.message-updated'])
    expect((events[1].data as ReturnType<typeof message>).message.content).toBe(content)
    expect(events[1].sequence).toBe(ring.currentSequence)
  })

  it('keeps the latest update of each message and thread, in order', () => {
    const ring = new EventSequenceRing(512)
    ring.push('thread.message-updated', message('a', '1'), 't1')
    ring.push('thread.message-updated', message('a', '1'), 't2')
    ring.push('turn.started', {}, 't1')
    ring.push('thread.message-updated', message('b', '1'), 't1')
    ring.push('thread.message-updated', message('a', '12'), 't1')
    ring.push('threads.updated', { version: 1, threads: [] })
    ring.push('threads.updated', { version: 2, threads: [] })
    const { events } = ring.replayAfter(0)
    expect(events.map((event) => [event.sequence, event.type, event.threadId])).toEqual([
      [2, 'thread.message-updated', 't2'],
      [3, 'turn.started', 't1'],
      [4, 'thread.message-updated', 't1'],
      [5, 'thread.message-updated', 't1'],
      [7, 'threads.updated', undefined]
    ])
    // A client that saw sequence 1 still replays without a gap: what it missed is in the later updates.
    expect(ring.replayAfter(1).gap).toBe(false)
    expect(ring.replayAfter(5).events.map((event) => event.sequence)).toEqual([7])
  })

  it('reports a gap only for events dropped for space', () => {
    const ring = new EventSequenceRing(3)
    for (let i = 0; i < 5; i++) ring.push('run.event', { i }, 't1')
    expect(ring.size).toBe(3)
    expect(ring.replayAfter(1).gap).toBe(true)
    expect(ring.replayAfter(2)).toEqual({ gap: false, events: ring.replayAfter(2).events })
    expect(ring.replayAfter(2).events.map((event) => event.sequence)).toEqual([3, 4, 5])
  })

  it('forgets a superseded key once its event is dropped for space', () => {
    const ring = new EventSequenceRing(2)
    ring.push('thread.message-updated', message('a', '1'), 't1')
    ring.push('run.event', {}, 't1')
    ring.push('run.event', {}, 't1')
    ring.push('thread.message-updated', message('a', '12'), 't1')
    expect(ring.replayAfter(0).events.map((event) => event.sequence)).toEqual([3, 4])
  })
})

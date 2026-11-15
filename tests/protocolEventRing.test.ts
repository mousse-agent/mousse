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

  it('keeps one message list per thread: the newest, which carries the whole transcript', () => {
    const ring = new EventSequenceRing(512)
    const list = (...ids: string[]) => ({ messages: ids.map((id) => ({ id, role: 'assistant', content: id })) })
    ring.push('thread.messages', list('a'), 't1')
    ring.push('thread.messages', list('x'), 't2')
    ring.push('thread.message', message('b', 'b'), 't1')
    ring.push('thread.messages', list('a', 'b'), 't1')
    const { gap, events } = ring.replayAfter(0)
    expect(gap).toBe(false)
    expect(events.map((event) => [event.sequence, event.type, event.threadId])).toEqual([
      [2, 'thread.messages', 't2'],
      [3, 'thread.message', 't1'],
      [4, 'thread.messages', 't1']
    ])
    expect(events[2].data).toEqual(list('a', 'b'))
  })

  it('replays a list that followed an undo as a replacement, so a client that missed the undo drops the undone messages', () => {
    const ring = new EventSequenceRing(512)
    ring.push('thread.messages', { messages: [{ id: 'a' }], replace: true }, 't1')
    const live = ring.push('thread.messages', { messages: [{ id: 'a' }, { id: 'c' }] }, 't1')
    // Windows that are connected already applied the undo; they merge the newer list as sent.
    expect(live.data).toEqual({ messages: [{ id: 'a' }, { id: 'c' }] })
    const [kept] = ring.replayAfter(0).events
    expect(kept.sequence).toBe(live.sequence)
    expect(kept.data).toEqual({ messages: [{ id: 'a' }, { id: 'c' }], replace: true })
    // A list that superseded only plain lists stays a merge.
    const plain = new EventSequenceRing(512)
    plain.push('thread.messages', { messages: [{ id: 'a' }] }, 't1')
    plain.push('thread.messages', { messages: [{ id: 'a' }, { id: 'c' }] }, 't1')
    expect(plain.replayAfter(0).events[0].data).toEqual({ messages: [{ id: 'a' }, { id: 'c' }] })
  })

  it('drops the oldest events past its byte budget and reports the gap', () => {
    const ring = new EventSequenceRing(512, 10_000)
    for (let i = 0; i < 10; i++) ring.push('run.event', { text: 'x'.repeat(3_000) }, 't1')
    expect(ring.size).toBe(3)
    expect(ring.approximateBytes()).toBeLessThanOrEqual(10_000)
    expect(ring.replayAfter(0).gap).toBe(true)
    expect(ring.replayAfter(7)).toEqual({ gap: false, events: ring.replayAfter(7).events })
    expect(ring.replayAfter(7).events.map((event) => event.sequence)).toEqual([8, 9, 10])
  })

  it('drops an event larger than the whole budget at once, and replay from before it is a gap', () => {
    const ring = new EventSequenceRing(512, 10_000)
    ring.push('run.event', { text: 'small' }, 't1')
    ring.push('thread.messages', { messages: [{ id: 'a', content: 'x'.repeat(20_000) }] }, 't1')
    expect(ring.size).toBe(0)
    expect(ring.approximateBytes()).toBe(0)
    expect(ring.replayAfter(1)).toEqual({ gap: true, events: [] })
    expect(ring.replayAfter(2)).toEqual({ gap: false, events: [] })
  })

  it('counts a message several events hold once, and frees it when the last one leaves', () => {
    const transcript = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, role: 'assistant', content: 'x'.repeat(1_000) }))
    const ring = new EventSequenceRing(512)
    ring.push('thread.messages', { messages: transcript }, 't1')
    const listOnly = ring.approximateBytes()
    expect(listOnly).toBeGreaterThan(20_000)
    // The streaming update and the list hold the same message object: only the update's own few bytes are added.
    ring.push('thread.message-updated', { message: transcript[19] }, 't1')
    expect(ring.approximateBytes() - listOnly).toBeLessThan(50)
    // A message that changed in place is measured again when the next event holds it.
    transcript[19].content += 'y'.repeat(5_000)
    ring.push('thread.message-updated', { message: transcript[19] }, 't1')
    expect(ring.approximateBytes() - listOnly).toBeGreaterThan(5_000)
    // The thread's next list leaves the old messages behind; nothing in the ring holds them any more.
    ring.push('thread.messages', { messages: [] }, 't1')
    ring.push('thread.message-updated', { message: { id: 'm19' } }, 't1')
    expect(ring.approximateBytes()).toBeLessThan(100)
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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMessageUpdateBatcher } from '../../src/renderer/stores/messageUpdateBatcher'
import { upsertMessage, useAppStore } from '../../src/renderer/stores/appStore'
import type { ChatMessage } from '../../src/shared/types'

const reply = (content: string, id = 'r1'): ChatMessage =>
  ({ id, role: 'assistant', content, timestamp: '2026-11-10T10:00:00.000Z', streaming: true }) as ChatMessage

/** A hand-driven frame clock. */
function frames() {
  let queued: Array<() => void> = []
  return {
    schedule: (run: () => void) => {
      queued.push(run)
      return () => { queued = queued.filter((entry) => entry !== run) }
    },
    tick: () => {
      const due = queued
      queued = []
      for (const run of due) run()
    },
    pending: () => queued.length
  }
}

describe('createMessageUpdateBatcher', () => {
  it('applies a burst of updates once per frame, with the latest version of each message', () => {
    const clock = frames()
    const applied: ChatMessage[][] = []
    const batcher = createMessageUpdateBatcher({ apply: (_t, messages) => applied.push(messages), isCurrent: () => true, schedule: clock.schedule })
    for (let i = 1; i <= 30; i++) batcher.push('t1', reply('x'.repeat(i)))
    batcher.push('t1', reply('tool', 'r2'))
    expect(applied).toEqual([])
    expect(clock.pending()).toBe(1)
    clock.tick()
    expect(applied).toHaveLength(1)
    expect(applied[0]!.map((message) => message.content)).toEqual(['x'.repeat(30), 'tool'])
    clock.tick()
    expect(applied).toHaveLength(1)
  })

  it('applies held updates at once on flush, and not again at the frame', () => {
    const clock = frames()
    const applied: string[] = []
    const batcher = createMessageUpdateBatcher({ apply: (_t, messages) => applied.push(...messages.map((m) => m.content)), isCurrent: () => true, schedule: clock.schedule })
    batcher.push('t1', reply('a'))
    batcher.push('t1', reply('ab'))
    batcher.flush()
    expect(applied).toEqual(['ab'])
    clock.tick()
    expect(applied).toEqual(['ab'])
  })

  it('drops updates of a thread that is no longer shown', () => {
    const clock = frames()
    let shown = 't1'
    const applied: string[] = []
    const batcher = createMessageUpdateBatcher({ apply: (thread) => applied.push(thread), isCurrent: (thread) => thread === shown, schedule: clock.schedule })
    batcher.push('t1', reply('a'))
    shown = 't2'
    clock.tick()
    expect(applied).toEqual([])
  })

  it('applies the first thread before queueing another', () => {
    const clock = frames()
    const applied: string[] = []
    const batcher = createMessageUpdateBatcher({ apply: (thread, messages) => applied.push(`${thread}:${messages[0]!.content}`), isCurrent: () => true, schedule: clock.schedule })
    batcher.push('t1', reply('a'))
    batcher.push('t2', reply('b'))
    clock.tick()
    expect(applied).toEqual(['t1:a', 't2:b'])
  })

  it('falls back to a timer when no frame comes (a hidden window)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // No frame ever comes.
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const applied: string[] = []
    try {
      const batcher = createMessageUpdateBatcher({ apply: (_t, messages) => applied.push(messages[0]!.content), isCurrent: () => true })
      batcher.push('t1', reply('a'))
      vi.advanceTimersByTime(99)
      expect(applied).toEqual([])
      vi.advanceTimersByTime(1)
      expect(applied).toEqual(['a'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })
})

describe('updateMessages', () => {
  it('applies a frame of updates in one store write', () => {
    const base: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'Hi', timestamp: '2026-11-10T09:59:00.000Z' } as ChatMessage,
      reply('')
    ]
    useAppStore.setState({ activeThreadId: 't1', messages: base, earlierByThread: {} })
    const listener = vi.fn()
    const unsubscribe = useAppStore.subscribe(listener)
    useAppStore.getState().updateMessages([reply('a'), reply('ab'), reply('abc')])
    unsubscribe()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().messages.map((message) => message.content)).toEqual(['Hi', 'abc'])
  })

  it('keeps the other messages and the order when a streamed update keeps its timestamp', () => {
    const first = { id: 'u1', role: 'user', content: 'Hi', timestamp: '2026-11-10T09:59:00.000Z' } as ChatMessage
    const messages = [first, reply('a')]
    const next = upsertMessage(messages, reply('ab'))
    expect(next[0]).toBe(first)
    expect(next.map((message) => message.content)).toEqual(['Hi', 'ab'])
  })
})

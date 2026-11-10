// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { Markdown } from '../../src/renderer/chat/components/agent-elements/markdown'
import { startRenderCounts, stopRenderCounts } from '../../src/renderer/chat/components/agent-elements/render-counts'
import { mousseToUIMessages, reuseUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import type { ChatMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver
let observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = []

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
  observers = []
  globalThis.ResizeObserver = class {
    private entry: { callback: ResizeObserverCallback; targets: Element[] }
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: [] }
      observers.push(this.entry)
    }
    observe(target: Element) { this.entry.targets.push(target) }
    unobserve() {}
    disconnect() { this.entry.targets = [] }
  } as unknown as typeof ResizeObserver
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  globalThis.ResizeObserver = realResizeObserver
  stopRenderCounts()
  vi.useRealTimers()
})

const ask = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })
const answer = (id: string, text: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] })

/** `count` finished turns, then a live one whose reply is `live`. */
function thread(count: number, live: string): UIMessage[] {
  const finished = Array.from({ length: count }, (_, i) => [ask(`u${i}`, `Question ${i}`), answer(`a${i}`, `Answer ${i} with **bold** text.`)]).flat()
  return [...finished, ask('live', 'And now?'), answer('reply', live)]
}

const render = (messages: UIMessage[]) => act(() => root.render(createElement(MessageList, { messages, status: 'streaming' })))

describe('a streamed delta renders only the turn it changed', () => {
  it('renders one turn row and one reply for a delta in a 50-turn thread', () => {
    const messages = thread(49, 'The reply so far')
    render(messages)
    const counts = startRenderCounts()
    // A delta: the same message objects, except the live reply.
    render([...messages.slice(0, -1), answer('reply', 'The reply so far, and more')])
    expect(counts.TurnRow).toBe(1)
    expect(counts.AssistantParts).toBe(1)
  })

  it('renders one turn row per delta in a short thread too', () => {
    let messages = thread(10, 'Start')
    render(messages)
    const counts = startRenderCounts()
    for (let i = 0; i < 20; i++) {
      messages = [...messages.slice(0, -1), answer('reply', `Start ${'word '.repeat(i + 1)}`)]
      render(messages)
    }
    expect(counts.TurnRow).toBe(20)
  })

  it('places the prompt ticks at most twice while 100 deltas stream in', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    let messages = thread(10, 'Start')
    render(messages)
    act(() => { vi.advanceTimersByTime(1000) })
    const counts = startRenderCounts()
    const content = host.querySelector('.an-message-list')!.firstElementChild!
    for (let i = 0; i < 100; i++) {
      messages = [...messages.slice(0, -1), answer('reply', `Start ${'word '.repeat(i + 1)}`)]
      render(messages)
      // The transcript grew; the browser tells the observers of the content after layout.
      act(() => { for (const { callback, targets } of observers) if (targets.includes(content)) callback([], {} as ResizeObserver) })
      act(() => { vi.advanceTimersByTime(5) })
    }
    act(() => { vi.advanceTimersByTime(1000) })
    // 100 deltas over 500 ms: the growth throttle places them about once per 500 ms.
    expect(counts.updateMarkers ?? 0).toBeLessThanOrEqual(2)
    expect(counts.updateMarkers ?? 0).toBeGreaterThanOrEqual(1)
  })
})

describe('reuseUIMessages', () => {
  const chat = (id: string, role: ChatMessage['role'], content: string, streaming = false): ChatMessage =>
    ({ id, role, content, timestamp: `2026-11-10T10:00:0${id.length}.000Z`, ...(streaming ? { streaming: true } : {}) }) as ChatMessage

  it('keeps every message a delta did not change as the same object', () => {
    const before = [chat('u1', 'user', 'Hi'), chat('a1', 'assistant', 'Hello'), chat('u22', 'user', 'More?'), chat('a22', 'assistant', 'Yes', true)]
    const first = mousseToUIMessages(before)
    const after = [...before.slice(0, -1), chat('a22', 'assistant', 'Yes, and', true)]
    const second = reuseUIMessages(first, mousseToUIMessages(after))
    expect(second.slice(0, 3)).toEqual(first.slice(0, 3))
    second.slice(0, 3).forEach((message, index) => expect(message).toBe(first[index]))
    expect(second[3]).not.toBe(first[3])
    expect(second[3]!.parts).toEqual([{ type: 'text', text: 'Yes, and' }])
  })

  it('returns the previous list itself when nothing changed', () => {
    const messages = [chat('u1', 'user', 'Hi'), chat('a1', 'assistant', 'Hello')]
    const first = mousseToUIMessages(messages)
    expect(reuseUIMessages(first, mousseToUIMessages(messages))).toBe(first)
  })

  it('does not reuse a message whose nested parts changed', () => {
    const first = [{ id: 'a', role: 'assistant', parts: [{ type: 'tool-Bash', toolCallId: 't', state: 'input-available', input: { command: 'ls' } }] }] as unknown as UIMessage[]
    const next = [{ id: 'a', role: 'assistant', parts: [{ type: 'tool-Bash', toolCallId: 't', state: 'output-available', input: { command: 'ls' }, output: 'a.txt' }] }] as unknown as UIMessage[]
    expect(reuseUIMessages(first, next)[0]).toBe(next[0])
  })
})

describe('Markdown of a streaming reply', () => {
  const paragraph = 'The renderer keeps a bounded window of rows and recycles their nodes as the list scrolls.'
  const reply = Array.from({ length: 12 }, (_, i) => `## Part ${i}\n\n${paragraph}\n\n- one\n- two\n`).join('\n')

  /** Renders `reply` growing by `step` characters a time; returns how many blocks were split from text. */
  function streamInto(streaming: boolean, step: number): number {
    const counts = startRenderCounts()
    for (let end = step; end < reply.length + step; end += step) {
      act(() => root.render(createElement(Markdown, { content: reply.slice(0, Math.min(end, reply.length)), streaming })))
    }
    return counts.blocksSplit ?? 0
  }

  it('splits only the live tail while the reply streams, and ends on the same blocks', () => {
    const whole = streamInto(false, 40)
    const html = host.innerHTML
    act(() => root.render(createElement('div')))
    const live = streamInto(true, 40)
    expect(live).toBeLessThan(whole / 4)
    // The streamed reply ends on exactly what the whole text renders.
    act(() => root.render(createElement(Markdown, { content: reply, streaming: false })))
    expect(host.innerHTML).toBe(html)
  })

  it('marks only the live reply, so only its new blocks fade in', () => {
    const messages = thread(3, 'Live text.\n\nMore live text.')
    act(() => root.render(createElement(MessageList, { messages, status: 'streaming' })))
    const marked = [...host.querySelectorAll('.an-markdown')].map((el) => el.hasAttribute('data-streaming'))
    expect(marked.at(-1)).toBe(true)
    expect(marked.slice(0, -1).every((flag) => !flag)).toBe(true)
    act(() => root.render(createElement(MessageList, { messages, status: 'ready' })))
    expect(host.querySelector('.an-markdown[data-streaming]')).toBeNull()
  })
})


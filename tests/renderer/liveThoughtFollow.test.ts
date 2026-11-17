// @vitest-environment jsdom
/**
 * An opened thought that is still being written follows its newest words while the reader is at its end, and stops
 * when they scroll up in it; back at the end, it follows again. A thought row closed and opened again by hand while it
 * streams opens at its end at once, not at its top until the next words come. Following costs no extra render: a delta
 * still renders only the live row and the thought's own row.
 *
 * jsdom has no layout: the thought's box is given a height (175 px) and a content height that grows with its text, and
 * its scrollTop is clamped as a browser's is.
 */
import { act, createElement, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { TurnProgressContext, type TurnProgressState } from '../../src/renderer/chat/components/agent-elements/turn-progress'
import { countRender, startRenderCounts, stopRenderCounts } from '../../src/renderer/chat/components/agent-elements/render-counts'
import { mousseToUIMessages, reuseUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { applyStreamedUpdates, clearAllLiveText } from '../../src/renderer/stores/liveTextStore'
import { setReplyPacing } from '../../src/renderer/lib/replyPacingSetting'
import { COLLAPSE_CLOSE_MS } from '../../src/renderer/components/ui/Collapse'
import type { ChatMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BOX = 'max-h-[175px]'
const tops = new WeakMap<Element, number>()
const isBox = (element: Element) => element.classList.contains(BOX)

let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  // The thought's box: 175 px tall, 2 px of content per character of its text, scrolled as far as it can go.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return isBox(this) ? 175 : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: HTMLElement) { return isBox(this) ? 175 + (this.textContent ?? '').length * 2 : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) { return tops.get(this) ?? 0 },
    set(this: HTMLElement, value: number) { tops.set(this, Math.min(Math.max(0, value), Math.max(0, this.scrollHeight - this.clientHeight))) },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setReplyPacing(false)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  globalThis.ResizeObserver = realResizeObserver
  for (const name of ['clientHeight', 'scrollHeight', 'scrollTop']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  stopRenderCounts()
  clearAllLiveText()
  useAppStore.setState({ messages: [], activeThreadId: null, profileId: 'default' })
  setReplyPacing(true)
})

const at = (n: number) => new Date(Date.UTC(2026, 10, 18, 10, 0, 0) + n * 1000).toISOString()
const thinking = (n: number, content: string): ChatMessage =>
  ({ id: 'th', role: 'system', kind: 'thinking', content: '', timestamp: at(n), thinking: { content, status: 'processing' } })
const read = (id: string, n: number): ChatMessage => ({
  id, role: 'system', kind: 'tool_call', content: '', timestamp: at(n),
  toolCall: { title: 'Read', summary: 'Read a.ts', details: ['Tool: Read'], status: 'complete', toolName: 'Read', input: { file_path: 'a.ts' } },
})

function Transcript() {
  countRender('Transcript')
  const messages = useAppStore((s) => s.messages)
  const shown = useRef<UIMessage[]>([])
  const ui = useMemo(() => {
    const next = reuseUIMessages(shown.current, mousseToUIMessages(messages))
    shown.current = next
    return next
  }, [messages])
  const progress: TurnProgressState = { phase: 'thinking', step: { kind: 'reasoning' } }
  return createElement(TurnProgressContext.Provider, { value: progress }, createElement(MessageList, { messages: ui, status: 'streaming' }))
}

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(' ')
/** A thought this many words long, streamed as App's batcher applies a frame. */
function stream(count: number) {
  act(() => applyStreamedUpdates([thinking(5, `**Checking the build**\n\n${words(count)}`)], useAppStore.getState().messages, (next) => useAppStore.getState().updateMessages(next)))
}

const liveRow = () => host.querySelector<HTMLElement>('[data-turn-live]')!
const box = () => liveRow().querySelector<HTMLElement>(`.an-tool-group-rows .${BOX.replace(/[[\]]/g, '\\$&')}`)
/** How far the thought's box is from its end, in px: 0 at its end. */
const fromEnd = () => { const b = box()!; return b.scrollHeight - b.clientHeight - b.scrollTop }
const thoughtButton = () => [...liveRow().querySelectorAll<HTMLButtonElement>('.an-tool-group-rows button[aria-expanded]')].find((button) => button.querySelector('svg.thinking-icon'))!
/** The reader scrolls the thought's box to `top`. */
function scrollTo(top: number) {
  act(() => {
    box()!.scrollTop = top
    box()!.dispatchEvent(new Event('scroll'))
  })
}

describe('an opened thought follows its newest words', () => {
  it('while the reader is at its end; not once they scroll up; again once they are back', () => {
    useAppStore.setState({ messages: [{ id: 'u', role: 'user', content: 'Why?', timestamp: at(0), turnId: 't-u' }, read('r1', 1), thinking(5, `**Checking the build**\n\n${words(30)}`)], activeThreadId: 'thread-1' })
    act(() => root.render(createElement(Transcript)))
    act(() => liveRow().querySelector<HTMLButtonElement>('button.turn-live-toggle')!.click())
    expect(box()).not.toBeNull()
    expect(box()!.scrollTop).toBeGreaterThan(0)
    expect(fromEnd()).toBe(0)

    const counts = startRenderCounts()
    stream(60)
    expect(fromEnd()).toBe(0)
    // Following renders nothing more: the live row and the thought's own row, once each.
    expect(counts.TurnProgressRow).toBe(1)
    expect(counts.ThinkingTool).toBe(1)
    expect(counts.MessageList ?? 0).toBe(0)
    expect(counts.Transcript ?? 0).toBe(0)

    scrollTo(40)
    stream(90)
    expect(box()!.scrollTop).toBe(40)
    expect(fromEnd()).toBeGreaterThan(0)

    scrollTo(1e9)
    stream(120)
    expect(fromEnd()).toBe(0)
  })

  it('a thought row closed and opened again by hand opens at its end, before any new words', async () => {
    useAppStore.setState({ messages: [{ id: 'u', role: 'user', content: 'Why?', timestamp: at(0), turnId: 't-u' }, read('r1', 1), thinking(5, `**Checking the build**\n\n${words(30)}`)], activeThreadId: 'thread-1' })
    act(() => root.render(createElement(Transcript)))
    act(() => liveRow().querySelector<HTMLButtonElement>('button.turn-live-toggle')!.click())
    stream(80)
    act(() => thoughtButton().click())
    // Closed, its words unmount once the close has played.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, COLLAPSE_CLOSE_MS + 80)) })
    expect(box()).toBeNull()
    act(() => thoughtButton().click())
    expect(box()).not.toBeNull()
    expect(fromEnd()).toBe(0)
    // And it keeps following.
    stream(110)
    expect(fromEnd()).toBe(0)
  })
})

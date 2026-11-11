// @vitest-environment jsdom
/**
 * The transcript's own hooks into the end follower, with the defaults on (motion and paragraph
 * pacing): a prompt sent here is held near the top and the space under it closes when the turn
 * ends; a steer never moves a reader who scrolled up (#873); a long, windowed thread follows too.
 * jsdom has no layout, so a small one is given by hand: rows of fixed height stacked from the top,
 * the space under the content, and a viewport of 800 px that clamps the scroll position.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { PIN_TOP } from '../../src/renderer/chat/components/agent-elements/virtual/end-follow'
import { RENDER_ALL_THRESHOLD } from '../../src/renderer/chat/components/agent-elements/virtual/turn-window'
import { setReplyPacing } from '../../src/renderer/lib/replyPacingSetting'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CLIENT = 800
const ROW = 300

let root: Root
let host: HTMLElement
let observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = []
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver
const realRect = Element.prototype.getBoundingClientRect

/** The hand-made layout: content height, the top of each turn row by key, and the scroll position. */
const layout = { content: 0, rowTops: new Map<string, number>(), scrollTop: 0, writes: 0 }
const list = () => host.querySelector<HTMLElement>('.an-message-list')!
const reserve = () => Number.parseFloat(host.querySelector<HTMLElement>('[data-pin-reserve]')?.style.height || '0')
const scrollHeight = () => Math.max(CLIENT, layout.content + reserve())
const clamp = () => { layout.scrollTop = Math.max(0, Math.min(layout.scrollTop, scrollHeight() - CLIENT)) }
const end = () => scrollHeight() - CLIENT

function rect(top: number, height = 0): DOMRect {
  return { top, bottom: top + height, left: 0, right: 1000, width: 1000, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] })
  // The defaults: motion on, pacing on.
  setReplyPacing(true)
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
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
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement
    if (el.classList?.contains('an-message-list')) return rect(0, CLIENT)
    if (el.hasAttribute?.('data-pin-reserve')) { clamp(); return rect(layout.content - layout.scrollTop, reserve()) }
    const key = el.getAttribute?.('data-turn-key')
    if (key && layout.rowTops.has(key)) { clamp(); return rect(layout.rowTops.get(key)! - layout.scrollTop, ROW) }
    return realRect.call(this)
  }
  layout.content = 0
  layout.rowTops = new Map()
  layout.scrollTop = 0
  layout.writes = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  globalThis.ResizeObserver = realResizeObserver
  Element.prototype.getBoundingClientRect = realRect
  vi.useRealTimers()
})

/** Gives the list the hand-made layout once it is mounted. */
function attachLayout() {
  const el = list()
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => CLIENT })
  Object.defineProperty(el, 'clientTop', { configurable: true, get: () => 0 })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => { clamp(); return layout.scrollTop },
    set: (value: number) => { layout.writes += 1; layout.scrollTop = value; clamp() },
  })
}

/** Lays the thread's turns out from the top, ROW px each, plus `extra` px under the last one. */
function place(keys: string[], extra = 0) {
  layout.rowTops = new Map(keys.map((key, index) => [key, 24 + index * ROW]))
  layout.content = 24 + keys.length * ROW + extra
}

/** What the browser does after layout: tell every observer the transcript resized. */
const grew = () => act(() => { for (const { callback, targets } of observers) if (targets.length) callback([], {} as ResizeObserver) })
const frames = (count: number) => { for (let index = 0; index < count; index++) act(() => { vi.advanceTimersByTime(16) }) }

const ask = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })
const steered = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }], metadata: { steered: true } })
const answer = (id: string, text: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] })
const history = (count: number) => Array.from({ length: count }, (_, i) => [ask(`u${i}`, `Question ${i}`), answer(`a${i}`, `Answer ${i}.`)]).flat()
const render = (messages: UIMessage[], status: 'ready' | 'submitted' | 'streaming', afterTurns?: string) =>
  act(() => root.render(createElement(MessageList, { messages, status, afterTurns: afterTurns ? createElement('div', { className: 'queued-message' }, afterTurns) : null })))
/** The header of the last turn ("Working · 0s" while it runs), or null. */
const lastHeader = () => [...host.querySelectorAll('[data-turn-key]')].pop()?.querySelector('.turn-work')?.textContent ?? null
const keysOf = (count: number, ...more: string[]) => [...Array.from({ length: count }, (_, i) => `u${i}`), ...more]

describe('a prompt sent here', () => {
  it('is held near the top while its reply fits, and the space closes when the turn ends', () => {
    const before = history(5)
    place(keysOf(5))
    render(before, 'ready')
    attachLayout()
    layout.scrollTop = end()
    grew()

    // Send: the prompt's row is laid out under the thread, and the list pins it.
    place(keysOf(5, 'optimistic:1'), 0)
    layout.content += 80
    render([...before, ask('optimistic:1', 'Next please')], 'submitted')
    const rowTop = layout.rowTops.get('optimistic:1')!
    expect(list().scrollTop).toBe(rowTop - PIN_TOP)
    expect(reserve()).toBeGreaterThan(0)

    // The reply streams in, a paragraph at a time: nothing scrolls while it fits.
    const writes = layout.writes
    for (let step = 1; step <= 4; step++) {
      layout.content += 60
      render([...before, ask('optimistic:1', 'Next please'), answer('r', `${'Paragraph done.\n\n'.repeat(step)}half`)], 'streaming')
      grew()
      frames(2)
      expect(list().scrollTop).toBe(rowTop - PIN_TOP)
    }
    expect(layout.writes).toBe(writes)

    // The turn ends: the space closes over a few frames and the reply settles at the end.
    render([...before, ask('optimistic:1', 'Next please'), answer('r', 'Paragraph done.\n\n'.repeat(4) + 'end.')], 'ready')
    expect(reserve()).toBeGreaterThan(0)
    frames(30)
    expect(reserve()).toBe(0)
    expect(list().scrollTop).toBe(layout.content - CLIENT)
  })

  it('is held for a queued turn that starts while the reader is at the end', () => {
    const before = history(5)
    place(keysOf(5))
    render(before, 'ready')
    attachLayout()
    layout.scrollTop = end()
    grew()
    // The queue's next turn arrives before its run reports streaming: it is pinned all the same.
    place(keysOf(5, 'u-queued'), 80)
    render([...before, ask('u-queued', 'Queued one')], 'ready')
    expect(list().scrollTop).toBe(layout.rowTops.get('u-queued')! - PIN_TOP)
    // And it stays pinned once the run starts.
    render([...before, ask('u-queued', 'Queued one')], 'streaming')
    expect(list().scrollTop).toBe(layout.rowTops.get('u-queued')! - PIN_TOP)
    expect(reserve()).toBeGreaterThan(0)
  })

  it('shows the queued turn header with its pinned prompt, before its run reports streaming', () => {
    const before = history(5)
    const live = [...before, ask('u-live', 'Go'), answer('a-live', 'Done.')]
    place(keysOf(5, 'u-live'), 200)
    render(live, 'streaming', 'Queued one')
    attachLayout()
    layout.scrollTop = end()
    grew()
    // The turn ends with a message still queued.
    render(live, 'ready', 'Queued one')
    // The queue's next turn arrives a commit before its run's status: pinned, and its header is
    // already there, so nothing under the prompt moves when the status comes.
    place(keysOf(5, 'u-live', 'u-queued'), 80)
    render([...live, ask('u-queued', 'Queued one')], 'ready')
    expect(list().scrollTop).toBe(layout.rowTops.get('u-queued')! - PIN_TOP)
    expect(lastHeader()).toMatch(/^Working/)
    render([...live, ask('u-queued', 'Queued one')], 'streaming')
    expect(lastHeader()).toMatch(/^Working/)
    // Its run ends without a reply: the header goes.
    render([...live, ask('u-queued', 'Queued one')], 'ready')
    expect(lastHeader()).toBeNull()
  })

  it('shows no header for a prompt that arrives with no queued turn waiting and no run', () => {
    const before = history(5)
    place(keysOf(5))
    render(before, 'ready')
    attachLayout()
    layout.scrollTop = end()
    grew()
    place(keysOf(5, 'u-other'), 80)
    render([...before, ask('u-other', 'From elsewhere')], 'ready')
    expect(lastHeader()).toBeNull()
  })
})

describe('a steer while the reader is up in the thread (#873), defaults on', () => {
  it('never moves the reader', () => {
    const before = history(5)
    const live = [...before, ask('u-live', 'Refactor it'), answer('a-live', 'Looking at it.\n\n')]
    place(keysOf(5, 'u-live'), 400)
    render(live, 'streaming')
    attachLayout()
    layout.scrollTop = end()
    grew()
    // Up into the thread by wheel.
    act(() => { list().dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })) })
    layout.scrollTop = 300
    act(() => { list().dispatchEvent(new Event('scroll')) })
    expect(list().hasAttribute('data-following-end')).toBe(false)
    const writes = layout.writes
    // A message is steered into the running reply; the reply goes on under it.
    layout.content += 120
    render([...live, steered('s1', 'keep the order')], 'streaming')
    grew()
    layout.content += 200
    render([...live, steered('s1', 'keep the order'), answer('a-2', 'Kept.\n\nMore.\n\n')], 'streaming')
    grew()
    frames(20)
    expect(list().scrollTop).toBe(300)
    expect(layout.writes).toBe(writes)
  })
})

describe('a long, windowed thread, defaults on', () => {
  it('lands on the end in the same frame as the reply grows, and paces the reply', () => {
    const count = RENDER_ALL_THRESHOLD + 5
    const before = history(count)
    const live = (text: string) => [...before, ask('u-live', 'Go on'), answer('a-live', text)]
    place(keysOf(count, 'u-live'), 200)
    render(live('First paragraph.\n\nSecond half writ'), 'streaming')
    attachLayout()
    expect(list().dataset.windowed).toBe('true')
    layout.scrollTop = end()
    grew()
    frames(5)
    expect(host.querySelector('[data-message-id="a-live"]')?.textContent ?? '').not.toContain('Second half writ')
    // A paragraph more: the end moves 300 px, and the view is there before the frame paints.
    const start = list().scrollTop
    layout.content += 300
    render(live('First paragraph.\n\nSecond half written.\n\nThird'), 'streaming')
    grew()
    expect(end() - start).toBeGreaterThan(200)
    expect(list().scrollTop).toBe(end())
    frames(5)
    expect(list().scrollTop).toBe(end())
  })
})

// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { RENDER_ALL_THRESHOLD } from '../../src/renderer/chat/components/agent-elements/virtual/turn-window'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  globalThis.ResizeObserver = realResizeObserver
})

const ask = (id: string, text = 'Explain the turn window'): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })
const answer = (id: string, text: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] })

/** `count` finished question/answer turns. */
const history = (count: number): UIMessage[] =>
  Array.from({ length: count }, (_, index) => [ask(`u${index}`, `Question ${index}`), answer(`a${index}`, `Answer ${index}`)]).flat()

const render = (messages: UIMessage[], status: 'ready' | 'submitted' | 'streaming') =>
  act(() => root.render(createElement(MessageList, { messages, status })))

const list = () => host.querySelector<HTMLElement>('.an-message-list')!
const gap = () => host.querySelector<HTMLElement>('[data-reply-gap]')
/** What sits below the last turn, in order: the rows column first. */
const belowRows = () => [...list().firstElementChild!.children].slice(1)

/** The toolbar under each finished reply, in thread order (a prompt's toolbar is 28px). */
const toolbars = () => [...host.querySelectorAll<HTMLElement>('.chat-message-toolbar')].filter((el) => el.className.includes('h-[48px]'))

describe('the gap under a streaming reply', () => {
  it('is a fixed 44px, about three lines above the composer, never a share of the viewport', () => {
    render([ask('u1'), answer('a1', 'The renderer keeps a bounded window of rows')], 'streaming')
    expect(gap()).not.toBeNull()
    expect(gap()!.className).toContain('h-[44px]')
    expect(gap()!.className).not.toMatch(/vh|min-h/)
    // Directly under the rows: nothing else pushes the newest text up from the composer.
    expect(belowRows()).toEqual([gap()])
    expect(host.innerHTML).not.toMatch(/d+vh/)
  })

  it('holds the same size while the reply grows', () => {
    render([ask('u1'), answer('a1', 'The renderer')], 'streaming')
    const before = gap()!.outerHTML
    render([ask('u1'), answer('a1', 'The renderer keeps a bounded window of rows and recycles their nodes.')], 'streaming')
    expect(gap()!.outerHTML).toBe(before)
  })

  it('is there while the reply is awaited, before any text arrives', () => {
    render([ask('u1')], 'submitted')
    expect(gap()).not.toBeNull()
    expect(belowRows()).toEqual([gap()])
  })

  it('gives way to the last turn toolbar when the reply ends, which takes the same space', () => {
    render([ask('u1'), answer('a1', 'Done streaming.')], 'streaming')
    expect(gap()).not.toBeNull()
    expect(toolbars()).toEqual([])
    render([ask('u1'), answer('a1', 'Done streaming.')], 'ready')
    expect(gap()).toBeNull()
    expect(belowRows()).toEqual([])
    // 48px tall, pulled 4px (-mb-1) into the end padding: 44px of space, like the gap, so the text does not move.
    const [toolbar] = toolbars()
    expect(toolbar!.className).toContain('h-[48px]')
    expect(toolbar!.className).toContain('-mb-1')
  })

  it('stays when the reply ends without a toolbar to take its place, so nothing moves', () => {
    // A reply of tool calls only: no text to copy, no metadata, so no toolbar.
    const tools = { id: 'a1', role: 'assistant', parts: [{ type: 'tool-Bash', toolCallId: 't1', state: 'output-available', input: { command: 'ls' }, output: 'a.txt' }] } as unknown as UIMessage
    render([ask('u1'), tools], 'streaming')
    const during = gap()!.outerHTML
    render([ask('u1'), tools], 'ready')
    expect(toolbars()).toEqual([])
    expect(gap()!.outerHTML).toBe(during)
    expect(belowRows()).toEqual([gap()])
  })

  it('stays when a turn is stopped before the reply wrote anything', () => {
    render([ask('u1')], 'streaming')
    const during = gap()!.outerHTML
    render([ask('u1')], 'ready')
    expect(gap()!.outerHTML).toBe(during)
  })

  it('leaves earlier turns their full toolbar, and no leftover space under a finished thread', () => {
    render([ask('u1'), answer('a1', 'Done streaming.'), ask('u2', 'And then?'), answer('a2', 'That is all.')], 'ready')
    expect(gap()).toBeNull()
    const [first, last] = toolbars()
    expect(first!.className).toContain('h-[48px]')
    expect(first!.className).not.toContain('-mb-1')
    expect(last!.className).toContain('-mb-1')
  })

  it('keeps queued messages clear of the last turn toolbar', () => {
    act(() => root.render(createElement(MessageList, {
      messages: [ask('u1'), answer('a1', 'Done.')],
      status: 'ready',
      afterTurns: createElement('div', { 'data-queued': '' }, 'Queued: and then?'),
    })))
    const after = host.querySelector<HTMLElement>('[data-after-turns]')!
    expect(after.className).toContain('[&:not(:empty)]:mt-5')
    expect(after.querySelector('[data-queued]')).not.toBeNull()
  })

  it('is the same fixed gap on a long, windowed thread', () => {
    const messages = [...history(RENDER_ALL_THRESHOLD + 5), ask('live'), answer('streaming', 'Point A11: the store keeps one entry per thread')]
    render(messages, 'streaming')
    expect(list().dataset.windowed).toBe('true')
    expect(gap()!.className).toContain('h-[44px]')
    // Below the last turn; the turn window's spacers stay inside the rows column, above it.
    expect(belowRows()).toEqual([gap()])
    expect(list().firstElementChild!.firstElementChild!.querySelector('[data-reply-gap]')).toBeNull()
  })
})

describe('following a streaming reply', () => {
  /** Every ResizeObserver the list made, so a test can deliver "the transcript grew". */
  let observers: Array<{ callback: ResizeObserverCallback; targets: Element[]; boxes: Map<Element, string> }> = []
  beforeEach(() => {
    observers = []
    globalThis.ResizeObserver = class {
      private entry: { callback: ResizeObserverCallback; targets: Element[]; boxes: Map<Element, string> }
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [], boxes: new Map() }
        observers.push(this.entry)
      }
      observe(target: Element, options?: ResizeObserverOptions) {
        this.entry.targets.push(target)
        this.entry.boxes.set(target, options?.box ?? 'content-box')
      }
      unobserve() {}
      disconnect() { this.entry.targets = [] }
    } as unknown as typeof ResizeObserver
  })
  /** What the browser does after layout: tell the observers of the transcript content that it resized. */
  const grew = () => act(() => {
    const content = list().firstElementChild!
    for (const { callback, targets } of observers) if (targets.includes(content)) callback([], {} as ResizeObserver)
  })
  /**
   * Only the content's end padding grew (it is the composer's height, and the composer unfolded):
   * the browser tells observers of the border box, not of the content box.
   */
  const paddingGrew = () => act(() => {
    const content = list().firstElementChild!
    for (const { callback, targets, boxes } of observers) {
      if (targets.includes(content) && boxes.get(content) === 'border-box') callback([], {} as ResizeObserver)
    }
  })

  it('reaches the end when only the end padding grows, as when the composer unfolds', () => {
    render([ask('u1'), answer('a1', 'Done.')], 'ready')
    const size = scrollable(list(), 800)
    grew()
    expect(list().scrollTop).toBe(2200)
    // The composer unfolds: 30px more padding under the last turn.
    size.scrollHeight += 30
    paddingGrew()
    expect(list().scrollTop).toBe(2230)
  })

  /** Gives the list a scrollable size and a working `scrollTop` that counts writes; jsdom has no layout. */
  function scrollable(el: HTMLElement, clientHeight: number) {
    let top = 0
    const size = { scrollHeight: 3000, writes: 0 }
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => size.scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { size.writes += 1; top = Math.min(value, size.scrollHeight - clientHeight) } })
    return size
  }
  const jump = () => host.querySelector<HTMLElement>('.chat-jump')!

  it('keeps the newest text at the end while following, and stays put once the reader scrolls up', () => {
    render([ask('u1'), answer('a1', 'First line')], 'streaming')
    const size = scrollable(list(), 800)
    render([ask('u1'), answer('a1', 'First line\n\nSecond line')], 'streaming')
    grew()
    expect(list().scrollTop).toBe(2200)
    expect(jump().dataset.hidden).toBe('true')
    expect(list().hasAttribute('data-following-end')).toBe(true)

    // Reading an earlier message: a wheel up leaves follow mode, and native anchoring is back.
    act(() => { list().dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })) })
    list().scrollTop = 900
    expect(list().hasAttribute('data-following-end')).toBe(false)
    size.scrollHeight = 3400
    render([ask('u1'), answer('a1', 'First line\n\nSecond line\n\nThird line')], 'streaming')
    grew()
    expect(list().scrollTop).toBe(900)
    expect(jump().dataset.hidden).toBeUndefined()
  })

  it('writes the scroll position once per growth while following, and not at all when nothing moved', () => {
    render([ask('u1'), answer('a1', 'Line 0')], 'streaming')
    const size = scrollable(list(), 800)
    grew()
    let text = 'Line 0'
    size.writes = 0
    for (let i = 1; i <= 100; i++) {
      text += `\n\nLine ${i}`
      size.scrollHeight += 20
      render([ask('u1'), answer('a1', text)], 'streaming')
      grew()
    }
    // One write per frame of growth: rendering the delta itself writes nothing.
    expect(size.writes).toBe(100)
    expect(list().scrollTop).toBe(size.scrollHeight - 800)
    // A resize that did not move the end writes nothing.
    grew()
    expect(size.writes).toBe(100)
  })

  it('writes nothing while the reader is in the history', () => {
    render([ask('u1'), answer('a1', 'Line 0')], 'streaming')
    const size = scrollable(list(), 800)
    act(() => { list().dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })) })
    list().scrollTop = 500
    size.writes = 0
    let text = 'Line 0'
    for (let i = 1; i <= 20; i++) {
      text += `\n\nLine ${i}`
      size.scrollHeight += 20
      render([ask('u1'), answer('a1', text)], 'streaming')
      grew()
    }
    expect(size.writes).toBe(0)
    expect(list().scrollTop).toBe(500)
  })
})

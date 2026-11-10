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
  it('is a fixed 28px, about two lines above the composer, never a share of the viewport', () => {
    render([ask('u1'), answer('a1', 'The renderer keeps a bounded window of rows')], 'streaming')
    expect(gap()).not.toBeNull()
    expect(gap()!.className).toContain('h-[28px]')
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
    // 48px tall, pulled 20px (-mb-5) into the end padding: 28px of space, like the gap, so the text does not move.
    const [toolbar] = toolbars()
    expect(toolbar!.className).toContain('h-[48px]')
    expect(toolbar!.className).toContain('-mb-5')
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
    expect(first!.className).not.toContain('-mb-5')
    expect(last!.className).toContain('-mb-5')
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
    expect(gap()!.className).toContain('h-[28px]')
    // Below the last turn; the turn window's spacers stay inside the rows column, above it.
    expect(belowRows()).toEqual([gap()])
    expect(list().firstElementChild!.firstElementChild!.querySelector('[data-reply-gap]')).toBeNull()
  })
})

describe('following a streaming reply', () => {
  /** Gives the list a scrollable size and a working `scrollTop`; jsdom has no layout. */
  function scrollable(el: HTMLElement, scrollHeight: number, clientHeight: number) {
    let top = 0
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = Math.min(value, scrollHeight - clientHeight) } })
  }
  const jump = () => host.querySelector<HTMLElement>('.chat-jump')!

  it('keeps the newest text at the end while following, and stays put once the reader scrolls up', () => {
    render([ask('u1'), answer('a1', 'First line')], 'streaming')
    scrollable(list(), 3000, 800)
    render([ask('u1'), answer('a1', 'First line\n\nSecond line')], 'streaming')
    expect(list().scrollTop).toBe(2200)
    expect(jump().dataset.hidden).toBe('true')

    // Reading an earlier message: a wheel up leaves follow mode.
    act(() => { list().dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })) })
    list().scrollTop = 900
    render([ask('u1'), answer('a1', 'First line\n\nSecond line\n\nThird line')], 'streaming')
    expect(list().scrollTop).toBe(900)
    expect(jump().dataset.hidden).toBeUndefined()
  })
})

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

describe('the gap under a streaming reply', () => {
  it('is a fixed 48px, the height of the toolbar a finished turn shows, never a share of the viewport', () => {
    render([ask('u1'), answer('a1', 'The renderer keeps a bounded window of rows')], 'streaming')
    expect(gap()).not.toBeNull()
    expect(gap()!.className).toContain('h-[48px]')
    expect(gap()!.className).not.toMatch(/vh|min-h/)
    // Directly under the rows: nothing else pushes the newest text up from the composer.
    expect(belowRows()).toEqual([gap()])
    expect(host.innerHTML).not.toMatch(/\d+vh/)
  })

  it('holds the same size while the reply grows', () => {
    const turn = [ask('u1'), answer('a1', 'The renderer')]
    render(turn, 'streaming')
    const before = gap()!.outerHTML
    render([ask('u1'), answer('a1', 'The renderer keeps a bounded window of rows and recycles their nodes.')], 'streaming')
    expect(gap()!.outerHTML).toBe(before)
  })

  it('is there while the reply is awaited, before any text arrives', () => {
    render([ask('u1')], 'submitted')
    expect(gap()).not.toBeNull()
    expect(belowRows()).toEqual([gap()])
  })

  it('gives way to the turn toolbar when the reply ends, and does not come back on a finished thread', () => {
    render([ask('u1'), answer('a1', 'Done streaming.')], 'streaming')
    expect(gap()).not.toBeNull()
    render([ask('u1'), answer('a1', 'Done streaming.')], 'ready')
    expect(gap()).toBeNull()
    expect(belowRows()).toEqual([])
    // The toolbar takes the gap's place under the reply, at the same 48px height.
    const lastTurn = host.querySelector('[data-turn-key]:last-of-type') ?? list()
    expect(lastTurn.innerHTML).toContain('h-[48px]')
    // A thread that had a reply in this view keeps no leftover space under it.
    render([ask('u1'), answer('a1', 'Done streaming.'), ask('u2', 'And then?'), answer('a2', 'That is all.')], 'ready')
    expect(gap()).toBeNull()
  })

  it('is the same fixed gap on a long, windowed thread', () => {
    const messages = [...history(RENDER_ALL_THRESHOLD + 5), ask('live'), answer('streaming', 'Point A11: the store keeps one entry per thread')]
    render(messages, 'streaming')
    expect(list().dataset.windowed).toBe('true')
    expect(gap()!.className).toContain('h-[48px]')
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

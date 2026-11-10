// @vitest-environment jsdom
/**
 * Queue and Steer in the transcript: messages steered into a running reply show inside it as one block, and
 * queueing, steering, dequeueing and a queued message's turn starting never move a reader who scrolled up. At the
 * end, the end is followed; a prompt the person sends from here goes to the end.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageList, groupMessagesIntoTurns, readSteerGroup } from '../../src/renderer/chat/components/agent-elements/message-list'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver
/** Every ResizeObserver the list made, so a test can deliver "the transcript grew". */
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
})

const ask = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })
const steered = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }], metadata: { steered: true } })
const answer = (id: string, text: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] })

const render = (messages: UIMessage[], status: 'ready' | 'streaming', afterTurns?: ReactNode) =>
  act(() => root.render(createElement(MessageList, { messages, status, afterTurns })))

const list = () => host.querySelector<HTMLElement>('.an-message-list')!
const turnRows = () => host.querySelectorAll('[data-turn-key]')
/** What the browser does after layout: tell the observers of the transcript content that it resized. */
const grew = () => act(() => {
  const content = list().firstElementChild!
  for (const { callback, targets } of observers) if (targets.includes(content)) callback([], {} as ResizeObserver)
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
/** The reader scrolls up into the history, as a wheel does. */
const scrollUp = (to: number) => {
  act(() => { list().dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })) })
  list().scrollTop = to
}
const queued = (...texts: string[]) => createElement('div', { className: 'queued-messages' }, texts.map((text) => createElement('div', { key: text, className: 'queued-message' }, text)))

describe('messages steered into a running reply', () => {
  it('join that reply as one block where they entered it, not as turns of their own', () => {
    const messages = [
      ask('u1', 'Refactor the queue'),
      answer('a1', 'Looking at the queue'),
      steered('s1', 'use the id'),
      steered('s2', 'and keep the order'),
      steered('s3', 'no duplicates'),
      answer('a2', 'Understood: by id, in order, once each')
    ]
    const turns = groupMessagesIntoTurns(messages)
    expect(turns).toHaveLength(1)
    const rows = turns[0]!.assistantMsgs
    expect(rows.map((row) => row.id)).toEqual(['a1', 'steer-group:s1', 'a2'])
    expect(readSteerGroup(rows[1]!)?.map((message) => message.id)).toEqual(['s1', 's2', 's3'])

    render(messages, 'streaming')
    expect(turnRows()).toHaveLength(1)
    const groups = host.querySelectorAll('.steer-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.textContent).toContain('Steer')
    expect([...groups[0]!.querySelectorAll('[data-steered-id]')].map((el) => (el as HTMLElement).dataset.steeredId)).toEqual(['s1', 's2', 's3'])
    // The block sits between the reply text before it and the text after it.
    const text = host.textContent ?? ''
    expect(text.indexOf('Looking at the queue')).toBeLessThan(text.indexOf('use the id'))
    expect(text.indexOf('no duplicates')).toBeLessThan(text.indexOf('Understood'))
  })

  it('keep the same group row while nothing in it changed, and split around reply text between them', () => {
    const base = [ask('u1', 'Go'), answer('a1', 'Working'), steered('s1', 'first')]
    const once = groupMessagesIntoTurns(base)[0]!.assistantMsgs[1]
    const again = groupMessagesIntoTurns(base)[0]!.assistantMsgs[1]
    expect(again).toBe(once)
    const split = groupMessagesIntoTurns([...base, answer('a2', 'Read it'), steered('s2', 'second')])[0]!.assistantMsgs
    expect(split.map((row) => row.id)).toEqual(['a1', 'steer-group:s1', 'a2', 'steer-group:s2'])
  })
})

describe('the reading position while queueing and steering', () => {
  const thread = [ask('u1', 'Write the notes'), answer('a1', 'Line 1\n\nLine 2')]

  it('stays put for a reader scrolled up: queueing, steering, dequeueing, and a queued message starting its turn', () => {
    render(thread, 'streaming')
    const size = scrollable(list(), 800)
    grew()
    scrollUp(900)
    expect(list().hasAttribute('data-following-end')).toBe(false)
    size.writes = 0

    // Three messages are queued under the reply.
    render(thread, 'streaming', queued('A', 'B', 'C'))
    size.scrollHeight += 180
    grew()
    expect(list().scrollTop).toBe(900)

    // C is steered: it leaves the queue and joins the running reply.
    const withSteer = [...thread, steered('s-c', 'C')]
    render(withSteer, 'streaming', queued('A', 'B'))
    grew()
    expect(list().scrollTop).toBe(900)

    // B is removed from the queue.
    render(withSteer, 'streaming', queued('A'))
    size.scrollHeight -= 60
    grew()
    expect(list().scrollTop).toBe(900)

    // The reply ends and the queue starts A's turn.
    const nextTurn = [...withSteer, answer('a2', 'Done, with C'), ask('u-a', 'A')]
    render(nextTurn, 'streaming')
    size.scrollHeight += 120
    grew()
    expect(list().scrollTop).toBe(900)
    expect(size.writes).toBe(0)
    expect(list().hasAttribute('data-following-end')).toBe(false)
  })

  it('follows the end for a reader at the end, through the same changes', () => {
    render(thread, 'streaming')
    const size = scrollable(list(), 800)
    grew()
    expect(list().scrollTop).toBe(2200)

    render(thread, 'streaming', queued('A', 'B', 'C'))
    size.scrollHeight += 180
    grew()
    expect(list().scrollTop).toBe(size.scrollHeight - 800)

    render([...thread, steered('s-c', 'C')], 'streaming', queued('A', 'B'))
    size.scrollHeight += 40
    grew()
    expect(list().scrollTop).toBe(size.scrollHeight - 800)

    render([...thread, steered('s-c', 'C'), answer('a2', 'Done'), ask('u-a', 'A')], 'streaming')
    size.scrollHeight += 120
    grew()
    expect(list().scrollTop).toBe(size.scrollHeight - 800)
    expect(list().hasAttribute('data-following-end')).toBe(true)
  })

  it('takes a reader scrolled up to the end when they send a prompt themselves', () => {
    render([...thread, answer('a2', 'Done')], 'ready')
    const size = scrollable(list(), 800)
    grew()
    scrollUp(500)
    render([...thread, answer('a2', 'Done'), ask('optimistic:1', 'Next please')], 'streaming')
    size.scrollHeight += 100
    grew()
    expect(list().hasAttribute('data-following-end')).toBe(true)
    expect(list().scrollTop).toBe(size.scrollHeight - 800)
  })
})

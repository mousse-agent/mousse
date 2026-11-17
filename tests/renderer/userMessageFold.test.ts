// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { PROMPT_FOLD_HEIGHT, UserMessage } from '../../src/renderer/chat/components/agent-elements/user-message'
import { bringIntoView } from '../../src/renderer/chat/components/agent-elements/find/reveal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let textHeight = 0
/** Reads of the prompt text's height, and whether React was committing during one. */
let heightReads = 0
let committing = false
const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')

/** jsdom has no ResizeObserver: this one reports what it observes when `resize()` is called, as the browser does before a paint. */
let observed: { callback: () => void; targets: Set<Element> }[] = []
class FakeResizeObserver {
  private readonly entry: { callback: () => void; targets: Set<Element> }
  constructor(callback: () => void) {
    this.entry = { callback, targets: new Set() }
    observed.push(this.entry)
  }
  observe(target: Element) { this.entry.targets.add(target) }
  unobserve(target: Element) { this.entry.targets.delete(target) }
  disconnect() { this.entry.targets.clear() }
}
const resize = () => act(() => { for (const entry of observed) if (entry.targets.size > 0) entry.callback() })

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains('chat-user-text')) return 0
      heightReads += committing ? 1000 : 1
      return textHeight
    }
  })
  observed = []
  heightReads = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight)
  vi.unstubAllGlobals()
})

function show(text: string): void {
  const message = { id: 'm1', role: 'user', parts: [{ type: 'text', text }] } as UIMessage
  committing = true
  try {
    act(() => root.render(createElement(UserMessage, { message })))
  } finally {
    committing = false
  }
  resize()
}

describe('a long prompt', () => {
  it('folds at 176px when it is at least twice that tall, and opens with "Show full message"', () => {
    textHeight = PROMPT_FOLD_HEIGHT * 2
    show('line\n'.repeat(40))
    const text = host.querySelector('.chat-user-text')!
    const button = host.querySelector<HTMLButtonElement>('.chat-user-fold')!
    expect(PROMPT_FOLD_HEIGHT).toBe(176)
    expect(text.classList.contains('is-folded')).toBe(true)
    expect(button.textContent).toBe('Show full message')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    act(() => button.click())
    expect(text.classList.contains('is-folded')).toBe(false)
    expect(button.textContent).toBe('Show less')
    act(() => button.click())
    expect(text.classList.contains('is-folded')).toBe(true)
    // The whole text stays in the bubble, folded or not.
    expect(text.textContent).toBe('line\n'.repeat(40))
  })

  it('stays whole when folding would hide too little', () => {
    textHeight = PROMPT_FOLD_HEIGHT * 2 - 1
    show('a few lines')
    expect(host.querySelector('.chat-user-text')!.classList.contains('is-folded')).toBe(false)
    expect(host.querySelector('.chat-user-fold')).toBeNull()
  })

  it('measures from the resize observer, never while React commits', () => {
    // A size read during a commit lays out the transcript half-way through a turn-window move and can undo its scroll.
    textHeight = PROMPT_FOLD_HEIGHT * 3
    show('line\n'.repeat(60))
    expect(heightReads).toBe(1)
    expect(host.querySelector('.chat-user-text')!.classList.contains('is-folded')).toBe(true)
  })

  it('opens when Find lands on a match in the folded part', () => {
    textHeight = PROMPT_FOLD_HEIGHT * 3
    show(`${'line\n'.repeat(60)}needle at the end`)
    const text = host.querySelector('.chat-user-text')!
    expect(text.classList.contains('is-folded')).toBe(true)
    const node = text.firstChild as Text
    const range = document.createRange()
    range.setStart(node, node.data.indexOf('needle'))
    range.setEnd(node, node.data.indexOf('needle') + 'needle'.length)
    range.getBoundingClientRect = () => ({ top: 400, bottom: 417, left: 0, right: 40, width: 40, height: 17, x: 0, y: 400, toJSON: () => ({}) }) as DOMRect
    act(() => bringIntoView(range, { container: host, onProgrammaticScroll: () => {} }))
    expect(text.classList.contains('is-folded')).toBe(false)
    expect(host.querySelector('.chat-user-fold')!.textContent).toBe('Show less')
  })
})

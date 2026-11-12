// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { PROMPT_FOLD_HEIGHT, UserMessage } from '../../src/renderer/chat/components/agent-elements/user-message'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const globalCss = readFileSync(resolve(process.cwd(), 'src/renderer/styles/global.css'), 'utf8')

let host: HTMLDivElement
let root: Root
let textHeight = 0
const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('chat-user-text') ? textHeight : 0
    }
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight)
})

function show(text: string): void {
  const message = { id: 'm1', role: 'user', parts: [{ type: 'text', text }] } as UIMessage
  act(() => root.render(createElement(UserMessage, { message })))
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

  it('sits in a bubble with 12px padding, at most 80% wide, clipped to 176px with a fade', () => {
    textHeight = 40
    show('hi')
    const bubble = host.querySelector('.chat-user-bubble')!
    expect(bubble.className).toContain('max-w-[80%]')
    expect(bubble.className).toContain('p-3')
    expect(globalCss).toMatch(/\.chat-user-text\.is-folded \{\s*max-height: 176px;\s*overflow: hidden;\s*mask-image:/)
  })
})

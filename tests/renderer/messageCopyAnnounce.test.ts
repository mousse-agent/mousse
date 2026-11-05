// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('Copy under a message is a named Tab stop that announces "Copied"', () => {
  act(() => root.render(createElement(MessageList, {
    messages: [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'The build bundles the renderer.' }] }],
    status: 'ready',
    showCopyToolbar: true
  })))
  const copy = host.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!
  expect(copy.tabIndex).toBe(0)
  const status = copy.parentElement!.querySelector('[role="status"][aria-live="polite"]')!
  expect(status.textContent).toBe('')
  act(() => copy.click())
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('The build bundles the renderer.')
  expect(status.textContent).toBe('Copied')
})

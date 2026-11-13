// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { UserMessage } from '../../src/renderer/chat/components/agent-elements/user-message'
import { expandComposerQuotes, registerQuote } from '../../src/renderer/lib/composerQuotes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('a sent prompt shows the quote it replied to as a pill at its place, while its text keeps the quote marks the agent got', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const token = registerQuote('reuses the same connection id')
  const text = expandComposerQuotes(`In this step ${token} on every attempt?`)
  expect(text).toBe('In this step\n\n"reuses the same connection id"\n\non every attempt?')
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  act(() => root.render(createElement(UserMessage, { message: { id: 'm1', role: 'user', parts: [{ type: 'text', text }] } as UIMessage })))
  const prompt = host.querySelector('.chat-user-text')!
  expect([...prompt.childNodes].map((node) => (node as Element).classList?.contains('sent-quote-pill') ? `[${node.textContent}]` : node.textContent))
    .toEqual(['In this step', '[Replying to: reuses the same connection id]', 'on every attempt?'])
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

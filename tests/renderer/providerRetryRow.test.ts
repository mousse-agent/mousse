// @vitest-environment jsdom
/**
 * A turn's provider retries in the transcript: one row that counts them, says the provider recovered (and is never
 * read as the answer), or has become the turn's error, whose title says how many retries there were.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { TurnActionsContext, type TurnActions } from '../../src/renderer/chat/components/agent-elements/turn-actions'
import { chatStatusFromPhase, mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import type { ChatMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const at = '2026-11-18T10:00:00.000Z'
const later = (ms: number) => new Date(Date.parse(at) + ms).toISOString()
const prompt: ChatMessage = { id: 'u1', role: 'user', content: 'Do the work', timestamp: at }
const REFUSED = 'Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)'

function show(messages: ChatMessage[], phase: Parameters<typeof chatStatusFromPhase>[0] = 'idle') {
  const actions: TurnActions = { retryTitle: () => null, retry: vi.fn(), continueRun: vi.fn(), stopCompaction: vi.fn() }
  act(() => root.render(createElement(TurnActionsContext.Provider, { value: actions },
    createElement(MessageList, { messages: mousseToUIMessages(messages), status: chatStatusFromPhase(phase) }))))
}
const text = () => host.textContent?.replace(/\s+/g, ' ') ?? ''

describe('the provider retry row', () => {
  it('counts the retries while they run', () => {
    show([prompt, { id: 'r1', role: 'assistant', kind: 'provider_retry', content: 'Retrying provider… (3/10)', streaming: true, timestamp: later(1_000),
      providerRetry: { status: 'retrying', attempt: 3, maxAttempts: 10, cause: 'connection error' } }], 'thinking')
    expect(text()).toContain('Retrying provider… (3/10)')
    expect(host.querySelector('[title="Last failure: connection error"]')).not.toBeNull()
  })

  it('says the provider recovered, and leaves the reply after it as the answer', () => {
    show([
      prompt,
      { id: 'r1', role: 'assistant', kind: 'provider_retry', content: 'Provider recovered after 2 retries', streaming: false, timestamp: later(1_000),
        providerRetry: { status: 'recovered', attempt: 2, maxAttempts: 10 } },
      { id: 'a1', role: 'assistant', content: 'The answer of the turn', timestamp: later(20_000), completedAt: later(20_000) }
    ])
    expect(text()).toContain('Provider recovered after 2 retries')
    expect(text()).toContain('The answer of the turn')
    const order = ['Provider recovered', 'The answer of the turn'].map((part) => text().indexOf(part))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it("once the retries ran out it is the turn's error, titled with the count and showing the provider's message", () => {
    show([prompt, { id: 'r1', role: 'system', content: `[provider_unavailable] ${REFUSED} (after 10/10 retries)`, timestamp: later(60_000),
      error: { code: 'provider_unavailable', message: REFUSED, details: { provider: 'claude', retries: { attempt: 10, max: 10 }, supportId: 'ref-1' } } }])
    expect(text()).toContain('Provider error after 10/10 retries')
    expect(text()).toContain(REFUSED)
    expect(text()).not.toContain('Something went wrong')
  })
})

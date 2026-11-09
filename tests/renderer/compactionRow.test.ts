// @vitest-environment jsdom
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

const at = '2026-11-09T10:00:00.000Z'
const prompt: ChatMessage = { id: 'u1', role: 'user', content: 'Back to this', timestamp: at }
const row = (patch: Partial<ChatMessage>): ChatMessage =>
  ({ id: 'k1', role: 'assistant', kind: 'context_compaction', content: 'Compacting context…', timestamp: at, ...patch })

function show(messages: ChatMessage[], stopCompaction = vi.fn()) {
  const actions: TurnActions = { retryTitle: () => null, retry: vi.fn(), continueRun: vi.fn(), stopCompaction }
  act(() => root.render(createElement(TurnActionsContext.Provider, { value: actions },
    createElement(MessageList, { messages: mousseToUIMessages(messages), status: chatStatusFromPhase('idle') }))))
  return { stopCompaction }
}
const stop = () => host.querySelector<HTMLButtonElement>('button[aria-label="Stop compacting"]')
const text = () => host.textContent?.replace(/\s+/g, ' ') ?? ''

describe('the compaction row', () => {
  it('can be stopped while a compaction a person started runs', () => {
    const { stopCompaction } = show([prompt, row({ streaming: true, compaction: { manual: true } })])
    expect(text()).toContain('Compacting context…')
    expect(stop()?.getAttribute('title')).toBe('Stop compacting')
    act(() => stop()!.click())
    expect(stopCompaction).toHaveBeenCalledOnce()
  })

  it('has no Stop for a compaction inside a turn, nor once it ended', () => {
    show([prompt, row({ streaming: true })])
    expect(stop()).toBeNull()
    show([prompt, row({ streaming: false, content: 'Context compacted · 182K → 9K', compaction: { manual: true } })])
    expect(stop()).toBeNull()
    expect(text()).toContain('Context compacted · 182K → 9K')
  })

  it('says when the full history was kept', () => {
    show([prompt, row({ streaming: false, content: 'Compaction stopped · full history kept', compaction: { manual: true, kept: 'stopped' } })])
    expect(text()).toContain('Compaction stopped · full history kept')
    show([prompt, row({ streaming: false, content: 'Compaction interrupted · full history kept', compaction: { manual: true, kept: 'interrupted' } })])
    expect(text()).toContain('Compaction interrupted · full history kept')
  })
})

describe('compaction rows after a turn', () => {
  it('leave the answer in place, and do not count toward the time the turn worked', () => {
    const start = Date.parse(at)
    const later = (ms: number) => new Date(start + ms).toISOString()
    show([
      prompt,
      { id: 'a1', role: 'assistant', content: 'The answer of the turn', timestamp: later(41_000) },
      row({ id: 'k1', streaming: false, content: 'Compaction stopped · full history kept', compaction: { manual: true, kept: 'stopped' }, timestamp: later(2 * 60 * 60_000) }),
      row({ id: 'k2', streaming: false, content: 'Context compacted · 51K → 28K', compaction: { manual: true }, timestamp: later(2 * 60 * 60_000 + 5_000) })
    ])
    expect(text()).toContain('The answer of the turn')
    expect(text()).toContain('Worked for 41s')
    // In the order they happened, after the answer: no row folds into the turn's activity.
    const order = ['The answer of the turn', 'Compaction stopped', 'Context compacted'].map((part) => text().indexOf(part))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})

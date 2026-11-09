// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { createTurnActions, TurnActionsContext } from '../../src/renderer/chat/components/agent-elements/turn-actions'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
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

const at = (seconds: number) => new Date(Date.parse('2026-11-09T10:00:00.000Z') + seconds * 1000).toISOString()
/** A turn's prompt and reply; `copied` leaves out the turn, as a fork's copies of its source do. */
const turn = (ordinal: number, prompt: string, copied = false): ChatMessage[] => {
  const turnId = copied ? {} : { turnId: `run:thread:t1:ordinal:${ordinal}` }
  return [
    { id: `u${ordinal}`, role: 'user', content: prompt, timestamp: at(ordinal * 10), ...turnId },
    { id: `a${ordinal}`, role: 'assistant', content: `reply to ${prompt}`, timestamp: at(ordinal * 10 + 1), ...turnId }
  ]
}
const forkButtons = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Fork from here"]')]

describe('Fork from here', () => {
  const show = (messages: ChatMessage[], status: 'ready' | 'streaming', forkFrom = vi.fn()) => {
    act(() => root.render(createElement(
      TurnActionsContext.Provider,
      { value: createTurnActions({ prompt: () => undefined, send: vi.fn(), forkFrom }) },
      createElement(MessageList, { messages: mousseToUIMessages(messages), status })
    )))
    return forkFrom
  }

  it('is offered on every finished turn and forks after that turn', () => {
    const forkFrom = show([...turn(1, 'First'), ...turn(2, 'Second')], 'ready')
    expect(forkButtons()).toHaveLength(2)
    act(() => forkButtons()[0]!.click())
    expect(forkFrom).toHaveBeenCalledExactlyOnceWith('run:thread:t1:ordinal:1')
  })

  it('is not offered on the turn that is still running, nor on a fork\'s copies of its source', () => {
    show([...turn(1, 'Copied', true), ...turn(2, 'Own'), ...turn(3, 'Running')], 'streaming')
    expect(forkButtons()).toHaveLength(1)
  })

  it('is not offered without a fork action (another client of the transcript)', () => {
    act(() => root.render(createElement(MessageList, { messages: mousseToUIMessages(turn(1, 'First')), status: 'ready' })))
    expect(forkButtons()).toHaveLength(0)
  })
})

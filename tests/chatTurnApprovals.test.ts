// @vitest-environment jsdom
import type { UIMessage } from 'ai'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../src/renderer/chat/components/agent-elements/message-list'
import { chatStatusFromTurn } from '../src/renderer/chat/adapters/mousseToUI'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-10-29T10:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

const user: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Run the checks' }], createdAt: at(0) } as unknown as UIMessage
const command = (id: string, seconds: number, done: boolean): UIMessage =>
  ({
    id,
    role: 'assistant',
    createdAt: at(seconds),
    parts: [{
      type: 'tool-Bash',
      toolCallId: id,
      state: done ? 'output-available' : 'input-available',
      input: { command: `npm run ${id}` },
      ...(done ? { output: { stdout: '', exitCode: 0 } } : {})
    }]
  }) as unknown as UIMessage
const reply = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'text', text }] }) as unknown as UIMessage

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

/** Moves the clock (and the indicator's tick) to `seconds` after sending, then renders the list. */
async function render(seconds: number, messages: UIMessage[], status: ReturnType<typeof chatStatusFromTurn>) {
  await act(async () => {
    vi.advanceTimersByTime(Math.max(0, T0 + seconds * 1000 - Date.now()))
  })
  await act(async () => {
    root.render(createElement(MessageList, { messages, status }))
  })
}

/** Renders the list at `seconds` after the message was sent, with the chat status of `phase`. */
async function show(seconds: number, messages: UIMessage[], phase: string) {
  await render(seconds, messages, chatStatusFromTurn({ phase, turnId: 'run:1' }))
  return {
    turns: host.querySelectorAll('[data-turn-key]').length,
    indicators: [...host.querySelectorAll('.turn-work-label')].map((node) => node.textContent)
  }
}

describe('a reply with approvals in the middle', () => {
  it('stays one turn with one working indicator, and its time covers the whole reply', async () => {
    expect(await show(2, [user, command('lint', 1, false)], 'tool_running')).toEqual({ turns: 1, indicators: ['Working for 2 seconds'] })
    // The agent waits for the first approval: still the same reply, still working.
    expect(await show(6, [user, command('lint', 1, false)], 'awaiting_input')).toEqual({ turns: 1, indicators: ['Working for 6 seconds'] })
    // Approved: the command runs, and the next one waits for its own approval.
    expect(await show(12, [user, command('lint', 1, true), command('test', 10, false)], 'awaiting_input')).toEqual({ turns: 1, indicators: ['Working for 12 seconds'] })
    expect(await show(20, [user, command('lint', 1, true), command('test', 10, true), reply('r1', 19, 'All green.')], 'streaming')).toEqual({ turns: 1, indicators: ['Working for 20 seconds'] })
    expect(await show(21, [user, command('lint', 1, true), command('test', 10, true), reply('r1', 19, 'All green.')], 'completed')).toEqual({ turns: 1, indicators: ['Worked for 21s'] })
  })

  it('times the whole reply even when the status read as ready during a pause', async () => {
    await show(2, [user, command('lint', 1, false)], 'tool_running')
    // An older daemon (or a request with no run id) reports the wait as not running.
    await render(6, [user, command('lint', 1, false)], 'ready')
    await show(15, [user, command('lint', 1, true), reply('r1', 14, 'Done.')], 'streaming')
    expect(await show(30, [user, command('lint', 1, true), reply('r1', 14, 'Done.')], 'completed')).toEqual({ turns: 1, indicators: ['Worked for 30s'] })
  })
})

describe('chatStatusFromTurn', () => {
  it('reads a run waiting for an answer as streaming', () => {
    expect(chatStatusFromTurn({ phase: 'awaiting_input', turnId: 'run:1' })).toBe('streaming')
  })

  it('reads a request with no run behind it as ready', () => {
    expect(chatStatusFromTurn({ phase: 'awaiting_input', turnId: null })).toBe('ready')
  })

  it('maps every other phase as before', () => {
    expect(chatStatusFromTurn(undefined)).toBe('ready')
    expect(chatStatusFromTurn({ phase: 'queued' })).toBe('submitted')
    expect(chatStatusFromTurn({ phase: 'tool_running', turnId: 'run:1' })).toBe('streaming')
    expect(chatStatusFromTurn({ phase: 'completed', turnId: 'run:1' })).toBe('ready')
    expect(chatStatusFromTurn({ phase: 'failed' })).toBe('error')
  })
})

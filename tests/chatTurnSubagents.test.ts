// @vitest-environment jsdom
import type { UIMessage } from 'ai'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../src/renderer/chat/components/agent-elements/message-list'
import { SubagentCardsContext } from '../src/renderer/chat/components/agent-elements/tools/subagent-cards-context'
import { chatStatusFromTurn } from '../src/renderer/chat/adapters/mousseToUI'
import type { SubagentCardModel } from '../src/renderer/chat/adapters/subagentCards'
import type { SubagentState } from '../src/shared/subagents'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-10-29T10:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

const NAMES = ['Test Subagent One', 'Test Subagent Two', 'Test Subagent Three']

const user = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], createdAt: at(seconds) }) as unknown as UIMessage
const reply = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'text', text }] }) as unknown as UIMessage
const thought = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'tool-Thinking', toolCallId: id, state: 'output-available', input: { thought: text }, output: text }] }) as unknown as UIMessage
const launch = (index: number, seconds: number): UIMessage =>
  ({
    id: `launch-${index}`,
    role: 'assistant',
    createdAt: at(seconds),
    parts: [{ type: 'tool-Subagent', toolCallId: `call-${index}`, state: 'output-available', input: {}, subagentTool: 'delegate_task' }]
  }) as unknown as UIMessage
/** The message the daemon adds when a subagent's result reaches the parent (the text is for the model). */
const result = (index: number, seconds: number, childThreadId = `child-${index}`): UIMessage =>
  ({
    id: `wake-${index}`,
    role: 'user',
    createdAt: at(seconds),
    parts: [{ type: 'text', text: `Subagent "${NAMES[index]}" finished task d${index}.\nMODEL-ONLY RESULT ${index}` }],
    metadata: { subagentNotice: [{ delegationId: `d${index}`, childThreadId, title: NAMES[index], runStatus: 'completed', fullyShown: true }] }
  }) as unknown as UIMessage

const cards = (states: SubagentState[]): Map<string, SubagentCardModel> =>
  new Map(states.map((state, index) => [`call-${index}`, {
    toolCallId: `call-${index}`,
    pending: false,
    childThreadId: `child-${index}`,
    delegationId: `d${index}`,
    title: NAMES[index]!,
    state,
    provider: 'claude',
    model: 'opus',
    continued: false,
    latest: true,
    waitingOn: [],
    exact: true,
    createdAt: T0 + 3000,
    completedAt: state === 'done' ? T0 + 3000 + (index + 1) * 5000 : null
  }]))

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
  // A finished card reads its subagent's last reply.
  ;(window as unknown as { mousse: unknown }).mousse = { orchestrator: { getMessages: async () => [] } }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

/** Renders the list `seconds` after the message was sent, with the thread in `phase` and the subagents in `states`. */
async function show(seconds: number, messages: UIMessage[], phase: string, states: SubagentState[]) {
  await act(async () => {
    vi.advanceTimersByTime(Math.max(0, T0 + seconds * 1000 - Date.now()))
  })
  await act(async () => {
    root.render(createElement(SubagentCardsContext.Provider, { value: cards(states) },
      createElement(MessageList, { messages, status: chatStatusFromTurn({ phase, turnId: 'run:1' }) })))
  })
  const text = host.textContent ?? ''
  return {
    turns: host.querySelectorAll('[data-turn-key]').length,
    indicators: [...host.querySelectorAll('.turn-work-label')].map((node) => node.textContent),
    notices: host.querySelectorAll('.subagent-notice').length,
    text
  }
}

const u = user('u1', 0, 'Launch three test subagents')
const intro = reply('a1', 2, 'I launched three subagents. Mousse will send me their results when they finish.')
const launched = [u, intro, launch(0, 3), launch(1, 3), launch(2, 3)]

describe('a reply that launches subagents whose results arrive one by one', () => {
  it('stays one turn with one working indicator, and the card shows each result', async () => {
    let view = await show(3, launched, 'streaming', ['working', 'working', 'working'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Working for 3 seconds'], notices: 0 })
    expect(view.text).toContain('3 subagents')

    // The parent's run ends while its subagents work: the reply goes on.
    view = await show(5, launched, 'completed', ['working', 'working', 'working'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Working for 5 seconds'], notices: 0 })

    // The first result wakes the parent: still the same turn, and the card counts it as done.
    const first = [...launched, result(0, 8), thought('t1', 9, 'One replied; two are still running.'), reply('a2', 10, 'Test Subagent One finished. Two and Three are still running.')]
    view = await show(10, first, 'streaming', ['done', 'working', 'working'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Working for 10 seconds'], notices: 0 })
    expect(view.text).toContain('2 working · 1 done')
    expect(view.text).not.toContain('finished task')

    view = await show(11, first, 'completed', ['done', 'working', 'working'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Working for 11 seconds'], notices: 0 })

    const all = [...first, result(1, 13), result(2, 18), reply('a3', 20, 'All three test subagents have now reported back.')]
    view = await show(20, all, 'streaming', ['done', 'done', 'done'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Working for 20 seconds'], notices: 0 })

    view = await show(21, all, 'completed', ['done', 'done', 'done'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Worked for 21s'], notices: 0 })
    expect(view.text).toContain('3 subagents')
    expect(view.text).toContain('3 done')
    expect(view.text).not.toMatch(/finished task|MODEL-ONLY RESULT/)
    // Every part of the reply is in the one turn, in order.
    const order = ['I launched three subagents', '3 subagents', 'Test Subagent One finished.', 'All three test subagents'].map((s) => view.text.indexOf(s))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('starts a new turn for a real new message', async () => {
    const all = [...launched, result(0, 8), result(1, 9), result(2, 10), reply('a2', 12, 'All done.'), user('u2', 30, 'Thanks, now summarize')]
    const view = await show(31, all, 'streaming', ['done', 'done', 'done'])
    expect(view.turns).toBe(2)
    expect(view.indicators).toEqual(['Worked for 12s', 'Working for 1 second'])
  })

  it('keeps a result line in the turn for a subagent with no card', async () => {
    const all = [...launched, result(0, 8, 'other-thread'), reply('a2', 10, 'Noted.')]
    const view = await show(11, all, 'completed', [])
    expect(view.turns).toBe(1)
    expect(view.notices).toBe(1)
    expect(view.text).toContain('Test Subagent One')
    expect(view.text).not.toContain('MODEL-ONLY RESULT')
  })
})

describe('a saved thread split by subagent results', () => {
  it('reads as one turn per message the user wrote', async () => {
    const saved = [
      ...launched,
      result(0, 8), reply('a2', 10, 'One finished.'),
      result(1, 13), result(2, 18), reply('a3', 20, 'All three reported back.'),
      user('u2', 60, 'Next'), reply('a4', 62, 'Okay.')
    ]
    const view = await show(100, saved, 'completed', ['done', 'done', 'done'])
    expect(view).toMatchObject({ turns: 2, indicators: ['Worked for 20s', 'Worked for 2s'], notices: 0 })
    expect(view.text).not.toMatch(/finished task|MODEL-ONLY RESULT/)
  })
})

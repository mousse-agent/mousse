// @vitest-environment jsdom
/**
 * A finished turn reads as its prompt, one "Worked for" line and its answer: the work that led to the answer
 * (thoughts, calls, narration) folds behind the line, which opens it in place (message-list.tsx).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
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

const T0 = Date.parse('2026-11-12T10:00:00Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const ask = (id: string, text: string, seconds: number): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], createdAt: at(seconds), turnId: `turn-${id}` }) as unknown as UIMessage
const said = (id: string, text: string, seconds: number): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }], createdAt: at(seconds), metadata: { endedAt: T0 + seconds * 1000 } }) as unknown as UIMessage
const call = (id: string, type: string, input: Record<string, unknown>, seconds: number, state = 'output-available'): UIMessage =>
  ({
    id,
    role: 'assistant',
    createdAt: at(seconds),
    parts: [{ type, toolCallId: id, state, input, ...(state === 'output-available' ? { output: 'ok' } : {}) }]
  }) as unknown as UIMessage
const thought = (id: string, text: string, seconds: number): UIMessage =>
  ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'tool-Thinking', toolCallId: id, state: 'output-available', input: { thought: text }, output: text }] }) as unknown as UIMessage

const turn = (n: number, start: number): UIMessage[] => [
  ask(`u${n}`, `Fix the cache ${n}`, start),
  thought(`t${n}`, 'Reading the cache code', start + 2),
  said(`n${n}`, `I'll read how the key is built ${n}.`, start + 3),
  call(`r${n}a`, 'tool-Read', { file_path: 'src/cache.ts' }, start + 4),
  call(`r${n}b`, 'tool-Read', { file_path: 'package.json' }, start + 5),
  call(`b${n}`, 'tool-Bash', { command: 'node test.js' }, start + 6),
  call(`e${n}`, 'tool-Edit', { file_path: 'src/cache.ts', old_string: 'a', new_string: 'b' }, start + 8),
  said(`a${n}`, `The key changed every run ${n}.`, start + 12)
]

function render(messages: UIMessage[], status: 'ready' | 'streaming' = 'ready') {
  act(() => root.render(createElement(MessageList, { messages, status })))
}

const toggles = () => [...host.querySelectorAll<HTMLButtonElement>('.turn-work-toggle')]
const answerOf = (index: number) => host.querySelectorAll<HTMLElement>('.turn-answer')[index]!
const visible = (index: number) => answerOf(index).textContent!.replace(/\s+/g, ' ')

describe('a finished turn', () => {
  it('shows only its answer under one "Worked for" line, folded by default', () => {
    render(turn(1, 0))
    expect(toggles()).toHaveLength(1)
    expect(toggles()[0]!.textContent).toBe('Worked for 12s')
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(visible(0).trim()).toBe('The key changed every run 1.')
    expect(host.querySelector('.turn-work-chevron')).not.toBeNull()
  })

  it('opens its work in place, in the order it ran: the thought, the narration as prose, the calls grouped by what they did', () => {
    render(turn(1, 0))
    act(() => toggles()[0]!.click())
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('true')
    const text = visible(0)
    const order = ['Reading the cache code', "I'll read how the key is built 1.", 'Read 2 files, ran 1 command and edited 1 file', 'The key changed every run 1.']
    for (const piece of order) expect(text).toContain(piece)
    expect(order.map((piece) => text.indexOf(piece))).toEqual(order.map((piece) => text.indexOf(piece)).sort((x, y) => x - y))
    // The narration is prose, like the answer, not a row of the activity.
    const narration = [...answerOf(0).querySelectorAll('[data-find-text]')].map((node) => node.textContent)
    expect(narration).toEqual(["I'll read how the key is built 1.", 'The key changed every run 1.'])
    act(() => toggles()[0]!.click())
    expect(visible(0).trim()).toBe('The key changed every run 1.')
  })

  it('remembers which turns are open while the thread is open', () => {
    const thread = [...turn(1, 0), ...turn(2, 100)]
    render(thread)
    act(() => toggles()[0]!.click())
    // A new message arrives and the list draws again: the first turn stays open, the second closed.
    render([...thread, ask('u3', 'And now?', 200)], 'streaming')
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(toggles()[1]!.getAttribute('aria-expanded')).toBe('false')
    expect(visible(0)).toContain("I'll read how the key is built 1.")
    expect(visible(1)).not.toContain("I'll read how the key is built 2.")
  })

  it('has no fold control when it did no work', () => {
    render([ask('u1', 'Hi', 0), said('a1', 'Hello.', 2)])
    expect(toggles()).toHaveLength(0)
    expect(host.querySelector('.turn-work-label')!.textContent).toBe('Worked for 2s')
  })

  it('keeps an error in view with its work folded', () => {
    const failed = { id: 'x1', role: 'assistant', createdAt: at(9), parts: [{ type: 'error', title: 'Request failed', message: 'Overloaded' }] } as unknown as UIMessage
    render([...turn(1, 0).slice(0, -1), failed])
    expect(toggles()).toHaveLength(1)
    expect(visible(0)).toContain('Overloaded')
    expect(visible(0)).not.toContain('Read ')
  })
})

describe('a turn whose end the window learned late', () => {
  it('shows how long its work really took, not how long until the window heard it ended (#1042)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(T0 + 1_000)
      const question = ask('u1', 'Fix it', 0)
      render([question, { id: 'a1', role: 'assistant', createdAt: at(1), parts: [{ type: 'text', text: 'Looking' }] } as unknown as UIMessage], 'streaming')
      // The window missed the end; 30 seconds later it caught up with the service, which saved when the reply ended.
      vi.setSystemTime(T0 + 31_000)
      const finished = { id: 'a1', role: 'assistant', createdAt: at(1), completedAt: at(4), parts: [{ type: 'text', text: 'Fixed.' }] } as unknown as UIMessage
      render([question, finished], 'ready')
      expect(host.querySelector('.turn-work-label')!.textContent).toBe('Worked for 4s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a turn heard ending as it ends still shows its own clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(T0 + 1_000)
      const question = ask('u1', 'Fix it', 0)
      render([question, { id: 'a1', role: 'assistant', createdAt: at(1), parts: [{ type: 'text', text: 'Looking' }] } as unknown as UIMessage], 'streaming')
      vi.setSystemTime(T0 + 7_000)
      // The end arrives before the reply's saved end does.
      render([question, { id: 'a1', role: 'assistant', createdAt: at(1), parts: [{ type: 'text', text: 'Fixed.' }] } as unknown as UIMessage], 'ready')
      expect(host.querySelector('.turn-work-label')!.textContent).toBe('Worked for 7s')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a running turn', () => {
  it('folds finished calls into their group lines and ends on one live line', () => {
    const running = [
      ...turn(1, 0).slice(0, 6),
      call('b2', 'tool-Bash', { command: 'npm test' }, 7, 'input-available')
    ]
    render(running, 'streaming')
    expect(toggles()).toHaveLength(0)
    const text = visible(0)
    expect(text).toContain("I'll read how the key is built 1.")
    expect(text).toContain('Read 2 files and ran 2 commands')
    // No call row shows on its own; the line under the work names what runs.
    expect(answerOf(0).querySelector('.an-tool-group-rows')).toBeNull()
    const live = host.querySelector<HTMLElement>('[data-turn-progress]')!
    expect(answerOf(0).lastElementChild).toBe(live)
    expect(live.textContent).toBe('Running Bash…npm test')
  })
})

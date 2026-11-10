// @vitest-environment jsdom
/**
 * The live line under a running turn's Working (turn-progress.tsx): every phase of a turn shows a
 * specific, non-empty line, or a header that says what the turn waits for.
 */
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as messageListModule from '../../src/renderer/chat/components/agent-elements/message-list'
import {
  TurnProgressContext,
  describeTurnProgress,
  stepSeenAt,
  type TurnProgressState
} from '../../src/renderer/chat/components/agent-elements/turn-progress'

const { MessageList } = messageListModule
/** Steered messages show as a Steer block inside the running reply (#873); before it, as a turn of their own. */
const steerBlocks = 'readSteerGroup' in messageListModule

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
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
  vi.useRealTimers()
})

type Status = 'ready' | 'submitted' | 'streaming'
const NOW = Date.parse('2026-11-11T10:00:00Z')
const createdAt = new Date(NOW - 4000).toISOString()

const ask = (id = 'u1', text = 'Fix the failing test', metadata?: Record<string, unknown>): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], createdAt, ...(metadata ? { metadata } : {}) }) as unknown as UIMessage
const reply = (id: string, ...parts: unknown[]): UIMessage => ({ id, role: 'assistant', parts, createdAt } as unknown as UIMessage)
const text = (value: string) => ({ type: 'text', text: value })
const tool = (name: string, state: string, input: Record<string, unknown> = {}, id = `call-${name}-${state}`) =>
  ({ type: `tool-${name}`, toolCallId: id, state, input, ...(state === 'output-available' ? { output: { stdout: 'ok' } } : {}) })
const thought = (state: 'input-available' | 'output-available', content = '') =>
  ({ type: 'tool-Thinking', toolCallId: `thought-${state}`, state, input: { thought: content }, ...(state === 'output-available' ? { output: content } : {}) })

function render(messages: UIMessage[], status: Status, state: TurnProgressState | null) {
  act(() => root.render(createElement(TurnProgressContext.Provider, { value: state }, createElement(MessageList, { messages, status }))))
}

/** The last turn's header and the live line under it. */
const header = () => [...host.querySelectorAll<HTMLElement>('.turn-work-label')].at(-1)?.textContent ?? null
const line = () => host.querySelector<HTMLElement>('[data-turn-progress]')
const lineText = () => line()?.textContent ?? ''

/** A running turn: its header says it works, and the line under it is non-empty. */
function expectLive(label: string | RegExp) {
  expect(header()).toMatch(/^Working/)
  expect(lineText()).not.toBe('')
  if (typeof label === 'string') expect(lineText()).toBe(label)
  else expect(lineText()).toMatch(label)
  // The line ends the turn's answer, under the Working header.
  const answer = line()!.closest('.turn-answer')!
  expect(answer.lastElementChild).toBe(line())
  expect(answer.previousElementSibling?.classList.contains('turn-work')).toBe(true)
}

describe('the line under Working', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
  })

  it('1. sent, before the service starts the turn (lease or turn-slot wait): Starting…', () => {
    render([ask('optimistic:1')], 'ready', { phase: 'idle' })
    expectLive('Starting…')
    render([ask()], 'submitted', { phase: 'queued' })
    expectLive('Starting…')
  })

  it('1. the runtime, its tools and Skills being set up: Starting…', () => {
    render([ask()], 'streaming', { phase: 'thinking', step: { kind: 'starting' } })
    expectLive('Starting…')
    expect(line()!.title).toBe('Starting the agent and its tools')
  })

  it('2. waiting for the first token: Waiting for the model…', () => {
    render([ask()], 'streaming', { phase: 'thinking', step: { kind: 'waiting' } })
    expectLive('Waiting for the model…')
  })

  it('3. a thinking-only stretch, no text yet: Thinking…', () => {
    render([ask()], 'streaming', { phase: 'thinking', step: { kind: 'reasoning' } })
    expectLive('Thinking…')
  })

  it('3. a thought that streams its summary: Thinking…', () => {
    render([ask(), reply('t1', thought('input-available', 'Reading the test output'))], 'streaming', { phase: 'thinking' })
    expectLive('Thinking…')
  })

  it('3. reasoning again after text, with nothing shown of it: Thinking…', () => {
    render([ask(), reply('a1', text('Found it.'))], 'streaming', { phase: 'streaming', step: { kind: 'reasoning' } })
    expectLive('Thinking…')
  })

  it('4. text streaming: Writing…', () => {
    render([ask(), reply('a1', text('The test fails because'))], 'streaming', { phase: 'streaming' })
    expectLive('Writing…')
  })

  it('5. a tool call being prepared: Preparing <tool>…', () => {
    render([ask(), reply('c1', tool('Bash', 'input-streaming'))], 'streaming', { phase: 'tool_running' })
    expectLive('Preparing Bash…')
    // Claude opens the row at the call's start, before its arguments arrive.
    render([ask(), reply('c1', tool('Bash', 'input-available'))], 'streaming', { phase: 'tool_running' })
    expectLive('Preparing Bash…')
    render([ask(), reply('c1', tool('Bash', 'input-available', { label: 'command', cwd: 'J:/repo' }))], 'streaming', { phase: 'tool_running' })
    expectLive('Preparing Bash…')
  })

  it('5. a long shell command running: Running <tool>…, the command in the tooltip', () => {
    render([ask(), reply('c1', tool('Bash', 'input-available', { command: 'npm test -- --run slow.test.ts' }))], 'streaming', { phase: 'tool_running' })
    expectLive('Running Bash…')
    expect(line()!.title).toBe('npm test -- --run slow.test.ts')
  })

  it('5. an MCP tool running is named by its tool', () => {
    render([ask(), reply('c1', tool('mcp__github__get_issue', 'input-available', { issue: 12 }))], 'streaming', { phase: 'tool_running' })
    expectLive('Running Get Issue…')
  })

  it('5. a tool result arrived, the model reads it: Thinking…', () => {
    render([ask(), reply('c1', tool('Bash', 'output-available', { command: 'ls' }))], 'streaming', { phase: 'thinking' })
    expectLive('Thinking…')
  })

  it('6. between tool calls, in a collapsed group: Thinking…', () => {
    render([ask(), reply('c1', tool('Read', 'output-available', {}, 'r1')), reply('c2', tool('Grep', 'output-available', {}, 'g1'))], 'streaming', { phase: 'thinking' })
    expectLive('Thinking…')
  })

  it('6. a tool still running behind a finished one is named', () => {
    render([ask(), reply('c1', tool('Bash', 'input-available', { command: 'sleep 30' }, 'b1')), reply('c2', tool('Read', 'output-available', {}, 'r1'))], 'streaming', { phase: 'tool_running' })
    expectLive('Running Bash…')
  })

  it('7. a subagent running: Running subagent…', () => {
    render([ask(), reply('s1', tool('Agent', 'input-available', { description: 'Audit the tests' }))], 'streaming', { phase: 'tool_running' })
    expectLive('Running subagent…')
    expect(line()!.title).toBe('Audit the tests')
  })

  it('7. the turn ended and its subagents still work: Waiting for subagents…', () => {
    const progress = describeTurnProgress({ state: { phase: 'completed' }, messages: [reply('a1', text('Started two agents.'))], awaitingSubagents: true, now: NOW })
    expect(progress?.label).toBe('Waiting for subagents…')
  })

  it('8. an approval waiting: the header says so instead of Working, and the request is the live row', () => {
    const request = { type: 'data-permission-request', data: { requestId: 'r1', action: 'command', prompt: 'Run npm test?', status: 'pending' } }
    render([ask(), reply('p1', request)], 'streaming', { phase: 'awaiting_input' })
    expect(header()).toBe('Waiting for approval')
    expect(line()).toBeNull()
  })

  it('8. a question waiting for its answer: the header says so instead of Working, tooltip too', () => {
    render([ask(), reply('a1', text('One question first.'))], 'streaming', { phase: 'awaiting_input' })
    expect(header()).toBe('Waiting for your answer')
    const label = [...host.querySelectorAll<HTMLElement>('.turn-work-label')].at(-1)!
    expect(label.title).not.toMatch(/Working/)
    expect(line()).toBeNull()
  })

  it('9. compaction: its own live row says it, once', () => {
    const compaction = { ...reply('k1', text('Compacting context…')), metadata: { compaction: true, compacting: true } } as UIMessage
    render([ask(), reply('a1', text('Working through the files.')), compaction], 'streaming', { phase: 'thinking' })
    expect(header()).toMatch(/^Working/)
    expect(host.querySelector('[role="status"] .an-text-shimmer--active')?.textContent).toBe('Compacting context…')
    expect(line()).toBeNull()
  })

  it('9. a compaction before any output, with no text of its own yet, is the line', () => {
    const compaction = { ...reply('k1', text('')), metadata: { compaction: true, compacting: true } } as UIMessage
    render([ask(), compaction], 'streaming', { phase: 'thinking' })
    expectLive('Compacting context…')
  })

  it('10. a retry after a provider error: Retrying in 5s…, counting down, the attempt in the tooltip', () => {
    render([ask()], 'streaming', { phase: 'thinking', step: { kind: 'retrying', attempt: 2, maxAttempts: 5, delayMs: 5000 } })
    expectLive('Retrying in 5s…')
    expect(line()!.title).toBe('Attempt 2 of 5')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(lineText()).toBe('Retrying in 4s…')
    act(() => { vi.advanceTimersByTime(5000) })
    expect(lineText()).toBe('Retrying…')
  })

  it('10. a countdown that starts on a line already shown reads its right second at once', () => {
    const messages = [ask(), reply('a1', text('Partial'))]
    render(messages, 'streaming', { phase: 'streaming', step: { kind: 'waiting' } })
    // The line has been up a while (no timer ran meanwhile) when the retry arrives.
    act(() => { vi.setSystemTime(NOW + 30_000) })
    render(messages, 'streaming', { phase: 'streaming', step: { kind: 'retrying', attempt: 3, maxAttempts: 5, delayMs: 7000 } })
    expect(lineText()).toBe('Retrying in 7s…')
  })

  it("10. counts a retry down on this window's clock, whatever the other computer's says, and does not start over", () => {
    // A step carries a wait, not a time; the same state read again (after missed events) keeps its first sighting.
    const state: TurnProgressState = { threadId: 't1', updatedAt: '2026-11-11T09:00:00.000Z', phase: 'thinking', step: { kind: 'retrying', attempt: 4, maxAttempts: 9, delayMs: 8000 } }
    const first = stepSeenAt(state, NOW)
    expect(stepSeenAt({ ...state, step: { ...state.step! } }, NOW + 3000)).toBe(first)
    const progress = describeTurnProgress({ state, messages: [], stepSince: first, now: NOW + 3000 })
    expect(progress?.label).toBe('Retrying in 5s…')
  })

  it('10. a second retry that says the same counts down again, in the same turn and in another thread', () => {
    const retry = { kind: 'retrying' as const, attempt: 1, maxAttempts: 3, delayMs: 4000 }
    const first: TurnProgressState = { threadId: 't-same', updatedAt: '2026-11-11T09:10:00.000Z', phase: 'thinking', step: retry }
    expect(stepSeenAt(first, NOW)).toBe(NOW)
    // Later in the same turn Pi retries again with the same attempt, limit and wait: a new state change.
    const again: TurnProgressState = { ...first, updatedAt: '2026-11-11T09:12:00.000Z', step: { ...retry } }
    expect(stepSeenAt(again, NOW + 120_000)).toBe(NOW + 120_000)
    const label = (state: TurnProgressState, at: number) =>
      describeTurnProgress({ state, messages: [], stepSince: stepSeenAt(state, at), now: at })?.label
    expect(label(again, NOW + 120_000)).toBe('Retrying in 4s…')
    // Another thread's retry at the same moment, saying the same, counts on its own.
    const other: TurnProgressState = { ...first, threadId: 't-other' }
    expect(label(other, NOW + 120_000)).toBe('Retrying in 4s…')
  })

  it('10. a retry shown in the list counts down again when the same retry comes back later', () => {
    const retry = { kind: 'retrying' as const, attempt: 1, maxAttempts: 3, delayMs: 3000 }
    render([ask()], 'streaming', { threadId: 't-list', updatedAt: '2026-11-11T09:20:00.000Z', phase: 'thinking', step: retry })
    expectLive('Retrying in 3s…')
    act(() => { vi.advanceTimersByTime(4000) })
    expect(lineText()).toBe('Retrying…')
    render([ask()], 'streaming', { threadId: 't-list', updatedAt: '2026-11-11T09:20:04.000Z', phase: 'thinking', step: { ...retry } })
    expect(lineText()).toBe('Retrying in 3s…')
  })

  it('10. a retry after no answer at all says so, without an attempt count', () => {
    render([ask()], 'streaming', { phase: 'thinking', step: { kind: 'retrying', attempt: 1, delayMs: 2000, noResponse: true } })
    expectLive('Retrying in 2s…')
    expect(line()!.title).toBe('No answer from the provider yet')
  })

  it('10. a retry mid-reply replaces the stale line', () => {
    render([ask(), reply('a1', text('Partial'))], 'streaming', { phase: 'streaming', step: { kind: 'retrying', attempt: 1 } })
    expectLive('Retrying…')
  })

  it('11. after Stop, while the turn still ends: Stopping…', () => {
    render([ask(), reply('c1', tool('Bash', 'input-available', { command: 'sleep 60' }))], 'streaming', { phase: 'tool_running', stopping: true })
    expectLive('Stopping…')
  })

  it('11. once the turn shows stopped there is no Working left', () => {
    render([ask(), reply('a1', text('Partial'))], 'ready', { phase: 'stopped' })
    expect(header()).toMatch(/^Worked for/)
    expect(line()).toBeNull()
  })

  it('12. a steered message the model has not answered yet: Waiting for the model…, then what it does', () => {
    // The service says the model has the steer (step `waiting`), whether the steer shows as a turn of its own or as
    // a Steer block inside the running reply.
    const steered = ask('u2', 'Also check the lint', { steered: true })
    render([ask('u1'), reply('a1', text('Looking.')), steered], 'streaming', { phase: 'streaming', step: { kind: 'waiting' } })
    expectLive('Waiting for the model…')
    render([ask('u1'), reply('a1', text('Looking.')), steered, reply('t2', thought('input-available'))], 'streaming', { phase: 'thinking' })
    expectLive('Thinking…')
  })

  it('12. a Steer block says nothing by itself: the line follows what the turn does, and waits only by the step', () => {
    // The block shows at the click, before the model reads it (Claude's steer is taken when it is pushed).
    const block = { id: 'steer-group:u2', role: 'user', parts: [], metadata: { steerGroup: [ask('u2', 'Also check the lint', { steered: true })] } } as unknown as UIMessage
    const label = (messages: UIMessage[], state: TurnProgressState) => describeTurnProgress({ state, messages, now: NOW })?.label
    // A long command still runs: it stays the line.
    const running = reply('c1', tool('Bash', 'input-available', { command: 'npm test' }))
    expect(label([running, block], { phase: 'tool_running' })).toBe('Running Bash…')
    expect(label([running, block], { phase: 'tool_running', step: { kind: 'waiting' } })).toBe('Running Bash…')
    // Claude keeps writing into the reply above the block: Writing…, until the service says the model waits.
    const writing = reply('a1', text('Looking at the'))
    expect(label([writing, block], { phase: 'streaming' })).toBe('Writing…')
    expect(label([writing, block], { phase: 'streaming', step: { kind: 'waiting' } })).toBe('Waiting for the model…')
  })

  it.skipIf(!steerBlocks)('12. a steer during a running tool keeps Running <tool>… in the transcript (#873)', () => {
    const steered = ask('u2', 'Also check the lint', { steered: true })
    render([ask('u1'), reply('c1', tool('Bash', 'input-available', { command: 'npm test' })), steered], 'streaming', { phase: 'tool_running' })
    expectLive('Running Bash…')
  })

  it.skipIf(!steerBlocks)('12. a steer while the reply is written keeps Writing… until the service says the model waits (#873)', () => {
    const steered = ask('u2', 'Also check the lint', { steered: true })
    const messages = [ask('u1'), reply('a1', text('Looking at the')), steered]
    render(messages, 'streaming', { phase: 'streaming' })
    expectLive('Writing…')
    render(messages, 'streaming', { phase: 'streaming', step: { kind: 'waiting' } })
    expectLive('Waiting for the model…')
  })

  it('follows the turn inside a memoised row: a new step alone updates it', () => {
    const messages = [ask(), reply('a1', text('Done with the first file.'))]
    render(messages, 'streaming', { phase: 'streaming' })
    expectLive('Writing…')
    render(messages, 'streaming', { phase: 'streaming', step: { kind: 'reasoning' } })
    expectLive('Thinking…')
    render(messages, 'streaming', { phase: 'thinking', step: { kind: 'retrying', attempt: 1 } })
    expectLive('Retrying…')
  })

  it('is never empty while a turn runs, in any phase or step', () => {
    const turns: UIMessage[][] = [
      [ask()],
      [ask(), reply('a1', text('Some text'))],
      [ask(), reply('c1', tool('Bash', 'output-available'))],
      [ask(), reply('t1', thought('output-available', 'Plan'))]
    ]
    const states: TurnProgressState[] = [
      {},
      { phase: 'queued' },
      { phase: 'thinking' },
      { phase: 'streaming' },
      { phase: 'tool_running' },
      { phase: 'finalizing' },
      ...(['starting', 'waiting', 'reasoning'] as const).map((kind) => ({ phase: 'thinking' as const, step: { kind } })),
      { phase: 'thinking', step: { kind: 'retrying', attempt: 1 } }
    ]
    for (const messages of turns) {
      for (const state of states) {
        render(messages, 'streaming', state)
        expect(header()).toMatch(/^Working/)
        expect(lineText(), JSON.stringify({ state, parts: messages.at(-1)!.parts })).not.toBe('')
      }
    }
  })

  it('without a thread behind the list it reads the messages', () => {
    render([ask()], 'submitted', null)
    expectLive('Starting…')
    render([ask(), reply('a1', text('Some text'))], 'streaming', null)
    expectLive('Thinking…')
  })

  it('ends with the turn', () => {
    render([ask(), reply('a1', text('Done.'))], 'ready', { phase: 'completed' })
    expect(header()).toMatch(/^Worked for/)
    expect(line()).toBeNull()
  })
})

describe('its animation', () => {
  const css = readFileSync('src/renderer/chat/components/agent-elements/turn-progress.css', 'utf8')

  it('animates only opacity and transform, so the compositor draws it', () => {
    const keyframes = css.match(/@keyframes turn-progress-dot\s*\{([^]*?)\n\}/)?.[1] ?? ''
    expect(keyframes).not.toBe('')
    const properties = [...keyframes.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1])
    expect(new Set(properties)).toEqual(new Set(['opacity', 'transform']))
    expect(css).not.toMatch(/background-position|width:\s*calc|animation:[^;]*an-shimmer/)
  })

  it('moves in steps, at the Animation speed setting', () => {
    expect(css).toMatch(/animation: turn-progress-dot calc\(1\.2s \* var\(--ui-motion-scale, 1\)\) steps\(12, jump-none\)/)
  })

  it('has no edge or side bar', () => {
    expect(css).not.toMatch(/border-(left|right)|inset-inline|box-shadow/)
  })
})

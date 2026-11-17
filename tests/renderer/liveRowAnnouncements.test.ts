// @vitest-environment jsdom
/**
 * What a screen reader hears from a running turn: the live row's status region says a few calm words for each step
 * ("Thinking", the call that runs, "Retrying"), at most once every two seconds and then only the latest step. It never
 * reads a thought's headlines or a retry's countdown, and nothing else in the row is a live region.
 *
 * The region is read over a scripted turn at fake time, the way a screen reader would hear it: each change of its text
 * is one announcement.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { setReplyPacing } from '../../src/renderer/lib/replyPacingSetting'
import { ANNOUNCE_EVERY_MS, TurnProgressContext, type TurnProgressState } from '../../src/renderer/chat/components/agent-elements/turn-progress'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver
const NOW = Date.parse('2026-11-18T10:00:00Z')

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(NOW)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setReplyPacing(false)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  globalThis.ResizeObserver = realResizeObserver
  vi.useRealTimers()
  setReplyPacing(true)
})

const createdAt = new Date(NOW - 1000).toISOString()
const ask = (): UIMessage => ({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Fix the failing test' }], createdAt } as unknown as UIMessage)
const reply = (id: string, ...parts: unknown[]): UIMessage => ({ id, role: 'assistant', parts, createdAt } as unknown as UIMessage)
const thought = (id: string, state: 'input-available' | 'output-available', content: string) =>
  ({ type: 'tool-Thinking', toolCallId: id, state, input: { thought: content }, ...(state === 'output-available' ? { output: content } : {}) })
const bash = (id: string, command: string, done = false) =>
  ({ type: 'tool-Bash', toolCallId: id, state: done ? 'output-available' : 'input-available', input: { command }, ...(done ? { output: { stdout: 'ok' } } : {}) })

function render(messages: UIMessage[], state: TurnProgressState | null) {
  act(() => root.render(createElement(TurnProgressContext.Provider, { value: state }, createElement(MessageList, { messages, status: 'streaming' }))))
}

const region = () => document.querySelector<HTMLElement>('[data-live-announce]')
const lineText = () => host.querySelector('[data-turn-progress] .turn-progress-label')?.textContent ?? ''

/** Everything the region said, with when, read every 100 ms as time passes. */
const heard: Array<{ at: number; text: string }> = []
function listen() {
  const text = region()?.textContent ?? ''
  if (text && text !== heard.at(-1)?.text) heard.push({ at: Date.now() - NOW, text })
}
function wait(ms: number) {
  for (let left = ms; left > 0; left -= 100) {
    act(() => { vi.advanceTimersByTime(Math.min(100, left)) })
    listen()
  }
}
function step(messages: UIMessage[], state: TurnProgressState | null) {
  render(messages, state)
  listen()
}

describe('the live row speaks calmly', () => {
  it('over a scripted turn: one word per step, never a headline or a countdown, at most once every two seconds', () => {
    heard.length = 0
    const a1 = (...parts: unknown[]) => [ask(), reply('a1', ...parts)]
    const done = thought('t1', 'output-available', '**Reading the test**\n\nIt starts twice.\n\n**Checking the reminder**\n\nIt fires once.')

    // 0 s: sent; a thought streams and changes its headline twice.
    step([ask()], { phase: 'thinking' })
    wait(300)
    step(a1(thought('t1', 'input-available', '**Reading the test**\n\nIt starts')), { phase: 'thinking' })
    wait(300)
    step(a1(thought('t1', 'input-available', '**Reading the test**\n\nIt starts twice.\n\n**Checking the reminder**\n\nIt')), { phase: 'thinking' })
    wait(300)
    // 0.9 s: a quick command runs and ends within the two seconds, and the next thought starts: nothing new to say.
    step(a1(done, bash('b1', 'npm test')), { phase: 'tool_running' })
    wait(300)
    step(a1(done, bash('b1', 'npm test', true), thought('t2', 'input-available', '**Reading the output**\n\nOk')), { phase: 'thinking' })
    wait(1300)
    // 2.5 s: a longer command.
    step(a1(done, bash('b1', 'npm test', true), thought('t2', 'output-available', '**Reading the output**\n\nOk'), bash('b2', 'npm run build')), { phase: 'tool_running' })
    wait(500)
    // 3 s: the provider fails and a retry counts down from 5 s, said once.
    const messages = a1(done, bash('b1', 'npm test', true), thought('t2', 'output-available', '**Reading the output**\n\nOk'), bash('b2', 'npm run build', true))
    step(messages, { phase: 'thinking', step: { kind: 'retrying', attempt: 1, maxAttempts: 5, delayMs: 5000 } })
    wait(2000)
    // The row counts down; the region does not.
    expect(lineText()).toMatch(/^Retrying in \ds…$/)
    expect(region()!.textContent).toBe('Retrying')
    wait(3500)
    // 8.5 s: the retry worked and the model thinks again.
    step([...messages.slice(0, 1), reply('a1', ...(messages[1]!.parts as unknown[]), thought('t3', 'input-available', '**Trying again**\n\nOk'))], { phase: 'thinking' })
    wait(2500)

    expect(heard.map((said) => said.text)).toEqual(['Thinking', 'Running Bash npm run build', 'Retrying', 'Thinking'])
    for (let i = 1; i < heard.length; i++) expect(heard[i]!.at - heard[i - 1]!.at).toBeGreaterThanOrEqual(ANNOUNCE_EVERY_MS)
    // The headlines and the countdown were never said.
    expect(heard.some((said) => /Reading|Checking|Trying|in \ds/.test(said.text))).toBe(false)
  })

  it('a step that changes sooner waits, and only the latest of several is said', () => {
    heard.length = 0
    step([ask()], { phase: 'thinking' })
    wait(500)
    step([ask(), reply('a1', bash('b1', 'npm test'))], { phase: 'tool_running' })
    wait(500)
    step([ask(), reply('a1', bash('b1', 'npm test', true), bash('b2', 'npm run lint'))], { phase: 'tool_running' })
    wait(500)
    expect(heard.map((said) => said.text)).toEqual(['Thinking'])
    wait(1000)
    expect(heard).toEqual([{ at: 0, text: 'Thinking' }, { at: ANNOUNCE_EVERY_MS, text: 'Running Bash npm run lint' }])
  })

  it('the region is the only live region: the row, its lines and its rows are not', () => {
    render([ask(), reply('a1', thought('t1', 'output-available', '**Reading the test**\n\nOk'), bash('b1', 'npm test'))], { phase: 'tool_running' })
    act(() => host.querySelector<HTMLButtonElement>('button.turn-live-toggle')!.click())
    const row = host.querySelector('[data-turn-live]')!
    expect(row.querySelectorAll('.an-tool-group-rows button').length).toBeGreaterThan(0)
    expect(row.querySelector('[role="status"], [aria-live], [role="log"], [role="alert"]')).toBeNull()
    expect(region()!.getAttribute('role')).toBe('status')
  })
})

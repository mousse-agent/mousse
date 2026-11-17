// @vitest-environment jsdom
/**
 * A tool row or group the person opened stays open while the reply goes on: when a thought starts or ends beside it,
 * and when the next call joins a lone call's run (the run keeps its container from its first call).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const createdAt = '2026-11-13T10:00:00.000Z'
const user: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Run the tests' }], createdAt } as unknown as UIMessage
const command = (id: string, done = true): UIMessage =>
  ({ id: `m-${id}`, role: 'assistant', createdAt, parts: [{ type: 'tool-Bash', toolCallId: id, state: done ? 'output-available' : 'input-available', input: { command: `npm run ${id}` }, ...(done ? { output: { stdout: `${id} ok`, exitCode: 0 } } : {}) }] }) as unknown as UIMessage
const thought = (id: string, done: boolean): UIMessage =>
  ({ id: `m-${id}`, role: 'assistant', createdAt, parts: [{ type: 'tool-Thinking', toolCallId: id, state: done ? 'output-available' : 'input-available', input: { thought: 'Checking the output' }, ...(done ? { output: 'Checking the output' } : {}) }] }) as unknown as UIMessage

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (messages: UIMessage[]) => act(() => root.render(createElement(MessageList, { messages, status: 'streaming' })))
const toggles = () => [...host.querySelectorAll<HTMLButtonElement>('.turn-answer button[aria-expanded]')]
const toggle = (startsWith: string) => {
  const button = toggles().find((b) => b.textContent!.replace(/\s+/g, ' ').trim().startsWith(startsWith))
  if (!button) throw new Error(`no row "${startsWith}": ${toggles().map((b) => b.textContent).join(' | ')}`)
  return button
}

describe('an opened tool row', () => {
  it('a group stays open when a thought starts and ends after it', () => {
    render([user, command('a'), command('b')])
    act(() => toggle('Ran 2 commands').click())
    expect(toggle('Ran 2 commands').getAttribute('aria-expanded')).toBe('true')
    render([user, command('a'), command('b'), thought('t', false)])
    expect(toggle('Ran 2 commands').getAttribute('aria-expanded')).toBe('true')
  })

  it('a lone call, opened, stays open as the same element when the next call joins it', () => {
    render([user, command('a'), thought('t', false)])
    const opened = toggle('Ran npm run a')
    act(() => opened.click())
    expect(opened.getAttribute('aria-expanded')).toBe('true')
    render([user, command('a'), thought('t', true), command('b', false)])
    // The run keeps its container: the line the person opened is the group's, still open, now with both calls.
    expect(opened.isConnected).toBe(true)
    expect(opened.getAttribute('aria-expanded')).toBe('true')
    expect(opened.textContent).toMatch(/command/)
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.an-tool-group-rows button[aria-expanded]')].map((b) => b.textContent!)
    expect(rows.some((text) => text.includes('npm run a'))).toBe(true)
    expect(rows.some((text) => text.includes('npm run b'))).toBe(true)
  })
})

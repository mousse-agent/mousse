// @vitest-environment jsdom
/**
 * "Working · Ns" counts from when the reply started, all through the reply: when the service's saved copy of the
 * prompt takes the place of the one shown on send (another id, a later time), when the first tool shows, and when the
 * answer lands, the time goes on from where it was. "Worked for" then reads the whole reply.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-11-13T10:00:00.000Z')
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

const prompt = (id: string, seconds: number): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text: 'Fix the test' }], createdAt: iso(seconds) }) as unknown as UIMessage
const command = (id: string, seconds: number): UIMessage =>
  ({ id, role: 'assistant', createdAt: iso(seconds), parts: [{ type: 'tool-Bash', toolCallId: id, state: 'output-available', input: { command: 'npm test' }, output: { stdout: 'ok', exitCode: 0 } }] }) as unknown as UIMessage
const answer = (id: string, seconds: number): UIMessage =>
  ({ id, role: 'assistant', createdAt: iso(seconds), parts: [{ type: 'text', text: 'The test passes now.' }] }) as unknown as UIMessage

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(T0)
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const render = (messages: UIMessage[], status: 'streaming' | 'ready') =>
  act(() => root.render(createElement(MessageList, { messages, status })))
const at = (seconds: number) => act(() => { vi.setSystemTime(T0 + seconds * 1000 - 1000); vi.advanceTimersByTime(1000) })
const label = () => [...host.querySelectorAll('.turn-work-label')].at(-1)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

describe('the time of a reply', () => {
  it('keeps counting from the start when the prompt is swapped for its saved copy and the reply goes on', () => {
    render([prompt('optimistic:1', 0)], 'streaming')
    at(3)
    expect(label()).toContain('3s')
    // The service's copy of the prompt, saved a few seconds later, takes the place of the one shown on send, and
    // the first tool shows.
    render([prompt('m1', 2), command('c1', 3)], 'streaming')
    at(5)
    expect(label()).toContain('5s')
    render([prompt('m1', 2), command('c1', 3), answer('a1', 6)], 'streaming')
    at(8)
    expect(label()).toContain('8s')
    render([prompt('m1', 2), command('c1', 3), answer('a1', 6)], 'ready')
    expect(label()).toMatch(/Worked for 8s/)
  })
})

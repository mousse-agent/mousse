import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { MessageList } from '../src/renderer/chat/components/agent-elements/message-list'

const user: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Start the app' }] }

const thought = (id: string, text: string, state: 'input-available' | 'output-available'): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [{ type: 'tool-Thinking', toolCallId: id, state, input: { thought: text }, ...(state === 'output-available' ? { output: text } : {}) }]
  }) as unknown as UIMessage

const command = (id: string): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [{ type: 'tool-Bash', toolCallId: id, state: 'output-available', input: { command: 'npm start' }, output: { stdout: '', exitCode: 0 } }]
  }) as unknown as UIMessage

const render = (messages: UIMessage[], status: 'ready' | 'submitted' | 'streaming') =>
  renderToStaticMarkup(createElement(MessageList, { messages, status }))

/** The visible text of the live turn, tags stripped. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('a turn right after sending', () => {
  it.each(['submitted', 'streaming'] as const)('shows a live Thinking row under the timer while %s', (status) => {
    const html = render([user], status)
    const working = html.indexOf('Working for')
    const thinking = html.indexOf('Thinking')
    expect(working).toBeGreaterThan(-1)
    expect(thinking).toBeGreaterThan(working)
    // The row sits where the answer's first row will, so the handover does not move it.
    expect(html).toMatch(/class="turn-work"[\s\S]*class="turn-answer[^"]*"[\s\S]*Thinking/)
  })

  it('shows no live row once the turn settled', () => {
    expect(render([user], 'ready')).not.toContain('Thinking')
  })

  it('streams the thought into the row in place of the placeholder', () => {
    const html = render([user, thought('t1', 'Looking for the start script', 'input-available')], 'streaming')
    expect(text(html)).toContain('Thinking Looking for the start script')
    // One row: the placeholder gave way to the thought.
    expect(html.match(/Thinking/g)).toHaveLength(1)
  })
})

describe('a tool call group', () => {
  it('is titled with the latest thought, not "Tool calls"', () => {
    const html = render(
      [
        user,
        thought('t1', 'Find the start script', 'output-available'),
        command('c1'),
        thought('t2', 'The app is starting; watch the log', 'output-available'),
        command('c2')
      ],
      'ready'
    )
    expect(text(html)).toContain('The app is starting; watch the log')
    expect(html).not.toContain('Tool calls')
  })

  it('falls back to "Tool calls" and the count only when no thought has text', () => {
    const html = render([user, thought('t1', '', 'output-available'), command('c1'), command('c2')], 'ready')
    expect(text(html)).toContain('Tool calls 3')
  })
})

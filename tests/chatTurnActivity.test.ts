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
  it.each(['submitted', 'streaming'] as const)('shows a live line under the timer while %s', (status) => {
    const html = render([user], status)
    const working = html.indexOf('Working · ')
    const starting = html.indexOf('Starting…')
    expect(working).toBeGreaterThan(-1)
    expect(starting).toBeGreaterThan(working)
    // The line sits where the answer's first row will, so the handover does not move it.
    expect(html).toMatch(/class="turn-work"[\s\S]*class="turn-answer[^"]*"[\s\S]*data-turn-progress="starting"/)
  })

  it('shows no live line once the turn settled', () => {
    const html = render([user], 'ready')
    expect(html).not.toContain('data-turn-progress')
    expect(html).not.toContain('Starting…')
  })

  it('streams the thought in its own row, with the live line under it', () => {
    const html = render([user, thought('t1', 'Looking for the start script', 'input-available')], 'streaming')
    expect(text(html)).toContain('Thinking Looking for the start script')
    expect(text(html)).toMatch(/Looking for the start script .*Thinking…/)
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

describe('a finished turn', () => {
  const reply = (id: string, said: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text: said }] })
  const turn = [
    user,
    reply('n1', 'Checking the start script first.'),
    command('c1'),
    thought('t1', 'The script is fine', 'output-available'),
    reply('a1', 'The app starts on port 3000.'),
    thought('t2', 'Nothing else to check', 'output-available')
  ]

  /** The visible rows of the turn's answer, in order (the Go to latest pill is not a row). */
  const rows = (html: string) =>
    html
      .slice(html.indexOf('turn-answer'))
      .replace(/<button[^>]*chat-jump[\s\S]*?<\/button>/, '')
      .split(/<[^>]+>/)
      .map((piece) => piece.trim())
      .filter((piece) => piece && !piece.includes('turn-answer'))

  it('ends on its answer, with its notes and the activity after it folded into one group above it', () => {
    const html = render(turn, 'ready')
    // The group is titled from its latest thought and collapsed: the note is inside it, not shown.
    expect(rows(html)).toEqual(['Nothing else to check', 'The app starts on port 3000.'])
  })

  it('keeps the order things happened in while the turn still runs, the live line last', () => {
    const html = render(turn, 'streaming')
    expect(rows(html)).toEqual([
      'Checking the start script first.',
      'The script is fine',
      'The app starts on port 3000.',
      'Nothing else to check',
      'Thinking…'
    ])
  })
})

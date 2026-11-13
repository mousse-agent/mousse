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
    const starting = html.indexOf('Thinking…')
    expect(working).toBeGreaterThan(-1)
    expect(starting).toBeGreaterThan(working)
    // The line sits where the answer's first row will, so the handover does not move it.
    expect(html).toMatch(/class="turn-work"[\s\S]*class="turn-answer[^"]*"[\s\S]*data-turn-progress="starting"/)
  })

  it('shows no live line once the turn settled', () => {
    const html = render([user], 'ready')
    expect(html).not.toContain('data-turn-progress')
    expect(html).not.toContain('Thinking…')
  })

  it('streams the thought in its own row, which is the live line: no second one under it', () => {
    const html = render([user, thought('t1', 'Looking for the start script', 'input-available')], 'streaming')
    expect(text(html)).toContain('Looking for the start script')
    expect(text(html)).not.toContain('Thinking Looking')
    expect(html).not.toContain('data-turn-progress')
  })
})

const read = (id: string, path: string): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [{ type: 'tool-Read', toolCallId: id, state: 'output-available', input: { file_path: path }, output: 'x' }]
  }) as unknown as UIMessage

const edit = (id: string, path: string): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [{ type: 'tool-Edit', toolCallId: id, state: 'output-available', input: { file_path: path, old_string: 'a', new_string: 'b' }, output: 'ok' }]
  }) as unknown as UIMessage

const reply = (id: string, said: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text: said }] })

describe('a tool call group', () => {
  it('is titled with its latest thought, then what its calls did', () => {
    const html = render(
      [
        user,
        thought('t1', 'Find the start script', 'output-available'),
        read('r1', 'package.json'),
        command('c1'),
        read('r2', 'scripts/start.js'),
        command('c2'),
        thought('t2', 'The app is starting; watch the log', 'output-available'),
        read('r3', 'logs/app.log'),
        command('c3')
      ],
      'streaming'
    )
    // The latest thought says why the calls ran; what they did follows it.
    expect(text(html)).toContain('The app is starting; watch the log · 6 actions')
  })

  it('splits at narration: the calls on each side are a group of their own, the narration prose between them', () => {
    const html = render(
      [user, read('r1', 'a.ts'), read('r2', 'b.ts'), reply('n1', 'Now the fix.'), edit('e1', 'a.ts'), edit('e2', 'b.ts')],
      'streaming'
    )
    const flat = text(html)
    expect(flat).toContain('Read 2 files')
    expect(flat).toContain('Edited 2 files')
    expect(flat.indexOf('Read 2 files')).toBeLessThan(flat.indexOf('Now the fix.'))
    expect(flat.indexOf('Now the fix.')).toBeLessThan(flat.indexOf('Edited 2 files'))
    // The narration is the reply's prose, not a row of the activity.
    expect(html).toMatch(/data-find-text[^>]*>[\s\S]*Now the fix\./)
  })

  it('is titled with its latest thought when it holds only thoughts', () => {
    const html = render([user, thought('t1', 'Look around', 'output-available'), thought('t2', 'Check the order', 'output-available')], 'streaming')
    expect(text(html)).toContain('Check the order')
  })
})

describe('a finished turn', () => {
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

  it('shows the prompt, one "Worked for" line that opens the work, and the answer', () => {
    const html = render(turn, 'ready')
    expect(rows(html)).toEqual(['The app starts on port 3000.'])
    expect(html).toMatch(/<button[^>]*class="turn-work-label turn-work-toggle"[^>]*aria-expanded="false"/)
    expect(text(html)).toMatch(/Worked( for)?/)
  })

  it('keeps the order things happened in while the turn still runs, the live line last', () => {
    const html = render(turn, 'streaming')
    expect(rows(html)).toEqual([
      'Checking the start script first.',
      // The thought came after the command: it says what is next, so the group keeps its count.
      'Ran 1 command',
      'The app starts on port 3000.',
      'Nothing else to check',
      'Thinking…'
    ])
  })
})

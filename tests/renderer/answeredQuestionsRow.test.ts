// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { answeredQuestionsSummary } from '../../src/renderer/chat/components/agent-elements/question/answered-questions-tool'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const at = (n: number) => new Date(Date.UTC(2026, 10, 6, 12, 0, n)).toISOString()
const message = (id: string, role: ChatMessage['role'], content: string, n: number, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role, content, timestamp: at(n), ...extra })

const twoAnswers: ChatMessage['questionAnswers'] = [
  { prompt: 'Which part of the export job should I start with?', chosen: ['Row reader'] },
  { prompt: 'Which output formats should it write?', chosen: ['CSV'], reply: 'JSON later.' }
]

const transcript = (answers: ChatMessage['questionAnswers']): ChatMessage[] => [
  message('u1', 'user', 'Plan the export job for me.', 0, { turnId: 'run-1' }),
  message('a1', 'assistant', 'I have a few questions before I start.', 1),
  message('qa', 'user', 'Q: …\nA: …', 2, { questionAnswers: answers }),
  message('a2', 'assistant', 'Starting with the row reader.', 3)
]

const render = (messages: ChatMessage[]) =>
  act(() => root.render(createElement(MessageList, { messages: mousseToUIMessages(messages), status: 'ready' })))

const rowOf = () => host.querySelector<HTMLElement>('.an-answered-questions')

describe('answers to the agent\'s questions', () => {
  it('become one step of the agent\'s turn, not a message from the user', () => {
    const ui = mousseToUIMessages(transcript(twoAnswers))
    const answer = ui.find((each) => each.id === 'qa')!
    expect(answer.role).toBe('assistant')
    expect(answer.parts).toEqual([expect.objectContaining({ type: 'tool-QuestionAnswers', input: { questions: twoAnswers } })])
    expect(ui.filter((each) => each.role === 'user').map((each) => each.id)).toEqual(['u1'])
  })

  it('render as one collapsed row in the turn with the count, and open to each question and answer', () => {
    render(transcript(twoAnswers))
    // Only the request is a user bubble; the answers are not.
    expect([...host.querySelectorAll('.chat-user-bubble')].map((el) => el.textContent?.trim())).toEqual(['Plan the export job for me.'])
    expect(host.textContent).not.toContain('Q: ')
    const row = rowOf()!
    expect(row).not.toBeNull()
    expect(row.textContent).toContain('Answered 2 questions')
    // Collapsed: the questions are not shown yet.
    expect(row.textContent).not.toContain('Which output formats should it write?')
    // One turn: the answers sit between the agent's two replies, under one work header.
    const html = host.innerHTML
    expect(html.indexOf('an-answered-questions')).toBeGreaterThan(html.indexOf('I have a few questions'))
    expect(html.indexOf('an-answered-questions')).toBeLessThan(html.indexOf('Starting with the row reader.'))

    const trigger = row.querySelector<HTMLElement>('button, [role="button"]')!
    act(() => trigger.click())
    const opened = rowOf()!.textContent ?? ''
    expect(opened).toContain('Which part of the export job should I start with?')
    expect(opened).toContain('Row reader')
    expect(opened).toContain('Which output formats should it write?')
    expect(opened).toContain('CSV')
    expect(opened).toContain('“JSON later.”')
    // The opened list is indented with no rule on its edge, and the questions use the app's secondary text colour
    // (set for light and dark themes, dimmer than the answers), not a faded or faint shade.
    const list = rowOf()!.querySelector<HTMLElement>('.an-answered-questions-list')!
    expect(list.className).not.toMatch(/\bborder-l\b/)
    expect(list.className).toMatch(/\bpl-/)
    const prompt = list.querySelector<HTMLElement>('dt')!
    expect(prompt.classList).toContain('text-[color:var(--text-secondary)]')
    expect(prompt.className).not.toMatch(/an-foreground-muted|an-foreground-subtle/)
  })

  it('show one question as the question and its answer', () => {
    render(transcript([{ prompt: 'Which output formats should it write?', chosen: [], reply: 'CSV only for now.' }]))
    expect(rowOf()!.textContent).toContain('Which output formats should it write?')
    expect(rowOf()!.textContent).toContain('· CSV only for now.')
    expect(answeredQuestionsSummary([{ prompt: `${'a'.repeat(80)}\nsecond line`, chosen: ['Yes', 'No'] }])).toEqual({
      label: `${'a'.repeat(59)}…`,
      detail: '· Yes, No'
    })
    expect(answeredQuestionsSummary([{ prompt: 'Skipped?', chosen: [] }]).detail).toBe('· No answer')
  })

  it('leave an older answer, saved as text only, as the user message it was', () => {
    const older = transcript(undefined)
    const ui = mousseToUIMessages(older)
    expect(ui.find((each) => each.id === 'qa')?.role).toBe('user')
  })
})

// @vitest-environment jsdom
/**
 * A bot's question in its chat (#1123), in the chat the owner uses: the question's bubble with its answers as quick
 * replies under it and "Other…", a tap that answers it and leaves a quiet line, "Other…" that replies to it from the
 * composer, buttons that stay (quieter) once the owner moved on, and the text alone from a service that has no
 * questions or whose answers can't be sent here.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'
import type { BotChatMessage } from '../../src/shared/bots/personal/chat'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/chats/ChatResourcesPanel', () => ({ ChatResourcesPanel: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTranscript', () => ({ NetworkTranscript: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkChatActions', () => ({ NetworkChatActions: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTaskPicker', () => ({ NetworkTaskPicker: () => null }))
vi.mock('../../src/renderer/components/chats/ChatBrowserAccess', () => ({ ChatBrowserAccess: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

let root: Root
let host: HTMLElement
let fake: FakeBots
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

const flats = summary('flats', { name: 'Flat finder' })
const QUESTION_TEXT = 'Which flat should I book a viewing for?'
const PLAIN = 'Flat A · Flat B · Something else'
/** A question's bubble as the service sends it: its words, then its answers as text from `plainFrom`. */
const bubble = (over: Partial<BotChatMessage> = {}, status: 'open' | 'moved_on' | 'answered' | 'withdrawn' = 'open'): BotChatMessage => message(2, {
  id: 'qb', text: `${QUESTION_TEXT}\n\n${PLAIN}`, plainFrom: QUESTION_TEXT.length,
  question: { questionId: 'q_1', choices: [{ label: 'Flat A', detail: '2 bed, Hackney, £1,900' }, { label: 'Flat B' }], other: true, status },
  ...over
})

const transcript = () => host.querySelector<HTMLElement>('.chat-transcript')!
const box = () => host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea.composer-input')!
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label || element.querySelector('.bot-question-label')?.textContent === label)
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const answers = (scope: ParentNode = transcript()) => [...scope.querySelectorAll('.bot-question-replies button')].map((element) => element.textContent)

async function open(rows: BotChatMessage[]) {
  fake.bots = [flats]
  fake.chats.flats = rows
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(flats.id))
  await settle()
}

beforeEach(() => {
  fake = fakeBots()
  installPreload(fake)
  setBotsClient(fake.client)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setBotsClient(null)
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
})

describe('a question in the bot chat', () => {
  it('shows its words in a bubble, and its answers as quick replies under it with Other…', async () => {
    await open([message(1, { id: 'r', text: 'I found two.' }), bubble()])
    const shown = transcript().querySelector('[data-message-id="qb"]')!
    expect(shown.querySelector('.bot-bubble')?.textContent).toContain(QUESTION_TEXT)
    // The plain copy is for apps that can't draw the buttons: here it is not repeated.
    expect(shown.querySelector('.bot-bubble')?.textContent).not.toContain('Flat B')
    expect(answers(shown)).toEqual(['Flat A2 bed, Hackney, £1,900', 'Flat B', 'Other…'])
    expect(button('Flat A', shown)?.title).toBe('2 bed, Hackney, £1,900')
  })

  it('a tap sends that answer once, and the question becomes a quiet line with what was picked', async () => {
    await open([bubble()])
    await click(button('Flat B'))
    await settle()
    expect(fake.calls.filter(([name]) => name === 'answerQuestion')).toEqual([['answerQuestion', 'flats', 'q_1', 'Flat B']])
    expect(answers()).toEqual([])
    const line = [...transcript().querySelectorAll('.bot-system-line')].find((element) => element.textContent === 'You answered “Flat B”')
    expect(line?.getAttribute('title')).toBe(QUESTION_TEXT)
    // No bubble of the owner's repeats it.
    expect(transcript().querySelector('.bot-you')).toBeNull()
  })

  it('a second tap while the first is on its way sends nothing more', async () => {
    let finish: (() => void) | undefined
    const held = new Promise<void>((resolve) => { finish = resolve })
    const original = fake.client.answerQuestion
    fake.client.answerQuestion = vi.fn(async (...args: Parameters<typeof original>) => { await held; return original(...args) })
    await open([bubble()])
    await click(button('Flat A'))
    expect(button('Flat B')?.disabled).toBe(true)
    expect(button('Flat A')?.getAttribute('aria-pressed')).toBe('true')
    await click(button('Flat B'))
    finish!()
    await settle()
    expect(fake.client.answerQuestion).toHaveBeenCalledTimes(1)
  })

  it('a tap the service refuses (answered elsewhere) gives the buttons back and says why', async () => {
    await open([bubble()])
    fake.client.answerQuestion = vi.fn(async () => { throw Object.assign(new Error('This was already answered.'), { code: 'question_answered' }) })
    await click(button('Flat A'))
    await settle()
    expect(host.querySelector('.bot-input-area .composer-notice[data-tone="error"] .composer-notice-title')?.textContent).toBe('This was already answered.')
    // The chat is read again, so it shows the question as it is now.
    expect(fake.calls.filter(([name]) => name === 'messages').length).toBeGreaterThan(1)
  })

  it('Other… replies to the question from the composer, and the answer is sent as a reply to it', async () => {
    await open([bubble()])
    await click(button('Other…'))
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))) })
    const replying = host.querySelector('.bot-replying')
    expect(replying?.textContent).toContain(QUESTION_TEXT)
    expect(replying?.textContent).not.toContain('Flat B')
    expect(document.activeElement).toBe(box())
    await act(async () => useBotsStore.getState().setDraft('flats', 'Neither, somewhere near the park'))
    await act(async () => { await useBotsStore.getState().send('flats') })
    expect(fake.calls.find(([name]) => name === 'send')).toEqual(['send', 'flats', 'Neither, somewhere near the park', expect.any(String), [], 'qb'])
  })

  it('once the owner moved on, the buttons stay and still answer it; answered or no longer needed, there are none', async () => {
    await open([bubble({}, 'moved_on'), bubble({ id: 'qa', seq: 3, question: { questionId: 'q_2', choices: [{ label: 'Yes' }, { label: 'No' }], other: false, status: 'answered', answer: 'Yes', answeredWith: 'choice' } }), bubble({ id: 'qw', seq: 4, question: { questionId: 'q_3', choices: [], other: false, status: 'withdrawn' }, text: 'Shall I?', plainFrom: undefined })])
    const moved = transcript().querySelector('[data-message-id="qb"] .bot-question-replies')
    expect(moved?.getAttribute('data-status')).toBe('moved_on')
    expect(answers(transcript().querySelector('[data-message-id="qb"]')!)).toEqual(['Flat A2 bed, Hackney, £1,900', 'Flat B', 'Other…'])
    expect(answers(transcript().querySelector('[data-message-id="qa"]')!)).toEqual([])
    expect(answers(transcript().querySelector('[data-message-id="qw"]')!)).toEqual([])
    await click(button('Flat A'))
    await settle()
    expect(fake.calls.filter(([name]) => name === 'answerQuestion')).toEqual([['answerQuestion', 'flats', 'q_1', 'Flat A']])
  })

  it('a question from work is answered with a tap the same way; answered in the chat, or no longer needed, it says so under the bubble', async () => {
    await open([
      bubble({ id: 'qr', kind: 'notice', activationId: 'act_w1' }),
      bubble({ id: 'qc', seq: 3, kind: 'notice', question: { questionId: 'q_2', choices: [{ label: 'Yes' }, { label: 'No' }], other: false, status: 'answered', answer: 'The second one', answeredWith: 'text', by: 'chat' } }),
      bubble({ id: 'qn', seq: 4, kind: 'notice', question: { questionId: 'q_3', choices: [{ label: 'Yes' }, { label: 'No' }], other: false, status: 'withdrawn' } })
    ])
    expect(answers(transcript().querySelector('[data-message-id="qr"]')!)).toEqual(['Flat A2 bed, Hackney, £1,900', 'Flat B', 'Other…'])
    expect(transcript().querySelector('[data-message-id="qc"] .bot-question-settled')?.textContent).toBe('Answered in chat: The second one')
    expect(transcript().querySelector('[data-message-id="qn"] .bot-question-settled')?.textContent).toBe('No longer needed')
    await click(button('Flat B', transcript().querySelector('[data-message-id="qr"]')!))
    await settle()
    expect(fake.calls.filter(([name]) => name === 'answerQuestion')).toEqual([['answerQuestion', 'flats', 'q_1', 'Flat B']])
  })

  it('a service with no questions sends the text alone, and the chat shows it all, answers included', async () => {
    await open([message(2, { id: 'old', text: `${QUESTION_TEXT}\n\n${PLAIN}` })])
    expect(transcript().querySelector('[data-message-id="old"] .bot-bubble')?.textContent).toContain(PLAIN)
    expect(answers()).toEqual([])
  })

  it('a service that lacks the method: the buttons go, and the question shows its answers as text to reply to', async () => {
    await open([bubble()])
    fake.client.answerQuestion = vi.fn(async () => { throw Object.assign(new Error('Method not found'), { code: 'method_not_found' }) })
    await click(button('Flat A'))
    await settle()
    expect(answers()).toEqual([])
    expect(transcript().querySelector('[data-message-id="qb"] .bot-bubble')?.textContent).toContain(PLAIN)
    expect(host.querySelector('.bot-input-area .composer-notice[data-tone="error"]')).toBeNull()
  })
})

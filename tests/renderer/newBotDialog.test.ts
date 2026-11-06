// @vitest-environment jsdom
/**
 * New bot (bot-ui §4.2): a look already picked that the owner's other bots don't wear, Shuffle, an
 * optional name, one sentence, and Create bot, which waits for the sentence and opens the chat.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/chats/ChatResourcesPanel', () => ({ ChatResourcesPanel: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTranscript', () => ({ NetworkTranscript: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkChatActions', () => ({ NetworkChatActions: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTaskPicker', () => ({ NetworkTaskPicker: () => null }))
vi.mock('../../src/renderer/components/chats/ChatBrowserAccess', () => ({ ChatBrowserAccess: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
vi.mock('../../src/renderer/components/editors/MarkdownPreview', async () => {
  const { createElement: h } = await import('react')
  return { MarkdownPreview: ({ value, className }: { value: string; className?: string }) => h('div', { className }, value) }
})

const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

let root: Root
let host: HTMLElement
let fake: FakeBots
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')
// The look picker's two radio groups (WP5's `BotLookPicker`).
const GROUPS = { 'bot-look-colour': '.bot-look-picker__colours', 'bot-look-accessory': '.bot-look-picker__accessories' } as const
const picked = (group: keyof typeof GROUPS) => dialog()?.querySelector(`${GROUPS[group]} [aria-checked="true"]`)?.getAttribute('aria-label')
const createButton = () => [...(dialog()?.querySelectorAll('button') ?? [])].find((element) => element.textContent === 'Create bot') as HTMLButtonElement | undefined
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function open(existing = fake.bots) {
  fake.bots = existing
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useBotsStore.setState({ newBotOpen: true }))
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

describe('New bot', () => {
  it('has a look, an optional name, one sentence and Create bot, and nothing about models or permissions', async () => {
    await open([])
    const box = dialog()!
    expect(box.querySelector('h2')?.textContent).toBe('New bot')
    expect([...box.querySelectorAll('.bot-look-picker__colours [role="radio"]')]).toHaveLength(8)
    expect([...box.querySelectorAll('.bot-look-picker__accessories [role="radio"]')]).toHaveLength(12)
    expect(box.querySelector<HTMLInputElement>('#bot-new-name')?.placeholder).toBe('Optional. Leave it empty and the bot names itself.')
    expect(box.querySelector<HTMLTextAreaElement>('#bot-new-text')?.placeholder).toBe('For example: every morning, tell me which emails need a reply.')
    expect([...box.querySelectorAll('input, textarea, select')]).toHaveLength(2)
    expect(box.textContent).not.toMatch(/model|permission|schedule|device/i)
  })

  it('starts with a look the other bots don’t wear', async () => {
    await open([summary('a', { look: { colour: 'coral', accessory: 'none' } }), summary('b', { look: { colour: 'teal', accessory: 'headphones' } })])
    expect(picked('bot-look-accessory')).not.toMatch(/^(None|Headphones)$/)
    expect(picked('bot-look-colour')).toBeTruthy()
  })

  it('changes the look by colour, accessory and Shuffle', async () => {
    await open([])
    const box = dialog()!
    await act(async () => box.querySelector<HTMLElement>('[aria-label="Purple"]')!.click())
    await act(async () => box.querySelector<HTMLElement>('[aria-label="Crown"]')!.click())
    expect([picked('bot-look-colour'), picked('bot-look-accessory')]).toEqual(['Purple', 'Crown'])
    expect(box.querySelector('.bot-look-picker__preview .bot-face')?.getAttribute('data-colour')).toBe('purple')
    await act(async () => [...box.querySelectorAll<HTMLElement>('button')].find((element) => element.textContent?.trim() === 'Shuffle')!.click())
    expect([picked('bot-look-colour'), picked('bot-look-accessory')]).not.toEqual(['Purple', 'Crown'])
  })

  it('enables Create bot once the sentence is written, and opens the chat with its first message', async () => {
    await open([])
    expect(createButton()?.disabled).toBe(true)
    await type(dialog()!.querySelector('#bot-new-text')!, '   ')
    expect(createButton()?.disabled).toBe(true)
    await type(dialog()!.querySelector('#bot-new-text')!, 'Every morning, tell me which emails need a reply.')
    expect(createButton()?.disabled).toBe(false)
    await act(async () => createButton()!.click())
    await act(async () => {})
    const [, input] = fake.calls.find(([name]) => name === 'create')! as [string, Record<string, unknown>]
    expect(input).toMatchObject({ description: 'Every morning, tell me which emails need a reply.' })
    expect(input).not.toHaveProperty('name')
    expect(typeof input.clientRequestId).toBe('string')
    expect(input.look).toEqual(expect.objectContaining({ colour: expect.any(String), accessory: expect.any(String) }))
    expect(dialog()).toBeNull()
    expect(useChatsStore.getState().activeBotId).toBe('new1')
    expect(host.querySelector('.chat-conversation-header h1')?.textContent).toBe('Inbox helper')
    expect(host.querySelector('.chat-run-status')?.textContent).toBe('Inbox helper is working…')
    await act(async () => fake.emit.message('new1', message(1, { text: 'Hi, I’m Inbox helper.' })))
    expect(host.querySelector('.chat-transcript')?.textContent).toContain('Hi, I’m Inbox helper.')
  })

  it('sends the name when one is given', async () => {
    await open([])
    await type(dialog()!.querySelector('#bot-new-name')!, '  Garden  ')
    await type(dialog()!.querySelector('#bot-new-text')!, 'Remind me to water the plants.')
    await act(async () => createButton()!.click())
    await act(async () => {})
    expect(fake.calls.find(([name]) => name === 'create')?.[1]).toMatchObject({ name: 'Garden' })
  })

  it('keeps the dialog open with the error when create fails', async () => {
    await open([])
    vi.mocked(fake.client.create).mockRejectedValueOnce(new Error('The service is busy'))
    await type(dialog()!.querySelector('#bot-new-text')!, 'Watch for cheap flights.')
    await act(async () => createButton()!.click())
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('The service is busy')
    expect(useChatsStore.getState().activeBotId).toBeNull()
  })
})

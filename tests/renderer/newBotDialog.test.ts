// @vitest-environment jsdom
/**
 * New bot (bot-ui §4.2): a look already picked that the owner's other bots don't wear, Shuffle, an
 * optional name, one sentence, and Create bot, which waits for the sentence and opens the chat.
 * Create bot always answers (busy, then the bot or a plain error), and nothing that closes,
 * remounts or hides the dialog loses what the owner put in.
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
// App mounts New bot apart from the chat pane (older code kept it inside the pane).
const NewBotDialogHost = ((await import('../../src/renderer/components/bots/NewBotDialog')) as { NewBotDialogHost?: () => null }).NewBotDialogHost ?? (() => null)
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
/** The Chats pane (when `pane`) and App's New bot. */
async function render(pane = true) {
  await act(async () => root.render(createElement('div', null, pane && createElement(ChatWorkspace), createElement(NewBotDialogHost))))
}
async function open(existing = fake.bots) {
  fake.bots = existing
  await act(async () => useChatsStore.getState().activate('p1'))
  await render()
  await act(async () => useBotsStore.setState({ newBotOpen: true }))
}
/** A promise settled by hand: a create (or list) still on its way. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const nameBox = () => dialog()!.querySelector<HTMLInputElement>('#bot-new-name')!
const textBox = () => dialog()!.querySelector<HTMLTextAreaElement>('#bot-new-text')!
const creates = () => fake.calls.filter(([name]) => name === 'create') as Array<[string, Record<string, unknown>]>
/** Purple with a crown, Garden, and a sentence: everything the owner can put in. */
async function fillIn() {
  await act(async () => dialog()!.querySelector<HTMLElement>('[aria-label="Purple"]')!.click())
  await act(async () => dialog()!.querySelector<HTMLElement>('[aria-label="Crown"]')!.click())
  await type(nameBox(), 'Garden')
  await type(textBox(), 'Remind me to water the plants.')
}
const filledIn = () => ({ name: nameBox()?.value, text: textBox()?.value, colour: picked('bot-look-colour'), accessory: picked('bot-look-accessory') })
const FILLED = { name: 'Garden', text: 'Remind me to water the plants.', colour: 'Purple', accessory: 'Crown' }
const backdrop = () => host.querySelector<HTMLElement>('.chat-dialog-backdrop')!
const mouseDown = async (element: HTMLElement) => { await act(async () => { element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) }) }

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
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toMatch(/^Mousse couldn’t finish making the bot\./)
    expect(dialog()?.querySelector<HTMLTextAreaElement>('#bot-new-text')?.value).toBe('Watch for cheap flights.')
    expect(useChatsStore.getState().activeBotId).toBeNull()
  })
})

describe('Create bot always answers', () => {
  it('shows Creating… while the create is on its way, and a second click or Ctrl+Enter makes no second request', async () => {
    await open([])
    const pending = deferred<ReturnType<typeof summary>>()
    vi.mocked(fake.client.create).mockImplementationOnce((input) => { fake.calls.push(['create', input]); return pending.promise })
    await type(textBox(), 'Watch for cheap flights.')
    await act(async () => { createButton()!.click(); createButton()!.click() })
    await act(async () => { textBox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
    const busy = [...dialog()!.querySelectorAll('button')].find((element) => element.textContent?.includes('Creating…')) as HTMLButtonElement
    expect(busy?.disabled).toBe(true)
    expect(creates()).toHaveLength(1)
    await act(async () => pending.resolve(summary('new1', { name: 'Flight deals' })))
    await act(async () => {})
    expect(dialog()).toBeNull()
    expect(useChatsStore.getState().activeBotId).toBe('new1')
  })

  it('says in plain words when the create fails, keeps everything put in, and a retry reuses the request', async () => {
    await open([])
    await fillIn()
    vi.mocked(fake.client.create).mockRejectedValueOnce({ code: 'platform_request_failed', message: 'Something went wrong. Please try again or report this error. Reference: 1234' })
    await act(async () => createButton()!.click())
    await act(async () => {})
    const alert = dialog()?.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toBe('Mousse couldn’t finish making the bot. What you wrote is kept: press Create bot to try again. It won’t make the same bot twice.')
    expect(alert).not.toMatch(/Reference|Something went wrong/)
    expect(filledIn()).toEqual(FILLED)
    expect(createButton()?.disabled).toBe(false)
    await act(async () => createButton()!.click())
    await act(async () => {})
    const [[first], [second]] = vi.mocked(fake.client.create).mock.calls
    expect(second!.clientRequestId).toBe(first!.clientRequestId)
    expect(useChatsStore.getState().activeBotId).toBe('new1')
  })

  it('shows the service’s own words for a refused description', async () => {
    await open([])
    vi.mocked(fake.client.create).mockRejectedValueOnce({ code: 'invalid_params', message: 'Say what the bot should do in 1 to 500 characters.' })
    await type(textBox(), 'Watch for cheap flights.')
    await act(async () => createButton()!.click())
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Say what the bot should do in 1 to 500 characters.')
  })

  it('keeps the new bot open when a list asked for before it was made arrives after it', async () => {
    await open([summary('a', { name: 'Inbox helper' })])
    const stale = deferred<ReturnType<typeof summary>[]>()
    vi.mocked(fake.client.list).mockImplementationOnce(() => stale.promise)
    // The 2-second poll is on its way when Create bot is pressed.
    void useBotsStore.getState().refresh()
    await type(textBox(), 'Every morning, tell me which emails need a reply.')
    await act(async () => createButton()!.click())
    await act(async () => {})
    await act(async () => stale.resolve([summary('a', { name: 'Inbox helper' })]))
    await act(async () => {})
    expect(useChatsStore.getState().activeBotId).toBe('new2')
    expect(host.querySelector('.chat-conversation-header h1')?.textContent).toBe('Inbox helper')
    expect(useBotsStore.getState().bots.map((bot) => bot.id)).toEqual(['a', 'new2'])
  })
})

describe('New bot keeps what was put in', () => {
  it('through polls, a bot opening behind it and the chat pane going away', async () => {
    fake.chats.a = [message(1)]
    await open([summary('a', { name: 'Inbox helper' })])
    await fillIn()
    fake.bots = [summary('a', { name: 'Inbox helper', state: 'working', stateText: 'Working…' }), summary('b', { name: 'Garden helper' })]
    await act(async () => { fake.emit.changed('a'); await useBotsStore.getState().refresh() })
    expect(filledIn()).toEqual(FILLED)
    // A bot's chat opens behind it (a notification, a bot's own event).
    await act(async () => useChatsStore.setState({ activeBotId: 'a' }))
    expect(filledIn()).toEqual(FILLED)
    // The pane switches to Projects (a thread is selected) and back.
    await render(false)
    expect(filledIn()).toEqual(FILLED)
    await render(true)
    expect(filledIn()).toEqual(FILLED)
  })

  it('ignores a click beside it once something is put in, and Close keeps it for next time', async () => {
    await open([])
    await mouseDown(backdrop())
    expect(dialog()).toBeNull()
    await act(async () => useBotsStore.setState({ newBotOpen: true }))
    await fillIn()
    await mouseDown(backdrop())
    expect(dialog()).not.toBeNull()
    expect(filledIn()).toEqual(FILLED)
    await act(async () => dialog()!.querySelector<HTMLElement>('[aria-label="Close"]')!.click())
    expect(dialog()).toBeNull()
    await act(async () => useBotsStore.setState({ newBotOpen: true }))
    expect(filledIn()).toEqual(FILLED)
  })

  it('starts empty again once the bot is made', async () => {
    await open([])
    await fillIn()
    await act(async () => createButton()!.click())
    await act(async () => {})
    expect(dialog()).toBeNull()
    await act(async () => useBotsStore.setState({ newBotOpen: true }))
    expect([nameBox().value, textBox().value]).toEqual(['', ''])
  })
})

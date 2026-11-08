// @vitest-environment jsdom
/**
 * A bot's chat (bot-ui §4.4, §4.8, §4.9): the owner's bubbles, the bot's messages with chips, asks
 * and error lines, one status line with the live chip while it works, a composer with only text,
 * attach and send or Stop, and the one menu with About, Rename, Change look, Pause and Delete.
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
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

let root: Root
let host: HTMLElement
let fake: FakeBots
let pickFiles: ReturnType<typeof vi.fn>
let setViewedBot: ReturnType<typeof vi.fn>
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()
const appInitial = useAppStore.getInitialState()

const inbox = summary('inbox', { name: 'Inbox helper', description: 'Tells me which emails need a reply.' })
const transcript = () => host.querySelector<HTMLElement>('.chat-transcript')!
const composer = () => host.querySelector<HTMLFormElement>('.agent-chat-composer')!
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function open(bot = inbox) {
  fake.bots = [bot]
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(bot.id))
}

beforeEach(() => {
  fake = fakeBots()
  pickFiles = vi.fn(async () => ['/home/me/Invoices/march.pdf'])
  setViewedBot = vi.fn(async () => undefined)
  installPreload(fake, { dialog: { pickFiles }, app: { setViewedBot } })
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
  useAppStore.setState({ settingsOpen: appInitial.settingsOpen })
})

describe('the transcript', () => {
  it('shows the owner’s messages as bubbles and the bot’s with its face, name, time, chips, ask and error', async () => {
    fake.chats.inbox = [
      message(1, { author: 'owner', text: 'Send the one to the Lisbon host.' }),
      message(2, { text: 'Sent.', chips: [{ icon: 'web', text: 'read 2 pages', highlight: 'example.com' }, { icon: 'memory', text: 'remembered', highlight: 'vegetarian' }] }),
      message(3, { text: 'I need one thing.', ask: { askId: 'k1', title: 'read files in ~/Invoices', note: 'Only this folder.', status: 'open' } }),
      message(4, { kind: 'error', text: 'I couldn’t do this morning’s check.', error: { text: 'Set up a provider so I can work.', action: { kind: 'open_providers', label: 'Set up' } } })
    ]
    await open()
    const [owner, chips, ask, error] = [...transcript().querySelectorAll('article')]
    expect(owner!.classList.contains('bot-you')).toBe(true)
    expect(owner!.querySelector('.bot-you-bubble')?.textContent).toBe('Send the one to the Lisbon host.')
    expect(owner!.querySelector('.bot-face, strong')).toBeNull()
    expect(chips!.classList.contains('from-agent')).toBe(true)
    expect(chips!.querySelector('.bot-face')).not.toBeNull()
    expect(chips!.querySelector('.chat-message-meta strong')?.textContent).toBe('Inbox helper')
    expect(chips!.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-07T09:00:00.000Z')
    expect([...chips!.querySelectorAll('.bot-chip')].map((chip) => chip.textContent)).toEqual(['read 2 pages example.com', 'remembered vegetarian'])
    expect(chips!.querySelector('.bot-chip b')?.textContent).toBe('example.com')
    expect(ask!.querySelector('.bot-ask-title')?.textContent).toBe('Inbox helper wants to read files in ~/Invoices')
    expect(error!.querySelector('.bot-error span')?.textContent).toBe('Set up a provider so I can work.')
    await click(button('Set up', error!))
    expect(useAppStore.getState().settingsOpen).toBe(true)
  })

  it('Sign in opens Settings, Providers on the entry to sign in to (the bot runner\'s card)', async () => {
    const { takePendingProvider } = await import('../../src/renderer/lib/settingsNavigation')
    const requested: string[] = []
    const listen = (event: Event) => requested.push(String((event as CustomEvent).detail))
    window.addEventListener('mousse:settings-provider', listen)
    try {
      fake.chats.inbox = [message(1, { kind: 'error', text: 'Sign in so I can work.', error: { text: 'Sign in so I can work.', action: { kind: 'sign_in', label: 'Sign in', instanceId: 'claude:bots' } } })]
      await open()
      await click(button('Sign in', transcript().querySelector('article')!))
      expect(useAppStore.getState().settingsOpen).toBe(true)
      expect(requested).toEqual(['claude:bots'])
      expect(takePendingProvider()).toBe('claude:bots')
    } finally {
      window.removeEventListener('mousse:settings-provider', listen)
    }
  })

  it('reports the bot it shows, and reads up to the last message', async () => {
    fake.bots = [{ ...inbox, unread: 2 }]
    fake.chats.inbox = [message(5), message(6)]
    await open({ ...inbox, unread: 2 })
    expect(setViewedBot).toHaveBeenCalledWith('inbox')
    expect(fake.calls).toContainEqual(['markRead', 'inbox', 6])
    expect(useBotsStore.getState().bots[0]?.unread).toBe(0)
    act(() => root.unmount())
    expect(setViewedBot).toHaveBeenLastCalledWith(null)
    root = createRoot(host)
  })

  it('pages back with beforeSeq when scrolled to the top', async () => {
    fake.chats.inbox = Array.from({ length: 70 }, (_, index) => message(index + 1))
    await open()
    expect(transcript().querySelectorAll('article')).toHaveLength(50)
    await act(async () => { transcript().dispatchEvent(new Event('scroll')) })
    await act(async () => {})
    expect(fake.calls).toContainEqual(['messages', 'inbox', { beforeSeq: 21, limit: 50 }])
    expect(transcript().querySelectorAll('article')).toHaveLength(70)
  })
})

describe('while it works', () => {
  it('shows one status line with the live chip, and Stop in place of send', async () => {
    fake.live.inbox = { activationId: 'act1', chip: { icon: 'search', text: 'searching the web' } }
    await open({ ...inbox, state: 'working', stateText: 'Working…' })
    const status = transcript().querySelector('.chat-run-status')!
    expect(status.textContent).toBe('Inbox helper is working…searching the web')
    expect(status.querySelector('.bot-chip.is-live')).not.toBeNull()
    await act(async () => fake.emit.activity('inbox', { icon: 'web', text: 'reading a page', highlight: 'example.com' }))
    expect(status.querySelector('.bot-chip')?.textContent).toBe('reading a page example.com')
    await click(button('Stop'))
    expect(fake.calls).toContainEqual(['stop', 'inbox'])
  })

  it('says Waiting for internet in the header and the status line, with no spinner, and still offers Stop', async () => {
    await open({ ...inbox, state: 'working', stateText: 'Waiting for internet', waiting: 'internet' })
    expect(host.querySelector('.chat-conversation-header span')?.textContent).toBe('Waiting for internet')
    const status = transcript().querySelector('.chat-run-status')!
    expect(status.textContent).toBe('Waiting for internet')
    expect(status.querySelector('.chat-spin')).toBeNull()
    expect(transcript().textContent).not.toContain('is working')
    await click(button('Stop'))
    expect(fake.calls).toContainEqual(['stop', 'inbox'])
  })
})

describe('the composer', () => {
  it('has only text, attach and send', async () => {
    await open()
    const form = composer()
    expect([...form.querySelectorAll('textarea, input, select')].map((element) => element.tagName)).toEqual(['TEXTAREA'])
    expect([...form.querySelectorAll('button')].map((element) => element.getAttribute('aria-label'))).toEqual(['Attach', 'Send'])
    expect(form.textContent).toBe('')
    expect(button('Send')?.disabled).toBe(true)
  })

  it('sends the words, shows them at once and empties the box', async () => {
    await open()
    let release!: () => void
    vi.mocked(fake.client.send).mockImplementationOnce((botId, text, id) => new Promise((resolve) => {
      release = () => resolve(message(9, { id: 'sent', author: 'owner', text }))
    }))
    await type(composer().querySelector('textarea')!, 'Do this every weekday at 9.')
    await act(async () => composer().requestSubmit())
    expect(transcript().querySelector('.bot-you.is-pending')?.textContent).toContain('Do this every weekday at 9.')
    expect(composer().querySelector('textarea')?.value).toBe('')
    await act(async () => release())
    expect(transcript().querySelector('.is-pending')).toBeNull()
    expect(transcript().querySelectorAll('.bot-you')).toHaveLength(1)
  })

  it('puts the words back when sending fails', async () => {
    await open()
    vi.mocked(fake.client.send).mockRejectedValueOnce(new Error('The bot is not there'))
    await type(composer().querySelector('textarea')!, 'Hello')
    await act(async () => composer().requestSubmit())
    await act(async () => {})
    expect(composer().querySelector('textarea')?.value).toBe('Hello')
    expect(host.querySelector('.chat-composer-error')?.textContent).toBe('The bot is not there')
    expect(transcript().querySelector('.bot-you')).toBeNull()
  })

  it('attaches files picked on this computer and sends them with the message', async () => {
    await open()
    await click(button('Attach'))
    expect(composer().querySelector('.bot-file-pill')?.textContent).toBe('march.pdf')
    await act(async () => composer().requestSubmit())
    await act(async () => {})
    const send = fake.calls.find(([name]) => name === 'send')!
    expect(send[4]).toEqual([{ name: 'march.pdf', path: '/home/me/Invoices/march.pdf' }])
  })

  it('says Paused with Resume while the bot is paused', async () => {
    await open({ ...inbox, state: 'paused', stateText: 'Paused until 14:00' })
    expect(transcript().querySelector('.bot-paused-line')?.textContent).toBe('Paused until 14:00. Resume')
    await click(button('Resume', transcript()))
    expect(fake.calls).toContainEqual(['resume', 'inbox'])
  })
})

describe('the menu', () => {
  it('offers About, Rename, Change look, Pause and Delete bot', async () => {
    await open()
    await click(button('Bot menu'))
    expect([...host.querySelectorAll('[role="menuitem"]')].map((element) => element.textContent)).toEqual(['About this bot', 'Rename', 'Change look', 'Pause', 'Delete bot'])
    await click(button('About this bot'))
    expect(host.querySelector('.bot-about')).not.toBeNull()
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })

  it('opens About from the header too', async () => {
    await open()
    await click(button('About Inbox helper'))
    expect(host.querySelector('aside.bot-about')?.getAttribute('aria-label')).toBe('About Inbox helper')
  })

  it('renames the bot', async () => {
    await open()
    await click(button('Bot menu'))
    await click(button('Rename'))
    await type(host.querySelector<HTMLInputElement>('#bot-rename')!, 'Mail helper')
    await click(button('Save'))
    expect(fake.calls).toContainEqual(['update', 'inbox', { name: 'Mail helper' }])
    expect(host.querySelector('.chat-conversation-header h1')?.textContent).toBe('Mail helper')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('changes the look', async () => {
    await open()
    await click(button('Bot menu'))
    await click(button('Change look'))
    await click(button('Pink'))
    await click(button('Chef hat'))
    await click(button('Save'))
    expect(fake.calls).toContainEqual(['update', 'inbox', { look: { colour: 'pink', accessory: 'chef_hat' } }])
    expect(host.querySelector('.chat-conversation-header .bot-face')?.getAttribute('data-accessory')).toBe('chef_hat')
  })

  it('pauses and resumes', async () => {
    await open()
    await click(button('Bot menu'))
    await click(button('Pause'))
    expect(fake.calls).toContainEqual(['pause', 'inbox'])
    await click(button('Bot menu'))
    expect(button('Resume')?.getAttribute('role')).toBe('menuitem')
  })

  it('deletes after a confirm that says what is kept', async () => {
    await open()
    await click(button('Bot menu'))
    await click(button('Delete bot'))
    const confirm = host.querySelector('[role="dialog"]')!
    expect(confirm.querySelector('h2')?.textContent).toBe('Delete Inbox helper?')
    expect(confirm.textContent).toContain('Its chat and memory are kept for 30 days, then erased.')
    expect(fake.calls.some(([name]) => name === 'remove')).toBe(false)
    await click(button('Delete bot', confirm))
    expect(fake.calls).toContainEqual(['remove', 'inbox'])
    expect(useChatsStore.getState().activeBotId).toBeNull()
    expect(host.querySelector('.bot-conversation')).toBeNull()
  })
})

describe('the store behind the chats', () => {
  it('never brings back a deleted bot from a list that was on its way, and keeps a bot’s error in its own chat', async () => {
    const other = summary('garden', { name: 'Garden' })
    await open(inbox)
    fake.bots = [inbox, other]
    // A list asked for before the delete answers after it, with the bot still in it.
    let answer: (list: typeof fake.bots) => void = () => {}
    vi.mocked(fake.client.list).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const listed = [...fake.bots]
    let refreshing!: Promise<void>
    await act(async () => { refreshing = useBotsStore.getState().refresh() })
    await act(async () => { await useBotsStore.getState().remove('inbox') })
    await act(async () => { answer(listed); await refreshing })
    expect(useBotsStore.getState().bots.map((bot) => bot.id)).toEqual(['garden'])
    await act(async () => { await useBotsStore.getState().loadDetail('inbox').catch(() => undefined) })
    expect(useBotsStore.getState().bots.map((bot) => bot.id)).toEqual(['garden'])
    // A pause of Garden that fails while Mail's chat is open is Garden's error: Mail's composer does not show it.
    fake.bots = [other, summary('mail', { name: 'Mail' })]
    await act(async () => { await useBotsStore.getState().refresh() })
    await act(async () => useChatsStore.getState().openBot('mail'))
    vi.mocked(fake.client.pause).mockRejectedValueOnce(new Error('Garden could not pause'))
    await act(async () => { await useBotsStore.getState().pause('garden') })
    expect(useBotsStore.getState()).toMatchObject({ error: 'Garden could not pause', errorBotId: 'garden' })
    expect(host.querySelector('.chat-composer-error')).toBeNull()
    vi.mocked(fake.client.pause).mockRejectedValueOnce(new Error('Mail could not pause'))
    await act(async () => { await useBotsStore.getState().pause('mail') })
    expect(host.querySelector('.chat-composer-error')?.textContent).toBe('Mail could not pause')
  })

  it('starts the chat over when more rows arrived than a page while events were missed', async () => {
    fake.chats.inbox = Array.from({ length: 10 }, (_, index) => message(index + 1))
    await open()
    expect(transcript().querySelectorAll('article')).toHaveLength(10)
    fake.chats.inbox = Array.from({ length: 80 }, (_, index) => message(index + 1))
    await act(async () => { await useBotsStore.getState().loadChat('inbox') })
    const held = useBotsStore.getState().chats.inbox!
    expect(held.messages.map((row) => row.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 31))
    expect(held.hasMore).toBe(true)
    await act(async () => { await useBotsStore.getState().loadOlder('inbox') })
    expect(useBotsStore.getState().chats.inbox!.messages.map((row) => row.seq)).toEqual(Array.from({ length: 80 }, (_, index) => index + 1))
  })
})

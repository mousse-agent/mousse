// @vitest-environment jsdom
/**
 * The bots of the owner's other computers, beside this computer's own (#2030): one Bots list, the computer a bot
 * lives on, its chat through `bots.focus` with only what works from here, its reply as it is written, and a computer
 * that is offline (a faded row, a dozing face, a chat read from the copy).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotChatMessage, BotSummary } from '../../src/shared/bots/personal/chat'
import { plainCards, type BotChatCard } from '../../src/shared/bots/personal/cards'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'
import { startDragOut } from '../../src/renderer/lib/fileDragOut'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/chats/ChatResourcesPanel', () => ({ ChatResourcesPanel: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTranscript', () => ({ NetworkTranscript: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkChatActions', () => ({ NetworkChatActions: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTaskPicker', () => ({ NetworkTaskPicker: () => null }))
vi.mock('../../src/renderer/components/chats/ChatBrowserAccess', () => ({ ChatBrowserAccess: () => null }))
vi.mock('../../src/renderer/components/chats/OpenNetworkChatDialog', () => ({ OpenNetworkChatDialog: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const { ChatsSidebar } = await import('../../src/renderer/components/chats/ChatsSidebar')
const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { clearBotLiveReplies } = await import('../../src/renderer/stores/botLiveReplies')

let root: Root
let host: HTMLElement
let fake: FakeBots
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

const LAPTOP = { node: 'n_laptop', name: 'Laptop' }
const local = summary('b_desk', { name: 'Desk helper', last: { text: 'Done.', at: '2026-11-07T09:00:00.000Z', author: 'bot' } })
/** A bot of another computer, as `bots.remote.list` names it: qualified ids, and the computer it lives on. */
const remote = (over: Partial<BotSummary> = {}): BotSummary => summary('n_laptop:b_inbox', {
  name: 'Inbox helper', homeThreadId: 'n_laptop:t_home', lives: { ...LAPTOP }, last: { text: 'Sorted.', at: '2026-11-07T10:00:00.000Z', author: 'bot' }, ...over
})
const away = (over: Partial<BotSummary> = {}) => remote({ lives: { ...LAPTOP, offline: true }, ...over })

const rows = () => [...host.querySelectorAll<HTMLButtonElement>('.chats-sidebar-content button[aria-label^="Message "]')]
const row = (name: string) => rows().find((element) => element.getAttribute('aria-label') === `Message ${name}`)!
const transcript = () => host.querySelector<HTMLElement>('.chat-transcript')!
const box = () => host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea.composer-input')
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
async function type(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}

async function show(bots: BotSummary[], pane = false) {
  fake.bots = bots
  await act(async () => {
    useChatsStore.getState().activate('p1')
    useChatsStore.setState({ snapshot: { agents: [], chats: [], devices: [] } })
  })
  await act(async () => root.render(createElement('div', null, createElement(ChatsSidebar), pane && createElement(ChatWorkspace))))
  await settle()
}
async function open(bot: BotSummary, chat: BotChatMessage[] = [message(1, { text: 'Three new invoices.' })]) {
  fake.chats[bot.id] = chat
  await show([local, bot], true)
  await act(async () => useChatsStore.getState().openBot(bot.id))
  await settle()
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  fake = fakeBots()
  installPreload(fake)
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
  setBotsClient(fake.client)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  setBotsClient(null)
  clearBotLiveReplies()
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
})

describe('one Bots list', () => {
  it('lists the other computers\' bots among this computer\'s own, by their latest message, with the computer they live on', async () => {
    await show([local, remote(), summary('b_new', { name: 'Quiet one', createdAt: '2026-11-07T08:00:00.000Z' })])
    expect(rows().map((element) => element.getAttribute('aria-label'))).toEqual(['Message Inbox helper', 'Message Desk helper', 'Message Quiet one'])
    const badge = row('Inbox helper').querySelector('.computer-badge')!
    expect(badge.getAttribute('title')).toBe('Lives on Laptop')
    expect(badge.getAttribute('data-state')).toBe('online')
    expect(row('Desk helper').querySelector('.computer-badge')).toBeNull()
    expect(row('Inbox helper').hasAttribute('data-away')).toBe(false)
  })

  it('keeps rows with the same time in one order, whichever list brings them first', async () => {
    const at = { text: 'Hi', at: '2026-11-07T10:00:00.000Z', author: 'bot' as const }
    await show([summary('b_zed', { name: 'Zed', last: at }), summary('b_amy', { name: 'Amy', last: at }), remote({ last: at })])
    const first = rows().map((element) => element.getAttribute('aria-label'))
    await act(async () => { fake.bots = [...fake.bots].reverse(); await useBotsStore.getState().refresh() })
    expect(rows().map((element) => element.getAttribute('aria-label'))).toEqual(first)
    expect(first).toEqual(['Message Amy', 'Message Zed', 'Message Inbox helper'])
  })

  it('keeps the other computers\' bots it listed when they can\'t be read now, and lists none from a service without them', async () => {
    await show([local, remote()])
    vi.mocked(fake.client.remoteList).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'internal' }))
    await act(async () => useBotsStore.getState().refresh())
    expect(useBotsStore.getState().bots.map((bot) => bot.id)).toEqual(['b_desk', 'n_laptop:b_inbox'])
    vi.mocked(fake.client.remoteList).mockRejectedValueOnce(Object.assign(new Error('no such method'), { code: 'method_not_found' }))
    await act(async () => useBotsStore.getState().refresh())
    expect(useBotsStore.getState().bots.map((bot) => bot.id)).toEqual(['b_desk'])
  })

  it('lists again when the other computers\' bots change', async () => {
    await show([local])
    fake.bots = [local, remote()]
    await act(async () => fake.emit.remote())
    await settle()
    expect(rows()).toHaveLength(2)
  })

  it('fades a bot whose computer is offline, strikes its computer through, and lets its face doze under a moon', async () => {
    await show([summary('b_rest', { name: 'Rester' }), away({ state: 'working', stateText: 'Sorting the inbox…', chat: { activationId: 'act1' } })])
    const offline = row('Inbox helper')
    expect(offline.getAttribute('data-away')).toBe('true')
    expect(offline.querySelector('[data-tone]')?.textContent).toBe('Offline')
    expect(offline.querySelector('.computer-badge')?.getAttribute('data-state')).toBe('offline')
    expect(offline.querySelector('.computer-badge')?.getAttribute('title')).toMatch(/^Lives on Laptop · Offline/)
    // The flat face (no WebGL here): asleep, with the moon and not the z.
    const face = offline.querySelector('.bot-face')!
    expect(face.getAttribute('data-state')).toBe('paused')
    expect(face.querySelector('path.bot-face-z-still')).not.toBeNull()
    expect(face.textContent).not.toContain('z')
    // A bot of this computer that rests keeps its z.
    expect(row('Rester').querySelector('.bot-face')!.textContent).toContain('z')
    expect(row('Rester').querySelector('path.bot-face-z-still')).toBeNull()
  })

  /** The row menu's items of another computer's bot: label, and the tooltip of a greyed one. */
  const rowMenu = async () => {
    await act(async () => { row('Inbox helper').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })) })
    return [...document.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Inbox helper menu"] [role="menuitem"]')]
  }
  const SETUP = ['About this bot', 'Rename', 'Change look', 'Pause', 'Make private', 'Delete bot']
  const greyed = (items: HTMLElement[]) => items.filter((item) => item.getAttribute('aria-disabled') === 'true').map((item) => [item.textContent, item.title])

  it('with Full bot access there, its row menu sets it up from here', async () => {
    await show([local, remote({ lives: { ...LAPTOP, level: 'full' } })])
    const items = await rowMenu()
    expect(items.map((item) => item.textContent)).toEqual(['Pin', 'Mark as unread', 'Mute notifications', 'Hide', 'Hide checklist', ...SETUP])
    expect(greyed(items)).toEqual([])
    expect(items.find((item) => item.textContent === 'Make private')!.title).toBe('Only Laptop and this computer reach it. Change it in About.')
    await click(items.find((item) => item.textContent === 'Pause'))
    await settle()
    expect(fake.calls).toContainEqual(['pause', 'n_laptop:b_inbox'])
  })

  it('with Use bot access there, its setup shows greyed, saying why, and does nothing', async () => {
    await show([local, remote()])
    const items = await rowMenu()
    expect(greyed(items)).toEqual(SETUP.map((label) => [label, 'Needs Full bot access on Laptop']))
    await click(items.find((item) => item.textContent === 'Pause'))
    await settle()
    expect(fake.calls.some(([name]) => name === 'pause')).toBe(false)
  })

  it('while its computer is offline, its setup shows greyed, saying so, even with Full bot access there', async () => {
    await show([local, away({ lives: { ...LAPTOP, level: 'full', offline: true } })])
    const items = await rowMenu()
    expect(greyed(items).filter(([label]) => SETUP.includes(label!))).toEqual(SETUP.map((label) => [label, 'Laptop is offline']))
  })
})

describe('the chat of a bot of another computer', () => {
  it('holds its chat stream while it shows, by its qualified id, and lets go when it closes', async () => {
    await open(remote())
    expect(fake.calls).toContainEqual(['focus', 'n_laptop:b_inbox', true])
    expect(fake.calls).toContainEqual(['messages', 'n_laptop:b_inbox', { limit: 50 }])
    expect(transcript().textContent).toContain('Three new invoices.')
    act(() => root.unmount())
    expect(fake.calls).toContainEqual(['focus', 'n_laptop:b_inbox', false])
    root = createRoot(host)
  })

  it('holds it again when the window\'s connection opens again', async () => {
    await open(remote())
    fake.calls.length = 0
    await act(async () => fake.emit.reread())
    await settle()
    expect(fake.calls).toContainEqual(['focus', 'n_laptop:b_inbox', true])
  })

  it('with Use bot access there, shows only what works from here: no About or model, a side panel with its browser alone, its setup greyed, no reactions, and files can be attached', async () => {
    await open(remote({ state: 'paused', stateText: 'Paused' }), [message(1, { text: 'Here is the chart.', reaction: '👍' })])
    expect(button('About Inbox helper')).toBeUndefined()
    // Its browser is watched from here at Use; Agent settings need Full there.
    await click(button('Show side panel'))
    expect([...host.querySelectorAll('aside.bot-side .surface-menu-row')].map((row) => row.textContent?.trim())).toEqual(['Browser'])
    await click(button('Hide side panel'))
    expect(host.querySelector('.bot-model-button, [aria-label^="Model"]')).toBeNull()
    expect(host.querySelector('.bot-header-name .computer-badge')?.getAttribute('title')).toBe('Lives on Laptop')
    expect(button('Resume', host.querySelector('.bot-paused-line')!)).toBeUndefined()
    await click(button('Bot menu'))
    const items = [...host.querySelectorAll<HTMLElement>('.bot-menu [role="menuitem"]')]
    expect(items.map((item) => item.textContent)).toEqual(['About this bot', 'Find in chat', 'Hide checklist', 'Rename', 'Change look', 'Resume', 'Make private', 'Delete bot'])
    expect(items.filter((item) => item.getAttribute('aria-disabled') === 'true').map((item) => [item.textContent, item.title])).toEqual(
      ['About this bot', 'Rename', 'Change look', 'Resume', 'Make private', 'Delete bot'].map((label) => [label, 'Needs Full bot access on Laptop']))
    await click(items.find((item) => item.textContent === 'Rename'))
    expect(useBotsStore.getState().dialog).toBeNull()
    expect(button('Attach files')).toBeDefined()
    expect(transcript().querySelector('.bot-reaction-bar, .bot-reaction')).toBeNull()
  })

  it('with Full bot access there, About, Resume and every setup item work from here, by its qualified id', async () => {
    await open(remote({ lives: { ...LAPTOP, level: 'full' }, state: 'paused', stateText: 'Paused' }))
    await click(button('Resume', host.querySelector('.bot-paused-line')!))
    await settle()
    expect(fake.calls).toContainEqual(['resume', 'n_laptop:b_inbox'])
    await click(button('Bot menu'))
    const items = [...host.querySelectorAll<HTMLElement>('.bot-menu [role="menuitem"]')]
    expect(items.filter((item) => item.getAttribute('aria-disabled') === 'true')).toEqual([])
    await click(items.find((item) => item.textContent === 'Rename'))
    expect(useBotsStore.getState().dialog).toEqual({ kind: 'rename', botId: 'n_laptop:b_inbox' })
    await act(async () => useBotsStore.setState({ dialog: null }))
    await click(button('Bot menu'))
    await click([...host.querySelectorAll<HTMLElement>('.bot-menu [role="menuitem"]')].find((item) => item.textContent === 'About this bot'))
    await settle()
    expect(useBotsStore.getState().aboutOpen).toBe(true)
  })

  it('while its computer is offline, its setup is greyed saying so, and an open About closes', async () => {
    await open(remote({ lives: { ...LAPTOP, level: 'full' } }))
    await act(async () => useBotsStore.setState({ aboutOpen: true }))
    expect(useBotsStore.getState().aboutOpen).toBe(true)
    fake.bots = [local, away({ lives: { ...LAPTOP, level: 'full', offline: true } })]
    await act(async () => fake.emit.remote())
    await settle()
    expect(useBotsStore.getState().aboutOpen).toBe(false)
    await click(button('Bot menu'))
    const items = [...host.querySelectorAll<HTMLElement>('.bot-menu [role="menuitem"]')]
    expect(items.filter((item) => item.getAttribute('aria-disabled') === 'true').map((item) => item.title)).toEqual(Array(6).fill('Laptop is offline'))
  })

  it.each([
    ['lowers this one to Use', { ...LAPTOP, level: 'use' as const }],
    ['goes offline', { ...LAPTOP, level: 'full' as const, offline: true }]
  ])('when its computer %s, an open Rename and Memory close', async (_case, lives) => {
    await open(remote({ lives: { ...LAPTOP, level: 'full' } }))
    await act(async () => useBotsStore.setState({ dialog: { kind: 'rename', botId: 'n_laptop:b_inbox' }, memoryOpen: { botId: 'n_laptop:b_inbox' } }))
    expect(document.querySelector('.bot-dialog')).not.toBeNull()
    fake.bots = [local, away({ lives })]
    await act(async () => fake.emit.remote())
    await settle()
    expect(useBotsStore.getState().dialog).toBeNull()
    expect(useBotsStore.getState().memoryOpen).toBeNull()
    expect(document.querySelector('.bot-dialog')).toBeNull()
  })

  it('sends words and files to it by its qualified id, none of this computer\'s threads, and a / as words', async () => {
    await open(remote())
    // A thread of this computer held for it some other way than its composer: never sent there.
    await act(async () => {
      useBotsStore.getState().setAttachments('n_laptop:b_inbox', [{ id: 'f1', file: new File(['x'], 'notes.txt', { type: 'text/plain' }) }])
      useBotsStore.getState().addReference('n_laptop:b_inbox', { id: 'r1', kind: 'thread', threadId: 't_local', title: 'Local thread' } as never)
    })
    await type(box()!, '/clear the old drafts')
    await click(button('Send message'))
    await settle()
    const sent = fake.calls.find(([name]) => name === 'send')!
    expect(sent.slice(0, 2)).toEqual(['send', 'n_laptop:b_inbox'])
    expect(sent[2]).toBe('/clear the old drafts')
    expect(sent[4]).toEqual([{ name: 'notes.txt', path: '/home/me/Desktop/notes.txt' }])
    expect(fake.calls.some(([name]) => name === 'clearChat')).toBe(false)
    // The sent message names the file by its place there; it is no path to read here, and not a picture to fetch.
    const shown = useBotsStore.getState().chats['n_laptop:b_inbox']!.messages.at(-1)!
    expect(shown.attachments).toEqual([{ name: 'notes.txt', path: '', remote: 'attachments/2026-11-08/notes.txt' }])
    expect(fake.calls.some(([name]) => name === 'remoteFile')).toBe(false)
  })

  it('says an SVG can’t be sent when the bot’s computer refuses one, and keeps the words and the file', async () => {
    await open(remote())
    // Refused on the bot's computer: the code arrives with its general wording; the reason says what it was.
    vi.mocked(fake.client.send).mockRejectedValueOnce({ code: 'conflict', message: 'The same identifier was used with different content.', details: { reason: 'svg' } })
    await act(async () => {
      useBotsStore.getState().setAttachments('n_laptop:b_inbox', [{ id: 'f1', file: new File(['<svg/>'], 'drawing.svg', { type: 'image/svg+xml' }) }])
    })
    await type(box()!, 'Here is the drawing')
    await click(button('Send message'))
    await settle()
    expect(host.textContent).toContain('SVG files can’t be sent to another computer.')
    expect(host.textContent).not.toContain('The same identifier was used')
    expect(box()!.value).toBe('Here is the drawing')
    expect(useBotsStore.getState().attachments['n_laptop:b_inbox']?.map((file) => file.file.name)).toEqual(['drawing.svg'])
  })

  it('reads its chat again, alone, when its chat stream opens again', async () => {
    fake.chats.b_desk = [message(1)]
    await open(remote())
    await act(async () => useBotsStore.getState().loadChat('b_desk'))
    fake.calls.length = 0
    fake.chats['n_laptop:b_inbox'] = [...fake.chats['n_laptop:b_inbox']!, message(2, { text: 'Sent while the stream was shut.' })]
    await act(async () => fake.emit.reread('n_laptop:b_inbox'))
    await settle()
    expect(fake.calls.filter(([name]) => name === 'messages').map(([, botId]) => botId)).toEqual(['n_laptop:b_inbox'])
    expect(transcript().textContent).toContain('Sent while the stream was shut.')
  })
})

describe('its reply as it is written', () => {
  beforeEach(() => { act(() => setAnimationSpeed('off')) })
  afterEach(() => { act(() => setAnimationSpeed('normal')) })
  const frame = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  const live = () => transcript().querySelector('.bot-live-reply .bot-turn-reply')

  it('streams in like a local bot\'s, never moves its row, and goes once its message is posted', async () => {
    const writing = remote({ state: 'working', stateText: 'Working…', chat: { activationId: 'act1' } })
    await open(writing, [message(1, { id: 'o1', author: 'owner', text: 'Sort the inbox.' })])
    const before = rows().map((element) => element.getAttribute('aria-label'))
    await act(async () => fake.emit.reply({ botId: 'n_laptop:b_inbox', messageId: 'r1', role: 'assistant', text: 'Three invoices are ', added: false }))
    await frame()
    expect(live()?.textContent).toBe('Three invoices are')
    await act(async () => fake.emit.reply({ botId: 'n_laptop:b_inbox', messageId: 'r1', role: 'assistant', text: 'Three invoices are overdue.\n\n', added: false }))
    await frame()
    expect(live()?.textContent).toBe('Three invoices are overdue.')
    // The row says what the bot does, never its words as they come, and keeps its place.
    expect(row('Inbox helper').textContent).not.toContain('Three invoices')
    expect(rows().map((element) => element.getAttribute('aria-label'))).toEqual(before)
    // Another bot's reply never shows here.
    await act(async () => fake.emit.reply({ botId: 'n_other:b_x', messageId: 'r9', role: 'assistant', text: 'Not mine.', added: false }))
    await frame()
    expect(transcript().textContent).not.toContain('Not mine.')
    // Its message posted: the live words go, and the message shows once.
    await act(async () => fake.emit.message('n_laptop:b_inbox', message(2, { id: 'b2', text: 'Three invoices are overdue.', activationId: 'act1' })))
    await frame()
    expect(live()).toBeNull()
    expect(transcript().textContent!.split('Three invoices are overdue.').length - 1).toBe(1)
  })

  it('leaves when the turn takes a step', async () => {
    await open(remote({ state: 'working', chat: { activationId: 'act1' } }), [message(1, { id: 'o1', author: 'owner', text: 'Sort it.' })])
    await act(async () => fake.emit.reply({ botId: 'n_laptop:b_inbox', messageId: 'r1', role: 'assistant', text: 'Looking now. ', added: false }))
    await frame()
    expect(live()).not.toBeNull()
    await act(async () => fake.emit.reply({ botId: 'n_laptop:b_inbox', messageId: 's1', role: 'assistant', kind: 'tool_call', added: true }))
    await frame()
    expect(live()).toBeNull()
  })
})

describe('a bot whose computer is offline', () => {
  it('opens read only from the copy: one line in the composer\'s place, no typing, no answers', async () => {
    const question = message(2, { id: 'qb', text: 'Which one?\n\nA · B', plainFrom: 'Which one?'.length, question: { questionId: 'q_1', choices: [{ label: 'A' }, { label: 'B' }], other: false, status: 'open' } })
    await open(away({ state: 'working', chat: { activationId: 'act1' }, unread: 1 }), [message(0, { id: 'o0', author: 'owner', text: 'Any invoices?' }), message(1, { text: 'Three new invoices.' }), question])
    expect(transcript().textContent).toContain('Three new invoices.')
    expect(box()).toBeNull()
    // Nothing can be sent, so no message, the owner's included, offers a reply.
    expect([...transcript().querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent)).not.toContain('Reply')
    expect(host.querySelector('.bot-away-note')?.textContent).toBe('Laptop is offline')
    expect(transcript().querySelector('.bot-typing, .bot-turn-typing')).toBeNull()
    expect(transcript().querySelector('.bot-question-replies')).toBeNull()
    expect(host.querySelector('.bot-header-who [role="status"]')?.textContent).toBe('Offline')
    expect(fake.calls.some(([name]) => name === 'markRead')).toBe(false)
  })

  it('reads its chat again and marks it read once its computer is back', async () => {
    await open(away({ unread: 1 }), [message(1), message(2, { text: 'Kept from before.' })])
    fake.chats['n_laptop:b_inbox'] = [...fake.chats['n_laptop:b_inbox']!, message(3, { text: 'Came while it was away.' })]
    fake.bots = [local, remote({ unread: 1 })]
    fake.calls.length = 0
    await act(async () => fake.emit.remote())
    await settle()
    expect(fake.calls).toContainEqual(['messages', 'n_laptop:b_inbox', { limit: 50 }])
    expect(transcript().textContent).toContain('Came while it was away.')
    expect(fake.calls).toContainEqual(['markRead', 'n_laptop:b_inbox', 3])
    expect(box()).not.toBeNull()
  })
})

describe('its applets', () => {
  const reference = { appletId: 'ap1', revisionId: 'rev1', sourceHash: 'h1', title: 'Chart', description: '' }
  /** A reply showing Chart, as another computer sends it: its words, then the plain line an app without applets reads. */
  const withApplet = message(1, { text: 'Here is the chart.\n\n_Applet: Chart. It opens on the computer._', plainFrom: 'Here is the chart.'.length, applets: [{ reference }] })
  /** The window's applet bridge: each mount answers `mounted`, and the page's events reach the card. */
  const applets = (mounted: { readOnly?: true } = {}) => {
    let listener: ((event: { runtimeId: string; type: string; text?: string }) => void) | undefined
    const api = {
      mount: vi.fn(async () => ({ runtimeId: 'rt1', src: 'mousse-applet://page', ...mounted })),
      visible: vi.fn(async () => undefined),
      unmount: vi.fn(async () => undefined),
      appearance: vi.fn(async () => undefined),
      onEvent: (callback: typeof listener) => { listener = callback; return () => { listener = undefined } }
    }
    installPreload(fake, { applets: api })
    window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never
    // jsdom has no IntersectionObserver: every card is on screen.
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe() { this.callback([{ isIntersecting: true }]) }
      disconnect() {}
    }
    return { api, send: (event: { runtimeId: string; type: string; text?: string }) => listener?.(event) }
  }

  it('runs here, read through the bot by its message, and what it adds goes to that bot’s composer', async () => {
    const { api, send } = applets()
    await open(remote(), [withApplet])
    await settle()
    // Drawn under its words, which stop before the plain line.
    expect(transcript().querySelector('.bot-message-applets .mousse-applet')?.getAttribute('aria-label')).toBe('Applet: Chart')
    expect(transcript().textContent).not.toContain('It opens on the computer')
    expect(api.mount).toHaveBeenCalledWith(expect.objectContaining({ appletId: 'ap1', revisionId: 'rev1', sourceHash: 'h1', bot: { botId: 'n_laptop:b_inbox', messageId: 'm1' } }))
    expect(host.querySelector('.mousse-applet-note')).toBeNull()

    await act(async () => send({ runtimeId: 'rt1', type: 'conversation-input', text: 'Make rent bigger' }))
    await click(button('Add to conversation draft'))
    expect(useBotsStore.getState().drafts['n_laptop:b_inbox']).toBe('From applet "Chart":\nMake rent bigger')
  })

  it('while its computer is offline, shows from the copy here, saying nothing it changes is saved', async () => {
    const { api } = applets({ readOnly: true })
    await open(away(), [withApplet])
    await settle()
    expect(api.mount).toHaveBeenCalledWith(expect.objectContaining({ bot: { botId: 'n_laptop:b_inbox', messageId: 'm1' } }))
    expect(transcript().querySelector('.mousse-applet-note')?.textContent).toBe('Laptop is offline · changes here aren’t saved')
  })

  it('offers no repair for an applet shown from the copy here, though its computer is listed as reachable', async () => {
    const { send } = applets({ readOnly: true })
    await open(remote(), [withApplet])
    await settle()
    await act(async () => send({ runtimeId: 'rt1', type: 'error', message: 'Applet stopped.' } as never))
    expect(transcript().querySelector('.mousse-applet-error')?.textContent).toContain('Applet stopped.')
    expect(button('Ask the assistant to fix this', transcript())).toBeUndefined()
  })
})

describe('what stays on its own computer', () => {
  it('draws no automation or watcher it set up there, so nothing here pauses, opens or reads one', async () => {
    const cards: BotChatCard[] = [
      { type: 'automation', jobId: 'job-1', name: 'Inbox digest', label: 'every hour' },
      { type: 'facts', title: 'Inbox', rows: [{ label: 'Unread', value: '3' }] } as BotChatCard
    ]
    const pause = vi.fn(async () => undefined)
    const resume = vi.fn(async () => undefined)
    installPreload(fake, { scheduled: { pause, resume } })
    await open(remote(), [message(1, { id: 'c1', text: `Set up.\n\n${plainCards(cards)}`, plainFrom: 'Set up.'.length, cards })])
    expect(transcript().querySelector('[data-testid="bot-automation-card"]')).toBeNull()
    expect(button('Pause', transcript())).toBeUndefined()
    expect([...transcript().querySelectorAll('button')].some((element) => element.getAttribute('aria-label')?.startsWith('Open automation'))).toBe(false)
    expect(transcript().querySelector('dl')?.textContent).toContain('Unread')
    expect(fake.calls.some(([name]) => name === 'get')).toBe(false)
    expect(pause).not.toHaveBeenCalled()
  })

  const failedTurn = (text: string) => [
    message(1, { id: 'o1', author: 'owner', text, activationId: 'a1', attachments: [{ name: 'log.txt', path: 'attachments/2026-11-08/log.txt' }, { name: 'passwd', path: '/etc/passwd' }] }),
    message(2, { id: 'e1', kind: 'error', text: 'I hit an error, so I stopped.', error: { text: 'I hit an error, so I stopped.' }, activationId: 'a1' })
  ]

  it('retries a failed turn with its files, each read here from its place there, and never a full path it names', async () => {
    await open(remote(), failedTurn('Read the log.'))
    await act(async () => useBotsStore.getState().retry('n_laptop:b_inbox', 'e1'))
    expect(fake.calls).toContainEqual(['remoteFile', 'n_laptop:b_inbox', 'attachments/2026-11-08/log.txt'])
    const sent = fake.calls.find(([name]) => name === 'send')!
    expect(sent[2]).toBe('Read the log.')
    expect(sent[4]).toEqual([{ name: 'log.txt', path: '/home/me/.mousse/bots/remote-files/log.txt' }])
  })

  it('retries a failed turn of files alone', async () => {
    await open(remote(), failedTurn(''))
    await act(async () => useBotsStore.getState().retry('n_laptop:b_inbox', 'e1'))
    const sent = fake.calls.find(([name]) => name === 'send')!
    expect(sent[2]).toBe('')
    expect(sent[4]).toEqual([{ name: 'log.txt', path: '/home/me/.mousse/bots/remote-files/log.txt' }])
  })

  it('shows its pictures from their copies here, read as they come, and nothing from a full path of that computer', async () => {
    await open(remote(), [message(1, { text: 'The chart.', attachments: [{ name: 'chart.png', path: 'images/chart.png' }, { name: 'shot.png', path: '/home/them/shot.png' }] })])
    await settle()
    expect(fake.calls.filter(([name]) => name === 'remoteFile')).toEqual([['remoteFile', 'n_laptop:b_inbox', 'images/chart.png']])
    const files = useBotsStore.getState().chats['n_laptop:b_inbox']!.messages[0]!.attachments
    expect(files).toEqual([
      { name: 'chart.png', path: '/home/me/.mousse/bots/remote-files/chart.png', remote: 'images/chart.png' },
      { name: 'shot.png', path: '' }
    ])
    // A picture the bot posts later is read as it comes.
    await act(async () => fake.emit.message('n_laptop:b_inbox', message(2, { text: 'And the map.', attachments: [{ name: 'map.png', path: 'images/map.png' }] })))
    await settle()
    expect(fake.calls).toContainEqual(['remoteFile', 'n_laptop:b_inbox', 'images/map.png'])
    expect(useBotsStore.getState().chats['n_laptop:b_inbox']!.messages.at(-1)!.attachments![0]!.path).toBe('/home/me/.mousse/bots/remote-files/map.png')
    // Read again as the chat is read again: the computer may have let its copy go since.
    const asked = () => fake.calls.filter(([name, , ref]) => name === 'remoteFile' && ref === 'images/chart.png').length
    const before = asked()
    await act(async () => useBotsStore.getState().loadChat('n_laptop:b_inbox'))
    await settle()
    expect(asked()).toBe(before + 1)
  })

  it('reads no file here for a full path or a file link its reply names, and offers none to open', async () => {
    const readAsset = vi.fn(async () => { throw new Error('not here') })
    const assetStamp = vi.fn(async () => { throw new Error('not here') })
    const openFile = vi.fn(async () => 'file')
    const showInFolder = vi.fn(async () => undefined)
    installPreload(fake, { fs: { readAsset, assetStamp }, localFiles: { open: openFile, showInFolder } })
    await open(remote(), [message(1, { text: 'The chart: ![chart](file:///home/them/chart.png)\n\nThe notes are in /home/them/notes.md' })])
    await settle()
    const read = [...readAsset.mock.calls, ...assetStamp.mock.calls].map((call) => JSON.stringify(call))
    expect(read.filter((call) => call.includes('/home/them'))).toEqual([])
    expect(button('Open notes.md')).toBeUndefined()
    expect(button('Show notes.md in folder')).toBeUndefined()
    expect(transcript().textContent).toContain('notes.md')
    expect(openFile).not.toHaveBeenCalled()
    expect(showInFolder).not.toHaveBeenCalled()
  })

  it('takes no file or chip from this window dropped on its composer', async () => {
    await open(remote())
    await type(box()!, 'See the notes')
    const bridge ={ start: vi.fn(() => new Promise(() => {})), startComposerFile: vi.fn(() => new Promise(() => {})) }
    startDragOut({ preventDefault: () => {} }, { name: 'notes.md', item: { kind: 'path', path: '/home/me/notes.md' } as never, inApp: { kind: 'reference', reference: { kind: 'file', title: 'notes.md', path: '/home/me/notes.md' } } }, bridge as never)
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['x'], 'notes.md')], types: ['Files'], getData: () => '' } })
    await act(async () => { box()!.dispatchEvent(drop) })
    await settle()
    expect(box()!.value).toBe('See the notes')
    expect(useBotsStore.getState().drafts['n_laptop:b_inbox']).toBe('See the notes')
    expect(host.querySelector('.bot-input-area .composer-chip, .bot-input-area [data-chip]')).toBeNull()
  })
})

describe('a bot this computer can no longer reach', () => {
  it('leaves with its copy here, and its open chat closes', async () => {
    await open(remote(), [message(1, { text: 'Three new invoices.' })])
    await act(async () => useBotsStore.getState().setDraft('n_laptop:b_inbox', 'half written'))
    fake.bots = [local]
    await act(async () => useBotsStore.getState().refresh())
    await settle()
    const state = useBotsStore.getState()
    expect(state.bots.map((bot) => bot.id)).toEqual(['b_desk'])
    expect(state.chats['n_laptop:b_inbox']).toBeUndefined()
    expect(state.drafts['n_laptop:b_inbox']).toBeUndefined()
    expect(useChatsStore.getState().activeBotId).toBeNull()
    expect(host.textContent).not.toContain('Three new invoices.')
  })

  it('forgets the copies of its pictures this window kept', async () => {
    const { remoteFilesKeptFor } = await import('../../src/renderer/stores/remoteBotFiles')
    await open(remote(), [message(1, { text: 'The chart.', attachments: [{ name: 'chart.png', path: 'images/chart.png' }] })])
    await settle()
    expect(remoteFilesKeptFor('n_laptop:b_inbox')).toBeGreaterThan(0)
    fake.bots = [local]
    await act(async () => useBotsStore.getState().refresh())
    await settle()
    expect(remoteFilesKeptFor('n_laptop:b_inbox')).toBe(0)
  })
})

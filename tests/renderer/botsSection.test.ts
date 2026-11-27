// @vitest-environment jsdom
/**
 * The Chats tab's Bots section (bot-ui §4.1): Bots where Roster was, + opens New bot, a row per bot (its face, its
 * name and latest time, and what it does now in coloured words; an idle bot's face sleeps), Recent with the direct
 * chats, and sections that fold and stay folded.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSummary } from '../../src/shared/chats'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/chats/ChatResourcesPanel', () => ({ ChatResourcesPanel: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTranscript', () => ({ NetworkTranscript: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkChatActions', () => ({ NetworkChatActions: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTaskPicker', () => ({ NetworkTaskPicker: () => null }))
vi.mock('../../src/renderer/components/chats/ChatBrowserAccess', () => ({ ChatBrowserAccess: () => null }))
vi.mock('../../src/renderer/components/chats/OpenNetworkChatDialog', () => ({ OpenNetworkChatDialog: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
// The composer's microphone pulls in audio worklets jsdom does not have; these tests never record.
vi.mock('../../src/renderer/dictation/microphone', () => ({}))
vi.mock('../../src/renderer/components/editors/MarkdownPreview', async () => {
  const { createElement: h } = await import('react')
  return { MarkdownPreview: ({ value, className }: { value: string; className?: string }) => h('div', { className }, value) }
})

const { ChatsSidebar } = await import('../../src/renderer/components/chats/ChatsSidebar')
const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
// App mounts New bot apart from the chat pane (older code kept it inside the pane).
const NewBotDialogHost = ((await import('../../src/renderer/components/bots/NewBotDialog')) as { NewBotDialogHost?: () => null }).NewBotDialogHost ?? (() => null)
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { setBotChecklistHidden } = await import('../../src/renderer/components/bots/botChecklistSetting')

let root: Root
let host: HTMLElement
let fake: FakeBots
const chatsInitial = useChatsStore.getInitialState()
const foldedInitial = useAppStore.getState().chatsSidebarCollapsed
const botsInitial = useBotsStore.getInitialState()

const direct = (id: string, name: string, at: string) => ({
  id, kind: 'direct', name, threadId: `t-${id}`, createdAt: at, updatedAt: at,
  participants: [{ id: 'p1', kind: 'agent', name, definitionId: 'a1' }]
}) as unknown as ChatSummary

async function show(bots = fake.bots, chats: ChatSummary[] = [], pane = true) {
  fake.bots = bots
  await act(async () => {
    useChatsStore.getState().activate('p1')
    useChatsStore.setState({ snapshot: { agents: [], chats, devices: [] } })
  })
  await act(async () => root.render(createElement('div', null, createElement(ChatsSidebar), pane && createElement(ChatWorkspace), createElement(NewBotDialogHost))))
}
const headings = () => [...host.querySelectorAll('.chats-sidebar-content .chat-section-heading h2')].map((element) => element.textContent)
const rows = () => [...host.querySelectorAll<HTMLButtonElement>('.chats-sidebar-content button[aria-label^="Message "]')]
const rowNames = () => rows().map((row) => row.getAttribute('aria-label')!.replace('Message ', ''))
const stateLine = (name: string) => button(`Message ${name}`)!.querySelector('[data-tone]')!
const fold = (title: string) => [...host.querySelectorAll<HTMLButtonElement>('.chat-section-heading h2 button')].find((element) => element.textContent === title)!
const button = (label: string) => [...host.querySelectorAll('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }) }

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
  useAppStore.setState({ chatsSidebarCollapsed: foldedInitial })
})

describe('the Bots section', () => {
  it('stands where Roster was, with a + that opens New bot', async () => {
    await show([])
    expect(headings()).toEqual(['Bots', 'Groups'])
    expect(host.textContent).not.toContain('Roster')
    expect(host.querySelector('[aria-label="Open Automations"]')).toBeNull()
    expect(host.querySelector('.chats-sidebar-content .chat-empty-hint')?.textContent).toBe('No bots yet. Press + to make one.')
    await click(button('New bot'))
    expect(host.querySelector('[role="dialog"] h2')?.textContent).toBe('New bot')
  })

  it('opens New bot from + while the pane shows Projects, as it does after a restart', async () => {
    await show([summary('a', { name: 'Inbox helper' })], [], false)
    await click(button('New bot'))
    expect(host.querySelector('[role="dialog"] h2')?.textContent).toBe('New bot')
  })

  it('shows the empty page with a face and a New bot button when there is nothing yet', async () => {
    await show([])
    const empty = host.querySelector('.chat-workspace-empty')!
    expect(empty.querySelector('h1')?.textContent).toBe('Make your first bot')
    expect(empty.querySelector('.bot-face')).not.toBeNull()
    await click([...empty.querySelectorAll('button')].find((element) => element.textContent === 'New bot'))
    expect(useBotsStore.getState().newBotOpen).toBe(true)
  })

  it('lists a row per bot, the one that spoke last first, each with its face, its latest time and what it does now', async () => {
    await show([
      summary('a', { name: 'Inbox helper', look: { colour: 'blue', accessory: 'crown' }, last: { text: 'Hi', at: '2026-11-07T08:00:00.000Z', author: 'bot' } }),
      summary('b', { name: 'Garden', state: 'working', stateText: 'Working…', work: [{ id: 'w', title: 'Watering plan', status: 'running', startedAt: '2026-11-07T09:30:00.000Z' }], last: { text: 'On it', at: '2026-11-07T10:00:00.000Z', author: 'bot' } }),
      summary('c', { name: 'Mail', state: 'needs_you', stateText: 'Wants to send 2 replies' })
    ])
    expect(rowNames()).toEqual(['Garden', 'Mail', 'Inbox helper'])
    const face = button('Message Inbox helper')!.querySelector('.bot-face')!
    expect(face.getAttribute('width')).toBe('36')
    expect(face.getAttribute('data-colour')).toBe('blue')
    expect(face.getAttribute('data-accessory')).toBe('crown')
    expect(button('Message Garden')!.querySelector('.bot-face')?.getAttribute('data-state')).toBe('working')
    expect(button('Message Garden')!.textContent).toContain('Nov 7')
    // What each does, in words, and its tone: working, waiting on the owner, idle.
    expect([stateLine('Garden'), stateLine('Mail'), stateLine('Inbox helper')].map((line) => [line.textContent, line.getAttribute('data-tone')]))
      .toEqual([['Watering plan', 'working'], ['Wants to send 2 replies', 'needs'], ['Idle', 'idle']])
    expect(host.textContent).not.toContain('No bots yet')
  })

  it('shows an idle bot\'s latest reply in place of Idle, a busy bot what it does, and Idle again with reply previews off', async () => {
    const { setReplyPreviews } = await import('../../src/renderer/lib/replyPreviewSetting')
    // Reply previews are off by default (#1512): turn them on as Settings → Appearance does.
    setReplyPreviews(true)
    await show([
      summary('a', { name: 'Inbox helper', lastReply: 'Sorted 12 emails into Later.' }),
      summary('b', { name: 'Garden', state: 'working', stateText: 'Working…', lastReply: 'Watered the tomatoes.' })
    ])
    expect([stateLine('Inbox helper'), stateLine('Garden')].map((line) => line.textContent)).toEqual(['Sorted 12 emails into Later.', 'Working…'])
    try {
      act(() => setReplyPreviews(false))
      expect(stateLine('Inbox helper').textContent).toBe('Idle')
    } finally {
      act(() => setReplyPreviews(false))
    }
  })

  it('lets an idle bot sleep, at full colour with its z, while a paused bot sleeps faded and a busy one stays awake', async () => {
    await show([summary('a', { name: 'Resting' }), summary('b', { name: 'Off', state: 'paused', stateText: 'Paused' }), summary('c', { name: 'Busy', state: 'working', stateText: 'Working…' })])
    const face = (name: string) => button(`Message ${name}`)!.querySelector<SVGElement>('.bot-face')!
    expect(face('Resting').getAttribute('data-state')).toBe('paused')
    expect(face('Resting').style.opacity).toBe('1')
    const z = (name: string) => face(name).querySelector('text')?.textContent
    expect(z('Resting')).toBe('z')
    expect(face('Off').style.opacity).toBe('0.6')
    expect(z('Off')).toBe('z')
    expect(face('Busy').getAttribute('data-state')).toBe('working')
    expect(z('Busy')).toBeUndefined()
  })

  it('lists each bot once, in the Bots row with its state on hover; Recent has the direct chats only', async () => {
    await show([
      summary('a', { name: 'Inbox helper', state: 'needs_you', stateText: 'Wants to use files on this computer', last: { text: 'Hi', at: '2026-11-07T08:00:00.000Z', author: 'bot' } }),
      summary('b', { name: 'Flight deals', state: 'paused', stateText: 'Paused', last: { text: 'Found one', at: '2026-11-07T10:00:00.000Z', author: 'bot' } })
    ], [direct('c1', 'Reviewer', '2026-11-07T09:00:00.000Z')])
    expect(headings()).toEqual(['Bots', 'Groups', 'Recent'])
    const rows = [...host.querySelectorAll('.chat-recent-section .chat-list-row')]
    expect(rows.map((element) => element.querySelector('.chat-list-name')?.textContent)).toEqual(['Reviewer'])
    expect(host.querySelectorAll('.chats-sidebar-content .bot-face')).toHaveLength(2)
    expect(button('Message Inbox helper')?.title).toBe('Inbox helper: Wants to use files on this computer')
    expect(button('Message Flight deals')?.title).toBe('Flight deals: Paused')
  })

  it('a right-click on a bot opens its menu, which hides its checklist and shows it again', async () => {
    await show([summary('a', { name: 'Inbox helper' })], [], false)
    const menuItems = () => [...document.querySelectorAll('[role="menu"][aria-label="Inbox helper menu"] [role="menuitem"]')].map((item) => item.textContent)
    const rightClick = async () => { await act(async () => { button('Message Inbox helper')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })) }) }
    try {
      await rightClick()
      expect(menuItems()).toEqual(['Hide checklist'])
      await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === 'Hide checklist'))
      expect(menuItems()).toEqual([])
      expect(JSON.parse(localStorage.getItem('mousse-bot-checklist-hidden')!)).toEqual(['a'])
      await rightClick()
      expect(menuItems()).toEqual(['Show checklist'])
    } finally {
      setBotChecklistHidden('a', false)
    }
  })

  it('opens a bot’s chat from its face', async () => {
    fake.chats.a = [message(1, { text: 'Good morning.' })]
    await show([summary('a', { name: 'Inbox helper' })])
    await click(button('Message Inbox helper'))
    expect(useChatsStore.getState()).toMatchObject({ activeBotId: 'a', activeChatId: null })
    expect(host.querySelector('.chat-conversation-header h1')?.textContent).toBe('Inbox helper')
    expect(host.querySelector('.chat-transcript')?.textContent).toContain('Good morning.')
    expect(button('Message Inbox helper')!.getAttribute('aria-current')).toBe('true')
  })

  it('marks the open bot, and counts a bot’s unread messages until its chat opens', async () => {
    fake.chats.a = [message(1, { text: 'Good morning.' })]
    fake.chats.b = [message(1, { text: 'Two emails need a reply.' })]
    await show([summary('a', { name: 'Inbox helper' }), summary('b', { name: 'Garden', unread: 2 })])
    const row = (label: string) => button(`Message ${label}`)!
    const unread = (label: string) => row(label).querySelector('[aria-label$=" unread"]')
    expect(unread('Inbox helper')).toBeNull()
    expect([unread('Garden')?.textContent, unread('Garden')?.getAttribute('aria-label')]).toEqual(['2', '2 unread'])
    expect(rows().filter((element) => element.getAttribute('aria-current') === 'true')).toEqual([])
    await click(row('Inbox helper'))
    expect(row('Inbox helper').getAttribute('aria-current')).toBe('true')
    expect(unread('Garden')).not.toBeNull()
    await click(row('Garden'))
    await act(async () => {})
    expect(row('Garden').getAttribute('aria-current')).toBe('true')
    expect(row('Inbox helper').getAttribute('aria-current')).toBeNull()
    expect(unread('Garden')).toBeNull()
    expect(useBotsStore.getState().bots.find((bot) => bot.id === 'b')?.unread).toBe(0)
    expect(fake.calls).toContainEqual(['markRead', 'b', 1])
  })

  it('follows bots.changed and plays done when a working bot finishes well', async () => {
    await show([summary('a', { name: 'Inbox helper', state: 'working', stateText: 'Working…' })])
    fake.bots = [summary('a', { name: 'Inbox helper', state: 'idle', stateText: 'All done', lastOutcome: 'ok' })]
    await act(async () => { fake.emit.changed('a') })
    await act(async () => {})
    expect(button('Message Inbox helper')!.querySelector('.bot-face')?.getAttribute('data-state')).toBe('happy')
  })
})

describe('folding the sections', () => {
  it('folds a section from its title, each on its own, and keeps it folded when the sidebar comes back', async () => {
    await show([summary('a', { name: 'Inbox helper' })], [direct('c1', 'Reviewer', '2026-11-07T09:00:00.000Z')], false)
    expect([fold('Bots'), fold('Groups'), fold('Recent')].map((element) => element.getAttribute('aria-expanded'))).toEqual(['true', 'true', 'true'])
    await click(fold('Bots'))
    expect(fold('Bots').getAttribute('aria-expanded')).toBe('false')
    // jsdom has no matchMedia, so the fold applies at once (Collapse).
    expect(rowNames()).toEqual([])
    expect(button('New bot')).toBeDefined()
    expect(fold('Groups').getAttribute('aria-expanded')).toBe('true')
    expect(host.textContent).toContain('No groups')
    expect(host.textContent).toContain('Reviewer')
    await click(fold('Recent'))
    expect(host.textContent).not.toContain('Reviewer')
    act(() => root.unmount())
    root = createRoot(host)
    await show(fake.bots, [direct('c1', 'Reviewer', '2026-11-07T09:00:00.000Z')], false)
    expect([fold('Bots'), fold('Groups'), fold('Recent')].map((element) => element.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false'])
    await click(fold('Bots'))
    expect(rowNames()).toEqual(['Inbox helper'])
  })

  it('remembers the folds for each profile, read back when it opens again', async () => {
    const key = (profileId: string) => `mousse-profile-${profileId}-workspace`
    act(() => { useAppStore.getState().activateProfile('fold-a') })
    await show([summary('a', { name: 'Inbox helper' })], [], false)
    await click(fold('Groups'))
    expect((JSON.parse(window.localStorage.getItem(key('fold-a')) ?? '{}') as { chatsSidebarCollapsed?: unknown }).chatsSidebarCollapsed).toEqual({ groups: true })
    // Another profile starts with every section open; coming back reads the first one's folds from storage.
    act(() => { useAppStore.getState().activateProfile('fold-b') })
    expect(fold('Groups').getAttribute('aria-expanded')).toBe('true')
    act(() => { useAppStore.getState().activateProfile('fold-a') })
    expect([fold('Bots'), fold('Groups')].map((element) => element.getAttribute('aria-expanded'))).toEqual(['true', 'false'])
    for (const profileId of ['fold-a', 'fold-b']) window.localStorage.removeItem(key(profileId))
  })
})

describe('after a restart', () => {
  it('lists the bots in the sidebar when the chat pane is not shown', async () => {
    fake.bots = [summary('b1', { name: 'noobesh' })]
    await act(async () => { useChatsStore.getState().activate('p1') })
    // The sidebar comes back on the Chats tab while the pane opens on Projects: the sidebar alone.
    await act(async () => root.render(createElement(ChatsSidebar)))
    await act(async () => {})
    expect(rowNames()).toEqual(['noobesh'])
  })

  it('shares one 30-second fallback poll between the sidebar and the pane, and stops it when both are gone', async () => {
    vi.useFakeTimers()
    try {
      await show([summary('b1', { name: 'noobesh' })])
      const lists = () => fake.calls.filter(([name]) => name === 'list').length
      const before = lists()
      // Every change to a bot is pushed: the poll only covers a missed push.
      await act(async () => { vi.advanceTimersByTime(29_000) })
      expect(lists()).toBe(before)
      await act(async () => { vi.advanceTimersByTime(1000) })
      expect(lists() - before).toBe(1)
      act(() => root.unmount())
      const after = lists()
      await act(async () => { vi.advanceTimersByTime(90_000) })
      expect(lists()).toBe(after)
      root = createRoot(host)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the poll', () => {
  const setVisibility = (state: DocumentVisibilityState) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }
  afterEach(() => { delete (document as { visibilityState?: unknown }).visibilityState })

  it('keeps the bots held when a list brings nothing new, and replaces only a bot that changed', async () => {
    await show([summary('b1', { name: 'noobesh' }), summary('b2')])
    const held = useBotsStore.getState().bots
    const live = useBotsStore.getState().live
    await act(async () => { await useBotsStore.getState().refresh() })
    expect(useBotsStore.getState().bots).toBe(held)
    expect(useBotsStore.getState().live).toBe(live)
    fake.bots = [summary('b1', { name: 'noobesh', state: 'working', stateText: 'Working…' }), summary('b2')]
    await act(async () => { await useBotsStore.getState().refresh() })
    const [first, second] = useBotsStore.getState().bots
    expect(first).not.toBe(held[0])
    expect(first).toMatchObject({ state: 'working' })
    expect(second).toBe(held[1])
  })

  it('skips its ticks while the window is hidden, and lists again as soon as it shows', async () => {
    vi.useFakeTimers()
    try {
      await show([summary('b1', { name: 'noobesh' })])
      const lists = () => fake.calls.filter(([name]) => name === 'list').length
      const before = lists()
      act(() => setVisibility('hidden'))
      await act(async () => { vi.advanceTimersByTime(60_000) })
      expect(lists()).toBe(before)
      await act(async () => setVisibility('visible'))
      expect(lists()).toBe(before + 1)
      await act(async () => { vi.advanceTimersByTime(30_000) })
      expect(lists()).toBe(before + 2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops following the window once no view polls', async () => {
    await show([summary('b1', { name: 'noobesh' })])
    act(() => root.unmount())
    const before = fake.calls.filter(([name]) => name === 'list').length
    await act(async () => setVisibility('visible'))
    expect(fake.calls.filter(([name]) => name === 'list').length).toBe(before)
    root = createRoot(host)
  })
})

it('keeps an open MCP review in needs-you words when its chat opens beside background work', async () => {
  const stateText = 'Waiting for you: Send email · Mail'
  const bot = summary('mail-review', { name: 'Mail helper', state: 'needs_you', needsOwner: true, stateText,
    work: [{ id: 'other-work', title: 'Organising mail', status: 'running', startedAt: '2026-11-07T09:00:00.000Z' }] })
  fake.chats[bot.id] = [message(1, { id: 'bm_action_mail', text: 'Mail · send_email\nPrivate body', action: {
    actionId: 'action_mail', digest: 'shown', title: 'Send email', serverName: 'Mail', args: { to: 'recipient@example.test', body: 'Review this email' }, hasHiddenValues: false, hiddenPaths: [], status: 'open'
  } })]
  await show([bot])
  expect(stateLine(bot.name).textContent).toBe(stateText)
  await click(button(`Message ${bot.name}`))
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.querySelector('[aria-label="Action summary"]')?.textContent).toBe('Send email · Mail')
  expect([...card.querySelectorAll('button')].map(element => element.textContent)).toEqual(['Send', 'Not now'])
  expect(stateLine(bot.name).textContent).toBe(stateText)
  expect(button(`Message ${bot.name}`)?.title).toBe(`${bot.name}: ${stateText}`)
  expect(button(`Message ${bot.name}`)?.textContent).not.toContain('Typing')
  expect(button(`Message ${bot.name}`)?.textContent).not.toContain('send_email')
  expect(card.textContent).not.toContain('send_email')
})

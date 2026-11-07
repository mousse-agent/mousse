// @vitest-environment jsdom
/**
 * The Agents tab's Bots section (bot-ui §4.1): Bots where Roster was, + opens New bot, each bot by
 * its face, and Recent with bot chats and direct chats together, saying each bot's state in words.
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
vi.mock('../../src/renderer/components/editors/MarkdownPreview', async () => {
  const { createElement: h } = await import('react')
  return { MarkdownPreview: ({ value, className }: { value: string; className?: string }) => h('div', { className }, value) }
})

const { ChatsSidebar } = await import('../../src/renderer/components/chats/ChatsSidebar')
const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

let root: Root
let host: HTMLElement
let fake: FakeBots
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

const direct = (id: string, name: string, at: string) => ({
  id, kind: 'direct', name, threadId: `t-${id}`, createdAt: at, updatedAt: at,
  participants: [{ id: 'p1', kind: 'agent', name, definitionId: 'a1' }]
}) as unknown as ChatSummary

async function show(bots = fake.bots, chats: ChatSummary[] = []) {
  fake.bots = bots
  await act(async () => {
    useChatsStore.getState().activate('p1')
    useChatsStore.setState({ snapshot: { agents: [], chats, devices: [] } })
  })
  await act(async () => root.render(createElement('div', null, createElement(ChatsSidebar), createElement(ChatWorkspace))))
}
const headings = () => [...host.querySelectorAll('.chats-sidebar-content .chat-section-heading h2')].map((element) => element.textContent)
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

  it('shows the empty page with a face and a New bot button when there is nothing yet', async () => {
    await show([])
    const empty = host.querySelector('.chat-workspace-empty')!
    expect(empty.querySelector('h1')?.textContent).toBe('Make your first bot')
    expect(empty.querySelector('.bot-face')).not.toBeNull()
    await click([...empty.querySelectorAll('button')].find((element) => element.textContent === 'New bot'))
    expect(useBotsStore.getState().newBotOpen).toBe(true)
  })

  it('lists each bot by its face, at 48 px, with its state in the face', async () => {
    await show([summary('a', { name: 'Inbox helper', look: { colour: 'blue', accessory: 'crown' } }), summary('b', { name: 'Garden', state: 'working', stateText: 'Working…' })])
    const row = [...host.querySelectorAll('.bot-roster button')]
    expect(row.map((element) => element.querySelector('span')?.textContent)).toEqual(['Inbox helper', 'Garden'])
    const face = row[0]!.querySelector('.bot-face')!
    expect(face.getAttribute('width')).toBe('48')
    expect(face.getAttribute('data-colour')).toBe('blue')
    expect(face.getAttribute('data-accessory')).toBe('crown')
    expect(row[1]!.querySelector('.bot-face')?.getAttribute('data-state')).toBe('working')
    expect(host.textContent).not.toContain('No bots yet')
  })

  it('merges bot chats into Recent by their last message, with the state in words', async () => {
    await show([
      summary('a', { name: 'Inbox helper', state: 'needs_you', stateText: 'Wants to read files in ~/Invoices', last: { text: 'Hi', at: '2026-11-07T08:00:00.000Z', author: 'bot' } }),
      summary('b', { name: 'Flight deals', state: 'paused', stateText: 'Paused', last: { text: 'Found one', at: '2026-11-07T10:00:00.000Z', author: 'bot' } })
    ], [direct('c1', 'Reviewer', '2026-11-07T09:00:00.000Z')])
    expect(headings()).toEqual(['Bots', 'Groups', 'Recent'])
    const rows = [...host.querySelectorAll('.chat-recent-section .chat-list-row')]
    expect(rows.map((element) => element.querySelector('.chat-list-name')?.textContent)).toEqual(['Flight deals', 'Reviewer', 'Inbox helper'])
    expect(rows[0]!.querySelector('.chat-list-preview')?.textContent).toBe('Paused')
    expect(rows[2]!.querySelector('.chat-list-preview')?.textContent).toBe('Wants to read files in ~/Invoices')
    expect(rows[2]!.querySelector('.bot-face')?.getAttribute('width')).toBe('40')
  })

  it('opens a bot’s chat from its face, and its chat from Recent', async () => {
    fake.chats.a = [message(1, { text: 'Good morning.' })]
    await show([summary('a', { name: 'Inbox helper' })])
    await click(button('Message Inbox helper'))
    expect(useChatsStore.getState()).toMatchObject({ activeBotId: 'a', activeChatId: null })
    expect(host.querySelector('.chat-conversation-header h1')?.textContent).toBe('Inbox helper')
    expect(host.querySelector('.chat-transcript')?.textContent).toContain('Good morning.')
    expect(host.querySelector('.bot-roster button.bot-roster-active')).not.toBeNull()
    expect(host.querySelector('.chat-recent-section .chat-list-row.active')).not.toBeNull()
  })

  it('finds bots with the chat search', async () => {
    await show([summary('a', { name: 'Inbox helper' }), summary('b', { name: 'Garden' })])
    await act(async () => useChatsStore.setState({ searchOpen: true, search: 'gar' }))
    expect([...host.querySelectorAll('.bot-roster button > span')].map((element) => element.textContent)).toEqual(['Garden'])
  })

  it('follows bots.changed and plays done when a working bot finishes well', async () => {
    await show([summary('a', { name: 'Inbox helper', state: 'working', stateText: 'Working…' })])
    fake.bots = [summary('a', { name: 'Inbox helper', state: 'idle', stateText: 'All done', lastOutcome: 'ok' })]
    await act(async () => { fake.emit.changed('a') })
    await act(async () => {})
    expect(host.querySelector('.bot-roster .bot-face')?.getAttribute('data-state')).toBe('happy')
    expect(host.querySelector('.chat-recent-section .chat-list-preview')?.textContent).toBe('All done')
  })
})

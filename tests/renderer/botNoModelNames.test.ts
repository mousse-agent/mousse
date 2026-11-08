// @vitest-environment jsdom
/**
 * No model anywhere (bot-ui rule 3, Bot Phase 1 §5.6, §8): even when the data behind the bot
 * screens carries catalog model ids and names (and an instance id for a Sign in button), the DOM of
 * the Bots section, New bot, the chat, its menu, About and the dialogs shows none of them.
 */
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotChatMessage, BotSummary } from '../../src/shared/bots/personal/chat'
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
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

interface CatalogModel { id: string; name: string; short?: string; family?: string; routes?: Record<string, { id: string }> }
const catalog = JSON.parse(readFileSync('src/mms/models/models.json', 'utf8')) as { models: CatalogModel[] }
/** Every catalog id, name, short name, route id and family word, plus models outside the catalog and the bot runner's instance id. */
const FORBIDDEN = [...new Set([
  ...catalog.models.flatMap((model) => [model.id, model.name, model.short, model.family, ...Object.values(model.routes ?? {}).map((route) => route.id)]),
  'gpt-5.1-mini', 'grok-4.1', 'claude:bots'
].filter((word): word is string => !!word))]

// Model-bearing internals the daemon never sends, on purpose: the screens must not show any field they don't know.
const leak = { model: 'claude-opus-5-5', selection: { instanceId: 'claude:bots', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }, modelLabel: 'Opus 5.5', depth: 'deep' }
const bot = { ...summary('b1', {
  name: 'Inbox helper', description: 'Tells me which emails need a reply.', state: 'working', stateText: 'Working…',
  error: { text: 'Sign in so I can work.', action: { kind: 'sign_in', label: 'Sign in', instanceId: 'claude:bots' } },
  last: { text: 'First pass done.', at: '2026-11-07T09:00:00.000Z', author: 'bot' }
}), ...leak } as BotSummary
const other = { ...summary('b2', { name: 'Garden', state: 'stuck', stateText: 'Needs you: sign in again' }), ...leak } as BotSummary
const rows: BotChatMessage[] = [
  { ...message(1, { author: 'owner', text: 'Think harder about this.' }), ...leak } as BotChatMessage,
  { ...message(2, { text: 'Okay, I’ll take more time on this.', chips: [{ icon: 'think', text: 'taking more time', ...leak } as never] }), ...leak } as BotChatMessage,
  { ...message(3, { text: 'I need one thing.', ask: { askId: 'k1', title: 'read files in ~/Invoices', note: 'Only this folder.', status: 'open', ...leak } as never }), ...leak } as BotChatMessage,
  { ...message(4, { kind: 'error', text: '', error: { text: 'Paused until 14:00 (your Claude usage limit)', action: { kind: 'sign_in', label: 'Sign in', instanceId: 'claude:bots' } } }), ...leak } as BotChatMessage
]

let root: Root
let host: HTMLElement
let fake: FakeBots
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const click = async (element: Element | undefined) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }
/** The words of `forbidden` found in the DOM, its attributes included. */
const found = () => {
  const html = host.innerHTML.toLowerCase()
  return FORBIDDEN.filter((word) => html.includes(word.toLowerCase()))
}

beforeEach(async () => {
  fake = fakeBots({
    bots: [bot, other],
    chats: { b1: rows },
    details: { b1: { summary: bot, permissions: [{ id: 'fp1', title: 'read files in ~/Invoices', note: '', grantedAt: '2026-11-06T10:00:00.000Z', ...leak } as never], runs: [{ id: 's1', label: 'every weekday · 09:00', kind: 'schedule', ...leak } as never] } }
  })
  fake.live.b1 = { activationId: 'act1', chip: { icon: 'search', text: 'searching the web', ...leak } as never }
  installPreload(fake)
  setBotsClient(fake.client)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement('div', null, createElement(ChatsSidebar), createElement(ChatWorkspace))))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setBotsClient(null)
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
})

describe('no model name on any bot screen', () => {
  it('checks against the whole catalog', () => {
    expect(FORBIDDEN).toEqual(expect.arrayContaining(['claude-opus-5-5', 'Claude Sonnet 5.5', 'Haiku 5.5', 'opus']))
    // And it sees one in an attribute.
    const probe = Object.assign(document.createElement('span'), { title: 'Claude Opus 5.5' })
    host.append(probe)
    expect(found()).toContain('Claude Opus 5.5')
    probe.remove()
  })

  it('is absent from the Bots section, Recent and the empty page', async () => {
    expect(host.querySelector('.bot-roster')).not.toBeNull()
    expect(host.querySelector('.chat-recent-section')).not.toBeNull()
    expect(found()).toEqual([])
  })

  it('is absent from the chat, its status line and its error lines', async () => {
    await act(async () => useChatsStore.getState().openBot('b1'))
    expect(host.querySelectorAll('.chat-transcript article')).toHaveLength(4)
    expect(host.querySelector('.chat-run-status .bot-chip')).not.toBeNull()
    expect(host.querySelector('.bot-error button')?.textContent).toBe('Sign in')
    expect(found()).toEqual([])
  })

  it('is absent while the bot waits for the internet: the sidebar, header and status line say only that', async () => {
    const waiting = { ...bot, stateText: 'Waiting for internet', waiting: 'internet' } as BotSummary
    await act(async () => useBotsStore.setState((state) => ({ bots: state.bots.map((entry) => (entry.id === 'b1' ? waiting : entry)) })))
    await act(async () => useChatsStore.getState().openBot('b1'))
    expect(host.querySelector('.chat-run-status')?.textContent).toBe('Waiting for internet')
    expect(host.querySelector('.chat-conversation-header span')?.textContent).toBe('Waiting for internet')
    expect(host.textContent).toContain('Waiting for internet')
    expect(found()).toEqual([])
  })

  it('is absent from the menu, About and every dialog', async () => {
    await act(async () => useChatsStore.getState().openBot('b1'))
    await click(button('Bot menu'))
    expect(host.querySelector('[role="menu"]')).not.toBeNull()
    expect(found()).toEqual([])
    await click(button('About this bot'))
    expect(host.querySelector('.bot-about-row')).not.toBeNull()
    expect(found()).toEqual([])
    for (const item of ['Rename', 'Change look', 'Delete bot']) {
      await click(button('Bot menu'))
      await click(button(item))
      expect(host.querySelector('[role="dialog"]')).not.toBeNull()
      expect(found()).toEqual([])
      await act(async () => useBotsStore.setState({ dialog: null }))
    }
  })

  it('is absent from New bot', async () => {
    await click(button('New bot'))
    expect(host.querySelector('[role="dialog"] h2')?.textContent).toBe('New bot')
    expect(found()).toEqual([])
  })
})

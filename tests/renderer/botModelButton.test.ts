// @vitest-environment jsdom
/**
 * A bot's model button in its chat header: the logo of the provider it talks on, ringed by the usage left as the
 * service keeps it, following each reading the service pushes, asking for the 5-minute refresh only while it shows a
 * ring, and opening the bot's four model rows.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, summary, type FakeBots } from './fakeBotsClient'
import { clearPrivateBotDrafts } from '../../src/renderer/components/bots/privateBotDrafts'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'
import type { ProviderUsage } from '../../src/shared/providerAuth'

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
const { clearBotLiveReplies } = await import('../../src/renderer/stores/botLiveReplies')

let root: Root
let host: HTMLElement
let fake: FakeBots
let pushed: Array<(event: { usage: ProviderUsage }) => void>
let watchUsage: ReturnType<typeof vi.fn>
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

const SONNET = 'claude-sonnet-5-5'
const providers = [{ id: 'claude', instanceId: 'claude', label: 'Claude', models: [{ id: SONNET, label: 'Sonnet 5.5' }, { id: 'claude-opus-5-5', label: 'Opus 5.5' }] }]
const rows = { talk: { instanceId: 'claude', model: SONNET }, light: null, medium: { instanceId: 'claude', model: SONNET }, hard: { instanceId: 'claude', model: 'claude-opus-5-5' } }
const pooled = (left: number): ProviderUsage => ({
  id: 'claude-subscription', label: 'Claude subscription', status: 'available', windows: [], readAt: new Date().toISOString(),
  accounts: [{ id: 'a', label: 'a', windows: [{ id: 'five_hour', label: '5-hour', remainingPercent: left }] }]
})

const button = () => host.querySelector<HTMLButtonElement>('[data-mousse="chat-header"] .bot-header-model')
const ring = () => button()?.querySelector('svg[data-usage-level]')
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }

async function open(cached: ProviderUsage | undefined) {
  fake = fakeBots()
  fake.client.model = vi.fn(async () => ({ model: SONNET, models: [], computer: 'this_computer', computers: [{ id: 'this_computer', name: 'Desk' }], providers, slots: rows })) as never
  pushed = []
  watchUsage = vi.fn(async () => ({ watched: true }))
  installPreload(fake, { providers: {
    usageSlots: async () => ({ slots: [{ id: 'claude-subscription', label: 'Claude subscription', instanceId: 'claude', ...(cached ? { cached } : {}) }] }),
    watchUsage,
    onUsage: (listener: (event: { usage: ProviderUsage }) => void) => { pushed.push(listener); return () => { pushed = pushed.filter((entry) => entry !== listener) } }
  } })
  setBotsClient(fake.client)
  const bot = summary('pip', { name: 'Pip' })
  fake.bots = [bot]
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(bot.id))
  await settle()
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  setAnimationSpeed('off')
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
  clearPrivateBotDrafts()
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
  setAnimationSpeed('normal')
})

it('rings the provider by the usage the CLI API proxy reports, follows each pushed reading, and asks for the refresh', async () => {
  await open(pooled(72))
  expect(button()?.title).toMatch(/^5-hour.*72% left\n1 of 1 accounts active$/)
  expect(ring()?.getAttribute('data-usage-level')).toBe('plenty')
  expect(watchUsage).toHaveBeenCalledWith('claude-subscription')
  // It sits just before the side-panel button.
  expect(button()?.closest('.bot-model-root')?.nextElementSibling?.getAttribute('aria-label')).toMatch(/side panel/)
  await act(async () => { for (const listener of pushed) listener({ usage: pooled(8) }) })
  expect(button()?.title).toMatch(/8% left/)
  expect(ring()?.getAttribute('data-usage-level')).not.toBe('plenty')
})

it('shows no ring for Claude without the proxy\'s numbers, and asks for no refresh', async () => {
  await open({ id: 'claude-subscription', label: 'Claude subscription', status: 'available', readAt: new Date().toISOString(), windows: [{ id: 'five_hour', label: '5-hour', remainingPercent: 50 }] })
  expect(button()?.title).toBe('No usage info')
  expect(ring()).toBeNull()
  expect(watchUsage).not.toHaveBeenCalled()
})

it('opens the bot\'s four model rows, each on its model', async () => {
  await open(undefined)
  // Nothing kept yet: it asks for a reading, and shows no ring meanwhile.
  expect(watchUsage).toHaveBeenCalledWith('claude-subscription')
  expect(ring()).toBeNull()
  await act(async () => button()!.click())
  const menu = host.querySelector<HTMLElement>('[role="dialog"][aria-label="Pip\'s models"]')!
  expect([...menu.querySelectorAll('.bot-model-row-label')].map((label) => label.textContent)).toEqual(['Talk', 'Light work', 'Medium work', 'Hard work'])
  expect(menu.textContent).toMatch(/Sonnet 5\.5.*Same as.*Sonnet 5\.5.*Opus 5\.5/)
  await act(async () => { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  await settle()
  expect(host.querySelector('[role="dialog"][aria-label="Pip\'s models"]')).toBeNull()
})

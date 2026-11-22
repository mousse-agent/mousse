// @vitest-environment jsdom
/**
 * A bot's checklist in its chat header: a count beside the side-panel button while the bot keeps tasks, the list in a
 * popover on click, updated when the service says the bot changed, and gone when it keeps none.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, summary, type FakeBots } from './fakeBotsClient'
import { clearPrivateBotDrafts } from '../../src/renderer/components/bots/privateBotDrafts'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'
import { setBotChecklistHidden } from '../../src/renderer/components/bots/botChecklistSetting'
import type { BotTaskItem } from '../../src/shared/bots/personal/chat'

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
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

const header = () => host.querySelector<HTMLElement>('.chat-conversation-header')!
const checklistButton = () => header().querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
const popover = () => host.querySelector<HTMLElement>('[role="dialog"][aria-label="Checklist"]')
const rows = () => [...(popover()?.querySelectorAll('li') ?? [])].map((row) => `${row.querySelector('svg')?.getAttribute('aria-label')}: ${row.textContent}`)
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }

const tasks: BotTaskItem[] = [
  { id: 't1', text: 'Find the flat listings', status: 'completed' },
  { id: 't2', text: 'Compare prices', status: 'in_progress', note: 'Three of five read' },
  { id: 't3', text: 'Write the summary', status: 'pending' }
]

async function open(bot = summary('flats', { name: 'Flat finder', tasks })) {
  fake.bots = [bot]
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(bot.id))
  await settle()
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  fake = fakeBots()
  installPreload(fake)
  // The popover's fade is timed in script; with motion off it opens and closes at once.
  setAnimationSpeed('off')
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
  clearPrivateBotDrafts()
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
  setAnimationSpeed('normal')
  setBotChecklistHidden('flats', false)
})

it('shows how far the checklist is beside the side-panel button, and the list on click', async () => {
  await open()
  const control = checklistButton()!
  expect(control.textContent).toBe('1/3')
  expect(control.getAttribute('aria-label')).toBe('Checklist, 1 of 3 done')
  // It sits just before the side-panel button.
  expect(control.closest('.bot-tasks-root')?.nextElementSibling?.getAttribute('aria-label')).toMatch(/side panel/)
  expect(popover()).toBeNull()

  await act(async () => control.click())
  await settle()
  expect(control.getAttribute('aria-expanded')).toBe('true')
  expect(rows()).toEqual(['Done: Find the flat listings', 'In progress: Compare prices', 'To do: Write the summary'])
  // The bot's note is in the tooltip.
  expect(popover()!.querySelectorAll('li')[1]!.getAttribute('title')).toContain('Three of five read')

  await act(async () => { popover()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await settle()
  expect(control.getAttribute('aria-expanded')).toBe('false')
  expect(popover()).toBeNull()
  expect(document.activeElement).toBe(control)
})

it('follows the bot as its tasks change, and shows nothing while it keeps none', async () => {
  await open()
  await act(async () => checklistButton()!.click())
  await settle()

  fake.bots = [summary('flats', { name: 'Flat finder', tasks: tasks.map((task) => ({ ...task, status: 'completed' as const })) })]
  await act(async () => fake.emit.changed('flats'))
  await settle()
  expect(checklistButton()!.textContent).toBe('3/3')
  expect(rows().every((row) => row.startsWith('Done: '))).toBe(true)

  fake.bots = [summary('flats', { name: 'Flat finder' })]
  await act(async () => fake.emit.changed('flats'))
  await settle()
  expect(checklistButton()).toBeNull()
  expect(popover()).toBeNull()
})

it('a click elsewhere closes the list', async () => {
  await open()
  await act(async () => checklistButton()!.click())
  await settle()
  expect(popover()).not.toBeNull()
  await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  await settle()
  expect(popover()).toBeNull()
})

it('the bot menu hides the checklist and shows it again, and the choice is kept for the bot', async () => {
  await open()
  const menuItem = async (label: string) => {
    await act(async () => header().querySelector<HTMLButtonElement>('button[aria-label="Bot menu"]')!.click())
    const item = [...header().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === label)
    expect(item, label).toBeDefined()
    await act(async () => item!.click())
    await settle()
  }

  await menuItem('Hide checklist')
  expect(checklistButton()).toBeNull()
  expect(JSON.parse(localStorage.getItem('mousse-bot-checklist-hidden')!)).toEqual(['flats'])
  // Opening the chat again keeps it hidden.
  act(() => root.unmount())
  root = createRoot(host)
  await open()
  expect(checklistButton()).toBeNull()

  await menuItem('Show checklist')
  expect(checklistButton()!.textContent).toBe('1/3')
  expect(JSON.parse(localStorage.getItem('mousse-bot-checklist-hidden')!)).toEqual([])
})
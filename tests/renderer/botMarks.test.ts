// @vitest-environment jsdom
/**
 * The Bots list's marks, filter and row menu (#2030): pin, mute, hide and marked unread kept on this computer for any
 * bot, this computer's or another's; the filter by computer and state with Hide offline and Show hidden; and a bot's
 * menu while its computer is offline.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotSummary } from '../../src/shared/bots/personal/chat'
import type { BotMarksByRef } from '../../src/shared/bots/personal/marks'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/chats/OpenNetworkChatDialog', () => ({ OpenNetworkChatDialog: () => null }))

const { ChatsSidebar } = await import('../../src/renderer/components/chats/ChatsSidebar')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

let root: Root
let host: HTMLElement
let fake: FakeBots
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

const LAPTOP = { node: 'n_laptop', name: 'Laptop' }
const STUDIO = { node: 'n_studio', name: 'Studio' }
const at = (hour: number) => ({ text: 'Hi', at: `2026-11-07T${String(hour).padStart(2, '0')}:00:00.000Z`, author: 'bot' as const })
const desk = summary('b_desk', { name: 'Desk helper', last: at(9) })
const old = summary('b_old', { name: 'Old helper', last: at(7) })
const worker = summary('b_work', { name: 'Worker', state: 'working', stateText: 'Working…', last: at(8) })
const asker = summary('b_ask', { name: 'Asker', state: 'needs_you', stateText: 'Wants to use files', last: at(6) })
const inbox = (over: Partial<BotSummary> = {}): BotSummary => summary('n_laptop:b_inbox', { name: 'Inbox helper', lives: { ...LAPTOP }, last: at(10), ...over })
const studio = summary('n_studio:b_art', { name: 'Art helper', lives: { ...STUDIO }, last: at(5) })
const offline = (over: Partial<BotSummary> = {}) => inbox({ lives: { ...LAPTOP, offline: true }, ...over })

const names = () => [...host.querySelectorAll<HTMLButtonElement>('.chats-sidebar-content button[aria-label^="Message "]')].map((element) => element.getAttribute('aria-label')!.slice('Message '.length))
const row = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Message ${name}"]`)!
const byLabel = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const click = async (element: Element | undefined | null) => { expect(element).toBeTruthy(); await act(async () => { (element as HTMLElement).click() }); await settle() }
const filterButton = () => byLabel('Filter bots', host)!

async function show(bots: BotSummary[], marks: BotMarksByRef = {}) {
  fake.bots = bots
  fake.marks = structuredClone(marks)
  await act(async () => {
    useChatsStore.getState().activate('p1')
    useChatsStore.setState({ snapshot: { agents: [], chats: [], devices: [] } })
  })
  await act(async () => root.render(createElement(ChatsSidebar)))
  await settle()
}
async function menuOf(name: string) {
  await act(async () => { row(name).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
  return document.querySelector<HTMLElement>(`[role="menu"][aria-label="${name} menu"]`)!
}
const menuItem = (menu: HTMLElement, label: string) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === label)
async function pick(name: string, label: string) { await click(menuItem(await menuOf(name), label)) }
async function filterBy(label: string) {
  await click(filterButton())
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Filter bots"]')!
  await click([...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((item) => item.textContent === label))
  if (document.querySelector('[role="menu"][aria-label="Filter bots"]')) await click(filterButton())
}
const filterOptions = async () => {
  await click(filterButton())
  const options = [...document.querySelectorAll('[role="menu"][aria-label="Filter bots"] [role^="menuitem"]')].map((item) => item.textContent)
  await click(filterButton())
  return options
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  localStorage.clear()
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
  vi.restoreAllMocks()
  setBotsClient(null)
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
  localStorage.clear()
})

describe('reading the marks', () => {
  it('reads nothing at app open, only when the Bots list shows', async () => {
    fake.bots = [desk]
    fake.marks = { b_desk: { pinnedAt: '2026-11-07T11:00:00.000Z' } }
    localStorage.setItem('mousse-profile-p1-bots-filter', JSON.stringify({ computer: 'all', state: 'working', hideOffline: false }))
    await act(async () => useChatsStore.getState().activate('p1'))
    await settle()
    expect(fake.calls.some(([name]) => name === 'marks')).toBe(false)
    expect(useBotsStore.getState().filter.state).toBe('all')
    await act(async () => fake.emit.marks())
    expect(fake.calls.some(([name]) => name === 'marks')).toBe(false)
    await act(async () => root.render(createElement(ChatsSidebar)))
    await settle()
    expect(fake.calls.filter(([name]) => name === 'marks')).toHaveLength(1)
    expect(useBotsStore.getState().marks).toEqual(fake.marks)
    expect(useBotsStore.getState().filter.state).toBe('working')
  })
})

describe('pin', () => {
  it('keeps pinned bots at the top, then the rest by their latest message, and unpins from the row', async () => {
    await show([desk, old, inbox()])
    expect(names()).toEqual(['Inbox helper', 'Desk helper', 'Old helper'])
    await click(byLabel('Pin Old helper', host))
    expect(fake.calls).toContainEqual(['setMark', 'b_old', 'pinned', true])
    expect(names()).toEqual(['Old helper', 'Inbox helper', 'Desk helper'])
    expect(row('Old helper').querySelector('[aria-label="Pinned"]')).not.toBeNull()
    // Pinned bots keep the latest-first order among themselves, and a newer message never lifts an unpinned bot above them.
    await pick('Desk helper', 'Pin')
    expect(names()).toEqual(['Desk helper', 'Old helper', 'Inbox helper'])
    await click(byLabel('Unpin Desk helper', host))
    expect(names()).toEqual(['Old helper', 'Inbox helper', 'Desk helper'])
  })

  it('pins another computer\'s bot from its menu, and reads the marks again when another window changes them', async () => {
    await show([desk, offline()])
    await pick('Inbox helper', 'Pin')
    expect(fake.calls).toContainEqual(['setMark', 'n_laptop:b_inbox', 'pinned', true])
    expect(names()).toEqual(['Inbox helper', 'Desk helper'])
    fake.marks = { b_desk: { pinnedAt: '2026-11-07T11:00:00.000Z' } }
    await act(async () => fake.emit.marks())
    await settle()
    expect(row('Desk helper').querySelector('[aria-label="Pinned"]')).not.toBeNull()
    expect(row('Inbox helper').querySelector('[aria-label="Pinned"]')).toBeNull()
  })

  it('puts a mark back and says why when it can\'t be kept', async () => {
    await show([desk, old])
    vi.mocked(fake.client.setMark).mockRejectedValueOnce(Object.assign(new Error('The disk is full.'), { code: 'internal' }))
    await click(byLabel('Pin Old helper', host))
    expect(names()).toEqual(['Desk helper', 'Old helper'])
    expect(useBotsStore.getState().error).toBe('The disk is full.')
  })
})

describe('hide, mute and marked unread', () => {
  it('takes a hidden bot off the list, and Show hidden brings it back faded with an eye struck through', async () => {
    await show([desk, inbox()])
    await pick('Inbox helper', 'Hide')
    expect(fake.calls).toContainEqual(['setMark', 'n_laptop:b_inbox', 'hidden', true])
    expect(names()).toEqual(['Desk helper'])
    expect(filterButton().hasAttribute('data-set')).toBe(false)
    expect(await filterOptions()).toContain('Show hidden (1)')
    await filterBy('Show hidden (1)')
    expect(names()).toEqual(['Inbox helper', 'Desk helper'])
    expect(row('Inbox helper').getAttribute('data-hidden')).toBe('true')
    expect(row('Inbox helper').querySelector('[aria-label="Hidden"]')).not.toBeNull()
    expect(row('Desk helper').hasAttribute('data-hidden')).toBe(false)
    expect(filterButton().getAttribute('data-set')).toBe('true')
    await pick('Inbox helper', 'Unhide')
    expect(row('Inbox helper').hasAttribute('data-hidden')).toBe(false)
  })

  it('says when every bot is hidden', async () => {
    await show([desk], { b_desk: { hidden: true } })
    expect(names()).toEqual([])
    expect(host.querySelector('.chat-empty-hint')?.textContent).toBe('Every bot is hidden')
  })

  it('shows a muted bot with a bell struck through, and unmutes it', async () => {
    await show([desk, offline()])
    await pick('Inbox helper', 'Mute notifications')
    expect(fake.calls).toContainEqual(['setMark', 'n_laptop:b_inbox', 'muted', true])
    expect(row('Inbox helper').querySelector('[aria-label="Muted"]')).not.toBeNull()
    expect(row('Desk helper').querySelector('[aria-label="Muted"]')).toBeNull()
    await pick('Inbox helper', 'Unmute notifications')
    expect(row('Inbox helper').querySelector('[aria-label="Muted"]')).toBeNull()
  })

  it('shows a dot on a bot marked unread until its chat opens', async () => {
    await show([desk, old])
    await pick('Old helper', 'Mark as unread')
    expect(row('Old helper').querySelector('[aria-label="Marked unread"]')).not.toBeNull()
    expect(menuItem(await menuOf('Old helper'), 'Mark as read')).toBeTruthy()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await act(async () => useChatsStore.getState().openBot('b_old'))
    await settle()
    expect(fake.calls).toContainEqual(['setMark', 'b_old', 'unread', false])
    expect(useBotsStore.getState().marks.b_old).toBeUndefined()
  })

  it('Mark as read clears the mark and reads the chat to its newest message on the bot\'s computer, unopened', async () => {
    fake.chats['n_laptop:b_inbox'] = [message(4), message(7)]
    await show([desk, inbox({ unread: 2 })], { 'n_laptop:b_inbox': { unread: true } })
    expect(row('Inbox helper').querySelector('[aria-label="2 unread"]')).not.toBeNull()
    expect(row('Inbox helper').querySelector('[aria-label="Marked unread"]')).toBeNull()
    await pick('Inbox helper', 'Mark as read')
    expect(fake.calls).toContainEqual(['markRead', 'n_laptop:b_inbox', 7])
    expect(fake.calls).toContainEqual(['setMark', 'n_laptop:b_inbox', 'unread', false])
    expect(row('Inbox helper').querySelector('.bot-row-unread')).toBeNull()
  })
})

describe('the menu of a bot whose computer is offline', () => {
  it('greys Mark as read with the computer offline, and keeps Pin, Mute, Hide and Mark as unread working', async () => {
    await show([desk, offline({ unread: 3 })])
    const menu = await menuOf('Inbox helper')
    const read = menuItem(menu, 'Mark as read')!
    expect(read.getAttribute('aria-disabled')).toBe('true')
    expect(read.getAttribute('title')).toBe('Laptop is offline')
    await click(read)
    expect(fake.calls.some(([name]) => name === 'markRead' || name === 'messages')).toBe(false)
    for (const label of ['Pin', 'Mute notifications', 'Hide']) expect(menuItem(menu, label)?.hasAttribute('aria-disabled')).toBe(false)
    await click(menuItem(menu, 'Mute notifications'))
    expect(fake.calls).toContainEqual(['setMark', 'n_laptop:b_inbox', 'muted', true])
  })

  it('lets a bot only marked unread be cleared while its computer is offline', async () => {
    await show([desk, offline()], { 'n_laptop:b_inbox': { unread: true } })
    const read = menuItem(await menuOf('Inbox helper'), 'Mark as read')!
    expect(read.hasAttribute('aria-disabled')).toBe(false)
    await click(read)
    expect(fake.calls).toContainEqual(['setMark', 'n_laptop:b_inbox', 'unread', false])
    await pick('Inbox helper', 'Mark as unread')
    expect(fake.calls).toContainEqual(['setMark', 'n_laptop:b_inbox', 'unread', true])
  })
})

describe('the filter', () => {
  it('offers the computers only with other computers\' bots, and narrows by each', async () => {
    await show([desk, old])
    expect(await filterOptions()).toEqual(['All bots', 'Needs me', 'Working', 'Show hidden (0)'])
    await act(async () => root.unmount())
    root = createRoot(host)
    await show([desk, inbox(), studio])
    expect(await filterOptions()).toEqual(['All', 'This computer', 'Laptop', 'Studio', 'All bots', 'Needs me', 'Working', 'Hide offline', 'Show hidden (0)'])
    await filterBy('This computer')
    expect(names()).toEqual(['Desk helper'])
    expect(filterButton().getAttribute('data-set')).toBe('true')
    await filterBy('Studio')
    expect(names()).toEqual(['Art helper'])
    await filterBy('All')
    expect(names()).toEqual(['Inbox helper', 'Desk helper', 'Art helper'])
    expect(filterButton().hasAttribute('data-set')).toBe(false)
  })

  it('narrows by state, a bot whose computer is offline counting as neither', async () => {
    await show([desk, worker, asker, offline({ state: 'working', stateText: 'Sorting…' })])
    await filterBy('Working')
    expect(names()).toEqual(['Worker'])
    await filterBy('Needs me')
    expect(names()).toEqual(['Asker'])
    expect(filterButton().getAttribute('data-set')).toBe('true')
  })

  it('leaves out offline bots on request, and combines every axis', async () => {
    await show([desk, worker, offline(), studio, summary('n_studio:b_run', { name: 'Runner', lives: { ...STUDIO }, state: 'working', stateText: 'Working…', last: at(4) })])
    await filterBy('Hide offline')
    expect(names()).toEqual(['Desk helper', 'Worker', 'Art helper', 'Runner'])
    await filterBy('Working')
    expect(names()).toEqual(['Worker', 'Runner'])
    await filterBy('Studio')
    expect(names()).toEqual(['Runner'])
    await filterBy('Laptop')
    expect(names()).toEqual([])
    expect(host.querySelector('.chat-empty-hint')?.textContent).toBe('No bots match the filter')
  })

  it('remembers the filter for the profile, but not Show hidden', async () => {
    await show([desk, worker, inbox()], { b_desk: { hidden: true } })
    await filterBy('Working')
    await filterBy('Show hidden (1)')
    expect(JSON.parse(localStorage.getItem('mousse-profile-p1-bots-filter')!)).toEqual({ computer: 'all', state: 'working', hideOffline: false })
    await act(async () => useBotsStore.getState().activate('p2'))
    expect(useBotsStore.getState().filter).toEqual({ computer: 'all', state: 'all', hideOffline: false, showHidden: false })
    await act(async () => useBotsStore.getState().activate('p1'))
    await settle()
    expect(useBotsStore.getState().filter).toEqual({ computer: 'all', state: 'working', hideOffline: false, showHidden: false })
  })

  it('narrows nothing by a computer whose bots left the list', async () => {
    await show([desk, inbox(), studio])
    await filterBy('Studio')
    fake.bots = [desk, inbox()]
    await act(async () => fake.emit.remote())
    await settle()
    expect(names()).toEqual(['Inbox helper', 'Desk helper'])
    expect(filterButton().hasAttribute('data-set')).toBe(false)
  })
})

describe('a bot that leaves', () => {
  it('drops its marks here when another computer\'s bot leaves the list', async () => {
    await show([desk, inbox()], { 'n_laptop:b_inbox': { pinnedAt: '2026-11-07T11:00:00.000Z', muted: true }, b_desk: { muted: true } })
    expect(Object.keys(useBotsStore.getState().marks).sort()).toEqual(['b_desk', 'n_laptop:b_inbox'])
    fake.bots = [desk]
    await act(async () => fake.emit.remote())
    await settle()
    expect(useBotsStore.getState().marks).toEqual({ b_desk: { muted: true } })
  })
})

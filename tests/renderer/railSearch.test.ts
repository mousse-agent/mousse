// @vitest-environment jsdom
/**
 * Search lives at the top of the navigation rail, not in the title bar. It is one search on every tab: it opens
 * Search everything, which finds threads, bot threads, archived threads, bots, chats and messages.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSummary } from '../../src/shared/chats'
import { fakeBots, installPreload, summary } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))
vi.mock('../../src/renderer/components/WindowCaptionButtons', () => ({ WindowCaptionButtons: () => null }))
vi.mock('../../src/renderer/components/downloads/DownloadsIndicator', () => ({ DownloadsIndicator: () => null }))

const { NavigationRail } = await import('../../src/renderer/components/NavigationRail')
const { CommandPalette } = await import('../../src/renderer/components/CommandPalette')
const { TitleBar } = await import('../../src/renderer/components/TitleBar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

const closed = { scheduledOpen: false, usageOpen: false, settingsOpen: false, paletteOpen: false }
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()
const releaseCrew = {
  id: 'c1', kind: 'group', name: 'Release crew', threadId: 't-c1', createdAt: '2026-11-07T09:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z',
  participants: [], lastMessage: { text: 'Nightly 0.48 is signed.' }
} as unknown as ChatSummary
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  // The bots and chats are only on the daemon: the search reads them as it opens, from any tab.
  const fake = fakeBots({ bots: [summary('b', { name: 'Garden', description: 'Waters the nightly plants.' })] })
  installPreload(fake, {
    storage: { policy: async () => ({}) },
    threads: { search: async () => ({ results: [] }) },
    platformRequest: { request: async (method: string) => (method === 'chats.snapshot' ? { agents: [], chats: [releaseCrew], devices: [] } : null) }
  })
  setBotsClient(fake.client)
  useAppStore.setState({ ...closed, sidebarMode: 'projects', threadsSidebarView: 'threads' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setBotsClient(null)
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
  useAppStore.setState(closed)
})

const render = () => act(() => root.render(createElement('div', null, createElement(NavigationRail), createElement(CommandPalette))))
const railLabels = () => [...host.querySelectorAll('.navigation-rail-button')].map((button) => button.getAttribute('aria-label'))
const click = (label: string) => act(async () => { host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click() })
const type = (text: string) => act(async () => {
  const input = host.querySelector<HTMLInputElement>('.thread-search-input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const groups = () => [...host.querySelectorAll('.thread-search-group')].map((group) =>
  `${group.getAttribute('aria-label')}: ${[...group.querySelectorAll('.thread-search-result-title')].map((title) => title.textContent).join(', ')}`)

describe('search in the navigation rail', () => {
  it('comes right after Home, styled like the others, and the title bar has none', () => {
    render()
    expect(railLabels()).toEqual(['Home', 'Search everything', 'Automations', 'Subscription usage', 'Settings'])
    expect(host.querySelector('[aria-label="Search everything"]')!.getAttribute('title')).toMatch(/^Search everything/)
    const titleBar = renderToStaticMarkup(createElement(TitleBar))
    expect(titleBar).not.toMatch(/aria-label="Search (threads|chats|everything)"/)
    expect(titleBar).toContain('aria-label="New thread"')
  })

  it('is the same search on every tab, over a rail page too', async () => {
    for (const tab of ['projects', 'threads', 'chats'] as const) {
      act(() => useAppStore.setState({ ...closed, threadsSidebarView: tab, usageOpen: true }))
      render()
      await click('Search everything')
      expect(useAppStore.getState(), tab).toMatchObject({ paletteOpen: true, paletteMode: 'messages', usageOpen: true })
      expect(host.querySelector('.thread-search-dialog')!.getAttribute('aria-label'), tab).toBe('Search everything')
      act(() => useAppStore.getState().setPaletteOpen(false))
    }
  })

  it('finds bots and chats from the Threads tab, which never loaded them, and opens a bot in Chats', async () => {
    render()
    await click('Search everything')
    await type('nightly')
    expect(groups()).toEqual(['Bots: Garden', 'Chats: Release crew'])
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.thread-search-result')].find((row) => row.textContent?.includes('Garden'))!.click() })
    await act(async () => {})
    expect(useChatsStore.getState().activeBotId ?? useChatsStore.getState().openingBotId).toBe('b')
    expect(useAppStore.getState().threadsSidebarView).toBe('chats')
  })
})

describe('Home in the navigation rail', () => {
  const home = () => host.querySelector<HTMLButtonElement>('[aria-label="Home"]')!

  it('is active while no rail page is open, and a click there changes nothing', async () => {
    render()
    expect(home().title).toBe('Home')
    expect(home().getAttribute('aria-current')).toBe('page')
    await click('Home')
    expect(useAppStore.getState()).toMatchObject(closed)
    expect(home().getAttribute('aria-current')).toBe('page')
  })

  it('leaves Automations or Usage and becomes the active item', async () => {
    for (const page of ['scheduledOpen', 'usageOpen'] as const) {
      useAppStore.setState({ ...closed, [page]: true })
      render()
      expect(home().hasAttribute('aria-current')).toBe(false)
      await click('Home')
      expect(useAppStore.getState()).toMatchObject({ scheduledOpen: false, usageOpen: false })
      expect(home().getAttribute('aria-current')).toBe('page')
    }
  })
})

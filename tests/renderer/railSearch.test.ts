// @vitest-environment jsdom
/**
 * Search lives at the top of the navigation rail, not in the title bar: in the Projects and Threads tabs it opens
 * the palette with message hits first, and in the Chats tab it opens the chat search in the sidebar.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))
vi.mock('../../src/renderer/components/WindowCaptionButtons', () => ({ WindowCaptionButtons: () => null }))
vi.mock('../../src/renderer/components/downloads/DownloadsIndicator', () => ({ DownloadsIndicator: () => null }))

const { NavigationRail } = await import('../../src/renderer/components/NavigationRail')
const { TitleBar } = await import('../../src/renderer/components/TitleBar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')

const closed = { scheduledOpen: false, usageOpen: false, settingsOpen: false, paletteOpen: false }
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = { storage: { policy: async () => ({}) } }
  useAppStore.setState({ ...closed, sidebarMode: 'projects' })
  useChatsStore.setState({ searchOpen: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = () => act(() => root.render(createElement(NavigationRail)))
const railLabels = () => [...host.querySelectorAll('.navigation-rail-button')].map((button) => button.getAttribute('aria-label'))
const click = (label: string) => act(async () => { host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click() })

describe('search in the navigation rail', () => {
  it('comes right after Home, styled like the others, and the title bar has none', () => {
    render()
    expect(railLabels()).toEqual(['Home', 'Search threads', 'Automations', 'Subscription usage', 'Settings'])
    expect(host.querySelector('[aria-label="Search threads"]')!.getAttribute('title')).toMatch(/^Search threads/)
    const titleBar = renderToStaticMarkup(createElement(TitleBar))
    expect(titleBar).not.toMatch(/aria-label="Search (threads|chats)"/)
    expect(titleBar).toContain('aria-label="New thread"')
  })

  it('opens the palette with message hits first outside the Chats tab, over a rail page too', async () => {
    useAppStore.setState({ usageOpen: true })
    render()
    await click('Search threads')
    expect(useAppStore.getState()).toMatchObject({ paletteOpen: true, paletteMode: 'messages', usageOpen: true })
    expect(useChatsStore.getState().searchOpen).toBe(false)
  })

  it('opens the chat search in the Chats tab, leaving a rail page that covers the sidebar', async () => {
    useAppStore.setState({ sidebarMode: 'chats', scheduledOpen: true })
    render()
    expect(railLabels()[1]).toBe('Search chats')
    await click('Search chats')
    expect(useChatsStore.getState().searchOpen).toBe(true)
    expect(useAppStore.getState()).toMatchObject({ scheduledOpen: false, paletteOpen: false })
  })
})

describe('Home in the navigation rail', () => {
  const home = () => host.querySelector<HTMLButtonElement>('[aria-label="Home"]')!

  it('is active while no rail page is open, and a click there changes nothing', async () => {
    render()
    expect(home().title).toBe('Home')
    expect(home().classList.contains('active')).toBe(true)
    expect(home().getAttribute('aria-current')).toBe('page')
    await click('Home')
    expect(useAppStore.getState()).toMatchObject(closed)
    expect(home().classList.contains('active')).toBe(true)
  })

  it('leaves Automations or Usage and becomes the active item', async () => {
    for (const page of ['scheduledOpen', 'usageOpen'] as const) {
      useAppStore.setState({ ...closed, [page]: true })
      render()
      expect(home().classList.contains('active')).toBe(false)
      expect(home().hasAttribute('aria-current')).toBe(false)
      await click('Home')
      expect(useAppStore.getState()).toMatchObject({ scheduledOpen: false, usageOpen: false })
      expect(home().classList.contains('active')).toBe(true)
    }
  })
})

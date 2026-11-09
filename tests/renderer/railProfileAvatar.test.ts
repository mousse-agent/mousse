// @vitest-environment jsdom
/**
 * While the threads sidebar is closed its profile footer can't be seen, so the rail shows the current profile as a
 * round avatar under Settings. It opens the same profile menu, to the right of the avatar.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))
vi.mock('../../src/renderer/components/downloads/DownloadsIndicator', () => ({ DownloadsIndicator: () => null }))

const { NavigationRail } = await import('../../src/renderer/components/NavigationRail')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { ProfileSwitcher } = await import('../../src/renderer/components/profiles/ProfileSwitcher')
const { paletteColorFor, profileColor } = await import('../../src/renderer/lib/profilePalette')
const { ProfileEditDialog } = await import('../../src/renderer/components/profiles/ProfileEditDialog')

const profiles = [
  { id: 'prf_alpha', displayName: 'Work', status: 'active', isDefault: true, revision: 1, color: '#4d6088' },
  { id: 'prf_beta', displayName: 'Personal', status: 'active', isDefault: false, revision: 1 }
]
let host: HTMLDivElement
let root: Root
let bind: ReturnType<typeof vi.fn>

beforeEach(() => {
  bind = vi.fn(async (ref: string) => ({ profile: profiles.find((profile) => profile.id === ref)! }))
  ;(window as unknown as { mousse: unknown }).mousse = {
    storage: { policy: async () => ({}) },
    profiles: {
      list: async () => ({ profiles, defaultProfileId: 'prf_alpha' }),
      status: async () => ({ binding: { profileId: 'prf_alpha' } }),
      bind
    }
  }
  // The app has activated the window's profile before the rail shows it.
  useAppStore.getState().activateProfile('prf_alpha')
  useAppStore.setState({ scheduledOpen: false, usageOpen: false, settingsOpen: false, profileReady: true, profileId: 'prf_alpha', threadsSidebarOpen: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { mousse?: unknown }).mousse
})

const render = () => act(async () => root.render(createElement(NavigationRail)))
const avatar = () => host.querySelector<HTMLButtonElement>('.profile-rail-trigger')
const slot = () => host.querySelector<HTMLElement>('.navigation-rail-profile')!

describe('the profile avatar on the rail', () => {
  it('is the last rail item while the sidebar is closed, with the profile initial, colour and name', async () => {
    await render()
    const buttons = [...host.querySelectorAll('.navigation-rail-button')]
    expect(buttons.at(-1)).toBe(avatar())
    expect(buttons.at(-2)?.getAttribute('aria-label')).toBe('Settings')
    expect(slot().dataset.shown).toBe('true')
    expect(slot().hasAttribute('inert')).toBe(false)
    expect(avatar()!.title).toBe('Work')
    expect(avatar()!.textContent).toBe('W')
    expect(avatar()!.querySelector<HTMLElement>('.profile-avatar')!.style.background).toBe('rgb(77, 96, 136)')
  })

  it('is hidden and out of reach while the sidebar is open', async () => {
    useAppStore.setState({ threadsSidebarOpen: true })
    await render()
    expect(slot().dataset.shown).toBe('false')
    expect(slot().hasAttribute('inert')).toBe(true)
    expect(slot().getAttribute('aria-hidden')).toBe('true')
  })

  it('opens the profile menu, checks the current profile, and closes on Escape, the avatar or a pick', async () => {
    await render()
    await act(async () => avatar()!.click())
    const menu = document.querySelector<HTMLElement>('.profile-menu.profile-menu-rail')!
    expect(menu.getAttribute('role')).toBe('menu')
    expect(avatar()!.getAttribute('aria-expanded')).toBe('true')
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(rows.map((row) => [row.textContent, row.getAttribute('aria-checked')])).toEqual([['Work', 'true'], ['Personal', 'false']])
    expect(menu.textContent).toContain('New profile')
    // Pinned beside the avatar by its bottom edge.
    expect(menu.style.bottom).not.toBe('')
    expect(menu.style.transformOrigin).toBe('0 100%')

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('.profile-menu')).toBeNull()

    await act(async () => avatar()!.click())
    await act(async () => avatar()!.click())
    expect(document.querySelector('.profile-menu')).toBeNull()

    await act(async () => avatar()!.click())
    await act(async () => document.querySelectorAll<HTMLButtonElement>('.profile-menu [role="menuitemradio"]')[1]!.click())
    expect(bind).toHaveBeenCalledWith('prf_beta')
    expect(document.querySelector('.profile-menu')).toBeNull()
  })

  it('closes its menu when the sidebar opens', async () => {
    await render()
    await act(async () => avatar()!.click())
    expect(document.querySelector('.profile-menu')).not.toBeNull()
    await act(async () => useAppStore.setState({ threadsSidebarOpen: true }))
    expect(document.querySelector('.profile-menu')).toBeNull()
  })

  it('has the same colour as the sidebar footer and its menu dot, also for a profile with no stored colour', async () => {
    useAppStore.setState({ profileId: 'prf_beta' })
    ;(window as unknown as { mousse: { profiles: { status: unknown } } }).mousse.profiles.status = async () => ({ binding: { profileId: 'prf_beta' } })
    await render()
    const footer = document.createElement('div')
    document.body.appendChild(footer)
    const footerRoot = createRoot(footer)
    await act(async () => footerRoot.render(createElement(ProfileSwitcher)))
    const colorOf = (element: Element | null) => (element as HTMLElement).style.background
    const rail = colorOf(avatar()!.querySelector('.profile-avatar'))
    expect(rail).not.toBe('')
    expect(colorOf(footer.querySelector('.profile-sidebar-trigger .profile-avatar'))).toBe(rail)
    await act(async () => avatar()!.click())
    const dot = [...document.querySelectorAll('.profile-menu-item')].find((row) => row.textContent?.includes('Personal'))!.querySelector('.profile-dot')
    expect(colorOf(dot)).toBe(rail)
    const probe = document.createElement('span')
    probe.style.background = paletteColorFor('prf_beta')
    expect(rail).toBe(probe.style.background)
    act(() => footerRoot.unmount())
    footer.remove()
  })

  it('gives a profile one colour on every surface in every theme: rail, footer, menu dot and the colour picker', async () => {
    const css = (color: string) => { const probe = document.createElement('span'); probe.style.background = color; return probe.style.background }
    for (const profile of profiles) {
      for (const theme of ['dark', 'light', 'blacksphere-plus']) {
        document.documentElement.dataset.theme = theme
        useAppStore.setState({ profileId: profile.id })
        ;(window as unknown as { mousse: { profiles: { status: unknown } } }).mousse.profiles.status = async () => ({ binding: { profileId: profile.id } })
        await render()
        const footer = document.createElement('div')
        document.body.appendChild(footer)
        const footerRoot = createRoot(footer)
        await act(async () => footerRoot.render(createElement(ProfileSwitcher)))
        await act(async () => avatar()!.click())
        const dot = [...document.querySelectorAll('.profile-menu-item')].find((row) => row.textContent?.includes(profile.displayName))!.querySelector<HTMLElement>('.profile-dot')!
        await act(async () => footerRoot.render(createElement(ProfileEditDialog, { mode: { kind: 'edit', profile } as never, onSubmit: () => {}, onClose: () => {} })))
        const swatch = footer.ownerDocument.querySelector<HTMLElement>('.profile-edit-swatch[aria-checked="true"]')!
        const expected = css(profile.color ?? paletteColorFor(profile.id))
        expect(css(profileColor(profile))).toBe(expected)
        expect([
          avatar()!.querySelector<HTMLElement>('.profile-avatar')!.style.background,
          dot.style.background,
          swatch.style.background
        ]).toEqual([expected, expected, expected])
        act(() => footerRoot.unmount())
        footer.remove()
        await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
      }
    }
    delete document.documentElement.dataset.theme
  })
})

// @vitest-environment jsdom
/**
 * The profile footer shows the profile the service has the window on. A switch that reports a failure after the
 * service already moved the window, or a window moved some other way, must not leave the footer on the old profile.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))

const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { ProfileSwitcher } = await import('../../src/renderer/components/profiles/ProfileSwitcher')

const profiles = [
  { id: 'prf_alpha', displayName: 'Work', status: 'active', isDefault: true, revision: 1 },
  { id: 'prf_beta', displayName: 'Personal', status: 'active', isDefault: false, revision: 1 }
]
let host: HTMLDivElement
let root: Root
let bound: string
let bind: ReturnType<typeof vi.fn>

beforeEach(() => {
  bound = 'prf_alpha'
  ;(window as unknown as { mousse: unknown }).mousse = {
    profiles: {
      list: async () => ({ profiles, defaultProfileId: 'prf_alpha' }),
      status: async () => ({ binding: { profileId: bound, epoch: 1 } }),
      bind: (bind = vi.fn())
    }
  }
  useAppStore.getState().activateProfile('prf_alpha')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { mousse?: unknown }).mousse
})

// Mounted as the threads sidebar mounts it.
const render = () => act(async () => root.render(createElement(ProfileSwitcher, {
  onSwitched: (profile) => useAppStore.getState().activateProfile(profile.id)
})))
const shownName = () => host.querySelector('.profile-sidebar-profile')?.textContent
const pick = async (name: string) => {
  await act(async () => host.querySelector<HTMLButtonElement>('.profile-sidebar-trigger')!.click())
  const row = [...document.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')].find((item) => item.textContent?.includes(name))!
  await act(async () => row.click())
}
const alert = () => document.querySelector('.profile-switcher-error')?.textContent

describe('the profile footer follows the window binding', () => {
  it('a switch that fails after the service moved the window ends on the new profile, with no error', async () => {
    bind.mockImplementation(async (id: string) => { bound = id; throw new Error('Request timeout: profiles.bind') })
    await render()
    expect(shownName()).toBe('Work')

    await pick('Personal')
    await vi.waitFor(() => expect(shownName()).toBe('Personal'))
    expect(useAppStore.getState().profileId).toBe('prf_beta')
    expect(alert()).toBeUndefined()

    // From there the person can switch back.
    bind.mockImplementation(async (id: string) => { bound = id; return { profile: profiles.find((item) => item.id === id), epoch: 3 } })
    await pick('Work')
    await vi.waitFor(() => expect(shownName()).toBe('Work'))
  })

  it('a switch that fails without moving the window stays on the old profile and says why', async () => {
    bind.mockRejectedValue(new Error('Profile is not active'))
    await render()
    await pick('Personal')
    await vi.waitFor(() => expect(alert()).toBe('Profile is not active'))
    expect(shownName()).toBe('Work')
    expect(useAppStore.getState().profileId).toBe('prf_alpha')
  })

  it('a window the service has on another profile follows it on the next read', async () => {
    await render()
    expect(shownName()).toBe('Work')
    bound = 'prf_beta'
    await act(async () => window.dispatchEvent(new Event('focus')))
    await vi.waitFor(() => expect(shownName()).toBe('Personal'))
    expect(useAppStore.getState().profileId).toBe('prf_beta')
  })
})

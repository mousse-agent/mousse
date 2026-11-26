// @vitest-environment jsdom
/**
 * The update button when another computer is behind: it shows "1 computer behind" (or "N computers behind") even
 * when this computer is up to date, opens Settings → Devices when that is all it has, adds the count to this
 * computer's own update, and once dismissed stays hidden until a newer release or another computer falls behind.
 * Only online computers count; a phone never does.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../../src/shared/updates'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { DownloadsIndicator } = await import('../../src/renderer/components/downloads/DownloadsIndicator')
const { applyUpdateState, downloadsActions, receiveComputers, resetDownloadsStore, subscribeToDownloads, summarizeDownloads, useDownloadsStore } =
  await import('../../src/renderer/stores/downloadsStore')
const { useUpdateStore } = await import('../../src/renderer/stores/updateStore')
const { useComputersStore, NO_COMPUTERS, COMPUTERS_FIRST_READ_MS } = await import('../../src/renderer/lib/computers')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
type Device = import('../../src/renderer/lib/netDevices').Device

const appState = (patch: Partial<UpdateState> = {}): UpdateState => ({
  phase: 'up-to-date', currentVersion: '0.9.2', channel: 'stable', releaseNotes: [], omittedReleaseCount: 0, ...patch
})
const computer = (node: string, name: string, extra: Partial<Device> = {}): Device => ({
  node: node as Device['node'],
  name,
  caps: [],
  keyEpoch: 1,
  expiresAt: 0,
  kind: 'computer',
  self: false,
  revoked: false,
  state: 'open',
  ...extra
})
const setComputers = (devices: Device[]) => {
  useComputersStore.setState({ loaded: true, routed: true, byNode: {}, devices })
  receiveComputers()
}
const computersRow = () => useDownloadsStore.getState().entries.find((entry) => entry.kind === 'computers')

let root: Root
let host: HTMLElement
beforeEach(() => {
  window.localStorage.clear()
  resetDownloadsStore()
  useUpdateStore.setState(appState(), true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  useComputersStore.setState(NO_COMPUTERS)
})

const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name
  )

describe('the update button and the computers behind this one', () => {
  it('counts only the online computers that are behind, never a phone', () => {
    setComputers([
      computer('a', 'This Mac', { self: true, version: '0.9.2' }),
      computer('b', 'Laptop', { version: '0.9.0', olderThanThis: true }),
      computer('c', 'Desk PC', { version: '0.9.1', olderThanThis: true, state: 'closed' }),
      computer('d', 'Mini', { version: '0.9.3', newerThanThis: true }),
      computer('e', 'Phone', { kind: 'phone', olderThanThis: true }),
      // Paired without saying its version: never behind.
      computer('f', 'Old box')
    ])
    expect(computersRow()).toMatchObject({ label: '1 computer behind', computers: [{ node: 'b', name: 'Laptop', version: '0.9.0' }] })
    setComputers([computer('b', 'Laptop', { olderThanThis: true }), computer('g', 'Server', { olderThanThis: true })])
    expect(computersRow()?.label).toBe('2 computers behind')
    setComputers([computer('d', 'Mini', { newerThanThis: true })])
    expect(computersRow()).toBeUndefined()
  })

  it('counts a computer between this version and the one offered here: behind the version this computer updates to', () => {
    useUpdateStore.setState(appState({ phase: 'available', availableVersion: '0.9.4' }), true)
    setComputers([
      computer('m', 'Mini', { version: '0.9.3', newerThanThis: true }),
      computer('n', 'Studio', { version: '0.9.4' }),
      // Another channel keeps its own updates.
      computer('o', 'Nightly box', { version: '0.9.3-nightly.20261120.1', otherChannel: true })
    ])
    expect(computersRow()).toMatchObject({ label: '1 computer behind', computers: [{ node: 'm', name: 'Mini', version: '0.9.3' }] })
  })

  it('shows while this computer is up to date and opens Settings → Devices', async () => {
    setComputers([computer('b', 'Laptop', { version: '0.9.0', olderThanThis: true })])
    expect(summarizeDownloads(useDownloadsStore.getState().entries)).toMatchObject({ status: 'available', label: '1 computer behind' })
    const opened: string[] = []
    const listen = (event: Event) => opened.push(String((event as CustomEvent).detail))
    window.addEventListener('mousse:settings-section', listen)
    await act(async () => root.render(createElement(DownloadsIndicator, { variant: 'nav' })))
    expect(host.textContent).toContain('1 computer behind')
    await act(async () => button('1 computer behind')!.click())
    window.removeEventListener('mousse:settings-section', listen)
    expect(opened).toEqual(['connections'])
    // Straight there, with no list to open first.
    expect(document.querySelector('.downloads-popover')).toBeNull()
  })

  it('adds the count to this computer’s own update, keeping its flow', () => {
    useUpdateStore.setState(appState({ phase: 'downloaded', availableVersion: '0.9.3' }), true)
    useDownloadsStore.setState({ entries: applyUpdateState([], useUpdateStore.getState()) })
    setComputers([computer('b', 'Laptop', { olderThanThis: true })])
    expect(summarizeDownloads(useDownloadsStore.getState().entries)).toMatchObject({
      status: 'ready',
      label: 'Restart to update · 1 computer behind'
    })
  })

  it('once dismissed, stays hidden until another computer falls behind or a newer release comes out', async () => {
    useUpdateStore.setState(appState({ phase: 'available', availableVersion: '0.9.3' }), true)
    useDownloadsStore.setState({ entries: applyUpdateState([], useUpdateStore.getState()) })
    setComputers([computer('b', 'Laptop', { olderThanThis: true })])
    await act(async () => root.render(createElement(DownloadsIndicator, { variant: 'nav' })))
    // With this computer's update too, the button opens the list, where the computers row has its own Dismiss.
    await act(async () => button('Update available · 1 computer behind')!.click())
    expect(document.querySelector('.downloads-popover')?.textContent).toContain('Laptop')
    const row = [...document.querySelectorAll<HTMLElement>('.downloads-row-item')].find((item) => item.textContent?.includes('1 computer behind'))!
    await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click())
    expect(computersRow()).toBeUndefined()

    // The same computer, read again: still hidden, in a later window too.
    setComputers([computer('b', 'Laptop', { olderThanThis: true })])
    expect(computersRow()).toBeUndefined()
    // Another computer falls behind.
    setComputers([computer('b', 'Laptop', { olderThanThis: true }), computer('g', 'Server', { olderThanThis: true })])
    expect(computersRow()?.label).toBe('2 computers behind')
    downloadsActions.dismiss('computers')
    expect(computersRow()).toBeUndefined()
    // A newer release.
    useUpdateStore.setState(appState({ phase: 'available', availableVersion: '0.9.4' }), true)
    receiveComputers()
    expect(computersRow()?.label).toBe('2 computers behind')
  })

  it('finds the computers already connected when the window opened, after it is idle once the profile is bound, and only the profile’s own', async () => {
    vi.useFakeTimers()
    try {
      // The window opens before its profile is bound.
      useAppStore.setState({ profileId: 'default', profileReady: false })
      // The work profile has a computer behind; the home profile has none.
      const nodes = () => useAppStore.getState().profileId === 'work' ? [computer('b', 'Laptop', { olderThanThis: true })] : []
      const request = vi.fn(async (method: string) =>
        method === 'netEngine.status' ? { on: true } : method === 'bridge.nodes' ? { nodes: nodes() } : { enabled: false }
      )
      ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request } }
      subscribeToDownloads()
      await vi.advanceTimersByTimeAsync(COMPUTERS_FIRST_READ_MS)
      // Nothing is read before the binding, however long it takes.
      expect(request).not.toHaveBeenCalled()
      useAppStore.setState({ profileId: 'work', profileReady: true })
      await vi.advanceTimersByTimeAsync(0)
      // Nor as the bound window opens.
      expect(request).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(COMPUTERS_FIRST_READ_MS)
      expect(computersRow()?.label).toBe('1 computer behind')
      // Another profile: its own list, never the last one's.
      useAppStore.setState({ profileId: 'home' })
      expect(computersRow()).toBeUndefined()
      await vi.advanceTimersByTimeAsync(0)
      expect(request.mock.calls.filter(([method]) => method === 'bridge.nodes')).toHaveLength(2)
      expect(computersRow()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

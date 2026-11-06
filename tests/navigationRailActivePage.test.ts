import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))

import { activeRailPage, escapeLeavesRailPage, leaveRailPage, openRailPage, toggleRailPage } from '../src/renderer/lib/railPages'
import { confirmNavigation } from '../src/renderer/services/navigationGuards'
import { useCommandRegistry } from '../src/renderer/commands/commandRegistry'
import { useAppStore } from '../src/renderer/stores/appStore'

const closed = { scheduledOpen: false, usageOpen: false, settingsOpen: false }

describe('navigation rail active page', () => {
  it('names the open rail page, and none while the workspace shows', () => {
    expect(activeRailPage(closed)).toBeNull()
    expect(activeRailPage({ ...closed, usageOpen: true })).toBe('usage')
    expect(activeRailPage({ ...closed, settingsOpen: true })).toBe('settings')
    expect(activeRailPage({ ...closed, scheduledOpen: true })).toBe('automations')
  })
})

describe('rail pages in the store', () => {
  beforeEach(() => {
    useAppStore.setState({ ...closed, mainAreaOpen: true, sidebarMode: 'projects' })
    useCommandRegistry.setState({ overlays: [] })
    vi.mocked(confirmNavigation).mockClear()
    vi.mocked(confirmNavigation).mockResolvedValue(true)
  })

  it('opening one rail page closes the others', () => {
    const store = useAppStore.getState()
    store.setUsageOpen(true)
    store.setSettingsOpen(true)
    expect(useAppStore.getState()).toMatchObject({ settingsOpen: true, usageOpen: false, scheduledOpen: false })
    store.setUsageOpen(true)
    store.setScheduledOpen(true)
    expect(useAppStore.getState()).toMatchObject({ scheduledOpen: true, usageOpen: false, settingsOpen: false })
    store.setUsageOpen(true)
    expect(useAppStore.getState()).toMatchObject({ usageOpen: true, settingsOpen: false, scheduledOpen: false })
  })

  it('clicking the open page again returns to the workspace and leaves the panel alone', async () => {
    await toggleRailPage('automations')
    expect(useAppStore.getState().scheduledOpen).toBe(true)
    await toggleRailPage('automations')
    expect(useAppStore.getState()).toMatchObject({ ...closed, mainAreaOpen: true, sidebarMode: 'projects' })
  })

  it('stays put when a navigation guard refuses', async () => {
    await openRailPage('usage')
    vi.mocked(confirmNavigation).mockResolvedValue(false)
    await leaveRailPage()
    expect(useAppStore.getState().usageOpen).toBe(true)
    await openRailPage('automations')
    expect(useAppStore.getState()).toMatchObject({ usageOpen: true, scheduledOpen: false })
  })

  it('does not ask the guards to open the page that is already open', async () => {
    await openRailPage('usage')
    vi.mocked(confirmNavigation).mockClear()
    await openRailPage('usage')
    expect(confirmNavigation).not.toHaveBeenCalled()
  })
})

describe('Escape on a rail page', () => {
  const field = { closest: (selector: string) => (selector.includes('input') ? {} : null) }
  const button = { closest: () => null }
  const esc = (over: Partial<Parameters<typeof escapeLeavesRailPage>[0]> = {}) => ({
    key: 'Escape',
    defaultPrevented: false,
    target: button as unknown as EventTarget,
    ...over
  })

  beforeEach(() => useCommandRegistry.setState({ overlays: [] }))

  it('returns from Automations and Usage', () => {
    expect(escapeLeavesRailPage(esc(), { ...closed, scheduledOpen: true })).toBe(true)
    expect(escapeLeavesRailPage(esc(), { ...closed, usageOpen: true })).toBe(true)
  })

  it('leaves the key to whatever else wants it', () => {
    const page = { ...closed, scheduledOpen: true }
    expect(escapeLeavesRailPage(esc(), closed)).toBe(false)
    expect(escapeLeavesRailPage(esc(), { ...closed, settingsOpen: true })).toBe(false)
    expect(escapeLeavesRailPage(esc({ key: 'Enter' }), page)).toBe(false)
    expect(escapeLeavesRailPage(esc({ defaultPrevented: true }), page)).toBe(false)
    expect(escapeLeavesRailPage(esc({ isComposing: true }), page)).toBe(false)
    expect(escapeLeavesRailPage(esc({ target: field as unknown as EventTarget }), page)).toBe(false)
    useCommandRegistry.setState({ overlays: ['palette'] })
    expect(escapeLeavesRailPage(esc(), page)).toBe(false)
  })
})

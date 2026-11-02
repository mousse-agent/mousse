import { beforeEach, describe, expect, it } from 'vitest'
import { activeRailPage } from '../src/renderer/components/NavigationRail'
import { useAppStore } from '../src/renderer/stores/appStore'

const home = {
  scheduledOpen: false,
  usageOpen: false,
  settingsOpen: false,
  threadSearchOpen: false,
  mainAreaOpen: false,
  sidebarMode: 'projects' as const
}

describe('navigation rail active page', () => {
  it('marks Home only when no rail page is open', () => {
    expect(activeRailPage(home)).toBe('home')
    expect(activeRailPage({ ...home, usageOpen: true })).toBe('usage')
    expect(activeRailPage({ ...home, settingsOpen: true })).toBe('settings')
    expect(activeRailPage({ ...home, scheduledOpen: true })).toBe('automations')
    expect(activeRailPage({ ...home, threadSearchOpen: true })).toBeNull()
    expect(activeRailPage({ ...home, mainAreaOpen: true })).toBeNull()
  })
})

describe('rail pages in the store', () => {
  beforeEach(() => {
    useAppStore.setState({ usageOpen: false, settingsOpen: false, scheduledOpen: false })
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
})

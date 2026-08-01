import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../src/renderer/stores/appStore'

function resetBrowserTabs(): void {
  useAppStore.setState({ browserTabs: [], browserActiveTabByThread: {} })
}

afterEach(() => {
  resetBrowserTabs()
})

describe('ensureBrowserTab', () => {
  it('creates a single default tab for a thread', () => {
    const id = useAppStore.getState().ensureBrowserTab('thread-a')
    const { browserTabs } = useAppStore.getState()
    expect(browserTabs).toHaveLength(1)
    expect(browserTabs[0]).toMatchObject({
      id,
      ownerThreadId: 'thread-a',
      url: 'about:blank',
      title: 'New tab'
    })
  })

  it('is idempotent under double-invoke (Strict Mode)', () => {
    const first = useAppStore.getState().ensureBrowserTab('thread-a')
    const second = useAppStore.getState().ensureBrowserTab('thread-a')
    expect(first).toBe(second)
    expect(useAppStore.getState().browserTabs).toHaveLength(1)
  })

  it('does not add a thread tab when a pinned tab already exists', () => {
    const pinned = useAppStore.getState().addBrowserTab(null)
    const ensured = useAppStore.getState().ensureBrowserTab('thread-a')
    expect(ensured).toBe(pinned)
    expect(useAppStore.getState().browserTabs).toHaveLength(1)
    expect(useAppStore.getState().browserTabs[0].ownerThreadId).toBeNull()
  })

  it('keeps separate unpinned tabs for different threads', () => {
    useAppStore.getState().addBrowserTab('thread-a')
    useAppStore.getState().ensureBrowserTab('thread-b')
    const tabs = useAppStore.getState().browserTabs
    expect(tabs).toHaveLength(2)
    expect(tabs.map((tab) => tab.ownerThreadId).sort()).toEqual(['thread-a', 'thread-b'])
  })
})

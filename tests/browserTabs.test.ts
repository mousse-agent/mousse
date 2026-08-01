import { readFileSync } from 'node:fs'
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

describe('browser panel empty toolbar and menu layering', () => {
  const panelSource = readFileSync(
    new URL('../src/renderer/components/BrowserPanel.tsx', import.meta.url),
    'utf8'
  )
  const appStyles = readFileSync(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')

  it('does not auto-seed a tab when the browser pane becomes active', () => {
    expect(panelSource).not.toMatch(/ensureTab\s*\(/)
    expect(panelSource).not.toMatch(/ensureBrowserTab/)
  })

  it('renders the address toolbar only when visible tabs exist', () => {
    expect(panelSource).toMatch(/hasVisibleTabs/)
    expect(panelSource).toMatch(/browser-empty-state/)
    expect(panelSource).toMatch(/hasVisibleTabs\s*\?\s*\([\s\S]*browser-toolbar/)
  })

  it('portals the three-dot menu with fixed floating positioning above the webview', () => {
    expect(panelSource).toMatch(/FloatingPortal/)
    expect(panelSource).toMatch(/useFloatingPosition/)
    expect(panelSource).toMatch(/browser-menu-floating/)
    expect(panelSource).toMatch(/browser-menu-backdrop/)
    expect(panelSource).toMatch(/onPointerDown=\{\(\) => setMenuOpen\(false\)\}/)
    expect(appStyles).toMatch(/\.browser-menu-floating\s*\{[\s\S]*?z-index:\s*var\(--z-floating/)
    expect(appStyles).toMatch(/\.browser-menu-backdrop\s*\{[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*0/)
    expect(appStyles).not.toMatch(/\.browser-panel-menu-open\s+\.browser-webview/)
  })
})

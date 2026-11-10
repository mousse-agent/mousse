// @vitest-environment jsdom
/**
 * Pages and panels that are not on the first paint load as their own chunks (lib/lazySurfaces). They still
 * render where they did, once their chunk arrives, and each one's import resolves to the component it names.
 * A chunk that fails to load shows a retryable state in its place instead of blanking the window.
 */
import { act, Component, createElement, Suspense, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const stub = (testId: string) => () => createElement('div', { 'data-testid': testId })
vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))
vi.mock('../../src/renderer/components/downloads/DownloadsIndicator', () => ({ DownloadsIndicator: () => null }))
vi.mock('../../src/renderer/components/TitleBar', () => ({ TitleBar: () => null }))
vi.mock('../../src/renderer/components/LinuxWindowResizeHandles', () => ({ LinuxWindowResizeHandles: () => null }))
vi.mock('../../src/renderer/components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('../../src/renderer/components/ThreadRenameDialog', () => ({ ThreadRenameDialog: () => null }))
vi.mock('../../src/renderer/components/ui/Toast', () => ({ ToastHost: () => null }))
vi.mock('../../src/renderer/components/ThreadsSidebar', () => ({ ThreadsSidebar: stub('threads-sidebar') }))
vi.mock('../../src/renderer/components/OrchestratorChat', () => ({ OrchestratorChat: stub('conversation') }))
vi.mock('../../src/renderer/components/MainViewTabs', () => ({ MainViewTabs: () => null }))
vi.mock('../../src/renderer/components/sideCard/ThreadSideCard', () => ({ ThreadSideCard: () => null }))
vi.mock('../../src/renderer/components/QuickActionEditor', () => ({ QuickActionEditorHost: () => null }))
vi.mock('../../src/renderer/components/WorkspaceLoading', () => ({ WorkspaceLoading: () => null }))
vi.mock('../../src/renderer/commands/useAppCommands', () => ({ useAppCommands: () => {} }))
vi.mock('../../src/renderer/commands/useCommandShortcuts', () => ({ useCommandShortcuts: () => {} }))
// The split-out surfaces, reached only through their dynamic imports.
vi.mock('../../src/renderer/components/AutomationsPage', () => ({ AutomationsPage: stub('automations-page') }))
vi.mock('../../src/renderer/components/SubscriptionUsagePage', () => ({ SubscriptionUsagePage: stub('usage-page') }))
vi.mock('../../src/renderer/components/chats/ChatWorkspace', () => ({ ChatWorkspace: stub('chats') }))
vi.mock('../../src/renderer/components/bots/NewBotDialog', () => ({ NewBotDialogHost: stub('new-bot') }))
vi.mock('../../src/renderer/components/SettingsPage', () => ({ SettingsPage: stub('settings') }))
// The Files tab handles file links once it has mounted.
const fileLinks = vi.hoisted(() => [] as unknown[])
vi.mock('../../src/renderer/components/FilesPanel', async () => {
  const { createElement: element, useEffect } = await import('react')
  return {
    FilesPanel: () => {
      useEffect(() => {
        const open = (event: Event) => { fileLinks.push((event as CustomEvent).detail) }
        window.addEventListener('mousse:open-file', open)
        return () => window.removeEventListener('mousse:open-file', open)
      }, [])
      return element('div', { 'data-testid': 'files' })
    }
  }
})
vi.mock('../../src/renderer/components/ProjectTerminalPanel', () => ({ ProjectTerminalPanel: stub('terminal') }))
vi.mock('../../src/renderer/components/BrowserPanel', () => ({ BrowserPanel: stub('browser') }))
vi.mock('../../src/renderer/components/changes/ChangesPanel', () => ({ ChangesPanel: stub('changes') }))
vi.mock('../../src/renderer/components/PullRequestPanel', () => ({ PullRequestPanel: stub('pull-request') }))
vi.mock('../../src/renderer/components/DocumentPanel', () => ({ DocumentPanel: stub('documents') }))

/** Every bridge call stays pending and every subscription returns a no-op unsubscribe. */
function pendingBridge(): unknown {
  const pending: Record<string, unknown> & (() => void) = Object.assign(() => {}, {})
  pending.then = () => pending
  pending.catch = () => pending
  pending.finally = () => pending
  const node = (): unknown => new Proxy(() => {}, {
    get: (_target, key) => (key === 'then' ? undefined : node()),
    apply: () => pending
  })
  return node()
}

const { default: App } = await import('../../src/renderer/App')
const { MainViewPanel } = await import('../../src/renderer/components/MainViewPanel')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useBotsStore } = await import('../../src/renderer/stores/botsStore')
const surfaces = await import('../../src/renderer/lib/lazySurfaces')
const { failedChunkUrl, lazyNamed } = await import('../../src/renderer/lib/lazyComponent')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  ;(window as unknown as { mousse: unknown }).mousse = pendingBridge()
  useAppStore.setState({
    profileReady: true,
    workspaceReady: true,
    scheduledOpen: false,
    usageOpen: false,
    settingsOpen: false,
    sidebarMode: 'projects',
    threadsSidebarOpen: true,
    threadsSidebarWidth: 300,
    mainAreaOpen: true,
    mainAreaWidth: 640,
    activeThreadId: 'thread_a',
    mainView: 'git',
    openedSurfaceKinds: ['git'],
    projectTerminalTabs: [],
    browserTabs: [],
    documentTabs: []
  })
  useBotsStore.setState({ newBotOpen: false })
  surfaces.useKeptPanels.setState({ files: false, terminal: false, browser: false })
  fileLinks.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

/** Lets the dynamic imports resolve and Suspense show what they loaded. */
const settle = () => act(async () => { for (let i = 0; i < 10; i += 1) await new Promise((done) => setTimeout(done, 0)) })
const shown = (testId: string) => host.querySelector(`[data-testid="${testId}"]`)
const openFile = (detail: unknown) => window.dispatchEvent(new CustomEvent('mousse:open-file', { detail }))

describe('split-out surfaces', () => {
  it('each resolves to the component it names', async () => {
    const lazy = [surfaces.SettingsPage, surfaces.AutomationsPage, surfaces.SubscriptionUsagePage, surfaces.ChatWorkspace,
      surfaces.NewBotDialogHost, surfaces.FilesPanel, surfaces.ProjectTerminalPanel, surfaces.BrowserPanel,
      surfaces.ChangesPanel, surfaces.PullRequestPanel, surfaces.DocumentPanel]
    for (const component of lazy) {
      const loaded = await component.preload() as Record<string, unknown>
      expect(Object.values(loaded).some((value) => typeof value === 'function')).toBe(true)
    }
  })

  it('the panel area draws its surfaces once loaded, and mounts files, terminal and browser only when needed', async () => {
    act(() => root.render(createElement(MainViewPanel)))
    await settle()
    expect(shown('changes')).not.toBeNull()
    for (const kept of ['files', 'terminal', 'browser']) expect(shown(kept)).toBeNull()
    act(() => useAppStore.setState({ mainView: 'pullRequest', openedSurfaceKinds: ['git', 'pullRequest'] }))
    await settle()
    expect(shown('pull-request')).not.toBeNull()
    expect(shown('changes')).toBeNull()
    // Shown once, the Files tab stays mounted (hidden) while another tab shows.
    act(() => useAppStore.setState({ mainView: 'files', openedSurfaceKinds: ['git', 'pullRequest', 'files'] }))
    await settle()
    expect(shown('files')).not.toBeNull()
    act(() => useAppStore.setState({ mainView: 'git' }))
    await settle()
    expect(shown('files')).not.toBeNull()
    expect(shown('terminal')).toBeNull()
  })

  it('a tab chosen while the panel is closed mounts when the panel opens', async () => {
    useAppStore.setState({ mainAreaOpen: false, mainView: 'files', openedSurfaceKinds: ['files'] })
    act(() => root.render(createElement(MainViewPanel)))
    await settle()
    expect(shown('files')).toBeNull()
    act(() => useAppStore.setState({ mainAreaOpen: true }))
    await settle()
    expect(shown('files')).not.toBeNull()
  })

  it('mounts the browser at once when it has tabs to keep, even hidden', async () => {
    useAppStore.setState({ mainAreaOpen: false })
    useAppStore.getState().addBrowserTab('thread_b')
    act(() => root.render(createElement(MainViewPanel)))
    await settle()
    expect(shown('browser')).not.toBeNull()
    expect(shown('terminal')).toBeNull()
    expect(shown('files')).toBeNull()
  })

  it('keeps file links that arrive before the Files tab has mounted, and hands them over once it listens', async () => {
    act(() => root.render(createElement(MainViewPanel)))
    await settle()
    expect(shown('files')).toBeNull()
    act(() => {
      openFile({ path: 'a.ts' })
      openFile({ path: 'b.ts', line: 3 })
    })
    await settle()
    expect(shown('files')).not.toBeNull()
    expect(fileLinks).toEqual([{ path: 'a.ts' }, { path: 'b.ts', line: 3 }])
    // Later links go straight to the tab, once each.
    act(() => openFile({ path: 'c.ts' }))
    expect(fileLinks).toEqual([{ path: 'a.ts' }, { path: 'b.ts', line: 3 }, { path: 'c.ts' }])
  })

  it('the idle warm-up mounts the kept panels after the first paint', async () => {
    act(() => root.render(createElement(MainViewPanel)))
    await settle()
    expect(shown('files')).toBeNull()
    surfaces.preloadSplitSurfaces()
    await act(async () => {
      for (let i = 0; i < 100 && !(shown('files') && shown('terminal') && shown('browser')); i += 1) {
        await new Promise((done) => setTimeout(done, 60))
      }
    })
    for (const kept of ['files', 'terminal', 'browser']) expect(shown(kept)).not.toBeNull()
  })

  it('mounts the Automations page once the workspace is ready, hidden until opened', async () => {
    useAppStore.setState({ workspaceReady: false })
    act(() => root.render(createElement(App)))
    await settle()
    // Only its hidden shell before then.
    expect(shown('automations-page')).toBeNull()
    expect(host.querySelector<HTMLElement>('.automations-page')?.hidden).toBe(true)
    act(() => useAppStore.setState({ workspaceReady: true }))
    await settle()
    expect(shown('automations-page')).not.toBeNull()
    // It stays mounted after the workspace reloads, so its state survives.
    act(() => useAppStore.setState({ workspaceReady: false }))
    await settle()
    expect(shown('automations-page')).not.toBeNull()
  })

  it('shows the Automations page opened before the workspace is ready', async () => {
    useAppStore.setState({ workspaceReady: false, scheduledOpen: true })
    act(() => root.render(createElement(App)))
    await settle()
    expect(shown('automations-page')).not.toBeNull()
  })

  it('shows Usage, Chats and New bot where they were', async () => {
    act(() => root.render(createElement(App)))
    await settle()
    expect(shown('usage-page')).toBeNull()
    expect(shown('chats')).toBeNull()
    expect(shown('new-bot')).toBeNull()

    act(() => useAppStore.setState({ usageOpen: true }))
    await settle()
    expect(host.querySelector('.usage-rail-page [data-testid="usage-page"]')).not.toBeNull()

    act(() => useAppStore.setState({ usageOpen: false, sidebarMode: 'chats' }))
    await settle()
    await act(async () => { await new Promise((done) => setTimeout(done, 400)) })
    expect(shown('chats')).not.toBeNull()

    act(() => useBotsStore.setState({ newBotOpen: true }))
    await settle()
    expect(shown('new-bot')).not.toBeNull()
  })
})

describe('a chunk that fails to load', () => {
  const page = () => createElement('div', { 'data-testid': 'loaded' }, 'Loaded')
  const failingOnce = () => {
    const state = { attempts: 0 }
    const Page = lazyNamed(async () => {
      state.attempts += 1
      if (state.attempts === 1) throw new TypeError('Failed to fetch dynamically imported module')
      return { Page: page }
    }, 'Page')
    return { state, Page }
  }

  it("shows Couldn't load in its place, and Retry imports it again", async () => {
    const { state, Page } = failingOnce()
    act(() => root.render(createElement('main', null, createElement(Suspense, { fallback: null }, createElement(Page)))))
    await settle()
    // The window is still there; only this part shows the failure.
    expect(host.querySelector('main')).not.toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load. Retry")
    expect(shown('loaded')).toBeNull()
    act(() => { host.querySelector<HTMLButtonElement>('.lazy-load-failed-retry')!.click() })
    await settle()
    expect(state.attempts).toBe(2)
    expect(shown('loaded')).not.toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it("retries the failed chunk under a new URL only when it is one of the window's own files", () => {
    const base = 'file:///C:/app/out/renderer/index.html'
    const failed = (url: string) => new TypeError(`Failed to fetch dynamically imported module: ${url}`)
    expect(failedChunkUrl(failed('file:///C:/app/out/renderer/assets/SettingsPage-X1.js'), base))
      .toBe('file:///C:/app/out/renderer/assets/SettingsPage-X1.js')
    // A retry's own failure names the URL with its query; the chunk is the same.
    expect(failedChunkUrl(failed('file:///C:/app/out/renderer/assets/SettingsPage-X1.js?retry=2'), base))
      .toBe('file:///C:/app/out/renderer/assets/SettingsPage-X1.js')
    expect(failedChunkUrl(failed('https://example.com/assets/evil.js'), base)).toBeUndefined()
    expect(failedChunkUrl(new Error('offline'), base)).toBeUndefined()
    expect(failedChunkUrl('not an error', base)).toBeUndefined()
  })

  it('a chunk that keeps failing is imported once per Retry, not in a loop', async () => {
    let attempts = 0
    const Page = lazyNamed(async (): Promise<{ Page: () => null }> => {
      attempts += 1
      throw new Error('offline')
    }, 'Page')
    act(() => root.render(createElement(Suspense, { fallback: null }, createElement(Page))))
    await settle()
    await settle()
    expect(attempts).toBe(1)
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    act(() => { host.querySelector<HTMLButtonElement>('.lazy-load-failed-retry')!.click() })
    await settle()
    await settle()
    expect(attempts).toBe(2)
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('a later mount after a failed preload imports it again', async () => {
    const { state, Page } = failingOnce()
    await expect(Page.preload()).rejects.toThrow('Failed to fetch')
    act(() => root.render(createElement(Suspense, { fallback: null }, createElement(Page))))
    await settle()
    expect(state.attempts).toBe(2)
    expect(shown('loaded')).not.toBeNull()
  })

  it('lets errors the loaded component throws reach the boundaries above', async () => {
    const Broken = lazyNamed(async () => ({ Broken: (): never => { throw new Error('render bug') } }), 'Broken')
    const caught: unknown[] = []
    class Outer extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false }
      static getDerivedStateFromError() { return { failed: true } }
      componentDidCatch(error: unknown) { caught.push(error) }
      render() { return this.state.failed ? createElement('p', null, 'outer') : this.props.children }
    }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    act(() => root.render(createElement(Outer, null, createElement(Suspense, { fallback: null }, createElement(Broken)))))
    await settle()
    quiet.mockRestore()
    expect(host.textContent).toBe('outer')
    expect(String(caught[0])).toContain('render bug')
  })
})

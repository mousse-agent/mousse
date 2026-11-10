// @vitest-environment jsdom
/**
 * Pages and panels that are not on the first paint load as their own chunks (lib/lazySurfaces). They still
 * render where they did, once their chunk arrives, and each one's import resolves to the component it names.
 */
import { act, createElement } from 'react'
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
vi.mock('../../src/renderer/components/FilesPanel', () => ({ FilesPanel: stub('files') }))
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

  it('the panel area draws its surfaces once loaded, keeping files, terminal and browser mounted', async () => {
    act(() => root.render(createElement(MainViewPanel)))
    await settle()
    expect(shown('changes')).not.toBeNull()
    for (const kept of ['files', 'terminal', 'browser']) expect(shown(kept)).not.toBeNull()
    act(() => useAppStore.setState({ mainView: 'pullRequest', openedSurfaceKinds: ['git', 'pullRequest'] }))
    await settle()
    expect(shown('pull-request')).not.toBeNull()
    expect(shown('changes')).toBeNull()
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

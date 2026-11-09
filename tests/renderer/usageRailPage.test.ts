// @vitest-environment jsdom
/**
 * Usage is a rail page of its own, like Automations: while it is open only the rail and the page show,
 * and leaving it brings back the sidebar and the panel area exactly as they were.
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
vi.mock('../../src/renderer/components/ScheduledPage', () => ({ ScheduledPage: () => null }))
vi.mock('../../src/renderer/components/ThreadsSidebar', () => ({ ThreadsSidebar: stub('threads-sidebar') }))
vi.mock('../../src/renderer/components/OrchestratorChat', () => ({ OrchestratorChat: stub('conversation') }))
vi.mock('../../src/renderer/components/chats/ChatWorkspace', () => ({ ChatWorkspace: stub('chats') }))
vi.mock('../../src/renderer/components/MainViewTabs', () => ({ MainViewTabs: () => null }))
vi.mock('../../src/renderer/components/MainViewPanel', () => ({ MainViewPanel: stub('panel-area') }))
vi.mock('../../src/renderer/components/sideCard/ThreadSideCard', () => ({ ThreadSideCard: () => null }))
vi.mock('../../src/renderer/components/QuickActionEditor', () => ({ QuickActionEditorHost: () => null }))
vi.mock('../../src/renderer/components/WorkspaceLoading', () => ({ WorkspaceLoading: () => null }))
vi.mock('../../src/renderer/components/SubscriptionUsagePage', () => ({
  SubscriptionUsagePage: ({ onClose }: { onClose: () => void }) =>
    createElement('button', { type: 'button', 'data-testid': 'usage-page', onClick: onClose }, 'Back')
}))
vi.mock('../../src/renderer/commands/useAppCommands', () => ({ useAppCommands: () => {} }))
vi.mock('../../src/renderer/commands/useCommandShortcuts', () => ({ useCommandShortcuts: () => {} }))

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
const { useAppStore } = await import('../../src/renderer/stores/appStore')

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
    mainAreaWidth: 640
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const workspace = () => host.querySelector<HTMLElement>('.app-workspace')!
const layout = () => {
  const { threadsSidebarOpen, threadsSidebarWidth, mainAreaOpen, mainAreaWidth } = useAppStore.getState()
  return { threadsSidebarOpen, threadsSidebarWidth, mainAreaOpen, mainAreaWidth }
}
const clickRail = (label: string) => act(async () => { host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click() })

describe('the Usage rail page', () => {
  it('hides the sidebar and panel area while open, keeping them mounted, and restores them on leaving', async () => {
    act(() => root.render(createElement(App)))
    const before = layout()
    expect(workspace().style.display).toBe('flex')

    await clickRail('Subscription usage')
    expect(host.querySelector('[data-testid="usage-page"]')).not.toBeNull()
    // The page sits beside the rail, outside the hidden workspace.
    expect(workspace().contains(host.querySelector('[data-testid="usage-page"]'))).toBe(false)
    expect(workspace().style.display).toBe('none')
    // Hidden, not unmounted: the sidebar and panel area keep their state.
    expect(workspace().querySelector('[data-testid="threads-sidebar"]')).not.toBeNull()
    expect(workspace().querySelector('[data-testid="panel-area"]')).not.toBeNull()

    // The rail item again returns to the workspace as it was.
    await clickRail('Subscription usage')
    expect(host.querySelector('[data-testid="usage-page"]')).toBeNull()
    expect(workspace().style.display).toBe('flex')
    expect(layout()).toEqual(before)

    // Escape and the page's own Back leave it too.
    await clickRail('Subscription usage')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(workspace().style.display).toBe('flex')
    await clickRail('Subscription usage')
    act(() => { host.querySelector<HTMLButtonElement>('[data-testid="usage-page"]')!.click() })
    expect(workspace().style.display).toBe('flex')
    expect(layout()).toEqual(before)
  })

  it('keeps a collapsed sidebar and a closed panel area that way', async () => {
    useAppStore.setState({ threadsSidebarOpen: false, mainAreaOpen: false })
    act(() => root.render(createElement(App)))
    const before = layout()
    await clickRail('Subscription usage')
    expect(workspace().style.display).toBe('none')
    await clickRail('Subscription usage')
    expect(workspace().style.display).toBe('flex')
    expect(layout()).toEqual(before)
  })
})

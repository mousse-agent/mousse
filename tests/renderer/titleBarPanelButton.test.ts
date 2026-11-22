// @vitest-environment jsdom
/**
 * The title bar's "Show panel" button appears only where the window has an app panel to show. Under the Chats tab
 * (a bot's page, a direct chat) the window lays out no panel, so the button is gone and its shortcut does nothing;
 * beside a thread the button opens and closes the panel.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const stub = (testId: string) => () => createElement('div', { 'data-testid': testId })
// The composer's microphone needs audio APIs jsdom lacks; the warm start's composer is in App's own chunk.
vi.mock('../../src/renderer/dictation/microphone', () => ({}))
vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))
vi.mock('../../src/renderer/components/downloads/DownloadsIndicator', () => ({ DownloadsIndicator: () => null }))
vi.mock('../../src/renderer/components/WindowCaptionButtons', () => ({ WindowCaptionButtons: () => null }))
vi.mock('../../src/renderer/components/TitleBarNav', () => ({ TitleBarNav: () => null }))
vi.mock('../../src/renderer/components/LinuxWindowResizeHandles', () => ({ LinuxWindowResizeHandles: () => null }))
vi.mock('../../src/renderer/components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('../../src/renderer/components/ThreadRenameDialog', () => ({ ThreadRenameDialog: () => null }))
vi.mock('../../src/renderer/components/ui/Toast', async (importOriginal) => ({ ...(await importOriginal<object>()), ToastHost: () => null }))
vi.mock('../../src/renderer/components/AutomationsPage', () => ({ AutomationsPage: () => null }))
vi.mock('../../src/renderer/components/ThreadsSidebar', () => ({ ThreadsSidebar: stub('threads-sidebar') }))
vi.mock('../../src/renderer/components/OrchestratorChat', () => ({ OrchestratorChat: stub('conversation') }))
vi.mock('../../src/renderer/components/chats/ChatWorkspace', () => ({ ChatWorkspace: stub('chats') }))
vi.mock('../../src/renderer/components/MainViewTabs', () => ({ MainViewTabs: () => null }))
vi.mock('../../src/renderer/components/MainViewPanel', () => ({
  MainViewPanel: ({ open }: { open: boolean }) => createElement('div', { 'data-testid': 'panel-area', 'data-open': String(open) })
}))
vi.mock('../../src/renderer/components/sideCard/ThreadSideCard', () => ({ ThreadSideCard: () => null }))
vi.mock('../../src/renderer/components/QuickActionEditor', () => ({ QuickActionEditorHost: () => null }))
vi.mock('../../src/renderer/components/WorkspaceLoading', () => ({ WorkspaceLoading: () => null }))
vi.mock('../../src/renderer/commands/useCommandShortcuts', () => ({ useCommandShortcuts: () => {} }))

/** Every bridge call stays pending. */
function bridge(): unknown {
  const pending: Record<string, unknown> & (() => void) = Object.assign(() => {}, {})
  pending.then = () => pending
  pending.catch = () => pending
  pending.finally = () => pending
  const node = (): unknown => new Proxy(() => {}, {
    get: (_target, key) => key === 'then' ? undefined : node(),
    apply: () => pending
  })
  return node()
}

const { default: App } = await import('../../src/renderer/App')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { runCommand } = await import('../../src/renderer/commands/commandRegistry')
const { setAnimationSpeed } = await import('../../src/renderer/lib/motion')

let host: HTMLDivElement
let root: Root

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const panelButton = () => host.querySelector<HTMLButtonElement>('header.titlebar button[aria-label="Show panel"], header.titlebar button[aria-label="Hide panel"]')
const panelOpen = () => host.querySelector('[data-testid="panel-area"]')?.getAttribute('data-open') === 'true'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  ;(window as unknown as { mousse: unknown }).mousse = bridge()
  useAppStore.setState({ profileReady: true, workspaceReady: true, threadsSidebarView: 'threads', sidebarMode: 'projects', threads: [], activeThreadId: null, mainAreaOpen: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useChatsStore.setState({ activeBotId: null })
  setAnimationSpeed('normal')
  vi.unstubAllGlobals()
})

describe('the title bar panel button', () => {
  it('opens and closes the panel beside a thread', async () => {
    act(() => root.render(createElement(App)))
    await settle()
    expect(panelOpen()).toBe(false)
    act(() => panelButton()!.click())
    await settle()
    expect(panelOpen()).toBe(true)
    expect(panelButton()!.getAttribute('aria-label')).toBe('Hide panel')
    // Closing, the panel stays laid out while it slides out; with motion off it goes at once.
    setAnimationSpeed('off')
    act(() => panelButton()!.click())
    await settle()
    expect(panelOpen()).toBe(false)
  })

  it('is not offered on a bot page, where there is no panel, and its shortcut changes nothing', async () => {
    useAppStore.getState().setThreadsSidebarView('chats')
    useChatsStore.setState({ activeBotId: 'bot-1' })
    act(() => root.render(createElement(App)))
    await settle()
    expect(host.querySelector('[data-testid="chats"]')).not.toBeNull()
    expect(panelButton()).toBeNull()
    act(() => { runCommand('mainArea.toggle', 'key') })
    await settle()
    expect(useAppStore.getState().mainAreaOpen).toBe(false)
  })
})

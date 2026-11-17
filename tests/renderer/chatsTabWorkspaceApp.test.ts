// @vitest-environment jsdom
/**
 * The window beside the sidebar's Chats tab shows Chats, not a thread, when the main process selects a thread on its
 * own (the thread restored at launch, or the echo of a selection); a notification that opens a thread moves the
 * sidebar off Chats so the thread shows beside its list.
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
vi.mock('../../src/renderer/components/ui/Toast', async (importOriginal) => ({ ...(await importOriginal<object>()), ToastHost: () => null }))
vi.mock('../../src/renderer/components/AutomationsPage', () => ({ AutomationsPage: () => null }))
vi.mock('../../src/renderer/components/ThreadsSidebar', () => ({ ThreadsSidebar: stub('threads-sidebar') }))
vi.mock('../../src/renderer/components/OrchestratorChat', () => ({ OrchestratorChat: stub('conversation') }))
vi.mock('../../src/renderer/components/chats/ChatWorkspace', () => ({ ChatWorkspace: stub('chats') }))
vi.mock('../../src/renderer/components/MainViewTabs', () => ({ MainViewTabs: () => null }))
vi.mock('../../src/renderer/components/MainViewPanel', () => ({ MainViewPanel: stub('panel-area') }))
vi.mock('../../src/renderer/components/sideCard/ThreadSideCard', () => ({ ThreadSideCard: () => null }))
vi.mock('../../src/renderer/components/QuickActionEditor', () => ({ QuickActionEditorHost: () => null }))
vi.mock('../../src/renderer/components/WorkspaceLoading', () => ({ WorkspaceLoading: () => null }))
vi.mock('../../src/renderer/commands/useAppCommands', () => ({ useAppCommands: () => {} }))
vi.mock('../../src/renderer/commands/useCommandShortcuts', () => ({ useCommandShortcuts: () => {} }))

/** Every bridge call stays pending, except the main process's selection and "open thread" events, which the test drives. */
let selected: ((payload: { id: string }) => void) | undefined
let openThread: ((threadId: string) => void) | undefined
function bridge(): unknown {
  const pending: Record<string, unknown> & (() => void) = Object.assign(() => {}, {})
  pending.then = () => pending
  pending.catch = () => pending
  pending.finally = () => pending
  const node = (path: string): unknown => new Proxy(() => {}, {
    get: (_target, key) => {
      if (key === 'then') return undefined
      if (path === 'threads' && key === 'onSelected') return (listener: typeof selected) => { selected = listener; return () => { selected = undefined } }
      if (path === 'app' && key === 'onOpenThread') return (listener: typeof openThread) => { openThread = listener; return () => { openThread = undefined } }
      if (path === 'threads' && key === 'select') return async () => undefined
      return node(String(key))
    },
    apply: () => pending
  })
  return node('')
}

const { default: App } = await import('../../src/renderer/App')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

let host: HTMLDivElement
let root: Root

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const shown = (testId: string) => Boolean(host.querySelector(`[data-testid="${testId}"]`))
/** The thread's conversation pane (it stays mounted under Chats, hidden). */
const conversationShown = () => { const pane = host.querySelector<HTMLElement>('aside.sidebar'); return Boolean(pane && pane.style.display !== 'none') }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  ;(window as unknown as { mousse: unknown }).mousse = bridge()
  useAppStore.setState({ profileReady: true, workspaceReady: true, threadsSidebarView: 'threads', threads: [], activeThreadId: null })
  // The window opens on the Chats tab, as it was left.
  useAppStore.getState().setThreadsSidebarView('chats')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('the window under the Chats tab', () => {
  it('keeps showing Chats when the main process selects the thread it restores at launch', async () => {
    act(() => root.render(createElement(App)))
    await settle()
    expect(shown('chats')).toBe(true)
    act(() => selected!({ id: 't-restored' }))
    await settle()
    expect(useAppStore.getState()).toMatchObject({ activeThreadId: 't-restored', threadsSidebarView: 'chats', sidebarMode: 'chats' })
    expect(shown('chats')).toBe(true)
    expect(conversationShown()).toBe(false)
  })

  it('leaves Chats for the Threads tab when a notification opens a thread', async () => {
    act(() => root.render(createElement(App)))
    await settle()
    act(() => openThread!('t-notified'))
    await settle()
    expect(useAppStore.getState()).toMatchObject({ activeThreadId: 't-notified', threadsSidebarView: 'threads', sidebarMode: 'projects' })
    expect(conversationShown()).toBe(true)
    expect(shown('chats')).toBe(false)
  })
})

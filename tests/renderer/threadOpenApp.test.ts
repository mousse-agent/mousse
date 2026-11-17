// @vitest-environment jsdom
/**
 * Opening a started thread that the window has no transcript for, through the window's own handlers: the sidebar's
 * select, the main process's echo of it, then the thread's view. The chat never shows the thread without its
 * messages.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))
vi.mock('../../src/renderer/components/downloads/DownloadsIndicator', () => ({ DownloadsIndicator: () => null }))
vi.mock('../../src/renderer/components/TitleBar', () => ({ TitleBar: () => null }))
vi.mock('../../src/renderer/components/LinuxWindowResizeHandles', () => ({ LinuxWindowResizeHandles: () => null }))
vi.mock('../../src/renderer/components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('../../src/renderer/components/ThreadRenameDialog', () => ({ ThreadRenameDialog: () => null }))
vi.mock('../../src/renderer/components/ui/Toast', async (importOriginal) => ({ ...(await importOriginal<object>()), ToastHost: () => null }))
vi.mock('../../src/renderer/components/AutomationsPage', () => ({ AutomationsPage: () => null }))
vi.mock('../../src/renderer/components/ThreadsSidebar', () => ({ ThreadsSidebar: () => null }))
vi.mock('../../src/renderer/components/chats/ChatWorkspace', () => ({ ChatWorkspace: () => null }))
vi.mock('../../src/renderer/components/MainViewTabs', () => ({ MainViewTabs: () => null }))
vi.mock('../../src/renderer/components/MainViewPanel', () => ({ MainViewPanel: () => null }))
vi.mock('../../src/renderer/components/sideCard/ThreadSideCard', () => ({ ThreadSideCard: () => null }))
vi.mock('../../src/renderer/components/QuickActionEditor', () => ({ QuickActionEditorHost: () => null }))
vi.mock('../../src/renderer/components/WorkspaceLoading', () => ({ WorkspaceLoading: () => null }))
vi.mock('../../src/renderer/commands/useAppCommands', () => ({ useAppCommands: () => {} }))
vi.mock('../../src/renderer/commands/useCommandShortcuts', () => ({ useCommandShortcuts: () => {} }))
// The chat shows the selected thread and its messages' ids, as the store hands them to it.
vi.mock('../../src/renderer/components/OrchestratorChat', async () => {
  const { useAppStore: store } = await import('../../src/renderer/stores/appStore')
  return {
    OrchestratorChat: () => {
      const thread = store((s) => s.activeThreadId)
      const messages = store((s) => s.messages)
      return createElement('div', { 'data-shown-thread': thread ?? '', 'data-shown-messages': messages.map((entry) => entry.id).join(' ') })
    }
  }
})

/** Every bridge call stays pending, except the select and the main process's events, which the test drives. */
const listeners: {
  selected?: (payload: { id: string }) => void
  view?: (view: unknown) => void
  message?: (payload: { threadId: string; message: unknown }) => void
} = {}
function bridge(): unknown {
  const pending: Record<string, unknown> & (() => void) = Object.assign(() => {}, {})
  pending.then = () => pending
  pending.catch = () => pending
  pending.finally = () => pending
  const node = (path: string): unknown => new Proxy(() => {}, {
    get: (_target, key) => {
      if (key === 'then') return undefined
      if (path === 'threads' && key === 'onSelected') return (listener: typeof listeners.selected) => { listeners.selected = listener; return () => undefined }
      if (path === 'threads' && key === 'onView') return (listener: typeof listeners.view) => { listeners.view = listener; return () => undefined }
      if (path === 'orchestrator' && key === 'onThreadMessage') return (listener: typeof listeners.message) => { listeners.message = listener; return () => undefined }
      if (path === 'threads' && key === 'select') return async () => undefined
      return node(String(key))
    },
    apply: () => pending
  })
  return node('')
}

const { default: App } = await import('../../src/renderer/App')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { selectThread } = await import('../../src/renderer/lib/threadActions')

let host: HTMLDivElement
let root: Root
/** The thread and messages the chat showed after each change of the page. */
let frames: Array<{ thread: string; messages: string }>
let observer: MutationObserver

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
function shown(): { thread: string; messages: string } {
  const chat = host.querySelector<HTMLElement>('[data-shown-thread]')
  return { thread: chat?.dataset.shownThread ?? '', messages: chat?.dataset.shownMessages ?? '' }
}

const now = new Date().toISOString()
const started = (id: string) => ({ id, name: id, createdAt: now, updatedAt: now, startedAt: now, order: 0 })
const message = (id: string) => ({ id, role: 'user', content: id, timestamp: now })

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  ;(window as unknown as { mousse: unknown }).mousse = bridge()
  useAppStore.setState({
    profileReady: true, workspaceReady: true, threadsSidebarView: 'threads',
    // The store's transcript cache lives for the whole file: each case opens a thread no earlier case showed.
    threads: [started('t-shown'), started('t-opened'), started('t-live')] as never,
    activeThreadId: 't-shown',
    messages: [message('shown-1')] as never
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  frames = []
  observer = new MutationObserver(() => frames.push(shown()))
  observer.observe(host, { subtree: true, childList: true, attributes: true })
})
afterEach(() => {
  observer.disconnect()
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('opening a thread the window has no transcript for', () => {
  it('shows the thread with its messages when its view arrives, and never without them', async () => {
    act(() => root.render(createElement(App)))
    await settle()
    // The window's profile never binds here (the bridge stays pending): show its workspace as a bound one would.
    act(() => useAppStore.setState({ workspaceReady: true }))
    expect(shown()).toEqual({ thread: 't-shown', messages: 'shown-1' })

    await act(async () => { void selectThread('t-opened') })
    act(() => listeners.selected!({ id: 't-opened' }))
    await settle()
    expect(shown()).toEqual({ thread: 't-shown', messages: 'shown-1' })

    act(() => listeners.view!({ threadId: 't-opened', messages: [message('opened-1')], agents: [], tasks: [] }))
    await settle()
    expect(shown()).toEqual({ thread: 't-opened', messages: 'opened-1' })
    expect(frames.filter((frame) => frame.thread === 't-opened' && frame.messages !== 'opened-1')).toEqual([])
  })

  it('keeps a message that arrives before the view, which the service read before it was sent', async () => {
    act(() => root.render(createElement(App)))
    await settle()
    act(() => useAppStore.setState({ workspaceReady: true }))

    await act(async () => { void selectThread('t-live') })
    act(() => listeners.message!({ threadId: 't-live', message: { ...message('live-2'), timestamp: new Date(Date.now() + 1000).toISOString() } }))
    expect(shown()).toEqual({ thread: 't-shown', messages: 'shown-1' })
    act(() => listeners.view!({ threadId: 't-live', messages: [message('live-1')], agents: [], tasks: [] }))
    await settle()
    expect(shown()).toEqual({ thread: 't-live', messages: 'live-1 live-2' })
  })
})

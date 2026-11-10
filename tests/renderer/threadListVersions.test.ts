// @vitest-environment jsdom
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
vi.mock('../../src/renderer/components/AutomationsPage', () => ({ AutomationsPage: () => null }))
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


/** Every bridge call stays pending, except the thread list subscription, which the test drives. */
let pushList: ((threads: unknown[], version?: { epoch: string; seq: number; generation?: number }) => void) | undefined
let pushTouches: ((touches: Array<{ id: string; updatedAt: string }>) => void) | undefined
/** The window's own list read (the fallback, on focus); a test answers it when it wants to. */
let readList: (() => Promise<unknown>) | undefined
function bridge(): unknown {
  const pending: Record<string, unknown> & (() => void) = Object.assign(() => {}, {})
  pending.then = () => pending
  pending.catch = () => pending
  pending.finally = () => pending
  const node = (path: string): unknown => new Proxy(() => {}, {
    get: (_target, key) => {
      if (key === 'then') return undefined
      if (path === 'threads' && key === 'onUpdated') return (listener: typeof pushList) => { pushList = listener; return () => { pushList = undefined } }
      if (path === 'threads' && key === 'onTouched') return (listener: typeof pushTouches) => { pushTouches = listener; return () => { pushTouches = undefined } }
      if (path === 'threads' && key === 'listAllVersioned' && readList) return readList
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

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  ;(window as unknown as { mousse: unknown }).mousse = bridge()
  useAppStore.setState({ profileReady: true, workspaceReady: true, sidebarMode: 'projects', threads: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  readList = undefined
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const row = (id: string, name: string) => ({ id, name, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', startedAt: '2026-11-10T00:00:00Z', order: 0 })
const names = () => useAppStore.getState().threads.map((thread) => thread.name)

describe('the thread list a window holds', () => {
  it('keeps a newer list when an older snapshot arrives after it, as the startup list can', async () => {
    act(() => root.render(createElement(App)))
    expect(pushList).toBeTypeOf('function')
    // A thread was renamed while the window was still loading its projects: that push arrives first.
    act(() => pushList!([row('a', 'Renamed')], { epoch: 'service-1', seq: 7 }))
    expect(names()).toEqual(['Renamed'])
    // The startup list was taken before the rename and lands afterwards: it is dropped.
    act(() => pushList!([row('a', 'Old name')], { epoch: 'service-1', seq: 5 }))
    expect(names()).toEqual(['Renamed'])
    // A newer one applies.
    act(() => pushList!([row('a', 'Renamed'), row('b', 'New')], { epoch: 'service-1', seq: 9 }))
    expect(names()).toEqual(['Renamed', 'New'])
  })

  // Review repro: A40, then the restarted service's B1, then a late A39 from the retired one.
  it("drops a late list of a retired service once a newer service's list was taken", async () => {
    act(() => root.render(createElement(App)))
    act(() => pushList!([row('a', 'Old service, last list')], { epoch: 'A', seq: 40, generation: 1 }))
    act(() => pushList!([row('a', 'New service')], { epoch: 'B', seq: 1, generation: 2 }))
    expect(names()).toEqual(['New service'])
    act(() => pushList!([row('a', 'Old service, late list')], { epoch: 'A', seq: 39, generation: 1 }))
    expect(names()).toEqual(['New service'])
    // The new service's own next list applies.
    act(() => pushList!([row('a', 'New service, later')], { epoch: 'B', seq: 2, generation: 2 }))
    expect(names()).toEqual(['New service, later'])
  })

  it('orders a routed call reply like a push: an older one is dropped, a newer one applies', async () => {
    act(() => root.render(createElement(App)))
    // The push for a local rename arrives first; the reply to a routed call, read before it, lands after.
    act(() => pushList!([row('a', 'Local rename'), row('n:b', 'Remote')], { epoch: 'A', seq: 7, generation: 1 }))
    act(() => pushList!([row('a', 'Before the rename'), row('n:b', 'Remote')], { epoch: 'A', seq: 5, generation: 1 }))
    expect(names()).toEqual(['Local rename', 'Remote'])
    act(() => pushList!([row('a', 'Local rename'), row('n:b', 'Remote renamed')], { epoch: 'A', seq: 9, generation: 1 }))
    expect(names()).toEqual(['Local rename', 'Remote renamed'])
  })

  // Review repro: a fallback read answers with time T1, a save pushes T2 as a touch, then the read's list lands.
  it("keeps a row's newer time when a list read before a touch lands after it", async () => {
    const t1 = '2026-11-10T10:00:00.000Z'
    const t2 = '2026-11-10T10:05:00.000Z'
    let answer!: (list: unknown) => void
    readList = () => new Promise((resolve) => { answer = resolve })
    act(() => root.render(createElement(App)))
    act(() => pushList!([{ ...row('a', 'A'), updatedAt: t1 }, row('b', 'B')], { epoch: 'A', seq: 4, generation: 1 }))
    // The window regains focus and reads its list; the service answers with what it had then.
    act(() => { window.dispatchEvent(new Event('focus')) })
    // A save moves the thread's time before that answer arrives.
    act(() => pushTouches!([{ id: 'a', updatedAt: t2 }]))
    expect(useAppStore.getState().threads.find((entry) => entry.id === 'a')?.updatedAt).toBe(t2)
    await act(async () => { answer({ threads: [{ ...row('a', 'A'), updatedAt: t1 }, row('b', 'B'), row('c', 'C')], version: { epoch: 'A', seq: 4, generation: 1 } }) })
    const threads = useAppStore.getState().threads
    expect(threads.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(threads.find((entry) => entry.id === 'a')?.updatedAt).toBe(t2)
    // A pushed list taken before the touch keeps the newer time too; a later time in a list still applies.
    act(() => pushList!([{ ...row('a', 'A'), updatedAt: t1 }, row('b', 'B'), row('c', 'C')], { epoch: 'A', seq: 5, generation: 1 }))
    expect(useAppStore.getState().threads.find((entry) => entry.id === 'a')?.updatedAt).toBe(t2)
    act(() => pushList!([{ ...row('a', 'A'), updatedAt: '2026-11-10T10:09:00.000Z' }], { epoch: 'A', seq: 6, generation: 1 }))
    expect(useAppStore.getState().threads.map((entry) => [entry.id, entry.updatedAt])).toEqual([['a', '2026-11-10T10:09:00.000Z']])
  })

  it("takes a restarted service's lists, and a list with no version, as they come", async () => {
    act(() => root.render(createElement(App)))
    act(() => pushList!([row('a', 'Before restart')], { epoch: 'service-1', seq: 40 }))
    act(() => pushList!([row('a', 'After restart')], { epoch: 'service-2', seq: 1 }))
    expect(names()).toEqual(['After restart'])
    act(() => pushList!([row('a', 'From another computer')]))
    expect(names()).toEqual(['From another computer'])
  })
})

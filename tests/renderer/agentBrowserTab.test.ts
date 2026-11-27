// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../../src/renderer/components/BrowserPanel'
import { MainViewPanel } from '../../src/renderer/components/MainViewPanel'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { BrowserAccessState } from '../../src/shared/browser/access'
import type { InAppBrowserState } from '../../src/shared/browser/inApp'

vi.mock('../../src/renderer/components/FilesPanel', () => ({ FilesPanel: () => null }))
vi.mock('../../src/renderer/components/ProjectTerminalPanel', () => ({ ProjectTerminalPanel: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const profileId = 'profile_a'
let root: Root
let host: HTMLElement
let access: BrowserAccessState
let emit: (state: InAppBrowserState) => void

beforeEach(() => {
  // Group-chat consent is off: a thread agent's tab never waits on it.
  access = { allowed: false, pending: [] }
  emit = () => {}
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request: vi.fn(async () => access) },
    inAppBrowser: {
      registerTab: vi.fn(async () => ({ uiTabId: 'ui' })),
      onState: (listener: (state: InAppBrowserState) => void) => { emit = listener; return () => {} }
    }
  }
  useAppStore.setState({
    profileId, activeThreadId: 'thread_a', sidebarMode: 'projects', mainView: 'files', mainAreaOpen: true,
    openedSurfaceKinds: ['files'], browserTabs: [], browserActiveTabByThread: {}, turnStates: {}
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = () => act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve() })
const render = async (component: () => unknown) => { act(() => root.render(createElement(component as never))); await settle() }
const agentState = (uiTabId: string, threadId: string, sessionId = 'sess_1'): InAppBrowserState =>
  ({ profileId, uiTabId, threadId, sessionId, owner: 'agent', lifecycle: 'agent-controlled', generation: 1 })

describe("an agent's browser tab", () => {
  it("is created in the requesting thread and shown when that thread is on screen", async () => {
    access = { ...access, tabRequests: [{ requestId: 'request_1', threadId: 'thread_a' }] }
    await render(() => createElement(BrowserPanel))
    const state = useAppStore.getState()
    expect(state.browserTabs).toHaveLength(1)
    expect(state.browserTabs[0].ownerThreadId).toBe('thread_a')
    expect(state.browserActiveTabByThread.thread_a).toBe(state.browserTabs[0].id)
    expect(state.mainView).toBe('browser')
  })

  it("is created for a background thread without taking over the current view", async () => {
    access = { ...access, tabRequests: [{ requestId: 'request_1', threadId: 'thread_b' }] }
    await render(() => createElement(BrowserPanel))
    const state = useAppStore.getState()
    expect(state.browserTabs.map((tab) => tab.ownerThreadId)).toEqual(['thread_b'])
    expect(state.mainView).toBe('files')
  })

  it('becomes the thread\'s tab and opens the browser once per agent session', async () => {
    const other = useAppStore.getState().addBrowserTab('thread_a')
    const agentTab = useAppStore.getState().addBrowserTab('thread_a')
    useAppStore.getState().setActiveBrowserTab('thread_a', other)
    useAppStore.setState({ mainView: 'files' })
    await render(() => createElement(BrowserPanel))
    act(() => emit(agentState(agentTab, 'thread_a')))
    expect(useAppStore.getState().mainView).toBe('browser')
    expect(useAppStore.getState().browserActiveTabByThread.thread_a).toBe(agentTab)
    // The person moves away; the agent's later navigations in the same session leave that alone.
    act(() => useAppStore.getState().setMainView('files'))
    act(() => emit({ ...agentState(agentTab, 'thread_a'), generation: 2 }))
    expect(useAppStore.getState().mainView).toBe('files')
    act(() => emit(agentState(agentTab, 'thread_a', 'sess_2')))
    expect(useAppStore.getState().mainView).toBe('browser')
  })

  it('opens again when the person returns to a thread whose agent is still working', async () => {
    const agentTab = useAppStore.getState().addBrowserTab('thread_b')
    await render(() => createElement(BrowserPanel))
    act(() => emit(agentState(agentTab, 'thread_b')))
    expect(useAppStore.getState().mainView).toBe('files')
    act(() => useAppStore.setState({ turnStates: { thread_b: { threadId: 'thread_b', phase: 'tool_running' } } as never }))
    act(() => useAppStore.setState({ activeThreadId: 'thread_b' }))
    expect(useAppStore.getState().mainView).toBe('browser')
    expect(useAppStore.getState().browserActiveTabByThread.thread_b).toBe(agentTab)
    // Once the turn has ended, returning to the thread keeps the person's view. Each thread keeps its own panel tab,
    // so the person moves this thread's panel to Files before leaving.
    act(() => useAppStore.getState().setMainView('files'))
    act(() => useAppStore.setState({ activeThreadId: 'thread_a' }))
    act(() => useAppStore.setState({ turnStates: { thread_b: { threadId: 'thread_b', phase: 'completed' } } as never }))
    act(() => useAppStore.setState({ activeThreadId: 'thread_b' }))
    expect(useAppStore.getState().mainView).toBe('files')
  })

  it('stays mounted while a thread without surfaces shows the picker', async () => {
    const hidden = useAppStore.getState().addBrowserTab('thread_b')
    useAppStore.setState({ openedSurfaceKinds: ['browser'], mainView: 'browser' })
    await render(() => createElement(MainViewPanel))
    expect(host.querySelector(`webview`)).not.toBeNull()
    expect(host.textContent).not.toContain(hidden)
    expect(host.querySelector('.keep-mounted-layout-inactive webview')).not.toBeNull()
  })
})

describe('the browser tab without tabs', () => {
  it('draws its empty state only while it shows, and keeps the logo across re-renders', async () => {
    await render(() => createElement(BrowserPanel, { active: false }))
    expect(host.querySelector('.browser-empty-state')).toBeNull()
    // One component type for both renders, so the second updates the panel instead of mounting it again.
    const Shown = () => createElement(BrowserPanel, { active: true })
    await render(Shown)
    const art = host.querySelector('.browser-empty-logo svg')
    expect(art).not.toBeNull()
    // React sets the inner HTML again for a new `__html` object; the same logo node means it was not redrawn.
    act(() => useAppStore.setState({ turnStates: { thread_a: { threadId: 'thread_a', phase: 'completed' } } as never }))
    await render(Shown)
    expect(host.querySelector('.browser-empty-logo svg')).toBe(art)
  })
})

describe('restored browser tabs', () => {
  const restoredTab = (id: string, ownerThreadId: string) =>
    ({ id, ownerThreadId, url: 'https://example.test/', title: id, zoomFactor: 1, deviceToolbarOpen: false, devicePreset: 'responsive' as const })
  const loadedTabIds = () => [...host.querySelectorAll('webview')].map((webview) => webview.getAttribute('data-browser-tab-id'))

  it('start no page while hidden and load the first time they are shown', async () => {
    useAppStore.setState({ browserTabs: [restoredTab('restored_a', 'thread_a'), restoredTab('restored_b', 'thread_b')] })
    const show = async (active: boolean) => { act(() => root.render(createElement(BrowserPanel, { active }))); await settle() }
    await show(false)
    expect(loadedTabIds()).toEqual([])
    await show(true)
    expect(loadedTabIds()).toEqual(['restored_a'])
    // Another thread's restored tab stays unloaded; a shown one stays loaded when the browser hides.
    await show(false)
    expect(loadedTabIds()).toEqual(['restored_a'])
  })

  it('load at once for a tab opened in this session or one an agent drives', async () => {
    useAppStore.setState({ browserTabs: [restoredTab('restored_b', 'thread_b')] })
    const opened = useAppStore.getState().addBrowserTab('thread_b')
    await render(() => createElement(BrowserPanel, { active: false }))
    expect(loadedTabIds()).toEqual([opened])
    act(() => emit(agentState('restored_b', 'thread_b')))
    await settle()
    expect(loadedTabIds()).toEqual(['restored_b', opened])
    expect(host.querySelector('webview[data-browser-tab-id="restored_b"]')?.hasAttribute('data-agent-controlled')).toBe(true)
  })
})

describe('browser tabs out of use', () => {
  const tab = (id: string, ownerThreadId: string) =>
    ({ id, ownerThreadId, url: `https://example.test/${id}`, title: id, zoomFactor: 1, deviceToolbarOpen: false, devicePreset: 'responsive' as const })
  const loadedTabIds = () => [...host.querySelectorAll('webview')].map((webview) => webview.getAttribute('data-browser-tab-id')).sort()
  const show = async (threadId: string, tabId: string) => {
    act(() => {
      useAppStore.setState({ activeThreadId: threadId })
      useAppStore.getState().setActiveBrowserTab(threadId, tabId)
    })
    await settle()
  }
  const webviewOf = (id: string) => host.querySelector(`webview[data-browser-tab-id="${id}"]`)!

  it('unload past the three used before the one on screen, across threads, and reload their saved page when shown', async () => {
    useAppStore.setState({ browserTabs: [tab('a1', 'thread_a'), tab('a2', 'thread_a'), tab('b1', 'thread_b'), tab('b2', 'thread_b'), tab('c1', 'thread_c')] })
    await render(() => createElement(BrowserPanel, { active: true }))
    for (const [thread, id] of [['thread_a', 'a1'], ['thread_a', 'a2'], ['thread_b', 'b1'], ['thread_b', 'b2'], ['thread_c', 'c1']]) await show(thread, id)
    expect(loadedTabIds()).toEqual(['a2', 'b1', 'b2', 'c1'])
    // The unloaded tab kept the address its page was last on.
    act(() => useAppStore.getState().updateBrowserTab('a1', { url: 'https://example.test/a1/later' }))
    await show('thread_a', 'a1')
    expect(loadedTabIds()).toEqual(['a1', 'b1', 'b2', 'c1'])
    expect(webviewOf('a1').getAttribute('src')).toBe('https://example.test/a1/later')
  })

  it('stay loaded while they play media or an agent drives them', async () => {
    useAppStore.setState({ browserTabs: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id) => tab(id, 'thread_a')) })
    await render(() => createElement(BrowserPanel, { active: true }))
    await show('thread_a', 'p1')
    act(() => { webviewOf('p1').dispatchEvent(new Event('media-started-playing')) })
    await show('thread_a', 'p2')
    act(() => emit(agentState('p2', 'thread_a')))
    for (const id of ['p3', 'p4', 'p5', 'p6']) await show('thread_a', id)
    expect(loadedTabIds()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
    // Once the media stops and the agent's session ends, they unload like any other tab.
    act(() => { webviewOf('p1').dispatchEvent(new Event('media-paused')) })
    act(() => emit({ ...agentState('p2', 'thread_a'), owner: 'disconnected' }))
    await settle()
    expect(loadedTabIds()).toEqual(['p3', 'p4', 'p5', 'p6'])
  })

  it('close with their thread when it is archived or deleted', async () => {
    const thread = (id: string, archivedAt?: string) => ({ id, name: id, order: 0, ...(archivedAt ? { archivedAt } : {}) })
    useAppStore.setState({
      threads: [thread('thread_a'), thread('thread_b'), thread('thread_c')] as never,
      browserTabs: [tab('a1', 'thread_a'), tab('b1', 'thread_b'), tab('c1', 'thread_c')]
    })
    await render(() => createElement(BrowserPanel, { active: true }))
    for (const [threadId, id] of [['thread_a', 'a1'], ['thread_b', 'b1'], ['thread_c', 'c1']]) await show(threadId, id)
    expect(loadedTabIds()).toEqual(['a1', 'b1', 'c1'])
    act(() => useAppStore.setState({ threads: [thread('thread_a', '2026-11-15T00:00:00Z'), thread('thread_b'), thread('thread_c')] as never }))
    act(() => useAppStore.setState({ threads: [thread('thread_a', '2026-11-15T00:00:00Z'), thread('thread_c')] as never }))
    await settle()
    expect(useAppStore.getState().browserTabs.map((entry) => entry.id)).toEqual(['c1'])
    expect(loadedTabIds()).toEqual(['c1'])
  })
})

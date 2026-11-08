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
  access = { allowed: true, pending: [] }
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
    // Once the turn has ended, returning to the thread keeps the person's view.
    act(() => useAppStore.setState({ activeThreadId: 'thread_a', mainView: 'files' }))
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

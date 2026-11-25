// @vitest-environment jsdom
/**
 * A thread agent uses the in-app browser with nothing to allow: the toolbar says who is using the tab, a shield over
 * the page takes the person's first touch while an agent step runs (main then gives the tab back to them), and the
 * person's use of the toolbar, address bar and picker is reported so the agent gives way.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../../src/renderer/components/BrowserPanel'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { BrowserAccessState } from '../../src/shared/browser/access'
import type { AttachedTabActivity } from '../../src/shared/browser/attached'
import type { InAppBrowserActivity, InAppBrowserState, InAppBrowserTabCommand } from '../../src/shared/browser/inApp'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

let root: Root
let host: HTMLElement
let access: BrowserAccessState
let request: ReturnType<typeof vi.fn>
let emit: (state: InAppBrowserState) => void
let command: (command: InAppBrowserTabCommand) => void
let reported: InAppBrowserActivity[]
let resumeAgent: ReturnType<typeof vi.fn>
let tabId: string

beforeEach(() => {
  access = { allowed: false, pending: [] }
  reported = []
  resumeAgent = vi.fn(async () => {})
  request = vi.fn(async () => access)
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    inAppBrowser: {
      registerTab: vi.fn(async () => ({ uiTabId: 'ui' })),
      resumeAgent,
      reportActivity: vi.fn(async (activity: InAppBrowserActivity) => { reported.push(activity) }),
      setTabOwner: vi.fn(async () => {}),
      onState: (listener: typeof emit) => { emit = listener; return () => {} },
      onTabCommand: (listener: typeof command) => { command = listener; return () => {} }
    }
  }
  useAppStore.setState({
    profileId: 'profile_a', activeThreadId: 'thread_a', sidebarMode: 'projects', mainView: 'browser', mainAreaOpen: true,
    openedSurfaceKinds: ['browser'], browserTabs: [], browserActiveTabByThread: {}, turnStates: {}
  })
  tabId = useAppStore.getState().addBrowserTab('thread_a')
  useAppStore.getState().updateBrowserTab(tabId, { url: 'https://example.test/', title: 'Example' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() })
const show = async () => { act(() => root.render(createElement(BrowserPanel))); await settle() }
const state = (activity: AttachedTabActivity, owner: InAppBrowserState['owner'] = 'agent', sessionId = 'session_1'): InAppBrowserState =>
  ({ profileId: 'profile_a', uiTabId: tabId, threadId: 'thread_a', sessionId, owner, lifecycle: 'agent-controlled', generation: 1, activity })
const shield = () => host.querySelector<HTMLElement>('.browser-agent-shield')
const toolbar = () => host.querySelector<HTMLElement>('.browser-toolbar')!

describe('a thread agent in the in-app browser', () => {
  it('needs nothing allowed: no switch, no consent panel, and no access request from the toolbar', async () => {
    await show()
    expect(host.querySelector('[role="switch"]')).toBeNull()
    expect(host.querySelector('[aria-label="Agent browser access request"]')).toBeNull()
    expect(host.querySelector('[data-mousse-decision]')).toBeNull()
    expect(host.querySelector('[inert]')).toBeNull()
    expect(request.mock.calls.map(([method]) => method)).not.toContain('browser.access.set')
  })

  it('opens the tab an agent waits for while group-chat consent is off', async () => {
    access = { allowed: false, pending: [], tabRequests: [{ requestId: 'request_1', threadId: 'thread_b' }] }
    await show()
    expect(useAppStore.getState().browserTabs.map((tab) => tab.ownerThreadId)).toEqual(['thread_a', 'thread_b'])
  })
})

describe('who is using the tab', () => {
  it('shows a shield only while an agent step changes the page, and never makes the toolbar inert', async () => {
    await show()
    act(() => emit(state('idle')))
    expect(shield()).toBeNull()
    expect(host.querySelector('.browser-activity')).toBeNull()
    act(() => emit(state('agent-busy')))
    expect(shield()).not.toBeNull()
    expect(host.querySelector('.browser-activity')?.getAttribute('data-state')).toBe('agent-busy')
    expect(toolbar().closest('[inert]')).toBeNull()
    expect(toolbar().querySelector('[inert]')).toBeNull()
    act(() => emit(state('agent-waiting')))
    expect(shield()).toBeNull()
    act(() => emit(state('agent-busy', 'disconnected')))
    expect(shield()).toBeNull()
  })

  it.each([
    ['pointer down', (target: HTMLElement) => target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))],
    ['wheel', (target: HTMLElement) => target.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))],
    ['key', (target: HTMLElement) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))]
  ] as const)('reports a %s on the shield as the person\'s input to that tab', async (_name, fire) => {
    await show()
    act(() => emit(state('agent-busy')))
    act(() => { fire(shield()!) })
    expect(reported).toEqual([{ localTabId: tabId, kind: 'input' }])
  })

  it('reports the person\'s clicks and keys in the toolbar, and holds the tab while the address bar has focus', async () => {
    await show()
    act(() => { host.querySelector<HTMLButtonElement>('[aria-label="Reload"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(reported).toEqual([{ localTabId: tabId, kind: 'input' }])
    reported = []
    const address = host.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
    act(() => address.focus())
    act(() => { address.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'x' })) })
    act(() => address.blur())
    expect(reported).toEqual([
      { localTabId: tabId, kind: 'pin', pin: 'address' },
      { localTabId: tabId, kind: 'input' },
      { localTabId: tabId, kind: 'unpin', pin: 'address' }
    ])
  })

  it('moves the address bar\'s hold to the tab shown while it has focus, and lets go of the one it held', async () => {
    const second = useAppStore.getState().addBrowserTab('thread_a')
    act(() => useAppStore.getState().setActiveBrowserTab('thread_a', tabId))
    await show()
    const address = host.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
    act(() => address.focus())
    act(() => useAppStore.getState().setActiveBrowserTab('thread_a', second))
    await settle()
    // At once, not when the bar loses focus later: the first tab is free for its agent, the shown one is the person's.
    expect(reported).toEqual([
      { localTabId: tabId, kind: 'pin', pin: 'address' },
      { localTabId: tabId, kind: 'unpin', pin: 'address' },
      { localTabId: second, kind: 'pin', pin: 'address' }
    ])
    act(() => address.blur())
    expect(reported.at(-1)).toEqual({ localTabId: second, kind: 'unpin', pin: 'address' })
    expect(reported).toHaveLength(4)
  })

  it('tells main when a tab is kept in every thread or given back to the thread, once it is registered', async () => {
    await show()
    const webview = host.querySelector(`webview[data-browser-tab-id="${tabId}"]`) as HTMLElement & Record<string, unknown>
    Object.assign(webview, { getURL: () => 'https://example.test/', getTitle: () => 'Example', canGoBack: () => false, canGoForward: () => false, isLoading: () => false, setZoomFactor: () => {}, getWebContentsId: () => 7 })
    act(() => { webview.dispatchEvent(new Event('dom-ready')) })
    await settle()
    const setTabOwner = (window as unknown as { mousse: { inAppBrowser: { setTabOwner: ReturnType<typeof vi.fn> } } }).mousse.inAppBrowser.setTabOwner
    const keep = async () => {
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Browser menu"]')!.click())
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')].find((item) => item.textContent?.includes('Keep tab in every thread'))!.click())
      await settle()
    }
    await keep()
    expect(setTabOwner).toHaveBeenLastCalledWith({ localTabId: tabId, threadId: null })
    await keep()
    expect(setTabOwner).toHaveBeenLastCalledWith({ localTabId: tabId, threadId: 'thread_a' })
    expect(setTabOwner).toHaveBeenCalledTimes(2)
  })

  it('registers a tab it opened for an agent as one agents may close, and the person\'s own tab as not', async () => {
    access = { allowed: false, pending: [], tabRequests: [{ requestId: 'request_1', threadId: 'thread_a' }] }
    await show()
    const agentTab = useAppStore.getState().browserTabs.find((tab) => tab.id !== tabId)!.id
    const registerTab = (window as unknown as { mousse: { inAppBrowser: { registerTab: ReturnType<typeof vi.fn> } } }).mousse.inAppBrowser.registerTab
    for (const id of [tabId, agentTab]) {
      const webview = host.querySelector(`webview[data-browser-tab-id="${id}"]`) as HTMLElement & Record<string, unknown>
      Object.assign(webview, { getURL: () => 'about:blank', getTitle: () => '', canGoBack: () => false, canGoForward: () => false, isLoading: () => false, setZoomFactor: () => {}, getWebContentsId: () => 7 })
      act(() => { webview.dispatchEvent(new Event('dom-ready')) })
      await settle()
    }
    const registered = new Map(registerTab.mock.calls.map(([input]: [{ localTabId: string; agentOpened?: boolean }]) => [input.localTabId, input.agentOpened]))
    expect(registered.get(agentTab)).toBe(true)
    expect(registered.get(tabId)).toBeUndefined()
  })

  it('offers Resume agent for a tab the agent handed over, and sends it to that tab', async () => {
    await show()
    act(() => emit(state('waiting-human', 'human')))
    expect(host.querySelector('.browser-activity')?.getAttribute('data-state')).toBe('waiting-human')
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Resume agent')!.click())
    expect(resumeAgent).toHaveBeenCalledWith(tabId)
    // Take control is gone: the person takes over by using the page.
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Browser menu"]')!.click())
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(items).not.toContain('Take control')
    expect(items).not.toContain('Resume agent')
  })
})

describe('an agent\'s tabs', () => {
  it('opens a tab of the agent\'s thread in the background while the person is on another', async () => {
    await show()
    act(() => command({ kind: 'open', requestId: 'open_1', threadId: 'thread_a', activate: false }))
    const tabs = useAppStore.getState().browserTabs
    expect(tabs).toHaveLength(2)
    expect(tabs[1].ownerThreadId).toBe('thread_a')
    expect(useAppStore.getState().browserActiveTabByThread.thread_a).toBe(tabId)
  })

  it('shows the agent\'s new tab when the person is not using the browser', async () => {
    await show()
    act(() => command({ kind: 'open', requestId: 'open_1', threadId: 'thread_a', activate: true }))
    const opened = useAppStore.getState().browserTabs[1].id
    expect(useAppStore.getState().browserActiveTabByThread.thread_a).toBe(opened)
  })

  it('closes a tab main asks to close, and ignores one already gone', async () => {
    const second = useAppStore.getState().addBrowserTab('thread_a')
    await show()
    act(() => command({ kind: 'close', localTabId: second }))
    expect(useAppStore.getState().browserTabs.map((tab) => tab.id)).toEqual([tabId])
    act(() => command({ kind: 'close', localTabId: 'missing' }))
    expect(useAppStore.getState().browserTabs.map((tab) => tab.id)).toEqual([tabId])
  })

  it('shows the agent\'s tab once a session, so its later tabs leave the person\'s view alone', async () => {
    const second = useAppStore.getState().addBrowserTab('thread_a')
    useAppStore.getState().setActiveBrowserTab('thread_a', tabId)
    await show()
    act(() => emit(state('agent-busy')))
    expect(useAppStore.getState().browserActiveTabByThread.thread_a).toBe(tabId)
    act(() => emit({ ...state('agent-busy'), uiTabId: second }))
    expect(useAppStore.getState().browserActiveTabByThread.thread_a).toBe(tabId)
    act(() => emit({ ...state('agent-busy', 'agent', 'session_2'), uiTabId: second }))
    expect(useAppStore.getState().browserActiveTabByThread.thread_a).toBe(second)
  })
})

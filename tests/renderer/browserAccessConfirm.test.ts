// @vitest-environment jsdom
/**
 * Turning on agent access to all browser tabs from the toolbar asks first, in the same bar as an agent's request
 * (#1142): that bar pauses a theme, so a theme cannot turn a click elsewhere into a grant. Turning it off is at once.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../../src/renderer/components/BrowserPanel'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { BrowserAccessState } from '../../src/shared/browser/access'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

let root: Root
let host: HTMLElement
let access: BrowserAccessState
let request: ReturnType<typeof vi.fn>

beforeEach(() => {
  access = { allowed: false, pending: [] }
  request = vi.fn(async (method: string, params: { allowed?: boolean }) => {
    if (method === 'browser.access.set') access = { ...access, allowed: Boolean(params.allowed) }
    return access
  })
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    inAppBrowser: { registerTab: vi.fn(async () => ({ uiTabId: 'ui' })), onState: () => () => {} }
  }
  useAppStore.setState({
    profileId: 'profile_a', activeThreadId: 'thread_a', sidebarMode: 'projects', mainView: 'browser', mainAreaOpen: true,
    openedSurfaceKinds: ['browser'], browserTabs: [], browserActiveTabByThread: {}, turnStates: {}
  })
  useAppStore.getState().addBrowserTab('thread_a')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() })
const toggle = () => host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Agent access to all browser tabs"]')!
const bar = () => host.querySelector<HTMLElement>('[aria-label="Agent browser access request"]')
const button = (name: string) => [...bar()!.querySelectorAll('button')].find((entry) => entry.textContent === name)!
const sets = () => request.mock.calls.filter(([method]) => method === 'browser.access.set').map(([, params]) => (params as { allowed: boolean }).allowed)

describe('agent access from the browser toolbar', () => {
  it('asks in a decision bar before turning on, and grants only on Allow', async () => {
    act(() => root.render(createElement(BrowserPanel)))
    await settle()
    expect(bar()).toBeNull()
    await act(async () => toggle().click())
    expect(sets()).toEqual([])
    expect(bar()!.hasAttribute('data-mousse-decision')).toBe(true)

    await act(async () => button('Deny').click())
    expect(bar()).toBeNull()
    expect(sets()).toEqual([])

    await act(async () => toggle().click())
    await act(async () => button('Allow').click())
    await settle()
    expect(sets()).toEqual([true])
  })

  it('turns off at once', async () => {
    access = { allowed: true, pending: [] }
    act(() => root.render(createElement(BrowserPanel)))
    await settle()
    await act(async () => toggle().click())
    await settle()
    expect(sets()).toEqual([false])
    expect(bar()).toBeNull()
  })

  it('ignores the second click of a double click on Allow, aimed at what was there before the bar opened', async () => {
    act(() => root.render(createElement(BrowserPanel)))
    await settle()
    await act(async () => toggle().click())
    await act(async () => { button('Allow').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })) })
    expect(sets()).toEqual([])
    expect(bar()).not.toBeNull()
    await act(async () => { button('Allow').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await settle()
    expect(sets()).toEqual([true])
  })
})

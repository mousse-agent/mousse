// @vitest-environment jsdom
/**
 * A thread agent's browser without a window, in that thread's Browser panel: one line while the agent
 * has one open (nothing streams), View opens it over the tabs and watches it, Take over hands it to this
 * window, what the person types goes to that thread's browser, and Give back returns it. A thread with
 * no such browser shows no line.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../../src/renderer/components/BrowserPanel'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { setThreadBrowserTransport, useThreadBrowserStore } from '../../src/renderer/stores/threadBrowserStore'
import type { ThreadBrowserView } from '../../src/shared/browser/threadView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

let root: Root
let host: HTMLElement
let views: Record<string, ThreadBrowserView>
let calls: Array<{ method: string; params: Record<string, unknown> }>
const initial = useThreadBrowserStore.getInitialState()

const agentHas: ThreadBrowserView = { open: true, control: 'bot', tab: { url: 'https://shop.example.com/cart', title: 'Cart' } }

beforeEach(() => {
  views = { thread_a: agentHas, thread_b: { open: false, control: 'bot' } }
  calls = []
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request: vi.fn(async () => ({ allowed: true, pending: [] })) },
    inAppBrowser: { registerTab: vi.fn(async () => ({ uiTabId: 'ui' })), onState: () => () => {} },
    browser: { onViewFrame: () => () => {} }
  }
  setThreadBrowserTransport((async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    const threadId = params.threadId as string
    if (method === 'browser.view.hold') {
      const request = params.request as { op: string }
      if (request.op === 'take') views[threadId] = { ...views[threadId]!, control: 'owner', holder: 'this-view' }
      if (request.op === 'release') views[threadId] = { ...views[threadId]!, control: 'bot', holder: 'bot' }
      return { browser: views[threadId], ...(request.op === 'take' ? { hold: { id: 'hold_1', lastSeq: 0, computer: 'This Mac' } } : {}) }
    }
    if (method === 'browser.view.send') return { acks: (params.inputs as Array<{ seq: number }>).map((sent) => ({ seq: sent.seq, status: 'applied' })), lastSeq: (params.inputs as Array<{ seq: number }>).at(-1)!.seq }
    if (method === 'browser.view.unwatch') return { ok: true }
    return { browser: views[threadId] }
  }) as never)
  useAppStore.setState({ profileId: 'profile_a', activeThreadId: 'thread_a', sidebarMode: 'projects', mainView: 'browser', mainAreaOpen: true,
    openedSurfaceKinds: ['browser'], browserTabs: [], browserActiveTabByThread: {}, turnStates: {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setThreadBrowserTransport(null)
  useThreadBrowserStore.setState(initial)
})

const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() })
const button = (name: string) => [...host.querySelectorAll('button')].find((entry) => entry.textContent === name)
const methods = () => calls.map((call) => call.method)

describe('a thread agent\'s browser without a window, in its Browser panel', () => {
  it('shows one line until View; then it is watched, taken over, typed into and given back from this window', async () => {
    act(() => root.render(createElement(BrowserPanel)))
    await vi.waitFor(() => expect(host.querySelector('[aria-label="The agent\'s browser"]')?.textContent).toContain('Agent\'s browser'))
    // Nothing streams until the person opens it.
    expect(methods()).not.toContain('browser.view.watch')
    expect(calls.every((call) => call.params.threadId === 'thread_a')).toBe(true)

    act(() => button('View')!.click())
    await settle()
    const pane = host.querySelector<HTMLElement>('aside.watched-browser-pane')!
    expect(pane.getAttribute('aria-label')).toBe('The agent\'s browser')
    await vi.waitFor(() => expect(methods()).toContain('browser.view.watch'))
    expect(pane.textContent).toContain('The agent\'s browser, without a window. Take over to click or type.')

    act(() => button('Take over')!.click())
    await vi.waitFor(() => expect(button('Give back')).toBeDefined())
    expect(calls.find((call) => call.method === 'browser.view.hold')!.params).toMatchObject({ threadId: 'thread_a', request: { op: 'take' } })
    expect(host.querySelector('.watched-browser-note')!.textContent).toBe('You have the agent\'s browser. Give it back when you\'re done.')

    // What the person types goes to this thread's browser, on the hold.
    const keys = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Type into The agent\'s browser"]')!
    act(() => { keys.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65, bubbles: true })) })
    await vi.waitFor(() => expect(methods()).toContain('browser.view.send'))
    const sent = calls.find((call) => call.method === 'browser.view.send')!
    expect(sent.params).toMatchObject({ threadId: 'thread_a', holdId: 'hold_1' })
    expect(sent.params.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ input: expect.objectContaining({ kind: 'keys', type: 'down', key: 'a' }) })]))

    act(() => button('Give back')!.click())
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'browser.view.hold' && (call.params.request as { op: string }).op === 'release')).toBe(true))
    await vi.waitFor(() => expect(button('Take over')).toBeDefined())

    // Close: back to the panel's own tabs, and the line again.
    act(() => (host.querySelector('[aria-label="Close the browser view"]') as HTMLButtonElement).click())
    await settle()
    expect(host.querySelector('aside.watched-browser-pane')).toBeNull()
    expect(button('View')).toBeDefined()
  })

  it('shows no line for a thread whose agent has no browser open', async () => {
    useAppStore.setState({ activeThreadId: 'thread_b' })
    act(() => root.render(createElement(BrowserPanel)))
    await vi.waitFor(() => expect(methods()).toContain('browser.view.get'))
    await settle()
    expect(host.querySelector('[aria-label="The agent\'s browser"]')).toBeNull()
    expect(button('View')).toBeUndefined()
  })
})

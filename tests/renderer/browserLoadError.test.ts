// @vitest-environment jsdom
/**
 * A tab that can't open its page shows the app's own page (what happened, what to try, Reload)
 * instead of a blank guest and a raw "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL'" notice.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../../src/renderer/components/BrowserPanel'
import { browserLoadErrorView, isPageLoadRejection, isShownLoadFailure } from '../../src/renderer/components/browser/browserLoadError'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const URL_4173 = 'http://127.0.0.1:4173/index.html'
const REJECTION = `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_CONNECTION_REFUSED (-102) loading '${URL_4173}'`

describe('what the error page says', () => {
  it.each([
    // [address, code, title, line with its site, a tip it offers]
    [URL_4173, 'ERR_CONNECTION_REFUSED', 'This site can’t be reached', '127.0.0.1 refused to connect.', 'Check that the server on port 4173 is running'],
    ['http://localhost/', 'ERR_CONNECTION_REFUSED', 'This site can’t be reached', 'localhost refused to connect.', 'Check that the server on port 80 is running'],
    ['https://example.com/a', 'ERR_CONNECTION_REFUSED', 'This site can’t be reached', 'example.com refused to connect.', 'Check your internet connection'],
    ['https://exmaple.test/', 'ERR_NAME_NOT_RESOLVED', 'This site can’t be reached', 'exmaple.test couldn’t be found. Its address may be misspelled.', 'Check the address for typos'],
    ['https://example.com/', 'ERR_CONNECTION_TIMED_OUT', 'This site can’t be reached', 'example.com took too long to respond.', 'Try again in a moment'],
    ['https://example.com/', 'ERR_INTERNET_DISCONNECTED', 'You’re offline', 'This computer isn’t connected to the internet.', 'Check your Wi‑Fi or network cable'],
    ['https://expired.example/', 'ERR_CERT_DATE_INVALID', 'This connection isn’t private', 'expired.example has a certificate this browser doesn’t trust.', 'Check the address for typos'],
    ['http://example.com:6000/', 'ERR_UNSAFE_PORT', 'This address isn’t allowed', 'Browsers refuse to open port 6000.', 'Use the site’s usual port'],
    ['https://example.com/', 'ERR_BLOCKED_BY_RESPONSE', 'This page was refused', 'example.com refused to show this page here.', 'Open it in your usual browser'],
    ['https://example.com/', 'ERR_SOMETHING_NEW', 'This site can’t be reached', 'example.com couldn’t be opened.', 'Check your internet connection']
  ])('%s, %s', (url, code, title, line, tip) => {
    const view = browserLoadErrorView({ url, errorCode: -1, errorDescription: code })
    expect(view.title).toBe(title)
    expect([view.host, view.line].filter(Boolean).join(' ')).toBe(line)
    expect(view.tips).toContain(tip)
    expect(view.code).toBe(code)
  })

  it('shows only main-frame failures that are not aborted loads', () => {
    expect(isShownLoadFailure(-102, true)).toBe(true)
    expect(isShownLoadFailure(-102, false)).toBe(false)
    expect(isShownLoadFailure(-3, true)).toBe(false)
  })

  it('knows the webview loadURL rejection for a failed page from other browser errors', () => {
    expect(isPageLoadRejection(new Error(REJECTION))).toBe(true)
    expect(isPageLoadRejection(new Error('In-app browser automation is unavailable'))).toBe(false)
  })
})

describe('a tab that can’t open its page', () => {
  let root: Root
  let host: HTMLElement
  let tabId: string

  beforeEach(() => {
    ;(window as unknown as { mousse: unknown }).mousse = {
      platformRequest: { request: vi.fn(async () => ({ allowed: false, pending: [] })) },
      inAppBrowser: { registerTab: vi.fn(async () => ({ uiTabId: 'ui' })), onState: () => () => {} }
    }
    useAppStore.setState({
      profileId: 'profile_a', activeThreadId: 'thread_a', sidebarMode: 'projects', mainView: 'browser', mainAreaOpen: true,
      openedSurfaceKinds: ['browser'], browserTabs: [], browserActiveTabByThread: {}, turnStates: {}
    })
    useAppStore.getState().addBrowserTab('thread_a')
    tabId = useAppStore.getState().browserTabs[0].id
    useAppStore.getState().updateBrowserTab(tabId, { url: URL_4173, title: URL_4173 })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() })
  const page = () => host.querySelector<HTMLElement>('.browser-load-error')
  const buttonNamed = (name: string) => [...host.querySelectorAll('button')].find((button) => button.textContent === name)

  async function mountWebview() {
    act(() => root.render(createElement(BrowserPanel)))
    await settle()
    const webview = host.querySelector(`webview[data-browser-tab-id="${tabId}"]`) as HTMLElement & Record<string, unknown>
    const loadURL = vi.fn(async () => { throw new Error(REJECTION) })
    Object.assign(webview, { loadURL, getURL: () => URL_4173, getTitle: () => '', canGoBack: () => false, canGoForward: () => false, isLoading: () => false, setZoomFactor: () => {}, getWebContentsId: () => 7 })
    act(() => { webview.dispatchEvent(new Event('dom-ready')) })
    await settle()
    return { webview, loadURL }
  }

  function fail(webview: HTMLElement, fields: { errorCode: number; errorDescription: string; isMainFrame: boolean }) {
    act(() => { webview.dispatchEvent(Object.assign(new Event('did-fail-load'), { validatedURL: URL_4173, ...fields })) })
  }

  it('shows what happened and reloads the address it couldn’t open', async () => {
    const { webview, loadURL } = await mountWebview()
    fail(webview, { errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', isMainFrame: true })
    expect(page()?.getAttribute('role')).toBe('alert')
    expect(page()?.textContent).toContain('This site can’t be reached')
    expect(page()?.textContent).toContain('127.0.0.1 refused to connect.')
    expect(page()?.textContent).toContain('Check that the server on port 4173 is running')

    await act(async () => buttonNamed('Reload')!.click())
    expect(loadURL).toHaveBeenCalledWith(URL_4173)
    await act(async () => buttonNamed('Details')!.click())
    expect(page()?.textContent).toContain(`Mousse couldn’t open ${URL_4173}`)

    // A page that commits replaces it.
    act(() => { webview.dispatchEvent(new Event('did-navigate')) })
    expect(page()).toBeNull()
  })

  it.each([
    ['a frame inside the page', { errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', isMainFrame: false }],
    ['an aborted load', { errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true }]
  ])('stays on the page when %s fails', async (_case, fields) => {
    const { webview } = await mountWebview()
    fail(webview, fields)
    expect(page()).toBeNull()
  })

  it('shows no raw error notice when the address bar’s load fails', async () => {
    const { webview, loadURL } = await mountWebview()
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')!
    await act(async () => { input.closest('form')!.requestSubmit() })
    await settle()
    expect(loadURL).toHaveBeenCalled()
    fail(webview, { errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', isMainFrame: true })
    expect(host.textContent).not.toContain('GUEST_VIEW_MANAGER_CALL')
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
  })
})

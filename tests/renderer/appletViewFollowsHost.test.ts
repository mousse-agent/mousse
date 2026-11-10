// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppletCard } from '../../src/renderer/components/applets/AppletCard'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { AppletReference } from '../../src/shared/applets'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const reference: AppletReference = {
  appletId: 'applet-1',
  revisionId: 'rev-1',
  sourceHash: 'hash-1',
  title: 'Some equations',
  description: 'Euler and Gauss'
}

/** The applet's host in a transcript: an app root, the scroller and the row, laid out by hand (jsdom has no layout). */
let app: HTMLElement
let scroller: HTMLElement
let root: Root
let hostRect = { left: 100, top: 100, width: 600, height: 300 }
let frames: Array<FrameRequestCallback> = []
let api: Record<string, ReturnType<typeof vi.fn>>
const initialStore = useAppStore.getState()
const realCheckVisibility = (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility

const rect = (r: { left: number; top: number; width: number; height: number }) =>
  ({ x: r.left, y: r.top, left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r }) as DOMRect

/** Runs queued frames and the promises they start until the page settles. */
async function settle() {
  for (let round = 0; round < 12; round++) {
    const queued = frames.splice(0)
    await act(async () => {
      for (const frame of queued) frame(0)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    if (!queued.length && !frames.length) break
  }
}

const preview = () => app.querySelector<HTMLElement>('.mousse-applet-preview')!
const hidCalls = () => api.update.mock.calls.filter(([input]) => (input as { visible?: boolean }).visible === false)
const shownCalls = () => api.update.mock.calls.filter(([input]) => (input as { visible?: boolean }).visible === true)

async function renderApplet() {
  await act(async () => root.render(createElement(AppletCard, { reference })))
  await settle()
  expect(api.mount).toHaveBeenCalledTimes(1)
}

beforeEach(() => {
  frames = []
  hostRect = { left: 100, top: 100, width: 600, height: 300 }
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe() { this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    disconnect() {}
  })
  // jsdom draws nothing: an element is rendered unless it, or an ancestor, is `hidden`.
  ;(HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility = function (this: HTMLElement) {
    return !this.closest('[hidden]')
  }
  api = {
    mount: vi.fn(async () => ({ runtimeId: 'runtime-1' })),
    unmount: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    appearance: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({})),
    suspend: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
    get: vi.fn(),
    export: vi.fn()
  }
  ;(window as unknown as { mousse: unknown }).mousse = { applets: api }
  useAppStore.setState({ activeThreadId: 'thread-1', profileId: 'profile-1' })

  app = document.createElement('div')
  app.className = 'app'
  scroller = document.createElement('div')
  scroller.className = 'an-message-list'
  scroller.getBoundingClientRect = () => rect({ left: 0, top: 0, width: 900, height: 700 })
  const row = document.createElement('div')
  scroller.appendChild(row)
  app.appendChild(scroller)
  document.body.appendChild(app)
  root = createRoot(row)
  const original = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('mousse-applet-preview') ? rect(hostRect) : original.call(this)
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  app.remove()
  document.body.innerHTML = ''
  ;(HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility = realCheckVisibility
  delete (document as { elementFromPoint?: unknown }).elementFromPoint
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("an applet's native view follows its host", () => {
  it('is placed over the host while the host is on screen', async () => {
    await renderApplet()
    expect(api.mount.mock.calls[0][0]).toMatchObject({ threadId: 'thread-1', bounds: { x: 100, y: 100, width: 600, height: 300 } })
    expect(hidCalls()).toHaveLength(0)
  })

  it('hides when the host scrolls out of view, and shows again when it comes back', async () => {
    await renderApplet()
    hostRect = { left: 100, top: -400, width: 600, height: 300 }
    window.dispatchEvent(new Event('scroll'))
    await settle()
    expect(hidCalls()).toHaveLength(1)
    hostRect = { left: 100, top: 120, width: 600, height: 300 }
    window.dispatchEvent(new Event('scroll'))
    await settle()
    expect(shownCalls().at(-1)?.[0]).toMatchObject({ bounds: { y: 120 }, visible: true })
  })

  it('hides when Settings opens over the transcript, and shows again when it closes', async () => {
    await renderApplet()
    // Opening Settings leaves the transcript where it is: the app goes inert and the page is drawn over it.
    const settings = document.createElement('div')
    settings.className = 'settings-page overlay-page'
    document.body.appendChild(settings)
    app.setAttribute('inert', '')
    await settle()
    expect(hidCalls()).toHaveLength(1)
    expect(api.unmount).not.toHaveBeenCalled()

    app.removeAttribute('inert')
    settings.hidden = true
    await settle()
    expect(shownCalls().length).toBeGreaterThan(0)
  })

  it('hides when any page or layer is drawn over the host', async () => {
    await renderApplet()
    const page = document.createElement('div')
    page.className = 'some-future-page'
    document.body.appendChild(page)
    ;(document as { elementFromPoint?: unknown }).elementFromPoint = () => page
    await settle()
    expect(hidCalls()).toHaveLength(1)
  })

  it('hides when its pane is hidden (a rail page replaces the workspace)', async () => {
    await renderApplet()
    app.hidden = true
    await settle()
    expect(hidCalls()).toHaveLength(1)
  })

  it('closes when another thread opens, and never starts there', async () => {
    await renderApplet()
    await act(async () => useAppStore.setState({ activeThreadId: 'thread-2' }))
    await settle()
    expect(api.unmount).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(api.mount).toHaveBeenCalledTimes(1)
  })

  it('closes when the host unmounts (a windowed-out turn)', async () => {
    await renderApplet()
    await act(async () => root.render(null))
    expect(api.unmount).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
  })

  it('never starts while its host is hidden', async () => {
    app.setAttribute('inert', '')
    await act(async () => root.render(createElement(AppletCard, { reference })))
    await settle()
    expect(api.mount).not.toHaveBeenCalled()
    expect(preview()).not.toBeNull()
  })
})

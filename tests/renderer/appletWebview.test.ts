// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppletCard } from '../../src/renderer/components/applets/AppletCard'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { AppletReference } from '../../src/shared/applets'
import type { AppletUiEvent } from '../../src/shared/appletRuntime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * An applet card draws its page in a `<webview>` whose address main minted for the mount. What the card decides:
 * when to start the page, when to tell main it is out of sight, what to do when main releases or stops it, and how a
 * wheel turn the page could not use reaches the conversation's own listeners.
 */
const reference: AppletReference = { appletId: 'applet-1', revisionId: 'rev-1', sourceHash: 'hash-1', title: 'Totals', description: 'A short applet' }

let app: HTMLElement
let scroller: HTMLElement
let row: HTMLElement
let root: Root
let listeners: Array<(event: AppletUiEvent) => void> = []
let observers: Array<{ callback: IntersectionObserverCallback; options?: IntersectionObserverInit }> = []
let api: Record<string, ReturnType<typeof vi.fn>>
let mints = 0
const initialStore = useAppStore.getState()

const emit = (event: Omit<AppletUiEvent, 'runtimeId'>, runtimeId = `runtime-${mints}`) =>
  act(async () => { for (const listener of [...listeners]) listener({ runtimeId, ...event }) })
/** The card comes near the screen (true) or leaves it (false). */
const near = (value: boolean) =>
  act(async () => { for (const { callback } of observers) callback([{ isIntersecting: value } as IntersectionObserverEntry], {} as IntersectionObserver) })
const webview = () => app.querySelector('webview') as HTMLElement | null
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  listeners = []
  observers = []
  mints = 0
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { observers.push({ callback, options }) }
    observe() {}
    disconnect() {}
  })
  api = {
    mount: vi.fn(async () => { mints += 1; return { runtimeId: `runtime-${mints}`, src: `mousse-applet://runtime/${mints}` } }),
    unmount: vi.fn(async () => {}),
    visible: vi.fn(async () => {}),
    appearance: vi.fn(async () => {}),
    onEvent: vi.fn((listener: (event: AppletUiEvent) => void) => {
      listeners.push(listener)
      return () => { listeners = listeners.filter((item) => item !== listener) }
    }),
    get: vi.fn(),
    export: vi.fn()
  }
  ;(window as unknown as { mousse: unknown }).mousse = { applets: api }
  useAppStore.setState({ activeThreadId: 'thread-1', profileId: 'profile-1' })
  app = document.createElement('div')
  scroller = document.createElement('div')
  scroller.className = 'an-message-list'
  row = document.createElement('div')
  scroller.appendChild(row)
  app.appendChild(scroller)
  document.body.appendChild(app)
  root = createRoot(row)
})

afterEach(async () => {
  await act(async () => root.unmount())
  app.remove()
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const renderCard = async () => {
  await act(async () => root.render(createElement(AppletCard, { reference })))
}

describe('an applet card', () => {
  it('starts its page only once it comes near the conversation, and draws it at the minted address', async () => {
    await renderCard()
    expect(api.mount).not.toHaveBeenCalled()
    expect(observers[0]!.options?.root).toBe(scroller)
    await near(true)
    expect(api.mount).toHaveBeenCalledTimes(1)
    expect(api.mount.mock.calls[0]![0]).not.toHaveProperty('bounds')
    expect(webview()?.getAttribute('src')).toBe('mousse-applet://runtime/1')
    // Main decides the session and what the page may do; the card asks for nothing.
    for (const attribute of ['partition', 'preload', 'webpreferences', 'nodeintegration', 'allowpopups']) expect(webview()!.hasAttribute(attribute)).toBe(false)
  })

  it('tells main when it leaves the screen and comes back, and keeps the same page meanwhile', async () => {
    await renderCard()
    await near(true)
    const drawn = webview()
    await near(false)
    await near(true)
    expect(api.visible.mock.calls.map(([input]) => input)).toEqual([
      { runtimeId: 'runtime-1', visible: false },
      { runtimeId: 'runtime-1', visible: true }
    ])
    expect(webview()).toBe(drawn)
    expect(api.mount).toHaveBeenCalledTimes(1)
  })

  it('drops a released page, and starts a new one at a new address when it is back on screen', async () => {
    await renderCard()
    await near(true)
    await near(false)
    await emit({ type: 'released' })
    await flush()
    expect(webview()).toBeNull()
    expect(api.mount).toHaveBeenCalledTimes(1)
    await near(true)
    await flush()
    expect(api.mount).toHaveBeenCalledTimes(2)
    expect(webview()?.getAttribute('src')).toBe('mousse-applet://runtime/2')
  })

  it('shows a stopped page as an error, and removes its webview', async () => {
    await renderCard()
    await near(true)
    await emit({ type: 'error', message: 'The applet stopped responding and was stopped.' })
    expect(webview()).toBeNull()
    expect(app.querySelector('[role="alert"]')?.textContent).toContain('stopped responding')
    expect(api.unmount).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
  })

  it('ignores what another applet reported', async () => {
    await renderCard()
    await near(true)
    await emit({ type: 'error', message: 'not mine' }, 'runtime-other')
    expect(app.querySelector('[role="alert"]')).toBeNull()
    expect(webview()).not.toBeNull()
  })

  it('closes when another thread opens, and never starts there', async () => {
    await renderCard()
    await near(true)
    await act(async () => useAppStore.setState({ activeThreadId: 'thread-2' }))
    await near(true)
    expect(api.unmount).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(api.mount).toHaveBeenCalledTimes(1)
    expect(webview()).toBeNull()
  })

  it('closes when the card unmounts (a windowed-out turn)', async () => {
    await renderCard()
    await near(true)
    await act(async () => root.render(null))
    expect(api.unmount).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
  })

  it("passes a wheel turn the page could not use to the conversation's own wheel listeners", async () => {
    const heard: number[] = []
    scroller.addEventListener('wheel', (event) => heard.push(event.deltaY))
    await renderCard()
    await near(true)
    await emit({ type: 'wheel', deltaY: -120 })
    expect(heard).toEqual([-120])
  })

  it('gives the keyboard back to the thread on Escape in the page', async () => {
    await renderCard()
    await near(true)
    const blur = vi.spyOn(webview()!, 'blur')
    await emit({ type: 'escape' })
    expect(blur).toHaveBeenCalled()
  })
})

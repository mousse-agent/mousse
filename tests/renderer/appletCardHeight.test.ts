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
 * An inline applet card takes the height its page reports, and a card that mounts again (the transcript window
 * dropped the turn and brought it back, or the thread was reopened) starts at that height instead of the default.
 * Each test uses its own revision, because the remembered heights outlive a card by design.
 */
let revision = 0
const reference = (): AppletReference => ({
  appletId: 'applet-1',
  revisionId: `rev-${++revision}`,
  sourceHash: 'hash-1',
  title: 'Totals',
  description: 'A short applet'
})

let app: HTMLElement
let row: HTMLElement
let root: Root
let frames: FrameRequestCallback[] = []
let listeners: Array<(event: AppletUiEvent) => void> = []
let api: Record<string, ReturnType<typeof vi.fn>>
const initialStore = useAppStore.getState()
const realCheckVisibility = (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility

const rect = (r: { left: number; top: number; width: number; height: number }) =>
  ({ x: r.left, y: r.top, left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r }) as DOMRect

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

const previewHeight = () => app.querySelector<HTMLElement>('.mousse-applet-preview')!.style.height
const report = (height: number) => act(async () => { for (const listener of listeners) listener({ runtimeId: 'runtime-1', type: 'resize', height }) })

beforeEach(() => {
  frames = []
  listeners = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe() { this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    disconnect() {}
  })
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
  const scroller = document.createElement('div')
  scroller.className = 'an-message-list'
  scroller.getBoundingClientRect = () => rect({ left: 0, top: 0, width: 900, height: 700 })
  row = document.createElement('div')
  scroller.appendChild(row)
  app.appendChild(scroller)
  document.body.appendChild(app)
  root = createRoot(row)
  const original = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('mousse-applet-preview') ? rect({ left: 100, top: 100, width: 600, height: 300 }) : original.call(this)
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  app.remove()
  ;(HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility = realCheckVisibility
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('an inline applet card height', () => {
  it('follows the page: the first report at once, below the old 320 px floor, then shrinks and grows', async () => {
    await act(async () => root.render(createElement(AppletCard, { reference: reference() })))
    await settle()
    expect(api.mount).toHaveBeenCalledTimes(1)
    await report(80)
    expect(previewHeight()).toBe('80px')
    await report(2500)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) })
    expect(previewHeight()).toBe('2500px')
  })

  it('starts at its last measured height when it mounts again, in a new card or after the thread is reopened', async () => {
    const applet = reference()
    await act(async () => root.render(createElement(AppletCard, { reference: applet })))
    await settle()
    await report(80)
    // The transcript window drops the turn, then brings it back: a new card, before its page reports anything.
    await act(async () => root.render(null))
    await act(async () => root.render(createElement(AppletCard, { reference: applet })))
    expect(previewHeight()).toBe('80px')

    // Another thread opens and this one comes back.
    await act(async () => root.render(null))
    await act(async () => useAppStore.setState({ activeThreadId: 'thread-2' }))
    await act(async () => useAppStore.setState({ activeThreadId: 'thread-1' }))
    await act(async () => root.render(createElement(AppletCard, { reference: applet })))
    expect(previewHeight()).toBe('80px')

    // Another revision has not measured yet, and keeps the default.
    await act(async () => root.render(createElement(AppletCard, { reference: reference() })))
    expect(previewHeight()).toBe('320px')
  })
})

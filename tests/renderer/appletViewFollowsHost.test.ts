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

/** Boxes for elements other than the host, laid out by hand. */
const rects = new WeakMap<HTMLElement, { left: number; top: number; width: number; height: number }>()
type Box = { left: number; top: number; width: number; height: number }
/** An element with inline styles and a box, added at the end of the page unless `into` or `before` says otherwise. */
function place(style: Partial<CSSStyleDeclaration>, box: Box, where: { into?: HTMLElement; before?: Node } = {}) {
  const element = document.createElement('div')
  Object.assign(element.style, style)
  rects.set(element, box)
  if (where.before) where.before.parentNode!.insertBefore(element, where.before)
  else (where.into ?? document.body).appendChild(element)
  return element
}
/** A hover label: fixed, with a background, drawn after the transcript (like `.app-tooltip`). */
const label = (box: Box, where?: { into?: HTMLElement; before?: Node }) =>
  place({ position: 'fixed', backgroundColor: 'rgb(17, 17, 19)' }, box, where)
/** The clip the view was last shown with. */
const lastClip = () => (shownCalls().at(-1)?.[0] as { clip: unknown } | undefined)?.clip
/** The whole visible part of the transcript: the scroller's box, the view's clip when nothing is drawn over the host. */
const OPEN_CLIP = { x: 0, y: 0, width: 900, height: 700 }

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
    const placed = rects.get(this)
    if (placed) return rect(placed)
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

  it('hides behind a dialog that does not even touch the host', async () => {
    await renderApplet()
    const dialog = place({ position: 'fixed', backgroundColor: 'rgb(0, 0, 0)' }, { left: 750, top: 20, width: 100, height: 60 })
    dialog.setAttribute('role', 'dialog')
    dialog.getClientRects = () => [rect({ left: 750, top: 20, width: 100, height: 60 })] as unknown as DOMRectList
    await settle()
    expect(hidCalls()).toHaveLength(1)
  })

  it('never starts while its host is hidden', async () => {
    app.setAttribute('inert', '')
    await act(async () => root.render(createElement(AppletCard, { reference })))
    await settle()
    expect(api.mount).not.toHaveBeenCalled()
    expect(preview()).not.toBeNull()
  })
})

/**
 * Floating UI over an applet stays visible. The host is at (100, 100), 600 × 300; the toolbar under it opens its hover
 * labels upward over the host's bottom edge.
 */
describe('floating app UI over an applet', () => {
  it('cuts a hover label over the bottom edge out of the view, and gives the strip back when it goes', async () => {
    await renderApplet()
    const tip = label({ left: 150, top: 380, width: 100, height: 28 })
    await settle()
    // The largest band nothing is drawn over: everything above the label.
    expect(lastClip()).toEqual({ x: 100, y: 100, width: 600, height: 280 })
    expect(hidCalls()).toHaveLength(0)

    tip.remove()
    await settle()
    expect(lastClip()).toEqual(OPEN_CLIP)
  })

  it('finds a label that appears by a style change, not only one that is added', async () => {
    await renderApplet()
    const tip = label({ left: 150, top: 380, width: 100, height: 28 })
    tip.style.display = 'none'
    await settle()
    expect(lastClip()).toEqual(OPEN_CLIP)
    tip.style.display = ''
    await settle()
    expect(lastClip()).toEqual({ x: 100, y: 100, width: 600, height: 280 })
  })

  // What counts as drawn over the host. Each row adds its layers to a page with the applet showing.
  const rows: Array<{ name: string; add: () => void; clip: unknown }> = [
    { name: 'a label away from the host', add: () => label({ left: 150, top: 420, width: 100, height: 28 }), clip: OPEN_CLIP },
    { name: 'a label touching the host edge', add: () => label({ left: 150, top: 400, width: 100, height: 28 }), clip: OPEN_CLIP },
    {
      name: 'a transparent full-window layer whose card is elsewhere (the side card layer)',
      add: () => {
        const layer = place({ position: 'absolute', zIndex: '20' }, { left: 0, top: 0, width: 1000, height: 800 })
        place({ backgroundColor: 'rgb(30, 30, 30)' }, { left: 750, top: 20, width: 200, height: 100 }, { into: layer })
      },
      clip: OPEN_CLIP
    },
    {
      name: 'a transparent layer whose card is over the host (a toast stack)',
      add: () => {
        const layer = place({ position: 'fixed' }, { left: 400, top: 0, width: 400, height: 800 })
        place({ backgroundColor: 'rgb(30, 30, 30)' }, { left: 500, top: 330, width: 300, height: 60 }, { into: layer })
      },
      clip: { x: 100, y: 100, width: 600, height: 230 }
    },
    {
      name: 'a layer before the transcript, drawn under it',
      add: () => label({ left: 150, top: 380, width: 100, height: 28 }, { before: app }),
      clip: OPEN_CLIP
    },
    {
      name: 'a layer before the transcript, raised above it',
      add: () => place({ position: 'absolute', zIndex: '5', backgroundColor: 'rgb(9, 9, 9)' }, { left: 150, top: 380, width: 100, height: 28 }, { before: app }),
      clip: { x: 100, y: 100, width: 600, height: 280 }
    },
    {
      name: 'a layer with a negative z-index',
      add: () => place({ position: 'fixed', zIndex: '-1', backgroundColor: 'rgb(9, 9, 9)' }, { left: 150, top: 380, width: 100, height: 28 }),
      clip: OPEN_CLIP
    },
    {
      name: 'an invisible layer',
      add: () => place({ position: 'fixed', opacity: '0', backgroundColor: 'rgb(9, 9, 9)' }, { left: 150, top: 380, width: 100, height: 28 }),
      clip: OPEN_CLIP
    },
    {
      name: 'a layer in an inert part of the app',
      add: () => {
        const inert = document.createElement('div')
        inert.setAttribute('inert', '')
        document.body.appendChild(inert)
        label({ left: 150, top: 380, width: 100, height: 28 }, { into: inert })
      },
      clip: OPEN_CLIP
    },
    {
      name: 'an element in the page flow (not floating)',
      add: () => place({ backgroundColor: 'rgb(9, 9, 9)' }, { left: 150, top: 380, width: 100, height: 28 }),
      clip: OPEN_CLIP
    },
    {
      name: 'a narrow layer over the left edge: the band to its right is the largest',
      add: () => label({ left: 90, top: 150, width: 30, height: 200 }),
      clip: { x: 120, y: 100, width: 580, height: 300 }
    }
  ]
  it.each(rows)('$name', async ({ add, clip }) => {
    await renderApplet()
    add()
    await settle()
    expect(lastClip()).toEqual(clip)
    expect(hidCalls()).toHaveLength(0)
  })

  it('hides while a layer covers the whole host, and shows again when it goes', async () => {
    await renderApplet()
    const sheet = label({ left: 50, top: 50, width: 800, height: 500 })
    await settle()
    expect(hidCalls()).toHaveLength(1)
    sheet.remove()
    await settle()
    expect(lastClip()).toEqual(OPEN_CLIP)
  })

  it('on macOS, where a native view cannot be clipped, hides only while a label is over the host', async () => {
    ;(window as unknown as { mousse: { platform?: string } }).mousse.platform = 'darwin'
    await renderApplet()
    const away = label({ left: 150, top: 420, width: 100, height: 28 })
    await settle()
    expect(hidCalls()).toHaveLength(0)
    away.remove()
    const tip = label({ left: 150, top: 380, width: 100, height: 28 })
    await settle()
    expect(hidCalls()).toHaveLength(1)
    const before = shownCalls().length
    tip.remove()
    await settle()
    expect(shownCalls().length).toBeGreaterThan(before)
    expect(lastClip()).toEqual(OPEN_CLIP)
  })
})

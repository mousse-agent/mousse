// @vitest-environment jsdom
/**
 * Where a Usage row's "…" menu opens: below its button, right edges lined up, so it never covers the
 * row above; upward only where the page has no room below. Other pinned popovers keep opening above.
 */
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageRowMenu } from '../../src/renderer/components/UsageRowMenu'
import { usePinnedPopover } from '../../src/renderer/lib/floatingLayer'
import type { ProviderUsage } from '../../src/shared/providerAuth'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const provider: ProviderUsage = { id: 'xai', label: 'Grok (xAI)', status: 'error', windows: [], problem: 'session_expired' }
const WIDTH = 160

let root: Root | undefined
let host: HTMLElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  vi.restoreAllMocks()
})

/** Lays the anchor out at `top`..`top + 24`, right edge at 900, in an 800px-tall window; menus are 160px wide. */
function layout(top: number) {
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(WIDTH)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top, bottom: top + 24, left: 876, right: 900, width: 24, height: 24, x: 876, y: top, toJSON: () => ({}) } as DOMRect)
}

function mount(node: ReturnType<typeof createElement>) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(node))
}

function openMenu() {
  mount(createElement(UsageRowMenu, { provider, hidden: false, actions: { onHide: vi.fn(), onDisable: vi.fn() } }))
  act(() => document.querySelector<HTMLButtonElement>('[data-testid="usage-row-menu"]')!.click())
  return document.querySelector<HTMLElement>('[data-testid="usage-row-menu-list"]')!.style
}

describe("a Usage row's menu", () => {
  it('opens below its button, right edges lined up', () => {
    layout(300)
    const style = openMenu()
    expect(style.top).toBe(`${300 + 24 + 6}px`)
    expect(style.bottom).toBe('')
    expect(style.left).toBe(`${900 - WIDTH}px`)
  })

  it('opens upward only where the page has no room below', () => {
    layout(740)
    const style = openMenu()
    expect(style.bottom).toBe(`${800 - 740 + 6}px`)
    expect(style.top).toBe('')
  })
})

describe('other pinned popovers', () => {
  it('still open above by default', () => {
    layout(300)
    function Probe() {
      const anchorRef = useRef<HTMLButtonElement>(null)
      const contentRef = useRef<HTMLDivElement>(null)
      const style = usePinnedPopover({ open: true, anchorRef, contentRef, maxHeight: 160, minHeight: 120 })
      return createElement('div', null, createElement('button', { ref: anchorRef }), createElement('div', { ref: contentRef, style, 'data-testid': 'probe' }))
    }
    mount(createElement(Probe))
    const style = document.querySelector<HTMLElement>('[data-testid="probe"]')!.style
    expect(style.bottom).toBe(`${800 - 300 + 6}px`)
    expect(style.top).toBe('')
  })
})

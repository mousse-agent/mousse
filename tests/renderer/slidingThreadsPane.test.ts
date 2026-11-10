// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SlidingThreadsPane } from '../../src/renderer/components/SlidingThreadsPane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Settled states only, with reduced motion on: the pane opens and closes at once, so nothing waits for a frame or a timer.
let root: Root
let app: HTMLElement
let toggle: HTMLButtonElement
const realMatchMedia = window.matchMedia

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion: reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
  app = document.createElement('div')
  app.className = 'app'
  toggle = document.createElement('button')
  toggle.className = 'titlebar-sidebar-toggle'
  const host = document.createElement('div')
  app.append(toggle, host)
  document.body.append(app)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  app.remove()
  window.matchMedia = realMatchMedia
})

type Props = { open: boolean; width?: number; overlay?: boolean; resizing?: boolean }
const draw = ({ open, width = 280, overlay = false, resizing = false }: Props) =>
  act(() => root.render(createElement(SlidingThreadsPane, {
    open, width, overlay, resizing,
    resizer: overlay ? undefined : createElement('div', { className: 'resizer resizer-threads' })
  }, createElement('aside', { className: 'threads-sidebar' }, createElement('button', { className: 'sidebar-focus' }, 'Thread')))))
const pane = () => app.querySelector<HTMLElement>('.sliding-threads-pane')!
const sidebar = () => app.querySelector('.threads-sidebar')
const resizer = () => app.querySelector('.resizer-threads')
const widths = () => [pane().style.getPropertyValue('--threads-pane-width'), pane().style.getPropertyValue('--threads-pane-layout-width')]

describe('SlidingThreadsPane, settled', () => {
  it('opens expanded and usable', () => {
    draw({ open: true })
    expect(pane().classList.contains('is-expanded')).toBe(true)
    expect(pane().classList.contains('is-hidden')).toBe(false)
    expect(pane().hasAttribute('inert')).toBe(false)
    expect(pane().getAttribute('aria-hidden')).toBe('false')
    expect(sidebar()).not.toBeNull()
    expect(resizer()).not.toBeNull()
  })

  it('closing with focus inside returns focus to the sidebar toggle, and the closed pane is inert and empty', () => {
    draw({ open: true })
    app.querySelector<HTMLButtonElement>('.sidebar-focus')!.focus()
    expect(document.activeElement?.className).toBe('sidebar-focus')

    draw({ open: false })
    expect(document.activeElement).toBe(toggle)
    expect(pane().hasAttribute('inert')).toBe(true)
    expect(pane().getAttribute('aria-hidden')).toBe('true')
    expect(pane().classList.contains('is-expanded')).toBe(false)
    expect(pane().classList.contains('is-hidden')).toBe(true)
    expect(sidebar()).toBeNull()
    expect(resizer()).toBeNull()

    draw({ open: true })
    expect(pane().hasAttribute('inert')).toBe(false)
    expect(pane().classList.contains('is-expanded')).toBe(true)
    expect(sidebar()).not.toBeNull()
  })

  it('keeps the resized width through resizing, closing and reopening', () => {
    draw({ open: true, width: 330, resizing: true })
    expect(pane().classList.contains('is-resizing')).toBe(true)
    // The layout width adds the 1 px resizer to the sidebar's own width.
    expect(widths()).toEqual(['330px', '331px'])

    draw({ open: true, width: 330 })
    expect(pane().classList.contains('is-resizing')).toBe(false)
    draw({ open: false, width: 330 })
    expect(widths()).toEqual(['330px', '331px'])
    draw({ open: true, width: 330 })
    expect(widths()).toEqual(['330px', '331px'])
    expect(pane().classList.contains('is-expanded')).toBe(true)
  })

  it('a closed overlay takes no clicks and holds no sidebar', () => {
    draw({ open: true, overlay: true })
    expect(pane().classList.contains('sliding-threads-pane--overlay')).toBe(true)
    expect(sidebar()).not.toBeNull()

    draw({ open: false, overlay: true })
    expect(pane().hasAttribute('inert')).toBe(true)
    expect(pane().getAttribute('aria-hidden')).toBe('true')
    expect(pane().classList.contains('is-hidden')).toBe(true)
    expect(sidebar()).toBeNull()
    // jsdom does no hit testing: the stylesheet is what keeps a closed pane out of the pointer's way.
    const css = readFileSync(resolve('src/renderer/styles/sliding-threads-pane.css'), 'utf8')
    expect(css).toContain(".app .sliding-threads-pane[aria-hidden='true'] { pointer-events: none; }")
    expect(css).toContain('.app .sliding-threads-pane.is-hidden { visibility: hidden; }')
  })
})

// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COLLAPSE_CLOSE_MS, COLLAPSE_LONG_LIST, COLLAPSE_OPEN_MS, Collapse, type CollapseProps } from '../../src/renderer/components/ui/Collapse'
import { RecentlyDeletedView, type RecentlyDeletedActions } from '../../src/renderer/components/sidebar/RecentlyDeletedSection'
import { ToolCallsGroup } from '../../src/renderer/chat/components/agent-elements/tools/tool-calls-group'
import type { TrashState } from '../../src/renderer/lib/trashInventory'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia

/** A renderer with animations (jsdom has no matchMedia; without one Collapse applies changes at once). */
function motion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  vi.useFakeTimers()
  motion(false)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  vi.useRealTimers()
})

const items = (n: number) => Array.from({ length: n }, (_, i) => createElement('li', { key: i }, `Row ${i + 1}`))
const draw = (props: Partial<CollapseProps> & { open: boolean }, children: ReactNode = items(3)) =>
  act(() => root.render(createElement(Collapse, { as: 'ul', className: 'rows', ...props }, children)))
const shell = () => host.querySelector<HTMLElement>('.ui-collapse')
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

describe('Collapse', () => {
  it('first render shows the current state without animating', () => {
    draw({ open: true })
    expect(shell()?.dataset.state).toBe('open')
    expect(shell()?.hasAttribute('data-motion')).toBe(false)
    expect(host.querySelectorAll('.ui-collapse > .ui-collapse-clip > ul.rows > li')).toHaveLength(3)

    act(() => root.unmount())
    root = createRoot(host)
    draw({ open: false })
    expect(host.innerHTML).toBe('')
  })

  it('opens with the enter motion, then settles as a plain group', () => {
    draw({ open: false })
    draw({ open: true })
    expect(shell()?.dataset.state).toBe('open')
    expect(shell()?.dataset.motion).toBe('enter')
    expect(shell()?.hasAttribute('inert')).toBe(false)
    advance(COLLAPSE_OPEN_MS + 200)
    expect(shell()?.hasAttribute('data-motion')).toBe(false)
    expect(host.querySelectorAll('li')).toHaveLength(3)
  })

  it('closes inert and hidden from screen readers, and unmounts once the close finishes', () => {
    draw({ open: true })
    draw({ open: false })
    expect(shell()?.dataset.state).toBe('closed')
    expect(shell()?.dataset.motion).toBe('exit')
    expect(shell()?.hasAttribute('inert')).toBe(true)
    expect(shell()?.getAttribute('aria-hidden')).toBe('true')
    advance(COLLAPSE_CLOSE_MS - 10)
    expect(shell()).not.toBeNull()
    advance(100)
    expect(host.innerHTML).toBe('')
  })

  it('reopening while it closes keeps the content and turns back', () => {
    draw({ open: true })
    draw({ open: false })
    advance(50)
    draw({ open: true })
    expect(shell()?.dataset.motion).toBe('enter')
    expect(shell()?.hasAttribute('inert')).toBe(false)
    advance(COLLAPSE_CLOSE_MS + 100)
    expect(shell()?.dataset.state).toBe('open')
  })

  it('opens and closes at once with reduced motion', () => {
    motion(true)
    draw({ open: false })
    draw({ open: true })
    expect(shell()?.dataset.state).toBe('open')
    expect(shell()?.hasAttribute('data-motion')).toBe(false)
    draw({ open: false })
    expect(host.innerHTML).toBe('')
  })

  it('applies a change at once when it was not the user\'s', () => {
    draw({ open: false, animate: false })
    draw({ open: true, animate: false })
    expect(shell()?.hasAttribute('data-motion')).toBe(false)
    draw({ open: false, animate: false })
    expect(host.innerHTML).toBe('')
  })

  it('staggers short lists only', () => {
    draw({ open: true, itemCount: 3 })
    expect(shell()?.hasAttribute('data-stagger')).toBe(true)
    draw({ open: true, itemCount: COLLAPSE_LONG_LIST + 1 })
    expect(shell()?.hasAttribute('data-stagger')).toBe(false)
  })

  it('keeps the motion within the requested timing and turns it off for reduced motion', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/collapse.css'), 'utf8')
    expect(css).toMatch(/\[data-motion='enter'\]\s*\{\s*transition: grid-template-rows 160ms/)
    expect(css).toMatch(/\[data-motion='exit'\]\s*\{\s*grid-template-rows: 0fr;\s*transition: grid-template-rows 130ms/)
    expect(css).toMatch(/:nth-child\(8\) \{ transition-delay: 84ms; \}/)
    expect(css).not.toMatch(/nth-child\(9\)/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none !important/)
  })
})

describe('Collapse adopters', () => {
  const trash = (): TrashState => ({
    loaded: true,
    records: [],
    taskNames: {},
    paused: false,
    policy: { schemaVersion: 1, graceDays: 30, automaticPurge: true }
  } as unknown as TrashState)
  const actions: RecentlyDeletedActions = { onToggle: () => {}, onRestore: () => {}, onDelete: () => {}, onRetry: () => {} }

  it('Recently deleted opens and closes its list with the motion and keeps the toggle wired', () => {
    const view = (expanded: boolean) => act(() => root.render(createElement(RecentlyDeletedView, { state: trash(), expanded, hidden: false, actions })))
    view(false)
    expect(host.querySelector('.threads-sidebar-trash-list')).toBeNull()
    view(true)
    const toggle = host.querySelector('[aria-controls]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(shell()?.dataset.motion).toBe('enter')
    expect(host.querySelector(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`)?.classList.contains('threads-sidebar-trash-list')).toBe(true)
    view(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(shell()?.hasAttribute('inert')).toBe(true)
    advance(COLLAPSE_CLOSE_MS + 50)
    expect(host.querySelector('.threads-sidebar-trash-list')).toBeNull()
  })

  it('a tool-calls group starts closed, opens its rows with the motion, and unmounts them after closing', () => {
    act(() => root.render(createElement(ToolCallsGroup, { count: 2, children: [createElement('div', { key: 1 }, 'Read a.ts'), createElement('div', { key: 2 }, 'Read b.ts')] })))
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(host.textContent).not.toContain('Read a.ts')
    act(() => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(shell()?.dataset.motion).toBe('enter')
    expect(host.querySelector('.ui-collapse-items')?.children).toHaveLength(2)
    act(() => toggle.click())
    expect(shell()?.dataset.motion).toBe('exit')
    advance(COLLAPSE_CLOSE_MS + 50)
    expect(host.textContent).not.toContain('Read a.ts')
  })
})

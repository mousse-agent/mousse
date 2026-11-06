// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COLLAPSE_CLOSE_MS, COLLAPSE_LONG_LIST, COLLAPSE_OPEN_MS, Collapse, type CollapseProps } from '../../src/renderer/components/ui/Collapse'
import { ToolCallsGroup } from '../../src/renderer/chat/components/agent-elements/tools/tool-calls-group'

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

  it('keeps the rows mounted and inert for the whole close, then unmounts them', () => {
    draw({ open: true })
    draw({ open: false })
    expect(host.querySelectorAll('.ui-collapse > .ui-collapse-clip > ul.rows > li')).toHaveLength(3)
    expect(host.querySelector('.ui-collapse ul.rows')?.closest('[inert]')).toBe(shell())
    advance(COLLAPSE_CLOSE_MS - 10)
    expect(host.querySelectorAll('li')).toHaveLength(3)
    expect(shell()?.hasAttribute('inert')).toBe(true)
    advance(100)
    expect(host.querySelectorAll('li')).toHaveLength(0)
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

  it('lays a settled group out as the same one-row grid it moves in, so the close has a row to shrink from', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/collapse.css'), 'utf8')
    const base = css.match(/\n\.ui-collapse \{([^}]*)\}/)?.[1] ?? ''
    expect(base).toMatch(/display: grid;/)
    expect(base).toMatch(/grid-template-rows: 1fr;/)
    // Only the clip and the transitions depend on the motion; the layout does not.
    expect(css).not.toMatch(/\.ui-collapse\[data-motion\] \{[^}]*display/)
  })

  it('turns the chevron with the group: the open and close durations and easings', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/collapse.css'), 'utf8')
    expect(css).toMatch(/\[data-motion='exit'\]\s*\{[^}]*grid-template-rows 130ms var\(--ui-collapse-ease-close\)/)
    // The rule that turns the chevron is the one with the transition, on `transform`; `rotate` is listed too
    // because Tailwind's `rotate-*` classes set that separate property, which a `transform` transition skips.
    expect(css).toMatch(/\.ui-collapse-chevron \{\s*transform: rotate\(0deg\);\s*transition-property: transform, rotate;\s*transition-duration: 130ms;\s*transition-timing-function: var\(--ui-collapse-ease-close\);/)
    expect(css).toMatch(/\.ui-collapse-chevron\[data-open\] \{\s*transform: rotate\(var\(--ui-collapse-chevron-turn, 90deg\)\);\s*transition-duration: 160ms;\s*transition-timing-function: var\(--ui-collapse-ease\);/)
  })

  it('fades the bottom edge of a closing group, so a highlighted row cut by the clip leaves no sliver', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/collapse.css'), 'utf8')
    expect(css).toMatch(/\[data-motion='exit'\] > \.ui-collapse-clip \{\s*mask-image: linear-gradient\(to bottom, #000 calc\(100% - 20px\), transparent calc\(100% - 4px\)\);/)
    // A sidebar row's highlight fades out with the close (it would otherwise outlast the row's clipped text).
    const sidebar = readFileSync(resolve(process.cwd(), 'src/renderer/styles/threads-sidebar.css'), 'utf8')
    expect(sidebar).toMatch(/\.app \.ui-collapse\[data-motion='exit'\] \.threads-sidebar-thread \{\s*background: transparent;\s*box-shadow: none;/)
  })

  it('no other rule turns a shared chevron, so its one transition always applies', () => {
    const files = [
      'src/renderer/styles/app.css',
      'src/renderer/chat/components/agent-elements/tools/subagent-card.css',
      'src/renderer/chat/components/agent-elements/tools/tool-row-base.tsx',
      'src/renderer/chat/components/agent-elements/tools/bash-tool.tsx',
      'src/renderer/chat/components/agent-elements/tools/edit-tool.tsx',
      'src/renderer/chat/components/agent-elements/tools/SubagentCard.tsx',
      'src/renderer/chat/components/agent-elements/turn-edit-summary.tsx'
    ].map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'))
    for (const source of files) {
      expect(source).not.toMatch(/(turn-edits|subagent-group)-chevron\.is-open/)
      // No Tailwind `rotate-*` class on the chevron element (up to the end of its tag).
      expect(source).not.toMatch(/ui-collapse-chevron[^>]*\brotate-/)
    }
  })
})

describe('Collapse adopters', () => {
  it('a tool-calls group starts closed, opens its rows with the motion, and unmounts them after closing', () => {
    act(() => root.render(createElement(ToolCallsGroup, { count: 2, children: [createElement('div', { key: 1 }, 'Read a.ts'), createElement('div', { key: 2 }, 'Read b.ts')] })))
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(host.textContent).not.toContain('Read a.ts')
    const chevron = () => toggle.querySelector('.ui-collapse-chevron')
    // One glyph for both states: the same element turns (a swapped or remounted icon would snap, not turn).
    const glyph = chevron()
    expect(toggle.querySelectorAll('svg')).toHaveLength(1)
    expect(glyph?.hasAttribute('data-open')).toBe(false)
    act(() => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(shell()?.dataset.motion).toBe('enter')
    expect(chevron()).toBe(glyph)
    expect(chevron()?.hasAttribute('data-open')).toBe(true)
    expect(host.querySelector('.ui-collapse-items')?.children).toHaveLength(2)
    act(() => toggle.click())
    // The chevron turns back in the same render the close starts, while the rows are still there.
    expect(shell()?.dataset.motion).toBe('exit')
    expect(chevron()).toBe(glyph)
    expect(chevron()?.hasAttribute('data-open')).toBe(false)
    expect(host.textContent).toContain('Read a.ts')
    advance(COLLAPSE_CLOSE_MS + 50)
    expect(host.textContent).not.toContain('Read a.ts')
  })
})

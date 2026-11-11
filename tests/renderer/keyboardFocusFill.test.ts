// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import postcss from 'postcss'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessages } from '../../src/renderer/components/QueuedMessages'
import { CopyIconButton } from '../../src/renderer/chat/components/agent-elements/tools/copy-icon-button'
import { useThreadQueue } from '../../src/renderer/hooks/useThreadQueue'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { QueuedMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Keyboard focus is a fill, never an outline, ring or border: arrow keys and Tab move a background
 * highlight, the same look as hover and selection.
 */

const RENDERER = join(__dirname, '../../src/renderer')

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return cssFiles(path)
    return name.endsWith('.css') ? [path] : []
  })
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsxFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

interface FocusRule { file: string; line: number; selectors: string[]; decls: Map<string, string> }

const rules: FocusRule[] = cssFiles(RENDERER).flatMap((file) => {
  const out: FocusRule[] = []
  postcss.parse(readFileSync(file, 'utf8')).walkRules((rule) => {
    const decls = new Map<string, string>()
    rule.each((node) => { if (node.type === 'decl') decls.set(node.prop, node.value) })
    out.push({ file: relative(RENDERER, file), line: rule.source?.start?.line ?? 0, selectors: rule.selectors, decls })
  })
  return out
})

/** Rules that style an element while it has keyboard focus (its own focus, not a child's). */
const focusRules = rules.filter((rule) => rule.selectors.some((s) => /:focus(?!-within)/.test(s) && !/::/.test(s)))

const drawsOutline = (value: string) => !/^(none|0|0px)$/.test(value.trim())
const ringShadow = (value: string) => /var\(--ui-focus-ring\)|(^|,)\s*(inset\s+)?0(px)?\s+0(px)?\s+0(px)?\s+[\d.]+px/.test(value)

/**
 * Text fields whose existing hairline border brightens on focus. That is a field's focus look, not a
 * ring; the field's fill changes too.
 */
const TEXT_FIELD_BORDERS = new Set([
  '.side-card-git-branch-input:focus',
  '.side-card-git-message:focus',
  '.side-card-git-pr-title-input:focus',
  '.start-from-pr-input:focus',
  '.scheduled-input:focus-visible',
  '.threads-sidebar-rename-input:focus'
])

const where = (rule: FocusRule) => `${rule.file}:${rule.line} ${rule.selectors.join(', ')}`

describe('keyboard focus styles in the renderer CSS', () => {
  it('never draw an outline', () => {
    const offenders = focusRules.filter((rule) =>
      [...rule.decls].some(([prop, value]) => (prop === 'outline' && drawsOutline(value)) || /^outline-(color|width|style|offset)$/.test(prop)))
    expect(offenders.map(where)).toEqual([])
  })

  it('never draw a ring with box-shadow', () => {
    const offenders = focusRules.filter((rule) => ringShadow(rule.decls.get('box-shadow') ?? ''))
    expect(offenders.map(where)).toEqual([])
    // The ring token is gone, so nothing can bring it back by name.
    expect(rules.filter((rule) => rule.decls.has('--ui-focus-ring')).map(where)).toEqual([])
  })

  it('never add a border, except a text field brightening its own hairline', () => {
    const offenders = focusRules.filter((rule) =>
      [...rule.decls].some(([prop, value]) => /^border(-(color|width|style|left|right|top|bottom))?$/.test(prop) && !/^(0|none|transparent)$/.test(value.trim())) &&
      !rule.selectors.every((s) => TEXT_FIELD_BORDERS.has(s)))
    expect(offenders.map(where)).toEqual([])
  })

  it('switch off the browser ring everywhere and fall back to the focus fill for any control', () => {
    const polish = readFileSync(join(RENDERER, 'styles/polish.css'), 'utf8').replace(/\r\n/g, '\n')
    expect(polish).toMatch(/--ui-focus-fill:\s*var\(--ui-pressed\);/)
    expect(polish).toMatch(/--ui-focus-layer:\s*linear-gradient\(var\(--ui-focus-fill\), var\(--ui-focus-fill\)\);/)
    expect(polish).toMatch(/\n:focus-visible \{\n {2}outline: none;\n\}/)
    const fallback = rules.find((rule) => rule.selectors.some((s) => s.startsWith(':is(button, a[href]') && s.endsWith(':focus-visible')))
    expect(fallback?.decls.get('background-image')).toBe('var(--ui-focus-layer)')
    for (const role of ['menuitem', 'option', 'treeitem', 'tab', 'listitem', 'switch']) {
      expect(fallback!.selectors[0]).toContain(`[role='${role}']`)
    }
  })

  it('show a fill on the lists people arrow through', () => {
    const fill = (selector: string) => {
      const rule = focusRules.find((r) => r.selectors.includes(selector))
      expect(rule, selector).toBeDefined()
      return rule!.decls.get('background-image') ?? rule!.decls.get('background') ?? ''
    }
    expect(fill('.threads-sidebar-thread:focus-visible')).toBe('var(--ui-focus-layer)')
    expect(fill('.queued-message-btn:focus-visible')).toBe('var(--ui-focus-layer)')
    expect(fill(':is(.composer-run-menu, .model-picker-run) .composer-mode-menu-item:focus-visible')).toBe('var(--ui-focus-layer)')
    expect(fill('.profile-menu-row:focus-visible')).toBe('var(--ui-hover)')
    expect(fill('.threads-context-menu-item:focus-visible')).toBe('var(--ui-hover)')
    expect(fill('.ui-tab-select:focus-visible')).toBe('var(--ui-focus-layer)')
    expect(fill('.toggle-switch:focus-visible')).toBe('var(--ui-focus-layer)')
  })

  it('keep the selected tab and rail button a fill, with no inset ring', () => {
    const selected = rules.filter((rule) => rule.selectors.some((s) =>
      /\.(threads-sidebar-tab|navigation-rail-button|main-view-tab|chat-list-row)\.active$/.test(s)))
    expect(selected.length).toBeGreaterThan(0)
    for (const rule of selected) expect(rule.decls.get('box-shadow') ?? '', where(rule)).not.toMatch(/inset 0 0 0/)
  })

  it('use no Tailwind focus outline or ring classes', () => {
    const offenders = tsxFiles(RENDERER).filter((file) =>
      /focus(-visible)?:(outline(?!-none)|ring)/.test(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => relative(RENDERER, file))).toEqual([])
  })
})

/** The focus rules whose selector matches `element` once its focus pseudo-class is taken off. */
function rulesFor(element: Element): FocusRule[] {
  return focusRules.filter((rule) => rule.selectors.some((selector) => {
    if (!/:focus(?!-within)/.test(selector)) return false
    const bare = selector.replace(/:focus-visible|:focus(?!-within)/g, '')
    try { return element.matches(bare) } catch { return false }
  }))
}

const queued = (id: string, content: string): QueuedMessage =>
  ({ id, threadId: 't1', content, enqueuedAt: '2026-11-11T10:00:00Z', order: 1, intent: 'normal', state: 'pending', source: 'gui' }) as QueuedMessage

describe('rendered controls take the focus fill', () => {
  let app: HTMLDivElement
  let root: Root
  let push: ((event: { threadId: string; items: QueuedMessage[] }) => void) | null = null

  beforeEach(() => {
    app = document.createElement('div')
    app.className = 'app'
    document.body.append(app)
    root = createRoot(app)
    useAppStore.setState({ queueEditDrafts: {}, queueDraftNotices: {} })
    const items = [queued('q1', 'Also check the logout path'), queued('q2', 'And add a test for it')]
    ;(window as unknown as { mousse: unknown }).mousse = {
      queue: {
        list: vi.fn(async () => items), edit: vi.fn(), reorder: vi.fn(), remove: vi.fn(), promoteToSteer: vi.fn(),
        onUpdated: (listener: typeof push) => { push = listener; return () => { push = null } }
      }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    app.remove()
  })

  function Queue() {
    const queue = useThreadQueue({ threadId: 't1', hold: null, onDraftToComposer: () => {} })
    return createElement(QueuedMessages, { queue })
  }

  it('every focusable control in the queued messages has a fill and no ring', async () => {
    act(() => root.render(createElement(Queue)))
    await act(async () => { push?.({ threadId: 't1', items: [queued('q1', 'Also check the logout path'), queued('q2', 'And add a test for it')] }) })
    const focusable = [...app.querySelectorAll<HTMLElement>('button, [tabindex]')].filter((el) => el.tabIndex >= 0)
    expect(focusable.length).toBeGreaterThan(4)
    for (const element of focusable) {
      const name = element.getAttribute('aria-label') ?? element.className
      const own = rulesFor(element)
      // Its own rule, or the global fallback that covers buttons and list items.
      expect(own.some((rule) => /var\(--ui-focus-layer\)|var\(--ui-hover\)/.test(rule.decls.get('background-image') ?? rule.decls.get('background') ?? '')), name).toBe(true)
      for (const rule of own) {
        expect(drawsOutline(rule.decls.get('outline') ?? 'none'), where(rule)).toBe(false)
        expect(ringShadow(rule.decls.get('box-shadow') ?? ''), where(rule)).toBe(false)
      }
    }
  })

  it('a tool card copy button fills on focus like it does on hover', () => {
    act(() => root.render(createElement(CopyIconButton, { text: 'npm test', label: 'Copy command' })))
    const classes = app.querySelector('button')!.className.split(/\s+/)
    expect(classes).toContain('hover:bg-an-foreground/10')
    expect(classes).toContain('focus-visible:bg-an-foreground/10')
    expect(classes).toContain('focus-visible:outline-none')
    expect(classes.filter((name) => /^focus-visible:(outline-(?!none)|outline$|ring)/.test(name))).toEqual([])
  })
})

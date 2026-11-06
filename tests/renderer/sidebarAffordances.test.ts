// @vitest-environment jsdom
/**
 * Starting work from the sidebar: Add project and each project's "New thread" are always there, the tabs never
 * change width, both tabs end with the same "No project" and "Archived" footer, the open thread's row is always
 * shown, and the Projects tab is a tree the keyboard can walk.
 */
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Row titles measure themselves; jsdom has no layout.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const actions = vi.hoisted(() => ({
  selectThread: vi.fn(async () => undefined),
  createAndSelectThread: vi.fn(async () => undefined),
  createAndSelectProjectThread: vi.fn(async () => undefined)
}))
vi.mock('../../src/renderer/lib/threadActions', () => actions)
// Neighbours that read the daemon. The pull request dialog leaves a mark to find.
vi.mock('../../src/renderer/components/StartFromPullRequestDialog', async () => {
  const { createElement: h } = await import('react')
  return { StartFromPullRequestDialog: ({ projectName }: { projectName: string }) => h('div', { 'data-testid': 'pr-dialog' }, projectName) }
})
vi.mock('../../src/renderer/components/profiles/ProfileSwitcher', () => ({ ProfileSwitcher: () => null }))
vi.mock('../../src/renderer/components/chats/ChatsSidebar', () => ({ ChatsSidebar: () => null }))

const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
const { ToastHost, dismissToast } = await import('../../src/renderer/components/ui/Toast')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { worktreeMark } = await import('../../src/renderer/lib/worktreeMark')
const { hasMoreBelow, revealDelta } = await import('../../src/renderer/lib/sidebarScroll')

const at = '2026-11-05T10:00:00.000Z'
const project = (id: string, name: string): Project => ({ id, name, path: `/p/${name}`, createdAt: at, order: 0 })
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, projectId: 'p1', ...over })

const threadsApi = {
  delete: vi.fn(async () => undefined),
  restore: vi.fn(async () => undefined),
  create: vi.fn(async () => thread('draft', 'New thread', { startedAt: undefined, projectId: undefined })),
  select: vi.fn(async () => undefined)
}
const projectsApi = {
  open: vi.fn(async () => null),
  remove: vi.fn(async () => undefined)
}

function preload(): unknown {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
  const group = (known: Record<string, unknown> = {}) => new Proxy(known, { get: (target, key: string) => target[key] ?? call(key) })
  return new Proxy({ threads: group(threadsApi), projects: group(projectsApi) } as Record<string, unknown>, {
    get: (target, key: string) => target[key] ?? group()
  })
}

const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'sidebarMode', 'worktreeByDefault'] as const
const appInitial = useAppStore.getInitialState()
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, appInitial[key]]))

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = preload()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  act(() => dismissToast())
  document.body.innerHTML = ''
  useAppStore.setState(appOriginal)
  Object.assign(appInitial, appOriginal)
  vi.clearAllMocks()
})

function show(threads: Thread[], options: { view?: 'projects' | 'threads'; projects?: Project[]; active?: string | null } = {}) {
  useAppStore.setState({
    projects: options.projects ?? [project('p1', 'Mousse')],
    threads,
    threadActivity: {},
    activeThreadId: options.active ?? null,
    threadsSidebarView: options.view ?? 'projects',
    sidebarMode: 'projects'
  })
  act(() => root.render(createElement('div', null, createElement(ThreadsSidebar), createElement(ToastHost))))
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const click = (target: Element) => act(() => { (target as HTMLElement).click() })
const key = (target: Element, init: KeyboardEventInit) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
const row = (id: string) => host.querySelector<HTMLButtonElement>(`button[data-thread-id="${id}"]`)!
const projectRow = (name = 'Mousse') => [...host.querySelectorAll<HTMLButtonElement>('.threads-sidebar-project-toggle')].find((item) => item.textContent?.includes(name))!
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
const headings = () => [...host.querySelectorAll<HTMLElement>('.threads-sidebar-footer section:not([hidden]) .threads-sidebar-heading-toggle')].map((item) => item.textContent)
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === label)!
const sidebarCss = readFileSync('src/renderer/styles/threads-sidebar.css', 'utf8')
const compactCss = readFileSync('src/renderer/styles/compact-shell.css', 'utf8')
const polishCss = readFileSync('src/renderer/styles/polish.css', 'utf8')
/** The declarations of a selector's top-level rule. */
const rule = (css: string, selector: string) => {
  const found = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)
  if (!found) throw new Error(`no rule for ${selector}`)
  return found[2]
}
const many = (count: number) => Array.from({ length: count }, (_, index) => thread(`t${index + 1}`, `Thread ${index + 1}`))

describe('starting work', () => {
  it('shows Add project at the end of the tab row and no button under the list', () => {
    show([thread('a', 'Fix tests')])
    const add = byLabel('Add project')!
    expect(add.closest('.threads-sidebar-tabs-row')).not.toBeNull()
    expect(host.textContent).not.toContain('Open project')
    click(add)
    expect(projectsApi.open).toHaveBeenCalledTimes(1)
  })

  it('says "No projects" with an inline Add project when there are none', () => {
    show([], { projects: [] })
    const empty = host.querySelector<HTMLElement>('.threads-sidebar-empty-projects')!
    expect(empty.textContent).toBe('No projects' + 'Add project')
    click(empty.querySelector('button')!)
    expect(projectsApi.open).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role="tree"]')).toBeNull()
  })

  it('gives each project one "New thread" button and moves the pull request start into its menu', () => {
    show([thread('a', 'Fix tests')])
    click(byLabel('New thread in Mousse')!)
    expect(actions.createAndSelectProjectThread).toHaveBeenCalledWith('p1')
    expect(byLabel('New thread from a pull request')).toBeNull()

    click(byLabel('More actions for Mousse')!)
    click(menuItem('New thread from a pull request'))
    expect(document.querySelector('[data-testid="pr-dialog"]')?.textContent).toBe('Mousse')
  })

  it('starts a thread in the project from its menu', () => {
    show([thread('a', 'Fix tests')])
    click(byLabel('More actions for Mousse')!)
    click(menuItem('New thread'))
    expect(actions.createAndSelectProjectThread).toHaveBeenCalledWith('p1')
  })
})

describe('tabs', () => {
  it('label all three segments, not only the selected one', () => {
    show([thread('a', 'Fix tests')])
    const labels = [...host.querySelectorAll('[role="tab"] .threads-sidebar-tab-label')].map((label) => label.textContent)
    expect(labels).toEqual(['Projects', 'Threads', 'Agents'])
  })

  it('show their labels whole or not at all: at the 260px default the open tab keeps its word at a fixed width', () => {
    const label = rule(sidebarCss, '.threads-sidebar-tab-label')
    expect(label).not.toMatch(/text-overflow|overflow:\s*hidden/)
    expect(label).toMatch(/flex-shrink:\s*0/)
    const queries = new Map([...sidebarCss.matchAll(/@container threads-sidebar \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)]
      .map(([, width, body]) => [Number(width), body]))
    expect([...queries.keys()]).toEqual([319, 239])
    // Under 320px (260px included) only the other two tabs drop their words; the open tab has a fixed minimum
    // width, so the row does not move when the open tab changes.
    const narrow = queries.get(319)!
    expect(narrow).toMatch(/\.threads-sidebar-tab:not\(\.active\) \.threads-sidebar-tab-label \{ display: none; \}/)
    expect(narrow).toMatch(/\.threads-sidebar-tab\.active \{[^}]*flex: 0 0 auto;[^}]*min-width: 88px/)
    // Under 240px there is no room for one word beside two icons.
    expect(queries.get(239)).toMatch(/^\s*\.threads-sidebar-tab-label \{ display: none; \}/m)
    for (const css of [compactCss, polishCss]) {
      expect(css).not.toMatch(/threads-sidebar-tab-label[^{]*\{[^}]*text-overflow/)
      expect(css).not.toMatch(/\.threads-sidebar-tab(?![\w-])[^{]*\{[^}]*\b(flex|min-width|padding)\s*:/)
    }
  })

  it('keep their names as tooltips when the words are hidden', () => {
    show([thread('a', 'Fix tests')])
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs.map((tab) => [tab.title, tab.getAttribute('aria-label')])).toEqual([['Projects', 'Projects'], ['Threads', 'Threads'], ['Agents', 'Agents']])
    expect(tabs.map((tab) => tab.classList.contains('active'))).toEqual([true, false, false])
  })

  it('open Automations from the Agents roster with an arrow, not a "+"', async () => {
    const { ChatsSidebar } = await vi.importActual<typeof import('../../src/renderer/components/chats/ChatsSidebar')>('../../src/renderer/components/chats/ChatsSidebar')
    const html = renderToStaticMarkup(createElement(ChatsSidebar))
    expect(html).toContain('aria-label="Open Automations"')
    expect(html).not.toContain('Manage agents')
  })
})

describe('the footer', () => {
  it('ends Projects with No project and Archived, and Threads with Archived', () => {
    show([thread('a', 'Fix tests'), thread('b', 'Loose', { projectId: undefined }), thread('c', 'Old', { settledAt: at })])
    expect(headings()).toEqual(['No project · 1', 'Archived · 1'])
    act(() => useAppStore.setState({ threadsSidebarView: 'threads' }))
    expect(headings()).toEqual(['Archived · 1'])
  })

  it('holds archived threads inside Archived, with Clear all and no Recently deleted', () => {
    show([thread('a', 'Fix tests'), thread('c', 'Old', { settledAt: at })])
    click(host.querySelector('.threads-sidebar-section-settled .threads-sidebar-heading-toggle')!)
    const archived = host.querySelector('.threads-sidebar-section-settled')!
    expect(archived.querySelector('[data-thread-id="c"]')).not.toBeNull()
    expect(archived.querySelector('[data-testid="archived-clear-all"]')?.textContent).toBe('Clear all')
    expect(host.textContent).not.toContain('Recently deleted')
  })

  it('follows the lists, and sticks to the bottom only when they are taller than the sidebar', () => {
    // The list is as tall as its rows and shrinks (and scrolls) once it outgrows the sidebar; it no longer
    // grows to push the footer down. The footer's auto bottom margin keeps the profile at the window's edge.
    const list = rule(sidebarCss, '.threads-sidebar-scroll')
    expect(list).toMatch(/flex:\s*0 1 auto/)
    expect(list).toMatch(/min-height:\s*0/)
    expect(list).toMatch(/overflow-y:\s*auto/)
    expect(rule(sidebarCss, '.threads-sidebar-footer')).toMatch(/margin-bottom:\s*auto/)
    for (const css of [compactCss, polishCss]) expect(css).not.toMatch(/\.threads-sidebar-scroll(?![\w-])[^{]*\{[^}]*\bflex(-grow)?\s*:/)
    // The Agents tab has no footer, so its list fills the sidebar.
    expect(rule(sidebarCss, ".threads-sidebar-scroll[data-view='chats']")).toMatch(/flex-grow:\s*1/)
    show([thread('a', 'Fix tests')])
    const scroller = host.querySelector<HTMLElement>('.threads-sidebar-scroll')!
    expect(scroller.dataset.view).toBe('projects')
    expect(scroller.nextElementSibling?.classList.contains('threads-sidebar-footer')).toBe(true)
  })

  it('is the one scroll container: it keeps its room, and nothing inside it caps its own height', () => {
    const footer = rule(sidebarCss, '.threads-sidebar-footer')
    expect(footer).toMatch(/flex:\s*0 0 auto/)
    expect(footer).toMatch(/min-height:\s*0/)
    expect(footer).toMatch(/overflow-y:\s*auto/)
    expect(footer).toMatch(/max-height:\s*45vh/)
    const inside = /\.threads-sidebar-(bottom-recent|section-settled|settled-list|trash-list)\b[^{]*\{([^}]*)\}/g
    for (const css of [sidebarCss, compactCss, polishCss]) {
      for (const [, , body] of css.matchAll(inside)) expect(body).not.toMatch(/max-height|overflow-y/)
    }
  })
})

/** Gives the list a height, a content height and a scroll position jsdom does not have. */
function layOut(scroller: HTMLElement, size: { height: number; content: number }) {
  let top = 0
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => size.height },
    scrollHeight: { configurable: true, get: () => size.content },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value } }
  })
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: size.height, height: size.height }) as DOMRect
}

describe('a list taller than the sidebar', () => {
  const waiting = { n1: 'awaiting_input', n2: 'awaiting_input' } as const
  const tall = () => [
    thread('n1', 'Answer me', { projectId: 'p1' }),
    thread('n2', 'Approve me', { projectId: 'p1' }),
    ...many(5),
    thread('q1', 'Payments fix', { projectId: 'p2' }),
    thread('q2', 'Payments docs', { projectId: 'p2' })
  ]

  it('fades its last rows and draws its scrollbar while rows sit below the fold', () => {
    const scrollCue = rule(sidebarCss, '.threads-sidebar-scroll[data-more-below]')
    expect(scrollCue).toMatch(/mask-image:\s*linear-gradient\(to bottom/)
    expect(rule(sidebarCss, '.threads-sidebar-scroll[data-more-below]::-webkit-scrollbar-thumb')).toMatch(/background-color/)

    show(tall(), { projects: [project('p1', 'Mousse'), project('p2', 'Payments')] })
    const scroller = host.querySelector<HTMLElement>('.threads-sidebar-scroll')!
    expect(scroller.hasAttribute('data-more-below')).toBe(false)
    layOut(scroller, { height: 200, content: 600 })
    act(() => { scroller.dispatchEvent(new Event('scroll')) })
    expect(scroller.hasAttribute('data-more-below')).toBe(true)
    scroller.scrollTop = 400
    act(() => { scroller.dispatchEvent(new Event('scroll')) })
    expect(scroller.hasAttribute('data-more-below')).toBe(false)
  })

  it('scrolls a project the person opens under a tall "Needs me" until its first rows show', () => {
    show(tall(), { projects: [project('p1', 'Mousse'), project('p2', 'Payments')] })
    act(() => useAppStore.setState({ threadActivity: waiting }))
    expect(host.querySelector('.threads-sidebar-needs-me')?.textContent).toContain('Needs me · 2')
    const scroller = host.querySelector<HTMLElement>('.threads-sidebar-scroll')!
    layOut(scroller, { height: 200, content: 700 })
    const payments = host.querySelector<HTMLElement>('[data-project-id="p2"]')!
    // Payments' row sits at 180px in a 200px list; open, its rows reach 400px.
    payments.getBoundingClientRect = () => ({ top: 180, bottom: 400 }) as DOMRect
    click(projectRow('Payments'))
    expect(projectRow('Payments').getAttribute('aria-expanded')).toBe('true')
    expect(scroller.scrollTop).toBe(180)

    // Closing it leaves the list where it is.
    click(projectRow('Payments'))
    expect(scroller.scrollTop).toBe(180)
  })
})

describe('sidebarScroll', () => {
  it('knows when rows sit below the fold', () => {
    expect(hasMoreBelow({ scrollHeight: 600, scrollTop: 0, clientHeight: 200 })).toBe(true)
    expect(hasMoreBelow({ scrollHeight: 600, scrollTop: 400, clientHeight: 200 })).toBe(false)
    expect(hasMoreBelow({ scrollHeight: 200, scrollTop: 0, clientHeight: 200 })).toBe(false)
  })

  it('scrolls only as far as needed and never past the project row', () => {
    const view = { top: 0, bottom: 200 }
    expect(revealDelta(view, { top: 20, bottom: 120 })).toBe(0)
    expect(revealDelta(view, { top: 150, bottom: 260 })).toBe(60)
    expect(revealDelta(view, { top: 180, bottom: 600 })).toBe(180)
    expect(revealDelta(view, { top: -40, bottom: 60 })).toBe(-40)
  })
})

describe('the open thread', () => {
  it('is shown when it is past the first 5 rows of its project', () => {
    show(many(7), { active: 't7' })
    expect(host.querySelector('.threads-sidebar-thread-list')!.classList.contains('expanded')).toBe(true)
    expect(row('t7').closest('[inert]')).toBeNull()
    expect(row('t7').classList.contains('active')).toBe(true)
  })

  it('opens No project when it has no project', () => {
    show([thread('a', 'Fix tests'), thread('b', 'Loose', { projectId: undefined })], { active: 'b' })
    expect(row('b')).not.toBeNull()
  })

  it('is marked by its background only', () => {
    show([thread('a', 'Fix tests')], { active: 'a' })
    expect(row('a').querySelector('.threads-sidebar-selected-dot')).toBeNull()
  })

  it('stays on the current tab when a new thread starts', async () => {
    const real = await vi.importActual<typeof import('../../src/renderer/lib/threadActions')>('../../src/renderer/lib/threadActions')
    useAppStore.setState({ threads: [], threadsSidebarView: 'projects', activeThreadId: null })
    await real.createAndSelectThread()
    expect(useAppStore.getState().threadsSidebarView).toBe('projects')
    expect(threadsApi.select).toHaveBeenCalledWith('draft')
  })
})

describe('row marks', () => {
  it('marks only a checkout that differs from the default for new threads', () => {
    expect(worktreeMark({ projectId: 'p1', worktreeEnabled: true }, true)).toBeUndefined()
    expect(worktreeMark({ projectId: 'p1', worktreeEnabled: false }, true)).toBe('Primary checkout')
    expect(worktreeMark({ projectId: 'p1', worktreeEnabled: true }, false)).toBe('Worktree')
    expect(worktreeMark({ projectId: 'p1' }, false)).toBeUndefined()
    expect(worktreeMark({ worktreeEnabled: false }, true)).toBeUndefined()
  })

  it('shows the mark on the row with its name as the tooltip', () => {
    useAppStore.setState({ worktreeByDefault: true })
    show([thread('a', 'Fix tests', { worktreeEnabled: true }), thread('b', 'Docs', { worktreeEnabled: false })], { active: 'a' })
    expect(row('a').querySelector('.threads-sidebar-worktree-icon')).toBeNull()
    expect(row('b').querySelector('.threads-sidebar-worktree-icon')?.getAttribute('title')).toBe('Primary checkout')
  })

  it('gives a title a tooltip only when it does not fit', () => {
    const width = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(300)
    const visible = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(120)
    show([thread('a', 'A very long thread title that does not fit')], { active: 'a' })
    expect(row('a').querySelector('.threads-sidebar-thread-name')?.getAttribute('title')).toBe('A very long thread title that does not fit')
    width.mockReturnValue(100)
    act(() => { row('a').querySelector('.threads-sidebar-thread-name')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(row('a').querySelector('.threads-sidebar-thread-name')?.hasAttribute('title')).toBe(false)
    width.mockRestore()
    visible.mockRestore()
  })
})

describe('the Projects tree', () => {
  const projects = [project('p1', 'Mousse'), project('p2', 'Notes')]

  it('is one Tab stop, on the open thread', () => {
    show([thread('a', 'Fix tests'), thread('b', 'Docs')], { projects, active: 'b' })
    const tree = host.querySelector('[role="tree"]')!
    const stops = [...tree.querySelectorAll('[tabindex="0"]')]
    expect(stops).toEqual([row('b')])
    expect(row('b').getAttribute('role')).toBe('treeitem')
    expect(row('b').getAttribute('aria-selected')).toBe('true')
    expect(projectRow('Mousse').getAttribute('aria-level')).toBe('1')
    expect(tree.querySelectorAll('.threads-sidebar-thread-action[tabindex="0"], .threads-sidebar-icon-btn:not([tabindex="-1"])')).toHaveLength(0)
  })

  it('moves with Up and Down, opens with Right and goes back to the project with Left', () => {
    show([thread('a', 'Fix tests'), thread('b', 'Docs'), thread('n', 'Note', { projectId: 'p2' })], { projects })
    projectRow('Mousse').focus()
    key(projectRow('Mousse'), { key: 'ArrowRight' })
    expect(projectRow('Mousse').getAttribute('aria-expanded')).toBe('true')
    key(projectRow('Mousse'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(row('a'))
    key(row('a'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row('b'))
    expect(row('b').tabIndex).toBe(0)
    expect(row('a').tabIndex).toBe(-1)
    key(row('b'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(projectRow('Notes'))
    key(projectRow('Notes'), { key: 'ArrowUp' })
    key(row('b'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(projectRow('Mousse'))
    key(projectRow('Mousse'), { key: 'ArrowLeft' })
    expect(projectRow('Mousse').getAttribute('aria-expanded')).toBe('false')
    key(projectRow('Mousse'), { key: 'End' })
    expect(document.activeElement).toBe(projectRow('Notes'))
    key(projectRow('Notes'), { key: 'Home' })
    expect(document.activeElement).toBe(projectRow('Mousse'))
  })

  it('shows the rest of a project when Down goes past its first 5 threads', () => {
    show(many(7), { active: 't1' })
    expect(row('t6').closest('[inert]')).not.toBeNull()
    row('t5').focus()
    key(row('t5'), { key: 'ArrowDown' })
    expect(host.querySelector('.threads-sidebar-thread-list')!.classList.contains('expanded')).toBe(true)
    expect(document.activeElement).toBe(row('t6'))
  })

  it('opens a thread with Enter; Delete does nothing to a thread in use, which is archived first', async () => {
    show([thread('a', 'Fix tests')], { active: 'a' })
    row('a').focus()
    click(row('a'))
    expect(actions.selectThread).toHaveBeenCalledWith('a')
    key(row('a'), { key: 'Delete' })
    await flush()
    expect(threadsApi.delete).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('.ui-toast [data-action="undo"]')).toBeNull()
  })

  it('asks before deleting an archived thread on Delete, and deletes it for good only on confirm', async () => {
    show([thread('a', 'Fix tests'), thread('c', 'Old', { settledAt: at })])
    click(host.querySelector('.threads-sidebar-section-settled .threads-sidebar-heading-toggle')!)
    row('c').focus()
    key(row('c'), { key: 'Delete' })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('Delete “Old”?')
    expect(threadsApi.delete).not.toHaveBeenCalled()
    click(dialog.querySelector('[data-testid="archived-delete-confirm"]')!)
    await flush()
    expect(threadsApi.delete).toHaveBeenCalledWith('c')
    expect(document.querySelector('.ui-toast [data-action="undo"]')).toBeNull()
  })

  it('asks before removing a project on Delete', () => {
    show([thread('a', 'Fix tests')])
    projectRow().focus()
    key(projectRow(), { key: 'Delete' })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Mousse leaves the sidebar.')
    expect(projectsApi.remove).not.toHaveBeenCalled()
  })
})

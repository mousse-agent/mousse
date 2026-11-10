// @vitest-environment jsdom
/**
 * Starting work from the sidebar: Add project and each project's "New thread" are always there, the tabs never
 * change width, both tabs end with the same "Archived" footer, the open thread's row is always
 * shown, and the Projects tab is a tree the keyboard can walk.
 */
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'sidebarMode'] as const
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

  it('shows Add project only on the Projects tab; elsewhere the tabs take the whole row', () => {
    show([thread('a', 'Fix tests')])
    const tab = (name: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((item) => item.getAttribute('aria-label') === name)!
    const rowChildren = () => [...host.querySelector('.threads-sidebar-tabs-row')!.children].map((child) => child.className)
    expect(rowChildren()).toEqual(['threads-sidebar-tabs', 'threads-sidebar-toolbar-button threads-sidebar-add-project'])
    for (const name of ['Threads', 'Chats']) {
      click(tab(name))
      expect(byLabel('Add project')).toBeNull()
      expect(rowChildren()).toEqual(['threads-sidebar-tabs'])
    }
    click(tab('Projects'))
    expect(byLabel('Add project')).not.toBeNull()
    // The tab list grows into the row when Add project is gone.
    expect(rule(sidebarCss, '.threads-sidebar-tabs')).toMatch(/flex:\s*1;/)
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

  it('gives Other threads a "New thread" button that starts a thread with no project, and no menu', () => {
    show([thread('a', 'Fix tests'), thread('b', 'Loose', { projectId: undefined })])
    const group = host.querySelector('.threads-sidebar-other-threads')!
    expect(group.querySelector('[aria-haspopup="menu"]')).toBeNull()
    click(group.querySelector('.threads-sidebar-project-row button[aria-label="New thread"]')!)
    expect(actions.createAndSelectThread).toHaveBeenCalledTimes(1)
    expect(actions.createAndSelectProjectThread).not.toHaveBeenCalled()
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
    expect(labels).toEqual(['Projects', 'Threads', 'Chats'])
  })

  it('show their labels whole or not at all: at the 260px default the open tab keeps its word at a fixed width', () => {
    const label = rule(sidebarCss, '.threads-sidebar-tab-label')
    expect(label).not.toMatch(/text-overflow|overflow:\s*hidden/)
    expect(label).toMatch(/flex-shrink:\s*0/)
    // The width rules read the `pill-tabs` container, which the sidebar is.
    expect(rule(sidebarCss, '.threads-sidebar')).toMatch(/container-name:\s*threads-sidebar pill-tabs/)
    const queries = new Map([...sidebarCss.matchAll(/@container pill-tabs \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)]
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
    expect(tabs.map((tab) => [tab.title, tab.getAttribute('aria-label')])).toEqual([['Projects', 'Projects'], ['Threads', 'Threads'], ['Chats', 'Chats']])
    expect(tabs.map((tab) => tab.classList.contains('active'))).toEqual([true, false, false])
  })

  it('make a bot from the + next to Bots in the Agents tab, which no longer opens Automations', async () => {
    const { ChatsSidebar } = await vi.importActual<typeof import('../../src/renderer/components/chats/ChatsSidebar')>('../../src/renderer/components/chats/ChatsSidebar')
    const html = renderToStaticMarkup(createElement(ChatsSidebar))
    expect(html).toContain('<h2>Bots</h2>')
    expect(html).toContain('aria-label="New bot"')
    expect(html).not.toContain('aria-label="Open Automations"')
    expect(html).not.toContain('Roster')
    expect(html).not.toContain('Manage agents')
  })
})

describe('the footer', () => {
  it('ends Projects and Threads with Archived only', () => {
    show([thread('a', 'Fix tests'), thread('b', 'Loose', { projectId: undefined }), thread('c', 'Old', { settledAt: at })])
    expect(headings()).toEqual(['Archived1'])
    act(() => useAppStore.setState({ threadsSidebarView: 'threads' }))
    expect(headings()).toEqual(['Archived1'])
  })

  it('holds archived threads inside Archived, with no Clear all and no Recently deleted', () => {
    show([thread('a', 'Fix tests'), thread('c', 'Old', { settledAt: at })])
    click(host.querySelector('.threads-sidebar-section-settled .threads-sidebar-heading-toggle')!)
    const archived = host.querySelector('.threads-sidebar-section-settled')!
    expect(archived.querySelector('[data-thread-id="c"]')).not.toBeNull()
    expect(archived.textContent).not.toContain('Clear all')
    expect(host.textContent).not.toContain('Recently deleted')
  })

  it('heads Archived with its count and a chevron that turns while it is open; the whole heading toggles', () => {
    show([thread('a', 'Fix tests'), thread('c', 'Old', { settledAt: at }), thread('d', 'Older', { settledAt: at })])
    const archived = host.querySelector<HTMLElement>('.threads-sidebar-section-settled')!
    const toggle = archived.querySelector<HTMLButtonElement>('.threads-sidebar-heading-toggle')!
    expect(archived.querySelectorAll('.threads-sidebar-heading > *')).toHaveLength(1)
    expect(toggle.querySelector('.threads-sidebar-settled-count')?.textContent).toBe('2')
    expect(toggle.querySelector('.threads-sidebar-settled-chevron')).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(archived.classList.contains('expanded')).toBe(true)
    expect(rule(sidebarCss, '.threads-sidebar-section-settled.expanded .threads-sidebar-settled-chevron')).toMatch(/rotate\(90deg\)/)
    expect(rule(sidebarCss, '.app .threads-sidebar-section-settled .threads-sidebar-heading-toggle')).toMatch(/flex:\s*1/)
  })

  it('hides the count when nothing is archived', () => {
    show([thread('a', 'Fix tests')])
    expect(host.querySelector('.threads-sidebar-settled-count')).toBeNull()
    expect(headings()).toEqual(['Archived'])
  })

  it('draws no divider above Archived', () => {
    for (const css of [sidebarCss, compactCss, polishCss]) {
      for (const [, body] of css.matchAll(/\.threads-sidebar-(?:section-settled|footer)\b[^{]*\{([^}]*)\}/g)) expect(body).not.toMatch(/border(-top)?\s*:/)
    }
  })

  it('is pinned to the bottom of the pane, and the lists scroll above it when they are taller than the sidebar', () => {
    // The list is as tall as its rows and shrinks (and scrolls) once it outgrows the sidebar. The footer's auto
    // top margin takes the room the lists leave, so it stays at the bottom, above the profile, when they are short.
    const list = rule(sidebarCss, '.threads-sidebar-scroll')
    expect(list).toMatch(/flex:\s*0 1 auto/)
    expect(list).toMatch(/min-height:\s*0/)
    expect(list).toMatch(/overflow-y:\s*auto/)
    expect(rule(sidebarCss, '.threads-sidebar-footer')).toMatch(/margin-top:\s*auto/)
    for (const css of [compactCss, polishCss]) expect(css).not.toMatch(/\.threads-sidebar-scroll(?![\w-])[^{]*\{[^}]*\bflex(-grow)?\s*:/)
    // The Agents tab has no footer, so its list fills the sidebar.
    expect(rule(sidebarCss, ".threads-sidebar-scroll[data-view='chats']")).toMatch(/flex-grow:\s*1/)
    show([thread('a', 'Fix tests')])
    const scroller = host.querySelector<HTMLElement>('.threads-sidebar-scroll')!
    expect(scroller.dataset.view).toBe('projects')
    expect(scroller.nextElementSibling?.classList.contains('threads-sidebar-footer')).toBe(true)
  })

  it('is the one scroll container: it keeps its room, and nothing inside it caps its own height at rest', () => {
    const footer = rule(sidebarCss, '.threads-sidebar-footer')
    expect(footer).toMatch(/flex:\s*0 0 auto/)
    expect(footer).toMatch(/min-height:\s*0/)
    expect(footer).toMatch(/overflow-y:\s*auto/)
    expect(footer).toMatch(/max-height:\s*45vh/)
    const inside = /\.threads-sidebar-(section-settled|settled-list|trash-list)\b([^{]*)\{([^}]*)\}/g
    for (const css of [sidebarCss, compactCss, polishCss]) {
      for (const [, , selector, body] of css.matchAll(inside)) {
        if (!selector.includes('[data-motion]')) expect(body).not.toMatch(/max-height|overflow-y/)
      }
    }
  })

  it('opens and closes Archived over the room the footer shows, so a long list does not fill it in one frame', () => {
    // Only while the Collapse moves: its rows are capped at 45vh less the heading, and the footer does not scroll.
    expect(rule(sidebarCss, '.threads-sidebar-footer > .threads-sidebar-section-settled > .ui-collapse[data-motion] > .ui-collapse-clip > *'))
      .toMatch(/max-height:\s*calc\(45vh - var\(--threads-sidebar-settled-head, 48px\)\)/)
    expect(rule(sidebarCss, '.threads-sidebar-footer:has(> .threads-sidebar-section-settled > .ui-collapse[data-motion])')).toMatch(/overflow-y:\s*hidden/)
    show([thread('a', 'Fix tests'), thread('c', 'Old', { settledAt: at })])
    click(host.querySelector('.threads-sidebar-section-settled .threads-sidebar-heading-toggle')!)
    expect(host.querySelector<HTMLElement>('.threads-sidebar-footer')!.style.getPropertyValue('--threads-sidebar-settled-head')).toMatch(/px$/)
  })

  it('keeps the Archived rows still while the heading sweeps over them, so they fade in place', () => {
    // The footer sits on the bottom of the pane: the rows hold the bottom of the group and its own box clips them.
    const group = '.threads-sidebar-footer > .threads-sidebar-section-settled > .ui-collapse'
    expect(rule(sidebarCss, group)).toMatch(/align-content:\s*end/)
    expect(rule(sidebarCss, `${group} > .ui-collapse-clip`)).toMatch(/justify-content:\s*flex-end/)
    expect(rule(sidebarCss, `${group}[data-motion]`)).toMatch(/overflow:\s*hidden/)
    expect(rule(sidebarCss, `${group}[data-motion] > .ui-collapse-clip`)).toMatch(/overflow:\s*visible/)
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

  it('opens Other threads when it has no project', () => {
    show([thread('a', 'Fix tests'), thread('b', 'Loose', { projectId: undefined })], { active: 'b' })
    expect(row('b').closest('.threads-sidebar-other-threads')).not.toBeNull()
    expect(projectRow('Other threads').getAttribute('aria-expanded')).toBe('true')
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
  it("marks only a checkout that differs from where its project's new threads start", () => {
    const worktrees = [{ id: 'p1' }]
    const folder = [{ id: 'p1', newThread: { worktreeEnabled: false } }]
    expect(worktreeMark({ projectId: 'p1', worktreeEnabled: true }, worktrees)).toBeUndefined()
    expect(worktreeMark({ projectId: 'p1', worktreeEnabled: false }, worktrees)).toBe('Primary checkout')
    expect(worktreeMark({ projectId: 'p1', worktreeEnabled: true }, folder)).toBe('Worktree')
    expect(worktreeMark({ projectId: 'p1' }, folder)).toBeUndefined()
    expect(worktreeMark({ worktreeEnabled: false }, worktrees)).toBeUndefined()
  })

  it('shows the mark on the row with its name as the tooltip', () => {
    show([thread('a', 'Fix tests', { worktreeEnabled: true }), thread('b', 'Docs', { worktreeEnabled: false })], { active: 'a' })
    expect(row('a').querySelector('.threads-sidebar-worktree-icon')).toBeNull()
    expect(row('b').querySelector('.threads-sidebar-worktree-icon')?.getAttribute('title')).toBe('Primary checkout')
  })

  it('gives a title a tooltip only when it does not fit', () => {
    const width = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(300)
    const visible = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(120)
    show([thread('a', 'A very long thread title that does not fit')], { active: 'a' })
    const title = () => row('a').querySelector('.threads-sidebar-thread-name')!
    const hover = () => act(() => { title().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    hover()
    expect(title().getAttribute('title')).toBe('A very long thread title that does not fit')
    width.mockReturnValue(100)
    hover()
    expect(title().hasAttribute('title')).toBe(false)
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

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
// Neighbours that read the daemon. Recently deleted and the pull request dialog leave a mark to find.
vi.mock('../../src/renderer/components/sidebar/RecentlyDeletedSection', async () => {
  const { createElement: h } = await import('react')
  return { RecentlyDeletedSection: ({ nested }: { nested?: boolean }) => h('div', { 'data-testid': 'trash', 'data-nested': String(Boolean(nested)) }) }
})
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

  it('show their labels whole or not at all, and hide them below 320px, so the 260px default shows icons', () => {
    const label = rule(sidebarCss, '.threads-sidebar-tab-label')
    expect(label).not.toMatch(/text-overflow|overflow:\s*hidden/)
    expect(label).toMatch(/flex-shrink:\s*0/)
    const hidden = [...sidebarCss.matchAll(/@container threads-sidebar \(max-width: (\d+)px\) \{([^}]*)\}/g)]
      .filter(([, , body]) => /\.threads-sidebar-tab-label\s*\{\s*display:\s*none/.test(body + '}'))
    expect(hidden.map(([, width]) => Number(width))).toEqual([319])
    for (const css of [compactCss, polishCss]) expect(css).not.toMatch(/threads-sidebar-tab-label[^{]*\{[^}]*text-overflow/)
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

  it('holds archived threads and Recently deleted inside Archived', () => {
    show([thread('a', 'Fix tests'), thread('c', 'Old', { settledAt: at })])
    expect(host.querySelector('[data-testid="trash"]')).toBeNull()
    click(host.querySelector('.threads-sidebar-section-settled .threads-sidebar-heading-toggle')!)
    const archived = host.querySelector('.threads-sidebar-section-settled')!
    expect(archived.querySelector('[data-thread-id="c"]')).not.toBeNull()
    expect(archived.querySelector('[data-testid="trash"]')?.getAttribute('data-nested')).toBe('true')
  })

  it('is the one scroll container: it shrinks for the lists, and nothing inside it caps its own height', () => {
    const footer = rule(sidebarCss, '.threads-sidebar-footer')
    expect(footer).toMatch(/flex:\s*0 1 auto/)
    expect(footer).toMatch(/min-height:\s*0/)
    expect(footer).toMatch(/overflow-y:\s*auto/)
    expect(footer).toMatch(/max-height:\s*45vh/)
    const inside = /\.threads-sidebar-(bottom-recent|section-settled|settled-list|trash-nested|trash-list)\b[^{]*\{([^}]*)\}/g
    for (const css of [sidebarCss, compactCss, polishCss]) {
      for (const [, , body] of css.matchAll(inside)) expect(body).not.toMatch(/max-height|overflow-y/)
    }
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

  it('opens a thread with Enter and deletes it with Delete, with Undo', async () => {
    show([thread('a', 'Fix tests')], { active: 'a' })
    row('a').focus()
    click(row('a'))
    expect(actions.selectThread).toHaveBeenCalledWith('a')
    key(row('a'), { key: 'Delete' })
    await flush()
    expect(threadsApi.delete).toHaveBeenCalledWith('a')
    expect(document.querySelector('.ui-toast [data-action="undo"]')).not.toBeNull()
  })

  it('asks before removing a project on Delete', () => {
    show([thread('a', 'Fix tests')])
    projectRow().focus()
    key(projectRow(), { key: 'Delete' })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Mousse leaves the sidebar.')
    expect(projectsApi.remove).not.toHaveBeenCalled()
  })
})

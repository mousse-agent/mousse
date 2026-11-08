// @vitest-environment jsdom
/**
 * Sidebar rows show their state: an empty project offers New thread, project rows have a disclosure chevron and a
 * tooltip with their folder, pinned threads list first, pinned cards carry the pin on their meta line, threads
 * of no project form "Other threads", the Projects tree's last group, thread titles end in an ellipsis and never move
 * on hover, and the project menu holds every project action, the rare Git one in a submenu. While a menu is open
 * the sidebar is marked so other rows do not light their actions.
 */
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorInfo, Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const actions = vi.hoisted(() => ({
  selectThread: vi.fn(async () => undefined),
  createAndSelectThread: vi.fn(async () => undefined),
  createAndSelectProjectThread: vi.fn(async () => undefined)
}))
vi.mock('../../src/renderer/lib/threadActions', () => actions)
vi.mock('../../src/renderer/components/StartFromPullRequestDialog', () => ({ StartFromPullRequestDialog: () => null }))
vi.mock('../../src/renderer/components/profiles/ProfileSwitcher', () => ({ ProfileSwitcher: () => null }))
vi.mock('../../src/renderer/components/chats/ChatsSidebar', () => ({ ChatsSidebar: () => null }))

const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
const { ToastHost, dismissToast } = await import('../../src/renderer/components/ui/Toast')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useEditorsStore } = await import('../../src/renderer/stores/editorsStore')

const at = '2026-11-05T10:00:00.000Z'
const project = (id: string, name: string, over: Partial<Project> = {}): Project => ({ id, name, path: `/p/${name}`, createdAt: at, order: 0, ...over })
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, projectId: 'p1', ...over })

const EDITORS: EditorInfo[] = [
  { id: 'cursor', label: 'Cursor', kind: 'editor' },
  { id: 'files', label: 'Finder', kind: 'files' }
]

const editorsApi = { open: vi.fn(async () => undefined), list: vi.fn(async () => EDITORS) }
const writeText = vi.fn(async () => undefined)

function preload(): unknown {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
  const group = (known: Record<string, unknown> = {}) => new Proxy(known, { get: (target, key: string) => target[key] ?? call(key) })
  return new Proxy({ editors: group(editorsApi) } as Record<string, unknown>, {
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
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  useEditorsStore.setState({ editors: EDITORS })
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
  useEditorsStore.setState({ editors: null })
  vi.clearAllMocks()
})

function show(threads: Thread[], options: { view?: 'projects' | 'threads'; projects?: Project[] } = {}) {
  useAppStore.setState({
    projects: options.projects ?? [project('p1', 'Mousse')],
    threads,
    threadActivity: {},
    activeThreadId: null,
    threadsSidebarView: options.view ?? 'projects',
    sidebarMode: 'projects'
  })
  act(() => root.render(createElement('div', null, createElement(ThreadsSidebar), createElement(ToastHost))))
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const click = (target: Element) => act(() => { (target as HTMLElement).click() })
const key = (target: Element, init: KeyboardEventInit) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
const projectRow = (name = 'Mousse') => [...host.querySelectorAll<HTMLButtonElement>('.threads-sidebar-project-toggle')].find((item) => item.textContent?.includes(name))!
const openProject = (name = 'Mousse') => click(projectRow(name))
const rowIds = () => [...host.querySelectorAll<HTMLElement>('section:not([hidden]) button[data-thread-id], [role="tabpanel"]:not([hidden]) button[data-thread-id]')].map((item) => item.dataset.threadId)
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
// The menu's items in order, with "—" for each separator.
const menuEntries = () => [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"], [role="separator"]')].map((item) => (item.getAttribute('role') === 'separator' ? '—' : item.textContent))
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === label)!
const openMenu = (name = 'Mousse') => click(host.querySelector(`[aria-label="More actions for ${name}"]`)!)

describe('project rows', () => {
  it('say only "No threads" when empty, leaving the header New thread as the one way to start one', () => {
    show([])
    openProject()
    const empty = host.querySelector('.threads-sidebar-empty-nested')!
    expect(empty.textContent).toBe('No threads')
    expect(empty.querySelector('button')).toBeNull()
    const row = projectRow().closest('.threads-sidebar-project-row')!
    expect(row.classList.contains('empty')).toBe(true)
    expect(host.querySelectorAll('[aria-label="New thread in Mousse"]')).toHaveLength(1)
    click(row.querySelector('.threads-sidebar-project-new-chat')!)
    expect(actions.createAndSelectProjectThread).toHaveBeenCalledWith('p1')
  })

  it('carry a disclosure chevron that follows the keyboard', () => {
    show([thread('a', 'Fix tests')])
    const row = projectRow()
    expect(row.querySelector('.threads-sidebar-project-chevron')).not.toBeNull()
    expect(row.closest('.threads-sidebar-project-row')!.classList.contains('expanded')).toBe(false)
    row.focus()
    key(row, { key: 'ArrowRight' })
    expect(row.closest('.threads-sidebar-project-row')!.classList.contains('expanded')).toBe(true)
    key(row, { key: 'ArrowLeft' })
    expect(row.closest('.threads-sidebar-project-row')!.classList.contains('expanded')).toBe(false)
  })

  it('name the project and its folder in their tooltip', () => {
    show([])
    expect(projectRow().title).toBe('Mousse · /p/Mousse')
  })

  it('show the folder under home as ~ on one line, beside the sidebar, with the whole path for screen readers', () => {
    const mousse = (window as unknown as { mousse: Record<string, unknown> }).mousse
    ;(window as unknown as { mousse: unknown }).mousse = new Proxy({ homeFolder: '/Users/ada' }, {
      get: (target, key: string) => (key in target ? target[key as keyof typeof target] : mousse[key])
    })
    const deep = '/Users/ada/ux-audit/tour/fixtures/workspaces/a-very-long-folder-name/another-long-folder/Mousse'
    show([], { projects: [project('p1', 'Mousse', { path: deep })] })
    const row = projectRow()
    expect(row.title.startsWith('Mousse · ~/ux-audit/…/')).toBe(true)
    expect(row.title.endsWith('/Mousse')).toBe(true)
    expect(row.title.length).toBeLessThanOrEqual(72)
    expect(row.getAttribute('aria-description')).toBe(`Mousse · ~${deep.slice('/Users/ada'.length)}`)
    expect(row.hasAttribute('data-tooltip-one-line')).toBe(true)
    expect(row.closest('[data-tooltip-placement="outside-left"]')).toBe(row.closest('.threads-sidebar-project-row'))
  })
})

describe('pinned threads', () => {
  const threads = [
    thread('a', 'Newest', { order: 0 }),
    thread('b', 'Pinned', { order: 2, pinnedAt: at }),
    thread('c', 'Older', { order: 1 })
  ]

  it('list first in a project, then the rest by recency', () => {
    show(threads)
    openProject()
    expect(rowIds()).toEqual(['b', 'a', 'c'])
  })

  it('list first in the Threads tab, with the pin on the card’s meta line', () => {
    show(threads, { view: 'threads' })
    expect(rowIds()).toEqual(['b', 'a', 'c'])
    const card = host.querySelector('button[data-thread-id="b"]')!
    expect(card.querySelector('.threads-sidebar-card-meta [aria-label="Pinned"]')).not.toBeNull()
    expect(card.querySelector('.threads-sidebar-card-title svg')).toBeNull()
  })
})

describe('Other threads', () => {
  const groupNames = () => [...host.querySelectorAll<HTMLElement>('.threads-sidebar-project-toggle')].map((item) => item.textContent)

  it('is the Projects tree’s last group, with the same rows as a project and no project actions', () => {
    show([thread('a', 'Fix tests'), thread('b', 'Loose', { projectId: undefined }), thread('c', 'Stray', { projectId: 'gone' })])
    expect(groupNames()).toEqual(['Mousse', 'Other threads'])
    expect(host.querySelector('.threads-sidebar-footer')?.textContent).not.toContain('No project')
    openProject('Other threads')
    const row = host.querySelector<HTMLElement>('button[data-thread-id="b"]')!
    expect(row.closest('.threads-sidebar-other-threads .threads-sidebar-children')).not.toBeNull()
    expect(row.closest('[role="tree"]')?.getAttribute('aria-label')).toBe('Projects')
    expect(row.getAttribute('aria-level')).toBe('2')
    expect(host.querySelector('button[data-thread-id="c"]')).not.toBeNull()
    const group = host.querySelector('.threads-sidebar-other-threads')!
    expect(group.querySelector('.threads-sidebar-project-more')).toBeNull()
    // Its one action is the global new thread, with no project.
    expect(group.querySelector('.threads-sidebar-project-new-chat')?.getAttribute('aria-label')).toBe('New thread')
    act(() => { projectRow('Other threads').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(menu()).toBeNull()
  })

  it('is hidden without threads, and shown under No projects', () => {
    show([thread('a', 'Fix tests')])
    expect(groupNames()).toEqual(['Mousse'])
    show([thread('b', 'Loose', { projectId: undefined })], { projects: [] })
    expect(host.textContent).toContain('No projects')
    expect(groupNames()).toEqual(['Other threads'])
  })

  it('is walked as part of the Projects tree, its one Tab stop', () => {
    show([thread('a', 'Fix tests'), thread('b', 'Loose', { projectId: undefined, order: 0 }), thread('c', 'Stray', { projectId: undefined, order: 1 })])
    expect(host.querySelectorAll('[role="tree"]')).toHaveLength(1)
    const items = () => [...host.querySelectorAll<HTMLElement>('[role="tree"] [role="treeitem"]')].filter((item) => !item.closest('[inert]'))
    expect(items().map((item) => item.tabIndex)).toEqual([0, -1])
    projectRow().focus()
    key(projectRow(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(projectRow('Other threads'))
    key(projectRow('Other threads'), { key: 'ArrowRight' })
    expect(projectRow('Other threads').getAttribute('aria-expanded')).toBe('true')
    key(projectRow('Other threads'), { key: 'ArrowRight' })
    expect((document.activeElement as HTMLElement).dataset.threadId).toBe('b')
    key(document.activeElement!, { key: 'End' })
    expect((document.activeElement as HTMLElement).dataset.threadId).toBe('c')
    expect(items().filter((item) => item.tabIndex === 0)).toEqual([document.activeElement])
    key(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(projectRow('Other threads'))
  })
})

describe('thread titles', () => {
  const css = readFileSync('src/renderer/styles/threads-sidebar.css', 'utf8')

  it('keep the hover actions\' room at rest, so nothing moves when the pointer arrives', () => {
    const rest = /\n\.threads-sidebar-thread-container > \.threads-sidebar-thread:not\(\.threads-sidebar-card\) \{([^}]*)\}/.exec(css)
    expect(rest?.[1]).toMatch(/padding-right:\s*var\(--thread-actions-room\)/)
    // No rule changes a row's padding on hover or focus.
    for (const [, selector, body] of css.matchAll(/([^{}]*):(?:hover|focus-within)[^{}]*\{([^}]*)\}/g)) {
      if (selector.includes('threads-sidebar-thread')) expect(body).not.toMatch(/padding/)
    }
  })

  it('end in an ellipsis instead of scrolling, the full title in the tooltip', () => {
    expect(css).not.toMatch(/threads-sidebar-title-scroll|thread-title-overflow/)
    show([thread('a', 'A very long thread title that does not fit')])
    openProject()
    const title = host.querySelector('button[data-thread-id="a"] .threads-sidebar-thread-name')!
    expect(title.children).toHaveLength(0)
    expect(title.textContent).toBe('A very long thread title that does not fit')
  })
})

describe('the project menu', () => {
  it('holds every project action, grouped', () => {
    show([])
    openMenu()
    expect(menuEntries()).toEqual([
      'New thread', 'New thread from a pull request', '—',
      'Open in Cursor', 'Show in Finder', 'Copy path', '—',
      'Pin', 'Rename', 'Change icon…', 'Git', '—',
      'Remove project…'
    ])
  })

  it('keeps "Trust this repository\'s Git settings" in a Git submenu, reached by pointer and keyboard', async () => {
    const trustGitSettings = vi.fn(async () => ({ filters: [] }))
    ;(window as unknown as { mousse: Record<string, unknown> }).mousse = new Proxy({ projects: { trustGitSettings } } as Record<string, unknown>, {
      get: (target, name: string) => target[name] ?? (preload() as Record<string, unknown>)[name]
    })
    show([])
    openMenu()
    const git = menuItem('Git')
    expect(git.getAttribute('aria-haspopup')).toBe('menu')
    expect(git.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.textContent).not.toContain('Trust this repository')

    git.focus()
    key(git, { key: 'ArrowRight' })
    const trust = menuItem('Trust this repository\'s Git settings')
    expect(trust.closest('[role="menu"]')?.getAttribute('aria-label')).toBe('Git')
    expect(document.activeElement).toBe(trust)
    // The submenu's arrows stay in it; Left goes back to Git and the menu stays open.
    key(trust, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(trust)
    key(trust, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(menuItem('Git'))
    expect(menuItem('Git').getAttribute('aria-expanded')).toBe('false')
    expect(menu()).not.toBeNull()
    // The parent's arrows skip the closed submenu.
    key(menuItem('Git'), { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Remove project…')

    act(() => { menuItem('Git').parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })) })
    click(menuItem('Trust this repository\'s Git settings'))
    await flush()
    expect(trustGitSettings).toHaveBeenCalledWith('p1')
    expect(menu()).toBeNull()
  })

  it('opens the folder in the editor and the file manager, and copies its path', async () => {
    show([])
    openMenu()
    click(menuItem('Open in Cursor'))
    await flush()
    expect(editorsApi.open).toHaveBeenLastCalledWith('cursor', '/p/Mousse')
    openMenu()
    click(menuItem('Show in Finder'))
    await flush()
    expect(editorsApi.open).toHaveBeenLastCalledWith('files', '/p/Mousse')
    openMenu()
    click(menuItem('Copy path'))
    await flush()
    expect(writeText).toHaveBeenCalledWith('/p/Mousse')
    expect(menu()).toBeNull()
  })

  it('leaves out Open and Show until the editors are known', () => {
    useEditorsStore.setState({ editors: null })
    editorsApi.list.mockImplementationOnce(() => new Promise(() => {}))
    show([])
    openMenu()
    expect(menuEntries()).not.toContain('Open in Cursor')
    expect(menuEntries()).toContain('Copy path')
  })
})

describe('while a menu is open', () => {
  it('marks the sidebar, so other rows keep their actions dark', () => {
    show([thread('a', 'Fix tests')])
    const aside = host.querySelector('aside')!
    expect(aside.classList.contains('menu-open')).toBe(false)
    openMenu()
    expect(aside.classList.contains('menu-open')).toBe(true)
    key(document.activeElement!, { key: 'Escape' })
    expect(aside.classList.contains('menu-open')).toBe(false)
  })

  it('keeps the project row whose menu is open lit', () => {
    show([thread('a', 'Fix tests')])
    openMenu()
    expect(projectRow().closest('.threads-sidebar-project-row')?.hasAttribute('data-menu-open')).toBe(true)
  })
})

describe('focus dimming', () => {
  const projects = [project('p1', 'Mousse'), project('p2', 'Docs', { order: 1 })]
  const threads = [thread('a', 'Fix tests'), thread('b', 'Write guide', { projectId: 'p2' }), thread('c', 'Loose', { projectId: undefined })]
  const open = (id: string | null) => act(() => { useAppStore.setState({ activeThreadId: id }) })
  const activeGroups = () => [...host.querySelectorAll<HTMLElement>('[role="tree"] [data-active-project]')].map((item) => item.dataset.projectId)
  const tree = () => host.querySelector('[role="tree"]')!

  it('marks the open thread’s project as the one in focus', () => {
    show(threads, { projects })
    open('b')
    expect(tree().hasAttribute('data-has-active')).toBe(true)
    expect(activeGroups()).toEqual(['p2'])
  })

  it('marks "Other threads" when the open thread has no project', () => {
    show(threads, { projects })
    open('c')
    expect(activeGroups()).toHaveLength(1)
    expect(host.querySelector('.threads-sidebar-other-threads')?.hasAttribute('data-active-project')).toBe(true)
  })

  it('marks a new draft’s project, and dims nothing with no thread open', () => {
    show([...threads, thread('d', 'New Thread', { projectId: 'p2', startedAt: undefined })], { projects })
    open('d')
    expect(activeGroups()).toEqual(['p2'])
    open(null)
    expect(tree().hasAttribute('data-has-active')).toBe(false)
    expect(activeGroups()).toEqual([])
  })

  it('dims the Threads tab only while the open thread has a card there', () => {
    show(threads, { projects, view: 'threads' })
    const feed = () => host.querySelector('.threads-sidebar-feed-list')!
    expect(feed().hasAttribute('data-has-active')).toBe(false)
    open('a')
    expect(feed().hasAttribute('data-has-active')).toBe(true)
  })
})

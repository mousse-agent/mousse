// @vitest-environment jsdom
/**
 * Sidebar rows show their state: an empty project offers New thread, project rows have a disclosure chevron and a
 * tooltip with their folder, pinned threads list first, pinned cards carry the pin on their meta line, "No project"
 * rows sit at the tree's indent, and the project menu holds every project action. While a menu is open the
 * sidebar is marked so other rows do not light their actions.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorInfo, Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Row titles measure themselves; jsdom has no layout.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const actions = vi.hoisted(() => ({
  selectThread: vi.fn(async () => undefined),
  createAndSelectThread: vi.fn(async () => undefined),
  createAndSelectProjectThread: vi.fn(async () => undefined)
}))
vi.mock('../../src/renderer/lib/threadActions', () => actions)
vi.mock('../../src/renderer/components/sidebar/RecentlyDeletedSection', () => ({ RecentlyDeletedSection: () => null }))
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
  it('say "No threads · New thread" when empty, and New thread starts one in the project', () => {
    show([])
    openProject()
    const empty = host.querySelector('.threads-sidebar-empty-nested')!
    expect(empty.textContent).toBe('No threads·New thread')
    click(empty.querySelector('button')!)
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

describe('No project', () => {
  it('lists its threads at the tree’s indent, with the same rows as a project', () => {
    show([thread('a', 'Loose', { projectId: undefined })])
    click([...host.querySelectorAll('.threads-sidebar-heading-toggle')].find((item) => item.textContent?.startsWith('No project'))!)
    const row = host.querySelector('section[aria-label="No project"] button[data-thread-id="a"]')!
    expect(row.closest('.threads-sidebar-children')).not.toBeNull()
    expect(row.classList.contains('threads-sidebar-thread-root')).toBe(false)
  })
})

describe('the project menu', () => {
  it('holds every project action, grouped', () => {
    show([])
    openMenu()
    expect(menuEntries()).toEqual([
      'New thread', 'New thread from a pull request', '—',
      'Open in Cursor', 'Show in Finder', 'Copy path', '—',
      'Pin', 'Rename', 'Trust this repository\'s Git settings', '—',
      'Remove project…'
    ])
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
})

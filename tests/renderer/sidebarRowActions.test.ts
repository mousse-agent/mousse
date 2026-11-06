// @vitest-environment jsdom
/**
 * What a person can do to a sidebar row: open an archived thread, rename by F2 or double-click, open the
 * row menu from a "…" button or the keyboard and move through it, archive with Undo, delete an archived thread after
 * its confirmation (a thread in use has no Delete), confirm a project's removal, and see every failure.
 */
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
// Neighbours that read the daemon and are not what these tests are about.
vi.mock('../../src/renderer/components/profiles/ProfileSwitcher', () => ({ ProfileSwitcher: () => null }))
vi.mock('../../src/renderer/components/chats/ChatsSidebar', () => ({ ChatsSidebar: () => null }))
vi.mock('../../src/renderer/components/ThreadHoverCard', () => ({
  ThreadHoverCard: ({ children }: { children: (props: object) => unknown }) => children({ anchorRef: { current: null }, onMouseEnter: () => {}, onMouseLeave: () => {} })
}))

const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
const { TitleBar } = await import('../../src/renderer/components/TitleBar')
const { ToastHost, TOAST_MS, dismissToast } = await import('../../src/renderer/components/ui/Toast')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

const at = '2026-11-05T10:00:00.000Z'
const project = (id: string, name: string): Project => ({ id, name, path: `/p/${name}`, createdAt: at, order: 0 })
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, projectId: 'p1', ...over })

const threadsApi = {
  pin: vi.fn(async () => undefined),
  settle: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
  regenerateTitle: vi.fn(async () => undefined)
}
const projectsApi = {
  pin: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  trustGitSettings: vi.fn(async () => undefined),
  open: vi.fn(async () => null)
}

/** Every other preload call the sidebar's neighbours make: subscriptions return an unsubscribe, the rest resolve empty. */
function preload(): unknown {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
  const group = (known: Record<string, unknown> = {}) => new Proxy(known, { get: (target, key: string) => target[key] ?? call(key) })
  return new Proxy({ platform: 'win32', threads: group(threadsApi), projects: group(projectsApi) } as Record<string, unknown>, {
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

/** Server rendering reads the store's initial state, so patch both it and the live state. */
function setStore(patch: Partial<ReturnType<typeof useAppStore.getState>>) {
  useAppStore.setState(patch)
  Object.assign(appInitial, patch)
}

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  act(() => dismissToast())
  document.body.innerHTML = ''
  useAppStore.setState(appOriginal)
  Object.assign(appInitial, appOriginal)
  vi.clearAllMocks()
  vi.useRealTimers()
})

function show(threads: Thread[], view: 'projects' | 'threads' = 'projects') {
  useAppStore.setState({ projects: [project('p1', 'Mousse')], threads, threadActivity: {}, activeThreadId: null, threadsSidebarView: view, sidebarMode: 'projects' })
  act(() => root.render(createElement('div', null, createElement(ThreadsSidebar), createElement(ToastHost))))
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const row = (id: string) => host.querySelector<HTMLButtonElement>(`button[data-thread-id="${id}"]`)!
const projectToggle = () => host.querySelector<HTMLButtonElement>('.threads-sidebar-project-toggle')!
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const menuLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === label)!
const toast = () => document.querySelector<HTMLElement>('.ui-toast')
const toastButton = (action: string) => document.querySelector<HTMLButtonElement>(`.ui-toast [data-action="${action}"]`)!
const key = (target: Element, init: KeyboardEventInit) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
const click = (target: Element) => act(() => { (target as HTMLElement).click() })
const openProject = () => click(projectToggle())

describe('naming', () => {
  it('says thread, Agents, No project and Archived', () => {
    setStore({ projects: [project('p1', 'Mousse')], threads: [thread('a', 'Fix tests')], threadsSidebarView: 'threads', sidebarMode: 'projects' })
    const html = renderToStaticMarkup(createElement(ThreadsSidebar))
    // New thread and Search may live in the sidebar header or in the title bar; either way they say "thread".
    const shell = renderToStaticMarkup(createElement(TitleBar)) + html
    expect(shell).toContain('aria-label="New thread"')
    expect(shell).toContain('aria-label="Search threads"')
    expect(html).toContain('aria-label="Agents"')
    expect(html).toContain('<span>No project</span>')
    expect(html).toContain('<span>Archived</span>')
    expect(html).toContain('aria-label="New thread in project"')
    expect(html).not.toMatch(/Settle|Recent chats|New chat/)
  })

  it('lists a thread whose project was removed under No project', () => {
    setStore({ projects: [project('p1', 'Mousse')], threads: [thread('a', 'Fix tests', { projectId: 'gone' })], threadsSidebarView: 'projects', sidebarMode: 'projects' })
    const html = renderToStaticMarkup(createElement(ThreadsSidebar))
    expect(html).toMatch(/<span>No project<\/span><span class="threads-sidebar-settled-count">1</)
  })
})

describe('an archived thread', () => {
  it('opens on click', () => {
    show([thread('a', 'Old work', { settledAt: at }), thread('b', 'Other')], 'threads')
    click(host.querySelector('.threads-sidebar-section-settled .threads-sidebar-heading-toggle')!)
    click(row('a'))
    expect(actions.selectThread).toHaveBeenCalledWith('a')
  })
})

describe('rename', () => {
  it('starts with F2 on a focused row, saves on Enter and gives focus back to the row', async () => {
    show([thread('a', 'Fix tests')])
    openProject()
    row('a').focus()
    key(row('a'), { key: 'F2' })
    const input = host.querySelector<HTMLInputElement>('.threads-sidebar-rename-input')!
    expect(input.value).toBe('Fix tests')
    expect(document.activeElement).toBe(input)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Fix flaky tests')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    key(input, { key: 'Enter' })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(threadsApi.rename).toHaveBeenCalledTimes(1)
    expect(threadsApi.rename).toHaveBeenCalledWith('a', 'Fix flaky tests')
    expect(document.activeElement).toBe(row('a'))
  })

  it('starts with a double-click on the title of a thread or a project', () => {
    show([thread('a', 'Fix tests')])
    openProject()
    act(() => { host.querySelector('.threads-sidebar-thread-name')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(host.querySelector<HTMLInputElement>('.threads-sidebar-rename-input')?.value).toBe('Fix tests')
    key(host.querySelector('.threads-sidebar-rename-input')!, { key: 'Escape' })
    act(() => { host.querySelector('.threads-sidebar-project-name')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(host.querySelector<HTMLInputElement>('.threads-sidebar-project-rename')?.value).toBe('Mousse')
  })
})

describe('the row menu', () => {
  it('opens from the "…" button with the same items as a right-click, and focuses the first', () => {
    show([thread('a', 'Fix tests')])
    openProject()
    act(() => { row('a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })) })
    const fromRightClick = menuLabels()
    key(menu()!, { key: 'Escape' })
    expect(menu()).toBeNull()

    const more = host.querySelector<HTMLButtonElement>('[aria-label="More actions for Fix tests"]')!
    click(more)
    expect(menuLabels()).toEqual(fromRightClick)
    // A thread in use is archived first: no Delete.
    expect(menuLabels()).toEqual(['Pin', 'Archive', 'Regenerate title', 'Rename'])
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(menuItem('Pin'))
  })

  it('moves with arrows, Home and End, and gives focus back to the row on Escape', () => {
    show([thread('a', 'Fix tests')])
    openProject()
    row('a').focus()
    key(row('a'), { key: 'F10', shiftKey: true })
    expect(document.activeElement).toBe(menuItem('Pin'))
    key(document.activeElement!, { key: 'ArrowDown' })
    key(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(menuItem('Regenerate title'))
    key(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(menuItem('Rename'))
    key(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(menuItem('Pin'))
    key(document.activeElement!, { key: 'Escape' })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(row('a'))
  })

  it('opens on a project row from its "…" button, with Remove project…', () => {
    show([thread('a', 'Fix tests')])
    click(host.querySelector('[aria-label="More actions for Mousse"]')!)
    expect(menuLabels()).toEqual(['Pin', 'Rename', 'Trust Git settings again', 'Remove project…'])
  })
})

describe('archive and delete', () => {
  it('archives with an "Archived · Undo" toast; Undo unarchives', async () => {
    show([thread('a', 'Fix tests')])
    openProject()
    click(host.querySelector('[aria-label="More actions for Fix tests"]')!)
    click(menuItem('Archive'))
    await flush()
    expect(threadsApi.settle).toHaveBeenCalledWith('a', true)
    expect(toast()?.textContent).toContain('Archived')
    click(toastButton('undo'))
    await flush()
    expect(threadsApi.settle).toHaveBeenLastCalledWith('a', false)
    expect(toast()).toBeNull()
  })

  it('deletes an archived thread from its "…" menu only after the confirmation, with no Undo toast', async () => {
    show([thread('a', 'Old work', { settledAt: at }), thread('b', 'Other')], 'threads')
    click(host.querySelector('.threads-sidebar-section-settled .threads-sidebar-heading-toggle')!)
    click(host.querySelector('[aria-label="More actions for Old work"]')!)
    expect(menuLabels()).toEqual(['Unarchive', 'Regenerate title', 'Rename', 'Delete…'])
    click(menuItem('Delete…'))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('Delete “Old work”?')
    expect(threadsApi.delete).not.toHaveBeenCalled()
    click(dialog.querySelector('[data-testid="archived-delete-confirm"]')!)
    await flush()
    expect(threadsApi.delete).toHaveBeenCalledWith('a')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(toast()).toBeNull()
  })

  it('asks before removing a project, and removes it only on Remove', async () => {
    show([thread('a', 'Fix tests')])
    click(host.querySelector('[aria-label="More actions for Mousse"]')!)
    click(menuItem('Remove project…'))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('Mousse leaves the sidebar. Its folder and threads stay.')
    expect(projectsApi.remove).not.toHaveBeenCalled()
    click(dialog.querySelector('[data-testid="remove-project-confirm"]')!)
    await flush()
    expect(projectsApi.remove).toHaveBeenCalledWith('p1')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('failures', () => {
  it('shows "Could not pin · <message>" with Retry, and Retry runs the action again', async () => {
    threadsApi.pin.mockRejectedValueOnce(new Error("Error invoking remote method 'threads:pin': Error: The background service is not running"))
    show([thread('a', 'Fix tests')])
    openProject()
    click(host.querySelector('[aria-label="Pin Fix tests"]')!)
    await flush()
    expect(toast()?.getAttribute('role')).toBe('alert')
    expect(toast()?.textContent).toContain('Could not pin · The background service is not running')
    click(toastButton('retry'))
    await flush()
    expect(threadsApi.pin).toHaveBeenCalledTimes(2)
    expect(toast()).toBeNull()
  })

  it('shows a failed delete in its dialog, without Undo or Retry', async () => {
    threadsApi.delete.mockRejectedValueOnce(new Error('offline'))
    show([thread('a', 'Old work', { settledAt: at }), thread('b', 'Other')], 'threads')
    click(host.querySelector('.threads-sidebar-section-settled .threads-sidebar-heading-toggle')!)
    click(host.querySelector('[aria-label="Delete Old work…"]')!)
    click(document.querySelector('[data-testid="archived-delete-confirm"]')!)
    await flush()
    expect(document.querySelector('[data-testid="archived-delete-error"]')?.textContent).toBe('offline')
    expect(document.querySelector('.ui-toast [data-action="undo"], .ui-toast [data-action="retry"]')).toBeNull()
  })
})

describe('the toast', () => {
  it('goes away after its time, but waits while the pointer is on it', async () => {
    vi.useFakeTimers()
    const { showToast } = await import('../../src/renderer/components/ui/Toast')
    act(() => root.render(createElement(ToastHost)))
    act(() => { showToast({ message: 'Archived' }) })
    // React reads pointer enter and leave from pointerover and pointerout.
    act(() => { toast()!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body })) })
    act(() => { vi.advanceTimersByTime(TOAST_MS * 2) })
    expect(toast()).not.toBeNull()
    act(() => { toast()!.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })) })
    act(() => { vi.advanceTimersByTime(TOAST_MS) })
    expect(toast()).toBeNull()
  })
})

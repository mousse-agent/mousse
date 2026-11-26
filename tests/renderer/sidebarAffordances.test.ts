// @vitest-environment jsdom
/**
 * Starting work from the sidebar: each project's "New thread" is always there, the tabs never change width, both
 * tabs end with the same "Archived" footer, the open thread's row is always shown, unsent drafts are marked, and the
 * Projects tab is a tree the keyboard can walk.
 */
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHeadsRequest, GitHeadsResult, Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const actions = vi.hoisted(() => ({
  selectThread: vi.fn(async () => undefined),
  createAndSelectThread: vi.fn(async () => undefined),
  createAndSelectProjectThread: vi.fn(async () => undefined),
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
const { useSidebarShowMoreStore } = await import('../../src/renderer/lib/sidebarShowMore')
const { hasMoreBelow, revealDelta } = await import('../../src/renderer/lib/sidebarScroll')
const { startRenderCounts, stopRenderCounts } = await import('../../src/renderer/chat/components/agent-elements/render-counts')
const { ARCHIVED_FIRST_ROWS } = await import('../../src/renderer/components/sidebar/ArchivedList')

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
  return new Proxy({
    threads: group(threadsApi), projects: group(projectsApi), git: group({ heads: async () => ({ threads: {}, projects: {} }) })
  } as Record<string, unknown>, {
    get: (target, key: string) => target[key] ?? group()
  })
}

const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'sidebarMode', 'composerDrafts'] as const
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
  // Show more outlives a sidebar mount; one test's expanded project must not open the next test's.
  useSidebarShowMoreStore.setState({ groups: new Set() })
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
/** The declarations of a selector's top-level rule. */
const rule = (css: string, selector: string) => {
  const found = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)
  if (!found) throw new Error(`no rule for ${selector}`)
  return found[2]
}
const many = (count: number) => Array.from({ length: count }, (_, index) => thread(`t${index + 1}`, `Thread ${index + 1}`))

describe('starting work', () => {
  it('says "No projects" with an inline Add project when there are none', () => {
    show([], { projects: [] })
    const empty = host.querySelector<HTMLElement>('.threads-sidebar-empty-projects')!
    expect(empty.textContent).toBe('No projects' + 'Add project')
    click(empty.querySelector('button')!)
    // It opens New project, as the title bar's Add project does.
    expect(useAppStore.getState().newProjectOpen).toBe(true)
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

  it('gives No project a "New thread" button that starts a thread with no project, and no menu', () => {
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
  it('label both segments, not only the selected one', () => {
    show([thread('a', 'Fix tests')])
    const labels = [...host.querySelectorAll('[role="tab"] .threads-sidebar-tab-label')].map((label) => label.textContent)
    expect(labels).toEqual(['Threads', 'Chats'])
  })

  it('keep their names as tooltips when the words are hidden', () => {
    show([thread('a', 'Fix tests')])
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs.map((tab) => [tab.title, tab.getAttribute('aria-label')])).toEqual([['Threads', 'Threads'], ['Chats', 'Chats']])
    expect(tabs.map((tab) => tab.classList.contains('active'))).toEqual([true, false])
  })

  it('show the threads by project or as one list under Threads, swapped by the button after the filter, and come back in the view used last', async () => {
    show([thread('a', 'Fix tests')])
    const swap = () => host.querySelector<HTMLButtonElement>('.thread-filter-swap')!
    const shown = () => host.querySelector('.threads-sidebar-section:not([hidden])')!.classList
    expect(shown().contains('threads-sidebar-section-projects')).toBe(true)
    expect(swap().getAttribute('aria-label')).toBe('Show as a list')
    await act(async () => swap().click())
    expect(useAppStore.getState().threadsSidebarView).toBe('threads')
    expect(shown().contains('threads-sidebar-section-feed')).toBe(true)
    expect(swap().getAttribute('aria-label')).toBe('Show by project')
    // The one Threads tab stays selected, and controls the list that shows.
    const threadsTab = host.querySelector<HTMLElement>('[role="tab"][title="Threads"]')!
    expect(threadsTab.classList.contains('active')).toBe(true)
    expect(document.getElementById(threadsTab.getAttribute('aria-controls')!)?.hidden).toBe(false)
    await act(async () => host.querySelector<HTMLElement>('[role="tab"][title="Chats"]')!.click())
    await act(async () => threadsTab.click())
    expect(useAppStore.getState().threadsSidebarView).toBe('threads')
  })

  it('make a bot from the + next to Bots in the Agents tab, which no longer opens Automations', async () => {
    const { ChatsSidebar } = await vi.importActual<typeof import('../../src/renderer/components/chats/ChatsSidebar')>('../../src/renderer/components/chats/ChatsSidebar')
    const html = renderToStaticMarkup(createElement(ChatsSidebar))
    expect(html).toMatch(/<h2>(?:(?!<\/h2>).)*>Bots<(?:(?!<\/h2>).)*<\/h2>/)
    expect(html).toContain('aria-label="New bot"')
    expect(html).not.toContain('aria-label="Open Automations"')
    expect(html).not.toContain('Roster')
    expect(html).not.toContain('Manage agents')
  })
})

describe('the footer', () => {
  it('ends Projects and Threads with Archived only', () => {
    show([thread('a', 'Fix tests'), thread('b', 'Loose', { projectId: undefined }), thread('c', 'Old', { archivedAt: at })])
    expect(headings()).toEqual(['Archived1'])
    act(() => useAppStore.setState({ threadsSidebarView: 'threads' }))
    expect(headings()).toEqual(['Archived1'])
  })

  it('holds archived threads inside Archived, with no Clear all and no Recently deleted', () => {
    show([thread('a', 'Fix tests'), thread('c', 'Old', { archivedAt: at })])
    click(host.querySelector('.threads-sidebar-section-archived .threads-sidebar-heading-toggle')!)
    const archived = host.querySelector('.threads-sidebar-section-archived')!
    expect(archived.querySelector('[data-thread-id="c"]')).not.toBeNull()
    expect(archived.textContent).not.toContain('Clear all')
    expect(host.textContent).not.toContain('Recently deleted')
  })

  it('heads Archived with its count and a chevron that turns while it is open; the whole heading toggles', () => {
    show([thread('a', 'Fix tests'), thread('c', 'Old', { archivedAt: at }), thread('d', 'Older', { archivedAt: at })])
    const archived = host.querySelector<HTMLElement>('.threads-sidebar-section-archived')!
    const toggle = archived.querySelector<HTMLButtonElement>('.threads-sidebar-heading-toggle')!
    expect(archived.querySelectorAll('.threads-sidebar-heading > *')).toHaveLength(1)
    expect(toggle.querySelector('.threads-sidebar-archived-count')?.textContent).toBe('2')
    expect(toggle.querySelector('.threads-sidebar-archived-chevron')).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(archived.classList.contains('expanded')).toBe(true)
    expect(rule(sidebarCss, '.threads-sidebar-section-archived.expanded .threads-sidebar-archived-chevron')).toMatch(/rotate\(90deg\)/)
    expect(rule(sidebarCss, '.app .threads-sidebar-section-archived .threads-sidebar-heading-toggle')).toMatch(/flex:\s*1/)
  })

  it('hides the count when nothing is archived', () => {
    show([thread('a', 'Fix tests')])
    expect(host.querySelector('.threads-sidebar-archived-count')).toBeNull()
    expect(headings()).toEqual(['Archived'])
  })

  it('comes after the lists', () => {
    show([thread('a', 'Fix tests')])
    const scroller = host.querySelector<HTMLElement>('.threads-sidebar-scroll')!
    expect(scroller.dataset.view).toBe('projects')
    expect(scroller.nextElementSibling?.classList.contains('threads-sidebar-footer')).toBe(true)
  })

  it('records the Archived heading height when Archived opens', () => {
    show([thread('a', 'Fix tests'), thread('c', 'Old', { archivedAt: at })])
    click(host.querySelector('.threads-sidebar-section-archived .threads-sidebar-heading-toggle')!)
    expect(host.querySelector<HTMLElement>('.threads-sidebar-footer')!.style.getPropertyValue('--threads-sidebar-archived-head')).toMatch(/px$/)
  })

  // Scrolling, kept focus and the last row's menu need layout: archived-list-electron.test.ts.
  it('builds no archived card while Archived is closed, and opens hundreds with only the first cards drawn', async () => {
    const archived = Array.from({ length: 300 }, (_, index) => thread(`old-${index}`, `Old ${index}`, { archivedAt: at }))
    const counts = startRenderCounts()
    try {
      show([thread('a', 'Fix tests'), ...archived])
      // Another sidebar update while closed builds none either.
      act(() => useAppStore.setState({ threadActivity: {} }))
      expect(Object.keys(counts).filter((name) => name.startsWith('SidebarRow:old-'))).toEqual([])
      expect(host.querySelector('.threads-sidebar-archived-count')?.textContent).toBe('300')
      click(host.querySelector('.threads-sidebar-section-archived .threads-sidebar-heading-toggle')!)
      const drawn = host.querySelectorAll('.threads-sidebar-archived-list [data-thread-id]')
      expect(drawn.length).toBeGreaterThan(0)
      expect(drawn.length).toBeLessThanOrEqual(ARCHIVED_FIRST_ROWS)
      // The menu of a drawn row still acts on the whole list.
      click(byLabel('More actions for Old 0')!)
      click(menuItem('Delete all archived…'))
      await flush()
      expect(document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent).toContain('Delete 300 archived threads?')
    } finally {
      stopRenderCounts()
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

  it('is marked while rows sit below the fold', () => {
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

  it('scrolls a project the person opens under a tall "Needs me" until its first rows show', async () => {
    show(tall(), { projects: [project('p1', 'Mousse'), project('p2', 'Payments')] })
    // A thread that starts waiting joins Needs me once the read of who answers its wait comes back (#1558).
    await act(async () => { useAppStore.setState({ threadActivity: waiting }) })
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
    expect(row('b').closest('.threads-sidebar-other-threads')).not.toBeNull()
    expect(projectRow('No project').getAttribute('aria-expanded')).toBe('true')
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
  it("names every card's branch: its own worktree's, with the branch icon, else its project folder's; none without Git", async () => {
    const status = vi.fn()
    const heads = vi.fn(async (_request: GitHeadsRequest): Promise<GitHeadsResult> => ({
      projects: { repo: { repo: true, branch: 'main' }, plain: { repo: false, branch: null } },
      threads: {
        own: { own: true, branch: 'mousse/fix-parser', generation: 0, lifecycle: 'ready' },
        unmade: { project: true }
      }
    }))
    Object.assign((window as unknown as { mousse: Record<string, unknown> }).mousse, { git: { heads, status } })
    const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)) })
    const card = (id: string) => host.querySelector(`.threads-sidebar-card[data-thread-id="${id}"] .threads-sidebar-card-sub`)
    show([
      thread('own', 'Fix parser', { projectId: 'repo', worktreeEnabled: true }),
      thread('folder', 'Docs', { projectId: 'repo', worktreeEnabled: false }),
      thread('unmade', 'New', { projectId: 'repo' })
    ], { view: 'threads', active: 'own', projects: [project('repo', 'Repo')] })
    await settle()
    expect(card('own')?.textContent).toBe('mousse/fix-parser')
    expect(card('own')?.querySelector('.threads-sidebar-branch-icon')).not.toBeNull()
    expect(card('folder')?.textContent).toBe('main')
    expect(card('folder')?.querySelector('.threads-sidebar-branch-icon')).toBeNull()
    expect(card('unmade')?.textContent).toBe('main')
    expect(heads).toHaveBeenCalledWith({ projectIds: ['repo'], threadIds: expect.arrayContaining(['own', 'unmade']) })
    expect(status).not.toHaveBeenCalled()

    show([thread('plain', 'Notes', { projectId: 'plain' })], { view: 'threads', active: 'plain', projects: [project('plain', 'Plain')] })
    await settle()
    // Nothing to name: the card has no lower line.
    expect(card('plain')).toBeNull()
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

  it("marks a closed project with its threads' state, and drops the mark once it is open", () => {
    show([thread('a', 'Fix tests'), thread('b', 'Ship docs')])
    act(() => useAppStore.setState({ threadActivity: { a: 'awaiting_input', b: 'awaiting_input' } }))
    const mark = () => projectRow().querySelector('[role="img"][aria-label="2 threads need you"]')
    expect(mark()?.textContent).toBe('2')
    click(projectRow())
    expect(projectRow().getAttribute('aria-expanded')).toBe('true')
    expect(mark()).toBeNull()
    // The open project's threads carry their own marks.
    expect(row('a')).not.toBeNull()
    click(projectRow())
    act(() => useAppStore.setState({ threadActivity: { a: 'processing' } }))
    expect(projectRow().querySelector('[role="img"][aria-label="Working"]')).not.toBeNull()
  })

  it("opens and closes a project from its computer badges, which sit after the project's toggle", () => {
    show([thread('a', 'Fix tests')], { projects: [{ ...project('p1', 'Mousse'), node: 'studio' }] })
    const badges = host.querySelector('.threads-sidebar-project-computers')!
    expect(badges.querySelector('.computer-badge')).not.toBeNull()
    expect(projectRow().contains(badges)).toBe(false)
    click(badges)
    expect(projectRow().getAttribute('aria-expanded')).toBe('true')
  })
})

describe('unsent drafts', () => {
  const draft = (drafts: Record<string, string>) => act(() => useAppStore.setState({ composerDrafts: drafts }))
  const rowOf = (id: string) => host.querySelector<HTMLButtonElement>(`[role="tree"] button[data-thread-id="${id}"]`)
  const draftMark = (id: string) => rowOf(id)?.querySelector('[role="img"][aria-label="Unsent draft"]') ?? null
  const chat = thread('n', 'New thread', { startedAt: undefined })

  it('marks a thread whose composer holds text, until the text is sent or cleared; whitespace is not a draft', () => {
    show([thread('a', 'Fix tests'), thread('b', 'Release notes')], { active: 'a' })
    expect(draftMark('a')).toBeNull()
    draft({ a: 'half a thought', b: '  \n ' })
    expect(draftMark('a')?.getAttribute('title')).toBe('Unsent draft')
    expect(draftMark('b')).toBeNull()
    draft({})
    expect(draftMark('a')).toBeNull()
  })

  it('lists a new chat in its project once it has a draft, titled by the draft, below pinned threads; a click opens it', () => {
    show([thread('a', 'Fix tests', { pinnedAt: at }), thread('b', 'Release notes'), chat], { active: 'b' })
    expect(rowOf('n')).toBeNull()
    draft({ n: 'Why does the\nrefund   fail?' })
    const rows = [...host.querySelectorAll<HTMLElement>('[role="tree"] button[data-thread-id]')]
    expect(rows.map((item) => item.dataset.threadId)).toEqual(['a', 'n', 'b'])
    expect(rowOf('n')!.querySelector('.threads-sidebar-thread-name')?.textContent).toBe('Why does the refund fail?')
    expect(draftMark('n')).not.toBeNull()
    click(rowOf('n')!)
    expect(actions.selectThread).toHaveBeenCalledWith('n')
    draft({ n: ' ' })
    expect(rowOf('n')).toBeNull()
  })

  it('gives a new chat nothing to rename, pin, archive, drag or open a menu on', () => {
    show([thread('a', 'Fix tests'), chat], { active: 'a' })
    draft({ n: 'a question' })
    const item = rowOf('n')!
    expect(item.closest('.threads-sidebar-thread-container')!.querySelector('.threads-sidebar-thread-actions')).toBeNull()
    expect(item.draggable).toBe(false)
    key(item, { key: 'F2' })
    act(() => { item.querySelector('.threads-sidebar-thread-name')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(host.querySelector('input:not(.thread-filter-field)')).toBeNull()
    act(() => { item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(document.querySelector('[role="menuitem"]')).toBeNull()
  })

  it('keeps new chats out of the Threads tab', () => {
    show([thread('a', 'Fix tests'), chat], { view: 'threads' })
    draft({ n: 'a question' })
    expect(host.querySelector('[data-thread-id="n"]')).toBeNull()
    expect(host.querySelector('[data-thread-id="a"]')).not.toBeNull()
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
    expect(document.activeElement).toBe(projectRow('No project'))
    key(projectRow('No project'), { key: 'Home' })
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
    show([thread('a', 'Fix tests'), thread('c', 'Old', { archivedAt: at })])
    click(host.querySelector('.threads-sidebar-section-archived .threads-sidebar-heading-toggle')!)
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

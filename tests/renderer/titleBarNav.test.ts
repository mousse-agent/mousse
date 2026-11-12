// @vitest-environment jsdom
/**
 * The title bar's thread navigation: the window's thread history (back, forward, the mouse buttons and
 * the keys), the open thread's path with its overflow and sibling menus, and the setting that turns it
 * off and brings back the in-thread breadcrumb.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))

import { confirmNavigation } from '../../src/renderer/services/navigationGuards'
import {
  attachMouseHistory,
  EMPTY_THREAD_HISTORY,
  goToHistoryIndex,
  historyList,
  pushVisit,
  stepHistory,
  stepTarget,
  trackThreadHistory,
  useThreadHistoryStore,
  type ThreadHistory
} from '../../src/renderer/lib/threadHistory'
import { hiddenSegmentCount, siblingThreads, threadPath } from '../../src/renderer/lib/threadPath'
import { setThreadPathInTitleBar } from '../../src/renderer/lib/threadPathSetting'
import { useSidebarRevealStore } from '../../src/renderer/lib/sidebarReveal'
import { ThreadPathView, TitleBarNav } from '../../src/renderer/components/TitleBarNav'
import { SubagentParentBar } from '../../src/renderer/components/SubagentParentBar'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { COMMANDS, commandAllowedInContext, defaultBindingFor, findConflicts, getCommand, resolveCommand, type CommandContext } from '../../src/shared/commands'
import { getDefaultSettings, normalizeAppearance } from '../../src/shared/settings'
import { searchSettings } from '../../src/renderer/lib/settingsSearch'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = '2026-11-12T10:00:00.000Z'
const thread = (id: string, name: string, extra: Partial<Thread> = {}): Thread => ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, ...extra })
const subagentOf = (parentThreadId: string, rootThreadId: string): Thread['lineage'] => ({ parentThreadId, rootThreadId, relationship: 'subagent' })
const project = (id: string, name: string): Project => ({ id, name, path: `/work/${name}`, createdAt: at } as Project)

const projects = [project('p1', 'acme-web'), project('p2', 'payments-api')]
const threads: Thread[] = [
  thread('t1', 'Fix flaky checkout test', { projectId: 'p1', updatedAt: '2026-11-12T12:00:00.000Z' }),
  thread('t2', 'Refactor router to nested routes', { projectId: 'p1', updatedAt: '2026-11-12T11:00:00.000Z' }),
  thread('t3', 'Add dark mode toggle', { projectId: 'p1', updatedAt: '2026-11-12T09:00:00.000Z' }),
  thread('t4', 'Upgrade Stripe SDK', { projectId: 'p2' }),
  thread('archived', 'Old idea', { projectId: 'p1', settledAt: at }),
  thread('draft', 'New Thread', { projectId: 'p1', startedAt: undefined }),
  thread('s1', 'Audit cart tests', { projectId: 'p1', lineage: subagentOf('t1', 't1') }),
  thread('s1b', 'Audit router tests', { projectId: 'p1', lineage: subagentOf('t1', 't1') }),
  thread('s2', 'Check float asserts', { projectId: 'p1', lineage: subagentOf('s1', 't1') }),
  thread('s3', 'Compare rounding modes in totals', { projectId: 'p1', lineage: subagentOf('s2', 't1') }),
  thread('s4', 'Verify line 19 tolerance', { projectId: 'p1', lineage: subagentOf('s3', 't1') }),
  thread('loose', 'Explain git rebase')
]

type Patch = Partial<ReturnType<typeof useAppStore.getState>>
const initial = useAppStore.getInitialState()
const keys = ['threads', 'projects', 'activeThreadId', 'profileId', 'sidebarMode', 'settingsOpen', 'threadsSidebarOpen', 'threadsSidebarView'] as const
const original = Object.fromEntries(keys.map((key) => [key, initial[key]])) as Patch
/** Server rendering reads the store's initial state, so patch both it and the live state. */
function setStore(patch: Patch) {
  useAppStore.setState(patch)
  Object.assign(initial, patch)
}

let root: Root | null = null
let host: HTMLElement | null = null
function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(element))
  return host
}

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = { threads: { select: vi.fn(async () => undefined) }, platform: 'darwin' }
  setStore({ threads, projects, activeThreadId: null, sidebarMode: 'projects', settingsOpen: false, threadsSidebarOpen: true, threadsSidebarView: 'projects' })
  useThreadHistoryStore.setState(EMPTY_THREAD_HISTORY)
  vi.mocked(confirmNavigation).mockResolvedValue(true)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  root = null
  host = null
  document.body.innerHTML = ''
  setStore(original)
  setThreadPathInTitleBar(true)
})

describe('the thread history', () => {
  const visits = (...ids: string[]): ThreadHistory => ids.reduce((history, id) => pushVisit(history, id), EMPTY_THREAD_HISTORY)
  const all = () => true

  it('records each thread opened, once in a row, and drops what was ahead when a new one opens after going back', () => {
    const history = visits('a', 'b', 'b', 'c')
    expect(history).toEqual({ entries: ['a', 'b', 'c'], index: 2 })
    const back = { ...history, index: 1 }
    expect(pushVisit(back, 'd')).toEqual({ entries: ['a', 'b', 'd'], index: 2 })
    expect(pushVisit(back, 'b')).toBe(back)
  })

  it('keeps the newest visits when it is full', () => {
    expect(pushVisit({ entries: ['a', 'b', 'c'], index: 2 }, 'd', 3)).toEqual({ entries: ['b', 'c', 'd'], index: 2 })
  })

  it('steps back and forward, skipping threads that can no longer be opened and the one the window is on', () => {
    const history = { entries: ['a', 'gone', 'b', 'c', 'b'], index: 4 }
    const canOpen = (id: string) => id !== 'gone'
    expect(stepTarget(history, -1, canOpen)).toBe(3)
    expect(stepTarget({ ...history, index: 2 }, -1, canOpen)).toBe(0)
    expect(stepTarget({ ...history, index: 0 }, -1, canOpen)).toBeNull()
    expect(stepTarget({ ...history, index: 0 }, 1, canOpen)).toBe(2)
    expect(stepTarget(history, 1, canOpen)).toBeNull()
  })

  it('lists where back and forward go, nearest first, each thread once', () => {
    const history = { entries: ['a', 'b', 'gone', 'a', 'c', 'd'], index: 4 }
    const canOpen = (id: string) => id !== 'gone'
    expect(historyList(history, -1, canOpen)).toEqual([{ index: 3, threadId: 'a' }, { index: 1, threadId: 'b' }])
    expect(historyList(history, 1, canOpen)).toEqual([{ index: 5, threadId: 'd' }])
    expect(historyList(history, -1, all).map((entry) => entry.threadId)).toEqual(['a', 'gone', 'b'])
  })

  it('follows the open thread, walks back and forward through it, and skips archived and unstarted threads', async () => {
    const stop = trackThreadHistory()
    try {
      for (const id of ['t1', 'archived', 'draft', 't2', 't3']) useAppStore.setState({ activeThreadId: id })
      expect(useThreadHistoryStore.getState().entries).toEqual(['t1', 'archived', 'draft', 't2', 't3'])
      await stepHistory(-1)
      expect(useAppStore.getState().activeThreadId).toBe('t2')
      await stepHistory(-1)
      expect(useAppStore.getState().activeThreadId).toBe('t1')
      expect(useThreadHistoryStore.getState().index).toBe(0)
      await stepHistory(-1)
      expect(useAppStore.getState().activeThreadId).toBe('t1')
      await stepHistory(1)
      expect(useAppStore.getState().activeThreadId).toBe('t2')
      // Stepping is not a new visit: forward is still there.
      expect(useThreadHistoryStore.getState().entries).toHaveLength(5)
      useAppStore.setState({ activeThreadId: 't4' })
      expect(useThreadHistoryStore.getState().entries).toEqual(['t1', 'archived', 'draft', 't2', 't4'])
    } finally {
      stop()
    }
  })

  it('stays put when the switch is refused to keep unsaved changes', async () => {
    const stop = trackThreadHistory()
    try {
      useAppStore.setState({ activeThreadId: 't1' })
      useAppStore.setState({ activeThreadId: 't2' })
      vi.mocked(confirmNavigation).mockResolvedValue(false)
      await goToHistoryIndex(0)
      expect(useAppStore.getState().activeThreadId).toBe('t2')
      expect(useThreadHistoryStore.getState().index).toBe(1)
    } finally {
      stop()
    }
  })

  it('starts again when the window switches profile', () => {
    const stop = trackThreadHistory()
    try {
      useAppStore.setState({ activeThreadId: 't1' })
      useAppStore.setState({ profileId: 'other', activeThreadId: null })
      expect(useThreadHistoryStore.getState().entries).toEqual([])
    } finally {
      stop()
    }
  })

  it('takes the mouse back and forward buttons on release and leaves the other buttons alone', () => {
    const steps: number[] = []
    const detach = attachMouseHistory(window, (direction) => steps.push(direction))
    const fire = (type: string, button: number) => {
      const event = new MouseEvent(type, { button, bubbles: true, cancelable: true })
      document.body.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(fire('mousedown', 3)).toBe(true)
    expect(fire('mouseup', 3)).toBe(true)
    expect(fire('mouseup', 4)).toBe(true)
    expect(fire('mouseup', 0)).toBe(false)
    expect(fire('mouseup', 1)).toBe(false)
    expect(steps).toEqual([-1, 1])
    detach()
    fire('mouseup', 3)
    expect(steps).toEqual([-1, 1])
  })
})

describe('the back and forward shortcuts', () => {
  const context = (over: Partial<CommandContext> = {}): CommandContext => ({
    platform: 'darwin', inTextInput: false, inTerminal: false, overlay: null, threadOpen: true, runActive: false, mainAreaOpen: false, projectsMode: true, ...over
  })
  const key = (k: string, mods: { meta?: boolean; alt?: boolean; ctrl?: boolean } = {}) => ({
    key: k, code: '', ctrlKey: Boolean(mods.ctrl), metaKey: Boolean(mods.meta), altKey: Boolean(mods.alt), shiftKey: false
  })
  const registered = () => true

  it('are Cmd+[ and Cmd+] on macOS and Alt+Left and Alt+Right elsewhere, in the Go group, rebindable', () => {
    expect(defaultBindingFor('thread.back', 'darwin')).toBe('Cmd+[')
    expect(defaultBindingFor('thread.forward', 'darwin')).toBe('Cmd+]')
    expect(defaultBindingFor('thread.back', 'win32')).toBe('Alt+Left')
    expect(defaultBindingFor('thread.forward', 'linux')).toBe('Alt+Right')
    expect(getCommand('thread.back')).toMatchObject({ title: 'Back', category: 'Go', scope: 'global' })
    expect(getCommand('thread.back').fixed).toBeUndefined()
    expect(resolveCommand(key('[', { meta: true }), {}, context(), registered)).toBe('thread.back')
    expect(resolveCommand(key(']', { meta: true }), {}, context(), registered)).toBe('thread.forward')
    expect(resolveCommand(key('ArrowLeft', { alt: true }), {}, context({ platform: 'win32' }), registered)).toBe('thread.back')
    expect(resolveCommand(key('ArrowRight', { alt: true }), {}, context({ platform: 'linux' }), registered)).toBe('thread.forward')
    expect(resolveCommand(key('ArrowLeft', { alt: true }), { 'thread.back': 'CommandOrControl+Alt+Left' }, context({ platform: 'win32' }), registered)).toBeNull()
  })

  it('never run from a text field, a terminal or the browser surface', () => {
    expect(resolveCommand(key('[', { meta: true }), {}, context({ inTextInput: true, inComposer: true }), registered)).toBeNull()
    expect(resolveCommand(key('[', { meta: true }), {}, context({ inTerminal: true }), registered)).toBeNull()
    expect(getCommand('thread.back').guest).toBe('deny')
    expect(commandAllowedInContext(getCommand('thread.forward'), context())).toBe(true)
  })

  it('clash with no other default', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const clashes = findConflicts({}, platform).filter((conflict) => conflict.kind === 'command' && conflict.commands.some((id) => id === 'thread.back' || id === 'thread.forward'))
      expect(clashes).toEqual([])
    }
    expect(COMMANDS.filter((command) => command.id === 'thread.back' || command.id === 'thread.forward')).toHaveLength(2)
  })
})

describe('the thread path', () => {
  it('is the project and the thread for a project thread', () => {
    expect(threadPath('t1', threads, projects)).toEqual([
      { kind: 'project', id: 'p1', name: 'acme-web' },
      { kind: 'thread', id: 't1', name: 'Fix flaky checkout test', current: true }
    ])
  })

  it('walks a subagent chain up to the thread a person started', () => {
    expect(threadPath('s4', threads, projects).map((segment) => segment.name)).toEqual([
      'acme-web', 'Fix flaky checkout test', 'Audit cart tests', 'Check float asserts', 'Compare rounding modes in totals', 'Verify line 19 tolerance'
    ])
    expect(threadPath('s4', threads, projects).filter((segment) => segment.kind === 'thread' && segment.current).map((segment) => segment.id)).toEqual(['s4'])
  })

  it('leaves out a project that is not listed, a parent that is gone, and invents no parent for other threads', () => {
    expect(threadPath('loose', threads, projects)).toEqual([{ kind: 'thread', id: 'loose', name: 'Explain git rebase', current: true }])
    const orphan = thread('orphan', 'Left behind', { lineage: subagentOf('trashed', 'trashed') })
    expect(threadPath('orphan', [...threads, orphan], projects).map((segment) => segment.id)).toEqual(['orphan'])
    // A forked thread carries no lineage of its own, so it stands alone.
    const fork = thread('fork', 'Fix flaky checkout test (fork)', { projectId: 'p1', createdBy: 't1' } as Partial<Thread>)
    expect(threadPath('fork', [...threads, fork], projects).map((segment) => segment.id)).toEqual(['p1', 'fork'])
    expect(threadPath('missing', threads, projects)).toEqual([])
    expect(threadPath(null, threads, projects)).toEqual([])
  })

  it('stops at a loop in the lineage', () => {
    const loop = [thread('x', 'X', { lineage: subagentOf('y', 'y') }), thread('y', 'Y', { lineage: subagentOf('x', 'x') })]
    expect(threadPath('x', loop, projects).map((segment) => segment.id)).toEqual(['y', 'x'])
  })
})

describe('the path overflow', () => {
  it('keeps every segment when they fit', () => {
    expect(hiddenSegmentCount([60, 120], 30, 400)).toBe(0)
    expect(hiddenSegmentCount([200], 30, 100)).toBe(0)
  })

  it('drops the topmost segments first, into "…"', () => {
    const widths = [70, 160, 110, 130, 210, 150]
    expect(hiddenSegmentCount(widths, 30, 830)).toBe(0)
    expect(hiddenSegmentCount(widths, 30, 829)).toBe(1)
    expect(hiddenSegmentCount(widths, 30, 630)).toBe(2)
    expect(hiddenSegmentCount(widths, 30, 520)).toBe(3)
  })

  it('never hides the current thread: with no room even for it, only "…" and it are left', () => {
    expect(hiddenSegmentCount([70, 160, 110, 150], 30, 120)).toBe(3)
    expect(hiddenSegmentCount([70, 160, 110, 150], 30, 10)).toBe(3)
  })
})

describe('the sibling menu', () => {
  it('lists a top thread’s fellow threads in its project, in sidebar order, without archived, unstarted or subagent threads', () => {
    expect(siblingThreads('t1', threads, projects)).toEqual({
      label: 'Threads in acme-web',
      threads: [
        { id: 't1', name: 'Fix flaky checkout test' },
        { id: 't2', name: 'Refactor router to nested routes' },
        { id: 't3', name: 'Add dark mode toggle' }
      ]
    })
  })

  it('lists a subagent’s fellow subagents of the same parent', () => {
    const menu = siblingThreads('s1', threads, projects)
    expect(menu?.label).toBe('Subagents of Fix flaky checkout test')
    expect(menu?.threads.map((entry) => entry.id).sort()).toEqual(['s1', 's1b'])
    expect(siblingThreads('s4', threads, projects)?.threads.map((entry) => entry.id)).toEqual(['s4'])
  })

  it('lists the other threads without a project, and leaves out Chats threads', () => {
    const chat = thread('chat', 'Agent chat')
    expect(siblingThreads('loose', [...threads, chat], projects, new Set(['chat']))).toEqual({ label: 'Other threads', threads: [{ id: 'loose', name: 'Explain git rebase' }] })
  })
})

describe('the title bar navigation', () => {
  it('shows ← →, then the project and the current thread brightest with its caret', () => {
    setStore({ activeThreadId: 't1' })
    const html = renderToStaticMarkup(createElement(TitleBarNav))
    expect(html).toContain('aria-label="Back"')
    expect(html).toContain('aria-label="Forward"')
    expect(html).toContain('aria-label="Thread path"')
    expect(html).toMatch(/data-segment="project"[^]*acme-web/)
    expect(html).toMatch(/is-current[^"]*" data-segment="current"[^]*aria-current="page"[^]*Fix flaky checkout test/)
  })

  it('hides the topmost ancestors behind "…" and keeps the current thread', () => {
    const html = renderToStaticMarkup(createElement(ThreadPathView, { segments: threadPath('s4', threads, projects), hidden: 2 }))
    expect(html).toContain('aria-label="Show 2 more"')
    expect(html).not.toContain('acme-web')
    expect(html).not.toContain('>Fix flaky checkout test<')
    expect(html).toContain('Audit cart tests')
    expect(html).toContain('Verify line 19 tolerance')
    // Each shown ancestor's "/" is a button that lists the threads beside it.
    expect(html.match(/aria-label="Threads beside /g)).toHaveLength(3)
  })

  it('opens an ancestor, shows the project, and lists the threads beside the current one', async () => {
    const stop = trackThreadHistory()
    try {
      setStore({ activeThreadId: 's1' })
      const view = mount(createElement(TitleBarNav))
      const segment = (name: string) => [...view.querySelectorAll<HTMLButtonElement>('nav[aria-label="Thread path"] button')].find((button) => button.textContent === name)!

      await act(async () => segment('Fix flaky checkout test').click())
      expect(useAppStore.getState().activeThreadId).toBe('t1')

      act(() => useAppStore.setState({ threadsSidebarOpen: false, threadsSidebarView: 'threads' }))
      act(() => segment('acme-web').click())
      expect(useAppStore.getState()).toMatchObject({ threadsSidebarOpen: true, threadsSidebarView: 'projects' })
      expect(useSidebarRevealStore.getState().project?.projectId).toBe('p1')

      act(() => view.querySelector<HTMLButtonElement>('[data-segment="current"] button')!.click())
      const menu = document.querySelector('.titlebar-nav-menu')!
      expect(menu.querySelector('.threads-context-menu-label')?.textContent).toBe('Threads in acme-web')
      const rows = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      expect(rows.map((row) => row.textContent)).toEqual(['Fix flaky checkout test', 'Refactor router to nested routes', 'Add dark mode toggle'])
      expect(rows[0]!.getAttribute('aria-checked')).toBe('true')
      await act(async () => rows[1]!.click())
      expect(useAppStore.getState().activeThreadId).toBe('t2')
      expect(document.querySelector('.titlebar-nav-menu')).toBeNull()

      // Back now goes to t1; its list names where back leads, newest first.
      const back = view.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!
      expect(back.disabled).toBe(false)
      expect(view.querySelector<HTMLButtonElement>('button[aria-label="Forward"]')!.disabled).toBe(true)
      act(() => { back.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
      const list = document.querySelector('.titlebar-nav-menu')!
      expect(list.querySelector('.threads-context-menu-label')?.textContent).toBe('Back')
      expect([...list.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual(['Fix flaky checkout testacme-web', 'Audit cart testsacme-web'])
    } finally {
      stop()
    }
  })

  it('is gone when the setting is off, and the subagent breadcrumb comes back', () => {
    setStore({ activeThreadId: 's2' })
    setThreadPathInTitleBar(true)
    expect(renderToStaticMarkup(createElement(TitleBarNav))).toContain('Thread path')
    const onBar = renderToStaticMarkup(createElement(SubagentParentBar))
    expect(onBar).not.toContain('subagent-breadcrumb')
    expect(onBar).toContain('Subagent of Audit cart tests')

    setThreadPathInTitleBar(false)
    expect(renderToStaticMarkup(createElement(TitleBarNav))).toBe('')
    const offBar = renderToStaticMarkup(createElement(SubagentParentBar))
    expect(offBar).toContain('subagent-breadcrumb')
    expect(offBar).toContain('title="Open Audit cart tests"')
    expect(offBar).toContain('Subagent of Audit cart tests')
  })
})

describe('the setting', () => {
  it('is on by default and kept as saved', () => {
    expect(getDefaultSettings().appearance.threadPathInTitleBar).toBe(true)
    expect(normalizeAppearance({}).threadPathInTitleBar).toBe(true)
    expect(normalizeAppearance({ threadPathInTitleBar: false }).threadPathInTitleBar).toBe(false)
  })

  it('is found by the settings search', () => {
    const pages = [{ id: 'appearance' as const, label: 'Appearance', keywords: [] }]
    expect(searchSettings('thread path', pages)[0]).toEqual({ title: 'Thread path in title bar', section: 'appearance', anchor: 'appearance-thread-path' })
    expect(searchSettings('breadcrumb', pages)[0]?.anchor).toBe('appearance-thread-path')
  })
})

/**
 * Which threads need the person: the "Needs me" group at the top of the Projects and Threads views, the
 * state of a project row, and the count on the titlebar's sidebar toggle while the sidebar is closed.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadsSidebar } from '../../src/renderer/components/ThreadsSidebar'
import { TitleBar } from '../../src/renderer/components/TitleBar'
import { needsMeThreads } from '../../src/renderer/lib/needsMe'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { Project, Thread, ThreadActivitySnapshot } from '../../src/shared/types'

// The window buttons read the platform from the preload, which server rendering has none of.
vi.mock('../../src/renderer/components/WindowCaptionButtons', () => ({ WindowCaptionButtons: () => null }))

const at = (minute: number) => `2026-11-05T10:${String(minute).padStart(2, '0')}:00.000Z`
const project = (id: string, name: string): Project => ({ id, name, path: `/p/${name}`, createdAt: at(0), order: 0 })
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name, createdAt: at(0), updatedAt: at(0), order: 0, startedAt: at(0), ...over })

type AppPatch = Partial<ReturnType<typeof useAppStore.getState>>
const appInitial = useAppStore.getInitialState()
const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'threadsSidebarOpen'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, appInitial[key]])) as AppPatch

/** Server rendering reads the store's initial state, so patch both it and the live state. */
function setStore(app: AppPatch) {
  useAppStore.setState(app)
  Object.assign(appInitial, app)
}
afterEach(() => {
  useAppStore.setState(appOriginal)
  Object.assign(appInitial, appOriginal)
})

const sidebar = () => renderToStaticMarkup(createElement(ThreadsSidebar))
const titleBar = () => renderToStaticMarkup(createElement(TitleBar))
const needsMeSection = (html: string) => html.match(/<section class="threads-sidebar-needs-me"[\s\S]*?<\/section>/)?.[0] ?? ''
const titlesIn = (html: string) => [...html.matchAll(/class="threads-sidebar-card-title">(?:<svg[\s\S]*?<\/svg>)?([^<]*)</g)].map((match) => match[1])

const projects = [project('p1', 'Mousse'), project('p2', 'Website')]
const threads = [
  thread('a', 'Fix tests', { projectId: 'p1', updatedAt: at(1) }),
  thread('b', 'Ship docs', { projectId: 'p2', updatedAt: at(5) }),
  thread('c', 'Refactor', { projectId: 'p1', updatedAt: at(3) }),
  thread('d', 'Archived question', { projectId: 'p1', settledAt: at(4) })
]
const waiting: ThreadActivitySnapshot = { a: 'awaiting_input', b: 'awaiting_input', c: 'processing', d: 'awaiting_input' }

describe('needsMeThreads', () => {
  it('lists the threads that wait for the person, newest first, across projects', () => {
    expect(needsMeThreads(threads, waiting).map((entry) => entry.id)).toEqual(['b', 'a'])
  })

  it('counts a parent once when a subagent below it waits, and never the subagent itself', () => {
    const withChild = [...threads, thread('child', 'Reviewer', { projectId: 'p1', lineage: { parentThreadId: 'c', rootThreadId: 'c', relationship: 'subagent' } })]
    expect(needsMeThreads(withChild, { child: 'awaiting_input' }).map((entry) => entry.id)).toEqual(['c'])
  })

  it('leaves out drafts, archived threads and threads another list shows', () => {
    const draft = thread('draft', 'New Chat', { startedAt: undefined })
    expect(needsMeThreads([...threads, draft], { ...waiting, draft: 'awaiting_input' }, new Set(['b'])).map((entry) => entry.id)).toEqual(['a'])
  })
})

describe('the Needs me group', () => {
  it('sits at the top of the Projects view with every waiting thread, newest first', () => {
    setStore({ projects, threads, threadActivity: waiting, threadsSidebarView: 'projects' })
    const html = sidebar()
    const group = needsMeSection(html)
    expect(group).toContain('Needs me · 2<')
    expect(group).toContain('aria-label="2 threads need you"')
    expect(titlesIn(group)).toEqual(['Ship docs', 'Fix tests'])
    expect(html.indexOf('threads-sidebar-needs-me')).toBeLessThan(html.indexOf('threads-sidebar-project"'))
  })

  it('sits at the top of the Threads view too', () => {
    setStore({ projects, threads, threadActivity: waiting, threadsSidebarView: 'threads' })
    const html = sidebar()
    expect(titlesIn(needsMeSection(html))).toEqual(['Ship docs', 'Fix tests'])
    expect(html.indexOf('threads-sidebar-needs-me')).toBeLessThan(html.indexOf('threads-sidebar-thread-feed"'))
  })

  it('is hidden when nothing waits', () => {
    setStore({ projects, threads, threadActivity: { c: 'processing' }, threadsSidebarView: 'projects' })
    expect(sidebar()).not.toContain('threads-sidebar-needs-me')
  })

  it('is hidden when there is only one thread', () => {
    setStore({ projects, threads: [threads[0]], threadActivity: { a: 'awaiting_input' }, threadsSidebarView: 'threads' })
    expect(sidebar()).not.toContain('threads-sidebar-needs-me')
  })

  it('does not let its rows be dragged', () => {
    setStore({ projects, threads, threadActivity: waiting, threadsSidebarView: 'projects' })
    expect(needsMeSection(sidebar())).toContain('draggable="false"')
  })
})

describe('the project row', () => {
  it('shows a dot for the worst thread state and, while closed, how many threads need the person', () => {
    setStore({ projects, threads, threadActivity: { a: 'awaiting_input', c: 'awaiting_input' }, threadsSidebarView: 'projects' })
    const html = sidebar()
    expect(html).toContain('class="threads-sidebar-project-status threads-sidebar-project-status--needs-me" role="img" aria-label="2 threads need you"')
    expect(html).toContain('class="threads-sidebar-project-count" aria-hidden="true">2<')
  })

  it('shows a working state, and nothing for a quiet project', () => {
    setStore({ projects, threads, threadActivity: { c: 'processing' }, threadsSidebarView: 'projects' })
    expect(sidebar()).toContain('threads-sidebar-project-status--working" role="img" aria-label="Working"')
    setStore({ projects, threads, threadActivity: {}, threadsSidebarView: 'projects' })
    expect(sidebar()).not.toContain('threads-sidebar-project-status')
    expect(sidebar()).not.toContain('threads-sidebar-project-finished')
  })

  it('counts the threads that finished unseen after the name, with no dot', () => {
    setStore({ projects, threads, threadActivity: { a: 'completed', c: 'completed', b: 'completed' }, threadsSidebarView: 'projects' })
    const html = sidebar()
    expect(html).toContain('Mousse</span><span class="threads-sidebar-project-finished" role="img" aria-label="2 finished" title="2 finished">2</span>')
    expect(html).toContain('aria-label="1 finished" title="1 finished">1</span>')
    expect(html).not.toContain('threads-sidebar-project-status')
  })

  it('keeps the needs-me dot beside the finished count', () => {
    setStore({ projects, threads, threadActivity: { a: 'completed', c: 'awaiting_input' }, threadsSidebarView: 'projects' })
    const html = sidebar()
    expect(html).toContain('aria-label="1 finished" title="1 finished">1</span><span class="threads-sidebar-project-status threads-sidebar-project-status--needs-me"')
  })

  it('stays bright while it counts finished threads, as do those rows, until they are seen', () => {
    const css = readFileSync(new URL('../../src/renderer/styles/threads-sidebar.css', import.meta.url), 'utf8')
    const lit = css.match(/([^{}]*)\{\s*--sidebar-row-dim: 1;\s*\}/)?.[1] ?? ''
    expect(lit).toContain('.threads-sidebar-project-row:has(.threads-sidebar-project-finished)')
    expect(lit).toContain(':is(.threads-sidebar-status-icon--completed, .threads-sidebar-card-status-done)')
    // Seeing the thread clears its finished state, and the header goes back to the focus dimming.
    setStore({ projects, threads, threadActivity: { a: 'completed' }, activeThreadId: 'b', threadsSidebarView: 'projects' })
    expect(sidebar()).toContain('threads-sidebar-project-finished')
    setStore({ projects, threads, threadActivity: {}, activeThreadId: 'b', threadsSidebarView: 'projects' })
    expect(sidebar()).not.toContain('threads-sidebar-project-finished')
  })
})

describe('the sidebar toggle', () => {
  it('carries the count while the sidebar is closed', () => {
    setStore({ projects, threads, threadActivity: waiting, threadsSidebarOpen: false })
    const html = titleBar()
    expect(html).toContain('class="titlebar-attention-badge" aria-hidden="true">2<')
    // The count is in the toggle's accessible label; the rest of the wording belongs to the title bar.
    const toggle = html.match(/<button[^>]*titlebar-sidebar-toggle[^>]*>/)?.[0] ?? ''
    expect(toggle.match(/aria-label="([^"]*)"/)?.[1]).toMatch(/(^|\D)2(\D|$)/)
    // The badge is part of the toggle button, placed against the button and not the rail width.
    expect(html).toMatch(/<button[^>]*titlebar-sidebar-toggle--badged[^>]*>(?:(?!<\/button>)[\s\S])*titlebar-attention-badge/)
    const css = readFileSync(new URL('../../src/renderer/styles/app.css', import.meta.url), 'utf8')
    const badge = css.match(/\.titlebar-attention-badge\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(badge).not.toMatch(/navigation-rail-width|titlebar-height/)
    expect(css).toMatch(/\.titlebar-sidebar-toggle\s*\{[^}]*position:\s*relative/)
    // One placement: inside the button's corner, so it never reaches a neighbouring button.
    expect(badge).toMatch(/top:\s*1px/)
    expect(badge).toMatch(/right:\s*1px/)
  })

  it('has no badge while the sidebar is open or nothing waits', () => {
    setStore({ projects, threads, threadActivity: waiting, threadsSidebarOpen: true })
    expect(titleBar()).not.toContain('titlebar-attention-badge')
    setStore({ projects, threads, threadActivity: {}, threadsSidebarOpen: false })
    expect(titleBar()).not.toContain('titlebar-attention-badge')
  })
})

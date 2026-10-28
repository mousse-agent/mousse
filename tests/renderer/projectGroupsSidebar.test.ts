/**
 * The Projects view when a project is on several computers: one group for the repository, a group of its own
 * for a project only another computer has, and the computer named wherever a row or a group is on one.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadsContextMenu } from '../../src/renderer/components/ThreadsContextMenu'
import { ThreadsSidebar } from '../../src/renderer/components/ThreadsSidebar'
import { useComputersStore } from '../../src/renderer/lib/computers'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { Project, Thread } from '../../src/shared/types'

// Server rendering has no document to portal into, so the menu renders in place.
vi.mock('../../src/renderer/lib/floatingLayer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/lib/floatingLayer')>()),
  FloatingPortal: ({ children }: { children: unknown }) => children
}))
// Recently deleted reads the daemon and is not what these tests are about.
vi.mock('../../src/renderer/components/sidebar/RecentlyDeletedSection', () => ({ RecentlyDeletedSection: () => null }))

const at = '2026-10-25T10:00:00.000Z'
const B ='nod_studio'
const project = (id: string, name: string, over: Partial<Project> = {}): Project => ({ id, name, path: `/p/${name}`, createdAt: at, order: 0, ...over })
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread => ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, ...over })

type AppPatch = Partial<ReturnType<typeof useAppStore.getState>>
const appInitial = useAppStore.getInitialState()
const appKeys = ['projects', 'threads', 'activeThreadId', 'threadsSidebarView'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, appInitial[key]])) as AppPatch
const computersInitial = useComputersStore.getInitialState()

/** Server rendering reads each store's initial state, so patch both it and the live state. */
function setStores(app: AppPatch, computers: { online: boolean } | null = { online: true }) {
  useAppStore.setState(app)
  Object.assign(appInitial, app)
  const next = {
    loaded: true,
    routed: true,
    byNode: computers ? { [B]: { node: B, name: 'Studio', online: computers.online } } : {},
    devices: []
  }
  useComputersStore.setState(next)
  Object.assign(computersInitial, next)
}
afterEach(() => {
  useAppStore.setState(appOriginal)
  Object.assign(appInitial, appOriginal)
  const none = { loaded: false, routed: false, byNode: {}, devices: [] }
  useComputersStore.setState(none)
  Object.assign(computersInitial, none)
})

const render = () => renderToStaticMarkup(createElement(ThreadsSidebar))
const groups = (html: string) => html.match(/class="threads-sidebar-project"/g)?.length ?? 0
const names = (html: string) => [...html.matchAll(/class="threads-sidebar-project-name">([^<]*)</g)].map((match) => match[1])

describe('the Projects view with a project on several computers', () => {
  const projects = [
    project('p1', 'Mousse'),
    project('p2', 'Notes'),
    project(`${B}:b1`, 'mousse-on-studio', { node: B, sameAs: 'p1', order: 1000 }),
    project(`${B}:b2`, 'Studio only', { node: B, order: 1001 })
  ]
  const threads = [
    thread('t1', 'Local thread', { projectId: 'p1' }),
    thread(`${B}:r1`, 'Remote thread', { projectId: `${B}:b1`, node: B })
  ]

  it('lists one group for the repository, named as this computer names it, and the project only the other computer has beside it', () => {
    setStores({ projects, threads, threadsSidebarView: 'projects' })
    const html = render()
    expect(groups(html)).toBe(3)
    expect(names(html)).toEqual(['Mousse', 'Notes', 'Studio only'])
    expect(html).not.toContain('mousse-on-studio')
  })

  it('marks the group by the other computers that hold it, and a project only they have by name', () => {
    setStores({ projects, threads, threadsSidebarView: 'projects' })
    const html = render()
    // The group of this computer's project: an icon that says where else it is.
    expect(html).toContain('title="Also on Studio"')
    // A project that only the other computer has says it is on it.
    expect(html).toContain('title="On Studio"')
    expect(html).toContain('computer-badge-name">Studio<')
  })

  it('keeps the group, marked, while the other computer is offline', () => {
    setStores({ projects: projects.map((entry) => (entry.node ? { ...entry, offline: true as const } : entry)), threads, threadsSidebarView: 'projects' }, { online: false })
    const html = render()
    expect(groups(html)).toBe(3)
    expect(html).toContain('title="Also on Studio · Offline"')
    expect(html).toContain('title="On Studio · Offline"')
  })

  it('does not group by a weak match, and says nothing of one', () => {
    setStores({ projects: [project('p1', 'Mousse'), project(`${B}:b1`, 'Fork', { node: B, similarTo: 'p1' })], threads: [], threadsSidebarView: 'projects' })
    const html = render()
    expect(names(html)).toEqual(['Mousse', 'Fork'])
    expect(html).not.toContain('Also on')
  })

  it('shows the group’s project name on a thread card of another computer, in the Threads view', () => {
    setStores({ projects, threads, threadsSidebarView: 'threads' })
    const html = render()
    expect(html).toContain('threads-sidebar-card-project">Mousse<')
    expect(html).not.toContain('mousse-on-studio')
    expect(html).toContain('computer-badge-name">Studio<')
  })
})

describe('the menu of a project group', () => {
  const menu = (target: Parameters<typeof ThreadsContextMenu>[0]['target']) =>
    renderToStaticMarkup(
      createElement(ThreadsContextMenu, {
        x: 0,
        y: 0,
        target,
        onClose: () => undefined,
        onPin: () => undefined,
        onSettle: () => undefined,
        onRegenerateTitle: () => undefined,
        onRename: () => undefined,
        onRemove: () => undefined,
        onTrustGitSettings: () => undefined
      })
    )

  it('says which computer a project of another computer is on', () => {
    const html = menu({ type: 'project', id: `${B}:b2`, name: 'Studio only', pinned: false, node: B, computerName: 'Studio' })
    expect(html).toContain('On Studio')
    expect(html).not.toContain('Trust Git settings again')
  })

  it('says that removing a project of this computer leaves the other computers’ projects', () => {
    const html = menu({ type: 'project', id: 'p1', name: 'Mousse', pinned: false, alsoOn: ['Studio', 'Desk'] })
    expect(html).toContain('Removes the project from this computer only. Studio and Desk keep theirs.')
    expect(html).not.toContain('threads-context-menu-label')
    expect(menu({ type: 'project', id: 'p1', name: 'Mousse', pinned: false, alsoOn: ['Studio'] })).toContain('Studio keeps theirs.')
  })

  it('has no note for a project that is only on this computer, or for a thread', () => {
    const own = menu({ type: 'project', id: 'p2', name: 'Notes', pinned: false })
    expect(own).not.toContain('Removes the project')
    expect(own).not.toContain('threads-context-menu-label')
    expect(menu({ type: 'thread', id: 't1', name: 'Thread', pinned: false })).not.toContain('Removes the project')
  })
})

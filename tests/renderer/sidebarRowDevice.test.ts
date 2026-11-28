// @vitest-environment jsdom
/**
 * What a thread's lower line names. In the Projects view, a row of a project on several computers names the computer
 * it runs on (this one by name too) in its branch's place; a row of a project on one computer names its branch. In
 * the Threads view, once there are other computers, a card names both: the computer, then the branch.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/StartFromPullRequestDialog', () => ({ StartFromPullRequestDialog: () => null }))
vi.mock('../../src/renderer/components/profiles/ProfileSwitcher', () => ({ ProfileSwitcher: () => null }))
vi.mock('../../src/renderer/components/chats/ChatsSidebar', () => ({ ChatsSidebar: () => null }))
// Every thread on a branch, so the test sees where the branch shows and where it does not.
vi.mock('../../src/renderer/hooks/useThreadBranch', () => ({ useThreadBranch: () => ({ branch: 'feature/rows', worktree: false }) }))

const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useComputersStore } = await import('../../src/renderer/lib/computers')

const at = '2026-11-18T10:00:00.000Z'
const B = 'nod_studio'
const project = (id: string, name: string, over: Partial<Project> = {}): Project => ({ id, name, path: `/p/${name}`, createdAt: at, order: 0, ...over })
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread => ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, ...over })

const projects = [
  project('p1', 'Mousse'),
  project('p2', 'Notes', { order: 1 }),
  project(`${B}:b1`, 'mousse-on-studio', { node: B, sameAs: 'p1', order: 1000 })
]
const threads = [
  thread('t1', 'Local thread', { projectId: 'p1' }),
  thread(`${B}:r1`, 'Remote thread', { projectId: `${B}:b1`, node: B }),
  thread('t2', 'Notes thread', { projectId: 'p2' })
]

function preload(): unknown {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
  const group = () => new Proxy({}, { get: (_target, key: string) => call(key) })
  return new Proxy({ git: {} } as Record<string, unknown>, { get: (target, key: string) => target[key] ?? group() })
}

const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'sidebarMode', 'appInfo'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getInitialState()[key]]))
const computersOriginal = useComputersStore.getInitialState()

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = preload()
  useComputersStore.setState({ loaded: true, routed: true, byNode: { [B]: { node: B, name: 'Studio', online: true } }, devices: [] } as never)
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(appOriginal)
  useComputersStore.setState(computersOriginal)
})

function mount(view: 'projects' | 'threads') {
  useAppStore.setState({ projects, threads, threadActivity: {}, activeThreadId: null, threadsSidebarView: view, sidebarMode: 'projects', appInfo: { deviceName: 'Laptop' } as never })
  root = createRoot(host)
  act(() => root.render(createElement(ThreadsSidebar)))
  for (const toggle of host.querySelectorAll<HTMLButtonElement>('.threads-sidebar-project-toggle'))
    if (toggle.getAttribute('aria-expanded') !== 'true') act(() => toggle.click())
}

/** The text of a thread's lower line(s), by its title: on a tree row, or on a Threads view card. */
function lowerText(name: string, on: 'row' | 'card' = 'row'): string {
  const rows = host.querySelectorAll<HTMLElement>(on === 'card' ? '.threads-sidebar-card[data-thread-id]' : '.threads-sidebar-thread:not(.threads-sidebar-card)[data-thread-id]')
  const row = [...rows].find((item) => item.textContent?.includes(name))!
  return [...row.querySelectorAll('.threads-sidebar-thread-sub, .threads-sidebar-card-sub')].map((line) => line.textContent).join(' | ')
}

it('names the computer in the branch’s place on the rows of a project on several computers, this one included', () => {
  mount('projects')
  expect(lowerText('Local thread')).toContain('Laptop')
  expect(lowerText('Local thread')).not.toContain('feature/rows')
  expect(lowerText('Remote thread')).toContain('Studio')
  expect(lowerText('Remote thread')).not.toContain('feature/rows')
})

it('names the branch on the rows of a project on one computer', () => {
  mount('projects')
  expect(lowerText('Notes thread')).toContain('feature/rows')
  expect(lowerText('Notes thread')).not.toContain('Laptop')
})

it('names both on a Threads view card, the computer on a line of its own', () => {
  mount('threads')
  expect(lowerText('Local thread', 'card')).toBe('Laptop | feature/rows')
  expect(lowerText('Remote thread', 'card')).toBe('Studio | feature/rows')
  expect(lowerText('Notes thread', 'card')).toBe('Laptop | feature/rows')
})

// @vitest-environment jsdom
/**
 * A project's Show more, and which projects are open, stay chosen when the sidebar closes and opens again:
 * closing unmounts it, and the hover peek is a separate mount.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/StartFromPullRequestDialog', () => ({ StartFromPullRequestDialog: () => null }))
vi.mock('../../src/renderer/components/profiles/ProfileSwitcher', () => ({ ProfileSwitcher: () => null }))
vi.mock('../../src/renderer/components/chats/ChatsSidebar', () => ({ ChatsSidebar: () => null }))

const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useSidebarOpenStore } = await import('../../src/renderer/lib/sidebarOpen')
const { useSidebarShowMoreStore } = await import('../../src/renderer/lib/sidebarShowMore')

const at = '2026-11-18T10:00:00.000Z'
const projects: Project[] = [
  { id: 'p1', name: 'Mousse', path: '/p/Mousse', createdAt: at, order: 0 },
  { id: 'p2', name: 'Site', path: '/p/Site', createdAt: at, order: 1 }
]
const threads: Thread[] = Array.from({ length: 8 }, (_, i) =>
  ({ id: `t${i}`, name: `Thread ${i}`, createdAt: at, updatedAt: at, order: i, startedAt: at, projectId: 'p1' }))

function preload(): unknown {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
  const group = () => new Proxy({}, { get: (_target, key: string) => call(key) })
  return new Proxy({ git: {} } as Record<string, unknown>, { get: (target, key: string) => target[key] ?? group() })
}

const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'sidebarMode'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getInitialState()[key]]))

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = preload()
  useAppStore.setState({ projects, threads, threadActivity: {}, activeThreadId: null, threadsSidebarView: 'projects', sidebarMode: 'projects' })
  useSidebarOpenStore.setState({ groups: new Set(), archived: false })
  useSidebarShowMoreStore.setState({ groups: new Set() })
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(appOriginal)
})

function render() {
  root = createRoot(host)
  act(() => root.render(createElement(ThreadsSidebar)))
}

const toggles = () => [...host.querySelectorAll<HTMLButtonElement>('.threads-sidebar-project-toggle')]
const openStates = () => toggles().map((toggle) => toggle.getAttribute('aria-expanded'))

function mount() {
  render()
  const toggle = toggles()[0]!
  if (toggle.getAttribute('aria-expanded') !== 'true') act(() => toggle.click())
}

const showMore = () => host.querySelector<HTMLButtonElement>('.threads-sidebar-show-more')!

it('keeps a project showing all its threads after the sidebar closes and opens again', () => {
  mount()
  expect(showMore().textContent).toBe('Show more')
  act(() => showMore().click())
  expect(showMore().textContent).toBe('Show less')

  act(() => root.unmount())
  mount()
  expect(showMore().textContent).toBe('Show less')
})

it('keeps the projects the person opened open after the sidebar closes and opens again from a new thread', () => {
  // No active thread, as on a new thread's page: nothing reveals a project on its own.
  render()
  expect(openStates().every((state) => state === 'false')).toBe(true)
  act(() => toggles()[1]!.click())
  const chosen = openStates()
  expect(chosen.filter((state) => state === 'true')).toHaveLength(1)

  act(() => root.unmount())
  render()
  expect(openStates()).toEqual(chosen)
})

it('keeps Archived open after the sidebar closes and opens again', () => {
  render()
  const archived = () => host.querySelector<HTMLButtonElement>('.threads-sidebar-section-archived .threads-sidebar-heading-toggle')!
  expect(archived().getAttribute('aria-expanded')).toBe('false')
  act(() => archived().click())
  expect(archived().getAttribute('aria-expanded')).toBe('true')

  act(() => root.unmount())
  render()
  expect(archived().getAttribute('aria-expanded')).toBe('true')
})

// @vitest-environment jsdom
/**
 * A project's Show more stays chosen when the sidebar closes and opens again: closing unmounts it, and the
 * hover peek is a separate mount.
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

const at = '2026-11-18T10:00:00.000Z'
const projects: Project[] = [{ id: 'p1', name: 'Mousse', path: '/p/Mousse', createdAt: at, order: 0 }]
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
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(appOriginal)
})

function mount() {
  root = createRoot(host)
  act(() => root.render(createElement(ThreadsSidebar)))
  const toggle = host.querySelector<HTMLButtonElement>('.threads-sidebar-project-toggle')!
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

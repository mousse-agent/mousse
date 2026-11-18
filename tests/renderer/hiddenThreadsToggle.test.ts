// @vitest-environment jsdom
/**
 * The sidebar's eye shows or hides, all at once, the threads the owner's bots started, also those a bot keeps out of the
 * sidebar (`Thread.hidden`). It is there only while such a thread exists, it is a view preference of the profile that
 * lasts across a remount, and it never unhides a thread. How a shown hidden row looks is checked in the real app.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/lib/threadActions', () => ({
  selectThread: vi.fn(async () => undefined),
  createAndSelectThread: vi.fn(async () => undefined),
  createAndSelectProjectThread: vi.fn(async () => undefined)
}))
vi.mock('../../src/renderer/components/StartFromPullRequestDialog', () => ({ StartFromPullRequestDialog: () => null }))
vi.mock('../../src/renderer/components/profiles/ProfileSwitcher', () => ({ ProfileSwitcher: () => null }))
vi.mock('../../src/renderer/components/chats/ChatsSidebar', () => ({ ChatsSidebar: () => null }))

const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

const at = '2026-11-05T10:00:00.000Z'
const project: Project = { id: 'p1', name: 'Mousse', path: '/p/Mousse', createdAt: at, order: 0 }
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, projectId: 'p1', ...over })
const botStarted = (id: string, name: string, hidden = true) =>
  thread(id, name, { ...(hidden ? { hidden: true } : {}), createdByThreadId: 'bot-chat', startedByBot: { botId: 'b1', name: 'Alpha' } })

const request = vi.fn(async () => undefined)
function preload(): unknown {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : request)
  const group = () => new Proxy({}, { get: (_target, key: string) => call(key) })
  return new Proxy({}, { get: () => group() })
}

const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'sidebarMode', 'profileId'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getInitialState()[key]]))

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = preload()
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(appOriginal)
  vi.clearAllMocks()
})

function show(threads: Thread[], profileId = 'prof-a') {
  useAppStore.setState({ projects: [project], threads, threadActivity: {}, activeThreadId: null, threadsSidebarView: 'projects', sidebarMode: 'projects', profileId })
  act(() => root.render(createElement(ThreadsSidebar)))
  // Open the project so its threads are rows.
  const toggle = [...host.querySelectorAll<HTMLButtonElement>('.threads-sidebar-project-toggle')].find((item) => item.textContent?.includes('Mousse'))!
  if (toggle.getAttribute('aria-expanded') !== 'true') act(() => toggle.click())
}

const eye = () => host.querySelector<HTMLButtonElement>('button[aria-label*="bot threads"]')
const row = (id: string) => host.querySelector<HTMLElement>(`[role="tabpanel"]:not([hidden]) button[data-thread-id="${id}"]`)

describe('the hidden bot threads eye', () => {
  it('is absent while no bot started a thread', () => {
    show([thread('t1', 'Plain')])
    expect(row('t1')).not.toBeNull()
    expect(eye()).toBeNull()
  })

  it('hides the threads a bot started and left in the sidebar, and shows them again', () => {
    show([thread('t1', 'Plain'), botStarted('b1', 'Project job', false)])
    expect(row('b1')).not.toBeNull()
    expect(eye()!.getAttribute('aria-label')).toBe('Hide bot threads')

    act(() => eye()!.click())
    expect(row('b1')).toBeNull()
    expect(row('t1')).not.toBeNull()
    expect(eye()!.getAttribute('aria-label')).toBe('Show bot threads (1)')

    act(() => eye()!.click())
    expect(row('b1')).not.toBeNull()
  })

  it('shows every hidden thread in its project, then hides every bot thread, without unhiding any', () => {
    show([thread('t1', 'Plain'), botStarted('h1', 'Quick check'), botStarted('h2', 'Lookup'), botStarted('b1', 'Project job', false)])
    expect(row('h1')).toBeNull()
    expect(row('b1')).not.toBeNull()
    expect(eye()!.getAttribute('aria-label')).toBe('Show hidden bot threads (2)')

    act(() => eye()!.click())
    expect(row('h1')!.textContent).toContain('Quick check')
    expect(row('h2')).not.toBeNull()
    expect(row('h1')!.getAttribute('aria-description')).toBe('Hidden thread')
    expect(row('t1')!.getAttribute('aria-description')).toBeNull()
    expect(eye()!.getAttribute('aria-label')).toBe('Hide bot threads')

    act(() => eye()!.click())
    expect(row('h1')).toBeNull()
    expect(row('h2')).toBeNull()
    expect(row('b1')).toBeNull()
    expect(row('t1')).not.toBeNull()
    expect(eye()!.getAttribute('aria-label')).toBe('Show bot threads (3)')

    // A view preference: the threads stay hidden and nothing asks the service to change them.
    expect(useAppStore.getState().threads.filter((item) => item.hidden).map((item) => item.id)).toEqual(['h1', 'h2'])
    expect(request.mock.calls.some((args) => String(args[0]).includes('setHidden'))).toBe(false)
  })

  it('keeps the choice for the profile across a remount, and not for another profile', () => {
    show([botStarted('h1', 'Quick check')])
    act(() => eye()!.click())
    act(() => root.unmount())
    root = createRoot(host)

    show([botStarted('h1', 'Quick check')])
    expect(row('h1')).not.toBeNull()

    act(() => root.unmount())
    root = createRoot(host)
    show([botStarted('h1', 'Quick check')], 'prof-b')
    expect(row('h1')).toBeNull()
  })
})

// @vitest-environment jsdom
/**
 * The threads the owner's bots started, in the sidebar: one a bot keeps out of it (`Thread.hidden`) is not listed, and
 * a bot-started thread's own menu has Hide, and the project menu's Hide bot threads and the Threads tab's Hide all bot
 * threads hide the listed ones (`threads.setHidden`).
 * Bringing one back is the bot chat's Show in sidebar (botThreadsUi.test.ts) or a message from its owner (threadHiddenProtocol.test.ts).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/StartFromPullRequestDialog', () => ({ StartFromPullRequestDialog: () => null }))
vi.mock('../../src/renderer/components/profiles/ProfileSwitcher', () => ({ ProfileSwitcher: () => null }))
vi.mock('../../src/renderer/components/chats/ChatsSidebar', () => ({ ChatsSidebar: () => null }))
vi.mock('../../src/renderer/components/ui/Toast', async (original) => ({ ...(await original<object>()), showToast: vi.fn(() => 1) }))

const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { showToast } = await import('../../src/renderer/components/ui/Toast')

const at = '2026-11-18T10:00:00.000Z'
const projects: Project[] = [
  { id: 'p1', name: 'Mousse', path: '/p/Mousse', createdAt: at, order: 0 },
  { id: 'p2', name: 'Smile', path: '/p/Smile', createdAt: at, order: 1 }
]
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, projectId: 'p1', ...over })
const byBot = (id: string, name: string, over: Partial<Thread> = {}) =>
  thread(id, name, { createdByThreadId: 'bot-chat', startedByBot: { botId: 'b1', name: 'Alpha' }, ...over })

// `threads.setHidden` answers with the thread as it is then, as the service does; one id can be made to fail.
let failing: string | null = null
const request = vi.fn(async (method: string, params: { threadId: string; hidden: boolean }) => {
  if (method !== 'threads.setHidden') return undefined
  if (params.threadId === failing) throw new Error('offline')
  const current = useAppStore.getState().threads.find((item) => item.id === params.threadId)!
  return { thread: { ...current, hidden: params.hidden || undefined } }
})
function preload(): unknown {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
  const group = (known: Record<string, unknown> = {}) => new Proxy(known, { get: (target, key: string) => target[key] ?? call(key) })
  return new Proxy({ platformRequest: group({ request }), git: {} } as Record<string, unknown>, { get: (target, key: string) => target[key] ?? group() })
}

const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'sidebarMode'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getInitialState()[key]]))

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = preload()
  failing = null
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

function show(threads: Thread[], view: 'projects' | 'threads' = 'projects') {
  useAppStore.setState({ projects, threads, threadActivity: {}, activeThreadId: null, threadsSidebarView: view, sidebarMode: 'projects' })
  act(() => root.render(createElement(ThreadsSidebar)))
  if (view !== 'projects') return
  for (const name of ['Mousse', 'Smile']) {
    const toggle = [...host.querySelectorAll<HTMLButtonElement>('.threads-sidebar-project-toggle')].find((item) => item.textContent?.includes(name))!
    if (toggle.getAttribute('aria-expanded') !== 'true') act(() => toggle.click())
  }
}

const row = (id: string) => host.querySelector<HTMLElement>(`[role="tabpanel"]:not([hidden]) button[data-thread-id="${id}"]`)
const rightClick = (element: Element) => act(() => { element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === label) ?? null
const projectRow = (name: string) => [...host.querySelectorAll<HTMLElement>('.threads-sidebar-project-toggle')].find((item) => item.textContent?.includes(name))!
const threadsTab = () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Threads"]')!
const hiddenIds = () => request.mock.calls.filter(([method, params]) => method === 'threads.setHidden' && params.hidden).map(([, params]) => params.threadId).sort()

describe('bot threads in the sidebar', () => {
  it('lists every thread but those a bot keeps hidden, with no eye to show them', () => {
    show([thread('t1', 'Plain'), byBot('b1', 'Shown job'), byBot('h1', 'Quick check', { hidden: true })])
    expect(row('t1')).not.toBeNull()
    expect(row('b1')).not.toBeNull()
    expect(row('h1')).toBeNull()
    expect(host.querySelector('button[aria-label*="bot threads"]')).toBeNull()
  })

  it('a project\'s menu hides the bot threads listed in it, and only while it has some', async () => {
    show([thread('t1', 'Plain'), byBot('b1', 'Job one'), byBot('b2', 'Job two'), byBot('h1', 'Quick check', { hidden: true }), byBot('s1', 'Other job', { projectId: 'p2' }), thread('t2', 'Smile work', { projectId: 'p2' })])
    rightClick(projectRow('Mousse'))
    await act(async () => menuItem('Hide bot threads')!.click())
    expect(hiddenIds()).toEqual(['b1', 'b2'])
    expect(row('b1')).toBeNull()
    expect(row('b2')).toBeNull()
    expect(row('t1')).not.toBeNull()
    expect(row('s1')).not.toBeNull()

    // Now none are listed there, so the item is gone.
    rightClick(projectRow('Mousse'))
    expect(menuItem('Rename')).not.toBeNull()
    expect(menuItem('Hide bot threads')).toBeNull()
  })

  it('a bot-started thread\'s menu hides just that thread; other threads have no Hide', async () => {
    show([thread('t1', 'Plain'), byBot('b1', 'Job one'), byBot('b2', 'Job two')])
    rightClick(row('t1')!)
    expect(menuItem('Rename')).not.toBeNull()
    expect(menuItem('Hide')).toBeNull()

    rightClick(row('b1')!)
    await act(async () => menuItem('Hide')!.click())
    expect(hiddenIds()).toEqual(['b1'])
    expect(row('b1')).toBeNull()
    expect(row('b2')).not.toBeNull()
  })

  it('the Threads tab\'s menu hides every listed bot thread, and opens only while there are some', async () => {
    show([thread('t1', 'Plain'), byBot('b1', 'Job one'), byBot('s1', 'Other job', { projectId: 'p2' }), byBot('x1', 'Archived job', { archivedAt: at })], 'threads')
    rightClick(threadsTab())
    await act(async () => menuItem('Hide all bot threads')!.click())
    expect(hiddenIds()).toEqual(['b1', 's1'])
    expect(row('t1')).not.toBeNull()

    rightClick(threadsTab())
    expect(menuItem('Hide all bot threads')).toBeNull()
  })

  it('says so when a thread could not be hidden, and hides the rest', async () => {
    show([byBot('b1', 'Job one'), byBot('b2', 'Job two')], 'threads')
    failing = 'b2'
    rightClick(threadsTab())
    await act(async () => menuItem('Hide all bot threads')!.click())
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Could not hide the threads'), tone: 'error' }))
    expect(row('b1')).toBeNull()
    expect(row('b2')).not.toBeNull()
  })
})

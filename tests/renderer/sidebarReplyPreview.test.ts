// @vitest-environment jsdom
/**
 * The sidebar shows no thread's latest reply, Reply previews on or off: a Projects tree row shows its branch under the
 * title instead. Both views show the pull requests the thread was linked to as a small count whose tooltip lists them
 * with their state.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'
import type { ThreadPullRequestLink } from '../../src/shared/pullRequests'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/lib/threadActions', () => ({
  selectThread: vi.fn(async () => undefined),
  createAndSelectThread: vi.fn(async () => undefined),
  createAndSelectProjectThread: vi.fn(async () => undefined),
  archiveThread: vi.fn(async () => undefined)
}))
vi.mock('../../src/renderer/components/profiles/ProfileSwitcher', () => ({ ProfileSwitcher: () => null }))
vi.mock('../../src/renderer/components/chats/ChatsSidebar', () => ({ ChatsSidebar: () => null }))

const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { setReplyPreviews } = await import('../../src/renderer/lib/replyPreviewSetting')

const at = '2026-11-17T10:00:00.000Z'
const project: Project = { id: 'p1', name: 'Mousse', path: '/p/Mousse', createdAt: at, order: 0 }
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, projectId: 'p1', ...over })
const url = (number: number) => `https://github.com/acme/app/pull/${number}`
const legacyLink: ThreadPullRequestLink = {
  number: 5, url: url(5), host: 'github.com', nameWithOwner: 'acme/app', headRefName: 'f', baseRefName: 'main',
  headRepository: 'acme/app', isCrossRepository: false, linkedAt: at
}

const threads = [
  thread('a', 'Fix the build', {
    lastReply: 'The lint step ran twice; it runs once now.',
    pullRequests: [
      { number: 7, url: url(7), nameWithOwner: 'acme/app', title: 'Run lint once', state: 'merged' },
      { number: 9, url: url(9), nameWithOwner: 'acme/app', title: 'Cache the lint step', state: 'open', isDraft: true }
    ]
  }),
  // Linked before the list was kept: its one link counts.
  thread('b', 'Old link', { pullRequest: legacyLink }),
  thread('c', 'Nothing yet'),
  // In its project's own folder: the folder's branch.
  thread('d', 'In the folder', { worktreeEnabled: false })
]

const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'sidebarMode'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getInitialState()[key]]))

let root: Root
let host: HTMLElement

beforeEach(() => {
  setReplyPreviews(true)
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
  const group = () => new Proxy({}, { get: (_target, key: string) => call(key) })
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy({ platform: 'darwin' } as Record<string, unknown>, { get: (target, key: string) => target[key] ?? group() })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(appOriginal)
})

function show(view: 'projects' | 'threads') {
  useAppStore.setState({ projects: [project], threads, threadActivity: {}, activeThreadId: 'a', threadsSidebarView: view, sidebarMode: 'projects' })
  act(() => root.render(createElement(ThreadsSidebar)))
  // The open thread's project opens by itself; open it when it did not.
  if (view === 'projects' && !host.querySelector('button[data-thread-id="a"]')) act(() => host.querySelector<HTMLButtonElement>('.threads-sidebar-project-toggle')!.click())
}

// The hidden tab's panel stays in the page; read the shown one.
const row = (id: string) => host.querySelector<HTMLButtonElement>(`.threads-sidebar-section:not([hidden]) button[data-thread-id="${id}"]`)!
const preview = (id: string) => row(id).querySelector('.threads-sidebar-reply-preview')?.textContent ?? null
const count = (id: string) => row(id).querySelector('[role="img"][aria-label$="pull request"], [role="img"][aria-label$="pull requests"]')

it('a Projects tree row shows its branch under the title: its own worktree\'s, or its project folder\'s', async () => {
  const bridge = (window as unknown as { mousse: Record<string, unknown> }).mousse
  bridge.git = { status: async () => ({ isRepo: true, branch: 'master' }) }
  bridge.workspace = { getStatus: async (id: string) => ({ metadata: { branch: `mousse/${id}` }, execution: { lifecycle: 'creating' } }) }
  show('projects')
  await act(async () => { for (let pass = 0; pass < 5; pass++) await Promise.resolve() })
  const branch = (id: string) => row(id).querySelector('.threads-sidebar-thread-sub')?.textContent ?? null
  expect(branch('a')).toBe('mousse/a')
  expect(branch('d')).toBe('master')
})

describe.each(['projects', 'threads'] as const)('a thread row in the %s view', (view) => {
  it('shows no reply, Reply previews on or off', () => {
    show(view)
    expect(preview('a')).toBeNull()
    expect(row('a').textContent).toContain('Fix the build')
    act(() => setReplyPreviews(false))
    expect(preview('a')).toBeNull()
  })

  it('counts the pull requests, and lists them with their state on hover', () => {
    show(view)
    expect(count('a')?.getAttribute('aria-label')).toBe('2 pull requests')
    expect(count('a')?.textContent).toBe('2')
    expect(count('a')?.getAttribute('title')).toBe('#7 Run lint once · merged\n#9 Cache the lint step · draft')
    expect(count('b')?.getAttribute('aria-label')).toBe('1 pull request')
    expect(count('b')?.getAttribute('title')).toBe('#5')
    expect(count('c')).toBeNull()
  })
})

describe('a list push that changes only what a row shows beside its title', () => {
  it('updates the count, though the thread\'s time did not move', () => {
    show('threads')
    const pushed = threads.map((entry) => entry.id === 'a'
      ? { ...entry, pullRequests: entry.pullRequests!.map((pr) => ({ ...pr, state: 'merged' as const, isDraft: undefined })) }
      : { ...entry })
    act(() => useAppStore.getState().setThreads(pushed))
    expect(count('a')?.getAttribute('title')).toBe('#7 Run lint once · merged\n#9 Cache the lint step · merged')
  })
})

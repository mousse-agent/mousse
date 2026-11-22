// @vitest-environment jsdom
/**
 * The sidebar shows no thread's latest reply, Reply previews on or off: a Projects tree row shows its branch under the
 * title instead. Both views show the pull requests the thread was linked to as a small count whose tooltip lists them
 * with their state.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHeadsRequest, GitHeadsResult, Project, Thread } from '../../src/shared/types'
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

const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'sidebarMode', 'appInfo'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getInitialState()[key]]))

let root: Root
let host: HTMLElement

beforeEach(() => {
  setReplyPreviews(true)
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
  const group = () => new Proxy({}, { get: (_target, key: string) => call(key) })
  const heads = async ({ threadIds = [] }: GitHeadsRequest): Promise<GitHeadsResult> => ({
    projects: { [project.id]: { repo: true, branch: 'master' } },
    threads: Object.fromEntries(threadIds.map((id) => [id, { own: true as const, branch: 'mousse/' + id, generation: 0, lifecycle: 'provisioning' }]))
  })
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy({ platform: 'darwin', git: { heads } } as Record<string, unknown>, {
    get: (target, key: string) => target[key] ?? group()
  })
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
  show('projects')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  const branch = (id: string) => row(id).querySelector('.threads-sidebar-thread-sub .threads-sidebar-branch-name')?.textContent ?? null
  const ownWorktree = (id: string) => row(id).querySelector('.threads-sidebar-thread-sub .threads-sidebar-branch-icon') !== null
  expect(branch('a')).toBe('mousse/a')
  expect(ownWorktree('a')).toBe(true)
  expect(branch('d')).toBe('master')
  expect(ownWorktree('d')).toBe(false)
})

describe.each(['projects', 'threads'] as const)('the model a thread in the %s view runs on', (view) => {
  it('shows as its agent\'s logo named in the tooltip: the one picked for it, else the default agent\'s', () => {
    useAppStore.setState({ appInfo: { platform: 'darwin', repoRoot: '/', llmProvider: 'claude' } })
    show(view)
    act(() => useAppStore.getState().setThreads(threads.map((entry) => entry.id === 'a'
      ? { ...entry, modelOverride: { instanceId: 'codex', llmProvider: 'codex', model: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' } }
      : entry)))
    const model = (id: string) => row(id).querySelector('.threads-sidebar-model-icon')?.getAttribute('title') ?? null
    expect(model('a')).toBe('GPT-6.1 Terra')
    expect(model('c')).toBe('Default model')
  })
})

it('a thread rested on opens its card beside it with the whole title, the project, computer, branch and model; leaving closes it', async () => {
  vi.useFakeTimers()
  try {
    useAppStore.setState({ appInfo: { platform: 'darwin', repoRoot: '/', llmProvider: 'claude', deviceName: 'Studio' } })
    show('projects')
    const card = () => document.querySelector('.threads-sidebar-hover-card')
    act(() => { row('d').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })) })
    expect(card()).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect([...card()!.querySelectorAll('.threads-sidebar-hover-card-item')].map((item) => item.textContent)).toEqual(['Mousse', 'Studio', 'master', 'Default model'])
    expect(card()!.querySelector('.threads-sidebar-hover-card-title')?.textContent).toBe('In the folder')
    act(() => { row('d').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' })) })
    expect(card()).toBeNull()
  } finally {
    vi.useRealTimers()
  }
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

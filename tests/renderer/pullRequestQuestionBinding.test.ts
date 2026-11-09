// @vitest-environment jsdom
/**
 * A Merge or Close question acts only on what it was asked about. Switching threads with it open closes it and nothing
 * runs on the other thread's pull request; a refresh that brings a new head keeps the reviewed head and says the pull
 * request changed until it is looked at again. Also: the Changes tab's whitespace option.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitPullRequestInfo, GitPullRequestLookup, PullRequestDetail, PullRequestMergeMethod } from '../../src/shared/pullRequests'
import type { GitStatusSnapshot } from '../../src/shared/types'

const merge = vi.fn(async (_target: unknown, _headSha?: string, method?: PullRequestMergeMethod) => ({ method }))
const close = vi.fn(async () => ({}))
const mergeMethod = vi.fn(async (_target: { path: string }): Promise<PullRequestMergeMethod | null> => 'squash')
const details: Record<string, PullRequestDetail> = {}
const sources: Record<string, unknown> = {}

vi.mock('../../src/renderer/hooks/useActiveThreadPullRequest', () => ({
  useActiveThreadPullRequest: (threadId: string | null) => sources[threadId ?? '']
}))
vi.mock('../../src/renderer/stores/pullRequestStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePullRequestDetail: (path: string | null) => (path && details[path] ? { detail: details[path], error: null, fetchedAt: 1 } : null),
  mergePullRequest: (...args: [unknown, string?, PullRequestMergeMethod?]) => merge(...args),
  closePullRequest: () => close(),
  pullRequestMergeMethod: (target: { path: string }) => mergeMethod(target)
}))

const { PullRequestPanel } = await import('../../src/renderer/components/PullRequestPanel')
const { MenuButton } = await import('../../src/renderer/components/changes/MenuButton')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const status = { isRepo: true, branch: 'feature', upstream: 'origin/feature', tracking: 'tracked', ahead: 0, behind: 0, changes: [], inProgress: null, hasRemote: true } as unknown as GitStatusSnapshot
const info = (number: number, repo: string): GitPullRequestInfo => ({
  number,
  title: `Change ${number}`,
  url: `https://example.test/${repo}/pull/${number}`,
  state: 'open',
  isDraft: false,
  baseRefName: 'main',
  checks: 'passing',
  checkCounts: { passed: 1, failed: 0, pending: 0, waiting: 0, total: 1 }
})
const detail = (number: number, repo: string, headSha: string) => ({
  number,
  title: `Change ${number}`,
  url: `https://example.test/${repo}/pull/${number}`,
  state: 'open',
  isDraft: false,
  checks: 'passing',
  checkCounts: { passed: 1, failed: 0, pending: 0, waiting: 0, total: 1 },
  identity: { host: 'example.test', nameWithOwner: repo, number },
  body: '',
  author: 'ada',
  headRefName: 'feature',
  baseRefName: 'main',
  headSha,
  headRepository: repo,
  baseRepository: repo,
  isCrossRepository: false,
  mergeState: 'clean',
  reviewDecision: null,
  reviews: [],
  comments: [],
  commentsTruncated: false,
  checkRuns: [],
  updatedAt: '2026-10-26T12:00:00Z',
  mergedAt: null,
  closedAt: null
}) as unknown as PullRequestDetail
const source = (threadId: string, path: string, number: number, repo: string) => {
  const lookup: GitPullRequestLookup = { state: 'found', pullRequest: info(number, repo) }
  return {
    path,
    branch: 'feature',
    projectId: `project-${threadId}`,
    ownThreadId: threadId,
    folderThreadId: null,
    link: null,
    lookup,
    location: { projectId: `project-${threadId}`, key: path, workspaceThreadId: null },
    git: { status, commits: [], branches: [], diffStats: null }
  }
}

let host: HTMLDivElement
let root: Root
const render = async () => { await act(async () => root.render(createElement(PullRequestPanel))) }
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error('element not found')
  await act(async () => { (element as HTMLElement).click() })
}
const button = (text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === text) ?? null
const question = () => host.querySelector('.side-card-git-pr-confirm')
const confirmMerge = () => question()?.querySelector('.side-card-git-pr-merge')

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  sources.a = source('a', '/repo-a', 12, 'acme/a')
  sources.b = source('b', '/repo-b', 40, 'acme/b')
  details['/repo-a'] = detail(12, 'acme/a', 'aaa1111')
  details['/repo-b'] = detail(40, 'acme/b', 'bbb2222')
  mergeMethod.mockImplementation(async (target) => (target.path === '/repo-a' ? 'squash' : 'rebase'))
  useAppStore.setState({ activeThreadId: 'a' })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  merge.mockClear()
  close.mockClear()
  mergeMethod.mockClear()
})

describe('a Merge or Close question in the pull request panel', () => {
  it('closes when another thread becomes active, and nothing runs on that thread’s pull request', async () => {
    await render()
    await click(host.querySelector('.pr-panel-merge'))
    expect(question()?.textContent).toContain('Squash #12')

    await act(async () => { useAppStore.setState({ activeThreadId: 'b' }) })
    expect(question()).toBeNull()
    expect(merge).not.toHaveBeenCalled()

    // A question asked on B names B's own method, never A's, and runs on B's head.
    await click(host.querySelector('.pr-panel-merge'))
    expect(question()?.textContent).toContain('Rebase the commits of #40')
    await click(confirmMerge())
    expect(merge).toHaveBeenCalledTimes(1)
    expect(merge.mock.calls[0][0]).toMatchObject({ path: '/repo-b', number: 40 })
    expect(merge.mock.calls[0][1]).toBe('bbb2222')
    expect(merge.mock.calls[0][2]).toBe('rebase')
  })

  it('closes a Close question too when another thread becomes active', async () => {
    await render()
    await click(host.querySelector('.pr-panel-menu'))
    await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.includes('Close pull request')))
    expect(question()?.textContent).toContain('Close #12 without merging?')

    await act(async () => { useAppStore.setState({ activeThreadId: 'b' }) })
    expect(question()).toBeNull()
    expect(close).not.toHaveBeenCalled()
  })

  it('keeps the reviewed head when a refresh brings a new one, and says the pull request changed', async () => {
    await render()
    await click(host.querySelector('.pr-panel-merge'))
    details['/repo-a'] = detail(12, 'acme/a', 'ccc3333')
    await render()

    expect(question()?.textContent).toContain('#12 changed since you opened this')
    // Nothing can run on the new head until it is looked at again.
    expect(confirmMerge()).toBeNull()
    expect(merge).not.toHaveBeenCalled()

    await click(button('Review again'))
    expect(question()?.textContent).not.toContain('changed since')
    await click(confirmMerge())
    expect(merge).toHaveBeenCalledTimes(1)
    expect(merge.mock.calls[0][1]).toBe('ccc3333')
  })

  it('sends the head and method it was asked about when nothing changed', async () => {
    await render()
    await click(host.querySelector('.pr-panel-merge'))
    await click(confirmMerge())
    expect(merge.mock.calls[0][0]).toMatchObject({ path: '/repo-a', number: 12 })
    expect(merge.mock.calls[0][1]).toBe('aaa1111')
    expect(merge.mock.calls[0][2]).toBe('squash')
  })
})

describe("the Changes tab's more menu", () => {
  it('toggles Ignore whitespace from a check-mark row, staying open, and closes on Escape', async () => {
    useAppStore.setState({ reviewIgnoreWhitespace: false })
    const Menu = () => {
      const ignore = useAppStore((s) => s.reviewIgnoreWhitespace)
      return createElement(MenuButton, {
        label: 'More',
        items: [{ label: 'Ignore whitespace', checked: ignore, onSelect: () => useAppStore.getState().setReviewIgnoreWhitespace(!ignore) }],
        children: '…'
      })
    }
    await act(async () => root.render(createElement(Menu)))
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="More"]')
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu')

    await click(trigger)
    const item = () => document.querySelector('[role="menuitemcheckbox"]')
    expect(item()?.textContent).toContain('Ignore whitespace')
    expect(item()?.getAttribute('aria-checked')).toBe('false')

    await click(item())
    expect(useAppStore.getState().reviewIgnoreWhitespace).toBe(true)
    expect(item()?.getAttribute('aria-checked')).toBe('true')

    await act(async () => { item()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(item()).toBeNull()
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
  })
})

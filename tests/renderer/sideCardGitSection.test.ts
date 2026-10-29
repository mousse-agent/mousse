// @vitest-environment jsdom
/**
 * The side card's Git section, mounted: the branch name always opens something (the branch list, or why the
 * branch stays fixed), the section collapses from its heading and keeps that choice across threads, and the
 * thread's pull requests list the newest first with the rest behind "Show N more".
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitSectionView, PullRequestList } from '../../src/renderer/components/sideCard/GitSection'
import { pullRequestList, pullRequestRow, type PullRequestFoundRow } from '../../src/renderer/components/sideCard/gitSectionLogic'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { EMPTY_GIT_ENTRY, type GitStatusView } from '../../src/renderer/stores/gitStatusStore'
import type { GitPullRequestInfo } from '../../src/shared/pullRequests'
import type { GitStatusSnapshot } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// jsdom lays nothing out; the branch list scrolls its active option into view.
Element.prototype.scrollIntoView ??= () => undefined

const status = (patch: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot => ({
  isRepo: true,
  branch: 'feature/login',
  upstream: 'origin/feature/login',
  tracking: 'tracked',
  ahead: 0,
  behind: 0,
  changes: [],
  inProgress: null,
  hasRemote: true,
  ...patch
} as GitStatusSnapshot)

const view = (patch: Partial<GitStatusView> = {}): GitStatusView => ({
  ...EMPTY_GIT_ENTRY,
  loaded: true,
  refresh: async () => undefined,
  status: status(),
  branches: { current: 'feature/login', branches: ['feature/login', 'main'] },
  ...patch
})

const pr = (number: number, patch: Partial<GitPullRequestInfo> = {}): PullRequestFoundRow => {
  const row = pullRequestRow({
    state: 'found',
    pullRequest: {
      number,
      title: `Change ${number}`,
      url: `https://github.com/acme/app/pull/${number}`,
      state: 'open',
      isDraft: false,
      checks: 'passing',
      checkCounts: { passed: 1, failed: 0, pending: 0, waiting: 0, total: 1 },
      ...patch
    }
  }, status())
  if (row?.kind !== 'found') throw new Error('expected a found row')
  return row
}

describe('the side card Git section, mounted', () => {
  let host: HTMLDivElement
  let root: Root

  const mount = async (props: Partial<Parameters<typeof GitSectionView>[0]> & { threadId?: string }) => {
    await act(async () => {
      root.render(createElement(GitSectionView, {
        threadId: 't1',
        projectId: 'p1',
        path: '/repo/a',
        git: view(),
        collapsedLabel: null,
        ...props
      }))
    })
  }
  const click = async (element: Element | null | undefined) => {
    if (!element) throw new Error('element not found')
    await act(async () => { (element as HTMLElement).click() })
  }
  const dialog = (label: string) => document.body.querySelector(`[role="dialog"][aria-label="${label}"]`)

  beforeEach(() => {
    useAppStore.setState({ sideCardCollapsed: {} })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    document.body.innerHTML = ''
  })

  it('opens the branch list from the branch name', async () => {
    await mount({})
    await click(host.querySelector('.side-card-git-branch'))
    expect(dialog('Switch branch')?.textContent).toContain('main')
  })

  it('opens the reason the branch stays fixed for a thread with its own worktree', async () => {
    await mount({
      workspaceThreadId: 't1',
      path: '/wt/t1',
      git: view({ status: status({ branch: 'mousse/thread/t1' }), branches: { current: 'mousse/thread/t1', branches: ['mousse/thread/t1'] } })
    })
    const branch = host.querySelector('.side-card-git-branch')
    await click(branch)
    expect(branch?.getAttribute('aria-expanded')).toBe('true')
    const shown = dialog('Branch')
    expect(shown?.textContent).toContain('mousse/thread/t1')
    expect(shown?.textContent).toContain('own branch and worktree')
    expect(dialog('Switch branch')).toBeNull()
  })

  it('collapses and expands from the heading, and keeps that choice on another thread', async () => {
    await mount({})
    const toggle = () => host.querySelector('.side-card-section-toggle')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    await click(toggle())
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.side-card-git-branch')).toBeNull()
    expect(useAppStore.getState().sideCardCollapsed).toEqual({ Git: true })

    await mount({ threadId: 't2', ownThreadId: 't2' })
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    await click(toggle())
    expect(host.querySelector('.side-card-git-branch')).not.toBeNull()
  })

  it('starts collapsed without a repository, and opening it there leaves repositories as they were', async () => {
    await mount({ git: view({ status: status({ isRepo: false, branch: null }) }), collapsedLabel: 'Not a repository', canInitialize: true })
    const toggle = () => host.querySelector('.side-card-section-toggle')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle()?.textContent).toContain('Not a repository')
    await click(toggle())
    expect(host.querySelector('.side-card-git-init')).not.toBeNull()

    await mount({ threadId: 't2' })
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
  })

  it('shows the newest pull request and the rest behind Show N more', async () => {
    await act(async () => {
      root.render(createElement(PullRequestList, { rows: [pr(3), pr(12, { state: 'merged' }), pr(7, { state: 'closed' })] }))
    })
    const titles = () => [...host.querySelectorAll('.side-card-git-pr-title')].map((title) => title.textContent)
    expect(titles()).toEqual(['Change 12'])
    const more = host.querySelector('.side-card-git-pr-more')
    expect(more?.textContent).toBe('Show 2 more')
    await click(more)
    expect(titles()).toEqual(['Change 12', 'Change 7', 'Change 3'])
    expect(host.querySelector('.side-card-git-pr-more')).toBeNull()
  })
})

describe('the pull request list', () => {
  it('shows one pull request with nothing hidden, and none for none', () => {
    expect(pullRequestList([pr(5)], false)).toEqual({ shown: [pr(5)], hidden: 0 })
    expect(pullRequestList([], false)).toEqual({ shown: [], hidden: 0 })
  })
})

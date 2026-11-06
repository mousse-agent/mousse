// @vitest-environment jsdom
/**
 * The side card's Git section, mounted: the branch name always opens something (the branch list, or why the
 * branch stays fixed), the section collapses from its heading and keeps that choice across threads, and the
 * thread's pull requests list the newest first with the rest behind "Show N more", and an open one merges or closes
 * after a confirmation. With nothing to commit, the commit popover opens with amend off and nothing turns it on but
 * the user.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { GitSectionView, PullRequestList } from '../../src/renderer/components/sideCard/GitSection'
import { pullRequestList, pullRequestRow, type PullRequestFoundRow } from '../../src/renderer/components/sideCard/gitSectionLogic'
import { useRetiredWorktreeNote } from '../../src/renderer/components/sideCard/useRetiredWorktreeNote'
import { retiredWorktreeNote } from '../../src/renderer/lib/storageCopy'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { EMPTY_GIT_ENTRY, type GitStatusView } from '../../src/renderer/stores/gitStatusStore'
import type { GitPullRequestInfo, PullRequestDetail } from '../../src/shared/pullRequests'
import type { GitCommit, GitStatusSnapshot } from '../../src/shared/types'

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

  it('says when cleanup removed the thread\'s worktree, while it is checking and once it is shown', async () => {
    const note = 'Worktree removed by cleanup on 1/2/2026; it is restored when you use the thread'
    await mount({ collapsedLabel: 'Checking…', retiredNote: note })
    expect(host.querySelector('.side-card-git-retired')?.textContent).toBe(note)
    await mount({ retiredNote: note })
    expect(host.querySelector('.side-card-git-retired')?.textContent).toBe(note)
    await mount({})
    expect(host.querySelector('.side-card-git-retired')).toBeNull()
  })

  it('reads the retirement from the workspace status, and again once the folder has resolved', async () => {
    const getStatus = vi.fn<(threadId: string) => Promise<unknown>>(async () => ({ retiredByCleanup: { at: '2026-10-30T09:00:00.000Z', rule: 'worktree-inactive' } }))
    vi.stubGlobal('mousse', { workspace: { getStatus } })
    onTestFinished(() => { vi.unstubAllGlobals() })
    const shown: (string | null)[] = []
    const Probe = ({ threadId, settled }: { threadId: string | null; settled: boolean }) => {
      shown.push(useRetiredWorktreeNote(threadId, settled))
      return null
    }
    await act(async () => root.render(createElement(Probe, { threadId: 't1', settled: false })))
    expect(getStatus).toHaveBeenCalledWith('t1')
    expect(shown.at(-1)).toBe(retiredWorktreeNote('2026-10-30T09:00:00.000Z'))
    expect(shown.at(-1)).toMatch(/^Worktree removed by cleanup on .+; it is restored when you use the thread$/)

    getStatus.mockResolvedValue({})
    await act(async () => root.render(createElement(Probe, { threadId: 't1', settled: true })))
    expect(getStatus).toHaveBeenCalledTimes(2)
    expect(shown.at(-1)).toBeNull()

    await act(async () => root.render(createElement(Probe, { threadId: null, settled: true })))
    expect(shown.at(-1)).toBeNull()
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

describe('merging and closing from a pull request row', () => {
  let host: HTMLDivElement
  let root: Root
  const info = (patch: Partial<GitPullRequestInfo> = {}): GitPullRequestInfo => ({
    number: 12,
    title: 'Change 12',
    url: 'https://github.com/acme/app/pull/12',
    state: 'open',
    isDraft: false,
    headRefName: 'feature/login',
    baseRefName: 'main',
    checks: 'passing',
    checkCounts: { passed: 1, failed: 0, pending: 0, waiting: 0, total: 1 },
    ...patch
  })
  const detail = (patch: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
    ...info(),
    identity: { host: 'github.com', nameWithOwner: 'acme/app', number: 12 },
    body: '',
    author: 'ada',
    authorAssociation: 'OWNER',
    headRefName: 'feature/login',
    baseRefName: 'main',
    headSha: 'abc1234',
    headRepository: 'acme/app',
    baseRepository: 'acme/app',
    isCrossRepository: false,
    reviewDecision: null,
    reviews: [],
    comments: [],
    commentsTruncated: false,
    checkRuns: [],
    updatedAt: '2026-10-29T08:00:00Z',
    mergedAt: null,
    closedAt: null,
    mergeState: 'clean',
    ...patch
  })
  let merge: ReturnType<typeof vi.fn>
  let close: ReturnType<typeof vi.fn>
  let mergeMethod: ReturnType<typeof vi.fn>

  const mount = async (props: Partial<Parameters<typeof GitSectionView>[0]> = {}) => {
    await act(async () => {
      root.render(createElement(GitSectionView, {
        threadId: 't1',
        ownThreadId: 't1',
        workspaceThreadId: 't1',
        projectId: 'p1',
        path: '/wt/t1',
        git: view(),
        pullRequest: { state: 'found', pullRequest: info(), others: [info({ number: 9, title: 'Change 9', state: 'merged' })] },
        pullRequestDetail: detail(),
        collapsedLabel: null,
        ...props
      }))
    })
  }
  const click = async (element: Element | null | undefined) => {
    if (!element) throw new Error('element not found')
    await act(async () => { (element as HTMLElement).click() })
  }
  const dialog = (label: string) => host.querySelector(`.side-card-git-pr-confirm[aria-label="${label}"]`)
  const confirmIn = (shown: Element | null) => [...(shown?.querySelectorAll('button') ?? [])].at(-1)

  beforeEach(() => {
    useAppStore.setState({ sideCardCollapsed: {}, mainView: 'git', openedSurfaceKinds: [] })
    merge = vi.fn(async () => ({ pullRequest: info({ state: 'merged' }), method: 'merge' }))
    close = vi.fn(async () => ({ pullRequest: info({ state: 'closed' }) }))
    mergeMethod = vi.fn(async () => 'merge')
    vi.stubGlobal('mousse', { pullRequests: { merge, close, mergeMethod, get: vi.fn(() => new Promise(() => {})), detail: vi.fn(() => new Promise(() => {})) } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('asks before merging, merges as the thread with the shown head, and says how it merged', async () => {
    await mount()
    const button = host.querySelector('.side-card-git-pr-merge')
    expect(button?.hasAttribute('data-ready')).toBe(true)
    await click(button)
    const shown = dialog('Merge #12')
    // The prompt names the method the merge will use, read as the same thread.
    expect(mergeMethod).toHaveBeenCalledWith({ threadId: 't1' })
    expect(shown?.textContent).toContain('Merge #12 into main with a merge commit?')
    expect(confirmIn(shown)?.textContent).toBe('Create a merge commit')
    expect(merge).not.toHaveBeenCalled()
    expect(document.activeElement?.textContent).toBe('Cancel')
    // The prompt's own Merge stands in for the row's while it asks: one primary action at a time.
    expect(host.querySelectorAll('.side-card-git-pr-merge')).toHaveLength(1)
    await click(confirmIn(shown))
    // The merge is sent with the method the prompt named, so it cannot do something else.
    expect(merge).toHaveBeenCalledWith({ threadId: 't1' }, 12, 'abc1234', 'merge')
    expect(dialog('Merge #12')).toBeNull()
    expect(host.querySelector('.side-card-git-notice')?.textContent).toBe('Merged #12 with a merge commit.')
  })

  it('names a squash or a rebase, and waits for the method before it can merge', async () => {
    mergeMethod.mockResolvedValueOnce('squash')
    await mount()
    await click(host.querySelector('.side-card-git-pr-merge'))
    expect(dialog('Merge #12')?.textContent).toContain('Squash #12 into one commit on main?')
    expect(confirmIn(dialog('Merge #12'))?.textContent).toBe('Squash and merge')
    await click(dialog('Merge #12')?.querySelector('button'))

    mergeMethod.mockResolvedValueOnce('rebase')
    await click(host.querySelector('.side-card-git-pr-merge'))
    expect(dialog('Merge #12')?.textContent).toContain('Rebase the commits of #12 onto main?')
    expect(confirmIn(dialog('Merge #12'))?.textContent).toBe('Rebase and merge')
    await click(dialog('Merge #12')?.querySelector('button'))

    mergeMethod.mockReturnValueOnce(new Promise(() => {}))
    await click(host.querySelector('.side-card-git-pr-merge'))
    expect(dialog('Merge #12')?.textContent).toContain('Merge #12 into main?')
    expect((confirmIn(dialog('Merge #12')) as HTMLButtonElement).disabled).toBe(true)
    expect(merge).not.toHaveBeenCalled()
  })

  it('says what a merge falls back to when the method cannot be read, and sends none', async () => {
    for (const unreadable of [() => mergeMethod.mockResolvedValueOnce(null), () => mergeMethod.mockRejectedValueOnce(new Error('No handler registered'))]) {
      unreadable()
      merge.mockClear()
      await mount()
      await click(host.querySelector('.side-card-git-pr-merge'))
      const shown = dialog('Merge #12')
      expect(shown?.textContent).toContain("Merge #12 into main? The merge method couldn't be read, so the repository's default is used, else squash.")
      expect(confirmIn(shown)?.textContent).toBe('Merge')
      await click(confirmIn(shown))
      expect(merge).toHaveBeenCalledWith({ threadId: 't1' }, 12, 'abc1234', undefined)
      await act(async () => root.render(createElement('div')))
    }
  })

  it('merges with the method a confirmation named, not one read again after a refusal', async () => {
    mergeMethod.mockResolvedValueOnce('rebase')
    merge.mockRejectedValueOnce(new Error('Pull request acme/app#12 is not mergeable: the base branch was modified.'))
    await mount()
    await click(host.querySelector('.side-card-git-pr-merge'))
    await click(confirmIn(dialog('Merge #12')))
    // Asked again from the same prompt: the same method, even though a new read would now say merge.
    await click(confirmIn(dialog('Merge #12')))
    expect(merge.mock.calls.map((call) => call[3])).toEqual(['rebase', 'rebase'])
    expect(mergeMethod).toHaveBeenCalledTimes(1)
  })

  it('puts the row\'s buttons back on Cancel, merging nothing', async () => {
    await mount()
    await click(host.querySelector('.side-card-git-pr-merge'))
    await click(dialog('Merge #12')?.querySelector('button'))
    expect(dialog('Merge #12')).toBeNull()
    expect(host.querySelector('.side-card-git-pr-close')).not.toBeNull()
    expect(merge).not.toHaveBeenCalled()
  })

  it('keeps the prompt open with the host\'s reason when the merge is refused', async () => {
    merge.mockRejectedValueOnce(new Error("Error invoking remote method 'pullRequests:merge': Error: Pull request acme/app#12 is not mergeable: the base branch policy prohibits the merge."))
    await mount()
    await click(host.querySelector('.side-card-git-pr-merge'))
    await click(confirmIn(dialog('Merge #12')))
    expect(dialog('Merge #12')?.querySelector('[role="alert"]')?.textContent).toBe('Pull request acme/app#12 is not mergeable: the base branch policy prohibits the merge.')
  })

  it('does not open the prompt while Merge is dimmed, and says why', async () => {
    await mount({ pullRequestDetail: detail({ mergeState: 'conflicting' }) })
    const button = host.querySelector('.side-card-git-pr-merge')
    expect(button?.getAttribute('aria-disabled')).toBe('true')
    expect(button?.getAttribute('title')).toBe('Has conflicts with main')
    await click(button)
    expect(dialog('Merge #12')).toBeNull()
  })

  it('asks before closing, then closes as the project when the folder is the project\'s', async () => {
    await mount({ workspaceThreadId: null, path: '/repo/a' })
    await click(host.querySelector('.side-card-git-pr-close'))
    const shown = dialog('Close #12')
    expect(shown?.textContent).toContain('without merging')
    await click(confirmIn(shown))
    expect(close).toHaveBeenCalledWith({ projectId: 'p1' }, 12)
    expect(host.querySelector('.side-card-git-notice')?.textContent).toBe('Closed #12.')
  })

  it('lists the earlier merged pull request behind Show 1 more, without actions', async () => {
    await mount()
    expect(host.querySelectorAll('.side-card-git-pr-item')).toHaveLength(1)
    await click(host.querySelector('.side-card-git-pr-more'))
    const items = [...host.querySelectorAll('.side-card-git-pr-item')]
    expect(items.map((item) => item.querySelector('.side-card-git-pr-title')?.textContent)).toEqual(['Change 12', 'Change 9'])
    expect(items[1].querySelector('.side-card-git-pr-merge, .side-card-git-pr-close')).toBeNull()
  })

  it('opens the pull request panel from the title, and the host in the browser from the arrow', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await mount()
    await click(host.querySelector('.side-card-git-pr-external'))
    expect(open).toHaveBeenCalledWith('https://github.com/acme/app/pull/12', '_blank', 'noopener,noreferrer')
    expect(useAppStore.getState().mainView).toBe('git')
    await click(host.querySelector('.side-card-git-pr'))
    expect(useAppStore.getState().mainView).toBe('pullRequest')
  })
})

describe('the commit popover with nothing to commit', () => {
  let host: HTMLDivElement
  let root: Root
  let lastCommitMessage: ReturnType<typeof vi.fn>
  const head = (patch: Partial<GitCommit> = {}): GitCommit => ({
    hash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    shortHash: 'a1b2c3d',
    message: 'Fix the flaky retry test',
    author: 'Ada',
    date: '2026-10-24T10:00:00Z',
    pushed: false,
    onRemote: false,
    ...patch
  })
  const clean = (patch: Partial<GitStatusView> = {}) => view({ commits: [head()], ...patch })
  const withFile = (patch: Partial<GitStatusView> = {}) =>
    clean({ status: status({ changes: [{ path: 'a.ts', status: 'modified', staged: false }] }), ...patch })

  const mount = async (git: GitStatusView, props: Partial<Parameters<typeof GitSectionView>[0]> = {}) => {
    await act(async () => {
      root.render(createElement(GitSectionView, { threadId: 't1', projectId: 'p1', path: '/repo/a', git, collapsedLabel: null, ...props }))
    })
  }
  const click = async (element: Element | null | undefined) => {
    if (!element) throw new Error('element not found')
    await act(async () => { (element as HTMLElement).click() })
  }
  const trigger = () => host.querySelector<HTMLButtonElement>('.side-card-git-commit-button')
  const popover = () => document.body.querySelector('.side-card-git-commit-popover')
  const amendSwitch = () => popover()?.querySelector<HTMLButtonElement>('[role="switch"]') ?? null
  const primary = () => popover()?.querySelector<HTMLButtonElement>('.side-card-git-submit[data-flow="commit"]') ?? null
  const submits = () => [...(popover()?.querySelectorAll<HTMLButtonElement>('.side-card-git-submit[data-flow]') ?? [])]
  const type = async (text: string) => {
    const box = popover()?.querySelector('textarea')
    if (!box) throw new Error('no message box')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(box, text)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  beforeEach(() => {
    useAppStore.setState({ sideCardCollapsed: {} })
    lastCommitMessage = vi.fn(async () => 'Fix the flaky retry test')
    vi.stubGlobal('mousse', { git: { lastCommitMessage } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('says Commit and opens with amend off, its buttons waiting for the user to turn it on', async () => {
    await mount(clean())
    expect(trigger()?.textContent).toBe('Commit')
    expect(trigger()?.disabled).toBe(false)
    await click(trigger())
    expect(popover()?.getAttribute('aria-label')).toBe('Commit changes')
    expect(amendSwitch()?.getAttribute('aria-checked')).toBe('false')
    expect(amendSwitch()?.disabled).toBe(false)
    await type('Reworded message')
    expect(primary()?.textContent).toBe('Commit')
    expect(submits().every((button) => button.disabled)).toBe(true)
    expect(primary()?.title).toBe('No changes to commit. Turn on Amend last commit to change a1b2c3d')
    expect(popover()?.querySelector('.side-card-git-hint')?.textContent).toBe('No changes to commit')
    expect(lastCommitMessage).not.toHaveBeenCalled()
  })

  it('enables the primary button as Amend once the user turns amend on, the hint naming the commit', async () => {
    await mount(clean())
    await click(trigger())
    await click(amendSwitch())
    expect(amendSwitch()?.getAttribute('aria-checked')).toBe('true')
    expect(popover()?.getAttribute('aria-label')).toBe('Amend commit')
    // The empty box starts from the last commit's message.
    expect(lastCommitMessage).toHaveBeenCalledTimes(1)
    expect(popover()?.querySelector('textarea')?.value).toBe('Fix the flaky retry test')
    expect(primary()?.textContent).toBe('Amend')
    expect(primary()?.disabled).toBe(false)
    expect(primary()?.hasAttribute('title')).toBe(false)
    expect(popover()?.querySelector('.side-card-git-hint')?.textContent).toBe('Amends a1b2c3d')
  })

  it('keeps amend off when files appear and go again while the popover is open', async () => {
    await mount(clean())
    await click(trigger())
    await mount(withFile())
    expect(amendSwitch()?.getAttribute('aria-checked')).toBe('false')
    expect(primary()?.textContent).toBe('Commit')
    await mount(clean())
    expect(popover()).not.toBeNull()
    expect(amendSwitch()?.getAttribute('aria-checked')).toBe('false')
    await type('Something')
    expect(primary()?.disabled).toBe(true)
  })

  it('keeps amend off when the last commit is committed away under the open popover', async () => {
    await mount(withFile())
    await click(trigger())
    expect(amendSwitch()?.getAttribute('aria-checked')).toBe('false')
    // Committed elsewhere: no changes left and a new HEAD.
    await mount(clean({ commits: [head({ hash: 'f'.repeat(40), shortHash: 'fffffff' }), head()] }))
    expect(popover()).not.toBeNull()
    expect(amendSwitch()?.getAttribute('aria-checked')).toBe('false')
    await type('Something')
    expect(primary()?.disabled).toBe(true)
    expect(primary()?.title).toContain('fffffff')
  })

  it('drops an amend the user turned on when HEAD moves under the open popover', async () => {
    await mount(clean())
    await click(trigger())
    await click(amendSwitch())
    await mount(clean({ commits: [head({ hash: 'f'.repeat(40), shortHash: 'fffffff' }), head()] }))
    expect(amendSwitch()?.getAttribute('aria-checked')).toBe('false')
    expect(primary()?.disabled).toBe(true)
  })

  it('keeps the trigger disabled when the last commit is pushed, the repository has no commits, or it is a thread worktree', async () => {
    await mount(clean({ commits: [head({ pushed: true, onRemote: true })] }))
    expect(trigger()?.textContent).toBe('Commit')
    expect(trigger()?.disabled).toBe(true)
    await mount(view({ status: status({ tracking: 'unborn', upstream: null }), commits: [] }))
    expect(trigger()?.textContent).toBe('Commit')
    expect(trigger()?.disabled).toBe(true)
    await mount(clean({ status: status({ branch: 'mousse/thread/t1' }), branches: { current: 'mousse/thread/t1', branches: ['mousse/thread/t1'] } }), { workspaceThreadId: 't1', path: '/wt/t1' })
    expect(trigger()?.textContent).toBe('Commit')
    expect(trigger()?.disabled).toBe(true)
  })
})

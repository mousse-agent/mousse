import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitSectionView, PullRequestLink } from '../src/renderer/components/sideCard/GitSection'
import {
  branchChoices,
  branchLabel,
  branchSearchAria,
  changedFileCount,
  changesSummary,
  diffStatLabel,
  formatCommitLine,
  gitCollapsedLabel,
  gitErrorCode,
  gitErrorMessage,
  commitMenuState,
  pullRequestRow,
  relativeTime,
  untrackedFileCount
} from '../src/renderer/components/sideCard/gitSectionLogic'
import {
  EMPTY_GIT_ENTRY,
  abortGitInProgress,
  checkoutGitBranch,
  commitGitChanges,
  createGitBranch,
  deleteGitBranch,
  discardGitPaths,
  fetchGit,
  pullGit,
  refreshGitStatus,
  renameGitBranch,
  stageGitPaths,
  unstageGitPaths,
  retainGitPath,
  useGitStatusStore,
  type GitStatusView
} from '../src/renderer/stores/gitStatusStore'
import { anyTurnEnded } from '../src/renderer/lib/turnEnded'
import { useAppStore } from '../src/renderer/stores/appStore'
import type { PullRequestComment, PullRequestDetail, PullRequestWatchStatus } from '../src/shared/pullRequests'
import { inTime, pullRequestWatchModel } from '../src/renderer/components/sideCard/pullRequestWatchLogic'
import type {
  GitBranchInfo,
  GitCommit,
  GitDiffStats,
  GitStatusSnapshot,
  TurnState,
  TurnStateSnapshot
} from '../src/shared/types'

const scope = { projectId: 'project-1', workspaceThreadId: null }
const threadScope = { projectId: 'project-1', workspaceThreadId: 'thread-1' }

const prComment = (id: string): PullRequestComment => ({
  id,
  author: 'grace',
  authorAssociation: 'MEMBER',
  body: 'Please rename this.',
  bodyTruncated: false,
  createdAt: '2026-10-26T09:00:00Z',
  edited: false,
  url: 'https://github.com/acme/app/pull/7#discussion_r1',
  path: 'src/a.ts',
  line: 14,
  startLine: null,
  side: 'RIGHT',
  inReplyTo: null
})

const prDetail = (patch: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  number: 7,
  title: 'Add the retry button',
  url: 'https://github.com/acme/app/pull/7',
  state: 'open',
  isDraft: false,
  checks: 'failing',
  checkCounts: { passed: 1, failed: 1, pending: 1, waiting: 1, total: 3 },
  identity: { host: 'github.com', nameWithOwner: 'acme/app', number: 7 },
  body: '',
  author: 'ada',
  headRefName: 'feature/retry',
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
  updatedAt: '2026-10-26T12:00:00Z',
  mergedAt: null,
  closedAt: null,
  ...patch
})

const repoStatus = (patch: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot => ({
  isRepo: true,
  branch: 'main',
  upstream: 'origin/main',
  tracking: 'tracked',
  ahead: 0,
  behind: 0,
  changes: [],
  ...patch
})

const commit = (patch: Partial<GitCommit> = {}): GitCommit => ({
  hash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  shortHash: 'a1b2c3d',
  message: 'Fix the flaky retry test',
  author: 'Ada',
  date: '2026-10-24T10:00:00Z',
  pushed: false,
  onRemote: false,
  ...patch
})

interface GitMock {
  status: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  branches: ReturnType<typeof vi.fn>
  diffStats: ReturnType<typeof vi.fn>
  checkout: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  push: ReturnType<typeof vi.fn>
  stage: ReturnType<typeof vi.fn>
  unstage: ReturnType<typeof vi.fn>
  discard: ReturnType<typeof vi.fn>
  fetch: ReturnType<typeof vi.fn>
  pull: ReturnType<typeof vi.fn>
  abortInProgress: ReturnType<typeof vi.fn>
  createBranch: ReturnType<typeof vi.fn>
  renameBranch: ReturnType<typeof vi.fn>
  deleteBranch: ReturnType<typeof vi.fn>
}

const installGit = (patch: Partial<GitMock> = {}): GitMock => {
  const git: GitMock = {
    status: vi.fn(async () => repoStatus()),
    log: vi.fn(async () => [commit()]),
    branches: vi.fn(async (): Promise<GitBranchInfo> => ({ current: 'main', branches: ['main', 'dev'] })),
    diffStats: vi.fn(async (): Promise<GitDiffStats> => ({ additions: 4, deletions: 1, filesChanged: 2 })),
    checkout: vi.fn(async () => ({ status: repoStatus() })),
    commit: vi.fn(async () => ({ status: repoStatus() })),
    push: vi.fn(async () => ({ status: repoStatus() })),
    stage: vi.fn(async () => ({ status: repoStatus() })),
    unstage: vi.fn(async () => ({ status: repoStatus() })),
    discard: vi.fn(async () => ({ status: repoStatus() })),
    fetch: vi.fn(async () => ({ status: repoStatus(), behindBefore: 0, behindAfter: 2 })),
    pull: vi.fn(async () => ({ status: repoStatus(), result: 'fast-forwarded' })),
    abortInProgress: vi.fn(async () => ({ status: repoStatus() })),
    createBranch: vi.fn(async () => ({ status: repoStatus() })),
    renameBranch: vi.fn(async () => ({ status: repoStatus() })),
    deleteBranch: vi.fn(async () => ({ status: repoStatus() })),
    ...patch
  }
  vi.stubGlobal('window', {
    mousse: { git },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
  return git
}

describe('shared git status store', () => {
  beforeEach(() => {
    useGitStatusStore.setState({ entries: {} })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shares one fetch between concurrent requests for the same path', async () => {
    const git = installGit()
    await Promise.all([refreshGitStatus('/repo/a'), refreshGitStatus('/repo/a'), refreshGitStatus('/repo/a', { quiet: true })])
    expect(git.status).toHaveBeenCalledTimes(1)
    expect(git.log).toHaveBeenCalledTimes(1)
    expect(git.branches).toHaveBeenCalledTimes(1)
    expect(git.diffStats).toHaveBeenCalledTimes(1)
    const entry = useGitStatusStore.getState().entries['/repo/a']
    expect(entry.loaded).toBe(true)
    expect(entry.loading).toBe(false)
    expect(entry.status?.branch).toBe('main')
    expect(entry.commits).toHaveLength(1)
    expect(entry.diffStats?.additions).toBe(4)
  })

  it('fetches paths independently', async () => {
    const git = installGit()
    await Promise.all([refreshGitStatus('/repo/a'), refreshGitStatus('/repo/b')])
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.status).toHaveBeenCalledWith(undefined, '/repo/a')
    expect(git.status).toHaveBeenCalledWith(undefined, '/repo/b')
  })

  it('skips an ordinary request while the data is fresh, but a forced refresh refetches', async () => {
    const git = installGit()
    await refreshGitStatus('/repo/a')
    await refreshGitStatus('/repo/a')
    expect(git.status).toHaveBeenCalledTimes(1)
    await refreshGitStatus('/repo/a', { force: true })
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('fetches again once the data has gone stale', async () => {
    vi.useFakeTimers()
    const git = installGit()
    await refreshGitStatus('/repo/a')
    vi.advanceTimersByTime(5000)
    await refreshGitStatus('/repo/a')
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('queues exactly one more fetch when a forced refresh arrives mid-fetch', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const git = installGit({
      status: vi.fn()
        .mockImplementationOnce(async () => { await gate; return repoStatus({ branch: 'old' }) })
        .mockImplementation(async () => repoStatus({ branch: 'new' }))
    })
    const first = refreshGitStatus('/repo/a')
    const forced = refreshGitStatus('/repo/a', { force: true })
    const forcedAgain = refreshGitStatus('/repo/a', { force: true })
    release?.()
    await Promise.all([first, forced, forcedAgain])
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(useGitStatusStore.getState().entries['/repo/a'].status?.branch).toBe('new')
  })

  it('does not flag loading for quiet refreshes of loaded data', async () => {
    installGit()
    await refreshGitStatus('/repo/a')
    const seen: boolean[] = []
    const stop = useGitStatusStore.subscribe((state) => seen.push(state.entries['/repo/a'].loading))
    await refreshGitStatus('/repo/a', { force: true, quiet: true })
    stop()
    expect(seen).not.toContain(true)
  })

  it('flags loading only for the first fetch of a folder, never for a later refresh', async () => {
    installGit()
    const seen: boolean[] = []
    const stop = useGitStatusStore.subscribe((state) => seen.push(state.entries['/repo/a']?.loading))
    await refreshGitStatus('/repo/a')
    expect(seen).toContain(true)
    seen.length = 0
    // What the Git panel asks for on mount and from its refresh button.
    await refreshGitStatus('/repo/a', { force: true })
    await refreshGitStatus('/repo/a', { force: true, quiet: false })
    stop()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen).not.toContain(true)
  })

  it('keeps loaded data free of loading when a refresh joins a fetch already running', async () => {
    installGit()
    await refreshGitStatus('/repo/a')
    const first = refreshGitStatus('/repo/a', { force: true })
    const joined = refreshGitStatus('/repo/a')
    expect(useGitStatusStore.getState().entries['/repo/a'].loading).toBe(false)
    await Promise.all([first, joined])
  })

  it('clears commits, branches and stats for a folder that is not a repo', async () => {
    installGit({ status: vi.fn(async () => repoStatus({ isRepo: false, branch: null, tracking: 'none' })) })
    await refreshGitStatus('/plain')
    const entry = useGitStatusStore.getState().entries['/plain']
    expect(entry.loaded).toBe(true)
    expect(entry.status?.isRepo).toBe(false)
    expect(entry.commits).toEqual([])
    expect(entry.branches).toBeNull()
    expect(entry.diffStats).toBeNull()
  })

  it('records a failed status fetch without rejecting', async () => {
    installGit({ status: vi.fn(async () => { throw new Error('spawn failed') }) })
    await expect(refreshGitStatus('/broken')).resolves.toBeUndefined()
    const entry = useGitStatusStore.getState().entries['/broken']
    expect(entry.loaded).toBe(true)
    expect(entry.error).toBe('spawn failed')
    expect(entry.loading).toBe(false)
  })

  it('keeps unchanged data by reference across refreshes', async () => {
    installGit()
    await refreshGitStatus('/repo/a')
    const before = useGitStatusStore.getState().entries['/repo/a']
    await refreshGitStatus('/repo/a', { force: true })
    const after = useGitStatusStore.getState().entries['/repo/a']
    expect(after.status).toBe(before.status)
    expect(after.commits).toBe(before.commits)
    expect(after.branches).toBe(before.branches)
  })

  it('refreshes after a checkout and after a commit', async () => {
    const git = installGit()
    await refreshGitStatus('/repo/a')
    await checkoutGitBranch('/repo/a', 'dev', scope)
    expect(git.checkout).toHaveBeenCalledWith(scope, 'dev', { operationId: expect.any(String) })
    expect(git.status).toHaveBeenCalledTimes(2)
    await commitGitChanges('/repo/a', 'Add things', scope)
    expect(git.commit).toHaveBeenCalledWith(scope, 'Add things', { amend: false, expectedBranch: 'main', operationId: expect.any(String) })
    expect(git.status).toHaveBeenCalledTimes(3)
  })

  it('passes the dirty-switch choice to the daemon and reports a kept stash', async () => {
    const git = installGit({ checkout: vi.fn(async () => ({ status: repoStatus(), stashKept: true })) })
    await refreshGitStatus('/repo/a')
    await expect(checkoutGitBranch('/repo/a', 'dev', scope, { dirty: 'stash' })).resolves.toEqual({ stashKept: true })
    expect(git.checkout).toHaveBeenCalledWith(scope, 'dev', { dirty: 'stash', operationId: expect.any(String) })
  })

  it('sends each new Git action with its scope, then refreshes once', async () => {
    const git = installGit()
    await refreshGitStatus('/repo/a')
    await stageGitPaths('/repo/a', ['a.ts', 'b.ts'], scope)
    expect(git.stage).toHaveBeenLastCalledWith(scope, { paths: ['a.ts', 'b.ts'] })
    await stageGitPaths('/repo/a', 'all', scope)
    expect(git.stage).toHaveBeenLastCalledWith(scope, { all: true })
    await unstageGitPaths('/repo/a', ['a.ts'], scope)
    expect(git.unstage).toHaveBeenLastCalledWith(scope, { paths: ['a.ts'] })
    await unstageGitPaths('/repo/a', 'all', scope)
    expect(git.unstage).toHaveBeenLastCalledWith(scope, { all: true })
    await discardGitPaths('/repo/a', ['a.ts'], threadScope)
    expect(git.discard).toHaveBeenLastCalledWith(threadScope, ['a.ts'])
    await expect(fetchGit('/repo/a', scope)).resolves.toEqual({ behindBefore: 0, behindAfter: 2 })
    await expect(pullGit('/repo/a', scope, { strategy: 'rebase' })).resolves.toEqual({ result: 'fast-forwarded' })
    expect(git.pull).toHaveBeenLastCalledWith(scope, { strategy: 'rebase', operationId: expect.any(String) })
    await abortGitInProgress('/repo/a', 'merge', scope)
    expect(git.abortInProgress).toHaveBeenLastCalledWith(scope, 'merge')
    await createGitBranch('/repo/a', 'topic', scope, { from: 'main', checkout: false })
    expect(git.createBranch).toHaveBeenLastCalledWith(scope, 'topic', { from: 'main', checkout: false })
    await renameGitBranch('/repo/a', 'topic', 'topic-2', scope)
    expect(git.renameBranch).toHaveBeenLastCalledWith(scope, 'topic', 'topic-2')
    await deleteGitBranch('/repo/a', 'topic-2', scope, { force: true })
    expect(git.deleteBranch).toHaveBeenLastCalledWith(scope, 'topic-2', { force: true })
    // The first load plus one refresh for each of the eleven actions.
    expect(git.status).toHaveBeenCalledTimes(12)
  })

  it('refreshes after a discard that fails, since part of it may have run', async () => {
    const git = installGit({ discard: vi.fn(async () => { throw new Error('busy') }) })
    await refreshGitStatus('/repo/a')
    await expect(discardGitPaths('/repo/a', ['a.ts'], scope)).rejects.toThrow('busy')
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('refreshes after a checkout that fails, since a stash-and-switch may have taken the changes away', async () => {
    const git = installGit({ checkout: vi.fn(async () => { throw new Error('local changes would be overwritten') }) })
    await refreshGitStatus('/repo/a')
    await expect(checkoutGitBranch('/repo/a', 'dev', scope, { dirty: 'stash' })).rejects.toThrow('overwritten')
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('refreshes after any other new Git action that fails', async () => {
    const fail = () => vi.fn(async () => { throw new Error('refused') })
    const git = installGit({ stage: fail(), unstage: fail(), fetch: fail(), createBranch: fail(), renameBranch: fail(), deleteBranch: fail() })
    await refreshGitStatus('/repo/a')
    let refreshes = 1
    for (const run of [
      () => stageGitPaths('/repo/a', ['a.ts'], scope),
      () => unstageGitPaths('/repo/a', 'all', scope),
      () => fetchGit('/repo/a', scope),
      () => createGitBranch('/repo/a', 'topic', scope),
      () => renameGitBranch('/repo/a', 'topic', 'topic-2', scope),
      () => deleteGitBranch('/repo/a', 'topic', scope)
    ]) {
      await expect(run()).rejects.toThrow('refused')
      refreshes += 1
      expect(git.status).toHaveBeenCalledTimes(refreshes)
    }
  })

  it('refreshes retained paths when the window regains focus, and stops after release', async () => {
    vi.useFakeTimers()
    const git = installGit()
    const listeners = new Map<string, () => void>()
    const win = (globalThis as unknown as { window: { addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> } }).window
    win.addEventListener.mockImplementation((type: string, listener: () => void) => { listeners.set(type, listener) })
    const releaseOne = retainGitPath('/repo/a')
    const releaseTwo = retainGitPath('/repo/a')
    expect(win.addEventListener).toHaveBeenCalledTimes(1)
    await refreshGitStatus('/repo/a')
    vi.advanceTimersByTime(5000)
    listeners.get('focus')?.()
    await vi.waitFor(() => expect(git.status).toHaveBeenCalledTimes(2))
    releaseOne()
    expect(win.removeEventListener).not.toHaveBeenCalled()
    releaseTwo()
    expect(win.removeEventListener).toHaveBeenCalledWith('focus', listeners.get('focus'))
  })
})

describe('retainGitPath release', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is idempotent: a second call does not take a count that belongs to another holder', () => {
    installGit()
    const win = (globalThis as unknown as { window: { addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> } }).window
    const releaseOne = retainGitPath('/repo/held')
    const releaseTwo = retainGitPath('/repo/held')
    releaseOne()
    releaseOne()
    releaseOne()
    // The second holder still keeps the path, and the shared listener, alive.
    expect(win.removeEventListener).not.toHaveBeenCalled()
    releaseTwo()
    expect(win.removeEventListener).toHaveBeenCalledTimes(1)
    releaseTwo()
    expect(win.removeEventListener).toHaveBeenCalledTimes(1)
  })
})

describe('anyTurnEnded', () => {
  const turn = (threadId: string, phase: TurnState['phase']): TurnState => ({
    threadId, turnId: 't', phase, updatedAt: '2026-10-24T10:00:00Z'
  })
  const snapshot = (...turns: TurnState[]): TurnStateSnapshot => Object.fromEntries(turns.map((t) => [t.threadId, t]))

  it('detects a running turn finishing', () => {
    expect(anyTurnEnded(snapshot(turn('a', 'streaming')), snapshot(turn('a', 'completed')))).toBe(true)
    expect(anyTurnEnded(snapshot(turn('a', 'tool_running')), snapshot(turn('a', 'stopped')))).toBe(true)
  })

  it('ignores turns that keep running, start, or were already finished', () => {
    expect(anyTurnEnded(snapshot(turn('a', 'thinking')), snapshot(turn('a', 'streaming')))).toBe(false)
    expect(anyTurnEnded(snapshot(turn('a', 'completed')), snapshot(turn('a', 'streaming')))).toBe(false)
    expect(anyTurnEnded(snapshot(turn('a', 'completed')), snapshot(turn('a', 'completed')))).toBe(false)
    const same = snapshot(turn('a', 'streaming'))
    expect(anyTurnEnded(same, same)).toBe(false)
  })
})

describe('git section formatting', () => {
  const NOW = Date.parse('2026-10-24T12:00:00Z')

  it('labels the diff stat with a real minus sign and flags zeros', () => {
    expect(diffStatLabel({ additions: 12, deletions: 3, filesChanged: 2 })).toEqual({
      added: '+12', removed: '−3', untracked: null, addedZero: false, removedZero: false, text: '+12 −3'
    })
    const onlyAdds = diffStatLabel({ additions: 5, deletions: 0, filesChanged: 1 })
    expect(onlyAdds.removedZero).toBe(true)
    expect(onlyAdds.addedZero).toBe(false)
    expect(diffStatLabel(null)).toMatchObject({ text: '+0 −0', addedZero: true, removedZero: true })
  })

  it('adds a short count of new files after the diff stat, since a diff never includes them', () => {
    const withNew = diffStatLabel({ additions: 0, deletions: 0, filesChanged: 0 }, 1)
    expect(withNew).toMatchObject({ untracked: '1 new', text: '+0 −0 · 1 new', addedZero: true, removedZero: true })
    expect(diffStatLabel({ additions: 4, deletions: 1, filesChanged: 2 }, 3).text).toBe('+4 −1 · 3 new')
    expect(diffStatLabel({ additions: 4, deletions: 1, filesChanged: 2 }).untracked).toBeNull()
    expect(diffStatLabel(null, 0).text).toBe('+0 −0')
  })

  it('counts only untracked files as new', () => {
    const status = repoStatus({
      changes: [
        { path: 'a.ts', status: 'modified', staged: false },
        { path: 'b.ts', status: 'untracked', staged: false },
        { path: 'c.ts', status: 'untracked', staged: false },
        { path: 'dist/x', status: 'ignored', staged: false }
      ]
    })
    expect(untrackedFileCount(status)).toBe(2)
    expect(untrackedFileCount(repoStatus())).toBe(0)
    expect(untrackedFileCount(null)).toBe(0)
  })

  it('counts a file staged and edited again once', () => {
    const status = repoStatus({
      changes: [
        { path: 'a.ts', status: 'modified', staged: true },
        { path: 'a.ts', status: 'modified', staged: false },
        { path: 'b.ts', status: 'added', staged: true },
        { path: 'b.ts', status: 'modified', staged: false },
        { path: 'c.ts', status: 'untracked', staged: false }
      ]
    })
    expect(changedFileCount(status)).toBe(3)
    expect(changesSummary(status)).toBe('3 files changed')
    expect(untrackedFileCount(status)).toBe(1)
  })

  it('summarizes changed files and ignores ignored ones', () => {
    const status = repoStatus({
      changes: [
        { path: 'a.ts', status: 'modified', staged: false },
        { path: 'b.ts', status: 'untracked', staged: false },
        { path: 'dist/x', status: 'ignored', staged: false }
      ]
    })
    expect(changedFileCount(status)).toBe(2)
    expect(changesSummary(status)).toBe('2 files changed')
    expect(changesSummary(repoStatus({ changes: [{ path: 'a.ts', status: 'added', staged: true }] }))).toBe('1 file changed')
    expect(changesSummary(repoStatus())).toBe('No changes')
    expect(changesSummary(null)).toBe('No changes')
  })

  it('formats relative time compactly', () => {
    const ago = (ms: number) => new Date(NOW - ms).toISOString()
    expect(relativeTime(ago(10_000), NOW)).toBe('now')
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5m')
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe('3h')
    expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe('2d')
    expect(relativeTime(ago(21 * 86_400_000), NOW)).toBe('3w')
    expect(relativeTime(ago(90 * 86_400_000), NOW)).toBe('3mo')
    expect(relativeTime(ago(800 * 86_400_000), NOW)).toBe('2y')
    expect(relativeTime(new Date(NOW + 60_000).toISOString(), NOW)).toBe('now')
    expect(relativeTime('not a date', NOW)).toBe('')
  })

  it('builds the commit line from the first message line and keeps the full message for the tooltip', () => {
    const line = formatCommitLine(
      commit({ message: 'Fix the flaky retry test\n\nThe timer was shared.', date: '2026-10-24T11:55:00Z' }),
      NOW
    )
    expect(line.subject).toBe('Fix the flaky retry test')
    expect(line.shortHash).toBe('a1b2c3d')
    expect(line.when).toBe('5m')
    expect(line.title).toContain('The timer was shared.')
    expect(line.title).toContain('a1b2c3d')
    expect(formatCommitLine(commit({ message: '  ' }), NOW).subject).toBe('(no message)')
  })

  it('lists local branches before remote ones and filters by the query', () => {
    const info: GitBranchInfo = { current: 'main', branches: ['remotes/origin/main', 'main', 'feature/login', 'remotes/origin/dev'] }
    expect(branchChoices(info, '')).toEqual(['main', 'feature/login', 'remotes/origin/main', 'remotes/origin/dev'])
    expect(branchChoices(info, ' LOG ')).toEqual(['feature/login'])
    expect(branchChoices(info, 'zzz')).toEqual([])
    expect(branchChoices(null, '')).toEqual([])
  })

  it('names the branch, including a detached or unborn checkout', () => {
    expect(branchLabel(repoStatus())).toBe('main')
    expect(branchLabel(repoStatus({ branch: null, tracking: 'detached' }))).toBe('Detached HEAD')
    expect(branchLabel(repoStatus({ branch: null, tracking: 'unborn' }))).toBe('No branch')
    expect(branchLabel(null)).toBe('No branch')
  })

  it('reads the daemon error code and message from an error that crossed the preload bridge', () => {
    const crossed = { name: 'StorageRequestError', code: 'git_checkout_dirty', message: 'Uncommitted changes would be overwritten by the switch.' }
    expect(gitErrorCode(crossed)).toBe('git_checkout_dirty')
    expect(gitErrorMessage(crossed)).toBe('Uncommitted changes would be overwritten by the switch.')
    expect(gitErrorCode(new Error('plain'))).toBeNull()
    expect(gitErrorCode('text')).toBeNull()
    expect(gitErrorCode(null)).toBeNull()
  })

  it('disables amend with its reason in a thread worktree', () => {
    const commits = [commit()]
    expect(commitMenuState(commits, 2, false).amendDisabled).toBe(false)
    const checkpointed = commitMenuState(commits, 2, true, true)
    expect(checkpointed).toMatchObject({ canAmend: false, amend: false, amendDisabled: true, amendTitle: "This thread's branch is checkpointed" })
    // No changes and nothing else to commit: the trigger stays off instead of forcing an amend.
    expect(commitMenuState(commits, 0, false, true)).toMatchObject({ triggerEnabled: false, amend: false })
  })

  it('reduces a git failure to one readable line', () => {
    const raw = new Error(
      "Error invoking remote method 'git:checkout': Error: error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\nPlease commit your changes"
    )
    expect(gitErrorMessage(raw)).toBe('Your local changes to the following files would be overwritten by checkout:')
    expect(gitErrorMessage('fatal: not a git repository')).toBe('not a git repository')
    expect(gitErrorMessage(new Error(''))).toBe('Git command failed')
  })
})

describe('git section stylesheet', () => {
  const css = readFileSync(resolve(__dirname, '../src/renderer/components/sideCard/gitSection.css'), 'utf8')
  // Body of the rule that opens with exactly this selector.
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`)
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start))
  }

  it('keeps the popover free of transitions, so focus can move in once it is positioned', () => {
    expect(rule('.side-card-git-popover')).toMatch(/transition:\s*none/)
  })

  it('marks the selected branch with a neutral fill, not an accent tint', () => {
    const selected = rule(".side-card-git-option[aria-selected='true']")
    expect(selected).toMatch(/background:\s*var\(--ui-pressed\)/)
    expect(selected).not.toContain('accent')
  })

  it('leaves the commit submit buttons neutral', () => {
    expect(rule('.side-card-git-submit')).not.toMatch(/accent/)
    expect(rule('.side-card-git-submit-quiet')).not.toMatch(/accent/)
  })

  it('removes the global focus ring from the branch search', () => {
    const focus = rule('.side-card-git-search input:focus')
    expect(focus).toMatch(/box-shadow:\s*none/)
    expect(focus).toMatch(/outline:\s*none/)
    expect(focus).toMatch(/border:\s*0/)
  })

  it('keeps the action buttons on one line and the branch name the part that shrinks', () => {
    expect(rule('.side-card-git-commit-button,\n.side-card-git-push')).toMatch(/flex:\s*none/)
    expect(rule('.side-card-git-commit-button,\n.side-card-git-push')).toMatch(/white-space:\s*nowrap/)
    expect(rule('.side-card-git-branch')).toMatch(/min-width:\s*0/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.side-card-git-pr-pending \{\s*animation: none/)
  })
})

describe('branch search semantics', () => {
  it('describes a combobox that controls the branch list and points at the active option', () => {
    expect(branchSearchAria('list-1', 2, 5)).toEqual({
      role: 'combobox',
      'aria-expanded': true,
      'aria-controls': 'list-1',
      'aria-autocomplete': 'list',
      'aria-activedescendant': 'list-1-2'
    })
  })

  it('points at no option when nothing matches', () => {
    expect(branchSearchAria('list-1', 0, 0)['aria-activedescendant']).toBeUndefined()
  })
})

describe('git section collapsed state', () => {
  const base = { hasProject: true, pathPending: false, hasPath: true, loaded: true, status: repoStatus() }

  it('stays expanded for a loaded repository', () => {
    expect(gitCollapsedLabel(base)).toBeNull()
  })

  it('collapses to one line for each reason there is nothing to manage', () => {
    expect(gitCollapsedLabel({ ...base, hasProject: false })).toBe('Git: no project')
    expect(gitCollapsedLabel({ ...base, pathPending: true })).toBe('Git: checking…')
    expect(gitCollapsedLabel({ ...base, hasPath: false })).toBe('Git: no project folder')
    expect(gitCollapsedLabel({ ...base, loaded: false, status: null })).toBe('Git: checking…')
    expect(gitCollapsedLabel({ ...base, status: null })).toBe('Git: unavailable')
    expect(gitCollapsedLabel({ ...base, status: repoStatus({ isRepo: false, branch: null }) })).toBe('Git: not a repository')
  })
})

describe('git section markup', () => {
  const view = (patch: Partial<GitStatusView> = {}): GitStatusView => ({
    ...EMPTY_GIT_ENTRY,
    loaded: true,
    refresh: async () => undefined,
    ...patch
  })
  const render = (props: { git: GitStatusView; collapsedLabel: string | null; path?: string | null }) =>
    renderToStaticMarkup(createElement(GitSectionView, {
      threadId: 't1',
      projectId: 'p1',
      path: props.path === undefined ? '/repo/a' : props.path,
      git: props.git,
      collapsedLabel: props.collapsedLabel,
      now: Date.parse('2026-10-24T10:05:00Z')
    }))

  it('shows a thread worktree branch as a label instead of a picker', () => {
    const html = renderToStaticMarkup(createElement(GitSectionView, {
      threadId: 't1',
      projectId: 'p1',
      workspaceThreadId: 't1',
      path: '/wt/t1',
      git: view({ status: repoStatus({ branch: 'mousse/thread/t1' }), commits: [commit()], branches: { current: 'mousse/thread/t1', branches: ['mousse/thread/t1'] } }),
      collapsedLabel: null,
      now: Date.parse('2026-10-24T10:05:00Z')
    }))
    expect(html).toContain('side-card-git-branch-static')
    expect(html).toContain('This thread works on its own branch')
    expect(html).toContain('mousse/thread/t1')
    expect(html).not.toMatch(/<button[^>]*class="side-card-git-branch"/)
  })

  it('renders only the quiet line when the folder is not a repository', () => {
    const html = render({
      git: view({ status: repoStatus({ isRepo: false, branch: null }) }),
      collapsedLabel: 'Git: not a repository'
    })
    expect(html).toContain('Git: not a repository')
    expect(html).toContain('side-card-git-quiet')
    expect(html).not.toContain('side-card-git-branch')
    expect(html).not.toContain('Commit')
    expect(html).not.toContain('<h3')
  })

  it('renders the quiet line for a thread without a project', () => {
    const html = render({ git: view(), collapsedLabel: 'Git: no project', path: null })
    expect(html).toContain('Git: no project')
    expect(html).not.toContain('side-card-git-branch')
  })

  it('renders branch, changes, latest commit and an enabled commit button for a repo with changes', () => {
    const html = render({
      git: view({
        status: repoStatus({ changes: [{ path: 'a.ts', status: 'modified', staged: false }] }),
        commits: [commit()],
        branches: { current: 'main', branches: ['main', 'dev'] },
        diffStats: { additions: 12, deletions: 3, filesChanged: 1 }
      }),
      collapsedLabel: null
    })
    expect(html).toContain('Git</h3>')
    expect(html).toContain('>main<')
    expect(html).toContain('1 file changed')
    expect(html).toContain('+12')
    expect(html).toContain('−3')
    expect(html).toContain('Fix the flaky retry test')
    expect(html).toContain('a1b2c3d')
    expect(html).toContain('>5m<')
    expect(html).toMatch(/<button[^>]*class="side-card-git-commit-button"(?![^>]*disabled)/)
  })

  it('counts a lone new file in the changes row and keeps the zero figures muted', () => {
    const html = render({
      git: view({
        status: repoStatus({ changes: [{ path: 'new.ts', status: 'untracked', staged: false }] }),
        commits: [commit()],
        branches: { current: 'main', branches: ['main'] },
        diffStats: { additions: 0, deletions: 0, filesChanged: 0 }
      }),
      collapsedLabel: null
    })
    expect(html).toContain('1 file changed')
    expect(html).toContain('data-zero="true">+0')
    expect(html).toContain('data-zero="true">−0')
    expect(html).toContain('side-card-git-new">· 1 new<')
    expect(html).toContain('+0 −0 · 1 new')
  })

  it('shows no new-file count when nothing is untracked', () => {
    const html = render({
      git: view({
        status: repoStatus({ changes: [{ path: 'a.ts', status: 'modified', staged: false }] }),
        diffStats: { additions: 2, deletions: 0, filesChanged: 1 }
      }),
      collapsedLabel: null
    })
    expect(html).not.toContain('side-card-git-new')
  })

  it('disables the commit button and mutes the stat when there are no changes', () => {
    const html = render({
      git: view({
        status: repoStatus(),
        commits: [commit({ pushed: true, onRemote: true })],
        branches: { current: 'main', branches: ['main'] },
        diffStats: { additions: 0, deletions: 0, filesChanged: 0 }
      }),
      collapsedLabel: null
    })
    expect(html).toContain('No changes')
    expect(html).toMatch(/class="side-card-git-commit-button"[^>]*disabled/)
    expect(html).toContain('title="No changes to commit"')
    expect(html).toContain('data-zero="true">+0')
    expect(html).toContain('data-zero="true">−0')
  })

  it('shows the verdict, the checks with their links, and the hint for a pull request read in full', () => {
    const detail = prDetail({
      reviewDecision: 'changes_requested',
      comments: [prComment('1'), prComment('2')],
      checkRuns: [
        { name: 'build', state: 'passing', url: 'https://ci.example.com/build', workflowName: 'CI' },
        { name: 'test', state: 'failing', url: 'https://ci.example.com/test', workflowName: 'CI' },
        { name: 'deploy', state: 'waiting', url: null }
      ]
    })
    const html = renderToStaticMarkup(createElement(GitSectionView, {
      threadId: 't1',
      ownThreadId: 't1',
      projectId: 'p1',
      workspaceThreadId: 't1',
      path: '/wt/t1',
      git: view({ status: repoStatus({ branch: 'mousse/thread/t1' }), branches: { current: 'mousse/thread/t1', branches: ['mousse/thread/t1'] } }),
      pullRequest: { state: 'found', pullRequest: detail },
      pullRequestDetail: detail,
      pullRequestLink: { number: 7 } as never,
      collapsedLabel: null
    }))
    expect(html).toContain('side-card-git-pr-verdict')
    expect(html).toContain('data-tone="failing">Changes requested')
    expect(html).toContain('2 comments')
    // A failing check opens the list; each check names its state, and one with a link is a button to it.
    expect(html).toContain('aria-expanded="true"')
    expect(html).toMatch(/side-card-git-pr-check-row" data-tone="failing"[^>]*>.*?test.*?title="Open this check"[^>]*>Failed/)
    expect(html).toMatch(/data-tone="passing"[^>]*>.*?build.*?>Passed/)
    expect(html).toMatch(/data-tone="waiting"[^>]*>.*?deploy.*?<span class="side-card-git-pr-check-state">Waiting for approval/)
    expect(html.indexOf('>test<')).toBeLessThan(html.indexOf('>build<'))
    expect(html).toContain('Merge back targets the primary checkout, not the PR')
  })

  it('keeps the check list closed while every check passed, and still names how many there are', () => {
    const detail = prDetail({ checkRuns: [{ name: 'build', state: 'passing', url: null }, { name: 'lint', state: 'skipped', url: null }] })
    const html = renderToStaticMarkup(createElement(GitSectionView, {
      threadId: 't1',
      projectId: 'p1',
      path: '/repo/a',
      git: view({ status: repoStatus() }),
      pullRequest: { state: 'found', pullRequest: detail },
      pullRequestDetail: detail,
      collapsedLabel: null
    }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('side-card-git-pr-checks-count">2')
    expect(html).not.toContain('side-card-git-pr-check-list')
    expect(html).not.toContain('side-card-git-pr-hint')
    expect(html).not.toContain('side-card-git-pr-verdict')
  })

  it('shows the host\'s message when the pull request could not be read, under the row', () => {
    const message = 'GraphQL: Could not resolve to a PullRequest with the number of 7. — signed in to github.com as octocat, which cannot see it.'
    const html = renderToStaticMarkup(createElement(GitSectionView, {
      threadId: 't1',
      projectId: 'p1',
      path: '/repo/a',
      git: view({ status: repoStatus() }),
      pullRequest: { state: 'found', pullRequest: prDetail() },
      pullRequestError: message,
      collapsedLabel: null
    }))
    expect(html).toContain('side-card-git-pr-error')
    expect(html).toContain('role="alert"')
    expect(html).toContain('signed in to github.com as octocat, which cannot see it.')
  })

  it('shows nothing of the detail for a merged pull request', () => {
    const detail = prDetail({ state: 'merged', reviewDecision: 'approved', checkRuns: [{ name: 'build', state: 'failing', url: null }] })
    const html = renderToStaticMarkup(createElement(GitSectionView, {
      threadId: 't1',
      projectId: 'p1',
      path: '/repo/a',
      git: view({ status: repoStatus() }),
      pullRequest: { state: 'found', pullRequest: detail },
      pullRequestDetail: detail,
      collapsedLabel: null
    }))
    expect(html).toContain('side-card-git-pr-suffix">Merged')
    expect(html).not.toContain('side-card-git-pr-checks')
    expect(html).not.toContain('side-card-git-pr-verdict')
  })

  it('marks the pull request detail with background colours only, never a side or edge bar', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/components/sideCard/gitSection.css'), 'utf8')
    const rules = [...css.matchAll(/([^{}]*side-card-git-pr-(?:review|verdict|checks|check-|hint|error)[^{}]*)\{([^}]*)\}/g)]
    expect(rules.length).toBeGreaterThan(10)
    for (const [, , body] of rules) {
      expect(body).not.toMatch(/border-(?:left|right|inline)(?:-width|-color)?\s*:/)
    }
  })
})

describe('the pull request row opens the panel', () => {
  const foundRow = () => {
    const row = pullRequestRow({ state: 'found', pullRequest: prDetail() }, repoStatus(), prDetail())
    if (row?.kind !== 'found') throw new Error('expected a found row')
    return row
  }

  /** Every button element in a rendered tree, found without a DOM. */
  const buttonsIn = (node: ReactNode): ReactElement<{ className?: string; onClick?: () => void; 'aria-label'?: string; title?: string }>[] => {
    if (!isValidElement(node)) return Array.isArray(node) ? node.flatMap(buttonsIn) : []
    const element = node as ReactElement<{ children?: ReactNode }>
    const own = element.type === 'button' ? [element as never] : []
    return [...own, ...buttonsIn(element.props.children)]
  }

  beforeEach(() => {
    useAppStore.setState({ mainView: 'git', openedSurfaceKinds: [], activeThreadId: null, mainAreaOpen: false })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('opens the Pull request surface from the title and number', () => {
    const [main] = buttonsIn(PullRequestLink({ row: foundRow() }))
    expect(main.props.className).toBe('side-card-git-pr')
    main.props.onClick?.()
    expect(useAppStore.getState().mainView).toBe('pullRequest')
    expect(useAppStore.getState().openedSurfaceKinds).toContain('pullRequest')
  })

  it('has a separate button that opens the pull request on the host in the browser, and leaves the app where it is', () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    const row = foundRow()
    const buttons = buttonsIn(PullRequestLink({ row }))
    const external = buttons.find((button) => button.props.className === 'side-card-git-pr-external')
    expect(external?.props['aria-label']).toBe('Open pull request #7 on GitHub')
    external?.props.onClick?.()
    expect(open).toHaveBeenCalledWith(row.url, '_blank', 'noopener,noreferrer')
    expect(useAppStore.getState().mainView).toBe('git')
  })

  it('renders both buttons in the side card, the first still named for the pull request', () => {
    const html = renderToStaticMarkup(createElement(GitSectionView, {
      threadId: 't1',
      projectId: 'p1',
      path: '/repo/a',
      git: { ...EMPTY_GIT_ENTRY, loaded: true, refresh: async () => undefined, status: repoStatus({ branch: 'feature/retry' }) },
      pullRequest: { state: 'found', pullRequest: prDetail() },
      pullRequestDetail: prDetail(),
      collapsedLabel: null
    }))
    expect(html).toContain('side-card-git-pr-line')
    expect(html).toMatch(/<button[^>]*class="side-card-git-pr"[^>]*aria-label="Pull request #7/)
    expect(html).toMatch(/<button[^>]*class="side-card-git-pr-external"[^>]*aria-label="Open pull request #7 on GitHub"/)
  })

  it('marks the external button with a background on hover and focus ring only', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/components/sideCard/gitSection.css'), 'utf8')
    const rule = /\.side-card-git-pr-external:hover\s*\{([^}]*)\}/.exec(css)
    expect(rule?.[1]).toMatch(/background:/)
    expect(rule?.[1]).not.toMatch(/border|shadow/)
  })
})

describe('the watch of the pull request in the side card', () => {
  const NOW = Date.parse('2026-10-27T10:00:00Z')
  const status = (patch: Partial<PullRequestWatchStatus> = {}): PullRequestWatchStatus => ({
    threadId: 't1',
    mode: 'notify',
    state: 'watching',
    nextCheckAt: '2026-10-27T10:04:00Z',
    ended: null,
    viewer: 'ada',
    host: 'github.com',
    actRefusal: null,
    ...patch
  })

  it('offers Off, Notify and Let the agent act, and says what the watch is doing', () => {
    const model = pullRequestWatchModel(status(), NOW)
    expect(model.options.map((option) => option.label)).toEqual(['Off', 'Notify', 'Let the agent act'])
    expect(model).toMatchObject({ mode: 'notify', watching: true, summary: 'Watching · next check in 4m' })
    expect(model.viewerLine).toBe('Comments by ada on github.com are not reported.')
    expect(pullRequestWatchModel(null, NOW)).toMatchObject({ mode: 'off', watching: false, summary: null, viewerLine: null, endedLine: null })
    expect(pullRequestWatchModel(status({ state: 'paused', nextCheckAt: '2026-10-27T10:10:00Z' }), NOW).summary).toBe('Waiting for GitHub · next check in 10m')
  })

  it('disables acting on a subagent thread with the reason, and names why a watch ended', () => {
    const refusal = "A subagent thread can only be notified: a pending notice would hold its parent's task open"
    const model = pullRequestWatchModel(status({ actRefusal: refusal }), NOW)
    expect(model.options.find((option) => option.mode === 'act')?.disabledReason).toBe(refusal)
    expect(model.options.find((option) => option.mode === 'notify')?.disabledReason).toBeNull()
    const ended = pullRequestWatchModel(status({ mode: 'off', state: 'ended', ended: { reason: 'merged', at: '2026-10-27T09:59:00Z' } }), NOW)
    expect(ended).toMatchObject({ mode: 'off', watching: false, endedLine: 'The pull request was merged, so the watch ended.' })
  })

  it('formats the wait in seconds and minutes', () => {
    expect(inTime('2026-10-27T10:00:30Z', NOW)).toBe('in 30s')
    expect(inTime('2026-10-27T10:10:00Z', NOW)).toBe('in 10m')
    expect(inTime('2026-10-27T09:59:00Z', NOW)).toBe('now')
    expect(inTime(null, NOW)).toBe('now')
  })

  const sectionWith = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(GitSectionView, {
    threadId: 't1',
    ownThreadId: 't1',
    projectId: 'p1',
    path: '/repo/a',
    git: { ...EMPTY_GIT_ENTRY, loaded: true, refresh: async () => undefined, status: repoStatus({ branch: 'feature/retry' }) },
    pullRequest: { state: 'found', pullRequest: prDetail() },
    pullRequestDetail: prDetail(),
    collapsedLabel: null,
    now: NOW,
    ...props
  }))

  it('shows the control under the pull request, with the viewer line and the next check', () => {
    const html = sectionWith({ pullRequestWatch: status(), onWatchChange: async () => undefined })
    expect(html).toContain('side-card-git-pr-watch')
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>Notify</)
    expect(html).toContain('Watching · next check in 4m')
    expect(html).toContain('Comments by ada on github.com are not reported.')
  })

  it('is hidden without a pull request, for a merged one, and for a thread that is not its own', () => {
    expect(sectionWith({ onWatchChange: async () => undefined, pullRequest: { state: 'none', isDefaultBranch: false }, pullRequestDetail: null })).not.toContain('side-card-git-pr-watch')
    expect(sectionWith({ onWatchChange: async () => undefined, pullRequest: { state: 'found', pullRequest: prDetail({ state: 'merged' }) } })).not.toContain('side-card-git-pr-watch')
    expect(sectionWith({ onWatchChange: async () => undefined, ownThreadId: null })).not.toContain('side-card-git-pr-watch')
    expect(sectionWith({})).not.toContain('side-card-git-pr-watch')
  })

  it('marks the chosen option with a background, never an edge bar', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/components/sideCard/gitSection.css'), 'utf8')
    const rule = /\.side-card-git-pr-watch-option\[aria-checked='true'\]\s*\{([^}]*)\}/.exec(css)
    expect(rule?.[1]).toMatch(/background:/)
    expect(rule?.[1]).not.toMatch(/border|shadow|outline/)
  })
})

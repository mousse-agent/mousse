import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/stores/appStore'
import {
  CommitPushError,
  OpenPullRequestError,
  commitGitChanges,
  initGitRepository,
  pushGitBranch,
  refreshGitStatus,
  useGitStatusStore
} from '../src/renderer/stores/gitStatusStore'
import {
  PULL_REQUEST_MAX_AGE_MS,
  closeCreatePullRequestForm,
  composeThreadPullRequest,
  createPullRequestForBranch,
  draftPullRequestFor,
  loadPullRequestBaseBranches,
  openCreatePullRequestForm,
  findsByBranch,
  openFoundNumber,
  pullRequestDetailKey,
  pullRequestKey,
  refreshPullRequest,
  refreshPullRequestDetail,
  retainPullRequest,
  retainPullRequestDetail,
  setPullRequestTracked,
  submitCreatePullRequest,
  mergePullRequest,
  closePullRequest,
  useGitPullRequestStore
} from '../src/renderer/stores/pullRequestStore'
import type { GitPullRequestInfo, PullRequestDetail, PullRequestScope } from '../src/shared/pullRequests'
import type { GitPullRequestLookup, GitStatusSnapshot, TurnState } from '../src/shared/types'

const lookup = (number: number): GitPullRequestLookup => ({
  state: 'found',
  pullRequest: {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    state: 'open',
    isDraft: false,
    checks: 'passing',
    checkCounts: { passed: 1, failed: 0, pending: 0, waiting: 0, total: 1 }
  }
})

const lookupInfo = (number: number): GitPullRequestInfo => (lookup(number) as { pullRequest: GitPullRequestInfo }).pullRequest

const detail = (number: number, patch: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  ...lookupInfo(number),
  identity: { host: 'github.com', nameWithOwner: 'acme/app', number },
  body: '',
  author: 'ada',
  headRefName: 'feature',
  baseRefName: 'main',
  headSha: 'abc1234',
  headRepository: 'acme/app',
  baseRepository: 'acme/app',
  isCrossRepository: false,
  reviewDecision: 'approved',
  reviews: [],
  comments: [],
  commentsTruncated: false,
  checkRuns: [{ name: 'build', state: 'passing', url: 'https://github.com/acme/app/actions/runs/1' }],
  updatedAt: '2026-10-26T12:00:00Z',
  mergedAt: null,
  closedAt: null,
  ...patch
})

const scope = (patch: Partial<PullRequestScope> = {}): PullRequestScope => ({
  threadId: 't1',
  originThreadId: 't1',
  path: '/repo/a',
  branch: 'feature',
  ...patch
})

const repoStatus = (patch: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot => ({
  isRepo: true,
  branch: 'feature',
  upstream: 'origin/feature',
  tracking: 'tracked',
  ahead: 0,
  behind: 0,
  changes: [],
  ...patch
})

interface Mock {
  pullRequest: ReturnType<typeof vi.fn>
  detail: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  draft: ReturnType<typeof vi.fn>
  baseBranches: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  init: ReturnType<typeof vi.fn>
  push: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
}

const project = { projectId: 'p1', workspaceThreadId: null }
const standalone = { projectId: null, workspaceThreadId: null }

const listeners = new Map<string, () => void>()
const removeEventListener = vi.fn()

const install = (patch: Partial<Mock> = {}): Mock => {
  const git: Mock = {
    pullRequest: vi.fn(async () => lookup(1)),
    detail: vi.fn(async (_ref: unknown, number: number) => detail(number)),
    create: vi.fn(async () => ({ pullRequest: lookupInfo(2), existing: false })),
    draft: vi.fn(async () => ({ title: 'T', body: 'B', base: 'main', source: 'heuristic' })),
    baseBranches: vi.fn(async () => ({ defaultBranch: 'main', branches: ['main'] })),
    commit: vi.fn(async () => ({ status: repoStatus() })),
    init: vi.fn(async () => ({ status: repoStatus() })),
    push: vi.fn(async () => ({ status: repoStatus() })),
    status: vi.fn(async () => repoStatus()),
    ...patch
  }
  const { pullRequest, detail: readDetail, create, draft, baseBranches, ...gitMethods } = git
  vi.stubGlobal('window', {
    mousse: {
      pullRequests: { get: pullRequest, detail: readDetail, create, draft, baseBranches },
      git: {
        ...gitMethods,
        log: vi.fn(async () => []),
        branches: vi.fn(async () => ({ current: 'feature', branches: ['feature'] })),
        diffStats: vi.fn(async () => ({ additions: 0, deletions: 0, filesChanged: 0 }))
      }
    },
    addEventListener: vi.fn((type: string, listener: () => void) => { listeners.set(type, listener) }),
    removeEventListener
  })
  return git
}

const entry = (path: string, branch: string) => useGitPullRequestStore.getState().entries[pullRequestKey(path, branch)]

const GIT_SCOPE = { projectId: 'project-1', workspaceThreadId: null }

describe('pull request store', () => {
  beforeEach(() => {
    useGitPullRequestStore.setState({ entries: {}, details: {} })
    useGitStatusStore.setState({ entries: {} })
    listeners.clear()
    removeEventListener.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shares one lookup between concurrent requests for the same path and branch', async () => {
    const git = install()
    await Promise.all([
      refreshPullRequest('/repo/a', 'feature', { projectId: 'p1' }),
      refreshPullRequest('/repo/a', 'feature'),
      refreshPullRequest('/repo/a', 'feature')
    ])
    expect(git.pullRequest).toHaveBeenCalledTimes(1)
    expect(git.pullRequest).toHaveBeenCalledWith({ projectId: 'p1' }, 'feature')
    expect(entry('/repo/a', 'feature').lookup).toEqual(lookup(1))
  })

  it('asks the daemon about the thread when the reader has one, and about the project otherwise', async () => {
    const git = install()
    await refreshPullRequest('/repo/a', 'feature', { projectId: 'p1', threadId: 't1' })
    await refreshPullRequest('/repo/b', 'feature', { projectId: 'p1' })
    await refreshPullRequest('/repo/c', 'feature')
    expect(git.pullRequest).toHaveBeenNthCalledWith(1, { threadId: 't1' }, 'feature')
    expect(git.pullRequest).toHaveBeenNthCalledWith(2, { projectId: 'p1' }, 'feature')
    expect(git.pullRequest).toHaveBeenNthCalledWith(3, {}, 'feature')
  })

  it('borrows the retained reader\'s thread when a refresh names none', async () => {
    const git = install()
    const release = retainPullRequest('/repo/a', 'feature', 'p1', 't1')
    await refreshPullRequest('/repo/a', 'feature', { force: true, projectId: 'p1' })
    expect(git.pullRequest).toHaveBeenCalledWith({ threadId: 't1' }, 'feature', true)
    release()
  })

  it('asks about the branch of the entry it stores the result under', async () => {
    const git = install({
      pullRequest: vi.fn(async (_ref: unknown, branch: unknown) => lookup(branch === 'other' ? 2 : 1))
    })
    await Promise.all([
      refreshPullRequest('/repo/a', 'feature', { projectId: 'p1' }),
      refreshPullRequest('/repo/a', 'other', { projectId: 'p1' })
    ])
    expect(git.pullRequest).toHaveBeenCalledWith({ projectId: 'p1' }, 'feature')
    expect(git.pullRequest).toHaveBeenCalledWith({ projectId: 'p1' }, 'other')
    expect(entry('/repo/a', 'feature').lookup).toEqual(lookup(1))
    expect(entry('/repo/a', 'other').lookup).toEqual(lookup(2))
  })

  it('keeps one entry per path and branch', async () => {
    const git = install()
    await Promise.all([
      refreshPullRequest('/repo/a', 'feature'),
      refreshPullRequest('/repo/a', 'other'),
      refreshPullRequest('/repo/b', 'feature')
    ])
    expect(git.pullRequest).toHaveBeenCalledTimes(3)
    expect(Object.keys(useGitPullRequestStore.getState().entries)).toHaveLength(3)
  })

  it('treats a lookup under 60 seconds old as fresh, and refetches after that', async () => {
    vi.useFakeTimers()
    const git = install()
    await refreshPullRequest('/repo/a', 'feature')
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS - 1000)
    await refreshPullRequest('/repo/a', 'feature')
    expect(git.pullRequest).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    await refreshPullRequest('/repo/a', 'feature')
    expect(git.pullRequest).toHaveBeenCalledTimes(2)
    expect(PULL_REQUEST_MAX_AGE_MS).toBe(60_000)
  })

  it('refetches when forced, and queues exactly one more fetch behind one in flight', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const git = install({
      pullRequest: vi.fn()
        .mockImplementationOnce(async () => { await gate; return lookup(1) })
        .mockImplementation(async () => lookup(2))
    })
    const first = refreshPullRequest('/repo/a', 'feature')
    const forced = refreshPullRequest('/repo/a', 'feature', { force: true })
    const forcedAgain = refreshPullRequest('/repo/a', 'feature', { force: true })
    release?.()
    await Promise.all([first, forced, forcedAgain])
    expect(git.pullRequest).toHaveBeenCalledTimes(2)
    expect(entry('/repo/a', 'feature').lookup).toEqual(lookup(2))
    // Only the fetch queued behind the first skips the daemon's cache.
    expect(git.pullRequest.mock.calls.map((call) => call[2])).toEqual([undefined, true])
  })

  it('has the daemon skip its cache for a forced refresh only', async () => {
    const git = install()
    await refreshPullRequest('/repo/a', 'feature')
    await refreshPullRequest('/repo/a', 'feature', { force: true })
    expect(git.pullRequest.mock.calls.map((call) => call[2])).toEqual([undefined, true])
  })

  it('keeps the lookup on screen when a refresh fails, and reports an error when there was none', async () => {
    const git = install()
    await refreshPullRequest('/repo/a', 'feature')
    git.pullRequest.mockRejectedValueOnce(new Error('offline'))
    await refreshPullRequest('/repo/a', 'feature', { force: true })
    expect(entry('/repo/a', 'feature').lookup).toEqual(lookup(1))
    git.pullRequest.mockRejectedValueOnce(new Error('offline'))
    await expect(refreshPullRequest('/repo/b', 'feature')).resolves.toBeUndefined()
    expect(entry('/repo/b', 'feature').lookup).toMatchObject({ state: 'unavailable', reason: 'error', message: 'offline' })
  })

  it('refreshes retained branches on focus within the max age rules, and stops after release', async () => {
    vi.useFakeTimers()
    const git = install()
    const releaseOne = retainPullRequest('/repo/a', 'feature')
    const releaseTwo = retainPullRequest('/repo/a', 'feature')
    const win = (globalThis as unknown as { window: { addEventListener: ReturnType<typeof vi.fn> } }).window
    expect(win.addEventListener).toHaveBeenCalledTimes(1)
    await refreshPullRequest('/repo/a', 'feature')
    listeners.get('focus')?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(git.pullRequest).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS + 1)
    listeners.get('focus')?.()
    await vi.waitFor(() => expect(git.pullRequest).toHaveBeenCalledTimes(2))
    releaseOne()
    expect(removeEventListener).not.toHaveBeenCalled()
    releaseTwo()
    releaseTwo()
    expect(removeEventListener).toHaveBeenCalledTimes(1)
  })

  it('looks an untracked branch with no pull request up on mount but not on focus or when a run ends', async () => {
    vi.useFakeTimers()
    const git = install({ pullRequest: vi.fn(async () => ({ state: 'none', isDefaultBranch: false })) })
    const turn = (phase: TurnState['phase']): TurnState => ({ threadId: 't1', turnId: 'x', phase, updatedAt: '2026-10-26T10:00:00Z' })
    useAppStore.setState({ turnStates: { t1: turn('streaming') } })
    const release = retainPullRequest('/repo/a', 'feature', 'p1')
    setPullRequestTracked('/repo/a', 'feature', false)
    await refreshPullRequest('/repo/a', 'feature', { projectId: 'p1' })
    expect(git.pullRequest).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS + 1)
    listeners.get('focus')?.()
    useAppStore.setState({ turnStates: { t1: turn('completed') } })
    await vi.advanceTimersByTimeAsync(0)
    expect(git.pullRequest).toHaveBeenCalledTimes(1)
    // Pushing the branch gives it an upstream, and then focus looks it up again.
    setPullRequestTracked('/repo/a', 'feature', true)
    listeners.get('focus')?.()
    await vi.waitFor(() => expect(git.pullRequest).toHaveBeenCalledTimes(2))
    release()
    useAppStore.setState({ turnStates: {} })
  })

  it('refreshes retained branches when a run ends, throttled by the max age', async () => {
    vi.useFakeTimers()
    const git = install()
    const turn = (phase: TurnState['phase']): TurnState => ({ threadId: 't1', turnId: 'x', phase, updatedAt: '2026-10-24T10:00:00Z' })
    useAppStore.setState({ turnStates: { t1: turn('streaming') } })
    const release = retainPullRequest('/repo/a', 'feature')
    await refreshPullRequest('/repo/a', 'feature')
    useAppStore.setState({ turnStates: { t1: turn('completed') } })
    await vi.advanceTimersByTimeAsync(0)
    expect(git.pullRequest).toHaveBeenCalledTimes(1)
    useAppStore.setState({ turnStates: { t1: turn('streaming') } })
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS + 1)
    useAppStore.setState({ turnStates: { t1: turn('completed') } })
    await vi.waitFor(() => expect(git.pullRequest).toHaveBeenCalledTimes(2))
    release()
    useAppStore.setState({ turnStates: {} })
  })

  it('keeps refreshing a branch that already found a pull request on focus and when a run ends, with or without an upstream', async () => {
    vi.useFakeTimers()
    const git = install()
    const turn = (phase: TurnState['phase']): TurnState => ({ threadId: 't1', turnId: 'x', phase, updatedAt: '2026-10-26T10:00:00Z' })
    useAppStore.setState({ turnStates: { t1: turn('streaming') } })
    const release = retainPullRequest('/repo/a', 'feature', 'p1')
    // Pushed without `-u`: the branch has no upstream, but the lookup found its pull request.
    setPullRequestTracked('/repo/a', 'feature', false)
    await refreshPullRequest('/repo/a', 'feature', { projectId: 'p1' })
    expect(entry('/repo/a', 'feature').lookup).toMatchObject({ state: 'found' })
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS + 1)
    listeners.get('focus')?.()
    await vi.waitFor(() => expect(git.pullRequest).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(0)
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS + 1)
    useAppStore.setState({ turnStates: { t1: turn('completed') } })
    await vi.waitFor(() => expect(git.pullRequest).toHaveBeenCalledTimes(3))
    release()
    useAppStore.setState({ turnStates: {} })
  })

  it('stops refreshing a pull request that was merged, and a branch with none and no upstream', async () => {
    vi.useFakeTimers()
    const merged = (): GitPullRequestLookup => ({ state: 'found', pullRequest: { ...lookupInfo(4), state: 'merged' } })
    const none = (): GitPullRequestLookup => ({ state: 'none', isDefaultBranch: false })
    const git = install({
      pullRequest: vi.fn(async (_ref: unknown, branch: unknown) => (branch === 'merged' ? merged() : none()))
    })
    const releaseMerged = retainPullRequest('/repo/a', 'merged', 'p1')
    const releaseNone = retainPullRequest('/repo/a', 'none', 'p1')
    setPullRequestTracked('/repo/a', 'merged', false)
    setPullRequestTracked('/repo/a', 'none', false)
    await Promise.all([refreshPullRequest('/repo/a', 'merged'), refreshPullRequest('/repo/a', 'none')])
    expect(git.pullRequest).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS + 1)
    listeners.get('focus')?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(git.pullRequest).toHaveBeenCalledTimes(2)
    releaseMerged()
    releaseNone()
  })

  it('does not schedule a refresh for the next focus when Create PR opens the form', async () => {
    const git = install()
    const release = retainPullRequest('/repo/a', 'feature', 'p1')
    await refreshPullRequest('/repo/a', 'feature')
    await createPullRequestForBranch(scope())
    expect(useGitPullRequestStore.getState().createForm).toEqual(scope())
    listeners.get('focus')?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(git.pullRequest).toHaveBeenCalledTimes(1)
    release()
  })
})

describe('pull request detail', () => {
  const detailEntry = (path: string, number: number) => useGitPullRequestStore.getState().details[pullRequestDetailKey(path, number)]

  beforeEach(() => {
    useGitPullRequestStore.setState({ entries: {}, details: {} })
    useGitStatusStore.setState({ entries: {} })
    listeners.clear()
    removeEventListener.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shares one read between concurrent requests, asks as the thread when given one, and keys by folder and number', async () => {
    const git = install()
    await Promise.all([
      refreshPullRequestDetail('/repo/a', 7, { threadId: 't1' }),
      refreshPullRequestDetail('/repo/a', 7),
      refreshPullRequestDetail('/repo/a', 7, { projectId: 'p1' })
    ])
    expect(git.detail).toHaveBeenCalledTimes(1)
    expect(git.detail).toHaveBeenCalledWith({ threadId: 't1' }, 7)
    expect(detailEntry('/repo/a', 7).detail).toMatchObject({ number: 7, reviewDecision: 'approved' })
    await refreshPullRequestDetail('/repo/b', 7, { projectId: 'p1' })
    await refreshPullRequestDetail('/repo/a', 8)
    expect(git.detail).toHaveBeenCalledTimes(3)
    expect(Object.keys(useGitPullRequestStore.getState().details)).toHaveLength(3)
  })

  it('treats a detail under 60 seconds old as fresh, forces past it, and queues one more read behind one in flight', async () => {
    vi.useFakeTimers()
    const git = install()
    await refreshPullRequestDetail('/repo/a', 7)
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS - 1000)
    await refreshPullRequestDetail('/repo/a', 7)
    expect(git.detail).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    await refreshPullRequestDetail('/repo/a', 7)
    expect(git.detail).toHaveBeenCalledTimes(2)

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    git.detail.mockImplementationOnce(async () => { await gate; return detail(7) })
    const first = refreshPullRequestDetail('/repo/a', 7, { force: true })
    const forced = refreshPullRequestDetail('/repo/a', 7, { force: true })
    const forcedAgain = refreshPullRequestDetail('/repo/a', 7, { force: true })
    release?.()
    await Promise.all([first, forced, forcedAgain])
    expect(git.detail).toHaveBeenCalledTimes(4)
    expect(git.detail.mock.calls.map((call) => call[2])).toEqual([undefined, undefined, true, true])
  })

  it('keeps unchanged data by reference, so what shows it does not render again, and replaces it when it changed', async () => {
    const git = install()
    await refreshPullRequestDetail('/repo/a', 7)
    const first = detailEntry('/repo/a', 7)
    await refreshPullRequestDetail('/repo/a', 7, { force: true })
    const second = detailEntry('/repo/a', 7)
    expect(second.detail).toBe(first.detail)
    expect(second.fetchedAt).toBeGreaterThanOrEqual(first.fetchedAt)
    git.detail.mockResolvedValueOnce(detail(7, { reviewDecision: 'changes_requested' }))
    await refreshPullRequestDetail('/repo/a', 7, { force: true })
    expect(detailEntry('/repo/a', 7).detail).not.toBe(first.detail)
    expect(detailEntry('/repo/a', 7).detail?.reviewDecision).toBe('changes_requested')
  })

  it('shows the host\'s message when a read fails, keeps the detail already shown, and clears the message on the next good read', async () => {
    const git = install()
    git.detail.mockRejectedValueOnce(new Error("Error invoking remote method 'pullRequests:detail': DomainRpcError: GraphQL: Could not resolve to a PullRequest with the number of 7. — signed in to github.com as octocat, which cannot see it."))
    await expect(refreshPullRequestDetail('/repo/a', 7)).resolves.toBeUndefined()
    expect(detailEntry('/repo/a', 7)).toMatchObject({
      detail: null,
      error: 'GraphQL: Could not resolve to a PullRequest with the number of 7. — signed in to github.com as octocat, which cannot see it.'
    })
    await refreshPullRequestDetail('/repo/a', 7, { force: true })
    expect(detailEntry('/repo/a', 7)).toMatchObject({ error: null, detail: { number: 7 } })
    git.detail.mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway'))
    await refreshPullRequestDetail('/repo/a', 7, { force: true })
    expect(detailEntry('/repo/a', 7)).toMatchObject({ error: 'HTTP 502: Bad Gateway', detail: { number: 7 } })
  })

  it('refreshes retained details with the lookups on focus and when a run ends, until merged, and stops after release', async () => {
    vi.useFakeTimers()
    const git = install()
    const turn = (phase: TurnState['phase']): TurnState => ({ threadId: 't1', turnId: 'x', phase, updatedAt: '2026-10-26T10:00:00Z' })
    useAppStore.setState({ turnStates: { t1: turn('streaming') } })
    const release = retainPullRequestDetail('/repo/a', 7, 'p1', 't1')
    await refreshPullRequestDetail('/repo/a', 7)
    listeners.get('focus')?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(git.detail).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS + 1)
    listeners.get('focus')?.()
    await vi.waitFor(() => expect(git.detail).toHaveBeenCalledTimes(2))
    // The retained reader's thread is the one it asks as.
    expect(git.detail.mock.calls[1][0]).toEqual({ threadId: 't1' })
    await vi.advanceTimersByTimeAsync(0)
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS + 1)
    useAppStore.setState({ turnStates: { t1: turn('completed') } })
    await vi.waitFor(() => expect(git.detail).toHaveBeenCalledTimes(3))
    await vi.advanceTimersByTimeAsync(0)

    // A merged pull request is final and is left alone.
    git.detail.mockResolvedValueOnce(detail(7, { state: 'merged' }))
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS + 1)
    listeners.get('focus')?.()
    await vi.waitFor(() => expect(git.detail).toHaveBeenCalledTimes(4))
    await vi.advanceTimersByTimeAsync(0)
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS + 1)
    listeners.get('focus')?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(git.detail).toHaveBeenCalledTimes(4)

    expect(removeEventListener).not.toHaveBeenCalled()
    release()
    release()
    expect(removeEventListener).toHaveBeenCalledTimes(1)
    useAppStore.setState({ turnStates: {} })
  })

  it('keeps the window listener while either a lookup or a detail is retained', () => {
    install()
    const win = (globalThis as unknown as { window: { addEventListener: ReturnType<typeof vi.fn> } }).window
    const releaseLookup = retainPullRequest('/repo/a', 'feature')
    const releaseDetail = retainPullRequestDetail('/repo/a', 7)
    expect(win.addEventListener).toHaveBeenCalledTimes(1)
    releaseLookup()
    expect(removeEventListener).not.toHaveBeenCalled()
    releaseDetail()
    expect(removeEventListener).toHaveBeenCalledTimes(1)
  })
})

describe('what the side card reads for a thread', () => {
  const link = { number: 7 }
  const entryOf = (patch: Partial<{ detail: PullRequestDetail | null; error: string | null }> = {}) => ({ detail: detail(7), error: null, fetchedAt: 1, ...patch })

  it('reads a linked pull request by its number, and the branch only when there is no link or the link cannot be read', () => {
    expect(findsByBranch(null, null)).toBe(true)
    expect(findsByBranch(link.number, null)).toBe(false)
    expect(findsByBranch(link.number, entryOf())).toBe(false)
    expect(findsByBranch(link.number, entryOf({ detail: null, error: 'HTTP 502' }))).toBe(true)
    // A failed refresh that kept an earlier detail still has the pull request.
    expect(findsByBranch(link.number, entryOf({ error: 'HTTP 502' }))).toBe(false)
  })

  it('reads only an open pull request found by the branch in full', () => {
    expect(openFoundNumber(lookup(7))).toBe(7)
    expect(openFoundNumber({ state: 'found', pullRequest: { ...lookupInfo(7), state: 'merged' } })).toBeNull()
    expect(openFoundNumber({ state: 'found', pullRequest: { ...lookupInfo(7), state: 'closed' } })).toBeNull()
    expect(openFoundNumber({ state: 'none', isDefaultBranch: false })).toBeNull()
    expect(openFoundNumber(null)).toBeNull()
  })

  it('builds the row\'s pull request from the linked detail, and shows nothing until it has been read', () => {
    const loaded = composeThreadPullRequest({ linkNumber: 7, linkedEntry: entryOf(), lookup: null, foundEntry: null })
    expect(loaded).toMatchObject({ linked: true, detailError: null, detail: { number: 7 }, lookup: { state: 'found', pullRequest: { number: 7 } } })
    expect(composeThreadPullRequest({ linkNumber: 7, linkedEntry: null, lookup: null, foundEntry: null })).toEqual({
      lookup: null, detail: null, detailError: null, linked: true
    })
  })

  it('shows the host\'s message for a linked pull request that could not be read, next to what the branch found', () => {
    const failed = entryOf({ detail: null, error: 'GraphQL: Could not resolve to a PullRequest' })
    expect(composeThreadPullRequest({ linkNumber: 7, linkedEntry: failed, lookup: null, foundEntry: null })).toEqual({
      lookup: null, detail: null, detailError: 'GraphQL: Could not resolve to a PullRequest', linked: false
    })
    const found = composeThreadPullRequest({ linkNumber: 7, linkedEntry: failed, lookup: lookup(8), foundEntry: entryOf({ detail: detail(8) }) })
    expect(found).toMatchObject({ linked: false, lookup: { pullRequest: { number: 8 } }, detail: { number: 8 }, detailError: null })
  })

  it('uses the branch lookup and its detail for a thread with no link', () => {
    const view = composeThreadPullRequest({ linkNumber: null, linkedEntry: null, lookup: lookup(7), foundEntry: entryOf() })
    expect(view).toMatchObject({ linked: false, lookup: { state: 'found' }, detail: { number: 7 }, detailError: null })
    const unread = composeThreadPullRequest({ linkNumber: null, linkedEntry: null, lookup: lookup(7), foundEntry: entryOf({ detail: null, error: 'HTTP 502: Bad Gateway' }) })
    expect(unread).toMatchObject({ lookup: { state: 'found' }, detail: null, detailError: 'HTTP 502: Bad Gateway' })
  })
})

describe('create form', () => {
  beforeEach(() => {
    useGitPullRequestStore.setState({ entries: {}, createForm: null })
    useGitStatusStore.setState({ entries: {} })
    listeners.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('opens for the scope it is given, and closes', async () => {
    install()
    await createPullRequestForBranch(scope())
    expect(useGitPullRequestStore.getState().createForm).toEqual(scope())
    closeCreatePullRequestForm()
    expect(useGitPullRequestStore.getState().createForm).toBeNull()
    openCreatePullRequestForm(scope({ branch: 'other' }))
    expect(useGitPullRequestStore.getState().createForm?.branch).toBe('other')
  })

  it('submits for the branch, thread and folder captured at open, even if the active thread changes meanwhile', async () => {
    const git = install()
    const opened = scope({ threadId: 't1', originThreadId: 't1' })
    await createPullRequestForBranch(opened)
    // Another thread becomes active and another form opens in the store; the submit still carries the captured scope.
    useAppStore.setState({ activeThreadId: 't2' } as never)
    openCreatePullRequestForm(scope({ threadId: 't2', originThreadId: 't2', branch: 'elsewhere' }))
    await submitCreatePullRequest(opened, { title: 'Add thing', body: 'Why', base: 'main', draft: false })
    expect(git.create).toHaveBeenCalledWith(opened, { title: 'Add thing', body: 'Why', base: 'main', draft: false })
    expect(git.create.mock.calls[0][0]).toMatchObject({ branch: 'feature', originThreadId: 't1', threadId: 't1' })
    expect(entry('/repo/a', 'elsewhere')).toBeUndefined()
  })

  it('stores the result under the key of the scope it was created for, and refreshes it past the caches', async () => {
    const git = install({ create: vi.fn(async () => ({ pullRequest: lookupInfo(9), existing: false })), pullRequest: vi.fn(async () => lookup(9)) })
    await submitCreatePullRequest(scope(), { title: 'T', body: '', base: 'main', draft: true })
    expect(entry('/repo/a', 'feature').lookup).toEqual({ state: 'found', pullRequest: lookupInfo(9) })
    await vi.waitFor(() => expect(git.pullRequest).toHaveBeenCalledWith({ threadId: 't1' }, 'feature', true))
  })

  it('returns the open pull request the branch already had, and stores it', async () => {
    install({ create: vi.fn(async () => ({ pullRequest: lookupInfo(5), existing: true })), pullRequest: vi.fn(async () => lookup(5)) })
    const result = await submitCreatePullRequest(scope(), { title: 'T', body: '', base: 'main', draft: false })
    expect(result).toEqual({ pullRequest: lookupInfo(5), existing: true })
    expect(entry('/repo/a', 'feature').lookup).toEqual({ state: 'found', pullRequest: lookupInfo(5) })
  })

  it('keeps the form and caches nothing when the create is refused, as for a branch that moved', async () => {
    const git = install({ create: vi.fn(async () => { throw new Error('The branch changed while this was open. Review it, then try again.') }) })
    await createPullRequestForBranch(scope())
    await expect(submitCreatePullRequest(scope(), { title: 'T', body: '', base: 'main', draft: false })).rejects.toThrow('branch changed')
    expect(useGitPullRequestStore.getState().createForm).toEqual(scope())
    expect(entry('/repo/a', 'feature')).toBeUndefined()
    expect(git.pullRequest).not.toHaveBeenCalled()
  })

  it('asks for a draft and for the base branches with the same scope', async () => {
    const git = install()
    await draftPullRequestFor(scope())
    await draftPullRequestFor(scope(), 'release')
    expect(git.draft.mock.calls).toEqual([[scope()], [scope(), 'release']])
    await loadPullRequestBaseBranches(scope())
    await loadPullRequestBaseBranches({ projectId: 'p1', originThreadId: null, path: '/repo/a', branch: 'feature' })
    expect(git.baseBranches.mock.calls).toEqual([[{ threadId: 't1' }], [{ projectId: 'p1' }]])
  })
})

describe('bounded memory', () => {
  beforeEach(() => {
    useGitPullRequestStore.setState({ entries: {}, createForm: null })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps at most 200 lookups, dropping the oldest and never one a section still shows', async () => {
    vi.useFakeTimers()
    install()
    const release = retainPullRequest('/repo/a', 'branch-0')
    for (let index = 0; index < 205; index++) {
      await refreshPullRequest('/repo/a', `branch-${index}`)
      vi.advanceTimersByTime(10)
    }
    const keys = Object.keys(useGitPullRequestStore.getState().entries)
    expect(keys).toHaveLength(200)
    expect(entry('/repo/a', 'branch-0')).toBeDefined()
    expect(entry('/repo/a', 'branch-1')).toBeUndefined()
    expect(entry('/repo/a', 'branch-204')).toBeDefined()
    release()
    vi.useRealTimers()
  })
})

describe('commit and push through the git store', () => {
  beforeEach(() => {
    useGitPullRequestStore.setState({ entries: {} })
    useGitStatusStore.setState({ entries: {} })
    listeners.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('commits without pushing and leaves the pull request alone', async () => {
    const git = install()
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await commitGitChanges('/repo/a', 'Add things', project)
    expect(git.commit).toHaveBeenCalledWith(project, 'Add things', { amend: false, expectedBranch: 'feature', operationId: expect.any(String) })
    expect(git.push).not.toHaveBeenCalled()
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).not.toHaveBeenCalled()
  })

  it('amends, and reports each phase in order for commit and push', async () => {
    const git = install()
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    const phases: string[] = []
    await commitGitChanges('/repo/a', 'Reword', project, { amend: true, push: true, onPhase: (phase) => phases.push(phase) })
    expect(git.commit).toHaveBeenCalledWith(project, 'Reword', { amend: true, expectedBranch: 'feature', operationId: expect.any(String) })
    expect(git.push).toHaveBeenCalledWith(project, { expectedBranch: 'feature', operationId: expect.any(String) })
    expect(phases).toEqual(['committing', 'pushing'])
  })

  it('force-refreshes the status and the pull request after commit and push', async () => {
    const git = install()
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await refreshPullRequest('/repo/a', 'feature')
    await commitGitChanges('/repo/a', 'Add things', project, { push: true })
    expect(git.status).toHaveBeenCalledTimes(2)
    // The lookup was fresh, so only a forced refresh fetches it again.
    expect(git.pullRequest).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).toHaveBeenLastCalledWith({ projectId: 'p1' }, 'feature', true)
  })

  it('refreshes the status, then rejects with the push failure when only the push fails', async () => {
    const pushError = new Error('rejected: non-fast-forward')
    const git = install({ push: vi.fn(async () => { throw pushError }) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    const failure = await commitGitChanges('/repo/a', 'Add things', standalone, { push: true }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CommitPushError)
    expect((failure as CommitPushError).pushError).toBe(pushError)
    expect((failure as CommitPushError).message).toBe('rejected: non-fast-forward')
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).not.toHaveBeenCalled()
  })

  it('does not push or refresh when the commit itself fails', async () => {
    const git = install({ commit: vi.fn(async () => { throw new Error('nothing to commit') }) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await expect(commitGitChanges('/repo/a', 'x', standalone, { push: true })).rejects.toThrow('nothing to commit')
    expect(git.push).not.toHaveBeenCalled()
    expect(git.status).toHaveBeenCalledTimes(1)
  })

  it('pushes the branch, then force-refreshes the status and the pull request', async () => {
    const git = install()
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await refreshPullRequest('/repo/a', 'feature')
    await pushGitBranch('/repo/a', project)
    expect(git.push).toHaveBeenCalledWith(project, { expectedBranch: 'feature', operationId: expect.any(String) })
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).toHaveBeenCalledTimes(2)
    // A push forces the lookup past both the store's age and the daemon's cache.
    expect(git.pullRequest).toHaveBeenLastCalledWith({ projectId: 'p1' }, 'feature', true)
  })

  it('does not refresh after a push that fails', async () => {
    const git = install({ push: vi.fn(async () => { throw new Error('rejected') }) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await expect(pushGitBranch('/repo/a', standalone)).rejects.toThrow('rejected')
    expect(git.status).toHaveBeenCalledTimes(1)
    expect(git.pullRequest).not.toHaveBeenCalled()
  })

  it('initializes the repository, then force-refreshes the status', async () => {
    const order: string[] = []
    const git = install({
      init: vi.fn(async () => { order.push('init') }),
      status: vi.fn(async () => { order.push('status'); return repoStatus() })
    })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    order.length = 0
    await initGitRepository('/repo/a', project)
    expect(git.init).toHaveBeenCalledWith(project)
    expect(order).toEqual(['init', 'status'])
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('does not refresh after an init that fails', async () => {
    const git = install({ init: vi.fn(async () => { throw new Error('This folder is already a Git repository.') }) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await expect(initGitRepository('/repo/a', standalone)).rejects.toThrow('already a Git repository')
    expect(git.status).toHaveBeenCalledTimes(1)
  })

  it('skips the pull request refresh when there is no branch', async () => {
    const git = install({ status: vi.fn(async () => repoStatus({ branch: null, tracking: 'detached' })) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await pushGitBranch('/repo/a', standalone)
    expect(git.pullRequest).not.toHaveBeenCalled()
  })
})

describe('commit, push and open PR through the git store', () => {
  const none: GitPullRequestLookup = { state: 'none', isDefaultBranch: false }
  const worktree = { projectId: 'p1', workspaceThreadId: 't1' }
  const projectForm = (): PullRequestScope => scope({ threadId: undefined, projectId: 'p1', originThreadId: null })
  const formOf = () => useGitPullRequestStore.getState().createForm
  const failure = (code: string, message: string) => Object.assign(new Error(message), { code })
  const noLookupInstall = (patch: Partial<Mock> = {}) => install({ pullRequest: vi.fn(async () => none), ...patch })

  beforeEach(() => {
    useGitPullRequestStore.setState({ entries: {}, createForm: null })
    useGitStatusStore.setState({ entries: {} })
    listeners.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('commits, pushes, looks the pull request up past the caches, then opens the form, each step on the branch it started on', async () => {
    const order: string[] = []
    const git = noLookupInstall({
      commit: vi.fn(async () => { order.push('commit'); return { status: repoStatus() } }),
      push: vi.fn(async () => { order.push('push'); return { status: repoStatus() } }),
      status: vi.fn(async () => { order.push('status'); return repoStatus() }),
      pullRequest: vi.fn(async () => { order.push('lookup'); return none })
    })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    order.length = 0
    const phases: string[] = []
    const result = await commitGitChanges('/repo/a', 'Add things', project, { openPullRequest: projectForm(), onPhase: (phase) => phases.push(phase) })
    expect(order).toEqual(['commit', 'push', 'status', 'lookup'])
    expect(phases).toEqual(['committing', 'pushing', 'opening-pr'])
    expect(git.commit).toHaveBeenCalledWith(project, 'Add things', { amend: false, expectedBranch: 'feature', operationId: expect.any(String) })
    expect(git.push).toHaveBeenCalledWith(project, { expectedBranch: 'feature', operationId: expect.any(String) })
    expect(git.pullRequest).toHaveBeenCalledWith({ projectId: 'p1' }, 'feature', true)
    expect(result).toEqual({ pullRequest: { kind: 'form' } })
    // The same form the Create PR row opens, for the folder, branch and thread of the click; nothing is created here.
    expect(formOf()).toEqual(projectForm())
    expect(git.create).not.toHaveBeenCalled()
  })

  it('amends, pushes and opens the form when asked to amend', async () => {
    const git = noLookupInstall()
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await commitGitChanges('/repo/a', 'Reword', project, { amend: true, openPullRequest: projectForm() })
    expect(git.commit).toHaveBeenCalledWith(project, 'Reword', { amend: true, expectedBranch: 'feature', operationId: expect.any(String) })
    expect(formOf()).toEqual(projectForm())
  })

  it('in a thread worktree commits everything once and asks about the thread, never amending, and opens the form for the worktree', async () => {
    const git = noLookupInstall()
    await refreshGitStatus('/repo/a', { scope: { projectId: 'p1', workspaceThreadId: null } })
    const form = scope({ path: '/repo/a', threadId: 't1', originThreadId: 't1' })
    const result = await commitGitChanges('/repo/a', 'Add things', worktree, { openPullRequest: form })
    expect(git.commit).toHaveBeenCalledTimes(1)
    expect(git.commit).toHaveBeenCalledWith(worktree, 'Add things', { amend: false, expectedBranch: 'feature', operationId: expect.any(String) })
    expect(git.push).toHaveBeenCalledWith(worktree, { expectedBranch: 'feature', operationId: expect.any(String) })
    expect(git.pullRequest).toHaveBeenLastCalledWith({ threadId: 't1' }, 'feature', true)
    expect(result).toEqual({ pullRequest: { kind: 'form' } })
    expect(formOf()).toEqual(form)
  })

  it('shows the pull request a branch already has instead of opening a second form', async () => {
    const git = install({ pullRequest: vi.fn(async () => lookup(12)) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    const result = await commitGitChanges('/repo/a', 'Add things', project, { openPullRequest: projectForm() })
    expect(result).toEqual({ pullRequest: { kind: 'existing', number: 12, state: 'open' } })
    expect(formOf()).toBeNull()
    expect(git.create).not.toHaveBeenCalled()
    // The found pull request is what the card's row reads.
    expect(entry('/repo/a', 'feature').lookup).toEqual(lookup(12))
  })

  it('stops at a commit a hook refused: nothing is pushed, looked up or opened, and a retry that passes runs every step', async () => {
    const hook = failure('git_hook_failed', 'pre-commit hook failed (exit 1)')
    const git = noLookupInstall({
      commit: vi.fn()
        .mockRejectedValueOnce(hook)
        .mockResolvedValue({ status: repoStatus() })
    })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await expect(commitGitChanges('/repo/a', 'Add things', project, { openPullRequest: projectForm() })).rejects.toBe(hook)
    expect(git.push).not.toHaveBeenCalled()
    expect(git.pullRequest).not.toHaveBeenCalled()
    expect(formOf()).toBeNull()

    const phases: string[] = []
    await commitGitChanges('/repo/a', 'Add things', project, { openPullRequest: projectForm(), onPhase: (phase) => phases.push(phase) })
    expect(phases).toEqual(['committing', 'pushing', 'opening-pr'])
    expect(git.push).toHaveBeenCalledTimes(1)
    expect(formOf()).toEqual(projectForm())
  })

  it('stops at a hook refusal in a thread worktree the same way', async () => {
    const git = noLookupInstall({ commit: vi.fn(async () => { throw failure('git_hook_failed', 'pre-commit hook failed (exit 1)') }) })
    await refreshGitStatus('/repo/a', { scope: { projectId: 'p1', workspaceThreadId: null } })
    await expect(
      commitGitChanges('/repo/a', 'x', worktree, { openPullRequest: scope({ threadId: 't1', originThreadId: 't1' }) })
    ).rejects.toThrow('pre-commit hook failed')
    expect(git.push).not.toHaveBeenCalled()
    expect(formOf()).toBeNull()
  })

  it.each([
    ['the remote has newer commits', failure('git_push_rejected', 'The remote has commits this branch does not. Pull them, then push again.')],
    ['the branch has diverged', failure('git_pull_diverged', 'This branch has diverged from its upstream.')],
    ['there is no remote to push to', failure('git_no_remote', 'Add a remote before pushing.')],
    ['the branch has no upstream', failure('git_no_upstream', 'This branch has no upstream. Push it first to set one.')],
    ['the remote refused the push', failure('git_push_rejected_by_remote', 'The remote refused this push.')],
    ['the push was cancelled', failure('git_cancelled', 'Cancelled.')]
  ])('stops at a push refused because %s: the commit stays, nothing is looked up or opened', async (_name, pushError) => {
    const git = noLookupInstall({ push: vi.fn(async () => { throw pushError }) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    const caught = await commitGitChanges('/repo/a', 'Add things', project, { openPullRequest: projectForm() }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(CommitPushError)
    expect((caught as CommitPushError).pushError).toBe(pushError)
    expect(git.commit).toHaveBeenCalledTimes(1)
    // The status is read again so the card shows the commit as unpushed.
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).not.toHaveBeenCalled()
    expect(formOf()).toBeNull()
  })

  it('recovers from a refused push with a plain push, after which the Create PR row opens the same form', async () => {
    const git = noLookupInstall({
      push: vi.fn()
        .mockRejectedValueOnce(failure('git_push_rejected', 'The remote has commits this branch does not.'))
        .mockResolvedValue({ status: repoStatus() })
    })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await expect(commitGitChanges('/repo/a', 'Add things', project, { openPullRequest: projectForm() })).rejects.toBeInstanceOf(CommitPushError)
    expect(formOf()).toBeNull()
    await pushGitBranch('/repo/a', project)
    await createPullRequestForBranch(projectForm())
    expect(git.push).toHaveBeenCalledTimes(2)
    expect(git.commit).toHaveBeenCalledTimes(1)
    expect(formOf()).toEqual(projectForm())
  })

  it('does not open a pull request for a branch that is still ahead of its upstream after the push', async () => {
    const git = noLookupInstall({ status: vi.fn(async () => repoStatus({ ahead: 1 })) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    const caught = await commitGitChanges('/repo/a', 'Add things', project, { openPullRequest: projectForm() }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(OpenPullRequestError)
    expect((caught as Error).message).toContain('not on the remote')
    expect(formOf()).toBeNull()
    expect(git.create).not.toHaveBeenCalled()
  })

  it('does not open a pull request for a branch with no upstream after the push', async () => {
    noLookupInstall({ status: vi.fn(async () => repoStatus({ tracking: 'none', upstream: null })) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await expect(commitGitChanges('/repo/a', 'x', project, { openPullRequest: projectForm() })).rejects.toBeInstanceOf(OpenPullRequestError)
    expect(formOf()).toBeNull()
  })

  it('refuses before committing when the folder is no longer on the branch the button was pressed on', async () => {
    const git = noLookupInstall({ status: vi.fn(async () => repoStatus({ branch: 'other' })) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await expect(commitGitChanges('/repo/a', 'x', project, { openPullRequest: projectForm() })).rejects.toThrow('The branch changed')
    expect(git.commit).not.toHaveBeenCalled()
    expect(git.push).not.toHaveBeenCalled()
    expect(formOf()).toBeNull()
  })

  it('stops when the daemon finds another branch at the commit, and leaves nothing pushed or opened', async () => {
    const changed = failure('git_branch_changed', 'The branch changed while this was open. Review it, then try again.')
    const git = noLookupInstall({ commit: vi.fn(async () => { throw changed }) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await expect(commitGitChanges('/repo/a', 'x', project, { openPullRequest: projectForm() })).rejects.toBe(changed)
    expect(git.push).not.toHaveBeenCalled()
    expect(git.pullRequest).not.toHaveBeenCalled()
    expect(formOf()).toBeNull()
  })

  it('stops when the branch changes between the commit and the push: the push is refused and nothing is opened', async () => {
    const changed = failure('git_branch_changed', 'The branch changed while this was open. Review it, then try again.')
    const git = noLookupInstall({ push: vi.fn(async () => { throw changed }) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    const caught = await commitGitChanges('/repo/a', 'x', project, { openPullRequest: projectForm() }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(CommitPushError)
    expect((caught as CommitPushError).pushError).toBe(changed)
    expect(git.pullRequest).not.toHaveBeenCalled()
    expect(formOf()).toBeNull()
  })

  it('stops when the branch changes after the push, before the form opens', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce(repoStatus())
      .mockResolvedValue(repoStatus({ branch: 'other', upstream: 'origin/other' }))
    const git = noLookupInstall({ status })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    const caught = await commitGitChanges('/repo/a', 'x', project, { openPullRequest: projectForm() }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(OpenPullRequestError)
    expect((caught as Error).message).toContain('The branch changed')
    expect(git.commit).toHaveBeenCalledTimes(1)
    expect(formOf()).toBeNull()
  })

  it('reports why when the lookup is unavailable, and opens nothing', async () => {
    noLookupInstall({ pullRequest: vi.fn(async () => ({ state: 'unavailable', reason: 'unauthenticated', message: 'Sign in to GitHub to open pull requests.' })) })
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    await expect(commitGitChanges('/repo/a', 'x', project, { openPullRequest: projectForm() })).rejects.toThrow('Sign in to GitHub')
    expect(formOf()).toBeNull()
  })

  it('opens nothing for the default branch or one that is not known to be a different branch', async () => {
    for (const isDefaultBranch of [true, null]) {
      noLookupInstall({ pullRequest: vi.fn(async () => ({ state: 'none', isDefaultBranch })) })
      useGitStatusStore.setState({ entries: {} })
      useGitPullRequestStore.setState({ entries: {}, createForm: null })
      await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
      await expect(commitGitChanges('/repo/a', 'x', project, { openPullRequest: projectForm() })).rejects.toBeInstanceOf(OpenPullRequestError)
      expect(formOf()).toBeNull()
    }
  })

  it('keeps "Commit and push" as it was: no form and no notice, and the lookup refreshed', async () => {
    const git = noLookupInstall()
    await refreshGitStatus('/repo/a', { scope: GIT_SCOPE })
    const result = await commitGitChanges('/repo/a', 'Add things', project, { push: true })
    expect(result).toEqual({ pullRequest: null })
    expect(git.pullRequest).toHaveBeenCalledWith({ projectId: 'p1' }, 'feature', true)
    expect(formOf()).toBeNull()
  })
})

describe('merging and closing a pull request', () => {
  beforeEach(() => {
    useGitPullRequestStore.setState({ entries: {}, details: {} })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const installActions = (merge: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn> = vi.fn()) => {
    const git = install()
    vi.stubGlobal('window', {
      ...(globalThis as unknown as { window: object }).window,
      mousse: { pullRequests: { get: git.pullRequest, detail: git.detail, merge, close } }
    })
    return git
  }

  it('merges as the thread, shows the merged state at once and reads the lookup and detail again', async () => {
    const merged = { ...lookupInfo(7), state: 'merged' as const }
    const merge = vi.fn(async () => ({ pullRequest: merged, method: 'squash' }))
    const git = installActions(merge)
    git.pullRequest.mockImplementation(async () => new Promise(() => {}))
    useGitPullRequestStore.setState({ entries: { [pullRequestKey('/repo/a', 'feature')]: { lookup: lookup(7), fetchedAt: 1 } } })
    const result = await mergePullRequest({ path: '/repo/a', branch: 'feature', number: 7, threadId: 't1', projectId: 'p1' }, 'abc1234')
    expect(result.method).toBe('squash')
    expect(merge).toHaveBeenCalledWith({ threadId: 't1' }, 7, 'abc1234')
    expect(entry('/repo/a', 'feature').lookup).toMatchObject({ state: 'found', pullRequest: { number: 7, state: 'merged' } })
    expect(git.pullRequest).toHaveBeenCalledWith({ threadId: 't1' }, 'feature', true)
    expect(git.detail).toHaveBeenCalledWith({ threadId: 't1' }, 7, true)
  })

  it('updates an earlier pull request of the branch in place', async () => {
    const close = vi.fn(async () => ({ pullRequest: { ...lookupInfo(5), state: 'closed' as const } }))
    const git = installActions(vi.fn(), close)
    git.pullRequest.mockImplementation(async () => new Promise(() => {}))
    const both: GitPullRequestLookup = { state: 'found', pullRequest: lookupInfo(7), others: [lookupInfo(5)] }
    useGitPullRequestStore.setState({ entries: { [pullRequestKey('/repo/a', 'feature')]: { lookup: both, fetchedAt: 1 } } })
    await closePullRequest({ path: '/repo/a', branch: 'feature', number: 5, projectId: 'p1' })
    expect(close).toHaveBeenCalledWith({ projectId: 'p1' }, 5)
    expect(entry('/repo/a', 'feature').lookup).toMatchObject({ pullRequest: { number: 7, state: 'open' }, others: [{ number: 5, state: 'closed' }] })
  })

  it('rejects with the host\'s reason and changes nothing', async () => {
    const git = installActions(vi.fn(async () => { throw new Error('Pull request acme/app#7 is not mergeable: the base branch policy prohibits the merge.') }))
    useGitPullRequestStore.setState({ entries: { [pullRequestKey('/repo/a', 'feature')]: { lookup: lookup(7), fetchedAt: 1 } } })
    await expect(mergePullRequest({ path: '/repo/a', branch: 'feature', number: 7, projectId: 'p1' })).rejects.toThrow('not mergeable')
    expect(entry('/repo/a', 'feature').lookup).toEqual(lookup(7))
    expect(git.pullRequest).not.toHaveBeenCalled()
  })
})

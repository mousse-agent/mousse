import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/stores/appStore'
import {
  CommitPushError,
  commitGitChanges,
  initGitRepository,
  pushGitBranch,
  refreshGitStatus,
  useGitStatusStore
} from '../src/renderer/stores/gitStatusStore'
import {
  PULL_REQUEST_MAX_AGE_MS,
  closeCreatePullRequestForm,
  createPullRequestForBranch,
  draftPullRequestFor,
  loadPullRequestBaseBranches,
  openCreatePullRequestForm,
  pullRequestKey,
  refreshPullRequest,
  retainPullRequest,
  setPullRequestTracked,
  submitCreatePullRequest,
  useGitPullRequestStore
} from '../src/renderer/stores/pullRequestStore'
import type { GitPullRequestInfo, PullRequestScope } from '../src/shared/pullRequests'
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
    create: vi.fn(async () => ({ pullRequest: lookupInfo(2), existing: false })),
    draft: vi.fn(async () => ({ title: 'T', body: 'B', base: 'main', source: 'heuristic' })),
    baseBranches: vi.fn(async () => ({ defaultBranch: 'main', branches: ['main'] })),
    commit: vi.fn(async () => ({ status: repoStatus() })),
    init: vi.fn(async () => ({ status: repoStatus() })),
    push: vi.fn(async () => ({ status: repoStatus() })),
    status: vi.fn(async () => repoStatus()),
    ...patch
  }
  const { pullRequest, create, draft, baseBranches, ...gitMethods } = git
  vi.stubGlobal('window', {
    mousse: {
      pullRequests: { get: pullRequest, create, draft, baseBranches },
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

describe('pull request store', () => {
  beforeEach(() => {
    useGitPullRequestStore.setState({ entries: {} })
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

  it('looks an untracked branch up on mount but not on focus or when a run ends', async () => {
    vi.useFakeTimers()
    const git = install()
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
    await refreshGitStatus('/repo/a')
    await commitGitChanges('/repo/a', 'Add things', project)
    expect(git.commit).toHaveBeenCalledWith(project, 'Add things', { amend: false, expectedBranch: 'feature' })
    expect(git.push).not.toHaveBeenCalled()
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).not.toHaveBeenCalled()
  })

  it('amends, and reports each phase in order for commit and push', async () => {
    const git = install()
    await refreshGitStatus('/repo/a')
    const phases: string[] = []
    await commitGitChanges('/repo/a', 'Reword', project, { amend: true, push: true, onPhase: (phase) => phases.push(phase) })
    expect(git.commit).toHaveBeenCalledWith(project, 'Reword', { amend: true, expectedBranch: 'feature' })
    expect(git.push).toHaveBeenCalledWith(project, { expectedBranch: 'feature' })
    expect(phases).toEqual(['committing', 'pushing'])
  })

  it('force-refreshes the status and the pull request after commit and push', async () => {
    const git = install()
    await refreshGitStatus('/repo/a')
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
    await refreshGitStatus('/repo/a')
    const failure = await commitGitChanges('/repo/a', 'Add things', standalone, { push: true }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CommitPushError)
    expect((failure as CommitPushError).pushError).toBe(pushError)
    expect((failure as CommitPushError).message).toBe('rejected: non-fast-forward')
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).not.toHaveBeenCalled()
  })

  it('does not push or refresh when the commit itself fails', async () => {
    const git = install({ commit: vi.fn(async () => { throw new Error('nothing to commit') }) })
    await refreshGitStatus('/repo/a')
    await expect(commitGitChanges('/repo/a', 'x', standalone, { push: true })).rejects.toThrow('nothing to commit')
    expect(git.push).not.toHaveBeenCalled()
    expect(git.status).toHaveBeenCalledTimes(1)
  })

  it('pushes the branch, then force-refreshes the status and the pull request', async () => {
    const git = install()
    await refreshGitStatus('/repo/a')
    await refreshPullRequest('/repo/a', 'feature')
    await pushGitBranch('/repo/a', project)
    expect(git.push).toHaveBeenCalledWith(project, { expectedBranch: 'feature' })
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).toHaveBeenCalledTimes(2)
    // A push forces the lookup past both the store's age and the daemon's cache.
    expect(git.pullRequest).toHaveBeenLastCalledWith({ projectId: 'p1' }, 'feature', true)
  })

  it('does not refresh after a push that fails', async () => {
    const git = install({ push: vi.fn(async () => { throw new Error('rejected') }) })
    await refreshGitStatus('/repo/a')
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
    await refreshGitStatus('/repo/a')
    order.length = 0
    await initGitRepository('/repo/a', project)
    expect(git.init).toHaveBeenCalledWith(project)
    expect(order).toEqual(['init', 'status'])
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('does not refresh after an init that fails', async () => {
    const git = install({ init: vi.fn(async () => { throw new Error('This folder is already a Git repository.') }) })
    await refreshGitStatus('/repo/a')
    await expect(initGitRepository('/repo/a', standalone)).rejects.toThrow('already a Git repository')
    expect(git.status).toHaveBeenCalledTimes(1)
  })

  it('skips the pull request refresh when there is no branch', async () => {
    const git = install({ status: vi.fn(async () => repoStatus({ branch: null, tracking: 'detached' })) })
    await refreshGitStatus('/repo/a')
    await pushGitBranch('/repo/a', standalone)
    expect(git.pullRequest).not.toHaveBeenCalled()
  })
})

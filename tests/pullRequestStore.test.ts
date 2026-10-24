import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/stores/appStore'
import {
  CommitPushError,
  commitGitChanges,
  pushGitBranch,
  refreshGitStatus,
  useGitStatusStore
} from '../src/renderer/stores/gitStatusStore'
import {
  PULL_REQUEST_MAX_AGE_MS,
  createPullRequestForBranch,
  pullRequestKey,
  refreshPullRequest,
  retainPullRequest,
  useGitPullRequestStore
} from '../src/renderer/stores/pullRequestStore'
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
    checkCounts: { passed: 1, failed: 0, pending: 0, total: 1 }
  }
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
  createPullRequest: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  push: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
}

const listeners = new Map<string, () => void>()
const removeEventListener = vi.fn()

const install = (patch: Partial<Mock> = {}): Mock => {
  const git: Mock = {
    pullRequest: vi.fn(async () => lookup(1)),
    createPullRequest: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    status: vi.fn(async () => repoStatus()),
    ...patch
  }
  vi.stubGlobal('window', {
    mousse: {
      git: {
        ...git,
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
    expect(git.pullRequest).toHaveBeenCalledWith('p1', '/repo/a')
    expect(entry('/repo/a', 'feature').lookup).toEqual(lookup(1))
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

  it('treats a lookup under 30 seconds old as fresh, and refetches after that', async () => {
    vi.useFakeTimers()
    const git = install()
    await refreshPullRequest('/repo/a', 'feature')
    vi.advanceTimersByTime(PULL_REQUEST_MAX_AGE_MS - 1000)
    await refreshPullRequest('/repo/a', 'feature')
    expect(git.pullRequest).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    await refreshPullRequest('/repo/a', 'feature')
    expect(git.pullRequest).toHaveBeenCalledTimes(2)
    expect(PULL_REQUEST_MAX_AGE_MS).toBe(30_000)
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

  it('looks the branch up again on the next focus after Create PR, even when fresh', async () => {
    const git = install()
    const release = retainPullRequest('/repo/a', 'feature', 'p1')
    await refreshPullRequest('/repo/a', 'feature')
    await createPullRequestForBranch('/repo/a', 'feature', 'p1')
    expect(git.createPullRequest).toHaveBeenCalledWith('p1', '/repo/a')
    expect(git.pullRequest).toHaveBeenCalledTimes(1)
    listeners.get('focus')?.()
    await vi.waitFor(() => expect(git.pullRequest).toHaveBeenCalledTimes(2))
    // Only the first focus after the browser trip is forced.
    listeners.get('focus')?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(git.pullRequest).toHaveBeenCalledTimes(2)
    release()
  })

  it('does not wait for focus when Create PR fails', async () => {
    const git = install({ createPullRequest: vi.fn(async () => { throw new Error('gh missing') }) })
    const release = retainPullRequest('/repo/a', 'feature')
    await refreshPullRequest('/repo/a', 'feature')
    await expect(createPullRequestForBranch('/repo/a', 'feature')).rejects.toThrow('gh missing')
    listeners.get('focus')?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(git.pullRequest).toHaveBeenCalledTimes(1)
    release()
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
    await commitGitChanges('/repo/a', 'Add things', 'p1')
    expect(git.commit).toHaveBeenCalledWith('Add things', 'p1', '/repo/a', { amend: false })
    expect(git.push).not.toHaveBeenCalled()
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).not.toHaveBeenCalled()
  })

  it('amends, and reports each phase in order for commit and push', async () => {
    const git = install()
    await refreshGitStatus('/repo/a')
    const phases: string[] = []
    await commitGitChanges('/repo/a', 'Reword', 'p1', { amend: true, push: true, onPhase: (phase) => phases.push(phase) })
    expect(git.commit).toHaveBeenCalledWith('Reword', 'p1', '/repo/a', { amend: true })
    expect(git.push).toHaveBeenCalledWith('p1', '/repo/a')
    expect(phases).toEqual(['committing', 'pushing'])
  })

  it('force-refreshes the status and the pull request after commit and push', async () => {
    const git = install()
    await refreshGitStatus('/repo/a')
    await refreshPullRequest('/repo/a', 'feature')
    await commitGitChanges('/repo/a', 'Add things', 'p1', { push: true })
    expect(git.status).toHaveBeenCalledTimes(2)
    // The lookup was fresh, so only a forced refresh fetches it again.
    expect(git.pullRequest).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).toHaveBeenLastCalledWith('p1', '/repo/a')
  })

  it('refreshes the status, then rejects with the push failure when only the push fails', async () => {
    const pushError = new Error('rejected: non-fast-forward')
    const git = install({ push: vi.fn(async () => { throw pushError }) })
    await refreshGitStatus('/repo/a')
    const failure = await commitGitChanges('/repo/a', 'Add things', undefined, { push: true }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CommitPushError)
    expect((failure as CommitPushError).pushError).toBe(pushError)
    expect((failure as CommitPushError).message).toBe('rejected: non-fast-forward')
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).not.toHaveBeenCalled()
  })

  it('does not push or refresh when the commit itself fails', async () => {
    const git = install({ commit: vi.fn(async () => { throw new Error('nothing to commit') }) })
    await refreshGitStatus('/repo/a')
    await expect(commitGitChanges('/repo/a', 'x', undefined, { push: true })).rejects.toThrow('nothing to commit')
    expect(git.push).not.toHaveBeenCalled()
    expect(git.status).toHaveBeenCalledTimes(1)
  })

  it('pushes the branch, then force-refreshes the status and the pull request', async () => {
    const git = install()
    await refreshGitStatus('/repo/a')
    await refreshPullRequest('/repo/a', 'feature')
    await pushGitBranch('/repo/a', 'p1')
    expect(git.push).toHaveBeenCalledWith('p1', '/repo/a')
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.pullRequest).toHaveBeenCalledTimes(2)
  })

  it('does not refresh after a push that fails', async () => {
    const git = install({ push: vi.fn(async () => { throw new Error('rejected') }) })
    await refreshGitStatus('/repo/a')
    await expect(pushGitBranch('/repo/a')).rejects.toThrow('rejected')
    expect(git.status).toHaveBeenCalledTimes(1)
    expect(git.pullRequest).not.toHaveBeenCalled()
  })

  it('skips the pull request refresh when there is no branch', async () => {
    const git = install({ status: vi.fn(async () => repoStatus({ branch: null, tracking: 'detached' })) })
    await refreshGitStatus('/repo/a')
    await pushGitBranch('/repo/a')
    expect(git.pullRequest).not.toHaveBeenCalled()
  })
})

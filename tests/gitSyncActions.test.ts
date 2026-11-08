import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSync, whileFolder } from '../src/renderer/components/git/gitSyncActions'
import { refreshGitStatus, useGitStatusStore } from '../src/renderer/stores/gitStatusStore'
import type { SyncActivity } from '../src/renderer/components/git/gitSyncLogic'
import type { GitFileChange, GitScope, GitStatusSnapshot } from '../src/shared/types'

const PATH = '/repo/a'
const project: GitScope = { projectId: 'project-1', workspaceThreadId: null }
const thread: GitScope = { projectId: 'project-1', workspaceThreadId: 'thread-1' }

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

const file = (path: string, patch: Partial<GitFileChange> = {}): GitFileChange => ({ path, status: 'modified', staged: false, ...patch })

type Mock = ReturnType<typeof vi.fn>
interface GitMock {
  status: Mock
  log: Mock
  branches: Mock
  diffStats: Mock
  stage: Mock
  unstage: Mock
  discard: Mock
  fetch: Mock
  pull: Mock
  abortInProgress: Mock
}

const install = (patch: Partial<GitMock> = {}, confirm: Mock = vi.fn(() => true)) => {
  const git: GitMock = {
    status: vi.fn(async () => repoStatus()),
    log: vi.fn(async () => []),
    branches: vi.fn(async () => ({ current: 'main', branches: ['main'] })),
    diffStats: vi.fn(async () => ({ additions: 0, deletions: 0, filesChanged: 0 })),
    stage: vi.fn(async () => ({ status: repoStatus() })),
    unstage: vi.fn(async () => ({ status: repoStatus() })),
    discard: vi.fn(async () => ({ status: repoStatus() })),
    fetch: vi.fn(async () => ({ status: repoStatus(), behindBefore: 0, behindAfter: 2 })),
    pull: vi.fn(async () => ({ status: repoStatus(), result: 'fast-forwarded' })),
    abortInProgress: vi.fn(async () => ({ status: repoStatus() })),
    ...patch
  }
  vi.stubGlobal('window', { mousse: { git }, confirm, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  return { git, confirm }
}

/** Errors cross the preload bridge as plain objects with the daemon's code. */
const daemonError = (code: string, message: string) => Object.assign(new Error(message), { code })

const GIT_SCOPE = { projectId: 'project-1', workspaceThreadId: null }

describe('sync actions', () => {
  beforeEach(() => {
    useGitStatusStore.setState({ entries: {} })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const run = async (request: Parameters<typeof runSync>[2], scope: GitScope = project) => {
    const seen: SyncActivity[] = []
    await runSync(PATH, scope, request, (activity) => seen.push(activity))
    return seen
  }

  it('fetch reports running, then what it found, and refreshes', async () => {
    const { git } = install()
    await refreshGitStatus(PATH, { scope: GIT_SCOPE })
    expect(await run({ action: 'fetch' })).toEqual([
      { phase: 'running', action: 'fetch' },
      { phase: 'done', action: 'fetch', message: 'Fetched: 2 new commits' }
    ])
    expect(git.fetch).toHaveBeenCalledWith(project, { operationId: expect.any(String) })
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('fetch with nothing new says so', async () => {
    install({ fetch: vi.fn(async () => ({ status: repoStatus(), behindBefore: 3, behindAfter: 3 })) })
    expect((await run({ action: 'fetch' }))[1]).toEqual({ phase: 'done', action: 'fetch', message: 'Already up to date' })
  })

  it('pull passes the strategy and reports what it did', async () => {
    const { git } = install({ pull: vi.fn(async () => ({ status: repoStatus(), result: 'merged' })) })
    expect(await run({ action: 'pull', strategy: 'merge' })).toEqual([
      { phase: 'running', action: 'pull' },
      { phase: 'done', action: 'pull', message: 'Pulled: merged' }
    ])
    expect(git.pull).toHaveBeenCalledWith(project, { strategy: 'merge', operationId: expect.any(String) })
  })

  it('a pull that stops on conflicts is reported as done, with what to do next, and the folder is refreshed to show them', async () => {
    let conflicted = false
    const { git } = install({
      status: vi.fn(async () => repoStatus(conflicted ? { inProgress: 'merge', changes: [file('a.ts', { status: 'conflicted' })] } : {})),
      pull: vi.fn(async () => { conflicted = true; return { status: repoStatus(), result: 'conflicted' } })
    })
    await refreshGitStatus(PATH, { scope: GIT_SCOPE })
    const seen = await run({ action: 'pull', strategy: 'merge' })
    expect(seen[1]).toEqual({ phase: 'done', action: 'pull', message: 'Pull stopped on conflicts. Resolve the conflicted files, or abort.' })
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(useGitStatusStore.getState().entries[PATH]?.status?.inProgress).toBe('merge')
  })

  it('a failed fetch reports the reason, and the folder is refreshed after the failure', async () => {
    const { git } = install({ fetch: vi.fn(async () => { throw daemonError('git_remote_unreachable', 'The remote could not be reached') }) })
    await refreshGitStatus(PATH, { scope: GIT_SCOPE })
    expect(await run({ action: 'fetch' })).toEqual([
      { phase: 'running', action: 'fetch' },
      { phase: 'failed', action: 'fetch', message: 'The remote could not be reached' }
    ])
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('a failed pull reports the reason, offers nothing it did not do, and refreshes', async () => {
    const { git } = install({ pull: vi.fn(async () => { throw daemonError('git_pull_diverged', 'The branches have diverged') }) })
    await refreshGitStatus(PATH, { scope: GIT_SCOPE })
    const seen = await run({ action: 'pull', strategy: 'ff-only' })
    expect(seen.at(-1)).toEqual({ phase: 'failed', action: 'pull', message: 'The branches have diverged' })
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('never rejects, even for an error with no message', async () => {
    install({ fetch: vi.fn(async () => { throw new Error('') }) })
    const seen = await run({ action: 'fetch' })
    expect(seen.at(-1)).toEqual({ phase: 'failed', action: 'fetch', message: 'Git command failed' })
  })

  it('abort gives up the merge, reports it, and refreshes', async () => {
    const { git } = install()
    await refreshGitStatus(PATH, { scope: GIT_SCOPE })
    expect(await run({ action: 'abort', kind: 'merge' })).toEqual([
      { phase: 'running', action: 'abort' },
      { phase: 'done', action: 'abort', message: 'Merge aborted' }
    ])
    expect(git.abortInProgress).toHaveBeenCalledWith(project, 'merge')
    expect((await run({ action: 'abort', kind: 'rebase' })).at(-1)).toEqual({ phase: 'done', action: 'abort', message: 'Rebase aborted' })
    expect(git.status).toHaveBeenCalledTimes(3)
  })

  it('a failed abort is reported and the folder is refreshed', async () => {
    const { git } = install({ abortInProgress: vi.fn(async () => { throw new Error('There is no merge to abort') }) })
    await refreshGitStatus(PATH, { scope: GIT_SCOPE })
    expect((await run({ action: 'abort', kind: 'merge' })).at(-1)).toEqual({ phase: 'failed', action: 'abort', message: 'There is no merge to abort' })
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('fetches in a thread worktree with the thread scope, so the daemon applies its rules', async () => {
    const { git } = install()
    await run({ action: 'fetch' }, thread)
    expect(git.fetch).toHaveBeenCalledWith(thread, { operationId: expect.any(String) })
  })
})

describe('results of an earlier folder', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops a fetch result that arrives after the panel moved to another folder', async () => {
    let release!: () => void
    install({ fetch: vi.fn(() => new Promise((resolve) => { release = () => resolve({ status: repoStatus(), behindBefore: 0, behindAfter: 2 }) })) })
    const folder = { current: PATH as string | null }
    const seen: SyncActivity[] = []
    const fetching = runSync(PATH, project, { action: 'fetch' }, whileFolder(folder, PATH, (activity: SyncActivity) => seen.push(activity)))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    folder.current = '/repo/b'
    release()
    await fetching
    expect(seen).toEqual([{ phase: 'running', action: 'fetch' }])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitScope, GitStatusSnapshot } from '../src/shared/types'
import { folderKey } from '../src/renderer/lib/activeProject'
import { refreshGitStatus, retainGitPath, stageGitPaths, useGitStatusStore } from '../src/renderer/stores/gitStatusStore'

const status = (branch: string): GitStatusSnapshot => ({ isRepo: true, branch, upstream: null, tracking: 'none', ahead: 0, behind: 0, changes: [] })
const projectScope = (projectId: string): GitScope => ({ projectId, workspaceThreadId: null })
const threadScope = (projectId: string, workspaceThreadId: string): GitScope => ({ projectId, workspaceThreadId })

/** A Git API whose answers depend on the folder it is asked about, as the daemon's do. */
function installGit(branchOf: (scope: GitScope) => string) {
  const git = {
    status: vi.fn(async (scope: GitScope) => status(branchOf(scope))),
    log: vi.fn(async () => []),
    branches: vi.fn(async () => ({ current: 'main', branches: ['main'] })),
    diffStats: vi.fn(async () => ({ additions: 0, deletions: 0, filesChanged: 0 })),
    stage: vi.fn(async () => ({ status: status('main') }))
  }
  const listeners = new Map<string, () => void>()
  vi.stubGlobal('window', {
    mousse: { git },
    addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type))
  })
  return { git, listeners }
}

describe('Git state by thread or project', () => {
  beforeEach(() => {
    useGitStatusStore.setState({ entries: {} })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps a folder with the same path on two computers apart', async () => {
    // Both projects live at the same path of their own computer; only their (qualified) ids tell them apart.
    const a = projectScope('nod_aaaaaaaaaaaaaaaaaaaaaaaaaa:project-1')
    const b = projectScope('nod_bbbbbbbbbbbbbbbbbbbbbbbbbb:project-1')
    const { git } = installGit((scope) => (scope.projectId?.startsWith('nod_a') ? 'on-a' : 'on-b'))
    await Promise.all([refreshGitStatus(folderKey(a)!, { scope: a }), refreshGitStatus(folderKey(b)!, { scope: b })])
    expect(git.status).toHaveBeenCalledTimes(2)
    const { entries } = useGitStatusStore.getState()
    expect(Object.keys(entries)).toHaveLength(2)
    expect(entries[folderKey(a)!]?.status?.branch).toBe('on-a')
    expect(entries[folderKey(b)!]?.status?.branch).toBe('on-b')
  })

  it('keeps a thread own worktree apart from its project, and shares a folder between readers', async () => {
    const project = projectScope('p1')
    const worktree = threadScope('p1', 't1')
    const { git } = installGit((scope) => (scope.workspaceThreadId ? 'mousse/thread/t1' : 'main'))
    await Promise.all([
      refreshGitStatus(folderKey(project)!, { scope: project }),
      refreshGitStatus(folderKey(worktree)!, { scope: worktree }),
      refreshGitStatus(folderKey(worktree)!, { scope: worktree })
    ])
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.status).toHaveBeenCalledWith(project)
    expect(git.status).toHaveBeenCalledWith(worktree)
    expect(git.log).toHaveBeenCalledWith(expect.any(Number), worktree)
    const { entries } = useGitStatusStore.getState()
    expect(entries['project:p1']?.status?.branch).toBe('main')
    expect(entries['thread:t1']?.status?.branch).toBe('mousse/thread/t1')
  })

  it('reads again through the same scope after an action, and when the window is focused again', async () => {
    vi.useFakeTimers()
    const worktree = threadScope('p1', 't1')
    const key = folderKey(worktree)!
    const { git, listeners } = installGit(() => 'main')
    await stageGitPaths(key, ['a.txt'], worktree)
    expect(git.stage).toHaveBeenCalledWith(worktree, { paths: ['a.txt'] })
    expect(git.status).toHaveBeenLastCalledWith(worktree)

    const release = retainGitPath(key, worktree)
    vi.advanceTimersByTime(5000)
    git.status.mockClear()
    listeners.get('focus')?.()
    await vi.waitFor(() => expect(git.status).toHaveBeenCalledWith(worktree))
    release()
  })
})

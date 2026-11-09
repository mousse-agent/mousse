import { describe, expect, it } from 'vitest'
import {
  IDLE_SYNC_ACTIVITY,
  abortLabel,
  fetchResultNotice,
  pullChoices,
  pullResultNotice,
  syncActivityLine,
  syncControls,
  syncLabel,
  syncState
} from '../src/renderer/components/git/gitSyncLogic'
import type { GitFileChange, GitScope, GitStatusSnapshot } from '../src/shared/types'

const project: GitScope = { projectId: 'p1', workspaceThreadId: null }
const thread: GitScope = { projectId: 'p1', workspaceThreadId: 't1' }

const status = (patch: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot => ({
  isRepo: true,
  branch: 'main',
  upstream: 'origin/main',
  tracking: 'tracked',
  ahead: 0,
  behind: 0,
  changes: [],
  hasRemote: true,
  ...patch
})

const change = (path: string, patch: Partial<GitFileChange> = {}): GitFileChange => ({
  path,
  status: 'modified',
  staged: false,
  ...patch
})

describe('sync state', () => {
  it('names where the branch stands against its upstream', () => {
    expect(syncState(status())).toMatchObject({ kind: 'up-to-date', ahead: 0, behind: 0 })
    expect(syncState(status({ behind: 2 }))).toMatchObject({ kind: 'behind', behind: 2 })
    expect(syncState(status({ ahead: 3 }))).toMatchObject({ kind: 'ahead', ahead: 3 })
    expect(syncState(status({ ahead: 1, behind: 2 }))).toMatchObject({ kind: 'diverged', ahead: 1, behind: 2 })
  })

  it('reports conflicted files first, with the files, and what is stopped', () => {
    const state = syncState(status({
      ahead: 1,
      behind: 1,
      inProgress: 'merge',
      changes: [change('a.ts', { status: 'conflicted' }), change('b.ts', { status: 'conflicted' }), change('c.ts')]
    }))
    expect(state).toMatchObject({ kind: 'conflicted', files: ['a.ts', 'b.ts'], what: 'merge' })
  })

  it('reports a stopped merge or rebase without conflicts as in progress', () => {
    expect(syncState(status({ inProgress: 'rebase' }))).toMatchObject({ kind: 'in-progress', what: 'rebase', files: [] })
  })

  it('has no upstream to compare with on a local, detached or unborn branch', () => {
    expect(syncState(status({ tracking: 'none', upstream: null }))).toMatchObject({ kind: 'no-upstream', noUpstream: 'untracked' })
    expect(syncState(status({ tracking: 'detached', branch: null, upstream: null }))).toMatchObject({ kind: 'no-upstream', noUpstream: 'detached' })
    expect(syncState(status({ tracking: 'unborn', upstream: null }))).toMatchObject({ kind: 'no-upstream', noUpstream: 'unborn' })
  })

  it('describes no state for a folder that is not a repository', () => {
    expect(syncState(null)).toBeNull()
    expect(syncState(status({ isRepo: false }))).toBeNull()
  })

  it('words each state in one line', () => {
    const label = (patch: Partial<GitStatusSnapshot>) => syncLabel(syncState(status(patch))!)
    expect(label({})).toBe('Up to date with origin/main')
    expect(label({ behind: 1 })).toBe('Behind origin/main by 1 commit')
    expect(label({ behind: 4 })).toBe('Behind origin/main by 4 commits')
    expect(label({ ahead: 2 })).toBe('Ahead of origin/main by 2 commits')
    expect(label({ ahead: 1, behind: 2 })).toBe('Diverged: 1 ahead, 2 behind')
    expect(label({ changes: [change('a.ts', { status: 'conflicted' })] })).toBe('Conflicted: 1 file')
    expect(label({ changes: [change('a.ts', { status: 'conflicted' }), change('b.ts', { status: 'conflicted' })] })).toBe('Conflicted: 2 files')
    expect(label({ inProgress: 'merge' })).toBe('Merge in progress')
    expect(label({ inProgress: 'rebase' })).toBe('Rebase in progress')
    expect(label({ inProgress: 'cherry-pick' })).toBe('Cherry-pick in progress')
    expect(label({ tracking: 'none', upstream: null })).toBe('No upstream branch')
    expect(label({ tracking: 'detached', branch: null, upstream: null })).toBe('Detached HEAD')
    expect(label({ tracking: 'unborn', upstream: null })).toBe('No commits yet')
  })
})

describe('pull choices and controls', () => {
  it('pulls fast-forward only, and offers merge or rebase once the sides have diverged', () => {
    expect(pullChoices(syncState(status({ behind: 2 })))).toEqual(['ff-only'])
    expect(pullChoices(syncState(status({ ahead: 1 })))).toEqual(['ff-only'])
    expect(pullChoices(syncState(status({ ahead: 1, behind: 2 })))).toEqual(['merge', 'rebase'])
    expect(pullChoices(null)).toEqual(['ff-only'])
  })

  it('enables Fetch and Pull for a tracked branch', () => {
    const controls = syncControls(status({ behind: 1 }), project)
    expect(controls.fetch).toEqual({ enabled: true, reason: null })
    expect(controls.pull).toEqual({ enabled: true, reason: null, choices: ['ff-only'] })
    expect(controls.abort).toBeNull()
  })

  it('gives a reason when Pull cannot run', () => {
    const reason = (patch: Partial<GitStatusSnapshot>, scope: GitScope = project) => syncControls(status(patch), scope).pull.reason
    expect(reason({ tracking: 'none', upstream: null })).toBe('No upstream branch to pull from')
    expect(reason({ tracking: 'detached', branch: null, upstream: null })).toBe('Detached HEAD has no upstream')
    expect(reason({ changes: [change('a.ts', { status: 'conflicted' })] })).toBe('Resolve the conflicted files first')
    expect(reason({ inProgress: 'rebase' })).toBe('Finish or abort the rebase first')
    expect(reason({ inProgress: 'cherry-pick' })).toBe('Finish or abort the cherry-pick first')
    expect(reason({ behind: 1 }, thread)).toBe("Not available in this thread's worktree")
  })

  it('still fetches in a thread worktree, but not without a remote', () => {
    expect(syncControls(status({ behind: 1 }), thread).fetch.enabled).toBe(true)
    expect(syncControls(status({ hasRemote: false, tracking: 'none', upstream: null }), project).fetch).toEqual({ enabled: false, reason: 'No remote configured' })
  })

  it('offers Abort only for a stopped merge or rebase', () => {
    expect(syncControls(status({ inProgress: 'merge' }), project).abort).toBe('merge')
    expect(syncControls(status({ inProgress: 'rebase', changes: [change('a.ts', { status: 'conflicted' })] }), project).abort).toBe('rebase')
    expect(syncControls(status({ inProgress: 'revert' }), project).abort).toBeNull()
    expect(abortLabel('merge')).toBe('Abort merge')
  })

  it('disables both without a repository', () => {
    const controls = syncControls(null, project)
    expect(controls.fetch.enabled).toBe(false)
    expect(controls.pull.enabled).toBe(false)
  })
})

describe('fetch and pull results', () => {
  it('says whether a fetch found anything', () => {
    expect(fetchResultNotice({ behindBefore: 0, behindAfter: 0 })).toBe('Already up to date')
    expect(fetchResultNotice({ behindBefore: 2, behindAfter: 2 })).toBe('Already up to date')
    expect(fetchResultNotice({ behindBefore: 0, behindAfter: 1 })).toBe('Fetched: 1 new commit')
    expect(fetchResultNotice({ behindBefore: 1, behindAfter: 4 })).toBe('Fetched: 3 new commits')
  })

  it('says what a pull did, and what to do when it stopped on conflicts', () => {
    expect(pullResultNotice('up-to-date')).toBe('Already up to date')
    expect(pullResultNotice('fast-forwarded')).toBe('Pulled: fast-forwarded')
    expect(pullResultNotice('merged')).toBe('Pulled: merged')
    expect(pullResultNotice('rebased')).toBe('Pulled: rebased')
    expect(pullResultNotice('conflicted')).toBe('Pull stopped on conflicts. Resolve the conflicted files, or abort.')
  })

  it('shows one line for the activity: progress and results as status, a failure as an alert with its reason', () => {
    expect(syncActivityLine(IDLE_SYNC_ACTIVITY)).toBeNull()
    expect(syncActivityLine({ phase: 'running', action: 'fetch' })).toEqual({ role: 'status', text: 'Fetching…' })
    expect(syncActivityLine({ phase: 'running', action: 'pull' })).toEqual({ role: 'status', text: 'Pulling…' })
    expect(syncActivityLine({ phase: 'done', action: 'fetch', message: 'Fetched: 2 new commits' })).toEqual({ role: 'status', text: 'Fetched: 2 new commits' })
    expect(syncActivityLine({ phase: 'failed', action: 'pull', message: 'Branches have diverged' })).toEqual({ role: 'alert', text: 'Pull failed: Branches have diverged' })
    expect(syncActivityLine({ phase: 'failed', action: 'fetch', message: 'No remote' })?.text).toBe('Fetch failed: No remote')
  })
})

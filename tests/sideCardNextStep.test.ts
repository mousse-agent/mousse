import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GitSectionView } from '../src/renderer/components/sideCard/GitSection'
import {
  branchTag,
  nextStep,
  pullFailureMessage,
  upstreamFigures,
  type UpstreamFigures
} from '../src/renderer/components/sideCard/gitSectionLogic'
import { EMPTY_GIT_ENTRY, type GitStatusView } from '../src/renderer/stores/gitStatusStore'
import type { GitCommit, GitPullRequestLookup, GitStatusSnapshot, GitUpstreamCheck } from '../src/shared/types'

const HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const NOW = Date.parse('2026-11-09T12:00:00Z')
const PROJECT = { workspaceThreadId: null }
const THREAD = { workspaceThreadId: 't1' }

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

const commit = (patch: Partial<GitCommit> = {}): GitCommit => ({
  hash: HEAD,
  shortHash: 'a1b2c3d',
  message: 'Fix the flaky retry test',
  author: 'Ada',
  date: '2026-11-09T11:00:00Z',
  pushed: true,
  onRemote: true,
  ...patch
})

const checked = (patch: Partial<Extract<GitUpstreamCheck, { state: 'checked' }>> = {}): GitUpstreamCheck => ({
  state: 'checked', branch: 'main', head: HEAD, ahead: 0, behind: 0, checkedAt: NOW - 3 * 60_000, ...patch
})

const tracked = (ahead = 0, behind = 0): UpstreamFigures => ({ ahead, behind, look: null, unreachable: null, checkedAt: null })

const conflicted = { path: 'a.ts', status: 'conflicted', staged: false } as GitStatusSnapshot['changes'][number]
const edited = { path: 'b.ts', status: 'modified', staged: false } as GitStatusSnapshot['changes'][number]

describe('upstreamFigures', () => {
  it('uses the last look at the remote when it was made on this branch at this HEAD', () => {
    expect(upstreamFigures(status(), HEAD, checked({ behind: 3 }))).toMatchObject({ ahead: 0, behind: 3, look: 'checked' })
  })

  it('sets a look aside once HEAD or the branch has moved since', () => {
    expect(upstreamFigures(status({ behind: 1 }), 'f'.repeat(40), checked({ behind: 3 }))).toMatchObject({ behind: 1, look: null })
    expect(upstreamFigures(status({ branch: 'other' }), HEAD, checked({ behind: 3 }))).toMatchObject({ behind: 0, look: null })
    expect(upstreamFigures(status({ tracking: 'none', upstream: null }), HEAD, checked({ behind: 3 }))).toMatchObject({ behind: 0, look: null })
  })

  it('keeps the tracking ref’s counts when the remote could not be reached', () => {
    const check: GitUpstreamCheck = { state: 'unreachable', branch: 'main', head: HEAD, reason: 'signed-out', checkedAt: NOW }
    expect(upstreamFigures(status({ behind: 2 }), HEAD, check)).toMatchObject({ behind: 2, look: 'unreachable', unreachable: 'signed-out' })
  })
})

describe('nextStep', () => {
  const step = (s: GitStatusSnapshot, figures: UpstreamFigures, scope = PROJECT, pullRequest: GitPullRequestLookup | null = null, commitCount = 1) =>
    nextStep({ status: s, figures, scope, commitCount, pullRequest })

  it('offers Pull before anything else when the remote has new commits', () => {
    expect(step(status({ changes: [edited] }), tracked(0, 3))).toMatchObject({ kind: 'pull', label: 'Pull 3 commits', strategies: ['ff-only'] })
    expect(step(status(), tracked(0, 1))).toMatchObject({ label: 'Pull 1 commit' })
  })

  it('asks how to join diverged branches instead of choosing for the person', () => {
    expect(step(status(), tracked(1, 3))).toMatchObject({ kind: 'pull', strategies: ['rebase', 'merge'] })
  })

  it('never pulls in a thread’s own worktree', () => {
    expect(step(status({ branch: 'mousse/thread/t1' }), tracked(0, 3), THREAD)).toBeNull()
  })

  it('puts conflicts and a stopped rebase ahead of pulling', () => {
    expect(step(status({ changes: [conflicted], inProgress: 'rebase' }), tracked(0, 3))).toMatchObject({ kind: 'resolve', label: 'Resolve 1 conflict', abort: 'rebase' })
    expect(step(status({ inProgress: 'merge' }), tracked(0, 3))).toMatchObject({ kind: 'finish', label: 'Finish the merge', abort: 'merge' })
    expect(step(status({ inProgress: 'cherry-pick' }), tracked())).toMatchObject({ kind: 'finish', abort: null })
  })

  it('pushes, publishes, then offers a pull request, and has nothing to offer when all is done', () => {
    expect(step(status(), tracked(2, 0))).toMatchObject({ kind: 'push', label: 'Push 2 commits' })
    expect(step(status({ tracking: 'none', upstream: null, branch: 'topic' }), tracked())).toMatchObject({ kind: 'push', label: 'Publish branch' })
    const none: GitPullRequestLookup = { state: 'none', isDefaultBranch: false } as GitPullRequestLookup
    expect(step(status({ branch: 'topic', upstream: 'origin/topic' }), tracked(), PROJECT, none)).toMatchObject({ kind: 'pull-request', label: 'Open pull request' })
    expect(step(status(), tracked())).toBeNull()
  })

  it('counts with the look’s figures, so a branch the remote moved past is not offered a push', () => {
    // The tracking ref still says 2 ahead; the remote has since taken 1 of them and added 3 more.
    expect(step(status({ ahead: 2 }), tracked(1, 3))).toMatchObject({ kind: 'pull' })
  })
})

describe('branchTag', () => {
  it('says up to date only after a look found nothing to do, with when in its title', () => {
    const figures = upstreamFigures(status(), HEAD, checked())
    expect(branchTag(status(), figures, null, NOW)).toEqual({ text: 'up to date', tone: 'quiet', title: 'Same as origin/main, checked 3m ago' })
    expect(branchTag(status(), tracked(), null, NOW)).toBeNull()
  })

  it('names a remote it could not check, and a stopped operation in the warning tone', () => {
    const offline = upstreamFigures(status(), HEAD, { state: 'unreachable', branch: 'main', head: HEAD, reason: 'offline', checkedAt: NOW })
    expect(branchTag(status(), offline, null, NOW)).toMatchObject({ text: 'can’t check origin', tone: 'quiet' })
    expect(branchTag(status({ inProgress: 'rebase' }), tracked(), null, NOW)).toMatchObject({ text: 'rebasing', tone: 'warn' })
  })
})

describe('pullFailureMessage', () => {
  it('says what to do when edits are in the way, and Git’s own words otherwise', () => {
    expect(pullFailureMessage({ code: 'git_pull_dirty', message: 'Uncommitted changes would be overwritten' })).toBe('Edits overlap. Commit or stash first.')
    expect(pullFailureMessage(new Error('fatal: unable to access remote'))).toBe('unable to access remote')
  })
})

describe('GitSectionView next step', () => {
  const view = (patch: Partial<GitStatusView>): GitStatusView => ({ ...EMPTY_GIT_ENTRY, loaded: true, refresh: async () => undefined, ...patch })
  const render = (s: GitStatusSnapshot, check: GitUpstreamCheck | null, workspaceThreadId: string | null = null) =>
    renderToStaticMarkup(createElement(GitSectionView, {
      threadId: 't1',
      projectId: 'p1',
      workspaceThreadId,
      path: '/repo/a',
      git: view({ status: s, commits: [commit()], branches: { current: s.branch, branches: [s.branch ?? 'main'] } as GitStatusView['branches'] }),
      collapsedLabel: null,
      upstreamCheck: check,
      now: NOW
    }))

  it('shows Pull as the tinted next step, with the changes and Commit below it', () => {
    const html = render(status({ changes: [edited] }), checked({ behind: 3 }))
    expect(html).toMatch(/class="side-card-git-next" data-tone="accent"[\s\S]*Pull 3 commits/)
    expect(html.indexOf('Pull 3 commits')).toBeLessThan(html.indexOf('side-card-git-changes-row'))
    expect(html).toContain('class="side-card-git-commit-open"')
  })

  it('tags an up-to-date branch and shows no next step', () => {
    const html = render(status(), checked())
    expect(html).toContain('class="side-card-git-branch-tag"')
    expect(html).toContain('up to date')
    expect(html).not.toContain('side-card-git-next')
  })

  it('shows no Pull in a thread’s own worktree', () => {
    const html = render(status({ branch: 'mousse/thread/t1', upstream: 'origin/mousse/thread/t1' }), checked({ branch: 'mousse/thread/t1', behind: 2 }), 't1')
    expect(html).not.toContain('Pull 2 commits')
  })
})

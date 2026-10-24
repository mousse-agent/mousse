import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GitSectionView } from '../src/renderer/components/sideCard/GitSection'
import {
  EMPTY_COMMIT_DRAFT,
  canAmendCommit,
  clearAmendPrefill,
  commitButtonLabels,
  commitHint,
  commitMenuState,
  prefillAmendDraft,
  pullRequestRow,
  pushButtonModel,
  pushFailedMessage
} from '../src/renderer/components/sideCard/gitSectionLogic'
import { EMPTY_GIT_ENTRY, type GitStatusView } from '../src/renderer/stores/gitStatusStore'
import type {
  GitCommit,
  GitPullRequestInfo,
  GitPullRequestLookup,
  GitStatusSnapshot
} from '../src/shared/types'

const status = (patch: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot => ({
  isRepo: true,
  branch: 'feature/login',
  upstream: 'origin/feature/login',
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

const pullRequest = (patch: Partial<GitPullRequestInfo> = {}): GitPullRequestInfo => ({
  number: 123,
  title: 'Fix login',
  url: 'https://github.com/acme/app/pull/123',
  state: 'open',
  isDraft: false,
  checks: 'passing',
  checkCounts: { passed: 3, failed: 0, pending: 0, total: 3 },
  ...patch
})

const found = (patch: Partial<GitPullRequestInfo> = {}): GitPullRequestLookup => ({
  state: 'found',
  pullRequest: pullRequest(patch)
})

const file = { path: 'a.ts', status: 'modified' as const, staged: false }

describe('pull request row', () => {
  it('shows nothing until the lookup has loaded', () => {
    expect(pullRequestRow(null, status())).toBeNull()
  })

  it('describes an open pull request with passing checks', () => {
    expect(pullRequestRow(found(), status())).toEqual({
      kind: 'found',
      url: 'https://github.com/acme/app/pull/123',
      number: '#123',
      title: 'Fix login',
      checks: 'passing',
      checksLabel: 'Checks passed',
      suffix: null,
      tooltip: '#123 Fix login\nChecks passed',
      ariaLabel: 'Pull request #123, Fix login, checks passed'
    })
  })

  it('counts failing checks', () => {
    const row = pullRequestRow(found({ checks: 'failing', checkCounts: { passed: 1, failed: 2, pending: 0, total: 3 } }), status())
    expect(row).toMatchObject({ checks: 'failing', checksLabel: '2 failing' })
    expect(row?.kind === 'found' && row.ariaLabel).toBe('Pull request #123, Fix login, 2 checks failing')
    const one = pullRequestRow(found({ checks: 'failing', checkCounts: { passed: 0, failed: 1, pending: 0, total: 1 } }), status())
    expect(one?.kind === 'found' && one.ariaLabel).toContain('1 check failing')
  })

  it('labels running checks', () => {
    const row = pullRequestRow(found({ checks: 'pending', checkCounts: { passed: 0, failed: 0, pending: 2, total: 2 } }), status())
    expect(row).toMatchObject({ checks: 'pending', checksLabel: 'Checks running' })
  })

  it('shows no check icon when there are no checks', () => {
    const row = pullRequestRow(found({ checks: 'none', checkCounts: { passed: 0, failed: 0, pending: 0, total: 0 } }), status())
    expect(row).toMatchObject({ checks: null, checksLabel: null, tooltip: '#123 Fix login', ariaLabel: 'Pull request #123, Fix login' })
  })

  it('marks a draft and keeps its checks', () => {
    const row = pullRequestRow(found({ isDraft: true }), status())
    expect(row).toMatchObject({ suffix: 'Draft', checks: 'passing' })
    expect(row?.kind === 'found' && row.ariaLabel).toBe('Pull request #123, Fix login, draft, checks passed')
  })

  it('shows merged and closed pull requests without checks', () => {
    expect(pullRequestRow(found({ state: 'merged' }), status())).toMatchObject({ suffix: 'Merged', checks: null, checksLabel: null })
    const closed = pullRequestRow(found({ state: 'closed', isDraft: true, checks: 'failing' }), status())
    expect(closed).toMatchObject({ suffix: 'Closed', checks: null })
    expect(closed?.kind === 'found' && closed.ariaLabel).toBe('Pull request #123, Fix login, closed')
  })

  it('copes with an empty title', () => {
    const row = pullRequestRow(found({ title: '  ' }), status())
    expect(row).toMatchObject({ title: '', tooltip: '#123\nChecks passed', ariaLabel: 'Pull request #123, checks passed' })
  })

  it('offers Create PR once the branch is pushed', () => {
    expect(pullRequestRow({ state: 'none', isDefaultBranch: false }, status())).toEqual({ kind: 'create', enabled: true, hint: null })
  })

  it('dims Create PR with a reason while the branch is unpushed or has no upstream', () => {
    const hint = 'Push the branch first'
    expect(pullRequestRow({ state: 'none', isDefaultBranch: false }, status({ ahead: 2 }))).toEqual({ kind: 'create', enabled: false, hint })
    expect(pullRequestRow({ state: 'none', isDefaultBranch: false }, status({ tracking: 'none', upstream: null }))).toEqual({ kind: 'create', enabled: false, hint })
  })

  it('shows nothing on the default branch or when the lookup is unavailable', () => {
    expect(pullRequestRow({ state: 'none', isDefaultBranch: true }, status())).toBeNull()
    for (const reason of ['gh-missing', 'unauthenticated', 'not-github', 'no-branch', 'error'] as const) {
      expect(pullRequestRow({ state: 'unavailable', reason, message: 'x' }, status())).toBeNull()
    }
  })
})

describe('push button', () => {
  it('counts unpushed commits on a tracked branch', () => {
    expect(pushButtonModel(status({ ahead: 3 }), 5)).toEqual({ label: 'Push', count: 3, title: 'Push 3 commits to origin/feature/login' })
    expect(pushButtonModel(status({ ahead: 1 }), 5)?.title).toBe('Push 1 commit to origin/feature/login')
  })

  it('stays when the branch is also behind, so Git can report the rejection', () => {
    expect(pushButtonModel(status({ ahead: 2, behind: 4 }), 5)).toMatchObject({ label: 'Push', count: 2 })
  })

  it('publishes a branch with no upstream that has commits', () => {
    expect(pushButtonModel(status({ tracking: 'none', upstream: null }), 1)).toEqual({
      label: 'Publish',
      count: null,
      title: 'Push this branch and track it on the remote'
    })
    expect(pushButtonModel(status({ tracking: 'none', upstream: null }), 0)).toBeNull()
  })

  it('has no button for a pushed, detached or unborn branch', () => {
    expect(pushButtonModel(status(), 5)).toBeNull()
    expect(pushButtonModel(status({ branch: null, tracking: 'detached', ahead: 0 }), 5)).toBeNull()
    expect(pushButtonModel(status({ branch: null, tracking: 'unborn' }), 0)).toBeNull()
    expect(pushButtonModel(status({ isRepo: false, branch: null }), 0)).toBeNull()
    expect(pushButtonModel(null, 0)).toBeNull()
  })
})

describe('commit menu state', () => {
  it('allows amending only a latest commit that no remote has', () => {
    expect(canAmendCommit([commit()])).toBe(true)
    expect(canAmendCommit([commit({ pushed: false, onRemote: true })])).toBe(false)
    expect(canAmendCommit([commit({ pushed: true, onRemote: true })])).toBe(false)
    expect(canAmendCommit([])).toBe(false)
  })

  it('enables the trigger for changes or an amendable commit', () => {
    expect(commitMenuState([commit()], 2, false)).toMatchObject({ triggerEnabled: true, triggerTitle: 'Commit all changes' })
    expect(commitMenuState([commit({ onRemote: true })], 2, false).triggerEnabled).toBe(true)
    expect(commitMenuState([], 1, false).triggerEnabled).toBe(true)
    expect(commitMenuState([commit()], 0, false)).toMatchObject({ triggerEnabled: true, triggerTitle: 'Amend the last commit' })
  })

  it('disables the trigger when there is nothing to commit or amend', () => {
    const state = commitMenuState([commit({ onRemote: true })], 0, false)
    expect(state).toMatchObject({ triggerEnabled: false, triggerTitle: 'No changes to commit' })
    expect(commitMenuState([], 0, false).triggerEnabled).toBe(false)
  })

  it('lets the checkbox toggle amend while there are changes', () => {
    expect(commitMenuState([commit()], 2, false)).toMatchObject({ amend: false, amendDisabled: false, amendTitle: null })
    expect(commitMenuState([commit()], 2, true)).toMatchObject({ amend: true, amendDisabled: false })
  })

  it('forces amend on without changes', () => {
    expect(commitMenuState([commit()], 0, false)).toMatchObject({ amend: true, amendDisabled: true, amendTitle: 'No changes to commit' })
  })

  it('disables amend with the reason when it is not possible', () => {
    expect(commitMenuState([commit({ onRemote: true })], 2, true)).toMatchObject({
      canAmend: false,
      amend: false,
      amendDisabled: true,
      amendTitle: 'The last commit is already pushed'
    })
    expect(commitMenuState([], 2, true)).toMatchObject({ amend: false, amendDisabled: true, amendTitle: 'No commits yet' })
  })

  it('names the commit it would amend', () => {
    expect(commitMenuState([commit()], 1, false).shortHash).toBe('a1b2c3d')
    expect(commitMenuState([], 1, false).shortHash).toBeNull()
  })

  it('words the footer hint and buttons for a plain commit and for an amend', () => {
    expect(commitHint(false, 'a1b2c3d', 1)).toBe('Stages 1 file')
    expect(commitHint(false, 'a1b2c3d', 3)).toBe('Stages 3 files')
    expect(commitHint(true, 'a1b2c3d', 0)).toBe('Amends a1b2c3d')
    expect(commitHint(true, 'a1b2c3d', 2)).toBe('Amends a1b2c3d · stages 2 files')
    expect(commitButtonLabels(false)).toEqual({ commit: 'Commit', commitAndPush: 'Commit and push' })
    expect(commitButtonLabels(true)).toEqual({ commit: 'Amend', commitAndPush: 'Amend and push' })
  })
})

describe('amend message', () => {
  it('fills an empty message from the last commit', () => {
    expect(prefillAmendDraft(EMPTY_COMMIT_DRAFT, 'Fix login\n\nBody')).toEqual({ message: 'Fix login\n\nBody', prefilled: 'Fix login\n\nBody' })
    expect(prefillAmendDraft({ message: '  ', prefilled: null }, 'Fix login').message).toBe('Fix login')
  })

  it('keeps a message the user already typed', () => {
    const draft = { message: 'My words', prefilled: null }
    expect(prefillAmendDraft(draft, 'Fix login')).toBe(draft)
    expect(prefillAmendDraft(EMPTY_COMMIT_DRAFT, null)).toBe(EMPTY_COMMIT_DRAFT)
  })

  it('clears the prefilled message when amend goes off, and only that', () => {
    expect(clearAmendPrefill({ message: 'Fix login', prefilled: 'Fix login' })).toEqual(EMPTY_COMMIT_DRAFT)
    expect(clearAmendPrefill({ message: 'Fix login now', prefilled: 'Fix login' })).toEqual({ message: 'Fix login now', prefilled: null })
    const typed = { message: 'Mine', prefilled: null }
    expect(clearAmendPrefill(typed)).toBe(typed)
  })

  it('words a push that failed after the commit landed', () => {
    const error = new Error("Error invoking remote method 'git:push': Error: Git push failed.")
    expect(pushFailedMessage(error)).toBe('Committed, but the push failed: Git push failed.')
  })
})

describe('git section actions markup', () => {
  const view = (patch: Partial<GitStatusView> = {}): GitStatusView => ({
    ...EMPTY_GIT_ENTRY,
    loaded: true,
    refresh: async () => undefined,
    status: status(),
    commits: [commit({ pushed: true, onRemote: true })],
    branches: { current: 'feature/login', branches: ['feature/login', 'main'] },
    diffStats: { additions: 0, deletions: 0, filesChanged: 0 },
    ...patch
  })
  const render = (git: GitStatusView, pr: GitPullRequestLookup | null = null) =>
    renderToStaticMarkup(createElement(GitSectionView, {
      threadId: 't1',
      projectId: 'p1',
      path: '/repo/a',
      git,
      pullRequest: pr,
      collapsedLabel: null,
      now: Date.parse('2026-10-24T10:05:00Z')
    }))

  it('renders a found pull request as one button with the checks icon, number and title', () => {
    const html = render(view(), found())
    expect(html).toMatch(/<button[^>]*class="side-card-git-pr"[^>]*aria-label="Pull request #123, Fix login, checks passed"/)
    expect(html).toContain('data-checks="passing"')
    expect(html).toContain('side-card-git-pr-number">#123<')
    expect(html).toContain('side-card-git-pr-title">Fix login<')
    expect(html).toContain('title="#123 Fix login\nChecks passed"')
    expect(html).not.toContain('side-card-git-pr-create')
  })

  it('renders each check state and the muted suffixes', () => {
    expect(render(view(), found({ checks: 'failing', checkCounts: { passed: 0, failed: 2, pending: 0, total: 2 } }))).toContain('data-checks="failing"')
    expect(render(view(), found({ checks: 'pending' }))).toContain('side-card-git-pr-pending')
    const none = render(view(), found({ checks: 'none' }))
    expect(none).not.toContain('data-checks')
    expect(none).not.toContain('side-card-git-pr-pending')
    expect(render(view(), found({ isDraft: true }))).toContain('side-card-git-pr-suffix">Draft<')
    const merged = render(view(), found({ state: 'merged' }))
    expect(merged).toContain('side-card-git-pr-suffix">Merged<')
    expect(merged).not.toContain('data-checks')
    expect(render(view(), found({ state: 'closed' }))).toContain('side-card-git-pr-suffix">Closed<')
  })

  it('renders an enabled Create PR for a pushed branch with no pull request', () => {
    const html = render(view(), { state: 'none', isDefaultBranch: false })
    expect(html).toMatch(/class="side-card-git-pr-create"[^>]*aria-disabled="false"[^>]*>Create PR</)
    expect(html).not.toContain('Push the branch first')
  })

  it('dims Create PR with its reason before the branch is pushed', () => {
    const html = render(view({ status: status({ ahead: 1 }) }), { state: 'none', isDefaultBranch: false })
    expect(html).toMatch(/class="side-card-git-pr-create"[^>]*title="Push the branch first"[^>]*aria-disabled="true"/)
  })

  it('renders no pull request row on the default branch, when unavailable, or before the lookup', () => {
    const rows = [
      render(view(), { state: 'none', isDefaultBranch: true }),
      render(view(), { state: 'unavailable', reason: 'gh-missing', message: 'GitHub CLI (gh) was not found.' }),
      render(view(), null)
    ]
    for (const html of rows) {
      expect(html).not.toContain('side-card-git-pr')
      expect(html).not.toContain('Create PR')
      expect(html).not.toContain('gh-missing')
    }
  })

  it('renders Push with the unpushed badge and its tooltip', () => {
    const html = render(view({ status: status({ ahead: 3 }) }))
    expect(html).toMatch(/<button[^>]*class="side-card-git-push"[^>]*>Push<span class="side-card-git-push-count" aria-hidden="true">↑3<\/span>/)
    expect(html).toContain('title="Push 3 commits to origin/feature/login"')
    expect(html).toContain('aria-label="Push 3 commits to origin/feature/login"')
    expect(html).not.toMatch(/class="side-card-git-push"[^>]*disabled/)
  })

  it('keeps Push when the branch is behind as well', () => {
    expect(render(view({ status: status({ ahead: 1, behind: 2 }) }))).toContain('side-card-git-push-count" aria-hidden="true">↑1<')
  })

  it('renders Publish for a branch with no upstream', () => {
    const html = render(view({ status: status({ tracking: 'none', upstream: null }) }))
    expect(html).toMatch(/class="side-card-git-push"[^>]*>Publish</)
    expect(html).toContain('title="Push this branch and track it on the remote"')
    expect(html).not.toContain('side-card-git-push-count')
  })

  it('renders no push button for a pushed, detached or unborn branch', () => {
    expect(render(view())).not.toContain('side-card-git-push')
    expect(render(view({ status: status({ branch: null, tracking: 'detached' }) }))).not.toContain('side-card-git-push')
    expect(render(view({ status: status({ branch: null, tracking: 'unborn' }), commits: [] }))).not.toContain('side-card-git-push')
  })

  it('keeps the commit trigger enabled when only an amend is possible', () => {
    const html = render(view({ commits: [commit()] }))
    expect(html).toMatch(/<button[^>]*class="side-card-git-commit-button"(?![^>]*disabled)/)
    expect(html).toContain('title="Amend the last commit"')
  })

  it('leaves the branch button without a repeated Branch tooltip and keeps its aria-label', () => {
    const html = render(view({ status: status({ changes: [file] }) }))
    expect(html).toContain('aria-label="Branch feature/login"')
    expect(html).not.toContain('title="Branch:')
    expect(html).not.toContain('Branch: ')
  })
})

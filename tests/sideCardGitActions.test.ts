import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GitSectionView } from '../src/renderer/components/sideCard/GitSection'
import {
  EMPTY_COMMIT_DRAFT,
  canAmendCommit,
  canInitRepository,
  canPush,
  chooseAmend,
  GIT_BUSY_REASON,
  clearAmendPrefill,
  commitButtonLabels,
  commitFormFor,
  commitHint,
  commitMenuState,
  commitScope,
  emptyCommitForm,
  forceAmend,
  gitActionAvailability,
  gitCollapsedLabel,
  gitActionLock,
  prefillAmendDraft,
  LINKED_WORKTREE_HINT,
  pullRequestCheckRows,
  pullRequestReadThreadId,
  pullRequestReviewState,
  pullRequestRow,
  pullRequestScope,
  pushButtonModel,
  pushFailedMessage,
  releaseForcedAmend
} from '../src/renderer/components/sideCard/gitSectionLogic'
import { EMPTY_GIT_ENTRY, type GitStatusView } from '../src/renderer/stores/gitStatusStore'
import type { PullRequestCheck, PullRequestComment, PullRequestDetail } from '../src/shared/pullRequests'
import type {
  GitCommit,
  GitFileChange,
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

const fileChange = (path: string, patch: Partial<GitFileChange> = {}): GitFileChange => ({ path, status: 'modified', staged: false, ...patch })

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
  checkCounts: { passed: 3, failed: 0, pending: 0, waiting: 0, total: 3 },
  ...patch
})

const found = (patch: Partial<GitPullRequestInfo> = {}): GitPullRequestLookup => ({
  state: 'found',
  pullRequest: pullRequest(patch)
})

const lineComment = (id: string, patch: Partial<PullRequestComment> = {}): PullRequestComment => ({
  id,
  author: 'grace',
  authorAssociation: 'MEMBER',
  body: 'Please rename this.',
  bodyTruncated: false,
  createdAt: '2026-10-26T09:00:00Z',
  edited: false,
  url: 'https://github.com/acme/app/pull/123#discussion_r1',
  path: 'src/a.ts',
  line: 14,
  startLine: null,
  side: 'RIGHT',
  inReplyTo: null,
  ...patch
})

const detail = (patch: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  ...pullRequest(),
  identity: { host: 'github.com', nameWithOwner: 'acme/app', number: 123 },
  body: '',
  author: 'ada',
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
  updatedAt: '2026-10-26T12:00:00Z',
  mergedAt: null,
  closedAt: null,
  ...patch
})

const check = (name: string, state: PullRequestCheck['state'], url: string | null = `https://github.com/acme/app/actions/runs/${name}`, workflowName?: string): PullRequestCheck => ({
  name,
  state,
  url,
  ...(workflowName ? { workflowName } : {})
})

const file = { path: 'a.ts', status: 'modified' as const, staged: false }

describe('what Create PR captures', () => {
  it('is the thread\'s own folder and the thread itself, for a worktree thread and for one on the project\'s checkout', () => {
    // Both kinds of thread are asked about by thread: the daemon resolves a worktree or the project folder.
    for (const path of ['/worktrees/t1', '/repo/a']) {
      expect(pullRequestScope({ path, branch: 'feature/login', projectId: 'p1', ownThreadId: 't1' })).toEqual({
        threadId: 't1',
        originThreadId: 't1',
        path,
        branch: 'feature/login'
      })
    }
  })

  it('is the project\'s folder, with no origin thread, for a new chat that has no folder of its own', () => {
    expect(pullRequestScope({ path: '/repo/a', branch: 'feature/login', projectId: 'p1', ownThreadId: null })).toEqual({
      projectId: 'p1',
      originThreadId: null,
      path: '/repo/a',
      branch: 'feature/login'
    })
  })

  it('is nothing without a branch', () => {
    expect(pullRequestScope({ path: '/repo/a', branch: null, projectId: 'p1', ownThreadId: 't1' })).toBeNull()
  })
})

describe('which thread a pull request read is made as', () => {
  it('is the thread only when its own worktree is the folder the card shows', () => {
    expect(pullRequestReadThreadId('t1', 't1')).toBe('t1')
  })

  it('is no thread for a thread whose workspace is not ready, so the card and the daemon read the same folder', () => {
    // The card shows the project's folder for it (no worktree is ready), and asks about the project.
    expect(pullRequestReadThreadId('t1', null)).toBeNull()
    // A workspace of another thread is not this thread's folder either.
    expect(pullRequestReadThreadId('t1', 't2')).toBeNull()
  })

  it('is no thread for a new chat', () => {
    expect(pullRequestReadThreadId(null, null)).toBeNull()
    expect(pullRequestReadThreadId(null, 't2')).toBeNull()
  })
})

describe('review state of a pull request', () => {
  const open = { state: 'open', isDraft: false } as const

  it.each([
    ['approved', 'Approved', 'passing'],
    ['changes_requested', 'Changes requested', 'failing'],
    ['review_required', 'Review required', 'pending']
  ] as const)('maps the host\'s decision %s', (decision, label, tone) => {
    expect(pullRequestReviewState(open, decision)).toEqual({ key: decision, label, tone })
  })

  it('maps a draft, merged and closed pull request', () => {
    expect(pullRequestReviewState({ state: 'open', isDraft: true }, null)).toEqual({ key: 'draft', label: 'Draft', tone: 'neutral' })
    expect(pullRequestReviewState({ state: 'merged', isDraft: false }, 'approved')).toEqual({ key: 'merged', label: 'Merged', tone: 'neutral' })
    expect(pullRequestReviewState({ state: 'closed', isDraft: false }, 'changes_requested')).toEqual({ key: 'closed', label: 'Closed', tone: 'neutral' })
  })

  it('lets a finished pull request win over what was decided, and a decision win over draft', () => {
    expect(pullRequestReviewState({ state: 'merged', isDraft: true }, 'review_required')?.key).toBe('merged')
    expect(pullRequestReviewState({ state: 'open', isDraft: true }, 'changes_requested')?.key).toBe('changes_requested')
  })

  it('is nothing for an open pull request nobody has to review', () => {
    expect(pullRequestReviewState(open, null)).toBeNull()
  })
})

describe('pull request checks', () => {
  it('lists every check with its state and link, what needs attention first, in the host\'s order within a state', () => {
    const rows = pullRequestCheckRows([
      check('build', 'passing', 'https://ci.example.com/build', 'CI'),
      check('docs', 'skipped'),
      check('lint', 'pending'),
      check('test', 'failing', 'https://ci.example.com/test', 'CI'),
      check('deploy', 'waiting', 'https://ci.example.com/deploy'),
      check('e2e', 'failing')
    ])
    expect(rows.map((row) => [row.name, row.tone, row.label])).toEqual([
      ['test', 'failing', 'Failed'],
      ['e2e', 'failing', 'Failed'],
      ['deploy', 'waiting', 'Waiting for approval'],
      ['lint', 'pending', 'Running'],
      ['build', 'passing', 'Passed'],
      ['docs', 'skipped', 'Skipped']
    ])
    expect(rows[0]).toEqual({ name: 'test', workflow: 'CI', tone: 'failing', label: 'Failed', url: 'https://ci.example.com/test' })
    expect(rows.find((row) => row.name === 'build')?.workflow).toBe('CI')
    expect(rows.find((row) => row.name === 'lint')?.workflow).toBeNull()
  })

  it('keeps only web links, and treats a check with no state yet as running', () => {
    const rows = pullRequestCheckRows([check('a', 'passing', 'javascript:alert(1)'), check('b', 'passing', null), check('c', 'none', 'http://ci.example.com/c')])
    expect(rows.map((row) => [row.name, row.url, row.tone])).toEqual([
      ['c', 'http://ci.example.com/c', 'pending'],
      ['a', null, 'passing'],
      ['b', null, 'passing']
    ])
  })

  it('is empty without checks', () => {
    expect(pullRequestCheckRows([])).toEqual([])
  })
})

describe('pull request row with its detail', () => {
  const checkSet = [check('build', 'passing'), check('test', 'failing'), check('deploy', 'waiting')]

  it('adds the reviewers\' verdict, each check with its link and the comment count to an open pull request', () => {
    const row = pullRequestRow(
      found({ checks: 'failing', checkCounts: { passed: 1, failed: 1, pending: 1, waiting: 1, total: 3 } }),
      status(),
      detail({ reviewDecision: 'changes_requested', checkRuns: checkSet, comments: [lineComment('1'), lineComment('2')] })
    )
    expect(row).toMatchObject({
      review: { label: 'Changes requested', tone: 'failing' },
      commentCount: 2,
      commentsLabel: '2 comments',
      linked: false,
      hint: null,
      tooltip: '#123 Fix login\nChanges requested\n1 failing',
      ariaLabel: 'Pull request #123, Fix login, changes requested, 1 check failing'
    })
    expect(row?.kind === 'found' && row.checkRows.map((entry) => [entry.name, entry.tone, entry.url])).toEqual([
      ['test', 'failing', 'https://github.com/acme/app/actions/runs/test'],
      ['deploy', 'waiting', 'https://github.com/acme/app/actions/runs/deploy'],
      ['build', 'passing', 'https://github.com/acme/app/actions/runs/build']
    ])
  })

  it.each([
    ['approved', 'Approved', 'passing'],
    ['review_required', 'Review required', 'pending']
  ] as const)('shows %s', (decision, label, tone) => {
    expect(pullRequestRow(found(), status(), detail({ reviewDecision: decision }))).toMatchObject({ review: { label, tone } })
  })

  it('has no verdict when nobody has to review, and still shows a draft by its suffix', () => {
    expect(pullRequestRow(found(), status(), detail())).toMatchObject({ review: null, suffix: null })
    expect(pullRequestRow(found({ isDraft: true }), status(), detail({ isDraft: true }))).toMatchObject({ review: null, suffix: 'Draft' })
    expect(pullRequestRow(found({ isDraft: true }), status(), detail({ isDraft: true, reviewDecision: 'approved' }))).toMatchObject({ review: { label: 'Approved' }, suffix: 'Draft' })
  })

  it('shows nothing of the detail for a merged or closed pull request', () => {
    for (const state of ['merged', 'closed'] as const) {
      const row = pullRequestRow(found({ state }), status(), detail({ state, reviewDecision: 'approved', checkRuns: checkSet, comments: [lineComment('1')] }))
      expect(row).toMatchObject({ review: null, checkRows: [], commentCount: 0, commentsLabel: null, suffix: state === 'merged' ? 'Merged' : 'Closed' })
    }
  })

  it('shows no check rows for a pull request without checks', () => {
    expect(pullRequestRow(found({ checks: 'none', checkCounts: { passed: 0, failed: 0, pending: 0, waiting: 0, total: 0 } }), status(), detail({ checkRuns: [] }))).toMatchObject({ checkRows: [], checks: null })
  })

  it('ignores the detail of another pull request, which the branch has moved on from', () => {
    const row = pullRequestRow(found(), status(), detail({ number: 99, reviewDecision: 'changes_requested', checkRuns: checkSet }))
    expect(row).toMatchObject({ number: '#123', review: null, checkRows: [], commentCount: 0 })
  })

  it('counts one comment, and says when more exist than were read', () => {
    expect(pullRequestRow(found(), status(), detail({ comments: [lineComment('1')] }))).toMatchObject({ commentCount: 1, commentsLabel: '1 comment' })
    expect(pullRequestRow(found(), status(), detail({ comments: [lineComment('1')], commentsTruncated: true }))).toMatchObject({ commentsLabel: '1+ comments' })
  })

  it('notes that merge back targets the primary checkout, for a linked pull request of a worktree thread only', () => {
    const open = found()
    expect(pullRequestRow(open, status(), detail(), { number: 123 }, true)).toMatchObject({ linked: true, hint: LINKED_WORKTREE_HINT })
    expect(LINKED_WORKTREE_HINT).toBe('Merge back targets the primary checkout, not the PR')
    expect(pullRequestRow(open, status(), detail(), { number: 123 }, false)).toMatchObject({ linked: true, hint: null })
    expect(pullRequestRow(open, status(), detail(), null, true)).toMatchObject({ linked: false, hint: null })
    // A link to another pull request is not this one's.
    expect(pullRequestRow(open, status(), detail(), { number: 7 }, true)).toMatchObject({ linked: false, hint: null })
  })
})

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
      review: null,
      checkRows: [],
      commentCount: 0,
      commentsLabel: null,
      linked: false,
      hint: null,
      tooltip: '#123 Fix login\nChecks passed',
      ariaLabel: 'Pull request #123, Fix login, checks passed'
    })
  })

  it('counts failing checks', () => {
    const row = pullRequestRow(found({ checks: 'failing', checkCounts: { passed: 1, failed: 2, pending: 0, waiting: 0, total: 3 } }), status())
    expect(row).toMatchObject({ checks: 'failing', checksLabel: '2 failing' })
    expect(row?.kind === 'found' && row.ariaLabel).toBe('Pull request #123, Fix login, 2 checks failing')
    const one = pullRequestRow(found({ checks: 'failing', checkCounts: { passed: 0, failed: 1, pending: 0, waiting: 0, total: 1 } }), status())
    expect(one?.kind === 'found' && one.ariaLabel).toContain('1 check failing')
  })

  it('labels running checks', () => {
    const row = pullRequestRow(found({ checks: 'pending', checkCounts: { passed: 0, failed: 0, pending: 2, waiting: 0, total: 2 } }), status())
    expect(row).toMatchObject({ checks: 'pending', checksLabel: 'Checks running' })
  })

  it('shows no check icon when there are no checks', () => {
    const row = pullRequestRow(found({ checks: 'none', checkCounts: { passed: 0, failed: 0, pending: 0, waiting: 0, total: 0 } }), status())
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

  it('says so when the checks that are left only wait for a maintainer\'s approval, and that is not failing or passing', () => {
    const waiting = pullRequestRow(found({ checks: 'pending', checkCounts: { passed: 1, failed: 0, pending: 1, waiting: 1, total: 2 } }), status())
    expect(waiting).toMatchObject({ checks: 'pending', checksLabel: 'Waiting for approval' })
    expect(waiting?.kind === 'found' && waiting.ariaLabel).toBe('Pull request #123, Fix login, waiting for approval')
    // A real run in progress next to a waiting one is still running; a failure outranks both.
    expect(pullRequestRow(found({ checks: 'pending', checkCounts: { passed: 0, failed: 0, pending: 2, waiting: 1, total: 2 } }), status())).toMatchObject({ checksLabel: 'Checks running' })
    expect(pullRequestRow(found({ checks: 'failing', checkCounts: { passed: 0, failed: 1, pending: 1, waiting: 1, total: 2 } }), status())).toMatchObject({ checks: 'failing', checksLabel: '1 failing' })
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

  it('shows nothing on the default branch, or when it is unknown', () => {
    expect(pullRequestRow({ state: 'none', isDefaultBranch: true }, status())).toBeNull()
    expect(pullRequestRow({ state: 'none', isDefaultBranch: null }, status())).toBeNull()
  })

  it('shows nothing when the lookup is unavailable', () => {
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

  it('stays when the branch has diverged, but is disabled with the way forward', () => {
    expect(pushButtonModel(status({ ahead: 2, behind: 4 }), 5)).toMatchObject({
      label: 'Push',
      count: 2,
      disabledReason: 'Branch has diverged; pull with merge or rebase first'
    })
    expect(pushButtonModel(status({ ahead: 2 }), 5)?.disabledReason).toBeUndefined()
  })

  it('is disabled while files are conflicted or a merge or rebase waits', () => {
    const conflicted = [{ path: 'a.ts', status: 'conflicted' as const, staged: false }]
    expect(pushButtonModel(status({ ahead: 1, changes: conflicted }), 5)?.disabledReason).toBe('Resolve 1 conflicted file first')
    expect(pushButtonModel(status({ ahead: 1, inProgress: 'rebase' }), 5)?.disabledReason).toBe('Finish or abort the rebase first')
  })

  it('still pushes from a thread worktree', () => {
    expect(pushButtonModel(status({ ahead: 1 }), 5, { workspaceThreadId: 't1' })?.disabledReason).toBeUndefined()
  })

  it('publishes a branch with no upstream that has commits', () => {
    expect(pushButtonModel(status({ tracking: 'none', upstream: null }), 1)).toEqual({
      label: 'Publish',
      count: null,
      title: 'Push this branch and track it on the remote'
    })
    expect(pushButtonModel(status({ tracking: 'none', upstream: null }), 0)).toBeNull()
  })

  it('publishes only to a remote that exists', () => {
    const local = status({ tracking: 'none', upstream: null })
    expect(pushButtonModel({ ...local, hasRemote: true }, 2)?.label).toBe('Publish')
    expect(pushButtonModel(local, 2)?.label).toBe('Publish')
    expect(pushButtonModel({ ...local, hasRemote: false }, 2)).toBeNull()
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

  it('reports amend as forced only when it is the one possible commit', () => {
    expect(commitMenuState([commit()], 0, false).forced).toBe(true)
    expect(commitMenuState([commit()], 1, false).forced).toBe(false)
    expect(commitMenuState([commit({ onRemote: true })], 0, false).forced).toBe(false)
  })

  it('keeps amend on once it was set, so files appearing later do not drop it', () => {
    // The popover stores the choice while amend is forced; with changes it stays checked and can be turned off.
    expect(commitMenuState([commit()], 2, true)).toMatchObject({ amend: true, forced: false, amendDisabled: false })
    expect(commitMenuState([commit()], 2, false).amend).toBe(false)
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

describe('commit hint by what the commit includes', () => {
  const availability = (patch: Partial<GitStatusSnapshot>, scope = { workspaceThreadId: null as string | null }) =>
    gitActionAvailability(status(patch), null, 3, scope).commit

  it('commits only the staged files when anything is staged', () => {
    const commitState = availability({ changes: [fileChange('a.ts', { staged: true }), fileChange('b.ts'), fileChange('c.ts', { status: 'untracked' })] })
    expect(commitHint(false, 'a1b2c3d', 3, commitState)).toBe('Commits 1 staged file')
    expect(commitHint(true, 'a1b2c3d', 3, commitState)).toBe('Amends a1b2c3d · adds 1 staged file')
  })

  it('stages everything when nothing is staged', () => {
    const commitState = availability({ changes: [fileChange('a.ts'), fileChange('b.ts', { status: 'untracked' })] })
    expect(commitHint(false, 'a1b2c3d', 2, commitState)).toBe('Stages 2 files')
    expect(commitHint(true, 'a1b2c3d', 2, commitState)).toBe('Amends a1b2c3d · stages 2 files')
  })

  it('counts a file staged and edited again once', () => {
    const commitState = availability({ changes: [fileChange('mm.ts', { staged: true }), fileChange('mm.ts')] })
    expect(commitState).toMatchObject({ stagedCount: 1, unstagedCount: 1, changedCount: 1, mode: 'staged' })
    expect(commitHint(false, null, 1, commitState)).toBe('Commits 1 staged file')
  })

  it("says a thread worktree's commit takes all changes, whatever is staged", () => {
    const commitState = availability({ changes: [fileChange('a.ts', { staged: true }), fileChange('b.ts')] }, { workspaceThreadId: 't1' })
    expect(commitState.mode).toBe('thread')
    expect(commitHint(false, 'a1b2c3d', 2, commitState)).toBe("Commits all changes on this thread's branch")
  })

  it('blocks the commit while files are conflicted', () => {
    const commitState = availability({ changes: [fileChange('a.ts', { status: 'conflicted' }), fileChange('b.ts', { status: 'conflicted' }), fileChange('c.ts', { staged: true })] })
    expect(commitState.blockedReason).toBe('Resolve 2 conflicted files first')
    expect(commitHint(false, null, 3, commitState)).toBe('Resolve 2 conflicted files first')
    expect(commitHint(true, 'a1b2c3d', 3, commitState)).toBe('Resolve 2 conflicted files first')
    expect(availability({ changes: [fileChange('a.ts', { status: 'conflicted' })] }).blockedReason).toBe('Resolve 1 conflicted file first')
  })

  it('says a merge with nothing left to resolve is finished by the commit', () => {
    const commitState = availability({ inProgress: 'merge', changes: [fileChange('a.ts', { staged: true })] })
    expect(commitState).toMatchObject({ mode: 'finish-merge', blockedReason: null })
    expect(commitHint(false, null, 1, commitState)).toBe('Finishes the merge')
  })

  it('keeps the old wording without availability', () => {
    expect(commitHint(false, 'a1b2c3d', 2)).toBe('Stages 2 files')
  })
})

describe('git action availability', () => {
  const none: GitPullRequestLookup = { state: 'none', isDefaultBranch: false }
  const project = { workspaceThreadId: null }
  const inThread = { workspaceThreadId: 't1' }
  const available = (patch: Partial<GitStatusSnapshot>, scope = project, lookup: GitPullRequestLookup | null = none, commitCount = 3) =>
    gitActionAvailability(status(patch), lookup, commitCount, scope)
  const dirty = [fileChange('a.ts')]
  const conflicts = [fileChange('a.ts', { status: 'conflicted' })]

  const cases: Array<{
    name: string
    patch: Partial<GitStatusSnapshot>
    scope?: { workspaceThreadId: string | null }
    lookup?: GitPullRequestLookup | null
    commitCount?: number
    push: string | null
    commitAndPush: boolean
    openPr: boolean
  }> = [
    { name: 'clean and level with upstream', patch: {}, push: 'Nothing to push', commitAndPush: true, openPr: false },
    { name: 'dirty and level', patch: { changes: dirty }, push: 'Nothing to push', commitAndPush: true, openPr: true },
    { name: 'ahead', patch: { ahead: 2 }, push: null, commitAndPush: true, openPr: false },
    { name: 'ahead and dirty', patch: { ahead: 2, changes: dirty }, push: null, commitAndPush: true, openPr: true },
    { name: 'behind', patch: { behind: 2 }, push: 'Branch is behind; pull first', commitAndPush: false, openPr: false },
    { name: 'behind and dirty', patch: { behind: 2, changes: dirty }, push: 'Branch is behind; pull first', commitAndPush: false, openPr: false },
    { name: 'diverged', patch: { ahead: 1, behind: 1 }, push: 'Branch has diverged; pull with merge or rebase first', commitAndPush: false, openPr: false },
    { name: 'no upstream with commits', patch: { tracking: 'none', upstream: null }, push: null, commitAndPush: true, openPr: false },
    { name: 'no upstream and dirty', patch: { tracking: 'none', upstream: null, changes: dirty }, push: null, commitAndPush: true, openPr: true },
    { name: 'no upstream and no commits', patch: { tracking: 'none', upstream: null }, commitCount: 0, push: 'Nothing to push', commitAndPush: true, openPr: false },
    { name: 'no upstream and no remote', patch: { tracking: 'none', upstream: null, hasRemote: false, changes: dirty }, push: 'No remote to push to', commitAndPush: false, openPr: false },
    { name: 'detached', patch: { branch: null, tracking: 'detached', upstream: null, changes: dirty }, push: 'No branch to push', commitAndPush: false, openPr: false },
    { name: 'conflicted', patch: { ahead: 1, changes: conflicts }, push: 'Resolve 1 conflicted file first', commitAndPush: true, openPr: true },
    { name: 'merge in progress', patch: { ahead: 1, inProgress: 'merge', changes: dirty }, push: 'Finish or abort the merge first', commitAndPush: true, openPr: true },
    { name: 'rebase in progress', patch: { inProgress: 'rebase' }, push: 'Finish or abort the rebase first', commitAndPush: true, openPr: false },
    { name: 'dirty with a pull request already open', patch: { changes: dirty }, lookup: { state: 'found', pullRequest: pullRequest() }, push: 'Nothing to push', commitAndPush: true, openPr: false },
    { name: 'dirty on the default branch', patch: { changes: dirty }, lookup: { state: 'none', isDefaultBranch: true }, push: 'Nothing to push', commitAndPush: true, openPr: false },
    { name: 'dirty with the default branch unknown', patch: { changes: dirty }, lookup: { state: 'none', isDefaultBranch: null }, push: 'Nothing to push', commitAndPush: true, openPr: false },
    { name: 'dirty before the lookup loaded', patch: { changes: dirty }, lookup: null, push: 'Nothing to push', commitAndPush: true, openPr: false },
    { name: 'thread worktree, dirty and ahead', patch: { ahead: 1, changes: dirty }, scope: inThread, push: null, commitAndPush: true, openPr: true },
    { name: 'thread worktree, behind', patch: { behind: 1, changes: dirty }, scope: inThread, push: 'Branch is behind; pull first', commitAndPush: false, openPr: false }
  ]

  it.each(cases)('$name', ({ patch, scope, lookup, commitCount, push, commitAndPush, openPr }) => {
    const result = available(patch, scope, lookup, commitCount)
    expect(result.push.reason).toBe(push)
    expect(result.push.enabled).toBe(push === null)
    expect(result.offerCommitAndPush).toBe(commitAndPush)
    expect(result.offerCommitPushAndOpenPr).toBe(openPr)
  })

  it('refuses amend in a thread worktree with the reason, and without commits', () => {
    expect(available({}, inThread).amend).toEqual({ enabled: false, reason: "This thread's branch is checkpointed" })
    expect(available({}, project).amend).toEqual({ enabled: true, reason: null })
    expect(available({}, project, none, 0).amend).toEqual({ enabled: false, reason: 'No commits yet' })
  })

  it('offers neither push choice nor a pull request commit without a branch, a repository or status', () => {
    for (const state of [null, status({ isRepo: false, branch: null })]) {
      const result = gitActionAvailability(state, none, 0, project)
      expect(result.push.enabled).toBe(false)
      expect(result.offerCommitAndPush).toBe(false)
      expect(result.offerCommitPushAndOpenPr).toBe(false)
    }
  })

  it('never offers a push after a commit while behind, and never enables Push with conflicts or a stopped merge, whatever else is true', () => {
    for (const behind of [0, 1]) for (const ahead of [0, 1]) for (const tracking of ['tracked', 'none', 'detached'] as const)
      for (const inProgress of [null, 'merge', 'rebase'] as const) for (const conflicted of [false, true])
        for (const staged of [false, true]) for (const scope of [project, inThread]) {
          const changes = [
            ...(conflicted ? conflicts : []),
            ...(staged ? [fileChange('s.ts', { staged: true })] : [])
          ]
          const result = available({
            behind,
            ahead,
            tracking,
            branch: tracking === 'detached' ? null : 'main',
            upstream: tracking === 'tracked' ? 'origin/main' : null,
            inProgress,
            changes
          }, scope)
          if (behind > 0 && tracking === 'tracked') expect(result.offerCommitAndPush).toBe(false)
          if (conflicted || inProgress) expect(result.push.enabled).toBe(false)
          if (result.offerCommitPushAndOpenPr) expect(result.offerCommitAndPush).toBe(true)
          if (conflicted) expect(result.commit.blockedReason).not.toBeNull()
          if (scope === inThread && !conflicted) expect(result.commit.mode).toBe('thread')
        }
  })
})

describe('commit form scope', () => {
  const head = commit()
  const other = commit({ hash: 'ffffffffffffffffffffffffffffffffffffffff', shortHash: 'fffffff' })
  const scopeA = commitScope('a', [head])
  const typed = (scope = scopeA) => ({ ...emptyCommitForm(scope), draft: { message: 'Only for a', prefilled: null } })

  it('differs by branch and by HEAD commit', () => {
    const key = commitScope('feature/login', [head])
    expect(commitScope('feature/login', [head, other])).toEqual(key)
    expect(commitScope('main', [head])).not.toEqual(key)
    expect(commitScope('feature/login', [other, head])).not.toEqual(key)
    expect(commitScope(null, [])).toEqual(commitScope(null, []))
  })

  it('keeps the text and amend choice while the scope is unchanged', () => {
    const form = { ...typed(), amendChecked: true }
    expect(commitFormFor(form, scopeA)).toBe(form)
  })

  it('drops text typed on one branch when the branch changes', () => {
    const onB = commitFormFor({ ...typed(), amendChecked: true }, commitScope('b', [head]))
    expect(onB.draft.message).toBe('')
    expect(onB.amendChecked).toBe(false)
  })

  it('keeps typed text across a new HEAD on the same branch, but not the amend choice', () => {
    const moved = commitFormFor({ ...typed(), amendChecked: true, amendForced: true }, commitScope('a', [other]))
    expect(moved).toEqual({ ...emptyCommitForm(commitScope('a', [other])), draft: { message: 'Only for a', prefilled: null } })
  })

  it('keeps an edited prefill as plain text across a new HEAD, and drops an unedited one', () => {
    const edited = { ...emptyCommitForm(scopeA), draft: { message: 'Fix login, reworded', prefilled: 'Fix login' }, amendChecked: true }
    const prefilled = { ...emptyCommitForm(scopeA), draft: { message: 'Fix login', prefilled: 'Fix login' }, amendChecked: true }
    const moved = commitScope('a', [other])
    expect(commitFormFor(edited, moved).draft).toEqual({ message: 'Fix login, reworded', prefilled: null })
    expect(commitFormFor(prefilled, moved)).toEqual(emptyCommitForm(moved))
  })

  it('does not bring a draft back after a round trip through another branch', () => {
    // The popover stores each result, closed or not, which is what makes A -> B -> A start empty.
    let stored = typed()
    stored = commitFormFor(stored, commitScope('b', [head]))
    stored = commitFormFor(stored, scopeA)
    expect(stored).toEqual(emptyCommitForm(scopeA))
  })

  it('turns a forced amend back off on close, and keeps one the user chose', () => {
    const forced = forceAmend(emptyCommitForm(scopeA))
    expect(forced).toMatchObject({ amendChecked: true, amendForced: true })
    expect(releaseForcedAmend(forced)).toMatchObject({ amendChecked: false, amendForced: false })

    const chosen = chooseAmend(emptyCommitForm(scopeA), true)
    expect(releaseForcedAmend(chosen)).toBe(chosen)
    // Amend the user already switched on is not taken over by the forced state.
    expect(forceAmend(chosen)).toBe(chosen)
    expect(chooseAmend(forced, true).amendForced).toBe(false)
  })
})

describe('push availability', () => {
  it('needs a branch and either an upstream or a remote', () => {
    expect(canPush(status())).toBe(true)
    expect(canPush(status({ tracking: 'none', upstream: null }))).toBe(true)
    expect(canPush(status({ tracking: 'none', upstream: null, hasRemote: true }))).toBe(true)
    expect(canPush(status({ tracking: 'none', upstream: null, hasRemote: false }))).toBe(false)
  })

  it('is false without a branch or a repository', () => {
    expect(canPush(status({ branch: null, tracking: 'detached' }))).toBe(false)
    expect(canPush(status({ isRepo: false, branch: null }))).toBe(false)
    expect(canPush(null)).toBe(false)
  })
})

describe('initialize repository', () => {
  const input = { hasProject: true, pathPending: false, hasPath: true, loaded: true, status: status({ isRepo: false, branch: null }) }

  it('is offered for a known folder that Git says is not a repository', () => {
    expect(canInitRepository(input)).toBe(true)
  })

  it('is not offered for a repository, or while the folder or its status is unknown', () => {
    expect(canInitRepository({ ...input, status: status() })).toBe(false)
    expect(canInitRepository({ ...input, hasProject: false })).toBe(false)
    expect(canInitRepository({ ...input, pathPending: true })).toBe(false)
    expect(canInitRepository({ ...input, hasPath: false })).toBe(false)
    expect(canInitRepository({ ...input, loaded: false })).toBe(false)
    expect(canInitRepository({ ...input, status: null })).toBe(false)
  })

  it('is not offered for a folder that does not exist, which reads as not found', () => {
    const missing = { ...input, status: status({ isRepo: false, branch: null, missing: true }) }
    expect(canInitRepository(missing)).toBe(false)
    expect(gitCollapsedLabel(missing)).toBe('Git: folder not found')
    expect(gitCollapsedLabel(input)).toBe('Git: not a repository')
  })
})

describe('git action lock', () => {
  it('leaves every control enabled while nothing runs', () => {
    for (const action of ['checkout', 'commit', 'push', 'pullRequest'] as const) {
      expect(gitActionLock(null, action)).toEqual({ disabled: false, reason: null })
    }
  })

  it('disables the other controls with the reason while an action runs', () => {
    expect(GIT_BUSY_REASON).toBe('Another Git action is running')
    expect(gitActionLock('commit', 'checkout')).toEqual({ disabled: true, reason: GIT_BUSY_REASON })
    expect(gitActionLock('push', 'pullRequest')).toEqual({ disabled: true, reason: GIT_BUSY_REASON })
    expect(gitActionLock('pullRequest', 'push')).toEqual({ disabled: true, reason: GIT_BUSY_REASON })
  })

  it('disables the running control without a reason, since it shows its own progress', () => {
    expect(gitActionLock('push', 'push')).toEqual({ disabled: true, reason: null })
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
    expect(render(view(), found({ checks: 'failing', checkCounts: { passed: 0, failed: 2, pending: 0, waiting: 0, total: 2 } }))).toContain('data-checks="failing"')
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
      render(view(), { state: 'none', isDefaultBranch: null }),
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

  it('keeps Push when the branch is behind as well, disabled with the reason', () => {
    const html = render(view({ status: status({ ahead: 1, behind: 2 }) }))
    expect(html).toContain('side-card-git-push-count" aria-hidden="true">↑1<')
    expect(html).toMatch(/class="side-card-git-push"[^>]*title="Branch has diverged; pull with merge or rebase first"[^>]*disabled=""/)
  })

  it('keeps Push enabled in a thread worktree', () => {
    const html = renderToStaticMarkup(createElement(GitSectionView, {
      threadId: 't1',
      projectId: 'p1',
      workspaceThreadId: 't1',
      path: '/repo/a',
      git: view({ status: status({ ahead: 1 }) }),
      collapsedLabel: null
    }))
    expect(html).toMatch(/class="side-card-git-push"(?![^>]*disabled)/)
  })

  it('renders Publish for a branch with no upstream', () => {
    const html = render(view({ status: status({ tracking: 'none', upstream: null }) }))
    expect(html).toMatch(/class="side-card-git-push"[^>]*>Publish</)
    expect(html).toContain('title="Push this branch and track it on the remote"')
    expect(html).not.toContain('side-card-git-push-count')
  })

  it('renders no Publish button when the repository has no remote', () => {
    const local = status({ tracking: 'none', upstream: null, hasRemote: false })
    const html = render(view({ status: local }))
    expect(html).not.toContain('side-card-git-push')
    expect(html).not.toContain('Publish')
    expect(render(view({ status: { ...local, hasRemote: true } }))).toContain('>Publish<')
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

  describe('not a repository', () => {
    const renderCollapsed = (canInitialize: boolean, path: string | null = '/repo/a') =>
      renderToStaticMarkup(createElement(GitSectionView, {
        threadId: 't1',
        projectId: 'p1',
        path,
        git: view({ status: status({ isRepo: false, branch: null }), commits: [] }),
        collapsedLabel: 'Git: not a repository',
        canInitialize
      }))

    it('keeps the quiet line and adds an enabled Initialize repository button', () => {
      const html = renderCollapsed(true)
      expect(html).toContain('Git: not a repository')
      expect(html).toMatch(/<button[^>]*class="side-card-git-init"(?![^>]*disabled)[^>]*>Initialize repository</)
    })

    it('shows no button when the section is not asked to offer one', () => {
      expect(renderCollapsed(false)).not.toContain('side-card-git-init')
      expect(renderCollapsed(true, null)).not.toContain('side-card-git-init')
    })
  })

  it('leaves the branch button without a repeated Branch tooltip and keeps its aria-label', () => {
    const html = render(view({ status: status({ changes: [file] }) }))
    expect(html).toContain('aria-label="Branch feature/login"')
    expect(html).not.toContain('title="Branch:')
    expect(html).not.toContain('Branch: ')
  })
})

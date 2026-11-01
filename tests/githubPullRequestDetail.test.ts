import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutableRunner } from '../src/mms/git/ghRunner'
import {
  GitHubCodeHost,
  LINE_COMMENT_JQ,
  parseCheckRuns,
  parseLineCommentPage,
  parsePullRequestDetail,
  parseReviewDecision,
  PULL_REQUEST_VIEW_JQ,
  PullRequestReadError
} from '../src/mms/git/GitHubCodeHost'
import type { PullRequestIdentity } from '../src/shared/pullRequests'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/github/${name}.json`, import.meta.url), 'utf8')
const failure = (stderr: string) => Object.assign(new Error('exit 1'), { stderr })
const ok = (stdout = '') => ({ stdout, stderr: '' })
const identity: PullRequestIdentity = { host: 'github.com', nameWithOwner: 'acme/app', number: 7 }
const identityJson = (url = 'https://github.com/acme/app') => JSON.stringify({ nameWithOwner: 'acme/app', url })

/** What `LINE_COMMENT_JQ` leaves of one REST line comment, written the way the host's projection writes it. */
function projected(id: number, createdAt: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    path: 'src/a.ts',
    line: 14,
    start_line: null,
    side: 'RIGHT',
    created_at: createdAt,
    updated_at: createdAt,
    in_reply_to_id: null,
    html_url: `https://github.com/acme/app/pull/7#discussion_r${id}`,
    author_association: 'MEMBER',
    user: { login: 'grace' },
    body: `comment ${id}`,
    body_truncated: false,
    ...patch
  }
}

/** `count` comments, ids `first…first+count-1`, created one minute apart, listed newest first as the host's pages are. */
function newestFirst(first: number, count: number) {
  const items = Array.from({ length: count }, (_, index) => projected(first + index, new Date(Date.UTC(2026, 9, 26, 0, 0, 0) + (first + index) * 60_000).toISOString().replace('.000Z', 'Z')))
  return items.reverse()
}

interface Setup {
  view?: string | (() => Promise<{ stdout: string; stderr: string }>)
  /** The line comment page requested (1-based). */
  page?: (page: number, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>
  identity?: (cwd: string | undefined) => string
  viewer?: () => Promise<{ stdout: string; stderr: string }>
  /** The REST read of the pull request, projected to its author's association. */
  association?: () => Promise<{ stdout: string; stderr: string }>
}

const isAssociationRead = (args: readonly string[]) => args[0] === 'api' && args.some((arg) => /^repos\/[^?]+\/pulls\/\d+$/.test(arg))

const commentPage = (args: readonly string[]) => Number(/[?&]page=(\d+)/.exec(args.find((arg) => arg.startsWith('repos/')) ?? '')?.[1])

const runner = (setup: Setup = {}) =>
  vi.fn<ExecutableRunner>(async (executable, args, options) => {
    if (executable !== 'gh') throw new Error(`unexpected ${executable} ${args.join(' ')}`)
    if (args[0] === '--version') return ok()
    if (args[0] === 'repo') return ok((setup.identity ?? (() => identityJson()))(options?.cwd))
    if (args[0] === 'pr' && args[1] === 'view') {
      const view = setup.view ?? fixture('pr-view')
      return typeof view === 'string' ? ok(view) : view()
    }
    if (args[0] === 'api' && args.includes('user')) return (setup.viewer ?? (async () => ok('octocat\n')))()
    if (isAssociationRead(args)) return (setup.association ?? (async () => ok('MEMBER\n')))()
    if (args[0] === 'api') return (setup.page ?? (async () => ok('[]')))(commentPage(args), args)
    throw new Error(`unexpected ${args.join(' ')}`)
  })

const callsTo = (run: ReturnType<typeof runner>, kind: 'view' | 'comments') =>
  run.mock.calls.filter((call) => (kind === 'view' ? call[1][0] === 'pr' && call[1][1] === 'view' : call[1][0] === 'api' && call[1].some((arg) => arg.includes('/comments'))))

describe('parseReviewDecision', () => {
  it('maps the host\'s decision, and an empty one is none', () => {
    expect(parseReviewDecision('APPROVED')).toBe('approved')
    expect(parseReviewDecision('CHANGES_REQUESTED')).toBe('changes_requested')
    expect(parseReviewDecision('REVIEW_REQUIRED')).toBe('review_required')
    expect(parseReviewDecision('')).toBeNull()
    expect(parseReviewDecision(null)).toBeNull()
    expect(parseReviewDecision('SOMETHING_NEW')).toBeNull()
  })
})

describe('parseCheckRuns', () => {
  it('gives each check its own state and link', () => {
    expect(parseCheckRuns(JSON.parse(fixture('pr-view')).statusCheckRollup)).toEqual([
      { name: 'build', state: 'passing', url: 'https://github.com/acme/app/actions/runs/1/job/1', workflowName: 'CI' },
      { name: 'test', state: 'failing', url: 'https://github.com/acme/app/actions/runs/1/job/2', workflowName: 'CI' },
      { name: 'lint', state: 'pending', url: 'https://github.com/acme/app/actions/runs/1/job/3', workflowName: 'CI' },
      { name: 'docs', state: 'skipped', url: 'https://github.com/acme/app/actions/runs/2/job/4', workflowName: 'Docs' },
      { name: 'ci/deploy-preview', state: 'passing', url: 'https://preview.example.com/7' }
    ])
  })

  it('reads a status context\'s state, a neutral run as skipped, and a run held for approval as waiting', () => {
    expect(parseCheckRuns([
      { __typename: 'StatusContext', context: 'ci/a', state: 'FAILURE', targetUrl: 'https://ci.example.com/a' },
      { __typename: 'StatusContext', context: 'ci/b', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'ci/c', state: 'ERROR' },
      { __typename: 'CheckRun', name: 'n', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { __typename: 'CheckRun', name: 'w', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
      { __typename: 'CheckRun', name: 'q', status: 'QUEUED', conclusion: '' },
      { __typename: 'CheckRun', name: 'x', status: 'COMPLETED', conclusion: 'TIMED_OUT' }
    ]).map((check) => [check.name, check.state, check.url])).toEqual([
      ['ci/a', 'failing', 'https://ci.example.com/a'],
      ['ci/b', 'pending', null],
      ['ci/c', 'failing', null],
      ['n', 'skipped', null],
      ['w', 'waiting', null],
      ['q', 'pending', null],
      ['x', 'failing', null]
    ])
  })

  it('is empty without checks', () => {
    expect(parseCheckRuns([])).toEqual([])
    expect(parseCheckRuns(null)).toEqual([])
  })
})

describe('parsePullRequestDetail', () => {
  it('reads reviews, the decision, conversation and line comments, and what was edited', () => {
    const line = [
      projected(901, '2026-10-26T09:30:00Z', { updated_at: '2026-10-26T09:45:00Z', in_reply_to_id: 900, line: null, start_line: 10, side: 'LEFT' }),
      projected(900, '2026-10-26T09:15:00Z')
    ]
    const detail = parsePullRequestDetail(identity, fixture('pr-view'), [JSON.stringify(line)])!
    expect(detail).toMatchObject({
      number: 7,
      state: 'open',
      isDraft: false,
      author: 'ada',
      headRefName: 'feature/retry',
      baseRefName: 'main',
      headSha: '0123456789abcdef0123456789abcdef01234567',
      headRepository: 'acme/app',
      baseRepository: 'acme/app',
      isCrossRepository: false,
      reviewDecision: 'changes_requested',
      commentsTruncated: false,
      checks: 'failing',
      mergedAt: null,
      closedAt: null,
      identity
    })
    expect(detail.reviews.map((review) => [review.id, review.author, review.authorAssociation, review.state, review.edited])).toEqual([
      ['PRR_approved', 'grace', 'MEMBER', 'approved', true],
      ['PRR_changes', 'linus', 'COLLABORATOR', 'changes_requested', false],
      ['PRR_commented', 'outsider', 'NONE', 'commented', false]
    ])
    // A review with no link of its own points at the pull request.
    expect(detail.reviews[2].url).toBe('https://github.com/acme/app/pull/7')
    // Oldest first across both kinds; a missing author is "ghost".
    expect(detail.comments.map((comment) => [comment.id, comment.path, comment.author, comment.edited])).toEqual([
      ['IC_second', null, 'ghost', false],
      ['900', 'src/a.ts', 'grace', false],
      ['901', 'src/a.ts', 'grace', true],
      ['IC_first', null, 'ada', true]
    ])
    expect(detail.comments[2]).toMatchObject({ inReplyTo: '900', line: null, startLine: 10, side: 'LEFT', bodyTruncated: false })
    expect(detail.comments[0]).toMatchObject({ line: null, startLine: null, side: null, inReplyTo: null })
    expect(detail.checkRuns).toHaveLength(5)
  })

  it('shows a run held for a maintainer\'s approval as waiting, for a pull request from a fork', () => {
    const detail = parsePullRequestDetail({ ...identity, number: 12 }, fixture('pr-view-fork-awaiting-approval'), [])!
    expect(detail).toMatchObject({ isCrossRepository: true, headRepository: 'forker/app', reviewDecision: 'review_required', checks: 'pending' })
    expect(detail.checkRuns.map((check) => check.state)).toEqual(['waiting', 'passing'])
    expect(detail.checkCounts).toMatchObject({ failed: 0, waiting: 1, pending: 1, passed: 1 })
  })

  it('has no checks and no decision for a new draft', () => {
    const detail = parsePullRequestDetail({ ...identity, number: 3 }, fixture('pr-view-no-checks'), [])!
    expect(detail).toMatchObject({ isDraft: true, reviewDecision: null, checks: 'none', checkRuns: [], reviews: [], comments: [] })
  })

  it('has no head repository when the fork was deleted, and keeps the merge time', () => {
    const detail = parsePullRequestDetail({ ...identity, number: 5 }, fixture('pr-view-head-repo-deleted'), [])!
    expect(detail).toMatchObject({ state: 'merged', headRepository: null, isCrossRepository: true, reviewDecision: 'approved', mergedAt: '2026-10-20T12:00:00Z', closedAt: '2026-10-20T12:00:00Z' })
  })

  it('is null for output that is not a pull request or a list of comments', () => {
    expect(parsePullRequestDetail(identity, 'not json', [])).toBeNull()
    expect(parsePullRequestDetail(identity, '{"number":1}', [])).toBeNull()
    expect(parsePullRequestDetail(identity, fixture('pr-view'), ['{"message":"nope"}'])).toBeNull()
    expect(parseLineCommentPage('nope')).toBeNull()
  })
})

describe('GitHubCodeHost.getPullRequestDetail', () => {
  it('reads the view with capped bodies and the line comments newest first, passing the host on every api call', async () => {
    const run = runner({ identity: () => identityJson('https://ghe.example.com/acme/app'), page: async () => ok('[]') })
    const detail = await new GitHubCodeHost(run).getPullRequestDetail('/repo', 7)
    expect(detail.identity).toEqual({ host: 'ghe.example.com', nameWithOwner: 'acme/app', number: 7 })
    const [view] = callsTo(run, 'view')
    expect(view[1].slice(0, 5)).toEqual(['pr', 'view', '7', '--json', expect.stringContaining('statusCheckRollup')])
    expect(view[1].slice(5)).toEqual(['--jq', PULL_REQUEST_VIEW_JQ])
    expect(view[2]).toEqual({ cwd: '/repo' })
    const [comments] = callsTo(run, 'comments')
    expect(comments[1]).toEqual([
      'api', '--hostname', 'ghe.example.com',
      'repos/acme/app/pulls/7/comments?sort=created&direction=desc&per_page=100&page=1',
      '--jq', LINE_COMMENT_JQ
    ])
  })

  it('asks gh only for fields gh 2.98 knows, and reads the author\'s association from the REST API', async () => {
    // `gh pr view --json` with no fields lists what gh 2.98.0 accepts; `authorAssociation` is not among them.
    const GH_2_98_PR_VIEW_FIELDS = new Set([
      'additions', 'assignees', 'author', 'autoMergeRequest', 'baseRefName', 'baseRefOid', 'body', 'changedFiles', 'closed',
      'closedAt', 'closingIssuesReferences', 'comments', 'commits', 'createdAt', 'deletions', 'files', 'fullDatabaseId',
      'headRefName', 'headRefOid', 'headRepository', 'headRepositoryOwner', 'id', 'isCrossRepository', 'isDraft', 'labels',
      'latestReviews', 'maintainerCanModify', 'mergeCommit', 'mergeStateStatus', 'mergeable', 'mergedAt', 'mergedBy',
      'milestone', 'number', 'potentialMergeCommit', 'projectCards', 'projectItems', 'reactionGroups', 'reviewDecision',
      'reviewRequests', 'reviews', 'state', 'statusCheckRollup', 'title', 'updatedAt', 'url'
    ])
    const run = runner({ association: async () => ok('OWNER\n') })
    const detail = await new GitHubCodeHost(run).getPullRequestDetail('/repo', 7)
    const [view] = callsTo(run, 'view')
    const fields = String(view[1][4]).split(',')
    expect(fields.filter((field) => !GH_2_98_PR_VIEW_FIELDS.has(field))).toEqual([])
    expect(run).toHaveBeenCalledWith('gh', ['api', '--hostname', 'github.com', 'repos/acme/app/pulls/7', '--jq', '.author_association'], { cwd: '/repo' })
    expect(detail.authorAssociation).toBe('OWNER')
  })

  it('opens the pull request as least trusted when its author\'s association cannot be read', async () => {
    const failed = await new GitHubCodeHost(runner({ association: async () => { throw failure('HTTP 502') } })).getPullRequestDetail('/repo', 7)
    expect(failed).toMatchObject({ number: 7, authorAssociation: 'NONE' })
    const garbled = await new GitHubCodeHost(runner({ association: async () => ok('{"message":"nope"}') })).getPullRequestDetail('/repo', 7)
    expect(garbled.authorAssociation).toBe('NONE')
  })

  it('merges two pages (100 and 37) and shows them oldest first', async () => {
    const run = runner({
      view: fixture('pr-view-no-checks'),
      page: async (page) => ok(JSON.stringify(page === 1 ? newestFirst(38, 100) : newestFirst(1, 37)))
    })
    const detail = await new GitHubCodeHost(run).getPullRequestDetail('/repo', 3)
    expect(callsTo(run, 'comments')).toHaveLength(2)
    expect(detail.comments).toHaveLength(137)
    expect(detail.comments.map((comment) => comment.id)).toEqual(Array.from({ length: 137 }, (_, index) => String(index + 1)))
    expect(detail.commentsTruncated).toBe(false)
  })

  it('stops after five pages, holds the newest 500 oldest first, and says there are more', async () => {
    // 600 comments, ids 1..600; the newest page holds 501..600.
    const run = runner({
      view: fixture('pr-view-no-checks'),
      page: async (page) => ok(JSON.stringify(newestFirst(600 - page * 100 + 1, 100)))
    })
    const detail = await new GitHubCodeHost(run).getPullRequestDetail('/repo', 3)
    expect(callsTo(run, 'comments')).toHaveLength(5)
    expect(detail.commentsTruncated).toBe(true)
    expect(detail.comments).toHaveLength(500)
    expect(detail.comments[0].id).toBe('101')
    expect(detail.comments[499].id).toBe('600')
    const pages = callsTo(run, 'comments').map((call) => /[?&]page=(\d+)/.exec(call[1][3])?.[1])
    expect(pages).toEqual(['1', '2', '3', '4', '5'])
    for (const call of callsTo(run, 'comments')) {
      expect(call[1]).toContain('--hostname')
      expect(call[1][3]).toContain('sort=created&direction=desc')
      expect(call[1].slice(-2)).toEqual(['--jq', LINE_COMMENT_JQ])
    }
  })

  it('is not truncated when the fifth page is short', async () => {
    const run = runner({
      view: fixture('pr-view-no-checks'),
      page: async (page) => ok(JSON.stringify(page < 5 ? newestFirst(1000 + page * 100, 100) : newestFirst(1, 99)))
    })
    expect((await new GitHubCodeHost(run).getPullRequestDetail('/repo', 3)).commentsTruncated).toBe(false)
  })

  it('reads a page of 100 comments with 12 KiB bodies as capped text, far under the output limit', async () => {
    // gh applies LINE_COMMENT_JQ before the output reaches Mousse: no diff hunk, bodies cut at 2,000 characters.
    const raw = Array.from({ length: 100 }, (_, index) => ({ ...projected(index + 1, '2026-10-26T09:00:00Z'), body: 'x'.repeat(12 * 1024), diff_hunk: 'y'.repeat(2048) }))
    expect(JSON.stringify(raw).length).toBeGreaterThan(1024 * 1024)
    const page = JSON.stringify(raw.map(({ diff_hunk: _hunk, body, ...rest }) => ({ ...rest, body: body.slice(0, 2000), body_truncated: body.length > 2000 })))
    const run = runner({ view: fixture('pr-view-no-checks'), page: async (number) => ok(number === 1 ? page : '[]') })
    const detail = await new GitHubCodeHost(run).getPullRequestDetail('/repo', 3)
    expect(page.length).toBeLessThan(300 * 1024)
    expect(detail.comments).toHaveLength(100)
    expect(detail.comments.every((comment) => comment.bodyTruncated && comment.body.length === 2000)).toBe(true)
  })

  it('projects line comments to the fields shown and caps their bodies', () => {
    expect(LINE_COMMENT_JQ).toContain('body: .body[:2000]')
    expect(LINE_COMMENT_JQ).toContain('body_truncated:')
    expect(LINE_COMMENT_JQ).not.toContain('diff_hunk')
    expect(PULL_REQUEST_VIEW_JQ).toContain('.comments |= map(')
    expect(PULL_REQUEST_VIEW_JQ).toContain('.reviews |= map(')
  })

  it('shares one read between callers, folders of one repository included, and forced reads', async () => {
    let now = 5_000_000
    const run = runner()
    const host = new GitHubCodeHost(run, () => now)
    await Promise.all([host.getPullRequestDetail('/a', 7), host.getPullRequestDetail('/b', 7), host.getPullRequestDetail('/a', 7, { force: true })])
    expect(callsTo(run, 'view')).toHaveLength(1)
    // Fresh for 30 seconds, and a forced read still waits out the 5-second floor.
    now += 4_000
    await host.getPullRequestDetail('/a', 7, { force: true })
    expect(callsTo(run, 'view')).toHaveLength(1)
    now += 2_000
    await host.getPullRequestDetail('/a', 7, { force: true })
    expect(callsTo(run, 'view')).toHaveLength(2)
    now += 31_000
    await host.getPullRequestDetail('/b', 7)
    expect(callsTo(run, 'view')).toHaveLength(3)
  })

  it('does not share a pull request between the same owner and repository on two hosts, or two numbers', async () => {
    const run = runner({ identity: (cwd) => (cwd === '/enterprise' ? identityJson('https://ghe.example.com/acme/app') : identityJson()) })
    const host = new GitHubCodeHost(run)
    await host.getPullRequestDetail('/a', 7)
    await host.getPullRequestDetail('/enterprise', 7)
    await host.getPullRequestDetail('/a', 8)
    expect(callsTo(run, 'view')).toHaveLength(3)
  })

  it('refuses a number that cannot be one before running anything', async () => {
    const run = runner()
    for (const number of [0, -1, 1.5, Number.NaN]) {
      await expect(new GitHubCodeHost(run).getPullRequestDetail('/repo', number)).rejects.toBeInstanceOf(PullRequestReadError)
    }
    expect(run).not.toHaveBeenCalled()
  })
})

describe('GitHubCodeHost.getPullRequestDetail failures', () => {
  it('names the repository, host and signed-in account when the pull request cannot be found, after the host\'s own message', async () => {
    const run = runner({ view: async () => { throw failure('GraphQL: Could not resolve to a PullRequest with the number of 7. (repository.pullRequest)') } })
    const error = await new GitHubCodeHost(run).getPullRequestDetail('/repo', 7).catch((caught: unknown) => caught as PullRequestReadError)
    expect(error).toBeInstanceOf(PullRequestReadError)
    expect(error.kind).toBe('not-found')
    expect(error.message.startsWith('GraphQL: Could not resolve to a PullRequest with the number of 7.')).toBe(true)
    expect(error.message).toContain('acme/app on github.com')
    expect(error.message).toContain('signed in to github.com as octocat')
    expect(run).toHaveBeenCalledWith('gh', ['api', '--hostname', 'github.com', 'user', '--jq', '.login'], { cwd: '/repo' })
  })

  it('still explains a missing pull request when the account cannot be read', async () => {
    const run = runner({
      view: async () => { throw failure('gh: Not Found (HTTP 404)') },
      viewer: async () => { throw failure('HTTP 502') }
    })
    const error = await new GitHubCodeHost(run).getPullRequestDetail('/repo', 7).catch((caught: unknown) => caught as PullRequestReadError)
    expect(error.message).toContain('may not see it')
    expect(error.message).toContain('gh: Not Found (HTTP 404)')
  })

  it('names the host when the account is signed out', async () => {
    const run = runner({
      identity: () => identityJson('https://ghe.example.com/acme/app'),
      view: async () => { throw failure('To get started with GitHub CLI, please run:  gh auth login') }
    })
    const error = await new GitHubCodeHost(run).getPullRequestDetail('/repo', 7).catch((caught: unknown) => caught as PullRequestReadError)
    expect(error.kind).toBe('unauthenticated')
    expect(error.message).toContain('To get started with GitHub CLI')
    expect(error.message).toContain('ghe.example.com')
    expect(error.message).toContain('/repo')
  })

  it('names the folder when it is not a GitHub repository, even though the identity read is what failed', async () => {
    const run = vi.fn<ExecutableRunner>(async (_executable, args) => {
      if (args[0] === '--version') return ok()
      throw failure('none of the git remotes configured for this repository point to a known GitHub host.')
    })
    const error = await new GitHubCodeHost(run).getPullRequestDetail('/notes', 7).catch((caught: unknown) => caught as PullRequestReadError)
    expect(error.kind).toBe('not-github')
    expect(error.message).toContain('none of the git remotes configured')
    expect(error.message).toContain('/notes is not a GitHub repository')
  })

  it('passes a rate limit and other failures on in the host\'s words, and a failed comment page too', async () => {
    const limited = runner({ view: async () => { throw failure('GraphQL: API rate limit exceeded for user ID 1.') } })
    const rateLimited = await new GitHubCodeHost(limited).getPullRequestDetail('/repo', 7).catch((caught: unknown) => caught as PullRequestReadError)
    expect(rateLimited).toMatchObject({ kind: 'rate-limited', message: 'GraphQL: API rate limit exceeded for user ID 1.' })

    const broken = runner({ page: async () => { throw failure('HTTP 502: Bad Gateway') } })
    const bad = await new GitHubCodeHost(broken).getPullRequestDetail('/repo', 7).catch((caught: unknown) => caught as PullRequestReadError)
    expect(bad).toMatchObject({ kind: 'error', message: 'HTTP 502: Bad Gateway' })
  })

  it('says so when gh is not installed', async () => {
    const run = vi.fn<ExecutableRunner>(async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) })
    const error = await new GitHubCodeHost(run).getPullRequestDetail('/repo', 7).catch((caught: unknown) => caught as PullRequestReadError)
    expect(error).toMatchObject({ kind: 'gh-missing' })
    expect(error.message).toContain('GitHub CLI (gh) was not found')
  })

  it('does not ask again at once after a failure that would only repeat, and does retry other failures', async () => {
    let now = 7_000_000
    const signedOut = runner({ view: async () => { throw failure('To get started with GitHub CLI, please run:  gh auth login') } })
    const host = new GitHubCodeHost(signedOut, () => now)
    await host.getPullRequestDetail('/repo', 7).catch(() => undefined)
    await host.getPullRequestDetail('/repo', 7).catch(() => undefined)
    expect(callsTo(signedOut, 'view')).toHaveLength(1)

    const flaky = runner({ view: async () => { throw failure('HTTP 502: Bad Gateway') } })
    const retried = new GitHubCodeHost(flaky, () => now)
    await retried.getPullRequestDetail('/repo', 7).catch(() => undefined)
    await retried.getPullRequestDetail('/repo', 7).catch(() => undefined)
    expect(callsTo(flaky, 'view')).toHaveLength(2)
  })
})

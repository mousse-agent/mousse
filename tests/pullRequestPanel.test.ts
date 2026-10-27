import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PullRequestMarkdown, openExternalUrl } from '../src/renderer/components/PullRequestMarkdown'
import { PullRequestPanelView } from '../src/renderer/components/PullRequestPanel'
import {
  PANEL_LIMITS,
  commentFileLink,
  commentFileTarget,
  groupPullRequestComments,
  htmlImagesToLinks,
  prepareCommentBody,
  pullRequestBadge,
  pullRequestPanelState,
  reviewLabel,
  safeWebUrl,
  showFirst,
  stripHtmlComments,
  summarizeReviewers,
  threadLineLabel,
  type PullRequestPanelState
} from '../src/renderer/components/pullRequestPanelLogic'
import { surfaceTabItems, SURFACE_CHOICES } from '../src/renderer/lib/surfaces'
import { useAppStore } from '../src/renderer/stores/appStore'
import { routeLink } from '../src/renderer/utils/chatLinks'
import type { PullRequestComment, PullRequestDetail, PullRequestReview } from '../src/shared/pullRequests'

const comment = (id: string, patch: Partial<PullRequestComment> = {}): PullRequestComment => ({
  id,
  author: 'grace',
  authorAssociation: 'MEMBER',
  body: `Comment ${id}`,
  bodyTruncated: false,
  createdAt: '2026-10-26T09:00:00Z',
  edited: false,
  url: `https://example.test/acme/app/pull/7#discussion_r${id}`,
  path: 'src/a.ts',
  line: 14,
  startLine: null,
  side: 'RIGHT',
  inReplyTo: null,
  ...patch
})

const conversation = (id: string, patch: Partial<PullRequestComment> = {}): PullRequestComment =>
  comment(id, { path: null, line: null, side: null, url: `https://example.test/acme/app/pull/7#issuecomment-${id}`, ...patch })

const review = (id: string, author: string, state: PullRequestReview['state'], submittedAt: string | null, patch: Partial<PullRequestReview> = {}): PullRequestReview => ({
  id,
  author,
  authorAssociation: 'MEMBER',
  state,
  body: '',
  bodyTruncated: false,
  submittedAt,
  edited: false,
  url: `https://example.test/acme/app/pull/7#pullrequestreview-${id}`,
  ...patch
})

const detail = (patch: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  number: 7,
  title: 'Add the retry button',
  url: 'https://example.test/acme/app/pull/7',
  state: 'open',
  isDraft: false,
  checks: 'passing',
  checkCounts: { passed: 1, failed: 0, pending: 0, waiting: 0, total: 1 },
  identity: { host: 'example.test', nameWithOwner: 'acme/app', number: 7 },
  body: '',
  author: 'ada',
  headRefName: 'feature/retry',
  baseRefName: 'main',
  headSha: 'abc1234def5678',
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

const NOW = Date.parse('2026-10-26T10:00:00Z')
const render = (state: PullRequestPanelState, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PullRequestPanelView, { state, now: NOW, ...props }))
const ready = (value: PullRequestDetail, staleError: string | null = null): PullRequestPanelState => ({ kind: 'ready', detail: value, staleError })
const count = (html: string, needle: string) => html.split(needle).length - 1

describe('grouping comments by file and line', () => {
  it('separates the conversation from line comments and groups the latter by file, then line', () => {
    const groups = groupPullRequestComments(detail({
      comments: [
        conversation('c1', { createdAt: '2026-10-26T08:00:00Z' }),
        comment('l1', { path: 'src/b.ts', line: 30 }),
        comment('l2', { path: 'src/a.ts', line: 40 }),
        comment('l3', { path: 'src/a.ts', line: 5 }),
        conversation('c2', { createdAt: '2026-10-26T08:30:00Z' })
      ]
    }))
    expect(groups.conversation.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(groups.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(groups.files[0].threads.map((thread) => [thread.key, thread.line])).toEqual([['l3', 5], ['l2', 40]])
    expect(groups.files[1].threads.map((thread) => thread.key)).toEqual(['l1'])
    expect(groups.lineCommentCount).toBe(3)
  })

  it('nests replies under the comment they answer, oldest first', () => {
    const groups = groupPullRequestComments(detail({
      comments: [
        comment('r2', { inReplyTo: 'root', createdAt: '2026-10-26T09:20:00Z' }),
        comment('root', { createdAt: '2026-10-26T09:00:00Z' }),
        comment('r1', { inReplyTo: 'root', createdAt: '2026-10-26T09:10:00Z' }),
        comment('other', { line: 90 })
      ]
    }))
    const [file] = groups.files
    expect(file.threads.map((thread) => thread.key)).toEqual(['root', 'other'])
    expect(file.threads[0].replies.map((reply) => reply.id)).toEqual(['r1', 'r2'])
    expect(file.commentCount).toBe(4)
  })

  it('follows a reply to a reply up to the thread it belongs to', () => {
    const groups = groupPullRequestComments(detail({
      comments: [
        comment('root', { createdAt: '2026-10-26T09:00:00Z' }),
        comment('r1', { inReplyTo: 'root', createdAt: '2026-10-26T09:01:00Z' }),
        comment('r2', { inReplyTo: 'r1', createdAt: '2026-10-26T09:02:00Z' })
      ]
    }))
    expect(groups.files[0].threads).toHaveLength(1)
    expect(groups.files[0].threads[0].replies.map((reply) => reply.id)).toEqual(['r1', 'r2'])
  })

  it('starts a thread of its own for a reply whose parent is not among the comments, and survives a loop', () => {
    const orphan = groupPullRequestComments(detail({
      comments: [comment('late', { inReplyTo: 'gone' }), comment('later', { inReplyTo: 'late', createdAt: '2026-10-26T09:05:00Z' })]
    }))
    expect(orphan.files[0].threads.map((thread) => [thread.key, thread.replies.map((r) => r.id)])).toEqual([['late', ['later']]])

    const loop = groupPullRequestComments(detail({
      comments: [comment('a', { inReplyTo: 'b' }), comment('b', { inReplyTo: 'a', createdAt: '2026-10-26T09:01:00Z' })]
    }))
    expect(loop.files[0].commentCount).toBe(2)
    // Neither comment is lost: the loop is cut where it closes.
    expect(loop.files[0].threads.reduce((sum, thread) => sum + 1 + thread.replies.length, 0)).toBe(2)
  })

  it('labels a thread by its line, its range, its side or its absence', () => {
    const base = { line: 14, startLine: null, side: 'RIGHT' as const, outdated: false }
    expect(threadLineLabel(base)).toBe('Line 14')
    expect(threadLineLabel({ ...base, startLine: 12 })).toBe('Lines 12–14')
    expect(threadLineLabel({ ...base, side: 'LEFT' })).toBe('Line 14 (old version)')
    expect(threadLineLabel({ ...base, line: null, outdated: true })).toBe('Outdated')
  })

  it('does not change its keys when a refresh adds a comment', () => {
    const first = [comment('l1', { line: 3 }), comment('l2', { line: 9 }), conversation('c1')]
    const before = groupPullRequestComments(detail({ comments: first }))
    const after = groupPullRequestComments(detail({ comments: [...first, comment('l3', { line: 6 }), comment('l4', { inReplyTo: 'l1', createdAt: '2026-10-26T09:30:00Z' })] }))
    expect(before.files[0].threads.map((thread) => thread.key)).toEqual(['l1', 'l2'])
    expect(after.files[0].threads.map((thread) => thread.key)).toEqual(['l1', 'l3', 'l2'])
    expect(after.files[0].threads[0].replies.map((reply) => reply.id)).toEqual(['l4'])
    expect(after.conversation.map((c) => c.id)).toEqual(['c1'])
  })

  it('does not alter the comments it reads', () => {
    const comments = [comment('b', { createdAt: '2026-10-26T09:10:00Z' }), comment('a')]
    const copy = structuredClone(comments)
    groupPullRequestComments(detail({ comments }))
    expect(comments).toEqual(copy)
  })
})

describe('outdated comments', () => {
  it('marks a thread whose line is gone, counts it per file, and lists it after the live ones', () => {
    const groups = groupPullRequestComments(detail({
      comments: [
        comment('old', { line: null, startLine: null, createdAt: '2026-10-26T08:00:00Z' }),
        comment('old-reply', { line: null, inReplyTo: 'old', createdAt: '2026-10-26T08:05:00Z' }),
        comment('live', { line: 80 })
      ]
    }))
    const [file] = groups.files
    expect(file.threads.map((thread) => [thread.key, thread.outdated])).toEqual([['live', false], ['old', true]])
    expect(file.outdatedCount).toBe(2)
    expect(file.commentCount).toBe(3)
  })

  it('shows the outdated badge and the file alone to open, never a line', () => {
    const html = render(ready(detail({ comments: [comment('old', { line: null })] })))
    expect(html).toContain('data-outdated="true"')
    expect(html).toContain('>outdated<')
    expect(html).toContain('1 outdated')
    expect(html).toContain('>Outdated</button>')
    expect(html).toContain('title="Open src/a.ts"')
    expect(html).not.toContain('at line')
  })
})

describe('review summaries per reviewer', () => {
  it('gives each reviewer one verdict: the latest approval or request, not a later plain comment', () => {
    const summaries = summarizeReviewers([
      review('1', 'ada', 'changes_requested', '2026-10-25T09:00:00Z'),
      review('2', 'ada', 'approved', '2026-10-25T10:00:00Z'),
      review('3', 'ada', 'commented', '2026-10-25T11:00:00Z', { body: 'Nice' }),
      review('4', 'bob', 'commented', '2026-10-25T12:00:00Z'),
      review('5', 'cy', 'changes_requested', '2026-10-25T12:30:00Z')
    ])
    expect(summaries.map((s) => [s.author, s.verdict, s.reviewCount])).toEqual([
      ['cy', 'changes_requested', 1],
      ['ada', 'approved', 1 + 2],
      ['bob', 'commented', 1]
    ])
    expect(summaries[1].decidedBy.id).toBe('2')
    expect(summaries[1].reviews.map((r) => r.id)).toEqual(['3', '2', '1'])
    expect(summaries[1]).toMatchObject({ label: 'Approved', tone: 'passing' })
    expect(summaries[0]).toMatchObject({ label: 'Changes requested', tone: 'failing' })
  })

  it('lets a dismissed review end the verdict it dismissed and counts a reviewer\'s line comments', () => {
    const summaries = summarizeReviewers(
      [review('1', 'ada', 'approved', '2026-10-25T09:00:00Z'), review('2', 'ada', 'dismissed', '2026-10-25T10:00:00Z')],
      [comment('l1', { author: 'ada' }), comment('l2', { author: 'ada' }), conversation('c1', { author: 'ada' }), comment('l3', { author: 'bob' })]
    )
    expect(summaries).toHaveLength(1)
    // A dismissal is not a plain comment: it is the reviewer's latest decisive review.
    expect(summaries[0]).toMatchObject({ verdict: 'dismissed', lineComments: 2 })
  })

  it('shows a pending draft last and never lets it hide a submitted verdict', () => {
    const summaries = summarizeReviewers([
      review('1', 'ada', 'approved', '2026-10-25T09:00:00Z'),
      review('2', 'ada', 'pending', null),
      review('3', 'bob', 'pending', null)
    ])
    expect(summaries.map((s) => [s.author, s.verdict])).toEqual([['ada', 'approved'], ['bob', 'pending']])
    expect(reviewLabel('pending')).toBe('Pending')
  })

  it('draws one block per reviewer with the verdict, the counts and each review\'s text', () => {
    const html = render(ready(detail({
      reviews: [
        review('1', 'ada', 'changes_requested', '2026-10-26T08:00:00Z', { body: 'Please add a test.' }),
        review('2', 'ada', 'approved', '2026-10-26T09:00:00Z'),
        review('3', 'bob', 'commented', '2026-10-26T09:30:00Z', { body: 'Looks fine to me.' })
      ],
      comments: [comment('l1', { author: 'ada' })]
    })))
    expect(count(html, 'class="pr-panel-reviewer"')).toBe(2)
    expect(html).toMatch(/data-reviewer="ada".*?data-tone="passing">Approved.*?2 reviews · 1 line comment/)
    expect(html).toMatch(/data-reviewer="bob".*?data-tone="neutral">Commented/)
    expect(html).toContain('Please add a test.')
    expect(html).toContain('Looks fine to me.')
    expect(html.indexOf('data-reviewer="ada"')).toBeLessThan(html.indexOf('data-reviewer="bob"'))
  })
})

describe('what the panel shows', () => {
  const found = { state: 'found' as const, pullRequest: detail() }

  it('chooses the state from the branch lookup and the read of the pull request', () => {
    const base = { hasBranch: true, branch: 'feature/retry', lookup: null, entry: null }
    expect(pullRequestPanelState({ ...base, hasBranch: false })).toEqual({ kind: 'no-branch' })
    expect(pullRequestPanelState(base)).toEqual({ kind: 'loading' })
    expect(pullRequestPanelState({ ...base, lookup: { state: 'none', isDefaultBranch: false } })).toEqual({ kind: 'none', branch: 'feature/retry' })
    expect(pullRequestPanelState({ ...base, lookup: { state: 'unavailable', reason: 'unauthenticated', message: 'Sign in to GitHub first.' } }))
      .toEqual({ kind: 'unavailable', message: 'Sign in to GitHub first.' })
    expect(pullRequestPanelState({ ...base, lookup: found, entry: null })).toEqual({ kind: 'loading' })
    expect(pullRequestPanelState({ ...base, lookup: found, entry: { detail: null, error: null } })).toEqual({ kind: 'loading' })
    expect(pullRequestPanelState({ ...base, lookup: found, entry: { detail: null, error: 'HTTP 502' } })).toEqual({ kind: 'error', message: 'HTTP 502', number: 7 })
    const loaded = detail()
    expect(pullRequestPanelState({ ...base, lookup: found, entry: { detail: loaded, error: null } })).toEqual({ kind: 'ready', detail: loaded, staleError: null })
    // A failed refresh keeps what was read and says why.
    expect(pullRequestPanelState({ ...base, lookup: found, entry: { detail: loaded, error: 'rate limit exceeded' } })).toMatchObject({ kind: 'ready', staleError: 'rate limit exceeded' })
  })

  it('says it is loading', () => {
    const html = render({ kind: 'loading' })
    expect(html).toContain('role="status"')
    expect(html).toContain('Loading the pull request')
    expect(html).not.toContain('pr-panel-header')
  })

  it('says a branch has no pull request, and a missing branch', () => {
    const none = render({ kind: 'none', branch: 'feature/retry' })
    expect(none).toContain('feature/retry has no pull request yet.')
    expect(render({ kind: 'no-branch' })).toContain('Open a project on a Git branch')
  })

  it('shows the host\'s own message when it cannot be asked or the read failed', () => {
    const unavailable = render({ kind: 'unavailable', message: 'You are not signed in to github.example.test. Run gh auth login.' })
    expect(unavailable).toContain('role="alert"')
    expect(unavailable).toContain('You are not signed in to github.example.test. Run gh auth login.')
    expect(unavailable).toContain('Try again')
    const failed = render({ kind: 'error', message: 'Signed in to example.test as ada; it cannot see acme/app.', number: 7 })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Signed in to example.test as ada; it cannot see acme/app.')
  })

  it('escapes a host message instead of rendering it', () => {
    const html = render({ kind: 'error', message: '<img src=x onerror=alert(1)>', number: 7 })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('shows a loaded pull request with nothing on it as empty', () => {
    const html = render(ready(detail()))
    expect(html).toContain('#7')
    expect(html).toContain('Add the retry button')
    expect(html).toContain('No reviews or comments yet.')
    expect(html).not.toContain('pr-panel-section-title')
  })

  it('shows the header: state, decision, branches, short head commit, refresh and the link to the host', () => {
    const html = render(ready(detail({ isDraft: true, reviewDecision: 'changes_requested' })))
    expect(html).toContain('data-tone="neutral">Draft<')
    expect(html).toContain('data-tone="failing">Changes requested<')
    expect(html).toContain('feature/retry → main')
    expect(html).toContain('>abc1234</code>')
    expect(html).toContain('Refresh')
    expect(html).toContain('Open on GitHub')
    expect(render(ready(detail({ state: 'merged', reviewDecision: 'approved' })))).not.toContain('>Approved<')
    expect(pullRequestBadge({ state: 'merged', isDraft: false }).label).toBe('Merged')
    expect(pullRequestBadge({ state: 'closed', isDraft: false }).label).toBe('Closed')
  })

  it('says a refresh is running, and that a refresh failed while keeping the pull request on screen', () => {
    expect(render(ready(detail()), { refreshing: true })).toMatch(/aria-busy="true"[^>]*>.*Refreshing…/)
    const stale = render(ready(detail({ title: 'Kept on screen' }), 'rate limit exceeded'))
    expect(stale).toContain('Kept on screen')
    expect(stale).toContain('Could not refresh: rate limit exceeded')
  })

  it('lists checks, worst first, each with its state', () => {
    const html = render(ready(detail({
      checkRuns: [
        { name: 'build', state: 'passing', url: 'https://ci.example.test/build' },
        { name: 'test', state: 'failing', url: 'https://ci.example.test/test' },
        { name: 'deploy', state: 'waiting', url: null }
      ]
    })))
    expect(html.indexOf('>test<')).toBeLessThan(html.indexOf('>build<'))
    expect(html).toMatch(/data-tone="failing"[^>]*>.*?test.*?title="Open this check"[^>]*>Failed/)
    expect(html).toMatch(/data-tone="waiting"[^>]*>.*?deploy.*?<span class="pr-panel-check-state">Waiting for approval/)
  })

  it('draws the description, the conversation and the comments per file', () => {
    const html = render(ready(detail({
      body: 'Adds a retry button.\n\n<!-- reviewer notes: hidden -->',
      comments: [conversation('c1', { body: 'Ship it' }), comment('l1', { path: 'src/z.ts', body: 'Rename **this**' })]
    })))
    expect(html).toContain('Adds a retry button.')
    expect(html).not.toContain('reviewer notes')
    expect(html).toContain('>Ship it<')
    expect(html).toContain('data-file-path="src/z.ts"')
    expect(html).toContain('<strong>this</strong>')
    expect(html).toContain('Comments on src/z.ts')
  })

  it('marks a thread whose file was opened with a background mark, and no other', () => {
    const value = detail({ comments: [comment('l1', { line: 3 }), comment('l2', { line: 9 })] })
    const html = render(ready(value), { initialSelectedKey: 'l2' })
    expect(count(html, 'data-selected="true"')).toBe(1)
    expect(html).toMatch(/data-thread-key="l2"[^>]*data-selected="true"/)
    expect(html).not.toMatch(/data-thread-key="l1"[^>]*data-selected/)
    expect(render(ready(value))).not.toContain('data-selected')
  })

  it('keeps comments in the same order and under the same keys when it draws again', () => {
    const comments = [comment('l1', { line: 3 }), comment('l2', { line: 9 }), comment('r1', { inReplyTo: 'l1', createdAt: '2026-10-26T09:05:00Z' })]
    const first = render(ready(detail({ comments })))
    const again = render(ready(detail({ comments: [...comments].reverse() })))
    expect([...first.matchAll(/data-comment-id="([^"]+)"/g)].map((m) => m[1])).toEqual(['l1', 'r1', 'l2'])
    expect(again).toBe(first)
  })

  it('draws a draft thread of line comments only for an open file group', () => {
    const comments = ['a', 'b', 'c', 'd', 'e'].map((name) => comment(`${name}1`, { path: `src/${name}.ts`, body: `Body ${name}` }))
    const html = render(ready(detail({ comments })))
    expect(count(html, 'class="pr-panel-file"')).toBe(5)
    // Only the first few files start open; the others draw their header alone.
    expect(count(html, 'aria-expanded="true"')).toBe(PANEL_LIMITS.openFiles)
    expect(html).toContain('Body a')
    expect(html).not.toContain('Body e')
  })
})

describe('large comment counts stay bounded', () => {
  it('takes the first items and says how many are left out', () => {
    expect(showFirst([1, 2, 3], 2)).toEqual({ items: [1, 2], hidden: 1 })
    expect(showFirst([1, 2, 3], 10)).toEqual({ items: [1, 2, 3], hidden: 0 })
    expect(showFirst([1, 2, 3], -4)).toEqual({ items: [], hidden: 3 })
  })

  it('groups five hundred line comments without losing one', () => {
    const comments = Array.from({ length: 500 }, (_, index) => comment(`l${index}`, { path: `src/f${index % 40}.ts`, line: (index % 97) + 1, createdAt: new Date(NOW - index * 1000).toISOString() }))
    const groups = groupPullRequestComments(detail({ comments }))
    expect(groups.files).toHaveLength(40)
    expect(groups.lineCommentCount).toBe(500)
    expect(groups.files.reduce((sum, file) => sum + file.commentCount, 0)).toBe(500)
  })

  it('draws a bounded number of comments however many exist, and offers the rest', () => {
    const lines = Array.from({ length: 600 }, (_, index) => comment(`l${index}`, { path: `src/f${index % 3}.ts`, line: index + 1, createdAt: new Date(NOW - index * 1000).toISOString() }))
    const chat = Array.from({ length: 400 }, (_, index) => conversation(`c${index}`, { createdAt: new Date(NOW - index * 1000).toISOString() }))
    const reviews = Array.from({ length: 200 }, (_, index) => review(`r${index}`, `reviewer${String(index).padStart(3, '0')}`, 'commented', '2026-10-26T08:00:00Z'))
    const html = render(ready(detail({ comments: [...lines, ...chat], reviews, commentsTruncated: true })))
    const drawn = count(html, 'data-comment-id=')
    // Conversation, then at most the first threads of the files that start open; nothing like 1,000.
    const ceiling = PANEL_LIMITS.listed + PANEL_LIMITS.openFiles * PANEL_LIMITS.threadsPerFile
    expect(drawn).toBeLessThanOrEqual(ceiling)
    expect(drawn).toBeGreaterThan(0)
    expect(count(html, 'data-reviewer=')).toBe(PANEL_LIMITS.listed)
    expect(html).toContain('Show 50 more comments')
    expect(html).toContain('375 not shown')
    expect(html).toContain('Show 50 more threads')
    expect(html).toContain('Show 50 more reviewers')
    expect(html).toContain('Only the newest line comments are shown.')
    expect(html).toContain('600+ comments')
  })

  it('draws a bounded number of replies in one thread', () => {
    const replies = Array.from({ length: 80 }, (_, index) => comment(`r${index}`, { inReplyTo: 'root', createdAt: new Date(NOW - 10_000 + index * 1000).toISOString() }))
    const html = render(ready(detail({ comments: [comment('root', { createdAt: new Date(NOW - 100_000).toISOString() }), ...replies] })))
    expect(count(html, 'data-comment-id=')).toBe(1 + PANEL_LIMITS.repliesPerThread)
    expect(html).toContain('Show 50 more replies')
  })

  it('clips one huge comment and points to the full text', () => {
    const huge = 'word '.repeat(5000)
    const prepared = prepareCommentBody(huge)
    expect(prepared.clipped).toBe(true)
    expect(prepared.text.length).toBeLessThanOrEqual(PANEL_LIMITS.bodyChars)
    const html = render(ready(detail({ comments: [conversation('c1', { body: huge })] })))
    expect(html.length).toBeLessThan(huge.length / 2)
    expect(html).toContain('open the full text on the host')
    expect(prepareCommentBody('short').clipped).toBe(false)
    expect(render(ready(detail({ comments: [conversation('c2', { body: 'cut by the host', bodyTruncated: true })] })))).toContain('open the full text on the host')
  })

  it('does not cut an emoji in half when it clips', () => {
    const prepared = prepareCommentBody('a'.repeat(PANEL_LIMITS.bodyChars - 1) + '😀😀', PANEL_LIMITS.bodyChars)
    expect(prepared.clipped).toBe(true)
    expect(prepared.text).not.toMatch(/[\ud800-\udbff]$/)
  })
})

describe('opening a file at a line from a comment', () => {
  it('points at the repository path and the line on the new version', () => {
    expect(commentFileTarget(comment('x'))).toEqual({ path: 'src/a.ts', line: 14 })
    expect(commentFileLink(comment('x'))).toBe('mousse-file://open?path=src%2Fa.ts&line=14')
  })

  it('opens the file alone when the line is gone or belongs to the old version', () => {
    expect(commentFileTarget(comment('x', { line: null }))).toEqual({ path: 'src/a.ts' })
    expect(commentFileTarget(comment('x', { side: 'LEFT' }))).toEqual({ path: 'src/a.ts' })
    expect(commentFileLink(comment('x', { line: null }))).toBe('mousse-file://open?path=src%2Fa.ts')
  })

  it('refuses a path that is not inside the repository', () => {
    for (const path of ['/etc/passwd', '../secrets.txt', 'src/../../x', 'C:\\Windows\\win.ini', 'C:/Windows/win.ini', 'a\\b', '', 'a\0b']) {
      expect(commentFileTarget(comment('x', { path }))).toBeNull()
    }
    expect(commentFileTarget(conversation('c1'))).toBeNull()
    expect(commentFileLink(comment('x', { path: '../x' }))).toBeNull()
  })

  describe('through the Files surface', () => {
    const dispatchEvent = vi.fn()
    beforeEach(() => {
      dispatchEvent.mockClear()
      vi.stubGlobal('window', { dispatchEvent })
    })
    afterEach(() => vi.unstubAllGlobals())

    it('asks the Files surface to open the path at the line, for the thread that is shown', () => {
      const link = commentFileLink(comment('x', { path: 'src/deep/file name.ts', line: 21 }))!
      expect(routeLink(link, { threadId: 'thread-1' })).toBe(true)
      expect(dispatchEvent).toHaveBeenCalledTimes(1)
      const event = dispatchEvent.mock.calls[0][0] as CustomEvent
      expect(event.type).toBe('mousse:open-file')
      expect(event.detail).toMatchObject({ path: 'src/deep/file name.ts', line: 21, threadId: 'thread-1' })
    })

  })

  it('gives a live thread a button that names the file and line, and a plain label when the path is unsafe', () => {
    const html = render(ready(detail({ comments: [comment('l1', { line: 14 }), comment('l2', { path: '../x', line: 2 })] })))
    expect(html).toContain('title="Open src/a.ts at line 14"')
    expect(html).toContain('>Line 14</button>')
    expect(html).toContain('<span class="pr-panel-line" data-static="true">Line 2</span>')
  })
})

describe('comment text is rendered safely', () => {
  it('drops raw HTML instead of injecting it', () => {
    const html = renderToStaticMarkup(createElement(PullRequestMarkdown, {
      text: 'Hi <script>alert(1)</script><b onclick="x()">bold</b> <iframe src="https://evil.test"></iframe>\n\n<div style="x">block</div>'
    }))
    expect(html).not.toMatch(/<script|<iframe|<div style|<b |onclick/i)
    expect(html).toContain('Hi')
  })

  it('opens links in the browser, and shows any other kind of link as plain text', () => {
    const html = renderToStaticMarkup(createElement(PullRequestMarkdown, {
      text: '[docs](https://example.test/docs) [bad](javascript:alert(1)) [mail](mailto:a@b.test) [rel](/acme/app/issues/3) [data](data:text/html,x)'
    }))
    expect(html).toMatch(/<a href="https:\/\/example\.test\/docs" target="_blank" rel="noopener noreferrer">docs<\/a>/)
    expect(html).not.toMatch(/javascript:|mailto:|data:text/)
    expect(html).toContain('bad')
    expect(html).toContain('mail')
    expect(count(html, '<a ')).toBe(1)
  })

  it('shows images as links and fetches nothing', () => {
    const html = renderToStaticMarkup(createElement(PullRequestMarkdown, {
      text: '![screenshot](https://example.test/a.png)\n\n![x](data:image/png;base64,AAAA)\n\n<img src="https://example.test/b.png" onerror="x()">'
    }))
    expect(html).not.toContain('<img')
    expect(html).toContain('>Image: screenshot</a>')
    expect(html).toContain('href="https://example.test/a.png"')
    expect(html).not.toContain('data:image')
    expect(html).toContain('(not shown)')
  })

  it('turns pasted HTML images into links, whatever else the tag carries', () => {
    expect(htmlImagesToLinks('<img width="300" alt="the [bug]" src="https://example.test/a(1).png" />'))
      .toBe('[Image: the bug](https://example.test/a%281%29.png)')
    expect(htmlImagesToLinks("<img src='https://example.test/b.png'>")).toBe('[Image](https://example.test/b.png)')
    expect(htmlImagesToLinks('<img src="javascript:alert(1)">x')).toBe('x')
    expect(htmlImagesToLinks('<img src="file:///etc/passwd">')).toBe('')
    expect(htmlImagesToLinks('no images')).toBe('no images')
  })

  it('removes HTML comments, but not inside code', () => {
    expect(stripHtmlComments('a <!-- hidden --> b')).toBe('a  b')
    expect(stripHtmlComments('a <!--\nmulti\nline\n--> b')).toBe('a  b')
    expect(stripHtmlComments('visible <!-- never closed\nstill hidden')).toBe('visible ')
    expect(stripHtmlComments('`<!-- kept -->` and <!-- gone -->')).toBe('`<!-- kept -->` and ')
    expect(stripHtmlComments('```html\n<!-- kept -->\n```\n<!-- gone -->')).toBe('```html\n<!-- kept -->\n```\n')
    expect(stripHtmlComments('nothing here')).toBe('nothing here')
  })

  it('accepts only web addresses', () => {
    expect(safeWebUrl('https://example.test/a?b=1')).toBe('https://example.test/a?b=1')
    expect(safeWebUrl('http://example.test')).toBe('http://example.test/')
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///x', 'mailto:a@b.test', '//example.test', '/rel', '', null, undefined]) {
      expect(safeWebUrl(bad)).toBeNull()
    }
  })

  describe('opening a link', () => {
    afterEach(() => vi.unstubAllGlobals())
    it('hands a web address to the browser without an opener, and ignores anything else', () => {
      const open = vi.fn()
      vi.stubGlobal('window', { open })
      openExternalUrl('https://example.test/x')
      expect(open).toHaveBeenCalledWith('https://example.test/x', '_blank', 'noopener,noreferrer')
      openExternalUrl('javascript:alert(1)')
      expect(open).toHaveBeenCalledTimes(1)
    })
  })
})

describe('the Pull request surface', () => {
  it('has a tab and a menu entry with its own command', () => {
    const items = surfaceTabItems({ opened: ['git', 'pullRequest'], terminals: [], browsers: [], documents: [] })
    expect(items.map((item) => [item.key, item.view, item.label])).toEqual([['git', 'git', 'Diff'], ['pullRequest', 'pullRequest', 'Pull request']])
    expect(SURFACE_CHOICES).toContainEqual({ id: 'pullRequest', label: 'Pull request', commandId: 'surface.pullRequest' })
  })

  it('opens from the store like any other surface', () => {
    useAppStore.getState().openSurfaceKind('pullRequest')
    expect(useAppStore.getState().openedSurfaceKinds).toContain('pullRequest')
    expect(useAppStore.getState().mainView).toBe('pullRequest')
  })
})

describe('the panel marks a selection with a background only', () => {
  const css = readFileSync(resolve(__dirname, '../src/renderer/components/pullRequestPanel.css'), 'utf8')

  it('never draws a bar on a side or an edge', () => {
    expect(css).toContain("[data-selected='true']")
    expect(css).not.toMatch(/border-(?:left|right|inline)(?:-start|-end)?(?:-width|-color|-style)?\s*:/)
    expect(css).not.toMatch(/box-shadow\s*:\s*inset/)
    expect(css).not.toMatch(/::before|::after/)
    const rule = /\.pr-panel-thread\[data-selected='true'\]\s*\{([^}]*)\}/.exec(css)
    expect(rule?.[1]).toMatch(/background:/)
    expect(rule?.[1]).not.toMatch(/border|shadow|outline/)
  })
})

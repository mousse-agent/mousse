import type {
  GitPullRequestLookup,
  PullRequestComment,
  PullRequestDetail,
  PullRequestReview,
  PullRequestReviewVerdict
} from '../../shared/pullRequests'
import { formatMousseFileLink } from '../../shared/chatReferences'

/** Pure helpers for the pull request panel. No React or store imports, so tests can load it. */

export { relativeTime } from './sideCard/gitSectionLogic'

/** How much the panel draws before "Show more": a pull request can carry thousands of remarks. */
export const PANEL_LIMITS = {
  /** Reviews, conversation comments, checks and file groups listed before "Show more". */
  listed: 25,
  /** File groups that start open; the rest start closed and draw nothing until opened. */
  openFiles: 3,
  /** Line threads of one file listed before "Show more". */
  threadsPerFile: 15,
  /** Replies of one thread listed before "Show more". */
  repliesPerThread: 5,
  /** How many more a "Show more" adds. */
  step: 50,
  /** Characters of one remark that are drawn; the rest is on the host. */
  bodyChars: 4000
} as const

/** The first `shown` items and how many are left out. */
export function showFirst<T>(items: readonly T[], shown: number): { items: readonly T[]; hidden: number } {
  const count = Math.max(0, Math.min(items.length, Math.floor(shown)))
  return { items: count === items.length ? items : items.slice(0, count), hidden: items.length - count }
}

// ---------------------------------------------------------------------------------------------
// Comment text
// ---------------------------------------------------------------------------------------------

const FENCE_OR_COMMENT = /(`{3,}[\s\S]*?(?:`{3,}|$))|(`[^`\n]*`)|(<!--[\s\S]*?(?:-->|$))/g

/**
 * Removes HTML comments (`<!-- ... -->`), which the host hides too. Code spans and fenced code keep
 * theirs; an unclosed comment runs to the end, as it does on the host.
 */
export function stripHtmlComments(text: string): string {
  if (!text.includes('<!--')) return text
  return text.replace(FENCE_OR_COMMENT, (match, fence: string | undefined, span: string | undefined) => {
    const isCode = fence !== undefined || span !== undefined
    return isCode ? match : ''
  })
}

const HTML_IMAGE = /<img\b[^>]*>/gi

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return match ? (match[1] ?? match[2] ?? '') : null
}

/** A web address that is safe to put in a markdown link, or null. */
export function safeWebUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.href.replace(/\(/g, '%28').replace(/\)/g, '%29')
  } catch {
    return null
  }
}

/**
 * Turns the `<img>` tags that pasted screenshots arrive as into markdown links, since raw HTML is never
 * rendered and images are shown as links (private attachments need a signed-in browser to load).
 * A tag without a web address is dropped.
 */
export function htmlImagesToLinks(text: string): string {
  if (!/<img\b/i.test(text)) return text
  return text.replace(HTML_IMAGE, (tag) => {
    const url = safeWebUrl(attribute(tag, 'src'))
    if (!url) return ''
    const alt = (attribute(tag, 'alt') ?? '').replace(/[[\]\\`]/g, ' ').replace(/\s+/g, ' ').trim()
    return `[Image${alt ? `: ${alt}` : ''}](${url})`
  })
}

/** What a remark's markdown is drawn from: no HTML comments, images as links, and at most `bodyChars` characters. */
export function prepareCommentBody(body: string, limit: number = PANEL_LIMITS.bodyChars): { text: string; clipped: boolean } {
  const text = htmlImagesToLinks(stripHtmlComments(body)).trim()
  if (text.length <= limit) return { text, clipped: false }
  // Do not cut a surrogate pair in half.
  let end = limit
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return { text: text.slice(0, end).trimEnd(), clipped: true }
}

// ---------------------------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------------------------

export type PullRequestPanelTone = 'passing' | 'failing' | 'pending' | 'neutral'

const REVIEW_LABELS: Record<PullRequestReviewVerdict, string> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  commented: 'Commented',
  dismissed: 'Dismissed',
  pending: 'Pending'
}

const REVIEW_TONES: Record<PullRequestReviewVerdict, PullRequestPanelTone> = {
  approved: 'passing',
  changes_requested: 'failing',
  commented: 'neutral',
  dismissed: 'neutral',
  pending: 'pending'
}

export function reviewLabel(state: PullRequestReviewVerdict): string {
  return REVIEW_LABELS[state]
}

export function reviewTone(state: PullRequestReviewVerdict): PullRequestPanelTone {
  return REVIEW_TONES[state]
}

/** What attention a verdict needs first: a request for changes, then approvals, then the rest. */
const VERDICT_ORDER: PullRequestReviewVerdict[] = ['changes_requested', 'approved', 'commented', 'dismissed', 'pending']

export interface ReviewerSummary {
  author: string
  /** Where the reviewer stands now: their latest approval or request for changes, unless a later review dismissed it; else their latest review. */
  verdict: PullRequestReviewVerdict
  label: string
  tone: PullRequestPanelTone
  /** The review that set the verdict. */
  decidedBy: PullRequestReview
  reviewCount: number
  /** Line comments this reviewer left. */
  lineComments: number
  /** Every review of this reviewer, newest first, so the panel lists them under the summary. */
  reviews: PullRequestReview[]
}

function reviewTime(review: PullRequestReview): number {
  const time = review.submittedAt ? Date.parse(review.submittedAt) : Number.NaN
  return Number.isNaN(time) ? 0 : time
}

/**
 * One summary per reviewer. On the host a plain comment review does not undo an earlier approval or
 * request for changes, so the verdict is the reviewer's latest approval or request for changes, unless
 * a later review was dismissed; a reviewer who only commented is `commented`. Reviewers whose changes
 * were requested come first, then approvals, then the rest, each group by name.
 */
export function summarizeReviewers(reviews: readonly PullRequestReview[], comments: readonly PullRequestComment[] = []): ReviewerSummary[] {
  const byAuthor = new Map<string, PullRequestReview[]>()
  for (const review of reviews) {
    const list = byAuthor.get(review.author)
    if (list) list.push(review)
    else byAuthor.set(review.author, [review])
  }
  const lineComments = new Map<string, number>()
  for (const comment of comments) {
    if (comment.path !== null) lineComments.set(comment.author, (lineComments.get(comment.author) ?? 0) + 1)
  }

  const summaries: ReviewerSummary[] = []
  for (const [author, list] of byAuthor) {
    // Newest first; reviews without a time (a pending draft) count as newest, then by position.
    const newestFirst = list
      .map((review, index) => ({ review, index }))
      .sort((a, b) => {
        const pendingA = a.review.state === 'pending' ? 1 : 0
        const pendingB = b.review.state === 'pending' ? 1 : 0
        return pendingB - pendingA || reviewTime(b.review) - reviewTime(a.review) || b.index - a.index
      })
      .map(({ review }) => review)
    const submitted = newestFirst.filter((review) => review.state !== 'pending')
    const decisive = submitted.find((review) => review.state !== 'commented')
    const decidedBy = decisive ?? submitted[0] ?? newestFirst[0]
    summaries.push({
      author,
      verdict: decidedBy.state,
      label: reviewLabel(decidedBy.state),
      tone: reviewTone(decidedBy.state),
      decidedBy,
      reviewCount: list.length,
      lineComments: lineComments.get(author) ?? 0,
      reviews: newestFirst
    })
  }
  return summaries.sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0))
}

// ---------------------------------------------------------------------------------------------
// Comments grouped by file and line
// ---------------------------------------------------------------------------------------------

/** One conversation on a line: the first comment and the replies under it, oldest first. */
export interface PullRequestLineThread {
  /** The id of the first comment; stable across refreshes, so the thread keeps its place. */
  key: string
  path: string
  /** Last line of the range; null when the line is no longer in the diff. */
  line: number | null
  startLine: number | null
  side: 'LEFT' | 'RIGHT' | null
  /** The line is gone from the current diff (the code changed since the comment). */
  outdated: boolean
  root: PullRequestComment
  replies: PullRequestComment[]
}

export interface PullRequestFileGroup {
  path: string
  /** Threads on lines still in the diff first, by line; outdated ones after them. */
  threads: PullRequestLineThread[]
  /** Comments in the file, replies included. */
  commentCount: number
  outdatedCount: number
}

export interface PullRequestCommentGroups {
  /** Comments on the conversation, oldest first. */
  conversation: PullRequestComment[]
  /** Files with line comments, by path. */
  files: PullRequestFileGroup[]
  /** Line comments in all files, replies included. */
  lineCommentCount: number
}

const MAX_REPLY_DEPTH = 64

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function byTime(a: PullRequestComment, b: PullRequestComment): number {
  const left = Date.parse(a.createdAt)
  const right = Date.parse(b.createdAt)
  const order = (Number.isNaN(left) ? 0 : left) - (Number.isNaN(right) ? 0 : right)
  return order || compareText(a.id, b.id)
}

/**
 * Splits a pull request's comments into the conversation and, per file, the threads on its lines.
 * A reply (`inReplyTo`) joins the thread of the comment it answers, however deep the chain; a reply
 * whose parent is not in the list (the host held only the newest line comments) starts a thread of its
 * own. A comment on a file with no line left is `outdated`. Comments are read once and nothing is
 * mutated, so calling it again on a refreshed detail gives the same keys.
 */
export function groupPullRequestComments(detail: Pick<PullRequestDetail, 'comments'>): PullRequestCommentGroups {
  const conversation: PullRequestComment[] = []
  const lineComments: PullRequestComment[] = []
  const byId = new Map<string, PullRequestComment>()
  for (const comment of detail.comments) {
    if (comment.path === null) {
      conversation.push(comment)
    } else {
      lineComments.push(comment)
      byId.set(comment.id, comment)
    }
  }
  conversation.sort(byTime)
  lineComments.sort(byTime)

  const rootOf = (comment: PullRequestComment): PullRequestComment => {
    let current = comment
    // A chain that loops, or runs implausibly deep, ends where it is.
    for (let depth = 0; depth < MAX_REPLY_DEPTH && current.inReplyTo !== null; depth += 1) {
      const parent = byId.get(current.inReplyTo)
      if (!parent || parent === comment) break
      current = parent
    }
    return current
  }

  const threads = new Map<string, PullRequestLineThread>()
  const replies: PullRequestComment[] = []
  for (const comment of lineComments) {
    const root = rootOf(comment)
    if (root.id === comment.id) {
      threads.set(comment.id, {
        key: comment.id,
        path: comment.path!,
        line: comment.line,
        startLine: comment.startLine,
        side: comment.side,
        outdated: comment.line === null,
        root: comment,
        replies: []
      })
    } else {
      replies.push(comment)
    }
  }
  for (const reply of replies) {
    // The root was seen as a root above, unless the chain looped; then the reply is its own thread.
    const thread = threads.get(rootOf(reply).id)
    if (thread) {
      thread.replies.push(reply)
    } else {
      threads.set(reply.id, {
        key: reply.id,
        path: reply.path!,
        line: reply.line,
        startLine: reply.startLine,
        side: reply.side,
        outdated: reply.line === null,
        root: reply,
        replies: []
      })
    }
  }

  const files = new Map<string, PullRequestFileGroup>()
  for (const thread of threads.values()) {
    let group = files.get(thread.path)
    if (!group) {
      group = { path: thread.path, threads: [], commentCount: 0, outdatedCount: 0 }
      files.set(thread.path, group)
    }
    group.threads.push(thread)
    group.commentCount += 1 + thread.replies.length
    if (thread.outdated) group.outdatedCount += 1 + thread.replies.length
  }
  for (const group of files.values()) {
    group.threads.sort((a, b) => {
      if (a.outdated !== b.outdated) return a.outdated ? 1 : -1
      return (a.line ?? 0) - (b.line ?? 0) || byTime(a.root, b.root)
    })
  }

  return {
    conversation,
    files: [...files.values()].sort((a, b) => compareText(a.path, b.path)),
    lineCommentCount: lineComments.length
  }
}

/** "Line 14", "Lines 12–14", "Line 14 (old version)" or "Outdated". */
export function threadLineLabel(thread: Pick<PullRequestLineThread, 'line' | 'startLine' | 'side' | 'outdated'>): string {
  if (thread.outdated || thread.line === null) return 'Outdated'
  const range = thread.startLine !== null && thread.startLine < thread.line
    ? `Lines ${thread.startLine}–${thread.line}`
    : `Line ${thread.line}`
  return thread.side === 'LEFT' ? `${range} (old version)` : range
}

export function commentCountLabel(count: number, truncated = false): string {
  return `${count}${truncated ? '+' : ''} ${count === 1 && !truncated ? 'comment' : 'comments'}`
}

// ---------------------------------------------------------------------------------------------
// Opening a file from a comment
// ---------------------------------------------------------------------------------------------

export interface CommentFileTarget {
  /** Relative to the folder the pull request is checked out in. */
  path: string
  /** Absent when the comment's line cannot be found in the working tree. */
  line?: number
}

/**
 * Where a line comment points in the working tree. The host's path is relative to the repository; one
 * that is absolute or climbs out of it is refused, since it would open something that is not part of the
 * pull request. A comment on a line that is gone, or on the old version of a file, opens the file alone:
 * its line number does not belong to the working tree.
 */
export function commentFileTarget(comment: Pick<PullRequestComment, 'path' | 'line' | 'side'>): CommentFileTarget | null {
  const path = comment.path?.trim()
  if (!path || path.includes('\0') || path.includes('\\')) return null
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null
  if (path.split('/').some((segment) => segment === '..')) return null
  const line = comment.line !== null && comment.line > 0 && comment.side !== 'LEFT' ? Math.floor(comment.line) : undefined
  return line === undefined ? { path } : { path, line }
}

/** The link the Files surface opens: the repository path, at the comment's line when it has one. */
export function commentFileLink(comment: Pick<PullRequestComment, 'path' | 'line' | 'side'>): string | null {
  const target = commentFileTarget(comment)
  return target ? formatMousseFileLink(target.path, target.line) : null
}

// ---------------------------------------------------------------------------------------------
// What the panel shows
// ---------------------------------------------------------------------------------------------

export type PullRequestPanelState =
  /** No project, no repository, or no branch to look up. */
  | { kind: 'no-branch' }
  | { kind: 'loading' }
  /** The branch has no pull request. */
  | { kind: 'none'; branch: string | null }
  /** The host could not be asked (GitHub CLI missing or not signed in, not a GitHub repository); `message` is the host's. */
  | { kind: 'unavailable'; message: string }
  /** The pull request exists but could not be read, and nothing was read before; `message` is the host's. */
  | { kind: 'error'; message: string; number: number }
  /** `staleError` is the host's message when a refresh failed and the earlier read stays on screen. */
  | { kind: 'ready'; detail: PullRequestDetail; staleError: string | null }

/** The state the panel shows, from the branch lookup and the read of the pull request it found. */
export function pullRequestPanelState(input: {
  hasBranch: boolean
  branch: string | null
  lookup: GitPullRequestLookup | null
  /** The read of the pull request the lookup found. */
  entry: { detail: PullRequestDetail | null; error: string | null } | null
}): PullRequestPanelState {
  if (!input.hasBranch) return { kind: 'no-branch' }
  const { lookup, entry } = input
  if (entry?.detail) return { kind: 'ready', detail: entry.detail, staleError: entry.error }
  if (!lookup) return { kind: 'loading' }
  if (lookup.state === 'unavailable') return { kind: 'unavailable', message: lookup.message }
  if (lookup.state === 'none') return { kind: 'none', branch: input.branch }
  if (entry?.error) return { kind: 'error', message: entry.error, number: lookup.pullRequest.number }
  return { kind: 'loading' }
}

/** First seven characters of a commit id. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export type PullRequestBadge = { label: 'Open' | 'Draft' | 'Merged' | 'Closed'; tone: PullRequestPanelTone }

export function pullRequestBadge(pullRequest: { state: 'open' | 'closed' | 'merged'; isDraft: boolean }): PullRequestBadge {
  if (pullRequest.state === 'merged') return { label: 'Merged', tone: 'neutral' }
  if (pullRequest.state === 'closed') return { label: 'Closed', tone: 'failing' }
  return pullRequest.isDraft ? { label: 'Draft', tone: 'neutral' } : { label: 'Open', tone: 'passing' }
}

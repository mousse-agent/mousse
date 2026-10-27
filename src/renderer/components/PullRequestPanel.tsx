import { memo, useMemo, useState, type ReactNode } from 'react'
import type { PullRequestComment, PullRequestDetail, PullRequestReview } from '../../shared/pullRequests'
import { useActiveThreadPullRequest } from '../hooks/useActiveThreadPullRequest'
import { ChevronDown, ChevronRight, ExternalLink, GitPullRequest, RefreshCw } from '../lib/icons'
import { useAppStore } from '../stores/appStore'
import { refreshPullRequest, refreshPullRequestDetail, usePullRequestDetail } from '../stores/pullRequestStore'
import { routeLink } from '../utils/chatLinks'
import { PullRequestMarkdown, openExternalUrl } from './PullRequestMarkdown'
import {
  PANEL_LIMITS,
  commentCountLabel,
  commentFileLink,
  commentFileTarget,
  groupPullRequestComments,
  prepareCommentBody,
  pullRequestBadge,
  pullRequestPanelState,
  relativeTime,
  reviewLabel,
  reviewTone,
  shortSha,
  showFirst,
  summarizeReviewers,
  threadLineLabel,
  type PullRequestFileGroup,
  type PullRequestLineThread,
  type PullRequestPanelState,
  type ReviewerSummary
} from './pullRequestPanelLogic'
import { pullRequestCheckRows } from './sideCard/gitSectionLogic'
import './pullRequestPanel.css'

export interface PanelActions {
  now: number
  /** Opens a line comment's file at its line; the thread it belongs to is marked. */
  onOpenFile: (comment: PullRequestComment, threadKey: string) => void
  selectedKey: string | null
}

/** A list that draws its first items and gives the rest on request, so a pull request with thousands of remarks stays light. */
function LimitedList<T>({
  items,
  initial = PANEL_LIMITS.listed,
  noun,
  className,
  label,
  render
}: {
  items: readonly T[]
  initial?: number
  noun: string
  className: string
  label?: string
  render: (item: T, index: number) => ReactNode
}) {
  const [shown, setShown] = useState<number>(initial)
  const visible = showFirst(items, shown)
  return (
    <>
      <ul className={className} aria-label={label}>
        {visible.items.map((item, index) => render(item, index))}
      </ul>
      {visible.hidden > 0 && (
        <button type="button" className="pr-panel-more" onClick={() => setShown(shown + PANEL_LIMITS.step)}>
          Show {Math.min(PANEL_LIMITS.step, visible.hidden)} more {noun}
          <span className="pr-panel-more-count">{visible.hidden} not shown</span>
        </button>
      )}
    </>
  )
}

function Section({ title, count, children }: { title: string; count?: string | number; children: ReactNode }) {
  return (
    <section className="pr-panel-section" aria-label={title}>
      <h3 className="pr-panel-section-title">
        {title}
        {count !== undefined && <span className="pr-panel-count">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

function ExternalButton({ url, label, text }: { url: string; label: string; text?: string }) {
  return (
    <button type="button" className="pr-panel-link" title={label} aria-label={label} onClick={() => openExternalUrl(url)}>
      {text ?? <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />}
    </button>
  )
}

/** A remark's text: markdown without HTML comments, with images as links, clipped at a few thousand characters. */
function Body({ text, truncated, url }: { text: string; truncated: boolean; url: string }) {
  const prepared = useMemo(() => prepareCommentBody(text), [text])
  if (!prepared.text) return null
  return (
    <>
      <PullRequestMarkdown text={prepared.text} />
      {(prepared.clipped || truncated) && (
        <button type="button" className="pr-panel-rest" onClick={() => openExternalUrl(url)}>
          … open the full text on the host
        </button>
      )}
    </>
  )
}

const CommentView = memo(function CommentView({ comment, now }: { comment: PullRequestComment; now: number }) {
  const age = relativeTime(comment.createdAt, now)
  return (
    <article className="pr-panel-comment" data-comment-id={comment.id}>
      <header className="pr-panel-comment-head">
        <span className="pr-panel-author">{comment.author}</span>
        {age && <span className="pr-panel-time" title={comment.createdAt}>{age}</span>}
        {comment.edited && <span className="pr-panel-time">edited</span>}
        <ExternalButton url={comment.url} label="Open this comment" />
      </header>
      <Body text={comment.body} truncated={comment.bodyTruncated} url={comment.url} />
    </article>
  )
})

function ThreadView({ thread, actions }: { thread: PullRequestLineThread; actions: PanelActions }) {
  const [shownReplies, setShownReplies] = useState<number>(PANEL_LIMITS.repliesPerThread)
  const replies = showFirst(thread.replies, shownReplies)
  const canOpen = commentFileTarget(thread.root) !== null
  const label = threadLineLabel(thread)
  const selected = actions.selectedKey === thread.key
  const where = thread.outdated || thread.line === null ? thread.path : `${thread.path} at line ${thread.line}`
  return (
    <li
      className="pr-panel-thread"
      data-thread-key={thread.key}
      data-outdated={thread.outdated ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="pr-panel-thread-head">
        {canOpen ? (
          <button
            type="button"
            className="pr-panel-line"
            title={`Open ${where}`}
            onClick={() => actions.onOpenFile(thread.root, thread.key)}
          >
            {label}
          </button>
        ) : (
          <span className="pr-panel-line" data-static="true">{label}</span>
        )}
        {thread.outdated && <span className="pr-panel-badge" data-tone="neutral" title="The code this comment was made on has changed">outdated</span>}
      </div>
      <CommentView comment={thread.root} now={actions.now} />
      {thread.replies.length > 0 && (
        <div className="pr-panel-replies">
          {replies.items.map((reply) => (
            <CommentView key={reply.id} comment={reply} now={actions.now} />
          ))}
          {replies.hidden > 0 && (
            <button type="button" className="pr-panel-more" onClick={() => setShownReplies(shownReplies + PANEL_LIMITS.step)}>
              Show {Math.min(PANEL_LIMITS.step, replies.hidden)} more {replies.hidden === 1 ? 'reply' : 'replies'}
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function FileGroupView({ group, initiallyOpen, actions }: { group: PullRequestFileGroup; initiallyOpen: boolean; actions: PanelActions }) {
  const [open, setOpen] = useState(initiallyOpen)
  const [shownThreads, setShownThreads] = useState<number>(PANEL_LIMITS.threadsPerFile)
  const threads = showFirst(group.threads, shownThreads)
  return (
    <li className="pr-panel-file" data-file-path={group.path}>
      <button type="button" className="pr-panel-file-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />}
        <span className="pr-panel-file-path" title={group.path}>{group.path}</span>
        {group.outdatedCount > 0 && <span className="pr-panel-badge" data-tone="neutral">{group.outdatedCount} outdated</span>}
        <span className="pr-panel-count">{commentCountLabel(group.commentCount)}</span>
      </button>
      {open && (
        <>
          <ul className="pr-panel-threads" aria-label={`Comments on ${group.path}`}>
            {threads.items.map((thread) => (
              <ThreadView key={thread.key} thread={thread} actions={actions} />
            ))}
          </ul>
          {threads.hidden > 0 && (
            <button type="button" className="pr-panel-more" onClick={() => setShownThreads(shownThreads + PANEL_LIMITS.step)}>
              Show {Math.min(PANEL_LIMITS.step, threads.hidden)} more {threads.hidden === 1 ? 'thread' : 'threads'}
              <span className="pr-panel-more-count">{threads.hidden} not shown</span>
            </button>
          )}
        </>
      )}
    </li>
  )
}

function ReviewEntry({ review, now }: { review: PullRequestReview; now: number }) {
  const age = review.submittedAt ? relativeTime(review.submittedAt, now) : ''
  return (
    <li className="pr-panel-review" data-review-id={review.id}>
      <div className="pr-panel-comment-head">
        <span className="pr-panel-badge" data-tone={reviewTone(review.state)}>{reviewLabel(review.state)}</span>
        {age && <span className="pr-panel-time" title={review.submittedAt ?? undefined}>{age}</span>}
        {review.edited && <span className="pr-panel-time">edited</span>}
        {review.url && <ExternalButton url={review.url} label="Open this review" />}
      </div>
      <Body text={review.body} truncated={review.bodyTruncated} url={review.url} />
    </li>
  )
}

function ReviewerView({ summary, now }: { summary: ReviewerSummary; now: number }) {
  const [shown, setShown] = useState<number>(PANEL_LIMITS.repliesPerThread)
  const reviews = showFirst(summary.reviews, shown)
  const facts = [
    summary.reviewCount === 1 ? '1 review' : `${summary.reviewCount} reviews`,
    summary.lineComments > 0 ? `${summary.lineComments} line ${summary.lineComments === 1 ? 'comment' : 'comments'}` : null
  ].filter(Boolean)
  return (
    <li className="pr-panel-reviewer" data-reviewer={summary.author}>
      <div className="pr-panel-reviewer-head">
        <span className="pr-panel-author">{summary.author}</span>
        <span className="pr-panel-badge" data-tone={summary.tone}>{summary.label}</span>
        <span className="pr-panel-time">{facts.join(' · ')}</span>
      </div>
      <ul className="pr-panel-reviews" aria-label={`Reviews by ${summary.author}`}>
        {reviews.items.map((review) => (
          <ReviewEntry key={review.id} review={review} now={now} />
        ))}
      </ul>
      {reviews.hidden > 0 && (
        <button type="button" className="pr-panel-more" onClick={() => setShown(shown + PANEL_LIMITS.step)}>
          Show {Math.min(PANEL_LIMITS.step, reviews.hidden)} more {reviews.hidden === 1 ? 'review' : 'reviews'}
        </button>
      )}
    </li>
  )
}

function ChecksSection({ detail }: { detail: PullRequestDetail }) {
  const rows = useMemo(() => pullRequestCheckRows(detail.checkRuns), [detail.checkRuns])
  if (rows.length === 0) return null
  return (
    <Section title="Checks" count={rows.length}>
      <LimitedList
        items={rows}
        noun="checks"
        className="pr-panel-checks"
        label="Checks"
        render={(check) => (
          <li key={`${check.workflow ?? ''}\u0000${check.name}`} className="pr-panel-check" data-tone={check.tone}>
            <span className="pr-panel-check-dot" aria-hidden="true" />
            <span className="pr-panel-check-name" title={check.workflow ? `${check.workflow} / ${check.name}` : check.name}>{check.name}</span>
            {check.url ? (
              <button type="button" className="pr-panel-check-state" title="Open this check" onClick={() => openExternalUrl(check.url!)}>
                {check.label}
              </button>
            ) : (
              <span className="pr-panel-check-state">{check.label}</span>
            )}
          </li>
        )}
      />
    </Section>
  )
}

/** The panel's contents once a pull request has been read. */
export function PullRequestPanelDetail({ detail, actions }: { detail: PullRequestDetail; actions: PanelActions }) {
  const groups = useMemo(() => groupPullRequestComments(detail), [detail])
  const reviewers = useMemo(() => summarizeReviewers(detail.reviews, detail.comments), [detail.reviews, detail.comments])
  const description = useMemo(() => prepareCommentBody(detail.body), [detail.body])
  const empty = reviewers.length === 0 && groups.conversation.length === 0 && groups.files.length === 0
  return (
    <div className="pr-panel-body">
      {description.text && (
        <Section title="Description">
          <Body text={detail.body} truncated={false} url={detail.url} />
        </Section>
      )}
      <ChecksSection detail={detail} />
      {reviewers.length > 0 && (
        <Section title="Reviews" count={reviewers.length}>
          <LimitedList
            items={reviewers}
            noun="reviewers"
            className="pr-panel-reviewers"
            label="Reviews by reviewer"
            render={(summary) => <ReviewerView key={summary.author} summary={summary} now={actions.now} />}
          />
        </Section>
      )}
      {groups.conversation.length > 0 && (
        <Section title="Conversation" count={groups.conversation.length}>
          <LimitedList
            items={groups.conversation}
            noun="comments"
            className="pr-panel-conversation"
            label="Conversation"
            render={(comment) => (
              <li key={comment.id}>
                <CommentView comment={comment} now={actions.now} />
              </li>
            )}
          />
        </Section>
      )}
      {groups.files.length > 0 && (
        <Section title="Files" count={`${groups.files.length} · ${commentCountLabel(groups.lineCommentCount, detail.commentsTruncated)}`}>
          {detail.commentsTruncated && (
            <p className="pr-panel-note">Only the newest line comments are shown. Open the pull request on the host for the rest.</p>
          )}
          <LimitedList
            items={groups.files}
            noun="files"
            className="pr-panel-files"
            label="Files with comments"
            render={(group, index) => (
              <FileGroupView key={group.path} group={group} initiallyOpen={index < PANEL_LIMITS.openFiles} actions={actions} />
            )}
          />
        </Section>
      )}
      {empty && <p className="pr-panel-empty">No reviews or comments yet.</p>}
    </div>
  )
}

function PanelHeader({
  detail,
  refreshing,
  onRefresh
}: {
  detail: PullRequestDetail
  refreshing: boolean
  onRefresh: () => void
}) {
  const badge = pullRequestBadge(detail)
  const decision = detail.state === 'open'
    ? detail.reviewDecision === 'approved' ? { label: 'Approved', tone: 'passing' }
      : detail.reviewDecision === 'changes_requested' ? { label: 'Changes requested', tone: 'failing' }
      : detail.reviewDecision === 'review_required' ? { label: 'Review required', tone: 'pending' }
      : null
    : null
  return (
    <header className="pr-panel-header">
      <div className="pr-panel-title-row">
        <GitPullRequest size={16} strokeWidth={1.8} aria-hidden="true" />
        <span className="pr-panel-number">#{detail.number}</span>
        <h2 className="pr-panel-title" title={detail.title}>{detail.title}</h2>
        <button
          type="button"
          className="pr-panel-action"
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
          title="Read the pull request again"
        >
          <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button type="button" className="pr-panel-action" onClick={() => openExternalUrl(detail.url)} title="Open the pull request on GitHub">
          <ExternalLink size={13} strokeWidth={2} aria-hidden="true" />
          Open on GitHub
        </button>
      </div>
      <div className="pr-panel-meta">
        <span className="pr-panel-badge" data-tone={badge.tone}>{badge.label}</span>
        {decision && <span className="pr-panel-badge" data-tone={decision.tone}>{decision.label}</span>}
        <span className="pr-panel-branches" title={`${detail.headRefName} into ${detail.baseRefName}`}>
          {detail.headRefName} → {detail.baseRefName}
        </span>
        {detail.headSha && <code className="pr-panel-sha" title={detail.headSha}>{shortSha(detail.headSha)}</code>}
        {detail.author && <span className="pr-panel-time">by {detail.author}</span>}
      </div>
    </header>
  )
}

function Notice({ role, children, action }: { role: 'status' | 'alert'; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="pr-panel-notice" role={role}>
      <p>{children}</p>
      {action}
    </div>
  )
}

export interface PullRequestPanelViewProps {
  state: PullRequestPanelState
  now?: number
  refreshing?: boolean
  onRefresh?: () => void
  onOpenFile?: (comment: PullRequestComment, threadKey: string) => void
  /** The thread marked as selected when the panel opens. */
  initialSelectedKey?: string | null
}

/** What the panel draws for a state: a message, or the pull request with its checks, reviews and comments. */
export function PullRequestPanelView({
  state,
  now = Date.now(),
  refreshing = false,
  onRefresh = () => undefined,
  onOpenFile = () => undefined,
  initialSelectedKey = null
}: PullRequestPanelViewProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(initialSelectedKey)
  const actions: PanelActions = {
    now,
    selectedKey,
    onOpenFile: (comment, key) => {
      setSelectedKey(key)
      onOpenFile(comment, key)
    }
  }
  return (
    <div className="pr-panel" data-state={state.kind}>
      {state.kind === 'ready' ? (
        <>
          <PanelHeader detail={state.detail} refreshing={refreshing} onRefresh={onRefresh} />
          {state.staleError && (
            <p className="pr-panel-error" role="alert" title={state.staleError}>
              Could not refresh: {state.staleError}
            </p>
          )}
          <PullRequestPanelDetail detail={state.detail} actions={actions} />
        </>
      ) : state.kind === 'loading' ? (
        <Notice role="status">Loading the pull request…</Notice>
      ) : state.kind === 'no-branch' ? (
        <Notice role="status">Open a project on a Git branch to see its pull request.</Notice>
      ) : state.kind === 'none' ? (
        <Notice role="status">
          {state.branch ? `${state.branch} has no pull request yet.` : 'This branch has no pull request yet.'} Create one from the Git section of the side card.
        </Notice>
      ) : (
        <Notice role="alert" action={<button type="button" className="pr-panel-action" onClick={onRefresh}>Try again</button>}>
          {state.message}
        </Notice>
      )}
    </div>
  )
}

/** The pull request of the active thread: reviews and comments grouped by file and line, read through the daemon. */
export function PullRequestPanel() {
  const threadId = useAppStore((state) => state.activeThreadId)
  const source = useActiveThreadPullRequest(threadId)
  const { path, branch, projectId, folderThreadId, lookup } = source
  const number = lookup?.state === 'found' ? lookup.pullRequest.number : null
  // Any state is read in full here; the side card reads only open ones. Same entry, same flight, when it is open.
  const entry = usePullRequestDetail(path, number, projectId, folderThreadId)
  const [refreshing, setRefreshing] = useState(false)
  const state = pullRequestPanelState({ hasBranch: path !== null && branch !== null, branch, lookup, entry })

  const refresh = () => {
    if (!path || !branch || refreshing) return
    setRefreshing(true)
    const options = { force: true, projectId: projectId ?? undefined, threadId: folderThreadId ?? undefined }
    const reads = [refreshPullRequest(path, branch, options)]
    if (number !== null) reads.push(refreshPullRequestDetail(path, number, options))
    void Promise.all(reads).finally(() => setRefreshing(false))
  }

  const openFile = (comment: PullRequestComment) => {
    const link = commentFileLink(comment)
    if (link) routeLink(link, { threadId: threadId ?? undefined })
  }

  return <PullRequestPanelView state={state} refreshing={refreshing} onRefresh={refresh} onOpenFile={openFile} />
}

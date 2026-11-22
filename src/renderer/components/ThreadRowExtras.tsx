import { GitPullRequest } from '../lib/icons'
import type { ThreadPullRequestSummary } from '../../shared/pullRequests'

const STATE_WORDS: Record<NonNullable<ThreadPullRequestSummary['state']>, string> = { open: 'open', merged: 'merged', closed: 'closed' }

/** One line of the count's tooltip: `#12 Title · merged`, the repository named when the thread's pull requests span several. */
function pullRequestLine(entry: ThreadPullRequestSummary, withRepository: boolean): string {
  const name = `${withRepository ? entry.nameWithOwner : ''}#${entry.number}`
  const state = entry.isDraft && entry.state === 'open' ? 'draft' : entry.state ? STATE_WORDS[entry.state] : undefined
  return [entry.title ? `${name} ${entry.title}` : name, state].filter(Boolean).join(' · ')
}

/** The count's tooltip: every pull request of the thread with its state as last read. */
export function pullRequestTooltip(pullRequests: readonly ThreadPullRequestSummary[]): string {
  const repositories = new Set(pullRequests.map((entry) => entry.nameWithOwner.toLowerCase()))
  return pullRequests.map((entry) => pullRequestLine(entry, repositories.size > 1)).join('\n')
}

/** A thread's pull requests as a small icon and number; hover lists them with their state. Nothing when it has none. */
export function ThreadPullRequestCount({ pullRequests, className = '' }: { pullRequests: readonly ThreadPullRequestSummary[]; className?: string }) {
  if (!pullRequests.length) return null
  const label = `${pullRequests.length} pull request${pullRequests.length === 1 ? '' : 's'}`
  return (
    <span className={`threads-sidebar-pr-count ${className}`.trim()} role="img" aria-label={label} title={pullRequestTooltip(pullRequests)}>
      <GitPullRequest size={11} strokeWidth={2} aria-hidden="true" />
      {pullRequests.length}
    </span>
  )
}

/** The latest reply under a thread's title: one muted line that ends in an ellipsis. */
export function ThreadReplyPreview({ text, className = '' }: { text: string; className?: string }) {
  return <span className={`threads-sidebar-reply-preview ${className}`.trim()}>{text}</span>
}

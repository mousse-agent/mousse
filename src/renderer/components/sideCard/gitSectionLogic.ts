import type { GitBranchInfo, GitCommit, GitDiffStats, GitStatusSnapshot } from '../../../shared/types'

const MINUS = '−'

export interface DiffStatLabel {
  added: string
  removed: string
  /** Zero counts render muted instead of green or red. */
  addedZero: boolean
  removedZero: boolean
  /** Plain text for tooltips and screen readers. */
  text: string
}

/** The `+N −M` pair for the changes row. Missing stats read as no changes. */
export function diffStatLabel(stats: GitDiffStats | null): DiffStatLabel {
  const additions = stats?.additions ?? 0
  const deletions = stats?.deletions ?? 0
  const added = `+${additions}`
  const removed = `${MINUS}${deletions}`
  return {
    added,
    removed,
    addedZero: additions === 0,
    removedZero: deletions === 0,
    text: `${added} ${removed}`
  }
}

/** Files with something to commit; ignored files never are. */
export function changedFileCount(status: GitStatusSnapshot | null): number {
  return status?.changes.filter((change) => change.status !== 'ignored').length ?? 0
}

/** Left side of the changes row: how many files differ from the last commit. */
export function changesSummary(status: GitStatusSnapshot | null): string {
  const count = changedFileCount(status)
  if (count === 0) return 'No changes'
  return count === 1 ? '1 file changed' : `${count} files changed`
}

/** Compact age for a commit date: "now", "5m", "3h", "2d", "6w", "4mo", "2y". Empty when the date is unreadable. */
export function relativeTime(date: string, now: number): string {
  const then = Date.parse(date)
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days}d`
  const weeks = Math.round(days / 7)
  if (days < 60) return `${weeks}w`
  const months = Math.round(days / 30)
  if (days < 365) return `${months}mo`
  return `${Math.round(days / 365)}y`
}

export interface CommitLine {
  subject: string
  shortHash: string
  when: string
  /** Full message and details for the tooltip. */
  title: string
}

/** The latest-commit row: first line of the message, short hash and age. */
export function formatCommitLine(commit: GitCommit, now: number): CommitLine {
  const message = commit.message.trim()
  const subject = message.split('\n', 1)[0]?.trim() || '(no message)'
  const when = relativeTime(commit.date, now)
  const details = [commit.shortHash, commit.author, commit.date].filter(Boolean).join(' · ')
  return { subject, shortHash: commit.shortHash, when, title: message ? `${message}\n\n${details}` : details }
}

const isRemoteBranch = (name: string) => name.startsWith('remotes/')

/** Branch names matching the query, local branches before remote-tracking ones. */
export function branchChoices(info: GitBranchInfo | null, query: string): string[] {
  if (!info) return []
  const needle = query.trim().toLowerCase()
  const matching = info.branches.filter((name) => !needle || name.toLowerCase().includes(needle))
  return [...matching.filter((name) => !isRemoteBranch(name)), ...matching.filter(isRemoteBranch)]
}

/** Label for the branch button. */
export function branchLabel(status: GitStatusSnapshot | null): string {
  if (status?.branch) return status.branch
  if (status?.tracking === 'detached') return 'Detached HEAD'
  return 'No branch'
}

/** Git's own message for an IPC failure, trimmed to its first line without the transport prefix. */
export function gitErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const stripped = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:Error|GitError):\s*/i, '')
  const line = stripped.split('\n').map((part) => part.trim()).find(Boolean) ?? ''
  return line.replace(/^(?:error|fatal):\s*/i, '') || 'Git command failed'
}

export interface GitCollapseInput {
  /** Whether the thread belongs to a project. */
  hasProject: boolean
  /** The folder is still being resolved. */
  pathPending: boolean
  hasPath: boolean
  /** The first fetch has finished. */
  loaded: boolean
  status: GitStatusSnapshot | null
}

/**
 * The single muted line shown instead of the section when there is nothing to
 * manage, or null when the full section applies.
 */
export function gitCollapsedLabel(input: GitCollapseInput): string | null {
  if (!input.hasProject) return 'Git: no project'
  if (input.pathPending) return 'Git: checking…'
  if (!input.hasPath) return 'Git: no project folder'
  if (!input.loaded) return 'Git: checking…'
  if (!input.status) return 'Git: unavailable'
  if (!input.status.isRepo) return 'Git: not a repository'
  return null
}

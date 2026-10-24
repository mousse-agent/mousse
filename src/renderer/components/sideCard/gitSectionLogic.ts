import type {
  GitBranchInfo,
  GitCommit,
  GitDiffStats,
  GitPullRequestLookup,
  GitStatusSnapshot
} from '../../../shared/types'
import { ipcErrorLine } from '../../lib/errorText'

const MINUS = '−'

export interface DiffStatLabel {
  added: string
  removed: string
  /** "N new" when untracked files exist; the line counts do not include them. */
  untracked: string | null
  /** Zero counts render muted instead of green or red. */
  addedZero: boolean
  removedZero: boolean
  /** Plain text for tooltips and screen readers. */
  text: string
}

/** Files Git does not track yet; they are in no diff, so the line counts miss them. */
export function untrackedFileCount(status: GitStatusSnapshot | null): number {
  return status?.changes.filter((change) => change.status === 'untracked').length ?? 0
}

/**
 * The `+N −M` pair for the changes row, with "· N new" after it when untracked
 * files exist. Missing stats read as no changes.
 */
export function diffStatLabel(stats: GitDiffStats | null, untrackedCount = 0): DiffStatLabel {
  const additions = stats?.additions ?? 0
  const deletions = stats?.deletions ?? 0
  const added = `+${additions}`
  const removed = `${MINUS}${deletions}`
  const untracked = untrackedCount > 0 ? `${untrackedCount} new` : null
  return {
    added,
    removed,
    untracked,
    addedZero: additions === 0,
    removedZero: deletions === 0,
    text: untracked ? `${added} ${removed} · ${untracked}` : `${added} ${removed}`
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
  return ipcErrorLine(error).replace(/^(?:error|fatal):\s*/i, '') || 'Git command failed'
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

/**
 * Whether the section offers "Initialize repository": the folder is known and loaded,
 * and Git says it is not a repository. Never while the folder or its status is unknown.
 */
export function canInitRepository(input: GitCollapseInput): boolean {
  return input.hasProject && !input.pathPending && input.hasPath && input.loaded && input.status !== null && !input.status.isRepo
}

/**
 * Attributes that make the branch search a combobox over the branch listbox. The
 * search only exists while the popover is open, so it is always expanded.
 */
export function branchSearchAria(listId: string, activeIndex: number, choiceCount: number) {
  return {
    role: 'combobox',
    'aria-expanded': true,
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    'aria-activedescendant': choiceCount > 0 ? `${listId}-${activeIndex}` : undefined
  } as const
}

export type PullRequestChecksTone = 'passing' | 'failing' | 'pending'

export interface PullRequestFoundRow {
  kind: 'found'
  url: string
  /** "#123" */
  number: string
  title: string
  /** Icon for the check state; null when there are no checks or the PR is finished. */
  checks: PullRequestChecksTone | null
  /** "Checks passed", "2 failing" or "Checks running". */
  checksLabel: string | null
  /** Muted word after the title. */
  suffix: 'Draft' | 'Merged' | 'Closed' | null
  tooltip: string
  ariaLabel: string
}

export interface PullRequestCreateRow {
  kind: 'create'
  enabled: boolean
  /** Why the button is dimmed; null when it is enabled. */
  hint: string | null
}

export type PullRequestRow = PullRequestFoundRow | PullRequestCreateRow

function checksText(tone: PullRequestChecksTone, failed: number): { label: string; spoken: string } {
  if (tone === 'passing') return { label: 'Checks passed', spoken: 'checks passed' }
  if (tone === 'failing') {
    const count = Math.max(1, failed)
    return { label: `${count} failing`, spoken: `${count} ${count === 1 ? 'check' : 'checks'} failing` }
  }
  return { label: 'Checks running', spoken: 'checks running' }
}

/**
 * The pull request row under the branch row. Only a found pull request, or a branch
 * with none that could get one, shows a row; every unavailable lookup shows nothing.
 */
export function pullRequestRow(lookup: GitPullRequestLookup | null, status: GitStatusSnapshot | null): PullRequestRow | null {
  if (!lookup) return null
  if (lookup.state === 'none') {
    // Only a branch known not to be the default one can get a pull request; unknown (null) shows nothing.
    if (lookup.isDefaultBranch !== false) return null
    const pushed = status?.tracking === 'tracked' && status.ahead === 0
    return { kind: 'create', enabled: pushed, hint: pushed ? null : 'Push the branch first' }
  }
  if (lookup.state !== 'found') return null

  const { pullRequest } = lookup
  const open = pullRequest.state === 'open'
  const tone = open && pullRequest.checks !== 'none' ? pullRequest.checks : null
  const checks = tone ? checksText(tone, pullRequest.checkCounts.failed) : null
  const suffix = pullRequest.state === 'merged' ? 'Merged' : pullRequest.state === 'closed' ? 'Closed' : pullRequest.isDraft ? 'Draft' : null
  const number = `#${pullRequest.number}`
  const title = pullRequest.title.trim()
  return {
    kind: 'found',
    url: pullRequest.url,
    number,
    title,
    checks: tone,
    checksLabel: checks?.label ?? null,
    suffix,
    tooltip: [title ? `${number} ${title}` : number, checks?.label].filter(Boolean).join('\n'),
    ariaLabel: ['Pull request ' + number, title, suffix?.toLowerCase(), checks?.spoken].filter(Boolean).join(', ')
  }
}

export interface PushButtonModel {
  label: 'Push' | 'Publish'
  /** Unpushed commits for the badge; null for a branch with no upstream. */
  count: number | null
  title: string
}

/** The Push or Publish button, or null when there is nothing to push or nowhere to push it. */
export function pushButtonModel(status: GitStatusSnapshot | null, commitCount: number): PushButtonModel | null {
  if (!status?.isRepo || !status.branch) return null
  if (status.tracking === 'tracked' && status.ahead > 0) {
    const noun = status.ahead === 1 ? '1 commit' : `${status.ahead} commits`
    return { label: 'Push', count: status.ahead, title: status.upstream ? `Push ${noun} to ${status.upstream}` : `Push ${noun}` }
  }
  if (status.tracking === 'none' && commitCount > 0 && status.hasRemote !== false) {
    return { label: 'Publish', count: null, title: 'Push this branch and track it on the remote' }
  }
  return null
}

/** Amending rewrites the latest commit, which a remote already has once it is there. */
export function canAmendCommit(commits: readonly GitCommit[]): boolean {
  const head = commits[0]
  return head !== undefined && !head.onRemote
}

export interface CommitMenuState {
  canAmend: boolean
  /** The Commit button opens the menu when there is something to commit or amend. */
  triggerEnabled: boolean
  triggerTitle: string
  /** Without file changes the only possible commit is an amend, so amend is on and cannot be turned off. */
  forced: boolean
  /** Whether the commit amends: asked for, or the only possible commit. */
  amend: boolean
  amendDisabled: boolean
  /** Why the checkbox is disabled; null when it can be toggled. */
  amendTitle: string | null
  shortHash: string | null
}

export function commitMenuState(commits: readonly GitCommit[], fileCount: number, amendChecked: boolean): CommitMenuState {
  const canAmend = canAmendCommit(commits)
  const hasChanges = fileCount > 0
  const forced = canAmend && !hasChanges
  const amendTitle = !canAmend
    ? commits.length === 0 ? 'No commits yet' : 'The last commit is already pushed'
    : forced ? 'No changes to commit' : null
  const triggerEnabled = hasChanges || canAmend
  return {
    canAmend,
    triggerEnabled,
    triggerTitle: !triggerEnabled ? 'No changes to commit' : hasChanges ? 'Commit all changes' : 'Amend the last commit',
    forced,
    amend: canAmend && (amendChecked || forced),
    amendDisabled: amendTitle !== null,
    amendTitle,
    shortHash: commits[0]?.shortHash ?? null
  }
}

/** Footer hint of the commit menu. */
export function commitHint(amend: boolean, shortHash: string | null, fileCount: number): string {
  const files = fileCount === 1 ? '1 file' : `${fileCount} files`
  if (!amend) return `Stages ${files}`
  const target = shortHash ? `Amends ${shortHash}` : 'Amends the last commit'
  return fileCount > 0 ? `${target} · stages ${files}` : target
}

export function commitButtonLabels(amend: boolean): { commit: string; commitAndPush: string } {
  return amend ? { commit: 'Amend', commitAndPush: 'Amend and push' } : { commit: 'Commit', commitAndPush: 'Commit and push' }
}

export interface CommitDraft {
  message: string
  /** The text filled in from the last commit, so turning amend off can take it back out. */
  prefilled: string | null
}

export const EMPTY_COMMIT_DRAFT: CommitDraft = { message: '', prefilled: null }

/** Fill an empty message with the last commit's message once amend is on. */
export function prefillAmendDraft(draft: CommitDraft, last: string | null): CommitDraft {
  if (!last || draft.message.trim()) return draft
  return { message: last, prefilled: last }
}

/** Drop the prefilled message again when amend goes off, unless it has been edited since. */
export function clearAmendPrefill(draft: CommitDraft): CommitDraft {
  if (draft.prefilled === null) return draft
  return draft.message === draft.prefilled ? EMPTY_COMMIT_DRAFT : { message: draft.message, prefilled: null }
}

/** What a commit message and its amend choice belong to: one branch at one HEAD commit. */
export function commitScopeKey(branch: string | null, commits: readonly GitCommit[]): string {
  return `${branch ?? ''}\u0000${commits[0]?.hash ?? ''}`
}

/** The commit popover's inputs, tagged with the scope they were entered for. */
export interface CommitForm {
  scope: string
  draft: CommitDraft
  amendChecked: boolean
}

export function emptyCommitForm(scope: string): CommitForm {
  return { scope, draft: EMPTY_COMMIT_DRAFT, amendChecked: false }
}

/**
 * The form as it applies to a scope. Text and the amend choice made on another branch
 * or at another HEAD are gone, so they can never be submitted for this one.
 */
export function commitFormFor(form: CommitForm, scope: string): CommitForm {
  return form.scope === scope ? form : emptyCommitForm(scope)
}

/** Why mutating Git controls are disabled while one action runs. */
export const GIT_BUSY_REASON = 'Another Git action is running'

export type GitAction = 'checkout' | 'commit' | 'push' | 'pullRequest' | 'init'

export interface GitActionLock {
  disabled: boolean
  /** Shown as the tooltip; null for the control that is itself running, and when nothing runs. */
  reason: string | null
}

/** Whether a control for `action` may be used while `running` is in progress. */
export function gitActionLock(running: GitAction | null, action: GitAction): GitActionLock {
  if (running === null) return { disabled: false, reason: null }
  return { disabled: true, reason: running === action ? null : GIT_BUSY_REASON }
}

/** Shown in the section when the commit landed and the push after it did not. */
export function pushFailedMessage(error: unknown): string {
  return `Committed, but the push failed: ${gitErrorMessage(error)}`
}

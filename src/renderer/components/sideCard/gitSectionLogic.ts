import type {
  PullRequestCheck,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestPushTarget,
  PullRequestReviewDecision,
  PullRequestScope,
  ThreadPullRequestLink
} from '../../../shared/pullRequests'
import type {
  GitBranchInfo,
  GitCommit,
  GitDiffStats,
  GitInProgress,
  GitPullRequestInfo,
  GitPullRequestLookup,
  GitScope,
  GitStatusSnapshot
} from '../../../shared/types'
import { ipcErrorLine } from '../../lib/errorText'
import type { CommitPhase } from '../../stores/gitStatusStore'

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
  return new Set(status?.changes.filter((change) => change.status === 'untracked').map((change) => change.path)).size
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

/** Files with something to commit; ignored files never are. A file staged and edited again has two changes and counts once. */
export function changedFileCount(status: GitStatusSnapshot | null): number {
  return new Set(status?.changes.filter((change) => change.status !== 'ignored').map((change) => change.path)).size
}

/** Left side of the changes row: how many files differ from the last commit. */
export function changesSummary(status: GitStatusSnapshot | null): string {
  const count = changedFileCount(status)
  if (count === 0) return 'No changes'
  return count === 1 ? '1 file changed' : `${count} files changed`
}

/** Compact age for a date: "now", "5m", "3h", "2d", "6w", "4mo", "2y". Empty when the date is unreadable. */
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

/** Shown in place of the branch picker while the folder is a thread's own worktree. */
export const THREAD_BRANCH_LABEL = 'This thread works on its own branch'

/** Why the branch picker of a thread with its own worktree lists no branches to switch to. */
export const THREAD_BRANCH_SWITCH_REASON = 'This thread has its own branch and worktree, so its branch stays fixed.'

export interface BranchActionState {
  enabled: boolean
  /** Why branch actions are unavailable; null when they are. */
  reason: string | null
}

/** Creating, renaming, deleting and switching are offered everywhere except a thread's own worktree. */
export function branchActionState(workspaceThreadId: string | null): BranchActionState {
  return workspaceThreadId === null ? { enabled: true, reason: null } : { enabled: false, reason: THREAD_BRANCH_LABEL }
}

/** Branches under `mousse/` belong to Mousse, whatever the case. */
export function isManagedBranchName(name: string): boolean {
  return name.toLowerCase().startsWith('mousse/')
}

/** Local branch names the user may act on, in listing order. Remote-tracking and managed branches are left out. */
export function localBranchNames(info: GitBranchInfo | null): string[] {
  return info ? info.branches.filter((name) => !isRemoteBranch(name) && !isManagedBranchName(name)) : []
}

const NAME_FORBIDDEN = /[\s~^:?*[\\\x00-\x1f\x7f]/

/**
 * What is wrong with a branch name as typed, or null when it looks fine or is still empty. Git has the last
 * word; this catches what it would refuse so the form can say so before anything runs. `existing` are the
 * local branches the name must not collide with.
 */
export function branchNameError(raw: string, existing: readonly string[]): string | null {
  const name = raw.trim()
  if (!name) return null
  if (name.startsWith('-')) return 'A branch name cannot start with a dash.'
  if (isManagedBranchName(name)) return 'Branches under mousse/ are managed by Mousse.'
  if (NAME_FORBIDDEN.test(name)) return 'A branch name cannot contain spaces or any of ~ ^ : ? * [ \\'
  if (name === '@' || name.includes('..') || name.includes('@{') || name.includes('//')) return 'A branch name cannot contain .. @{ or //'
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock') || name.split('/').some((part) => part.startsWith('.'))) {
    return 'A branch name cannot start or end with / or ., start a part with ., or end with .lock'
  }
  if (existing.includes(name)) return 'A branch with that name already exists.'
  return null
}

export interface BranchRowMenu {
  /** The row has actions at all: only local branches that Mousse does not manage do. */
  available: boolean
  canRename: boolean
  canDelete: boolean
  /** Why Delete is dimmed; null when it is not. */
  deleteReason: string | null
}

/** Rename and delete for one row of the branch list. The current branch can be renamed, never deleted. */
export function branchRowMenu(name: string, current: string | null): BranchRowMenu {
  if (isRemoteBranch(name) || isManagedBranchName(name)) return { available: false, canRename: false, canDelete: false, deleteReason: null }
  const isCurrent = current !== null && name.toLowerCase() === current.toLowerCase()
  return { available: true, canRename: true, canDelete: !isCurrent, deleteReason: isCurrent ? 'Switch to another branch first' : null }
}

export type DirtySwitchChoiceId = 'carry' | 'stash' | 'cancel'

export interface DirtySwitchChoice {
  id: DirtySwitchChoiceId
  label: string
  /** The choice Enter takes. */
  primary: boolean
}

/** What to ask before switching with uncommitted changes. Nothing to ask for a clean folder. */
export function dirtySwitchChoices(fileCount: number): DirtySwitchChoice[] {
  if (fileCount <= 0) return []
  return [
    { id: 'carry', label: 'Bring changes along', primary: true },
    { id: 'stash', label: 'Stash and switch', primary: false },
    { id: 'cancel', label: 'Cancel', primary: false }
  ]
}

export function dirtySwitchMessage(fileCount: number, branch: string): string {
  const files = fileCount === 1 ? '1 file has' : `${fileCount} files have`
  return `${files} uncommitted changes. Switch to ${branch} with them, or stash them first and bring them back?`
}

/** Shown after a stash-and-switch whose stash could not be applied cleanly on the new branch. */
export const STASH_KEPT_NOTICE = 'Switched; your stash is kept because it conflicts'

/** Git refused to carry the changes to the other branch. */
export function isDirtySwitchRefusal(code: string | null): boolean {
  return code === 'git_checkout_dirty' || code === 'git_checkout_untracked_collision'
}

/** Fixed wording for a failed switch, or null when Git's own message should be shown. */
export function checkoutFailureCopy(code: string | null): string | null {
  switch (code) {
    case 'git_checkout_dirty':
      return 'Your uncommitted changes would be overwritten by that branch. Stash and switch moves them aside and brings them back.'
    case 'git_checkout_untracked_collision':
      return 'An untracked file would be overwritten by that branch. Stash and switch moves it aside and brings it back.'
    case 'git_stash_kept':
      return 'Git could not put your changes back. They are kept in the stash.'
    default:
      return null
  }
}

export interface DeleteBranchPrompt {
  message: string
  confirmLabel: string
}

/** The delete confirmation, and the second one asked when the branch holds commits nothing else has. */
export function deleteBranchPrompt(name: string, stage: 'confirm' | 'unmerged'): DeleteBranchPrompt {
  return stage === 'confirm'
    ? { message: `Delete branch ${name}? Commits that other branches have stay where they are.`, confirmLabel: 'Delete' }
    : { message: `Branch ${name} has commits not on any other branch. Delete anyway?`, confirmLabel: 'Delete anyway' }
}

/** Fixed wording for a failed create, rename or delete, else Git's own message. */
export function branchFailureMessage(error: unknown, name = 'The branch', context: 'create' | 'rename' | 'delete' = 'rename'): string {
  switch (gitErrorCode(error)) {
    case 'git_branch_exists':
      return `A branch named ${name} already exists.`
    case 'git_branch_in_worktree':
      return `${name} is checked out in another worktree.`
    case 'git_branch_current':
      return 'Switch to another branch before deleting this one.'
    case 'git_ref_not_found':
      return `${name} no longer exists.`
    case 'git_branch_protected':
      return 'Branches under mousse/ are managed by Mousse and cannot be changed here.'
    case 'git_checkout_dirty':
    case 'git_checkout_untracked_collision':
      return context === 'create'
        ? 'Your uncommitted changes would be overwritten by that starting point. Create the branch without switching to it.'
        : (checkoutFailureCopy(gitErrorCode(error)) ?? gitErrorMessage(error))
    case 'task_branch_authoritative':
      return THREAD_BRANCH_LABEL
    default:
      return gitErrorMessage(error)
  }
}

/** The daemon's error code for a failed Git action, or null when the failure carries none. */
export function gitErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return null
}

/** The user pressed Cancel on a long action and it stopped. That is an outcome, not a failure to report. */
export function isGitCancelled(error: unknown): boolean {
  return gitErrorCode(error) === 'git_cancelled'
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

/** Shown while the folder or its status is still being read. */
export const GIT_CHECKING_LABEL = 'Checking…'

/**
 * The single muted line shown under the Git heading instead of the section's controls when there is
 * nothing to manage, or null when the full section applies.
 */
export function gitCollapsedLabel(input: GitCollapseInput): string | null {
  if (!input.hasProject) return 'No project'
  if (input.pathPending) return GIT_CHECKING_LABEL
  if (!input.hasPath) return 'No project folder'
  if (!input.loaded) return GIT_CHECKING_LABEL
  if (!input.status) return 'Unavailable'
  if (input.status.missing === true) return 'Folder not found'
  if (!input.status.isRepo) return 'Not a repository'
  return null
}

/**
 * Whether the section offers "Initialize repository": the folder exists and is loaded,
 * and Git says it is not a repository. Never while the folder or its status is unknown.
 */
export function canInitRepository(input: GitCollapseInput): boolean {
  return (
    input.hasProject &&
    !input.pathPending &&
    input.hasPath &&
    input.loaded &&
    input.status !== null &&
    !input.status.isRepo &&
    input.status.missing !== true
  )
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

export type PullRequestReviewTone = 'passing' | 'failing' | 'pending' | 'neutral'

export type PullRequestReviewKey = 'approved' | 'changes_requested' | 'review_required' | 'draft' | 'merged' | 'closed'

export interface PullRequestReviewLine {
  key: PullRequestReviewKey
  label: string
  tone: PullRequestReviewTone
}

/**
 * Where a pull request stands with its reviewers. A finished pull request is merged or closed whatever
 * was decided; otherwise the host's decision speaks, and a draft with none is a draft. Null for an open
 * pull request nobody has to review.
 */
export function pullRequestReviewState(
  pullRequest: Pick<GitPullRequestInfo, 'state' | 'isDraft'>,
  decision: PullRequestReviewDecision | null
): PullRequestReviewLine | null {
  if (pullRequest.state === 'merged') return { key: 'merged', label: 'Merged', tone: 'neutral' }
  if (pullRequest.state === 'closed') return { key: 'closed', label: 'Closed', tone: 'neutral' }
  if (decision === 'approved') return { key: 'approved', label: 'Approved', tone: 'passing' }
  if (decision === 'changes_requested') return { key: 'changes_requested', label: 'Changes requested', tone: 'failing' }
  if (decision === 'review_required') return { key: 'review_required', label: 'Review required', tone: 'pending' }
  if (pullRequest.isDraft) return { key: 'draft', label: 'Draft', tone: 'neutral' }
  return null
}

export type PullRequestCheckRowTone = 'failing' | 'waiting' | 'pending' | 'passing' | 'skipped'

export interface PullRequestCheckRow {
  name: string
  /** The workflow a check run belongs to, when the host names one. */
  workflow: string | null
  tone: PullRequestCheckRowTone
  /** "Failed", "Waiting for approval", "Running", "Passed" or "Skipped". */
  label: string
  /** Where the host shows this check; only web links. */
  url: string | null
}

const CHECK_ROW_ORDER: PullRequestCheckRowTone[] = ['failing', 'waiting', 'pending', 'passing', 'skipped']
const CHECK_ROW_LABELS: Record<PullRequestCheckRowTone, string> = {
  failing: 'Failed',
  waiting: 'Waiting for approval',
  pending: 'Running',
  passing: 'Passed',
  skipped: 'Skipped'
}

function webUrl(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null
}

/** Each check with its state and link, what needs attention first. A check with no state yet counts as running. */
export function pullRequestCheckRows(checks: readonly PullRequestCheck[]): PullRequestCheckRow[] {
  return checks
    .map((check, index) => {
      const tone: PullRequestCheckRowTone = check.state === 'none' ? 'pending' : check.state
      return {
        order: CHECK_ROW_ORDER.indexOf(tone),
        index,
        row: { name: check.name, workflow: check.workflowName ?? null, tone, label: CHECK_ROW_LABELS[tone], url: webUrl(check.url) }
      }
    })
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ row }) => row)
}

/** Shown on a linked pull request of a thread that works in its own worktree. */
export const LINKED_WORKTREE_HINT = 'Merge back targets the primary checkout, not the PR'

/** What the Merge button of an open pull request does: enabled (and then the one primary action) or dimmed with why. */
export interface PullRequestMergeAction {
  enabled: boolean
  /** Why it is dimmed; null when it is enabled. */
  reason: string | null
  /** The head that was shown: a merge is refused if more was pushed since. Null when it is not known. */
  headSha: string | null
}

export interface PullRequestFoundRow {
  kind: 'found'
  url: string
  /** "#123" */
  number: string
  /** The pull request's number, for merging or closing it. */
  value: number
  /** The branch it merges into, as named in the merge prompt. */
  base: string
  /** Merge and Close for an open pull request; null for a merged or closed one. */
  merge: PullRequestMergeAction | null
  title: string
  /** Icon for the check state; null when there are no checks or the PR is finished. */
  checks: PullRequestChecksTone | null
  /** "Checks passed", "2 failing", "Checks running" or "Waiting for approval". */
  checksLabel: string | null
  /** What colours and shapes the pull request icon. */
  state: 'open' | 'draft' | 'merged' | 'closed'
  /** Muted word after the number. */
  suffix: 'Draft' | 'Merged' | 'Closed' | null
  /** The reviewers' verdict of an open pull request, for the tooltip; null when the host has none (a draft, merged or closed pull request has its suffix instead). */
  review: { label: string; tone: PullRequestReviewTone } | null
  /** The thread is linked to this pull request, which it did not only find by its branch. */
  linked: boolean
  /** A short note about what the pull request means for this thread; null when there is none. */
  hint: string | null
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

function checksText(tone: PullRequestChecksTone, counts: GitPullRequestInfo['checkCounts']): { label: string; spoken: string } {
  if (tone === 'passing') return { label: 'Checks passed', spoken: 'checks passed' }
  if (tone === 'failing') {
    const count = Math.max(1, counts.failed)
    return { label: `${count} failing`, spoken: `${count} ${count === 1 ? 'check' : 'checks'} failing` }
  }
  // Runs held for a maintainer's approval have not started; when they are all that is left, say so.
  if (counts.waiting > 0 && counts.waiting >= counts.pending) return { label: 'Waiting for approval', spoken: 'waiting for approval' }
  return { label: 'Checks running', spoken: 'checks running' }
}

/**
 * The pull request row under the branch row. Only a found pull request, or a branch
 * with none that could get one, shows a row; every unavailable lookup shows nothing.
 * `detail` (the same pull request, read in full) adds the reviewers' verdict; `link` and `worktreeThread` say whether the thread is linked to it and works in its own worktree.
 */
export function pullRequestRow(
  lookup: GitPullRequestLookup | null,
  status: GitStatusSnapshot | null,
  detail: PullRequestDetail | null = null,
  link: Pick<ThreadPullRequestLink, 'number'> | null = null,
  worktreeThread = false
): PullRequestRow | null {
  if (!lookup) return null
  if (lookup.state === 'none') {
    // Only a branch known not to be the default one can get a pull request; unknown (null) shows nothing.
    if (lookup.isDefaultBranch !== false) return null
    const pushed = status?.tracking === 'tracked' && status.ahead === 0
    return { kind: 'create', enabled: pushed, hint: pushed ? null : 'Push the branch first' }
  }
  if (lookup.state !== 'found') return null

  return foundRow(lookup.pullRequest, detail, link, worktreeThread)
}

function foundRow(
  pullRequest: GitPullRequestInfo,
  detail: PullRequestDetail | null,
  link: Pick<ThreadPullRequestLink, 'number'> | null,
  worktreeThread: boolean
): PullRequestFoundRow {
  const open = pullRequest.state === 'open'
  const tone = open && pullRequest.checks !== 'none' ? pullRequest.checks : null
  const checks = tone ? checksText(tone, pullRequest.checkCounts) : null
  const suffix = pullRequest.state === 'merged' ? 'Merged' : pullRequest.state === 'closed' ? 'Closed' : pullRequest.isDraft ? 'Draft' : null
  const number = `#${pullRequest.number}`
  const title = pullRequest.title.trim()
  // A detail of another pull request (the branch moved on to a new one) says nothing about this one.
  const own = open && detail !== null && detail.number === pullRequest.number ? detail : null
  const verdict = own ? pullRequestReviewState(pullRequest, own.reviewDecision) : null
  const review = verdict && (verdict.key === 'approved' || verdict.key === 'changes_requested' || verdict.key === 'review_required')
    ? { label: verdict.label, tone: verdict.tone }
    : null
  const linked = link?.number === pullRequest.number
  return {
    kind: 'found',
    url: pullRequest.url,
    number,
    value: pullRequest.number,
    base: own?.baseRefName || pullRequest.baseRefName || 'the base branch',
    merge: open ? mergeAction(pullRequest, own) : null,
    title,
    checks: tone,
    checksLabel: checks?.label ?? null,
    state: pullRequest.state === 'open' && pullRequest.isDraft ? 'draft' : pullRequest.state,
    suffix,
    review,
    linked,
    hint: linked && worktreeThread ? LINKED_WORKTREE_HINT : null,
    tooltip: [title ? `${number} ${title}` : number, review?.label, checks?.label].filter(Boolean).join('\n'),
    ariaLabel: ['Pull request ' + number, title, suffix?.toLowerCase(), review?.label.toLowerCase(), checks?.spoken].filter(Boolean).join(', ')
  }
}

/**
 * Whether an open pull request can be merged from the side card: its checks pass (or it has none) and GitHub says it would
 * merge cleanly. Anything else dims Merge with the reason. `detail` is the same pull request read in full; without it
 * the host's answer is not known yet.
 */
export function mergeAction(pullRequest: GitPullRequestInfo, detail: PullRequestDetail | null): PullRequestMergeAction {
  const headSha = detail?.headSha || null
  const dimmed = (reason: string): PullRequestMergeAction => ({ enabled: false, reason, headSha })
  const base = detail?.baseRefName || pullRequest.baseRefName || 'the base branch'
  if (pullRequest.isDraft || detail?.mergeState === 'draft') return dimmed('A draft can’t be merged until it is ready for review')
  if (pullRequest.checks === 'failing') {
    const count = Math.max(1, pullRequest.checkCounts.failed)
    return dimmed(`${count} ${count === 1 ? 'check is' : 'checks are'} failing`)
  }
  if (pullRequest.checks === 'pending') {
    const counts = pullRequest.checkCounts
    return dimmed(counts.waiting > 0 && counts.waiting >= counts.pending ? 'Checks are waiting for approval' : 'Checks are still running')
  }
  switch (detail?.mergeState) {
    case 'clean':
      return { enabled: true, reason: null, headSha }
    case 'conflicting':
      return dimmed(`Has conflicts with ${base}`)
    case 'behind':
      return dimmed(`Behind ${base}; update the branch first`)
    case 'unstable':
      return dimmed('Some checks are not passing')
    case 'blocked':
      if (detail.reviewDecision === 'changes_requested') return dimmed('Changes were requested')
      if (detail.reviewDecision === 'review_required') return dimmed('Needs an approving review')
      return dimmed(`Blocked by the rules of ${base}`)
    default:
      return dimmed('GitHub is still working out whether it can be merged')
  }
}

/**
 * Every pull request the section lists: the lookup's own (as `pullRequestRow` builds it) and the branch's other ones.
 * Only the lookup's own has a full read, so only it can say whether it would merge.
 */
export function pullRequestRows(
  lookup: GitPullRequestLookup | null,
  status: GitStatusSnapshot | null,
  detail: PullRequestDetail | null = null,
  link: Pick<ThreadPullRequestLink, 'number'> | null = null,
  worktreeThread = false
): PullRequestFoundRow[] {
  const row = pullRequestRow(lookup, status, detail, link, worktreeThread)
  if (row?.kind !== 'found' || lookup?.state !== 'found') return []
  return [row, ...(lookup.others ?? []).map((other) => foundRow(other, null, link, worktreeThread))]
}

const MERGE_METHOD_WORDS: Record<PullRequestMergeMethod, string> = {
  merge: 'with a merge commit',
  squash: 'squashed into one commit',
  rebase: 'rebased onto the base branch'
}

/** Said once a merge went through: "Merged #12 squashed into one commit." */
export function mergedNotice(number: number, method: PullRequestMergeMethod | undefined): string {
  return method ? `Merged #${number} ${MERGE_METHOD_WORDS[method]}.` : `Merged #${number}.`
}

/** Pull requests shown before "Show N more". */
export const PULL_REQUESTS_SHOWN = 1

/**
 * The thread's pull requests as the section lists them: the newest first and shown, the rest counted behind
 * "Show N more" until expanded. Pull requests are newest when their number is highest.
 */
export function pullRequestList<T extends Pick<PullRequestFoundRow, 'number'>>(rows: readonly T[], expanded: boolean): { shown: T[]; hidden: number } {
  const ordered = [...rows].sort((a, b) => Number(b.number.slice(1)) - Number(a.number.slice(1)))
  if (expanded || ordered.length <= PULL_REQUESTS_SHOWN) return { shown: ordered, hidden: 0 }
  return { shown: ordered.slice(0, PULL_REQUESTS_SHOWN), hidden: ordered.length - PULL_REQUESTS_SHOWN }
}

/**
 * What Create PR captures when it is clicked: the folder (the thread's own, else the project's), the thread
 * whose conversation drafts the description and receives the link, the folder's path and the branch. Null
 * without a branch. A thread on the project's checkout is the origin as much as one with a worktree.
 */
export function pullRequestScope(input: {
  path: string
  branch: string | null
  projectId: string | null
  ownThreadId: string | null
}): PullRequestScope | null {
  if (!input.branch) return null
  return {
    ...(input.ownThreadId ? { threadId: input.ownThreadId } : input.projectId ? { projectId: input.projectId } : {}),
    originThreadId: input.ownThreadId,
    path: input.path,
    branch: input.branch
  }
}

/**
 * The thread a pull request read is made as. The daemon runs it in that thread's worktree, so only a thread
 * whose worktree is the folder the card shows asks as the thread; a thread whose workspace is not ready is
 * shown the project's folder, and asks about the project, as does one working on the project's checkout.
 */
export function pullRequestReadThreadId(ownThreadId: string | null, workspaceThreadId: string | null): string | null {
  return ownThreadId !== null && workspaceThreadId === ownThreadId ? ownThreadId : null
}

export interface PushButtonModel {
  label: 'Push' | 'Publish'
  /** Unpushed commits for the badge; null for a branch with no upstream. */
  count: number | null
  title: string
  /** Why the button is disabled right now; absent when it can be used. */
  disabledReason?: string
  /** Why Push does not go to the pull request's branch ("push by hand"); absent when it does or there is no pull request. */
  note?: string
}

/** Whether the branch has somewhere to push to: an upstream, or a remote to publish to. */
export function canPush(status: GitStatusSnapshot | null): boolean {
  if (!status?.isRepo || !status.branch) return false
  return status.tracking === 'tracked' || status.hasRemote !== false
}

/** Shown where a thread's own worktree rules out an action, for example amend. */
export const THREAD_CHECKPOINTED_REASON = "This thread's branch is checkpointed"

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

const IN_PROGRESS_NAMES: Record<GitInProgress, string> = {
  merge: 'merge',
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert'
}

/** Files by what Git says about them; a file staged and edited again counts on both sides but once in `changedCount`. */
export interface GitChangeCounts {
  stagedCount: number
  unstagedCount: number
  conflictedCount: number
  changedCount: number
  /** New files Git does not track yet; once staged they count as staged. */
  untrackedCount: number
  /** Files with changes on both sides: staged, then edited again. Counted in `stagedCount` and in `unstagedCount`. */
  partlyStagedCount: number
}

export function gitChangeCounts(status: GitStatusSnapshot | null): GitChangeCounts {
  const staged = new Set<string>()
  const unstaged = new Set<string>()
  const conflicted = new Set<string>()
  const changed = new Set<string>()
  const untracked = new Set<string>()
  for (const change of status?.changes ?? []) {
    if (change.status === 'ignored') continue
    changed.add(change.path)
    if (change.status === 'conflicted') conflicted.add(change.path)
    else if (change.staged) staged.add(change.path)
    else unstaged.add(change.path)
    if (change.status === 'untracked') untracked.add(change.path)
  }
  return {
    stagedCount: staged.size,
    unstagedCount: unstaged.size,
    conflictedCount: conflicted.size,
    changedCount: changed.size,
    untrackedCount: untracked.size,
    partlyStagedCount: [...staged].filter((path) => unstaged.has(path)).length
  }
}

/** What a commit would include, which decides the hint under the message. */
export type CommitMode = 'staged' | 'all' | 'thread' | 'conflicted' | 'finish-merge'

export interface CommitAvailability extends GitChangeCounts {
  mode: CommitMode
  /** Why no commit can be made right now; null when one can. */
  blockedReason: string | null
}

export interface GitActionAvailability {
  push: { enabled: boolean; reason: string | null }
  /** The commit popover offers "Commit and push": there is somewhere to push, and the branch is not behind. */
  offerCommitAndPush: boolean
  /**
   * The commit popover also offers "Commit, push and open PR": there are changes to commit, the branch can be
   * pushed (not behind, diverged or conflicted) and has no pull request, and is known not to be the default branch.
   */
  offerCommitPushAndOpenPr: boolean
  amend: { enabled: boolean; reason: string | null }
  commit: CommitAvailability
}

/**
 * Which side card actions can be used, and why not, from the state of the branch alone.
 * `scope.workspaceThreadId` is set in a thread's own worktree, where every commit takes all changes and amend is refused.
 */
export function gitActionAvailability(
  status: GitStatusSnapshot | null,
  pullRequest: GitPullRequestLookup | null,
  commitCount: number,
  scope: Pick<GitScope, 'workspaceThreadId'>
): GitActionAvailability {
  const counts = gitChangeCounts(status)
  const inThread = scope.workspaceThreadId !== null
  const inProgress = status?.inProgress ?? null
  const conflictedReason = counts.conflictedCount > 0 ? `Resolve ${plural(counts.conflictedCount, 'conflicted file')} first` : null
  const diverged = status?.tracking === 'tracked' && status.ahead > 0 && status.behind > 0
  const behind = status?.tracking === 'tracked' && status.behind > 0

  let pushReason: string | null = null
  if (!status?.isRepo || !status.branch) pushReason = 'No branch to push'
  else if (conflictedReason) pushReason = conflictedReason
  else if (inProgress) pushReason = `Finish or abort the ${IN_PROGRESS_NAMES[inProgress]} first`
  else if (diverged) pushReason = 'Branch has diverged; pull with merge or rebase first'
  else if (behind) pushReason = 'Branch is behind; pull first'
  else if (status.tracking === 'tracked' && status.ahead === 0) pushReason = 'Nothing to push'
  else if (status.tracking !== 'tracked' && status.hasRemote === false) pushReason = 'No remote to push to'
  else if (status.tracking !== 'tracked' && commitCount === 0) pushReason = 'Nothing to push'

  const offerCommitAndPush = canPush(status) && !behind
  const lookupNone = pullRequest?.state === 'none' && pullRequest.isDefaultBranch === false
  const amendReason = inThread ? THREAD_CHECKPOINTED_REASON : commitCount === 0 ? 'No commits yet' : null

  let mode: CommitMode = 'all'
  if (conflictedReason) mode = 'conflicted'
  else if (inThread) mode = 'thread'
  else if (inProgress === 'merge') mode = 'finish-merge'
  else if (counts.stagedCount > 0) mode = 'staged'

  return {
    push: { enabled: pushReason === null, reason: pushReason },
    offerCommitAndPush,
    offerCommitPushAndOpenPr: offerCommitAndPush && counts.changedCount > 0 && counts.conflictedCount === 0 && lookupNone,
    amend: { enabled: amendReason === null, reason: amendReason },
    commit: { ...counts, mode, blockedReason: conflictedReason }
  }
}

const PROJECT_SCOPE = { workspaceThreadId: null } as const

/** The Push or Publish button, or null when there is nothing to push or nowhere to push it. */
export function pushButtonModel(
  status: GitStatusSnapshot | null,
  commitCount: number,
  scope: Pick<GitScope, 'workspaceThreadId'> = PROJECT_SCOPE,
  /** Where Push goes for a thread linked to a pull request; null when it keeps its usual target. */
  pullRequestTarget: PullRequestPushTarget | null = null
): PushButtonModel | null {
  if (!status || !canPush(status)) return null
  const { push } = gitActionAvailability(status, null, commitCount, scope)
  const disabled = push.enabled || push.reason === null ? {} : { disabledReason: push.reason }
  const target = pullRequestTarget?.remote && pullRequestTarget.branch ? `${pullRequestTarget.remote}/${pullRequestTarget.branch}` : null
  const note = pullRequestTarget?.reason ? { note: pullRequestTarget.reason } : {}
  if (status.tracking === 'tracked' && status.ahead > 0) {
    const noun = status.ahead === 1 ? '1 commit' : `${status.ahead} commits`
    const destination = target ?? status.upstream
    return { label: 'Push', count: status.ahead, title: destination ? `Push ${noun} to ${destination}` : `Push ${noun}`, ...note, ...disabled }
  }
  if (status.tracking === 'none' && commitCount > 0) {
    return {
      label: 'Publish',
      count: null,
      title: target ? `Push this branch to ${target}, the pull request's branch` : 'Push this branch and track it on the remote',
      ...note,
      ...disabled
    }
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
  /** Without file changes the only possible commit is an amend, so amend is on and cannot be turned off. */
  forced: boolean
  /** Whether the commit amends: asked for, or the only possible commit. */
  amend: boolean
  amendDisabled: boolean
  /** Why the checkbox is disabled; null when it can be toggled. */
  amendTitle: string | null
  shortHash: string | null
}

/**
 * `checkpointed` is a thread's own worktree: its history is recorded commit by commit, so the daemon
 * refuses an amend there and the switch says why instead of failing later.
 */
export function commitMenuState(commits: readonly GitCommit[], fileCount: number, amendChecked: boolean, checkpointed = false): CommitMenuState {
  const canAmend = !checkpointed && canAmendCommit(commits)
  const hasChanges = fileCount > 0
  const forced = canAmend && !hasChanges
  const amendTitle = !canAmend
    ? checkpointed ? THREAD_CHECKPOINTED_REASON : commits.length === 0 ? 'No commits yet' : 'The last commit is already pushed'
    : forced ? 'No changes to commit' : null
  const triggerEnabled = hasChanges || canAmend
  return {
    canAmend,
    triggerEnabled,
    forced,
    amend: canAmend && (amendChecked || forced),
    amendDisabled: amendTitle !== null,
    amendTitle,
    shortHash: commits[0]?.shortHash ?? null
  }
}

/** The Commit button's own words: what a commit would take, counted, and its tooltip saying it in full. */
export interface CommitTrigger {
  label: string
  title: string
}

/**
 * Names on the Commit button exactly what it commits: "Commit all (N)" when every change goes in (untracked files
 * included), "Commit staged (M of N)" when only the staged files do. With no changes the only commit is an amend, so
 * the button says Amend; with nothing to amend either it stays Commit, disabled.
 */
export function commitTrigger(menu: Pick<CommitMenuState, 'triggerEnabled' | 'forced' | 'shortHash'>, commit: CommitAvailability): CommitTrigger {
  if (!menu.triggerEnabled) return { label: 'Commit', title: 'No changes to commit' }
  if (menu.forced) {
    return { label: 'Amend', title: `No changes to commit. Amend ${menu.shortHash ?? 'the last commit'} to change its message` }
  }
  const total = commit.changedCount
  const untracked = commit.untrackedCount > 0 ? `, including ${plural(commit.untrackedCount, 'untracked file')}` : ''
  switch (commit.mode) {
    case 'conflicted':
      return { label: 'Commit', title: commit.blockedReason ?? 'Resolve the conflicted files first' }
    case 'finish-merge':
      // With nothing staged the commit stages everything first (`add -A`), as a plain commit does.
      if (commit.stagedCount > 0) return { label: `Commit merge (${commit.stagedCount} of ${total} staged)`, title: `Finish the merge with only the ${plural(commit.stagedCount, 'staged file')}${unstagedStaysOut(commit)}` }
      if (total > 0) return { label: `Commit merge (all ${total})`, title: `Finish the merge, staging and committing all ${plural(total, 'changed file')}${untracked}` }
      return { label: 'Commit merge', title: 'Finish the merge' }
    case 'staged':
      return { label: `Commit staged (${commit.stagedCount} of ${total})`, title: `Commit only the ${plural(commit.stagedCount, 'staged file')}${unstagedStaysOut(commit)}` }
    case 'thread':
      return { label: `Commit all (${total})`, title: `Commit all ${plural(total, 'changed file')} on this thread's branch${untracked}` }
    default:
      return { label: `Commit all (${total})`, title: `Stage and commit all ${plural(total, 'changed file')}${untracked}` }
  }
}

/**
 * What a staged-only commit leaves out, counted from the unstaged side: a file staged and then edited again goes in
 * with its staged part only, so its unstaged part is named as staying out. Nothing when everything is staged.
 */
function unstagedStaysOut(commit: Pick<CommitAvailability, 'unstagedCount' | 'partlyStagedCount'>): string {
  const { unstagedCount: unstaged, partlyStagedCount: partly } = commit
  if (unstaged === 0) return ''
  if (partly === unstaged) return `; the unstaged part of ${partly === 1 ? 'the partly staged file' : `the ${partly} partly staged files`} stays out`
  const including = partly > 0 ? `, including the unstaged part of ${plural(partly, 'partly staged file')}` : ''
  return `; unstaged changes in ${plural(unstaged, 'file')} stay out${including}`
}

/** A merge method in GitHub's own words, for the button that confirms it. */
const MERGE_METHOD_ACTIONS: Record<PullRequestMergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge'
}

/**
 * The Merge confirmation, naming the method the merge will use: the merge is sent with that method and uses exactly
 * it. `method` is undefined while it is read and null when it could not be (or the computer is too old to say); the
 * merge then goes without one, and the computer that merges uses the repository's default, else squash.
 */
export function mergeConfirmation(number: string, base: string, method: PullRequestMergeMethod | null | undefined): { text: string; action: string } {
  const into = base ? ` into ${base}` : ''
  if (method === undefined) return { text: `Merge ${number}${into}?`, action: 'Merge' }
  if (method === null) {
    return { text: `Merge ${number}${into}? The merge method couldn't be read, so the repository's default is used, else squash.`, action: 'Merge' }
  }
  const on = base ? ` on ${base}` : ''
  const onto = base ? ` onto ${base}` : ''
  const text = {
    merge: `Merge ${number}${into} with a merge commit?`,
    squash: `Squash ${number} into one commit${on}?`,
    rebase: `Rebase the commits of ${number}${onto}?`
  }[method]
  return { text, action: MERGE_METHOD_ACTIONS[method] }
}

/**
 * Footer hint of the commit menu. With `commit` it says what the commit includes: only the staged
 * files when anything is staged, everything otherwise, all changes in a thread's worktree.
 * Without it the hint assumes everything is staged first.
 */
export function commitHint(amend: boolean, shortHash: string | null, fileCount: number, commit?: CommitAvailability): string {
  if (commit?.blockedReason) return commit.blockedReason
  const files = plural(fileCount, 'file')
  if (!amend) {
    if (commit?.mode === 'thread') return "Commits all changes on this thread's branch"
    if (commit?.mode === 'finish-merge') return 'Finishes the merge'
    if (commit?.mode === 'staged') return `Commits ${plural(commit.stagedCount, 'staged file')}`
    return `Stages ${files}`
  }
  const target = shortHash ? `Amends ${shortHash}` : 'Amends the last commit'
  if (fileCount === 0) return target
  if (commit && commit.mode !== 'all' && commit.stagedCount > 0) return `${target} · adds ${plural(commit.stagedCount, 'staged file')}`
  return `${target} · stages ${files}`
}

export function commitButtonLabels(amend: boolean): { commit: string; commitAndPush: string; commitPushAndOpenPr: string } {
  return amend
    ? { commit: 'Amend', commitAndPush: 'Amend and push', commitPushAndOpenPr: 'Amend, push and open PR' }
    : { commit: 'Commit', commitAndPush: 'Commit and push', commitPushAndOpenPr: 'Commit, push and open PR' }
}

/** What a commit button does: only commit, also push, or also push and open a pull request. */
export type CommitFlow = 'commit' | 'push' | 'push-pr'

export interface CommitFlowButton {
  flow: CommitFlow
  label: string
  /** The plain commit is the primary button; the ones that go on to push are quiet. */
  quiet: boolean
}

/**
 * The buttons of the commit popover, in the order shown. "Commit and push" needs somewhere to push and a branch that
 * is not behind; "Commit, push and open PR" needs `openPullRequest`, which `gitActionAvailability` decides.
 */
export function commitFlowButtons(input: { pushable: boolean; openPullRequest: boolean; amend: boolean }): CommitFlowButton[] {
  const labels = commitButtonLabels(input.amend)
  return [
    ...(input.pushable && input.openPullRequest ? [{ flow: 'push-pr' as const, label: labels.commitPushAndOpenPr, quiet: true }] : []),
    ...(input.pushable ? [{ flow: 'push' as const, label: labels.commitAndPush, quiet: true }] : []),
    { flow: 'commit', label: labels.commit, quiet: false }
  ]
}

export function commitPhaseLabel(phase: CommitPhase): string {
  return phase === 'committing' ? 'Committing…' : phase === 'pushing' ? 'Pushing…' : 'Opening PR…'
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

/** What a commit message and its amend choice belong to: a branch and the HEAD commit on it. */
export interface CommitScope {
  branch: string
  head: string
}

export function commitScope(branch: string | null, commits: readonly GitCommit[]): CommitScope {
  return { branch: branch ?? '', head: commits[0]?.hash ?? '' }
}

/** The commit popover's inputs, tagged with the branch and HEAD they were entered for. */
export interface CommitForm extends CommitScope {
  draft: CommitDraft
  amendChecked: boolean
  /** Amend was switched on because it was the only possible commit, not by the user. */
  amendForced: boolean
}

export function emptyCommitForm(scope: CommitScope): CommitForm {
  return { ...scope, draft: EMPTY_COMMIT_DRAFT, amendChecked: false, amendForced: false }
}

/**
 * The form as it applies to a scope. Another branch drops everything, so text typed there
 * can never be submitted here. A new HEAD on the same branch drops the amend choice and an
 * unedited prefill, which belonged to the old HEAD, but keeps typed text.
 */
export function commitFormFor(form: CommitForm, scope: CommitScope): CommitForm {
  if (form.branch !== scope.branch) return emptyCommitForm(scope)
  if (form.head === scope.head) return form
  return { ...emptyCommitForm(scope), draft: clearAmendPrefill(form.draft) }
}

/** The popover closed: an amend that was only forced goes back off, one the user chose stays. */
export function releaseForcedAmend(form: CommitForm): CommitForm {
  return form.amendForced ? { ...form, amendChecked: false, amendForced: false } : form
}

/** Amend is the only possible commit, so switch it on, remembering the user did not choose it. */
export function forceAmend(form: CommitForm): CommitForm {
  return form.amendChecked ? form : { ...form, amendChecked: true, amendForced: true }
}

/** The user's own amend choice. */
export function chooseAmend(form: CommitForm, checked: boolean): CommitForm {
  return { ...form, amendChecked: checked, amendForced: false }
}

/** Why mutating Git controls are disabled while one action runs. */
export const GIT_BUSY_REASON = 'Another Git action is running'

export type GitAction = 'checkout' | 'branch' | 'commit' | 'push' | 'pullRequest' | 'merge' | 'close' | 'init'

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

/** Shown when the commit and push landed and the pull request step did not start; the branch is pushed, so Create PR can be used. */
export function openPullRequestFailedMessage(error: unknown): string {
  return `Committed and pushed, but no pull request was opened: ${gitErrorMessage(error)}`
}

/** Said when "Commit, push and open PR" finds the branch already has a pull request, which the row below shows instead of a second form. */
export function existingPullRequestNotice(pullRequest: { number: number; state: 'open' | 'closed' | 'merged' }): string {
  const state = pullRequest.state === 'open' ? 'already open' : pullRequest.state
  return `Pushed. #${pullRequest.number} is ${state} for this branch.`
}

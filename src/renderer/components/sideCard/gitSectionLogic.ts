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
  GitPullStrategy,
  GitScope,
  GitStatusSnapshot,
  GitUpstreamCheck
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

/** What the Push, Commit and Create PR row offers for one folder and branch, wherever it is shown. */
export interface GitActionRowModel {
  branch: string | null
  /** What Create PR, or "Commit, push and open PR", opens the form for; null without a branch. */
  createScope: PullRequestScope | null
  /** The Create PR button, when the branch could get a pull request; null when it has one or never can. */
  createRow: PullRequestCreateRow | null
  pushButton: PushButtonModel | null
  availability: GitActionAvailability
  fileCount: number
}

export function gitActionRowModel(input: {
  path: string
  scope: Pick<GitScope, 'workspaceThreadId'>
  projectId: string | null
  ownThreadId: string | null
  status: GitStatusSnapshot | null
  commitCount: number
  pullRequest: GitPullRequestLookup | null
  pullRequestPushTarget?: PullRequestPushTarget | null
}): GitActionRowModel {
  const branch = input.status?.branch ?? null
  const row = pullRequestRow(input.pullRequest, input.status)
  return {
    branch,
    createScope: pullRequestScope({ path: input.path, branch, projectId: input.projectId, ownThreadId: input.ownThreadId }),
    createRow: row?.kind === 'create' ? row : null,
    pushButton: pushButtonModel(input.status, input.commitCount, input.scope, input.pullRequestPushTarget ?? null),
    availability: gitActionAvailability(input.status, input.pullRequest, input.commitCount, input.scope),
    fileCount: changedFileCount(input.status)
  }
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
export const THREAD_WORKTREE_REASON = "Not available in this thread's worktree"

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
  const amendReason = inThread ? THREAD_WORKTREE_REASON : commitCount === 0 ? 'No commits yet' : null

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
/**
 * The pull request a merge or close question was asked about is no longer the one shown: another number, a new head,
 * or it stopped being open. The question then needs a fresh look before it can run.
 */
export function pullRequestChangedSince(asked: PullRequestFoundRow, now: PullRequestFoundRow): boolean {
  if (asked.value !== now.value || asked.url !== now.url) return true
  if ((asked.merge === null) !== (now.merge === null)) return true
  return (asked.merge?.headSha ?? null) !== (now.merge?.headSha ?? null)
}

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

/** What a commit button does: only commit, also push, or also push and open a pull request. */
export type CommitFlow = 'commit' | 'push' | 'push-pr'

export function commitPhaseLabel(phase: CommitPhase): string {
  return phase === 'committing' ? 'Committing…' : phase === 'pushing' ? 'Pushing…' : 'Opening PR…'
}

/** Why mutating Git controls are disabled while one action runs. */
export const GIT_BUSY_REASON = 'Another Git action is running'

/** `files` is a stage, unstage or discard and `sync` a fetch, pull or abort, both run from the Git panel. */
export type GitAction = 'checkout' | 'branch' | 'commit' | 'push' | 'pullRequest' | 'merge' | 'close' | 'init' | 'files' | 'sync'

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

/**
 * The branch against its upstream as the side card counts it: the last quiet look at the remote when it was made
 * on this branch at this HEAD, else what the tracking ref says. A look made before a commit, pull or switch says
 * nothing about now, so it is set aside until the next one.
 */
export interface UpstreamFigures {
  ahead: number
  behind: number
  /** `checked`: the counts are the remote's as of `checkedAt`; `unreachable`: the remote did not answer; null: no look applies. */
  look: 'checked' | 'unreachable' | null
  unreachable: 'signed-out' | 'offline' | 'gone' | null
  checkedAt: number | null
}

export function upstreamFigures(status: GitStatusSnapshot | null, head: string | null, check: GitUpstreamCheck | null): UpstreamFigures {
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  if (!check || check.state === 'none' || status?.tracking !== 'tracked' || check.branch !== status.branch || head === null || check.head !== head) {
    return { ahead, behind, look: null, unreachable: null, checkedAt: null }
  }
  if (check.state === 'unreachable') return { ahead, behind, look: 'unreachable', unreachable: check.reason, checkedAt: check.checkedAt }
  return { ahead: check.ahead, behind: check.behind, look: 'checked', unreachable: null, checkedAt: check.checkedAt }
}

/** The stopped merge or rebase Abort gives up; other stopped operations have no Abort here. */
export type AbortableKind = 'merge' | 'rebase'

/** The one thing the side card offers to do next, most urgent first. Commit is not one: it lives on the changes row. */
export type NextStep =
  | { kind: 'resolve'; label: string; title: string; abort: AbortableKind | null }
  | { kind: 'finish'; label: string; title: string; abort: AbortableKind | null }
  | { kind: 'pull'; label: string; title: string; strategies: GitPullStrategy[] }
  | { kind: 'push'; label: string; title: string }
  | { kind: 'pull-request'; label: string; title: string }

const abortable = (what: GitInProgress | null | undefined): AbortableKind | null => (what === 'merge' || what === 'rebase' ? what : null)

/**
 * The next step for the side card, in the order a person must act: conflicts, then a stopped merge or rebase, then
 * commits on the remote to pull, then commits to push or a branch to publish, then a pull request to open. A
 * thread's own worktree never pulls (only the thread moves its branch). Null when there is nothing to do.
 */
export function nextStep(input: {
  status: GitStatusSnapshot | null
  figures: UpstreamFigures
  scope: Pick<GitScope, 'workspaceThreadId'>
  commitCount: number
  pullRequest: GitPullRequestLookup | null
}): NextStep | null {
  const { status, figures, scope } = input
  if (!status?.isRepo) return null
  const counts = gitChangeCounts(status)
  const inProgress = status.inProgress ?? null
  if (counts.conflictedCount > 0) {
    return { kind: 'resolve', label: `Resolve ${plural(counts.conflictedCount, 'conflict')}`, title: 'Open Changes to resolve them', abort: abortable(inProgress) }
  }
  if (inProgress) {
    return { kind: 'finish', label: `Finish the ${IN_PROGRESS_NAMES[inProgress]}`, title: 'Open Changes to finish it', abort: abortable(inProgress) }
  }
  const tracked = status.tracking === 'tracked' && Boolean(status.branch)
  if (tracked && figures.behind > 0 && scope.workspaceThreadId === null) {
    const diverged = figures.ahead > 0
    const from = status.upstream ?? 'the upstream branch'
    return {
      kind: 'pull',
      label: `Pull ${plural(figures.behind, 'commit')}`,
      title: diverged ? `${from} has ${plural(figures.behind, 'new commit')}; you have ${plural(figures.ahead, 'commit')} it does not` : `From ${from}, fast-forward`,
      strategies: diverged ? ['rebase', 'merge'] : ['ff-only']
    }
  }
  // The look's counts stand in for the tracking ref's, so Push and Create PR agree with Pull.
  const current = { ...status, ahead: figures.ahead, behind: figures.behind }
  const push = pushButtonModel(current, input.commitCount, scope)
  if (push && push.disabledReason === undefined) {
    return { kind: 'push', label: push.label === 'Publish' ? 'Publish branch' : `Push ${plural(push.count ?? 0, 'commit')}`, title: push.title }
  }
  const row = pullRequestRow(input.pullRequest, current)
  if (row?.kind === 'create' && row.enabled) return { kind: 'pull-request', label: 'Open pull request', title: 'Create a pull request for this branch' }
  return null
}

/** What each pull strategy is called in the next step's menu. */
export const PULL_STRATEGY_LABELS: Record<GitPullStrategy, string> = { 'ff-only': 'Pull', rebase: 'Rebase mine on top', merge: 'Merge' }

const IN_PROGRESS_TAGS: Record<GitInProgress, string> = { merge: 'merging', rebase: 'rebasing', 'cherry-pick': 'cherry-picking', revert: 'reverting' }

const UNREACHABLE_TITLES = {
  'signed-out': (remote: string) => `${remote} refused the check; sign in to see its new commits`,
  offline: (remote: string) => `${remote} could not be reached to check for new commits`,
  gone: (remote: string) => `${remote} no longer has this branch`
} as const

/** A quiet word after the branch name: a stopped operation, a remote that could not be checked, or that it is up to date. */
export interface BranchTag {
  text: string
  tone: 'quiet' | 'warn'
  title: string
}

export function branchTag(status: GitStatusSnapshot | null, figures: UpstreamFigures, step: NextStep | null, now: number): BranchTag | null {
  if (!status?.isRepo) return null
  if (status.inProgress) return { text: IN_PROGRESS_TAGS[status.inProgress], tone: 'warn', title: `A ${IN_PROGRESS_NAMES[status.inProgress]} is stopped part way` }
  const remote = status.upstream?.split('/')[0] || 'The remote'
  if (figures.look === 'unreachable' && figures.unreachable) {
    return { text: figures.unreachable === 'gone' ? 'gone from remote' : `can’t check ${remote}`, tone: 'quiet', title: UNREACHABLE_TITLES[figures.unreachable](remote) }
  }
  if (step === null && figures.look === 'checked' && figures.ahead === 0 && figures.behind === 0) {
    const when = figures.checkedAt === null ? '' : relativeTime(new Date(figures.checkedAt).toISOString(), now)
    const ago = when === '' ? '' : when === 'now' ? ', checked just now' : `, checked ${when} ago`
    return { text: 'up to date', tone: 'quiet', title: `Same as ${status.upstream ?? 'the upstream branch'}${ago}` }
  }
  return null
}

/** What a failed pull from the side card says: overlapping edits get a fixed line, everything else Git's own. */
export function pullFailureMessage(error: unknown): string {
  return gitErrorCode(error) === 'git_pull_dirty' ? 'Edits overlap. Commit or stash first.' : gitErrorMessage(error)
}

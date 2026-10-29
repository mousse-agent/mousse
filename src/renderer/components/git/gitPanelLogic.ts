import type {
  GitFetchResult,
  GitFileChange,
  GitInProgress,
  GitPullResult,
  GitPullStrategy,
  GitScope,
  GitStatusSnapshot
} from '../../../shared/types'
import { THREAD_WORKTREE_REASON } from '../sideCard/gitSectionLogic'

/** Pure state and wording for the Git panel's file rows and its sync bar. */

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

const IN_PROGRESS_TITLES: Record<GitInProgress, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert'
}

export type SyncKind = 'no-upstream' | 'up-to-date' | 'behind' | 'ahead' | 'diverged' | 'conflicted' | 'in-progress'

export interface SyncState {
  kind: SyncKind
  ahead: number
  behind: number
  upstream: string | null
  /** Paths Git lists as conflicted; empty unless `kind` is `conflicted`. */
  files: string[]
  /** The merge, rebase, cherry-pick or revert that is stopped; null when none is. */
  what: GitInProgress | null
  /** Why there is no upstream to compare with. */
  noUpstream: 'detached' | 'unborn' | 'untracked' | null
}

/**
 * The one state of the branch against its upstream, in the order a user must act on it:
 * conflicts, then a stopped merge or rebase, then how far the two sides have moved apart.
 * Null when there is no repository to describe.
 */
export function syncState(status: GitStatusSnapshot | null): SyncState | null {
  if (!status?.isRepo) return null
  const files = [...new Set(status.changes.filter((change) => change.status === 'conflicted').map((change) => change.path))]
  const what = status.inProgress ?? null
  const base = { ahead: status.ahead, behind: status.behind, upstream: status.upstream ?? null, what }
  if (files.length > 0) return { ...base, kind: 'conflicted', files, noUpstream: null }
  if (what) return { ...base, kind: 'in-progress', files: [], noUpstream: null }
  if (status.tracking !== 'tracked') {
    const noUpstream = status.tracking === 'detached' ? 'detached' : status.tracking === 'unborn' ? 'unborn' : 'untracked'
    return { ...base, kind: 'no-upstream', files: [], noUpstream }
  }
  const kind: SyncKind = status.ahead > 0 && status.behind > 0 ? 'diverged' : status.behind > 0 ? 'behind' : status.ahead > 0 ? 'ahead' : 'up-to-date'
  return { ...base, kind, files: [], noUpstream: null }
}

/** One short line for the sync bar. */
export function syncLabel(state: SyncState): string {
  const upstream = state.upstream
  switch (state.kind) {
    case 'conflicted':
      return `Conflicted: ${plural(state.files.length, 'file')}`
    case 'in-progress':
      return `${IN_PROGRESS_TITLES[state.what ?? 'merge']} in progress`
    case 'no-upstream':
      return state.noUpstream === 'detached' ? 'Detached HEAD' : state.noUpstream === 'unborn' ? 'No commits yet' : 'No upstream branch'
    case 'up-to-date':
      return upstream ? `Up to date with ${upstream}` : 'Up to date'
    case 'behind':
      return `Behind${upstream ? ` ${upstream}` : ''} by ${plural(state.behind, 'commit')}`
    case 'ahead':
      return `Ahead of${upstream ? ` ${upstream}` : ' upstream'} by ${plural(state.ahead, 'commit')}`
    case 'diverged':
      return `Diverged: ${state.ahead} ahead, ${state.behind} behind`
  }
}

/** The ways Pull can reconcile the branch: fast-forward only, unless the two sides have both moved. */
export function pullChoices(state: SyncState | null): GitPullStrategy[] {
  return state?.kind === 'diverged' ? ['merge', 'rebase'] : ['ff-only']
}

export interface SyncControl {
  enabled: boolean
  /** Why the control is disabled; null when it is enabled. */
  reason: string | null
}

export interface SyncControls {
  fetch: SyncControl
  pull: SyncControl & { choices: GitPullStrategy[] }
  /** The stopped operation the Abort button would give up; null when it has no Abort. */
  abort: 'merge' | 'rebase' | null
}

/** What the sync bar offers. A thread's own branch is only updated by the thread, so Pull is off there; Fetch works anywhere with a remote. */
export function syncControls(status: GitStatusSnapshot | null, scope: Pick<GitScope, 'workspaceThreadId'>): SyncControls {
  const state = syncState(status)
  const choices = pullChoices(state)
  const abort = state?.what === 'merge' || state?.what === 'rebase' ? state.what : null
  if (!status || !state) {
    return { fetch: { enabled: false, reason: 'Not a Git repository' }, pull: { enabled: false, reason: 'Not a Git repository', choices }, abort }
  }
  const fetch: SyncControl = status.hasRemote === false ? { enabled: false, reason: 'No remote configured' } : { enabled: true, reason: null }
  let pullReason: string | null = null
  if (scope.workspaceThreadId !== null) pullReason = THREAD_WORKTREE_REASON
  else if (state.kind === 'conflicted') pullReason = 'Resolve the conflicted files first'
  else if (state.kind === 'in-progress') pullReason = `Finish or abort the ${state.what ?? 'merge'} first`
  else if (state.noUpstream === 'detached') pullReason = 'Detached HEAD has no upstream'
  else if (state.kind === 'no-upstream') pullReason = 'No upstream branch to pull from'
  return { fetch, pull: { enabled: pullReason === null, reason: pullReason, choices }, abort }
}

/** What a fetch found. */
export function fetchResultNotice(result: GitFetchResult): string {
  const news = Math.max(0, result.behindAfter - result.behindBefore)
  return news === 0 ? 'Already up to date' : `Fetched: ${plural(news, 'new commit')}`
}

/** What a pull did. */
export function pullResultNotice(result: GitPullResult['result']): string {
  switch (result) {
    case 'up-to-date':
      return 'Already up to date'
    case 'fast-forwarded':
      return 'Pulled: fast-forwarded'
    case 'merged':
      return 'Pulled: merged'
    case 'rebased':
      return 'Pulled: rebased'
    case 'conflicted':
      return 'Pull stopped on conflicts. Resolve the conflicted files, or abort.'
  }
}

export type SyncAction = 'fetch' | 'pull' | 'abort'

/** What Fetch, Pull and Abort are doing, as one state: the sync bar shows a single line for whichever ran last. */
export type SyncActivity =
  | { phase: 'idle' }
  | { phase: 'running'; action: SyncAction }
  | { phase: 'done'; action: SyncAction; message: string }
  | { phase: 'failed'; action: SyncAction; message: string }

export const IDLE_SYNC_ACTIVITY: SyncActivity = { phase: 'idle' }

const RUNNING_TEXT: Record<SyncAction, string> = { fetch: 'Fetching…', pull: 'Pulling…', abort: 'Aborting…' }
const FAILED_TEXT: Record<SyncAction, string> = { fetch: 'Fetch failed', pull: 'Pull failed', abort: 'Abort failed' }

export interface SyncLine {
  /** `status` for progress and results, `alert` for a failure. */
  role: 'status' | 'alert'
  text: string
}

/** The line under the sync label: progress, the result, or the failure with Git's reason. Null when nothing ran. */
export function syncActivityLine(activity: SyncActivity): SyncLine | null {
  switch (activity.phase) {
    case 'idle':
      return null
    case 'running':
      return { role: 'status', text: RUNNING_TEXT[activity.action] }
    case 'done':
      return { role: 'status', text: activity.message }
    case 'failed':
      return { role: 'alert', text: `${FAILED_TEXT[activity.action]}: ${activity.message}` }
  }
}

/** Abort button wording. */
export function abortLabel(what: 'merge' | 'rebase'): string {
  return `Abort ${what}`
}

export type RowAction = 'stage' | 'unstage' | 'discard'

/**
 * The buttons a file row shows. Stage and unstage are absent in a thread's own worktree, where
 * a commit there takes every change anyway; discard is available everywhere.
 */
export function rowActions(file: GitFileChange, scope: Pick<GitScope, 'workspaceThreadId'>): RowAction[] {
  if (file.status === 'ignored') return []
  const inThread = scope.workspaceThreadId !== null
  if (file.staged) return inThread ? ['discard'] : ['unstage', 'discard']
  return inThread ? ['discard'] : ['stage', 'discard']
}

export type SectionAction = 'stage-all' | 'unstage-all'

/** The button in a section's title: Stage all for files not in the index, Unstage all for the staged ones. */
export function sectionAction(section: ChangeSectionId, scope: Pick<GitScope, 'workspaceThreadId'>): SectionAction | null {
  if (scope.workspaceThreadId !== null) return null
  return section === 'staged' ? 'unstage-all' : 'stage-all'
}

export type ChangeSectionId = 'conflicts' | 'staged' | 'changes' | 'untracked'
export type GitSectionId = ChangeSectionId | 'commits'

export interface ChangeGroups {
  conflicts: GitFileChange[]
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
}

/** A path changed in both the index and the working tree is in `staged` and in `unstaged`; a conflicted path is only in `conflicts`. */
export function groupChanges(changes: readonly GitFileChange[]): ChangeGroups {
  return {
    conflicts: changes.filter((change) => change.status === 'conflicted'),
    staged: changes.filter((change) => change.staged && change.status !== 'untracked' && change.status !== 'conflicted'),
    unstaged: changes.filter((change) => !change.staged && change.status !== 'untracked' && change.status !== 'ignored' && change.status !== 'conflicted'),
    untracked: changes.filter((change) => change.status === 'untracked')
  }
}

/** The row whose diff is open: a path on one side, since a file staged and edited again has a row on each. */
export interface SelectedFile {
  path: string
  staged: boolean
}

/**
 * The open file after an action on `paths` (or on every staged file, `'all'`). A staged file moves to its
 * unstaged side and the other way round, so its diff stays open; a discarded file has nothing left to show.
 */
export function selectionAfterAction(selected: SelectedFile | null, action: RowAction, paths: readonly string[] | 'all'): SelectedFile | null {
  if (!selected) return null
  const affected = paths === 'all' ? selected.staged : paths.includes(selected.path)
  if (!affected) return selected
  if (action === 'discard') return null
  if (action === 'stage') return selected.staged ? selected : { path: selected.path, staged: true }
  return selected.staged ? { path: selected.path, staged: false } : selected
}

export function rowActionLabel(action: RowAction, file: GitFileChange): string {
  switch (action) {
    case 'stage':
      return `Stage ${file.path}`
    case 'unstage':
      return `Unstage ${file.path}`
    case 'discard':
      return file.status === 'untracked' ? `Delete untracked file ${file.path}` : `Discard changes to ${file.path}`
  }
}

const DISCARD_LIST_LIMIT = 10

/**
 * The confirmation shown before changes are thrown away. It names the files, says which
 * untracked ones will be deleted, and that this cannot be undone.
 */
export function discardPrompt(files: readonly GitFileChange[]): string {
  const byPath = new Map<string, boolean>()
  for (const file of files) byPath.set(file.path, (byPath.get(file.path) ?? false) || file.status === 'untracked')
  const entries = [...byPath]
  if (entries.length === 0) return ''
  const closing = ['', 'This cannot be undone.']
  if (entries.length === 1) {
    const [path, untracked] = entries[0]
    return untracked
      ? [`Delete ${path}?`, '', 'It is not tracked by Git, so it will be deleted.', ...closing].join('\n')
      : [`Discard changes to ${path}?`, ...closing].join('\n')
  }
  const listed = entries.slice(0, DISCARD_LIST_LIMIT).map(([path, untracked]) => `  ${path}${untracked ? ' (untracked, will be deleted)' : ''}`)
  const more = entries.length > DISCARD_LIST_LIMIT ? [`  …and ${entries.length - DISCARD_LIST_LIMIT} more`] : []
  return [`Discard changes to ${entries.length} files?`, '', ...listed, ...more, ...closing].join('\n')
}

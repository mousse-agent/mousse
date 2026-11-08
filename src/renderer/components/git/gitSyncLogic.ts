import type {
  GitFetchResult,
  GitInProgress,
  GitPullResult,
  GitPullStrategy,
  GitScope,
  GitStatusSnapshot
} from '../../../shared/types'
import { THREAD_WORKTREE_REASON } from '../sideCard/gitSectionLogic'

/** Pure state and wording for Fetch, Pull and Abort, which the Changes tab's sync chip offers. */

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

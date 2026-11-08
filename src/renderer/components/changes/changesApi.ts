// The one place the Changes tab reaches the daemon's selection, undo and revert methods (`git.changes`,
// `git.include`, `git.undoLastCommit`, `git.revert`, `git.restoreReverted`, `git.revertedList` and the
// `git.selectionChanged` event; see docs/plans/changes-tab.md). They ship in their own PRs; until the preload
// exposes them, the feature checks below are false and the tab hides Include, Revert, Undo last commit and the
// selection UI, and reads the uncommitted diff through `review.file` instead.
import type { GitScope } from '../../../shared/types'

export type IncludeState = 'yes' | 'no' | 'partial'

export interface ChangeLine {
  kind: ' ' | '-' | '+'
  text: string
  oldNo?: number
  newNo?: number
}

export interface ChangeHunk {
  /** Hash of oldStart and the hunk's lines; unique within the file. */
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: ChangeLine[]
  included: IncludeState
}

export interface ChangedFile {
  /** A rename is one entry covering both paths. */
  path: string
  oldPath?: string
  change: 'modified' | 'added' | 'deleted' | 'renamed' | 'conflict'
  kind: 'file' | 'symlink' | 'submodule'
  binary: boolean
  /** Mode-only changes have no hunks. */
  mode?: { old: string; new: string }
  /** Include and Revert take the whole file only (binary, symlink, rename, conflict, filters, a diverged selection…). */
  wholeFileOnly: boolean
  /** The selection holds content that is not HEAD plus some of these hunks. */
  indexDiverged: boolean
  tooLarge: boolean
  /** Checked by every write: HEAD, paths, modes, index stages, working-tree digest and the selection token. */
  version: string
  hunks: ChangeHunk[]
  included: IncludeState
}

export interface SelectionState {
  /** `untouched`: nothing chosen yet (index equal to HEAD in a project folder, no overlay in a thread). */
  state: 'untouched' | 'chosen'
  token: string
}

export interface ChangesResult {
  files: ChangedFile[]
  selection: SelectionState
  /** The file count went over the limit; a single large file says `tooLarge`. */
  truncated: boolean
}

export interface LineChoice {
  /** Hunk id; `indexes` point into `hunk.lines`. */
  hunk: string
  indexes: number[]
}

export type IncludeInput =
  | { path: string; version: string; include: boolean; hunks?: string[]; lines?: LineChoice[] }
  | { all: true; include: boolean }

export type IncludeResult =
  | { path: string; version: string; included: IncludeState; selection: SelectionState }
  | { selection: SelectionState }

export interface RevertInput {
  path: string
  version: string
  hunks?: string[]
  lines?: LineChoice[]
}

export interface RevertResult {
  revertId: string
  keptUntil: number
  path: string
  version: string
}

export type RestoreResult =
  | { restored: true }
  | { restored: false; reason: 'changed' | 'expired'; currentBlob?: string; keptBlob?: string }

export interface RevertedEntry {
  revertId: string
  path: string
  oldPath?: string
  at: number
  keptUntil: number
  summary: string
}

/** What `git.commit` and `git.suggestCommitMessage` take as `selection`. */
export type CommitSelectionField = { mode: 'all' } | { mode: 'chosen'; token: string }

/** The errors these methods reject with, besides today's Git errors. */
export type ChangesErrorCode =
  | 'stale'
  | 'thread_busy'
  | 'whole_file_only'
  | 'git_merge_unresolved'
  | 'nothing_selected'
  | 'git_undo_in_thread'
  | 'git_amend_pushed'
  | 'git_amend_no_commit'
  | 'git_undo_root'
  | 'git_undo_merge'
  | 'computerOutdated'
  | 'remote_offline'

/** Which folder a call is about: the thread whose own worktree it is, else the project. */
export type ChangesTarget = { threadId: string } | { projectId: string }

export function changesTarget(scope: GitScope): ChangesTarget | null {
  if (scope.workspaceThreadId) return { threadId: scope.workspaceThreadId }
  return scope.projectId ? { projectId: scope.projectId } : null
}

interface ChangesBridge {
  changes: (params: ChangesTarget & { paths?: string[] }) => Promise<ChangesResult>
  include: (params: ChangesTarget & IncludeInput) => Promise<IncludeResult>
  undoLastCommit: (params: { projectId: string; expectedHead: string }) => Promise<unknown>
  revert: (params: ChangesTarget & RevertInput) => Promise<RevertResult>
  restoreReverted: (params: ChangesTarget & { revertId: string }) => Promise<RestoreResult>
  revertedList: (params: ChangesTarget) => Promise<RevertedEntry[]>
  onSelectionChanged: (cb: (event: Partial<ChangesTarget>) => void) => () => void
}

function bridge(): Partial<ChangesBridge> | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { mousse?: { git?: Partial<ChangesBridge> } }).mousse?.git
}

function method<K extends keyof ChangesBridge>(name: K): ChangesBridge[K] {
  const fn = bridge()?.[name]
  if (typeof fn !== 'function') throw Object.assign(new Error('Not available in this version'), { code: 'unavailable' })
  return fn as ChangesBridge[K]
}

const has = (name: keyof ChangesBridge) => typeof bridge()?.[name] === 'function'

/** True once the preload exposes the hunk reads and the selection (A1). */
export function changesApiAvailable(): boolean {
  return has('changes') && has('include')
}

/** True once Revert and its restore are exposed (A2). Revert ships only with restore. */
export function revertAvailable(): boolean {
  return has('revert') && has('restoreReverted') && has('revertedList')
}

export function undoLastCommitAvailable(): boolean {
  return has('undoLastCommit')
}

export const changesApi = {
  changes: (target: ChangesTarget, paths?: string[]) => method('changes')({ ...target, ...(paths ? { paths } : {}) }),
  include: (target: ChangesTarget, input: IncludeInput) => method('include')({ ...target, ...input }),
  undoLastCommit: (projectId: string, expectedHead: string) => method('undoLastCommit')({ projectId, expectedHead }),
  revert: (target: ChangesTarget, input: RevertInput) => method('revert')({ ...target, ...input }),
  restoreReverted: (target: ChangesTarget, revertId: string) => method('restoreReverted')({ ...target, revertId }),
  revertedList: (target: ChangesTarget) => method('revertedList')(target),
  /** Another view changed the selection; nothing to unsubscribe when the event is not exposed. */
  onSelectionChanged: (cb: (event: Partial<ChangesTarget>) => void): (() => void) => (has('onSelectionChanged') ? method('onSelectionChanged')(cb) : () => undefined)
}

/** The `selection` a commit or a suggestion sends: exactly the chosen hunks, or everything. */
export function commitSelectionFor(selection: SelectionState | null | undefined): CommitSelectionField | undefined {
  if (!selection) return undefined
  return selection.state === 'chosen' ? { mode: 'chosen', token: selection.token } : { mode: 'all' }
}

export function changesErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

/** The tab's own words for the new errors; Git's other errors keep their message. */
export function changesErrorText(error: unknown, fallback: (error: unknown) => string): string {
  switch (changesErrorCode(error)) {
    case 'thread_busy':
      return 'Wait for the turn to end'
    case 'whole_file_only':
      return 'Only the whole file can be chosen here'
    case 'nothing_selected':
      return 'Include something to commit'
    case 'stale':
      return 'Changed meanwhile; showing it again'
    case 'computerOutdated':
      return 'Update Mousse on that computer to commit a selection'
    default:
      return fallback(error)
  }
}

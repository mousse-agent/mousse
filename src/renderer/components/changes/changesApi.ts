// The one place the Changes tab reaches the daemon's selection, undo and revert methods (`git.changes`,
// `git.include`, `git.undoLastCommit`, `git.revert`, `git.restoreReverted`, `git.revertedList` and the
// `git.selectionChanged` event; see docs/plans/changes-tab.md). Like the other Git calls they name their folder by
// `GitScope`; the main process turns it into the daemon's `{ threadId? | projectId? }`. The app refuses a local
// service without these methods (`GUI_REQUIRED_METHODS`); an older computer over Bridge answers with an error code.
import type {
  GitChangedFile,
  GitChangeHunk,
  GitChangeLine,
  GitChangesResult,
  GitCommitSelection,
  GitIncluded,
  GitIncludeRequest,
  GitRestoreRevertedResult,
  GitRevertedItem,
  GitRevertRequest,
  GitRevertResult,
  GitScope,
  GitSelectionState
} from '../../../shared/types'

export type IncludeState = GitIncluded
export type ChangeLine = GitChangeLine
export type ChangeHunk = GitChangeHunk
export type ChangedFile = GitChangedFile
export type SelectionState = GitSelectionState
export type ChangesResult = GitChangesResult
export type RevertResult = GitRevertResult
export type RestoreResult = GitRestoreRevertedResult
export type RevertedEntry = GitRevertedItem
/** What `git.commit` and `git.suggestCommitMessage` take as `selection`. */
export type CommitSelectionField = GitCommitSelection

export interface LineChoice {
  /** Hunk id; `indexes` point into `hunk.lines`. */
  hunk: string
  indexes: number[]
}

/** Which hunks or lines of a file; neither means the whole file. */
export type FileChoice = Pick<GitIncludeRequest, 'hunks' | 'lines'>

/** Who `git.selectionChanged` is about: a thread's worktree (`threadId` alone) or a project's folder (`projectId`). */
export interface SelectionChangedEvent {
  threadId?: string
  projectId?: string
}

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

export const changesApi = {
  /** HEAD → working tree as hunks, and what the next commit takes; `paths` re-reads just those. */
  changes: (scope: GitScope, paths?: string[]): Promise<ChangesResult> => window.mousse.git.changes(scope, paths ? { paths } : undefined),
  include: (scope: GitScope, file: Pick<ChangedFile, 'path' | 'version'>, include: boolean, choice: FileChoice = {}) =>
    window.mousse.git.include(scope, { path: file.path, version: file.version, include, ...choice }),
  includeAll: async (scope: GitScope, include: boolean): Promise<SelectionState> => {
    const result = await window.mousse.git.include(scope, { all: true, include })
    return result.selection
  },
  undoLastCommit: (scope: GitScope, expectedHead: string) => window.mousse.git.undoLastCommit(scope, expectedHead),
  revert: (scope: GitScope, file: Pick<ChangedFile, 'path' | 'version'>, choice: FileChoice = {}): Promise<RevertResult> =>
    window.mousse.git.revert(scope, { path: file.path, version: file.version, ...choice } satisfies GitRevertRequest),
  restoreReverted: (scope: GitScope, revertId: string): Promise<RestoreResult> => window.mousse.git.restoreReverted(scope, revertId),
  revertedList: (scope: GitScope): Promise<RevertedEntry[]> => window.mousse.git.revertedList(scope),
  onSelectionChanged: (cb: (event: SelectionChangedEvent) => void): (() => void) => window.mousse.git.onSelectionChanged(cb)
}

/**
 * Whether a `git.selectionChanged` event is about the folder the tab shows. A thread's worktree is named by its
 * thread alone; a project folder by its project (a thread working there may be named too).
 */
export function selectionEventMatches(scope: GitScope, event: SelectionChangedEvent): boolean {
  if (scope.workspaceThreadId) return event.threadId === scope.workspaceThreadId && !event.projectId
  return scope.projectId !== null && event.projectId === scope.projectId
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
      return 'Changed meanwhile · try again'
    case 'computerOutdated':
      return 'Update Mousse on that computer to commit a selection'
    case 'git_undo_in_thread':
      return 'Use Undo in the chat'
    case 'git_undo_root':
      return "The first commit can't be undone"
    case 'git_undo_merge':
      return "A merge commit can't be undone here"
    default:
      return fallback(error)
  }
}

/** A daemon file with a choice applied at once, so the checkboxes and the footer move on the next frame. */
export function withInclude(file: ChangedFile, include: boolean, choice: FileChoice = {}): ChangedFile {
  const whole = !choice.hunks?.length && !choice.lines?.length
  const value: IncludeState = include ? 'yes' : 'no'
  const hunks = file.hunks.map((hunk) => {
    if (whole || choice.hunks?.includes(hunk.id)) return { ...hunk, included: value }
    if (choice.lines?.some((line) => line.hunk === hunk.id && line.indexes.length > 0)) return hunk.included === value ? hunk : { ...hunk, included: 'partial' as const }
    return hunk
  })
  return { ...file, hunks, included: whole ? value : fileIncluded(hunks, file.included) }
}

/** A file's state from its hunks; a file without hunks keeps what it had. */
export function fileIncluded(hunks: readonly ChangeHunk[], fallback: IncludeState): IncludeState {
  if (hunks.length === 0) return fallback
  if (hunks.every((hunk) => hunk.included === 'yes')) return 'yes'
  if (hunks.every((hunk) => hunk.included === 'no')) return 'no'
  return 'partial'
}

/** Fresh files for some paths put in place of the old ones, in the same order; paths no longer changed drop out. */
export function mergeFiles(current: readonly ChangedFile[], paths: readonly string[], fresh: readonly ChangedFile[]): ChangedFile[] {
  const asked = new Set(paths)
  const byPath = new Map(fresh.map((file) => [file.path, file]))
  const merged: ChangedFile[] = []
  for (const file of current) {
    // A rename read under its new path takes its old entry's place.
    const replacement = byPath.get(file.path) ?? [...byPath.values()].find((item) => item.oldPath === file.path)
    if (replacement) {
      merged.push(replacement)
      byPath.delete(replacement.path)
    } else if (!asked.has(file.path) && !(file.oldPath && asked.has(file.oldPath))) merged.push(file)
  }
  return [...merged, ...byPath.values()]
}

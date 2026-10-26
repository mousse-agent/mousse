/** What a Review lists: one turn, the whole thread since its base, or the working tree. */
export type ReviewScope =
  | { kind: 'turn'; turnId: string }
  | { kind: 'thread' }
  | { kind: 'worktree'; staged?: boolean }

/** One side of a comparison: a commit, the index, or the working tree. */
export type ReviewSide =
  | { kind: 'commit'; sha: string }
  | { kind: 'index' }
  | { kind: 'worktree' }

/** `from: null` is the empty tree, for an unborn repository or a base with no commit. */
export interface ReviewRange {
  from: ReviewSide | null
  to: ReviewSide
}

export type ReviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'typechange' | 'untracked'

export interface ReviewFileEntry {
  path: string
  /** Set for a rename: the path on the original side. */
  oldPath?: string
  status: ReviewFileStatus
  additions: number
  deletions: number
  binary: boolean
  /** False for an untracked file whose lines were not counted (too large, binary or a symlink). */
  countsExact: boolean
}

export interface ReviewFilesResult {
  /**
   * Absolute path the entry paths are relative to. Turn and thread scopes use the thread's
   * worktree top level; the working-tree scope uses the project folder, which is a subfolder of
   * the top level when the project sits inside a larger repository. Always join an entry path
   * with this `root`, and never compare paths across scopes.
   */
  root: string
  scope: ReviewScope
  range: ReviewRange
  files: ReviewFileEntry[]
  /** True when the list was cut at `REVIEW_MAX_FILES`. */
  truncated: boolean
  /** Merge commits inside a commit range: the agent pulled or merged other work. */
  mergeCommits: number
  /** Why there is nothing to list, as a sentence for the user. */
  unavailable?: string
}

/** `symlink: true` marks a link on any side; its `content` is the link text, as Git stores it. */
export type ReviewFileSide =
  | { content: string; size: number; symlink?: true }
  | { tooLarge: true; size: number; lines?: number; reason: 'bytes' | 'lines' }
  | { binary: true; size: number }
  | null

export interface ReviewFileResult {
  root: string
  path: string
  /** Null on a side means the file is absent there. */
  original: ReviewFileSide
  modified: ReviewFileSide
}

export interface ReviewFilesParams {
  threadId?: string
  projectId?: string
  scope: ReviewScope
}

export interface ReviewFileParams extends ReviewFilesParams {
  path: string
  /** From the list entry of a rename, so the original side is read at its old name. */
  oldPath?: string
}

/** The empty tree of a SHA-1 repository. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const REVIEW_MAX_FILE_BYTES = 1_048_576
export const REVIEW_MAX_FILE_LINES = 50_000
export const REVIEW_MAX_FILES = 2000
export const REVIEW_MAX_COUNTED_UNTRACKED = 200

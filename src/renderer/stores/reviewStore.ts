import { create } from 'zustand'
import type { ReviewScope } from '../../shared/review'

/** A line to scroll to once the file is open, for a comment pill that points at a diff. */
export interface ReviewReveal {
  path: string
  line: number
}

/** A comment pill's file as an absolute path; the panel maps it to a changed file once the list is loaded. */
export interface ReviewCommentTarget {
  absolutePath: string
  line: number
}

export interface ReviewThreadState {
  /** Null until the user or a turn row picks one; the panel then falls back to the thread's default. */
  scope: ReviewScope | null
  selectedPath: string | null
  /** Monaco `saveViewState()` per file, so scroll and cursor come back when the file is reopened. */
  viewState: Record<string, unknown>
  reveal?: ReviewReveal
  /** A clicked comment pill waiting for the list of its scope; see `revealComment`. */
  pendingComment?: ReviewCommentTarget
}

interface ReviewStoreState {
  byThread: Record<string, ReviewThreadState>
  /** Shows one turn of the thread, from the "Review changes" row under it. */
  openTurn: (threadId: string, turnId: string) => void
  /** Shows the whole thread since its base. */
  openThread: (threadId: string) => void
  setScope: (threadId: string, scope: ReviewScope) => void
  selectFile: (threadId: string, path: string | null) => void
  saveViewState: (threadId: string, path: string, state: unknown) => void
  /** Selects the file and asks the diff to scroll to the line; `scope` switches the comparison first. */
  reveal: (threadId: string, target: ReviewReveal & { scope?: ReviewScope }) => void
  /**
   * A comment pill was clicked: switches to the scope the comment was made on and remembers its file by
   * absolute path, since the pill does not know the worktree root. The panel finishes it with `resolveCommentReveal`.
   */
  revealComment: (threadId: string, target: ReviewCommentTarget & { scope: ReviewScope }) => void
  /** Selects the changed file the pending comment belongs to and asks the diff to scroll to it; null drops the request (the file is not in that scope's list). */
  resolveCommentReveal: (threadId: string, path: string | null) => void
  /** Returns the pending reveal for the file once; later calls get nothing. */
  takeReveal: (threadId: string, path: string) => ReviewReveal | undefined
}

const emptyThread = (): ReviewThreadState => ({ scope: null, selectedPath: null, viewState: {} })

function update(
  byThread: Record<string, ReviewThreadState>,
  threadId: string,
  patch: Partial<ReviewThreadState>
): Record<string, ReviewThreadState> {
  return { ...byThread, [threadId]: { ...(byThread[threadId] ?? emptyThread()), ...patch } }
}

/** Per-thread Review state. Not persisted: it survives switching threads and surfaces, not a restart. */
export const useReviewStore = create<ReviewStoreState>()((set, get) => ({
  byThread: {},
  openTurn: (threadId, turnId) =>
    set((s) => ({ byThread: update(s.byThread, threadId, { scope: { kind: 'turn', turnId }, selectedPath: null }) })),
  openThread: (threadId) =>
    set((s) => ({ byThread: update(s.byThread, threadId, { scope: { kind: 'thread' }, selectedPath: null }) })),
  setScope: (threadId, scope) => set((s) => ({ byThread: update(s.byThread, threadId, { scope }) })),
  selectFile: (threadId, selectedPath) => set((s) => ({ byThread: update(s.byThread, threadId, { selectedPath }) })),
  saveViewState: (threadId, path, state) =>
    set((s) => {
      const current = s.byThread[threadId] ?? emptyThread()
      return { byThread: update(s.byThread, threadId, { viewState: { ...current.viewState, [path]: state } }) }
    }),
  reveal: (threadId, { scope, path, line }) =>
    set((s) => ({
      byThread: update(s.byThread, threadId, { ...(scope ? { scope } : {}), selectedPath: path, reveal: { path, line } })
    })),
  revealComment: (threadId, { scope, absolutePath, line }) =>
    set((s) => ({ byThread: update(s.byThread, threadId, { scope, pendingComment: { absolutePath, line } }) })),
  resolveCommentReveal: (threadId, path) =>
    set((s) => {
      const current = s.byThread[threadId]
      if (!current?.pendingComment) return s
      const { pendingComment, ...rest } = current
      const next: ReviewThreadState = path ? { ...rest, selectedPath: path, reveal: { path, line: pendingComment.line } } : rest
      return { byThread: { ...s.byThread, [threadId]: next } }
    }),
  takeReveal: (threadId, path) => {
    const pending = get().byThread[threadId]?.reveal
    if (!pending || pending.path !== path) return undefined
    set((s) => {
      const { reveal: _taken, ...rest } = s.byThread[threadId]
      return { byThread: { ...s.byThread, [threadId]: rest } }
    })
    return pending
  }
}))

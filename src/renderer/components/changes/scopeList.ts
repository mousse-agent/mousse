import type { ReviewFilesResult, ReviewScope } from '../../../shared/review'
import { mergeUncommittedLists, type UncommittedParts } from './changesModel'

export interface ScopeList {
  result: ReviewFilesResult
  /** Uncommitted only: per path, whether it is staged, unstaged or both. */
  parts: Map<string, UncommittedParts> | null
}

/** Reads a scope's list. Uncommitted is HEAD → working tree, so Git's staged and unstaged diffs are read together. */
export async function readScopeList(target: { threadId?: string; projectId?: string }, scope: ReviewScope): Promise<ScopeList> {
  if (scope.kind !== 'worktree') return { result: await window.mousse.review.files({ ...target, scope }), parts: null }
  const [unstaged, staged] = await Promise.all([
    window.mousse.review.files({ ...target, scope: { kind: 'worktree' } }),
    window.mousse.review.files({ ...target, scope: { kind: 'worktree', staged: true } }).catch(() => null)
  ])
  return mergeUncommittedLists(unstaged, staged)
}

// Pure helpers for line comments on a diff, so tests can load them.
import {
  joinReviewPath,
  normalizeReviewPath,
  sameReviewFile,
  type ChatReference
} from '../../../shared/chatReferences'
import type { ReviewFileEntry, ReviewScope } from '../../../shared/review'
import type { TurnChoice } from './reviewModel'

/** The version of a file a comment was made on: `turn:<id>`, `thread`, `worktree:staged` or `worktree:unstaged`. */
export function scopeKey(scope: ReviewScope): string {
  if (scope.kind === 'turn') return `turn:${scope.turnId}`
  if (scope.kind === 'worktree') return scope.staged ? 'worktree:staged' : 'worktree:unstaged'
  return 'thread'
}

export function scopeFromKey(key: string): ReviewScope | null {
  if (key.startsWith('turn:')) {
    const turnId = key.slice('turn:'.length)
    return turnId ? { kind: 'turn', turnId } : null
  }
  if (key === 'thread') return { kind: 'thread' }
  if (key === 'worktree:staged') return { kind: 'worktree', staged: true }
  if (key === 'worktree:unstaged') return { kind: 'worktree' }
  return null
}

/** The scope name the agent and the pill show: "This thread", "Uncommitted", or the turn's picker label. */
export function commentScopeLabel(scope: ReviewScope, choices: readonly TurnChoice[] = []): string {
  if (scope.kind === 'thread') return 'This thread'
  if (scope.kind === 'worktree') return scope.staged ? 'Staged changes' : 'Uncommitted'
  const choice = choices.find((item) => item.turnId === scope.turnId)
  return choice ? `Turn: ${choice.label}`.slice(0, 128) : 'Turn'
}

export interface CommentFileQuery {
  reviewScope: string
  absolutePath: string
  platform: string
}

/** The review comments made on this file in this version of it. Comments on other versions never match. */
export function commentsForFile(
  references: readonly ChatReference[] | undefined,
  { reviewScope, absolutePath, platform }: CommentFileQuery
): ChatReference[] {
  return (references ?? []).filter(
    (reference) =>
      reference.kind === 'review-comment' &&
      reference.reviewScope === reviewScope &&
      !!reference.path &&
      !!reference.line &&
      sameReviewFile(reference.path, absolutePath, platform)
  )
}

/** Comments per changed file (by its path in the list) for the tree rows. */
export function commentCounts(
  references: readonly ChatReference[] | undefined,
  { reviewScope, root, files, platform }: { reviewScope: string; root: string; files: readonly ReviewFileEntry[]; platform: string }
): Map<string, number> {
  const counts = new Map<string, number>()
  const inScope = (references ?? []).filter(
    (reference) => reference.kind === 'review-comment' && reference.reviewScope === reviewScope && reference.path
  )
  if (inScope.length === 0) return counts
  const byAbsolutePath = new Map<string, number>()
  for (const reference of inScope) {
    const key = normalizeReviewPath(reference.path as string, platform)
    byAbsolutePath.set(key, (byAbsolutePath.get(key) ?? 0) + 1)
  }
  for (const file of files) {
    const count = byAbsolutePath.get(normalizeReviewPath(joinReviewPath(root, file.path), platform))
    if (count) counts.set(file.path, count)
  }
  return counts
}

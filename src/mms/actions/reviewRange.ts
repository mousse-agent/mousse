import type { ReviewRange, ReviewScope, ReviewSide } from '../../shared/review'
import { commitExists } from '../git/reviewDiff'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ThreadActionService } from './ThreadActionService'

export interface ResolvedReviewScope {
  /** The thread's worktree; paths in the review are relative to it. */
  cwd: string
  range: ReviewRange
  /** Why the range cannot be shown. The range is still set so callers can echo it. */
  unavailable?: string
}

const NOT_CHECKPOINTED = 'This turn was not checkpointed'
const NO_LONGER_AVAILABLE = 'Changes no longer available: the turn was undone or its checkpoint expired'

const commit = (sha: string): ReviewSide => ({ kind: 'commit', sha })

/**
 * Maps a turn or thread scope to a Git range in the thread's worktree. Returns null when the thread
 * has no ready workspace of its own: only provisioned workspaces are checkpointed, so a thread
 * without one has no turns to review. The working-tree scope does not go through here.
 */
export function resolveReviewScope(threadDirectory: string, scope: ReviewScope): ResolvedReviewScope | null {
  const workspace = new ThreadWorkspaceManager(threadDirectory).load()
  if (!workspace || workspace.lifecycle !== 'ready') return null
  const cwd = workspace.worktreePath

  if (scope.kind === 'thread') {
    const range: ReviewRange = { from: commit(workspace.baseSha), to: { kind: 'worktree' } }
    return commitExists(cwd, workspace.baseSha) ? { cwd, range } : { cwd, range, unavailable: NO_LONGER_AVAILABLE }
  }
  if (scope.kind !== 'turn') return null

  const action = new ThreadActionService(threadDirectory).list().find((item) => item.turnId === scope.turnId && item.scope !== 'conversation')
  if (!action) return { cwd, range: { from: null, to: { kind: 'worktree' } }, unavailable: NOT_CHECKPOINTED }
  // A turn always uses its own pair, never the previous turn's end: a stopped or failed turn still
  // records its own SHAs, and a canceled run must not break the next turn's diff.
  // An unfinished action maps to the working tree although `beginTurn` starts it with endSha === startSha.
  const unfinished = action.state === 'planned' || action.state === 'running' || action.state === 'checkpointing'
  const to: ReviewSide = unfinished ? { kind: 'worktree' } : commit(action.endSha)
  const range: ReviewRange = { from: commit(action.startSha), to }
  const missing = !commitExists(cwd, action.startSha) || (to.kind === 'commit' && !commitExists(cwd, to.sha))
  return missing ? { cwd, range, unavailable: NO_LONGER_AVAILABLE } : { cwd, range }
}

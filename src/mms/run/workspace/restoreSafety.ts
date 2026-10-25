import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { tryGit } from '../../actions/git'
import { ThreadWorkspaceManager } from '../../workspace/ThreadWorkspaceManager'
import type { ThreadWorkspaceMetadata } from '../../../shared/workspace'
import type { RunCapabilities as ProviderCapabilities } from '../../../shared/harness/types'
import { restoreMode, type RestoreMode } from '../policy/featureGates'

/**
 * Restore safety for undo and code revert (docs/run-engine/SPEC.md §16.3). A file restore needs a
 * workspace the thread owns that no other thread's worktree or live working directory overlaps
 * (realpath containment either way); weak-containment providers additionally get the diff to review
 * instead of an automatic restore.
 */

/** Where another thread works: its own worktree or the directory its live turn runs in. */
export interface WorkspaceClaim {
  threadId: string
  path: string
  kind: 'worktree' | 'live_cwd'
}

export type RestoreDecision =
  | { action: 'proceed'; mode: RestoreMode }
  | { action: 'review'; mode: 'review_diff' }
  | { action: 'refuse'; reason: 'workspace_shared'; message: string; conflicts: WorkspaceClaim[] }

/** `realpath` when the path exists, otherwise the resolved path. */
export function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

/** One path equals or contains the other, after realpath. */
export function pathsOverlap(left: string, right: string): boolean {
  const a = canonicalPath(left)
  const b = canonicalPath(right)
  return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`) || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`)
}

/** The thread's own provisioned worktree: ready, owned by the thread and not the primary checkout. */
export function ownsWorktree(threadId: string, metadata: ThreadWorkspaceMetadata | undefined): metadata is ThreadWorkspaceMetadata {
  if (!metadata || metadata.lifecycle !== 'ready' || metadata.threadId !== threadId) return false
  if ((metadata.provenance?.ownerThreadId ?? metadata.threadId) !== threadId) return false
  const primary = metadata.integrationTarget?.checkoutPath
  return !primary || canonicalPath(primary) !== canonicalPath(metadata.worktreePath)
}

/**
 * The decision for one restore. `reviewed` is the user's confirmation of the exact diff they saw
 * (the caller compares `restoreDiffSha`); it lifts the review step but never the ownership check.
 * Unknown capabilities fail closed: the diff is reviewed first. `others` may be a function, read
 * at most once and only when the ownership check passes.
 */
export function evaluateRestore(input: {
  threadId: string
  caps: ProviderCapabilities | null
  metadata: ThreadWorkspaceMetadata | undefined
  others: WorkspaceClaim[] | (() => WorkspaceClaim[])
  reviewed?: boolean
}): RestoreDecision {
  const mode = input.caps ? restoreMode(input.caps) : 'review_diff'
  if (!ownsWorktree(input.threadId, input.metadata))
    return {
      action: 'refuse',
      reason: 'workspace_shared',
      message: 'Files are restored only in a worktree this thread owns.',
      conflicts: []
    }
  const worktree = input.metadata.worktreePath
  const others = typeof input.others === 'function' ? input.others() : input.others
  const conflicts = others.filter((claim) => claim.threadId !== input.threadId && pathsOverlap(claim.path, worktree))
  if (conflicts.length)
    return {
      action: 'refuse',
      reason: 'workspace_shared',
      message: `Another thread works in this workspace (${conflicts.map((claim) => claim.threadId).join(', ')}); restore refused.`,
      conflicts
    }
  if (mode === 'review_diff' && !input.reviewed) return { action: 'review', mode }
  return { action: 'proceed', mode }
}

/** Other threads' provisioned worktrees, read from their workspace metadata. */
export function worktreeClaims(threads: Array<{ threadId: string; threadDirectory: string }>): WorkspaceClaim[] {
  const claims: WorkspaceClaim[] = []
  for (const thread of threads) {
    try {
      const metadata = new ThreadWorkspaceManager(thread.threadDirectory).load()
      if (metadata?.worktreePath) claims.push({ threadId: thread.threadId, path: metadata.worktreePath, kind: 'worktree' })
    } catch {
      // Unreadable metadata names no worktree.
    }
  }
  return claims
}

export const RESTORE_DIFF_MAX_CHARS = 200_000

/** The SHA-256 of a review diff; a reviewed restore names it (`reviewedDiffSha`). */
export function restoreDiffSha(diff: string): string {
  return createHash('sha256').update(diff).digest('hex')
}

/** What restoring `from` → `to` would change in the worktree (`git diff from to`), bounded. */
export function restoreDiff(worktreePath: string, from: string, to: string): string {
  const result = tryGit(worktreePath, ['diff', '--no-color', from, to])
  if (!result.ok) return ''
  return result.stdout.length > RESTORE_DIFF_MAX_CHARS
    ? `${result.stdout.slice(0, RESTORE_DIFF_MAX_CHARS)}\n… diff truncated`
    : result.stdout
}

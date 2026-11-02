import { existsSync } from 'node:fs'
import { ThreadJournal, type ThreadJournalRecord } from '../data/ThreadJournal'
import { isRecordedMerge } from '../actions/leftMerge'
import type { ThreadWorkspaceMetadata, WorkspaceRecovery } from '../../shared/workspace'

/** Journal states of an operation that has not finished (`ThreadWorkspaceManager.hasPendingOperation`). */
const PENDING_STATES = ['prepared', 'git_applied', 'context_pending', 'recovery_required']
const PUBLISH_TYPES = ['publish', 'change-publish']

/**
 * An operation's error as the person reads it. A failed Git command's message starts with the whole command line
 * (`Command failed: git -c core.fsmonitor=false -c … add -A …`); only what Git said after it is kept.
 */
export function recoveryErrorText(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '').trim()
  if (!text.startsWith('Command failed: ')) return text
  return text.split('\n').slice(1).map((line) => line.trim()).filter(Boolean).join(' ') || 'A Git command failed without saying why.'
}

interface LeftMergeDetails { mergeInProgress?: unknown; mergeIdentity?: unknown }

/** The folder of a merge an earlier version left, as recorded, whether or not it is still that merge. */
function recordedLeftMerge(entry: ThreadJournalRecord): string | undefined {
  const folder = (entry.details as LeftMergeDetails | undefined)?.mergeInProgress
  return entry.state === 'cancelled' && typeof folder === 'string' ? folder : undefined
}

/**
 * A merge an earlier version started (a Publish into the primary checkout, a subagent result into the worktree) that
 * is still in progress in its folder. Its record was cancelled on upgrade and keeps the folder in `mergeInProgress`
 * and which merge it was in `mergeIdentity`. Only that very merge counts: once it was finished, aborted or replaced by
 * another (even of the same commit at the same HEAD), it is the person's or the agent's and is never offered for Abort.
 */
function leftMerge(entry: ThreadJournalRecord): string | undefined {
  const folder = recordedLeftMerge(entry)
  if (!folder || !existsSync(folder)) return undefined
  return isRecordedMerge(folder, (entry.details as LeftMergeDetails).mergeIdentity) ? folder : undefined
}

/**
 * Clears the records of left merges that are no longer the recorded merge, so nothing offers to abort them again.
 * Called where Mousse already writes the journal (`operations.recover`); `workspace.getStatus` only reads, since a
 * journal write changes the generation clients send with their next action.
 */
export function clearStaleLeftMerges(threadDirectory: string): void {
  const journal = new ThreadJournal(threadDirectory)
  for (const entry of journal.latestByOperation().values()) {
    if (recordedLeftMerge(entry) && !leftMerge(entry)) journal.append({ operationId: entry.operationId, operationType: entry.operationType, state: 'cancelled', details: { mergeNoLongerRecorded: true } })
  }
}

/**
 * What a thread's worktree or its Publish is waiting on, or undefined when nothing is. `verified` is
 * `ThreadWorkspaceManager.verify()` of the stored metadata: `recovery_required` while a Mousse operation other than
 * Publish waits, or when Git cannot read the worktree. The branch and HEAD are the agent's to move and are never a
 * reason.
 */
export function describeRecovery(threadDirectory: string, verified: ThreadWorkspaceMetadata): WorkspaceRecovery | undefined {
  const latest = [...new ThreadJournal(threadDirectory, { readOnly: true }).latestByOperation().values()]
  const operationOf = (entry: ThreadJournalRecord) => ({ operationId: entry.operationId, operationType: entry.operationType })
  const errorOf = (entry: ThreadJournalRecord): string | undefined => {
    const error = (entry.details as { error?: unknown } | undefined)?.error
    return typeof error === 'string' && error ? recoveryErrorText(error) : undefined
  }

  // Turns, Undo and Publish are refused until this is recovered.
  const waiting = latest.find((entry) => PENDING_STATES.includes(entry.state) && !PUBLISH_TYPES.includes(entry.operationType))
  if (waiting) return { kind: 'paused', reason: errorOf(waiting) ?? `The ${waiting.operationType} operation did not finish.`, ...operationOf(waiting) }
  if (verified.lifecycle === 'recovery_required') return { kind: 'paused', reason: 'Git cannot read the worktree.' }

  // Nothing is refused, but Git keeps a merge open in that folder until it is aborted or finished.
  for (const entry of latest) {
    const folder = leftMerge(entry)
    if (!folder) continue
    return {
      kind: 'merge',
      reason: `A merge from an earlier version of Mousse is still in progress in ${folder}. Abort it, or finish it with Git.`,
      folder,
      ...operationOf(entry)
    }
  }

  // A Publish that did not finish (Mousse stopped during it): recovery finds out whether it landed and records that.
  const publish = latest.find((entry) => PENDING_STATES.includes(entry.state) && PUBLISH_TYPES.includes(entry.operationType))
  if (publish) return { kind: 'publish', reason: errorOf(publish) ?? 'A Publish did not finish.', ...operationOf(publish) }
  return undefined
}

import { access } from 'node:fs/promises'
import { ThreadJournal, type ThreadJournalRecord } from '../data/ThreadJournal'
import { leftMergeRefusalAsync } from '../actions/leftMerge'
import { waitForFolderAccess } from '../files/folderAccess'
import type { ThreadWorkspaceMetadata, WorkspaceRecovery } from '../../shared/workspace'
import { ThreadWorkspaceManager } from './ThreadWorkspaceManager'
import { settlesItself } from '../../shared/resourceLifecycle'

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
 * and which merge it was in `mergeIdentity`. Offered only while `operations.abort` would abort it (`leftMergeRefusal`,
 * the check Abort itself runs): once it was finished, aborted or replaced by another (even of the same commit at the
 * same HEAD), it is the person's or the agent's.
 */
async function leftMerge(entry: ThreadJournalRecord, records: readonly ThreadJournalRecord[]): Promise<string | undefined> {
  const folder = recordedLeftMerge(entry)
  if (!folder) return undefined
  await waitForFolderAccess([folder])
  if (!await access(folder).then(() => true, () => false)) return undefined
  return await leftMergeRefusalAsync(folder, entry, records) ? undefined : folder
}

/**
 * Clears the records of left merges that are no longer the recorded merge, so nothing offers to abort them again.
 * Called where Mousse already writes the journal (`operations.recover`); `workspace.getStatus` only reads, since a
 * journal write changes the generation clients send with their next action.
 */
export async function clearStaleLeftMerges(threadDirectory: string, beforeRecord?: () => void): Promise<void> {
  const journal = new ThreadJournal(threadDirectory)
  const records = journal.list()
  for (const entry of journal.latestByOperation().values()) {
    if (!recordedLeftMerge(entry) || await leftMerge(entry, records)) continue
    // A caller holding no thread lease checks again here, after the Git reads, that no turn has started.
    beforeRecord?.()
    journal.append({ operationId: entry.operationId, operationType: entry.operationType, state: 'cancelled', details: { mergeNoLongerRecorded: true } })
  }
}

/**
 * What a thread's worktree or its Publish is waiting on, or undefined when nothing is. `verified` is
 * `ThreadWorkspaceManager.verify()` of the stored metadata: `recovery_required` while a Mousse operation other than
 * Publish waits, or when Git cannot read the worktree. The branch and HEAD are the agent's to move and are never a
 * reason.
 */
export async function describeRecovery(threadDirectory: string, verified: ThreadWorkspaceMetadata): Promise<WorkspaceRecovery | undefined> {
  const journal = new ThreadJournal(threadDirectory, { readOnly: true })
  const records = journal.list()
  const latest = [...journal.latestByOperation().values()]
  const operationOf = (entry: ThreadJournalRecord) => ({ operationId: entry.operationId, operationType: entry.operationType })
  const errorOf = (entry: ThreadJournalRecord): string | undefined => {
    const error = (entry.details as { error?: unknown } | undefined)?.error
    return typeof error === 'string' && error ? recoveryErrorText(error) : undefined
  }

  // Turns, Undo and Publish are refused until this is recovered.
  // An unsettled expiry of kept files, or keep of a copy, touches no file; the next retention sweep settles it, so it
  // pauses nothing.
  const waiting = latest.find((entry) => PENDING_STATES.includes(entry.state) && !PUBLISH_TYPES.includes(entry.operationType) && !settlesItself(entry.operationType))
  if (waiting) return { kind: 'paused', reason: errorOf(waiting) ?? `The ${waiting.operationType} operation did not finish.`, ...operationOf(waiting) }
  // A folder with no Git of its own (`snapshotOnly`) has no worktree for Git to read: only a waiting operation pauses it.
  if (!verified.snapshotOnly && verified.lifecycle === 'recovery_required') return { kind: 'paused', reason: 'Git cannot read the worktree.' }

  // Nothing is refused, but Git keeps a merge open in that folder until it is aborted or finished.
  for (const entry of latest) {
    const folder = await leftMerge(entry, records)
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

/**
 * What the thread is waiting on now, for `workspace.getStatus` and for what `operations.recover` leaves. A thread with a
 * worktree is read from `workspace.json`, verified, and only while it has a project folder (`projectPath`). A thread
 * that records into a hidden store (a folder without Git, or a standalone thread) is read through `loadOrSnapshotAsync()`,
 * so a pending operation there shows the banner too; it is never verified with Git, since its folder has none.
 */
export async function threadRecovery(threadDirectory: string, projectPath: string | undefined): Promise<WorkspaceRecovery | undefined> {
  const manager = new ThreadWorkspaceManager(threadDirectory)
  const stored = manager.load()
  if (stored) return projectPath ? describeRecovery(threadDirectory, await manager.verify(stored)) : undefined
  const snapshot = await manager.loadOrSnapshotAsync()
  return snapshot ? describeRecovery(threadDirectory, snapshot) : undefined
}

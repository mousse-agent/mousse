import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from './ThreadActionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { git, requireClean, tryGit } from './git'
import { isRecordedMerge, preserveBeforeAbort } from './leftMerge'

/** Abort only the Git sequencer belonging to the selected durable operation. */
export class ManagedConflictService {
  constructor(private readonly threadDirectory: string) {}

  /** Aborts the operation's merge or revert. Every file is kept first under the returned `refs/mousse/preserved/` ref. */
  async abort(workspacePath: string, operationId: string): Promise<{ preservedRef: string }> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'operation-abort', async () => {
      const journal = new ThreadJournal(this.threadDirectory)
      const record = journal.latestByOperation().get(operationId)
      // A merge an older version left in progress stays abortable after its record was cancelled on upgrade.
      const leftMerge = record?.state === 'cancelled' && typeof (record.details as { mergeInProgress?: unknown } | undefined)?.mergeInProgress === 'string'
      if (!record || (record.state !== 'recovery_required' && !leftMerge)) throw new Error('No matching operation conflict is active.')
      // A merge an older version left is aborted only while it is that very merge: one started later, even of the same
      // commit at the same HEAD, is the person's or the agent's. Its record is cleared so nothing offers to abort it again.
      if (leftMerge && !isRecordedMerge(workspacePath, (record.details as { mergeIdentity?: unknown }).mergeIdentity)) {
        journal.append({ operationId, operationType: record.operationType, state: 'cancelled', details: { mergeNoLongerRecorded: true } })
        throw new Error('The merge in progress is not the one an earlier version left, so Mousse left it alone.')
      }
      const merge = ['publish', 'child-integration', 'change-integration'].includes(record.operationType)
      if (!merge && !['undo', 'redo', 'code-revert'].includes(record.operationType)) throw new Error(`Abort is unavailable for ${record.operationType}`)
      const details = record.details as { preMergeSha?: string; prePublishSha?: string; preUndoSha?: string; startSha?: string; workerHeadSha?: string; currentCommit?: string; actionId?: string }
      const before = details.preMergeSha ?? details.prePublishSha ?? details.preUndoSha ?? details.startSha
      if (!before || git(workspacePath, ['rev-parse', 'HEAD']) !== before) throw new Error('Conflict HEAD changed outside the selected operation.')
      const marker = tryGit(workspacePath, ['rev-parse', '--verify', merge ? 'MERGE_HEAD' : 'REVERT_HEAD'])
      if (!marker.ok) throw new Error('The matching Git sequencer is no longer active.')
      const intent = journal.list().find((entry) => entry.operationId === operationId && ['prepared', 'running'].includes(entry.state))
      const sourceSha = (intent?.expectedPreState as { sourceSha?: string } | undefined)?.sourceSha ?? (details as { sourceSha?: string }).sourceSha
      const expected = merge ? details.workerHeadSha ?? sourceSha : details.currentCommit
      if (!expected || marker.stdout !== expected) throw new Error('Git sequencer belongs to another operation.')
      // An abort rewrites conflicted files, edits in them included: they are kept first, so nothing is lost.
      const preservedRef = preserveBeforeAbort(workspacePath, operationId)
      const result = tryGit(workspacePath, [merge ? 'merge' : 'revert', '--abort'])
      if (!result.ok) throw new Error(result.stderr || 'Unable to abort the operation conflict.')
      // The merge is gone; what else the folder holds is someone's work and stays as it is.
      if (!leftMerge) requireClean(workspacePath, 'Thread workspace after abort')
      if (['undo', 'redo'].includes(record.operationType)) {
        const actions = new ThreadActionService(this.threadDirectory)
        const all = actions.list(); const target = all.find((item) => item.id === details.actionId)
        if (target?.state === 'undo_conflict') { target.state = 'completed'; actions.replace(all) }
      }
      journal.append({ operationId, operationType: record.operationType, state: 'cancelled', details: { conflictAborted: true, beforeSha: before, preservedRef } })
      return { preservedRef }
    })
  }
}

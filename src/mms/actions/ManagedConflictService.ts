import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from './ThreadActionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { git, requireClean, tryGit } from './git'

/** Abort only the Git sequencer belonging to the selected durable operation. */
export class ManagedConflictService {
  constructor(private readonly threadDirectory: string) {}

  async abort(workspacePath: string, operationId: string): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'operation-abort', async () => {
      const journal = new ThreadJournal(this.threadDirectory)
      const record = journal.latestByOperation().get(operationId)
      if (!record || record.state !== 'recovery_required') throw new Error('No matching operation conflict is active.')
      const merge = ['publish', 'child-integration'].includes(record.operationType)
      if (!merge && !['undo', 'redo', 'code-revert'].includes(record.operationType)) throw new Error(`Abort is unavailable for ${record.operationType}`)
      const details = record.details as { preMergeSha?: string; prePublishSha?: string; preUndoSha?: string; startSha?: string; workerHeadSha?: string; currentCommit?: string; actionId?: string }
      const before = details.preMergeSha ?? details.prePublishSha ?? details.preUndoSha ?? details.startSha
      if (!before || git(workspacePath, ['rev-parse', 'HEAD']) !== before) throw new Error('Conflict HEAD changed outside the selected operation.')
      const marker = tryGit(workspacePath, ['rev-parse', '--verify', merge ? 'MERGE_HEAD' : 'REVERT_HEAD'])
      if (!marker.ok) throw new Error('The matching Git sequencer is no longer active.')
      const intent = journal.list().find((entry) => entry.operationId === operationId && ['prepared', 'running'].includes(entry.state))
      const sourceSha = (intent?.expectedPreState as { sourceSha?: string } | undefined)?.sourceSha
      const expected = merge ? details.workerHeadSha ?? sourceSha : details.currentCommit
      if (!expected || marker.stdout !== expected) throw new Error('Git sequencer belongs to another operation.')
      const result = tryGit(workspacePath, [merge ? 'merge' : 'revert', '--abort'])
      if (!result.ok) throw new Error(result.stderr || 'Unable to abort the operation conflict.')
      requireClean(workspacePath, 'Thread workspace after abort')
      if (['undo', 'redo'].includes(record.operationType)) {
        const actions = new ThreadActionService(this.threadDirectory)
        const all = actions.list(); const target = all.find((item) => item.id === details.actionId)
        if (target?.state === 'undo_conflict') { target.state = 'completed'; actions.replace(all) }
      }
      journal.append({ operationId, operationType: record.operationType, state: 'cancelled', details: { conflictAborted: true, beforeSha: before } })
    })
  }
}

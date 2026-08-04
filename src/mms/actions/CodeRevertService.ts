import { randomUUID } from 'node:crypto'
import type { ThreadAction } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from './ThreadActionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { changedPaths, commitParents, git, MOUSSE_COMMIT_ENV, requireClean, tryGit } from './git'

/** Revert an older action's code while preserving current conversation/model context. */
export class CodeRevertService {
  private readonly actions: ThreadActionService
  private readonly journal: ThreadJournal
  constructor(private readonly threadDirectory: string) {
    this.actions = new ThreadActionService(threadDirectory)
    this.journal = new ThreadJournal(threadDirectory)
  }

  async revertCode(actionId: string, workspacePath: string): Promise<ThreadAction> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'code-revert', async () => {
      requireClean(workspacePath, 'Thread workspace')
      const actions = this.actions.list(); const target = actions.find((action) => action.id === actionId)
      if (!target || !['completed', 'undone'].includes(target.state)) throw new Error('Code revert requires a completed action.')
      if (!target.reversible || target.commits.length === 0) throw new Error('The selected action has no reversible repository changes.')
      const startSha = git(workspacePath, ['rev-parse', 'HEAD']); const operationId = randomUUID()
      this.journal.append({ operationId, operationType: 'code-revert', state: 'running', expectedPreState: { startSha, actionId } })
      for (const sha of [...target.commits].reverse()) {
        const args = ['revert', '--no-commit']; if (commitParents(workspacePath, sha).length > 1) args.push('-m', '1'); args.push(sha)
        const result = tryGit(workspacePath, args)
        if (!result.ok) {
          const conflictFiles = git(workspacePath, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean)
          this.journal.append({ operationId, operationType: 'code-revert', state: 'recovery_required', details: { startSha, actionId, conflictFiles } })
          throw new Error(`Code revert conflict: ${conflictFiles.join(', ')}`)
        }
      }
      if (!tryGit(workspacePath, ['diff', '--cached', '--quiet']).ok) {
        git(workspacePath, ['commit', '--no-verify', '-m', `mousse: revert code action ${actionId}`], MOUSSE_COMMIT_ENV)
      }
      const endSha = git(workspacePath, ['rev-parse', 'HEAD'])
      const record: ThreadAction = {
        id: randomUUID(), turnId: randomUUID(), conversationBranchId: target.conversationBranchId,
        parentActionId: actions.at(-1)?.id,
        presentationMessageStart: actions.at(-1)?.presentationMessageEnd ?? 0,
        presentationMessageEnd: actions.at(-1)?.presentationMessageEnd ?? 0,
        nativeContextBoundary: actions.at(-1)?.nativeContextBoundary ?? target.nativeContextBoundary,
        startSha, endSha, commits: startSha === endSha ? [] : [endSha], childIntegrations: [],
        changedPaths: changedPaths(workspacePath, startSha, endSha), externalEffects: [], reversible: true,
        state: 'completed', createdAt: new Date().toISOString(), completedAt: new Date().toISOString()
      }
      actions.push(record); this.actions.replace(actions)
      this.journal.append({ operationId, operationType: 'code-revert', state: 'completed', details: { actionId, compensationActionId: record.id, startSha, endSha } })
      return record
    })
  }
}

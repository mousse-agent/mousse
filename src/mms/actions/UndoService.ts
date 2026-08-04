import { randomUUID } from 'node:crypto'
import type { ThreadAction } from '../../shared/threadActions'
import type { ConversationBranchId } from '../../shared/workspace'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from './ThreadActionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { changedPaths, commitParents, git, MOUSSE_COMMIT_ENV, requireClean, tryGit } from './git'

export class UndoConflictError extends Error {
  constructor(readonly files: string[]) {
    super(`Undo has conflicts in: ${files.join(', ')}`)
    this.name = 'UndoConflictError'
  }
}

export class UndoService {
  private readonly actions: ThreadActionService
  private readonly journal: ThreadJournal

  constructor(private readonly threadDirectory: string) {
    this.actions = new ThreadActionService(threadDirectory)
    this.journal = new ThreadJournal(threadDirectory)
  }

  async undoLatest(
    branchId: ConversationBranchId,
    workspacePath: string,
    signal?: AbortSignal
  ): Promise<ThreadAction> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'undo-latest', async () => {
      requireClean(workspacePath, 'Thread workspace')
      const all = this.actions.list()
      const target = all.filter((action) => action.conversationBranchId === branchId).at(-1)
      if (!target || target.state !== 'completed') throw new Error('Only the latest completed action is eligible for conversation undo.')
      const preUndoSha = git(workspacePath, ['rev-parse', 'HEAD'])
      if (preUndoSha !== target.endSha) throw new Error('Thread HEAD no longer matches the latest action.')
      target.state = 'undoing'
      this.actions.replace(all)
      const operationId = randomUUID()
      this.journal.append({
        operationId,
        operationType: 'undo',
        state: 'running',
        expectedPreState: { preUndoSha, actionId: target.id }
      })
      for (const sha of [...target.commits].reverse()) {
        const parents = commitParents(workspacePath, sha)
        const args = ['revert', '--no-commit']
        if (parents.length > 1) args.push('-m', '1')
        args.push(sha)
        const result = tryGit(workspacePath, args)
        if (!result.ok) {
          const files = git(workspacePath, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean)
          target.state = 'undo_conflict'
          this.actions.replace(all)
          this.journal.append({
            operationId,
            operationType: 'undo',
            state: 'recovery_required',
            details: { preUndoSha, actionId: target.id, currentCommit: sha, conflictFiles: files, error: result.stderr }
          })
          throw new UndoConflictError(files)
        }
      }
      const staged = !tryGit(workspacePath, ['diff', '--cached', '--quiet']).ok
      if (staged) git(workspacePath, ['commit', '--no-verify', '-m', `mousse: undo turn ${target.turnId}`], MOUSSE_COMMIT_ENV)
      const endSha = git(workspacePath, ['rev-parse', 'HEAD'])
      const compensation: ThreadAction = {
        id: randomUUID(),
        turnId: randomUUID(),
        conversationBranchId: branchId,
        parentActionId: target.parentActionId,
        presentationMessageStart: target.presentationMessageEnd,
        presentationMessageEnd: target.presentationMessageEnd,
        nativeContextBoundary: target.nativeContextBoundary,
        startSha: preUndoSha,
        endSha,
        commits: preUndoSha === endSha ? [] : [endSha],
        childIntegrations: [],
        changedPaths: changedPaths(workspacePath, preUndoSha, endSha),
        externalEffects: target.externalEffects,
        reversible: true,
        state: 'completed',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      }
      target.state = 'undone'
      target.compensationActionId = compensation.id
      all.push(compensation)
      this.actions.replace(all)
      this.journal.append({
        operationId,
        operationType: 'undo',
        state: 'completed',
        details: { actionId: target.id, compensationActionId: compensation.id, preUndoSha, endSha }
      })
      return compensation
    }, signal)
  }

  async abortConflict(branchId: ConversationBranchId, workspacePath: string): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'undo-abort', async () => {
      const all = this.actions.list()
      const target = [...all].reverse().find((action) => action.conversationBranchId === branchId && action.state === 'undo_conflict')
      if (!target) throw new Error('No matching undo conflict is active.')
      const result = tryGit(workspacePath, ['revert', '--abort'])
      if (!result.ok) throw new Error(result.stderr || 'Unable to abort matching revert')
      target.state = 'completed'
      this.actions.replace(all)
    })
  }
}

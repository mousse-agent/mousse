import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import type { ConversationBranch } from '../../shared/threadActions'
import type { ConversationBranchId } from '../../shared/workspace'
import { ThreadActionService } from './ThreadActionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { git, requireClean } from './git'

export class ConversationBranchService {
  private readonly path: string
  private readonly actions: ThreadActionService
  constructor(private readonly threadDirectory: string) {
    this.path = join(threadDirectory, 'conversation-branches.json')
    this.actions = new ThreadActionService(threadDirectory)
  }

  list(): ConversationBranch[] {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) as ConversationBranch[] : []
  }

  async fork(
    workspacePath: string,
    sourceBranchId: ConversationBranchId,
    actionId: string,
    name: string
  ): Promise<ConversationBranch> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'conversation-fork', async () => {
      requireClean(workspacePath, 'Thread workspace')
      const action = this.actions.get(actionId)
      if (!action || action.state !== 'completed') throw new Error('Fork requires a completed action.')
      if (action.conversationBranchId !== sourceBranchId) throw new Error('Action does not belong to the source conversation branch.')
      if (!action.nativeContextBoundary.safeBoundaryProof) throw new Error('The selected turn has no validated native-context boundary.')
      const id = randomUUID()
      const branch = `mousse/thread/${action.turnId}/${id}`
      const retainedRef = `refs/mousse/conversation-branches/${id}`
      git(workspacePath, ['branch', branch, action.endSha])
      git(workspacePath, ['update-ref', retainedRef, action.endSha])
      const record: ConversationBranch = {
        id,
        name,
        parentBranchId: sourceBranchId,
        parentTurnId: action.turnId,
        gitBranch: branch,
        retainedRef,
        contextBoundary: action.nativeContextBoundary,
        lifecycle: 'inactive',
        creationReason: 'fork',
        createdAt: new Date().toISOString()
      }
      const branches = this.list(); branches.push(record); atomicWriteJsonSync(this.path, branches)
      return record
    })
  }
}

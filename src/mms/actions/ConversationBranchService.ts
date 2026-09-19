import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal } from '../data/ThreadJournal'
import type { ConversationBranch } from '../../shared/threadActions'
import type { ConversationBranchId } from '../../shared/workspace'
import { ThreadActionService } from './ThreadActionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { git, requireClean } from './git'

export class ConversationBranchService {
  private readonly path: string
  private readonly actions: ThreadActionService
  private readonly journal: ThreadJournal
  constructor(private readonly threadDirectory: string) {
    this.path = join(threadDirectory, 'conversation-branches.json')
    this.actions = new ThreadActionService(threadDirectory)
    this.journal = new ThreadJournal(threadDirectory)
  }

  list(): ConversationBranch[] {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) as ConversationBranch[] : []
  }

  async activate(
    workspacePath: string,
    branchId: ConversationBranchId,
    expectedJournalRevision?: number
  ): Promise<ConversationBranch> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'conversation-activate', async () => {
      this.actions.assertExpectedRevision(expectedJournalRevision)
      requireClean(workspacePath, 'Thread workspace')
      const branches = this.list(); const selected = branches.find((branch) => branch.id === branchId)
      if (!selected || selected.lifecycle === 'tombstoned') throw new Error(`Conversation branch is unavailable: ${branchId}`)
      const operationId = randomUUID()
      this.journal.append({
        operationId,
        operationType: 'conversation-activate',
        state: 'running',
        expectedPreState: { branchId }
      })
      try {
        git(workspacePath, ['switch', selected.gitBranch])
        for (const branch of branches) branch.lifecycle = branch.id === branchId ? 'active' : 'inactive'
        atomicWriteJsonSync(this.path, branches)
        this.journal.append({
          operationId,
          operationType: 'conversation-activate',
          state: 'completed',
          details: { branchId }
        })
        return selected
      } catch (error) {
        this.journal.append({
          operationId,
          operationType: 'conversation-activate',
          state: 'failed',
          details: { branchId, error: error instanceof Error ? error.message : String(error) }
        })
        throw error
      }
    })
  }

  async fork(
    workspacePath: string,
    sourceBranchId: ConversationBranchId,
    actionId: string,
    name: string,
    expectedJournalRevision?: number
  ): Promise<ConversationBranch> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'conversation-fork', async () => {
      this.actions.assertExpectedRevision(expectedJournalRevision)
      requireClean(workspacePath, 'Thread workspace')
      const action = this.actions.get(actionId)
      if (!action || action.state !== 'completed') throw new Error('Fork requires a completed action.')
      if (action.conversationBranchId !== sourceBranchId) throw new Error('Action does not belong to the source conversation branch.')
      if (!action.nativeContextBoundary.safeBoundaryProof) throw new Error('The selected turn has no validated native-context boundary.')
      const id = randomUUID()
      const operationId = randomUUID()
      const branch = `mousse/thread/${action.turnId}/${id}`
      const retainedRef = `refs/mousse/conversation-branches/${id}`
      this.journal.append({
        operationId,
        operationType: 'conversation-fork',
        state: 'running',
        expectedPreState: { sourceBranchId, actionId }
      })
      try {
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
        const branches = this.list()
        branches.push(record)
        atomicWriteJsonSync(this.path, branches)
        this.journal.append({
          operationId,
          operationType: 'conversation-fork',
          state: 'completed',
          details: { branchId: id, actionId }
        })
        return record
      } catch (error) {
        this.journal.append({
          operationId,
          operationType: 'conversation-fork',
          state: 'failed',
          details: { actionId, error: error instanceof Error ? error.message : String(error) }
        })
        throw error
      }
    })
  }
}

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal } from '../data/ThreadJournal'
import type { ConversationBranch } from '../../shared/threadActions'
import type { ConversationBranchId } from '../../shared/workspace'
import { ThreadActionService } from './ThreadActionService'
import { UndoRetentionService } from './UndoRetentionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from './ChangeReceiptService'
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
    expectedJournalRevision?: number,
    restoreContext?: (branch: ConversationBranch) => void | Promise<void>
  ): Promise<ConversationBranch> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'conversation-activate', async () => {
      new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
      this.actions.assertExpectedRevision(expectedJournalRevision)
      requireClean(workspacePath, 'Thread workspace')
      const branches = this.list(); const selected = branches.find((branch) => branch.id === branchId)
      if (!selected || selected.lifecycle === 'tombstoned') throw new Error(`Conversation branch is unavailable: ${branchId}`)
      const operationId = randomUUID()
      this.journal.append({
        operationId,
        operationType: 'conversation-activate',
        state: 'running',
        expectedPreState: { branchId, preBranch: git(workspacePath, ['branch', '--show-current']), preSha: git(workspacePath, ['rev-parse', 'HEAD']) }
      })
      try {
        git(workspacePath, ['switch', selected.gitBranch])
        for (const branch of branches) branch.lifecycle = branch.id === branchId ? 'active' : 'inactive'
        atomicWriteJsonSync(this.path, branches)
        const manager = new ThreadWorkspaceManager(this.threadDirectory)
        const metadata = manager.load()
        if (metadata) atomicWriteJsonSync(manager.workspacePath, { ...metadata, conversationBranchId: selected.id, branch: selected.gitBranch, retainedRef: selected.retainedRef, headSha: git(workspacePath, ['rev-parse', 'HEAD']), generation: (metadata.generation ?? 0) + 1 })
        this.journal.append({ operationId, operationType: 'conversation-activate', state: 'context_pending', details: { branchId, headSha: git(workspacePath, ['rev-parse', 'HEAD']), restoreContext: Boolean(restoreContext) } })
        if (restoreContext) await restoreContext(selected)
        this.journal.append({
          operationId,
          operationType: 'conversation-activate',
          state: 'completed',
          details: { branchId }
        })
        return selected
      } catch (error) {
        if (this.journal.latestByOperation().get(operationId)?.state === 'context_pending') throw error
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

  async recoverPending(workspacePath: string, restoreContext: (branch: ConversationBranch) => void | Promise<void>, heldThreadLease?: ThreadLeaseHandle): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'branch-context-recovery', async () => {
      for (const entry of this.journal.latestByOperation().values()) {
        if (entry.operationType !== 'conversation-activate' || entry.state !== 'context_pending') continue
        const details = entry.details as { branchId: string; headSha: string; restoreContext: boolean }
        const branch = this.list().find((item) => item.id === details.branchId)
        if (!branch || git(workspacePath, ['rev-parse', 'HEAD']) !== details.headSha || git(workspacePath, ['branch', '--show-current']) !== branch.gitBranch) throw new Error('Conversation branch recovery does not match Git state.')
        if (details.restoreContext) await restoreContext(branch)
        this.journal.append({ operationId: entry.operationId, operationType: 'conversation-activate', state: 'completed', details: { branchId: branch.id, recovered: true } })
      }
    }, undefined, heldThreadLease)
  }

  async fork(
    workspacePath: string,
    sourceBranchId: ConversationBranchId,
    actionId: string,
    name: string,
    expectedJournalRevision?: number,
    codeMode: 'historical' | 'current' = 'historical'
  ): Promise<ConversationBranch> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'conversation-fork', async () => {
      this.actions.assertExpectedRevision(expectedJournalRevision)
      requireClean(workspacePath, 'Thread workspace')
      const action = this.actions.get(actionId)
      if (action?.scope === 'conversation') throw new Error('Conversation-only turns have no repository snapshot to fork.')
      if (!action || action.state !== 'completed') throw new Error('Fork requires a completed action.')
      new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
      if (codeMode === 'historical') new UndoRetentionService(this.threadDirectory).assertAvailable(action)
      if (action.conversationBranchId !== sourceBranchId) throw new Error('Action does not belong to the source conversation branch.')
      if (!action.nativeContextBoundary.safeBoundaryProof) throw new Error('The selected turn has no validated native-context boundary.')
      const id = randomUUID()
      const operationId = randomUUID()
      const branch = `mousse/thread/${action.turnId}/${id}`
      const retainedRef = `refs/mousse/conversation-branches/${id}`
      const codeSha = codeMode === 'current' ? git(workspacePath, ['rev-parse', 'HEAD']) : action.endSha
      this.journal.append({
        operationId,
        operationType: 'conversation-fork',
        state: 'running',
        expectedPreState: { sourceBranchId, actionId, codeMode, codeSha }
      })
      try {
        git(workspacePath, ['branch', branch, codeSha])
        git(workspacePath, ['update-ref', retainedRef, codeSha])
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

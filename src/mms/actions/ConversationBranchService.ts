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
import { git, refuseUnsafeChanges, treeOf } from './git'
import { moveFiles, takeSnapshot } from './snapshots'

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

  /**
   * Makes another conversation branch the active one by switching the files to the code it last had: a snapshot of
   * the files as they are is kept under the branch being left (its own uncommitted work included), then the
   * selected branch's snapshot is written over them. HEAD, the thread's Git branch and the index are not touched.
   */
  async activate(
    workspacePath: string,
    branchId: ConversationBranchId,
    expectedJournalRevision?: number,
    restoreContext?: (branch: ConversationBranch) => void | Promise<void>
  ): Promise<ConversationBranch> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'conversation-activate', async () => {
      new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
      this.actions.assertExpectedRevision(expectedJournalRevision)
      refuseUnsafeChanges(workspacePath, 'Thread workspace', { discard: true })
      const branches = this.list(); const selected = branches.find((branch) => branch.id === branchId)
      if (!selected || selected.lifecycle === 'tombstoned') throw new Error(`Conversation branch is unavailable: ${branchId}`)
      const manager = new ThreadWorkspaceManager(this.threadDirectory)
      const metadata = manager.load()
      const leaving = metadata?.conversationBranchId ?? 'main'
      const operationId = randomUUID()
      this.journal.append({
        operationId,
        operationType: 'conversation-activate',
        state: 'running',
        expectedPreState: { branchId, preBranch: git(workspacePath, ['branch', '--show-current']), preSha: git(workspacePath, ['rev-parse', 'HEAD']) }
      })
      try {
        const threadId = metadata?.threadId
        if (leaving !== selected.id) {
          // Edits made outside Mousse since the last action are recorded for the branch being left, then it keeps the files.
          const current = this.actions.recordOutsideChangesHeld({ threadId: threadId ?? '', conversationBranchId: leaving, workspacePath }).startSha
          const left = branches.find((branch) => branch.id === leaving && branch.lifecycle !== 'tombstoned')
          // The thread's first branch can't be activated again; its code stays under the thread's own ref.
          if (left) git(workspacePath, ['update-ref', left.retainedRef, current])
          const wanted = git(workspacePath, ['rev-parse', '--verify', `${selected.retainedRef}^{commit}`])
          moveFiles(git(workspacePath, ['rev-parse', '--show-toplevel']), treeOf(workspacePath, current), treeOf(workspacePath, wanted))
        }
        const snapshot = takeSnapshot(workspacePath, { reason: `activate conversation branch ${selected.id}`, threadId, operationId })
        git(workspacePath, ['update-ref', selected.retainedRef, snapshot.sha])
        for (const branch of branches) branch.lifecycle = branch.id === branchId ? 'active' : 'inactive'
        atomicWriteJsonSync(this.path, branches)
        if (metadata) atomicWriteJsonSync(manager.workspacePath, { ...metadata, conversationBranchId: selected.id, retainedRef: selected.retainedRef, snapshotSha: snapshot.sha, headSha: snapshot.head ?? metadata.headSha, generation: (metadata.generation ?? 0) + 1 })
        this.journal.append({ operationId, operationType: 'conversation-activate', state: 'context_pending', details: { branchId, snapshotSha: snapshot.sha, restoreContext: Boolean(restoreContext) } })
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
        const details = entry.details as { branchId: string; restoreContext: boolean }
        const branch = this.list().find((item) => item.id === details.branchId)
        // The files were switched before this entry was written; only the conversation side is left to restore.
        if (!branch) throw new Error('Conversation branch recovery does not match the recorded branch.')
        if (details.restoreContext) await restoreContext(branch)
        this.journal.append({ operationId: entry.operationId, operationType: 'conversation-activate', state: 'completed', details: { branchId: branch.id, recovered: true } })
      }
    }, undefined, heldThreadLease)
  }

  /**
   * Starts a conversation branch at a turn's code: the turn's end snapshot (or, for `current`, a snapshot of the files
   * now) is pinned under `refs/mousse/conversation-branches/<id>`. No Git branch is made; the files and the checkout
   * are left as they are until the branch is activated.
   */
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
      const action = this.actions.get(actionId)
      if (action?.scope === 'conversation') throw new Error('Conversation-only turns have no repository snapshot to fork.')
      if (!action || action.state !== 'completed') throw new Error('Fork requires a completed action.')
      new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
      if (codeMode === 'historical') new UndoRetentionService(this.threadDirectory).assertAvailable(action)
      if (action.conversationBranchId !== sourceBranchId) throw new Error('Action does not belong to the source conversation branch.')
      if (!action.nativeContextBoundary.safeBoundaryProof) throw new Error('The selected turn has no validated native-context boundary.')
      const id = randomUUID()
      const operationId = randomUUID()
      const retainedRef = `refs/mousse/conversation-branches/${id}`
      const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
      const codeSha = codeMode === 'current' ? takeSnapshot(workspacePath, { reason: 'fork', threadId: metadata?.threadId, operationId }).sha : action.endSha
      this.journal.append({
        operationId,
        operationType: 'conversation-fork',
        state: 'running',
        expectedPreState: { sourceBranchId, actionId, codeMode, codeSha }
      })
      try {
        git(workspacePath, ['update-ref', retainedRef, codeSha])
        const record: ConversationBranch = {
          id,
          name,
          parentBranchId: sourceBranchId,
          parentTurnId: action.turnId,
          // Conversation branches share the worktree and its Git branch; they differ in the snapshot they own.
          gitBranch: metadata?.branch ?? '',
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

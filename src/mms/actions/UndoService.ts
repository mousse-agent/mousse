import { randomUUID } from 'node:crypto'
import type { ThreadAction } from '../../shared/threadActions'
import type { ConversationBranchId } from '../../shared/workspace'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from './ThreadActionService'
import { UndoRetentionService } from './UndoRetentionService'
import { ChangeReceiptService } from './ChangeReceiptService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { changedPaths, commitParents, git, introducedCommits, MOUSSE_COMMIT_ENV, requireClean, tryGit } from './git'

export type RestoreActionContext = (action: ThreadAction, kind: 'undo' | 'redo') => void | Promise<void>
interface UndoRecovery {
  actionId: string
  preUndoSha: string
  endSha: string
  target: ThreadAction
  compensation: ThreadAction
  contextAction: ThreadAction
  kind: 'undo' | 'redo'
  restoreContext: boolean
}

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
    signal?: AbortSignal,
    expectedJournalRevision?: number,
    restoreContext?: RestoreActionContext,
    kind: 'undo' | 'redo' = 'undo',
    expectedTurnId?: string,
    validateTarget?: (action: ThreadAction) => void
  ): Promise<ThreadAction> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, kind, async () => {
      const receipts = new ChangeReceiptService(this.threadDirectory)
      receipts.assertNoPendingOperation()
      this.actions.assertExpectedRevision(expectedJournalRevision)
      requireClean(workspacePath, 'Thread workspace')
      const all = this.actions.list()
      const target = all.filter((action) => action.conversationBranchId === branchId).at(-1)
      if (!target || !['completed', 'failed', 'stopped'].includes(target.state)) throw new Error('Only the latest completed action is eligible for conversation undo.')
      if (target.scope === 'conversation') throw new Error('Conversation-only actions require conversation history restoration.')
      if (expectedTurnId !== undefined && target.turnId !== expectedTurnId) throw new Error('The requested turn is no longer the latest eligible turn.')
      validateTarget?.(target)
      if (!target.reversible) throw new Error('This action cannot be reversed safely.')
      new UndoRetentionService(this.threadDirectory).assertAvailable(target)
      const original = all.find((action) => action.compensationActionId === target.id)
      if (kind === 'redo' && (!original || original.state !== 'undone')) throw new Error('Latest action is not an undo compensation.')
      const contextAction = kind === 'redo' ? original! : target
      const sourceReceipt = receipts.list().find((item) => item.id === target.receiptId)
      if (sourceReceipt && receipts.isPublished(sourceReceipt)) throw new Error('Published changes require a new code revert, not local undo.')
      const preUndoSha = git(workspacePath, ['rev-parse', 'HEAD'])
      if (preUndoSha !== target.endSha) throw new Error('Thread HEAD no longer matches the latest action.')
      const later = receipts.list().filter((item) => sourceReceipt && item.generation > sourceReceipt.generation && item.beforeSha !== item.afterSha)
      if (later.length) throw new Error('A newer workspace change depends on this action; undo the latest change first.')
      const operationId = randomUUID()
      const compensationId = randomUUID()
      this.journal.append({ operationId, operationType: kind, state: 'prepared', expectedPreState: { preUndoSha, actionId: target.id }, details: { target, contextAction, kind, compensationId, restoreContext: Boolean(restoreContext) } })
      target.state = 'undoing'; this.actions.replace(all)
      // Derive first-parent units even for legacy records that listed child commits twice.
      for (const sha of introducedCommits(workspacePath, target.startSha, target.endSha).reverse()) {
        const args = ['revert', '--no-commit']
        if (commitParents(workspacePath, sha).length > 1) args.push('-m', '1')
        args.push(sha)
        const result = tryGit(workspacePath, args)
        if (!result.ok) {
          const files = git(workspacePath, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean)
          target.state = 'undo_conflict'; this.actions.replace(all)
          this.journal.append({ operationId, operationType: kind, state: 'recovery_required', details: { preUndoSha, actionId: target.id, currentCommit: sha, conflictFiles: files, error: result.stderr } })
          throw new UndoConflictError(files)
        }
      }
      if (!tryGit(workspacePath, ['diff', '--cached', '--quiet']).ok) {
        git(workspacePath, ['commit', '--no-verify', '-m', `mousse: ${kind} turn ${target.turnId} (${operationId})`], MOUSSE_COMMIT_ENV)
      }
      const endSha = git(workspacePath, ['rev-parse', 'HEAD'])
      const compensation: ThreadAction = {
        id: compensationId, turnId: kind === 'redo' ? contextAction.turnId : compensationId, conversationBranchId: branchId, actor: { kind: 'user' },
        parentActionId: target.id,
        presentationMessageStart: kind === 'redo' ? contextAction.presentationMessageStart : target.presentationMessageEnd,
        presentationMessageEnd: kind === 'redo' ? contextAction.presentationMessageEnd : target.presentationMessageEnd,
        nativeContextStartBoundary: contextAction.nativeContextStartBoundary ? target.nativeContextBoundary : undefined,
        nativeContextBoundary: kind === 'undo' ? target.nativeContextStartBoundary ?? target.nativeContextBoundary : contextAction.nativeContextBoundary,
        startSha: preUndoSha, endSha, commits: preUndoSha === endSha ? [] : [endSha], childIntegrations: [],
        changedPaths: changedPaths(workspacePath, preUndoSha, endSha), externalEffects: target.externalEffects,
        reversible: true, state: 'completed', createdAt: new Date().toISOString(), completedAt: new Date().toISOString()
      }
      const receipt = receipts.record(workspacePath, { operationId, kind, actor: { kind: 'user' }, actionId: compensation.id,
        beforeSha: preUndoSha, afterSha: endSha, introducedCommits: compensation.commits,
        contributions: [], externalEffects: target.externalEffects, reversesReceiptId: target.receiptId })
      compensation.receiptId = receipt.id
      target.state = 'undone'; target.compensationActionId = compensation.id
      const recovery: UndoRecovery = { actionId: target.id, preUndoSha, endSha, target, compensation, contextAction, kind, restoreContext: Boolean(restoreContext) }
      this.journal.append({ operationId, operationType: kind, state: 'git_applied', details: recovery })
      all.push(compensation); this.actions.replace(all)
      await this.completeContext(operationId, recovery, restoreContext)
      return compensation
    }, signal)
  }

  private async completeContext(operationId: string, recovery: UndoRecovery, restoreContext?: RestoreActionContext): Promise<void> {
    if (recovery.restoreContext) {
      this.journal.append({ operationId, operationType: recovery.kind, state: 'context_pending', details: recovery })
      if (!restoreContext) throw new Error(`Conversation restoration is pending for operation ${operationId}.`)
      await restoreContext(recovery.contextAction, recovery.kind)
    }
    new UndoRetentionService(this.threadDirectory).refreshPairHeld(recovery.target, recovery.compensation)
    this.journal.append({ operationId, operationType: recovery.kind, state: 'completed', details: { actionId: recovery.actionId, compensationActionId: recovery.compensation.id, preUndoSha: recovery.preUndoSha, endSha: recovery.endSha } })
  }

  /** Called before another turn and by explicit operation recovery. No Git replay. */
  async recoverPending(workspacePath: string, restoreContext: RestoreActionContext, heldThreadLease?: ThreadLeaseHandle): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'context-recovery', async () => {
      for (const record of this.journal.latestByOperation().values()) {
        if (!['undo', 'redo', 'change-undo', 'change-redo'].includes(record.operationType) || !['prepared', 'git_applied', 'context_pending'].includes(record.state)) continue
        const entries = this.journal.list().filter((item) => item.operationId === record.operationId)
        const prepared = entries.find((item) => item.state === 'prepared')
        const intent = prepared?.details as { target: ThreadAction; contextAction: ThreadAction; kind: 'undo' | 'redo'; compensationId: string; restoreContext: boolean } | undefined
        if (!intent?.target) throw new Error('Undo recovery intent is missing.')
        const head = git(workspacePath, ['rev-parse', 'HEAD'])
        requireClean(workspacePath, 'Thread workspace')
        let recovery = record.details as UndoRecovery
        if (!recovery.compensation) {
          const preUndoSha = intent.target.endSha
          const noCodeChange = intent.target.startSha === intent.target.endSha
          const knownReceipt = new ChangeReceiptService(this.threadDirectory).list().find((item) => item.operationId === record.operationId)
          const isAppliedCommit = head !== preUndoSha && commitParents(workspacePath, head)[0] === preUndoSha && git(workspacePath, ['log', '-1', '--format=%B']).includes(record.operationId)
          if (!knownReceipt && !isAppliedCommit && !noCodeChange) {
            if (head !== preUndoSha) throw new Error('Undo recovery HEAD changed outside the recorded operation.')
            const all = this.actions.list(); const target = all.find((item) => item.id === intent.target.id)
            if (target) { target.state = intent.target.state; this.actions.replace(all) }
            this.journal.append({ operationId: record.operationId, operationType: intent.kind, state: 'cancelled', details: { recoveredBeforeGit: true } })
            continue
          }
          if (knownReceipt && knownReceipt.afterSha !== head) throw new Error('Undo recovery HEAD does not match its receipt.')
          if (git(workspacePath, ['rev-parse', `${head}^{tree}`]) !== git(workspacePath, ['rev-parse', `${intent.target.startSha}^{tree}`])) throw new Error('Undo recovery tree does not match its intended result.')
          const target = { ...intent.target, state: 'undone' as const, compensationActionId: intent.compensationId }
          const compensation: ThreadAction = {
            id: intent.compensationId, turnId: intent.kind === 'redo' ? intent.contextAction.turnId : intent.compensationId, conversationBranchId: target.conversationBranchId,
            actor: { kind: 'user' }, parentActionId: target.id,
            presentationMessageStart: intent.kind === 'redo' ? intent.contextAction.presentationMessageStart : target.presentationMessageEnd,
            presentationMessageEnd: intent.kind === 'redo' ? intent.contextAction.presentationMessageEnd : target.presentationMessageEnd,
            nativeContextStartBoundary: intent.contextAction.nativeContextStartBoundary ? target.nativeContextBoundary : undefined,
            nativeContextBoundary: intent.kind === 'undo' ? target.nativeContextStartBoundary ?? target.nativeContextBoundary : intent.contextAction.nativeContextBoundary,
            startSha: preUndoSha, endSha: head, commits: head === preUndoSha ? [] : [head], childIntegrations: [],
            changedPaths: changedPaths(workspacePath, preUndoSha, head), externalEffects: target.externalEffects,
            reversible: true, state: 'completed', createdAt: prepared!.createdAt, completedAt: new Date().toISOString()
          }
          const receipt = new ChangeReceiptService(this.threadDirectory).record(workspacePath, { operationId: record.operationId, kind: intent.kind, actor: { kind: 'user' }, actionId: compensation.id, beforeSha: preUndoSha, afterSha: head, introducedCommits: compensation.commits, contributions: [], externalEffects: target.externalEffects, reversesReceiptId: target.receiptId })
          compensation.receiptId = receipt.id
          recovery = { actionId: target.id, preUndoSha, endSha: head, target, compensation, contextAction: intent.contextAction, kind: intent.kind, restoreContext: intent.restoreContext }
          this.journal.append({ operationId: record.operationId, operationType: intent.kind, state: 'git_applied', details: recovery })
        }
        if (head !== recovery.endSha) throw new Error('Undo recovery HEAD does not match the recorded result.')
        const all = this.actions.list()
        const index = all.findIndex((item) => item.id === recovery.target.id)
        if (index < 0) throw new Error('Undo recovery target is missing.')
        all[index] = recovery.target
        if (!all.some((item) => item.id === recovery.compensation.id)) all.push(recovery.compensation)
        this.actions.replace(all)
        await this.completeContext(record.operationId, recovery, restoreContext)
      }
    }, undefined, heldThreadLease)
  }

  async abortConflict(branchId: ConversationBranchId, workspacePath: string): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'undo-abort', async () => {
      const all = this.actions.list()
      const target = [...all].reverse().find((action) => action.conversationBranchId === branchId && action.state === 'undo_conflict')
      if (!target) throw new Error('No matching undo conflict is active.')
      const unresolved = [...this.journal.latestByOperation().values()].reverse().find((record) =>
        ['undo', 'redo'].includes(record.operationType) && record.state === 'recovery_required' && (record.details as { actionId?: string })?.actionId === target.id)
      if (!unresolved) throw new Error('Matching undo operation is missing.')
      const result = tryGit(workspacePath, ['revert', '--abort'])
      if (!result.ok) throw new Error(result.stderr || 'Unable to abort matching revert')
      target.state = 'completed'; this.actions.replace(all)
      this.journal.append({ operationId: unresolved.operationId, operationType: unresolved.operationType, state: 'cancelled', details: { actionId: target.id, conflictAborted: true } })
    })
  }
}

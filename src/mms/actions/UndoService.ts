import { AppError, knownAppError } from '../../shared/errors'
import { randomUUID } from 'node:crypto'
import type { ThreadAction } from '../../shared/threadActions'
import type { ConversationBranchId } from '../../shared/workspace'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from './ThreadActionService'
import { UndoRetentionService } from './UndoRetentionService'
import { ChangeReceiptService } from './ChangeReceiptService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { changedPaths, commitParents, git, refuseUnsafeChanges, treeOf } from './git'
import { describeGit, pushedNotice, leftAsIsNotice, preservedNotice, coverageNotice, pushedTo, restoreChange, sameTree, snapshotOrigin, takeSnapshot, worktreeTree, type Snapshot } from './snapshots'

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

/** What `prepared` records: everything recovery needs to tell whether the files were changed. */
interface UndoIntent {
  target: ThreadAction
  contextAction: ThreadAction
  kind: 'undo' | 'redo'
  compensationId: string
  restoreContext: boolean
  /** The snapshot of the files before the restore; absent in intents written before snapshots. */
  ours?: string
  /** The tree the restore turns the files into. */
  expectedTree?: string
}

/** Edits made since the action overlap with it: nothing was changed, and the files are named for the person. */
export class UndoConflictError extends AppError {
  constructor(readonly files: string[], operation = 'Undo') {
    super({
      code: 'restore_conflict',
      message: `${operation} would overwrite edits made since in: ${files.join(', ') || 'some files'}. Nothing was changed. Move those edits aside or undo the later changes first.`,
      details: { files }, errorInfo: { category: 'conflict', retryable: false }
    })
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

  /**
   * Takes back the latest action's code by a three-way merge of the files (docs/workspace-snapshots.md): from the
   * action's end snapshot, onto the files as they are now, towards its start snapshot. Redo is the same step on the
   * undo's compensation action. Commits, HEAD, branches and the index are never touched, so edits made since the
   * action survive unless they overlap with it, in which case nothing changes and the files are named.
   */
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
      // A merge or rebase waiting in the worktree is not Mousse's to disturb.
      refuseUnsafeChanges(workspacePath, 'Thread workspace', { discard: true })
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
      if (sourceReceipt && receipts.isPublished(sourceReceipt)) throw knownAppError({ code: 'published_changes', message: 'Published changes require a new code revert, not local undo.' }, { category: 'conflict', retryable: false })
      const later = receipts.list().filter((item) => sourceReceipt && item.generation > sourceReceipt.generation && !sameTree(workspacePath, item.beforeSha, item.afterSha))
      if (later.length) throw new Error('A newer workspace change depends on this action; undo the latest change first.')
      const operationId = randomUUID()
      const compensationId = randomUUID()
      const label = kind === 'redo' ? 'Redo' : 'Undo'
      // The files as they are now, including edits made since the action: they are part of the merge, so they stay.
      const threadId = new ThreadWorkspaceManager(this.threadDirectory).load()?.threadId
      const ours = takeSnapshot(workspacePath, { reason: `before ${kind}`, threadId, operationId })
      const restored = restoreChange(workspacePath, { reason: `${kind} turn ${target.turnId}`, threadId, operationId, base: target.endSha, ours: ours.sha, theirs: target.startSha, restoredTo: kind === 'redo' ? 'before the Undo' : 'at the start of the turn' }, (expectedTree) => {
        const intent: UndoIntent = { target, contextAction, kind, compensationId, restoreContext: Boolean(restoreContext), ours: ours.sha, expectedTree }
        this.journal.append({ operationId, operationType: kind, state: 'prepared', expectedPreState: { preUndoSha: ours.sha, actionId: target.id }, details: intent })
        target.state = 'undoing'; this.actions.replace(all)
      })
      if ('conflicts' in restored) throw new UndoConflictError(restored.conflicts)
      const pushed = pushedTo(workspacePath, target.commits)
      const compensation = this.compensationFor(workspacePath, { target, contextAction, kind, compensationId }, ours.sha, restored.snapshot, new Date().toISOString(), [pushed ? pushedNotice(label, pushed) : '', restored.preserved ? preservedNotice(restored.preserved) : '', leftAsIsNotice(restored.leftAsIs) ?? '', coverageNotice(target.git?.coverageGaps, ours.coverageGaps, restored.snapshot.coverageGaps) ?? ''].filter(Boolean).join(' ') || undefined)
      const receipt = receipts.record(workspacePath, { operationId, kind, actor: { kind: 'user' }, actionId: compensation.id,
        beforeSha: ours.sha, afterSha: restored.snapshot.sha, introducedCommits: [],
        contributions: [], externalEffects: target.externalEffects, reversesReceiptId: target.receiptId, git: compensation.git })
      compensation.receiptId = receipt.id
      target.state = 'undone'; target.compensationActionId = compensation.id
      const recovery: UndoRecovery = { actionId: target.id, preUndoSha: ours.sha, endSha: restored.snapshot.sha, target, compensation, contextAction, kind, restoreContext: Boolean(restoreContext) }
      this.journal.append({ operationId, operationType: kind, state: 'git_applied', details: recovery })
      all.push(compensation); this.actions.replace(all)
      await this.completeContext(operationId, recovery, restoreContext)
      return compensation
    }, signal)
  }

  /** The action that records a restore: from the files before it to the files after it. */
  private compensationFor(workspacePath: string, intent: Pick<UndoIntent, 'target' | 'contextAction' | 'kind' | 'compensationId'>, startSha: string, end: Snapshot, createdAt: string, notice?: string): ThreadAction {
    const { target, contextAction, kind } = intent
    return {
      id: intent.compensationId, turnId: kind === 'redo' ? contextAction.turnId : intent.compensationId, conversationBranchId: target.conversationBranchId, actor: { kind: 'user' },
      parentActionId: target.id,
      presentationMessageStart: kind === 'redo' ? contextAction.presentationMessageStart : target.presentationMessageEnd,
      presentationMessageEnd: kind === 'redo' ? contextAction.presentationMessageEnd : target.presentationMessageEnd,
      nativeContextStartBoundary: contextAction.nativeContextStartBoundary ? target.nativeContextBoundary : undefined,
      nativeContextBoundary: kind === 'undo' ? target.nativeContextStartBoundary ?? target.nativeContextBoundary : contextAction.nativeContextBoundary,
      startSha, endSha: end.sha, commits: [], childIntegrations: [],
      changedPaths: changedPaths(workspacePath, startSha, end.sha), externalEffects: target.externalEffects,
      git: describeGit(workspacePath, startSha, end).record, ...(notice ? { notice } : {}),
      reversible: true, state: 'completed', createdAt, completedAt: new Date().toISOString()
    }
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

  /** Called before another turn and by explicit operation recovery. The restore is never replayed: the files tell whether it landed. */
  async recoverPending(workspacePath: string, restoreContext: RestoreActionContext, heldThreadLease?: ThreadLeaseHandle): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'context-recovery', async () => {
      for (const record of this.journal.latestByOperation().values()) {
        if (!['undo', 'redo', 'change-undo', 'change-redo'].includes(record.operationType) || !['prepared', 'git_applied', 'context_pending'].includes(record.state)) continue
        const entries = this.journal.list().filter((item) => item.operationId === record.operationId)
        const prepared = entries.find((item) => item.state === 'prepared')
        const intent = prepared?.details as UndoIntent | undefined
        if (!intent?.target) throw new Error('Undo recovery intent is missing.')
        let recovery = record.details as UndoRecovery
        if (!recovery.compensation) {
          const applied = intent.ours ? this.provenApplied(workspacePath, record.operationId, intent) : this.legacyApplied(workspacePath, record.operationId, intent)
          if (!applied) {
            const all = this.actions.list(); const target = all.find((item) => item.id === intent.target.id)
            if (target) { target.state = intent.target.state; this.actions.replace(all) }
            this.journal.append({ operationId: record.operationId, operationType: intent.kind, state: 'cancelled', details: { recoveredBeforeGit: true } })
            continue
          }
          const target = { ...intent.target, state: 'undone' as const, compensationActionId: intent.compensationId }
          const compensation = this.compensationFor(workspacePath, { target, contextAction: intent.contextAction, kind: intent.kind, compensationId: intent.compensationId }, applied.startSha, applied.end, prepared!.createdAt)
          const receipts = new ChangeReceiptService(this.threadDirectory)
          const known = receipts.list().find((item) => item.operationId === record.operationId)
          const receipt = known ? receipts.replay(workspacePath, known) : receipts.record(workspacePath, { operationId: record.operationId, kind: intent.kind, actor: { kind: 'user' }, actionId: compensation.id, beforeSha: applied.startSha, afterSha: applied.end.sha, introducedCommits: compensation.commits, contributions: [], externalEffects: target.externalEffects, reversesReceiptId: target.receiptId, ...(compensation.git ? { git: compensation.git } : {}) })
          compensation.receiptId = receipt.id
          recovery = { actionId: target.id, preUndoSha: applied.startSha, endSha: applied.end.sha, target, compensation, contextAction: intent.contextAction, kind: intent.kind, restoreContext: intent.restoreContext }
          this.journal.append({ operationId: record.operationId, operationType: intent.kind, state: 'git_applied', details: recovery })
        }
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

  /**
   * Whether an interrupted restore landed, read from the files: the receipt when it was recorded; otherwise the files
   * match the planned result (landed) or still match the snapshot before it (did not). Anything else is not Mousse's
   * to guess at, so recovery stays pending for a person to look at.
   */
  private provenApplied(workspacePath: string, operationId: string, intent: UndoIntent): { startSha: string; end: Snapshot } | undefined {
    const known = new ChangeReceiptService(this.threadDirectory).list().find((item) => item.operationId === operationId)
    if (known) return { startSha: known.beforeSha, end: { sha: known.afterSha, tree: treeOf(workspacePath, known.afterSha), ...snapshotOrigin(workspacePath, known.afterSha) } }
    const current = worktreeTree(workspacePath)
    if (current === intent.expectedTree) return { startSha: intent.ours!, end: takeSnapshot(workspacePath, { reason: `${intent.kind} turn ${intent.target.turnId}`, operationId }) }
    if (current === treeOf(workspacePath, intent.ours!)) return undefined
    throw new Error('Undo recovery found files that match neither the state before nor the state after the restore; resolve the differences by hand.')
  }

  /** The proof for an intent written before snapshots: the restore was a commit on the branch. */
  private legacyApplied(workspacePath: string, operationId: string, intent: UndoIntent): { startSha: string; end: Snapshot } | undefined {
    const head = git(workspacePath, ['rev-parse', 'HEAD'])
    const preUndoSha = intent.target.endSha
    const known = new ChangeReceiptService(this.threadDirectory).list().find((item) => item.operationId === operationId)
    const landed = head !== preUndoSha && commitParents(workspacePath, head)[0] === preUndoSha && git(workspacePath, ['log', '-1', '--format=%B']).includes(operationId)
    if (!known && !landed && intent.target.startSha !== intent.target.endSha) {
      if (head !== preUndoSha) throw new Error('Undo recovery HEAD changed outside the recorded operation.')
      return undefined
    }
    return { startSha: preUndoSha, end: { sha: head, tree: treeOf(workspacePath, head), head } }
  }
}

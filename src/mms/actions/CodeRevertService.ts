import { randomUUID } from 'node:crypto'
import type { ThreadAction } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from './ThreadActionService'
import { UndoRetentionService } from './UndoRetentionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from './ChangeReceiptService'
import { changedPaths, commitParents, git, refuseUnsafeChanges, treeOf } from './git'
import { UndoConflictError } from './UndoService'
import { describeGit, pushedNotice, leftAsIsNotice, preservedNotice, coverageNotice, pushedTo, restoreChange, sameTree, snapshotOrigin, takeSnapshot, worktreeTree, type Snapshot } from './snapshots'

/** What `prepared` records: the files before the revert and the tree they become. */
interface RevertIntent {
  target: ThreadAction
  latest?: ThreadAction
  /** The snapshot of the files before the revert; absent in intents written before snapshots. */
  ours?: string
  expectedTree?: string
}

/** Revert an older action's code while preserving current conversation/model context. */
export class CodeRevertService {
  private readonly actions: ThreadActionService
  private readonly journal: ThreadJournal
  constructor(private readonly threadDirectory: string) {
    this.actions = new ThreadActionService(threadDirectory)
    this.journal = new ThreadJournal(threadDirectory)
  }

  /**
   * Takes an older action's code back by the same three-way file merge as Undo (from the action's end snapshot, onto
   * the files as they are, towards its start snapshot). Later work stays unless it overlaps, in which case nothing
   * changes and the conflicting files are named. No commit is made and HEAD does not move.
   */
  async revertCode(
    actionId: string,
    workspacePath: string,
    expectedJournalRevision?: number
  ): Promise<ThreadAction> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'code-revert', async () => {
      new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
      this.actions.assertExpectedRevision(expectedJournalRevision)
      refuseUnsafeChanges(workspacePath, 'Thread workspace', { discard: true })
      const actions = this.actions.list(); const target = actions.find((action) => action.id === actionId)
      if (target?.scope === 'conversation') throw new Error('Conversation-only turns have no repository changes to revert.')
      if (!target || target.state !== 'completed') throw new Error('Code revert requires a completed action.')
      new UndoRetentionService(this.threadDirectory).assertAvailable(target)
      const workspace = new ThreadWorkspaceManager(this.threadDirectory).load()
      if (workspace && target.conversationBranchId !== workspace.conversationBranchId) throw new Error('Code revert requires an action on the active conversation branch.')
      const receipts = new ChangeReceiptService(this.threadDirectory)
      if (target.receiptId && receipts.list().some((item) => item.contributions.some((contribution) => contribution.receiptId === target.receiptId))) throw new Error('This change belongs to a completed parent action; revert the parent boundary instead.')
      if (!target.reversible || sameTree(workspacePath, target.startSha, target.endSha)) throw new Error('The selected action has no reversible repository changes.')
      const operationId = randomUUID()
      const threadId = workspace?.threadId
      // The files as they are now, including edits made since: they are part of the merge, so they stay.
      const ours = takeSnapshot(workspacePath, { reason: 'before code revert', threadId, operationId })
      const restored = restoreChange(workspacePath, { reason: `revert code action ${actionId}`, threadId, operationId, base: target.endSha, ours: ours.sha, theirs: target.startSha, restoredTo: 'at the start of the turn' }, (expectedTree) => {
        const intent: RevertIntent = { target, latest: actions.at(-1), ours: ours.sha, expectedTree }
        this.journal.append({ operationId, operationType: 'code-revert', state: 'prepared', expectedPreState: { startSha: ours.sha, actionId }, details: intent })
      })
      if ('conflicts' in restored) throw new UndoConflictError(restored.conflicts, 'The code revert')
      const pushed = pushedTo(workspacePath, target.commits)
      return this.complete(workspacePath, operationId, { target, latest: actions.at(-1) }, ours.sha, restored.snapshot, new Date().toISOString(), [pushed ? pushedNotice('Revert', pushed) : '', restored.preserved ? preservedNotice(restored.preserved) : '', leftAsIsNotice(restored.leftAsIs) ?? '', coverageNotice(target.git?.coverageGaps, ours.coverageGaps, restored.snapshot.coverageGaps) ?? ''].filter(Boolean).join(' ') || undefined)
    })
  }

  /** Records the revert as an action and a receipt, and ends its journal entry. */
  private complete(workspacePath: string, operationId: string, intent: RevertIntent, startSha: string, end: Snapshot, createdAt: string, notice?: string): ThreadAction {
    const { target, latest } = intent
    const record: ThreadAction = {
      id: operationId, turnId: operationId, conversationBranchId: target.conversationBranchId,
      parentActionId: latest?.id,
      presentationMessageStart: latest?.presentationMessageEnd ?? 0,
      presentationMessageEnd: latest?.presentationMessageEnd ?? 0,
      nativeContextBoundary: latest?.nativeContextBoundary ?? target.nativeContextBoundary,
      startSha, endSha: end.sha, commits: [], childIntegrations: [],
      changedPaths: changedPaths(workspacePath, startSha, end.sha), externalEffects: target.externalEffects, reversible: true,
      git: describeGit(workspacePath, startSha, end).record, ...(notice ? { notice } : {}),
      state: 'completed', createdAt, completedAt: new Date().toISOString()
    }
    const receipts = new ChangeReceiptService(this.threadDirectory)
    const existing = receipts.list().find((item) => item.operationId === operationId)
    const receipt = existing ? receipts.replay(workspacePath, existing) : receipts.record(workspacePath, {
      operationId, kind: 'revert', actor: { kind: 'user' }, actionId: record.id,
      beforeSha: startSha, afterSha: end.sha, introducedCommits: [],
      contributions: [], externalEffects: target.externalEffects, reversesReceiptId: target.receiptId, git: record.git
    })
    record.receiptId = receipt.id
    const actions = this.actions.list()
    if (!actions.some((item) => item.id === record.id)) { actions.push(record); this.actions.replace(actions) }
    this.journal.append({ operationId, operationType: 'code-revert', state: 'completed', details: { actionId: target.id, compensationActionId: record.id, startSha, endSha: end.sha } })
    return record
  }

  async recoverPending(workspacePath: string, heldThreadLease?: ThreadLeaseHandle): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'code-revert-recovery', async () => {
      const receipts = new ChangeReceiptService(this.threadDirectory)
      for (const entry of this.journal.latestByOperation().values()) {
        if (!['code-revert', 'change-revert'].includes(entry.operationType) || !['prepared', 'git_applied'].includes(entry.state)) continue
        const intent = this.journal.list().find((item) => item.operationId === entry.operationId && item.state === 'prepared')
        const expected = intent?.expectedPreState as { startSha: string; actionId: string } | undefined
        const details = intent?.details as RevertIntent | undefined
        if (!expected || !details?.target) throw new Error('Code revert recovery intent is missing.')
        const prior = receipts.list().find((item) => item.operationId === entry.operationId)
        const applied = details.ours ? this.provenApplied(workspacePath, entry.operationId, details, prior) : this.legacyApplied(workspacePath, entry.operationId, expected.startSha, prior)
        if (!applied) {
          this.journal.append({ operationId: entry.operationId, operationType: 'code-revert', state: 'cancelled', details: { recoveredBeforeGit: true } })
          continue
        }
        this.complete(workspacePath, entry.operationId, details, applied.startSha, applied.end, intent!.createdAt)
      }
    }, undefined, heldThreadLease)
  }

  /**
   * Whether an interrupted revert landed, read from the files: the receipt when it was recorded; otherwise the files
   * match the planned result (landed) or still match the snapshot before it (did not). Anything else is left for
   * a person to look at.
   */
  private provenApplied(workspacePath: string, operationId: string, details: RevertIntent, prior?: { beforeSha: string; afterSha: string }): { startSha: string; end: Snapshot } | undefined {
    if (prior) return { startSha: prior.beforeSha, end: { sha: prior.afterSha, tree: treeOf(workspacePath, prior.afterSha), ...snapshotOrigin(workspacePath, prior.afterSha) } }
    const current = worktreeTree(workspacePath)
    if (current === details.expectedTree) return { startSha: details.ours!, end: takeSnapshot(workspacePath, { reason: `revert code action ${details.target.id}`, operationId }) }
    if (current === treeOf(workspacePath, details.ours!)) return undefined
    throw new Error('Code revert recovery found files that match neither the state before nor the state after the revert; resolve the differences by hand.')
  }

  /** The proof for an intent written before snapshots: the revert was a commit on the branch. */
  private legacyApplied(workspacePath: string, operationId: string, startSha: string, prior?: { afterSha: string }): { startSha: string; end: Snapshot } | undefined {
    const head = git(workspacePath, ['rev-parse', 'HEAD'])
    if (!prior && head === startSha) return undefined
    if (prior ? prior.afterSha !== head : commitParents(workspacePath, head)[0] !== startSha || !git(workspacePath, ['log', '-1', '--format=%B']).includes(operationId)) throw new Error('Code revert recovery HEAD does not match the operation.')
    return { startSha, end: { sha: head, tree: treeOf(workspacePath, head), head } }
  }
}

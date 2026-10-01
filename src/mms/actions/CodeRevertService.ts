import { randomUUID } from 'node:crypto'
import type { ThreadAction } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from './ThreadActionService'
import { UndoRetentionService } from './UndoRetentionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from './ChangeReceiptService'
import { changedPaths, commitParents, git, introducedCommits, MOUSSE_COMMIT_ENV, requireClean, tryGit } from './git'

/** Revert an older action's code while preserving current conversation/model context. */
export class CodeRevertService {
  private readonly actions: ThreadActionService
  private readonly journal: ThreadJournal
  constructor(private readonly threadDirectory: string) {
    this.actions = new ThreadActionService(threadDirectory)
    this.journal = new ThreadJournal(threadDirectory)
  }

  async revertCode(
    actionId: string,
    workspacePath: string,
    expectedJournalRevision?: number
  ): Promise<ThreadAction> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'code-revert', async () => {
      new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
      this.actions.assertExpectedRevision(expectedJournalRevision)
      requireClean(workspacePath, 'Thread workspace')
      const actions = this.actions.list(); const target = actions.find((action) => action.id === actionId)
      if (target?.scope === 'conversation') throw new Error('Conversation-only turns have no repository changes to revert.')
      if (!target || target.state !== 'completed') throw new Error('Code revert requires a completed action.')
      new UndoRetentionService(this.threadDirectory).assertAvailable(target)
      const workspace = new ThreadWorkspaceManager(this.threadDirectory).load()
      if (workspace && target.conversationBranchId !== workspace.conversationBranchId) throw new Error('Code revert requires an action on the active conversation branch.')
      const receipts = new ChangeReceiptService(this.threadDirectory)
      if (target.receiptId && receipts.list().some((item) => item.contributions.some((contribution) => contribution.receiptId === target.receiptId))) throw new Error('This change belongs to a completed parent action; revert the parent boundary instead.')
      if (!target.reversible || target.commits.length === 0) throw new Error('The selected action has no reversible repository changes.')
      const startSha = git(workspacePath, ['rev-parse', 'HEAD']); const operationId = randomUUID()
      this.journal.append({ operationId, operationType: 'code-revert', state: 'prepared', expectedPreState: { startSha, actionId }, details: { target, latest: actions.at(-1) } })
      for (const sha of introducedCommits(workspacePath, target.startSha, target.endSha).reverse()) {
        const args = ['revert', '--no-commit']; if (commitParents(workspacePath, sha).length > 1) args.push('-m', '1'); args.push(sha)
        const result = tryGit(workspacePath, args)
        if (!result.ok) {
          const conflictFiles = git(workspacePath, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean)
          this.journal.append({ operationId, operationType: 'code-revert', state: 'recovery_required', details: { startSha, actionId, currentCommit: sha, conflictFiles } })
          throw new Error(`Code revert conflict: ${conflictFiles.join(', ')}`)
        }
      }
      if (!tryGit(workspacePath, ['diff', '--cached', '--quiet']).ok) {
        git(workspacePath, ['commit', '--no-verify', '-m', `mousse: revert code action ${actionId} (${operationId})`], MOUSSE_COMMIT_ENV)
      }
      const endSha = git(workspacePath, ['rev-parse', 'HEAD'])
      const record: ThreadAction = {
        id: operationId, turnId: operationId, conversationBranchId: target.conversationBranchId,
        parentActionId: actions.at(-1)?.id,
        presentationMessageStart: actions.at(-1)?.presentationMessageEnd ?? 0,
        presentationMessageEnd: actions.at(-1)?.presentationMessageEnd ?? 0,
        nativeContextBoundary: actions.at(-1)?.nativeContextBoundary ?? target.nativeContextBoundary,
        startSha, endSha, commits: startSha === endSha ? [] : [endSha], childIntegrations: [],
        changedPaths: changedPaths(workspacePath, startSha, endSha), externalEffects: target.externalEffects, reversible: true,
        state: 'completed', createdAt: new Date().toISOString(), completedAt: new Date().toISOString()
      }
      const receipt = new ChangeReceiptService(this.threadDirectory).record(workspacePath, {
        operationId, kind: 'revert', actor: { kind: 'user' }, actionId: record.id,
        beforeSha: startSha, afterSha: endSha, introducedCommits: record.commits,
        contributions: [], externalEffects: target.externalEffects, reversesReceiptId: target.receiptId
      })
      record.receiptId = receipt.id
      actions.push(record); this.actions.replace(actions)
      this.journal.append({ operationId, operationType: 'code-revert', state: 'completed', details: { actionId, compensationActionId: record.id, startSha, endSha } })
      return record
    })
  }
  async recoverPending(workspacePath: string, heldThreadLease?: ThreadLeaseHandle): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'code-revert-recovery', async () => {
      const receipts = new ChangeReceiptService(this.threadDirectory)
      for (const entry of this.journal.latestByOperation().values()) {
        if (!['code-revert', 'change-revert'].includes(entry.operationType) || !['prepared', 'git_applied'].includes(entry.state)) continue
        const intent = this.journal.list().find((item) => item.operationId === entry.operationId && item.state === 'prepared')
        const expected = intent?.expectedPreState as { startSha: string; actionId: string } | undefined
        const details = intent?.details as { target: ThreadAction; latest?: ThreadAction } | undefined
        if (!expected || !details?.target) throw new Error('Code revert recovery intent is missing.')
        requireClean(workspacePath, 'Thread workspace')
        const head = git(workspacePath, ['rev-parse', 'HEAD'])
        const prior = receipts.list().find((item) => item.operationId === entry.operationId)
        if (!prior && head === expected.startSha) {
          this.journal.append({ operationId: entry.operationId, operationType: 'code-revert', state: 'cancelled', details: { recoveredBeforeGit: true } })
          continue
        }
        if (prior ? prior.afterSha !== head : commitParents(workspacePath, head)[0] !== expected.startSha || !git(workspacePath, ['log', '-1', '--format=%B']).includes(entry.operationId)) throw new Error('Code revert recovery HEAD does not match the operation.')
        const target = details.target
        const record: ThreadAction = {
          id: entry.operationId, turnId: entry.operationId, conversationBranchId: target.conversationBranchId,
          parentActionId: details.latest?.id, presentationMessageStart: details.latest?.presentationMessageEnd ?? 0,
          presentationMessageEnd: details.latest?.presentationMessageEnd ?? 0,
          nativeContextBoundary: details.latest?.nativeContextBoundary ?? target.nativeContextBoundary,
          startSha: expected.startSha, endSha: head, commits: head === expected.startSha ? [] : [head], childIntegrations: [],
          changedPaths: changedPaths(workspacePath, expected.startSha, head), externalEffects: target.externalEffects,
          reversible: true, state: 'completed', createdAt: intent!.createdAt, completedAt: new Date().toISOString()
        }
        const receipt = receipts.record(workspacePath, { operationId: entry.operationId, kind: 'revert', actor: { kind: 'user' }, actionId: record.id, beforeSha: record.startSha, afterSha: head, introducedCommits: record.commits, contributions: [], externalEffects: target.externalEffects, reversesReceiptId: target.receiptId })
        record.receiptId = receipt.id
        const all = this.actions.list()
        if (!all.some((item) => item.id === record.id)) { all.push(record); this.actions.replace(all) }
        this.journal.append({ operationId: entry.operationId, operationType: 'code-revert', state: 'completed', details: { actionId: target.id, compensationActionId: record.id, startSha: record.startSha, endSha: head } })
      }
    }, undefined, heldThreadLease)
  }

}

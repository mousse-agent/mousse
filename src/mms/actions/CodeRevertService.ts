import { randomUUID } from 'node:crypto'
import type { ThreadAction } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from './ThreadActionService'
import { UndoRetentionService } from './UndoRetentionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from './ChangeReceiptService'
import { changedPathsAsync, commitParentsAsync, gitAsync, refuseUnsafeChangesAsync, treeOfAsync } from './git'
import { UndoConflictError } from './UndoService'
import { describeGitAsync, exactBytesNotice, gitLeftInPlaceNoticeAsync, leftAsIsNotice, preservedNotice, coverageNotice, namedGapsAsync, restoreChangeAsync, sameTreeAsync, moveOutcome, moveProgressAsync, plannedExactAsync, plannedExactGapsAsync, recordedSnapshotAsync, snapshotOfTreeAsync, takeSnapshotAsync, type Snapshot } from './snapshots'

/** What `prepared` records: the files before the revert and the tree they become. */
interface RevertIntent {
  target: ThreadAction
  latest?: ThreadAction
  /** The snapshot of the files before the revert; absent in intents written before snapshots. */
  ours?: string
  expectedTree?: string
  /** Its exact tree (see `snapshots.ts`), when the revert was exact; absent in intents written before. */
  expectedExactTree?: string
  /** What the turn did to Git that the revert leaves in place (`gitLeftInPlaceNotice`), so a recovered revert says it too. */
  gitNotice?: string
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
      await refuseUnsafeChangesAsync(workspacePath, 'Thread workspace', { discard: true })
      const actions = this.actions.list(); const target = actions.find((action) => action.id === actionId)
      if (target?.scope === 'conversation') throw new Error('Conversation-only turns have no repository changes to revert.')
      if (!target || target.state !== 'completed') throw new Error('Code revert requires a completed action.')
      new UndoRetentionService(this.threadDirectory).assertAvailable(target)
      const workspace = new ThreadWorkspaceManager(this.threadDirectory).load()
      if (workspace && target.conversationBranchId !== workspace.conversationBranchId) throw new Error('Code revert requires an action on the active conversation branch.')
      const receipts = new ChangeReceiptService(this.threadDirectory)
      if (target.receiptId && receipts.list().some((item) => item.contributions.some((contribution) => contribution.receiptId === target.receiptId))) throw new Error('This change belongs to a completed parent action; revert the parent boundary instead.')
      if (!target.reversible || await sameTreeAsync(workspacePath, target.startSha, target.endSha)) throw new Error('The selected action has no reversible repository changes.')
      const operationId = randomUUID()
      const threadId = workspace?.threadId
      // The files as they are now, including edits made since: they are part of the merge, so they stay.
      const ours = await takeSnapshotAsync(workspacePath, { reason: 'before code revert', threadId, operationId })
      const gitNotice = await gitLeftInPlaceNoticeAsync(workspacePath, 'Revert', target)
      const restored = await restoreChangeAsync(workspacePath, { reason: `revert code action ${actionId}`, threadId, operationId, base: target.endSha, ours: ours.sha, theirs: target.startSha, restoredTo: 'at the start of the turn', keep: { owner: this.threadDirectory, action: 'Revert' } }, (expectedTree, expectedExactTree) => {
        const intent: RevertIntent = { target, latest: actions.at(-1), ours: ours.sha, expectedTree, ...(expectedExactTree ? { expectedExactTree } : {}), ...(gitNotice ? { gitNotice } : {}) }
        this.journal.append({ operationId, operationType: 'code-revert', state: 'prepared', expectedPreState: { startSha: ours.sha, actionId }, details: intent })
      })
      if ('conflicts' in restored) throw new UndoConflictError(restored.conflicts, 'The code revert')
      return this.complete(workspacePath, operationId, { target, latest: actions.at(-1) }, ours.sha, restored.snapshot, new Date().toISOString(), [gitNotice ?? '', restored.preserved ? preservedNotice(restored.preserved, new UndoRetentionService(this.threadDirectory).policy().windowMs) : '', restored.exact ? exactBytesNotice(restored.exact) : '', leftAsIsNotice(restored.leftAsIs) ?? '', coverageNotice(target.git?.coverageGaps, await namedGapsAsync(workspacePath, ours.sha, restored.snapshot.sha, ours.coverageGaps, restored.snapshot.coverageGaps)) ?? ''].filter(Boolean).join(' ') || undefined)
    })
  }

  /** Records the revert as an action and a receipt, and ends its journal entry. */
  private async complete(workspacePath: string, operationId: string, intent: RevertIntent, startSha: string, end: Snapshot, createdAt: string, notice?: string): Promise<ThreadAction> {
    const { target, latest } = intent
    const record: ThreadAction = {
      id: operationId, turnId: operationId, conversationBranchId: target.conversationBranchId,
      parentActionId: latest?.id,
      presentationMessageStart: latest?.presentationMessageEnd ?? 0,
      presentationMessageEnd: latest?.presentationMessageEnd ?? 0,
      nativeContextBoundary: latest?.nativeContextBoundary ?? target.nativeContextBoundary,
      startSha, endSha: end.sha, commits: [], childIntegrations: [],
      changedPaths: await changedPathsAsync(workspacePath, startSha, end.sha), externalEffects: target.externalEffects, reversible: true,
      git: (await describeGitAsync(workspacePath, startSha, end)).record, ...(notice ? { notice } : {}),
      state: 'completed', createdAt, completedAt: new Date().toISOString()
    }
    const receipts = new ChangeReceiptService(this.threadDirectory)
    const existing = receipts.list().find((item) => item.operationId === operationId)
    const receipt = existing ? await receipts.replay(workspacePath, existing) : await receipts.record(workspacePath, {
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

  async recoverPending(workspacePath: string, heldThreadLease?: ThreadLeaseHandle, signal?: AbortSignal): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'code-revert-recovery', async () => {
      const receipts = new ChangeReceiptService(this.threadDirectory)
      for (const entry of this.journal.latestByOperation().values()) {
        if (!['code-revert', 'change-revert'].includes(entry.operationType) || !['prepared', 'git_applied'].includes(entry.state)) continue
        const intent = this.journal.list().find((item) => item.operationId === entry.operationId && item.state === 'prepared')
        const expected = intent?.expectedPreState as { startSha: string; actionId: string } | undefined
        const details = intent?.details as RevertIntent | undefined
        if (!expected || !details?.target) throw new Error('Code revert recovery intent is missing.')
        const prior = receipts.list().find((item) => item.operationId === entry.operationId)
        const applied = details.ours ? await this.provenApplied(workspacePath, entry.operationId, details, prior) : await this.legacyApplied(workspacePath, entry.operationId, expected.startSha, prior)
        if (!applied) {
          this.journal.append({ operationId: entry.operationId, operationType: 'code-revert', state: 'cancelled', details: { recoveredBeforeGit: true } })
          continue
        }
        const gitNotice = details.gitNotice ?? await gitLeftInPlaceNoticeAsync(workspacePath, 'Revert', details.target)
        await this.complete(workspacePath, entry.operationId, details, applied.startSha, applied.end, intent!.createdAt, [gitNotice ?? '', coverageNotice(details.target.git?.coverageGaps, await namedGapsAsync(workspacePath, applied.startSha, applied.end.sha, applied.end.coverageGaps)) ?? ''].filter(Boolean).join(' ') || undefined)
      }
    }, signal, heldThreadLease)
  }

  /**
   * Whether an interrupted revert landed, read from the files: the receipt when it was recorded; otherwise every path
   * the revert writes is as planned (landed) or none is (did not). Some written and some not is left for a person to
   * look at.
   */
  private async provenApplied(workspacePath: string, operationId: string, details: RevertIntent, prior?: { beforeSha: string; afterSha: string }): Promise<{ startSha: string; end: Snapshot } | undefined> {
    if (prior) return { startSha: prior.beforeSha, end: await recordedSnapshotAsync(workspacePath, prior.afterSha) }
    // Only the paths the revert writes are read, straight from disk: an ignored file it wrote counts, and an unrelated new file does not.
    const exact = await plannedExactAsync(workspacePath, details.ours!, details.expectedExactTree)
    const outcome = moveOutcome(await moveProgressAsync(workspacePath, await treeOfAsync(workspacePath, details.ours!), details.expectedTree!, exact))
    // The end is the planned result, not the files now: an edit made since stays an edit made since.
    if (outcome === 'applied') return { startSha: details.ours!, end: await snapshotOfTreeAsync(workspacePath, details.expectedTree!, { reason: `revert code action ${details.target.id}`, operationId }, exact?.to, await plannedExactGapsAsync(workspacePath, details.ours!, details.expectedTree!)) }
    if (outcome === 'not-applied') return undefined
    throw new Error('Code revert recovery found files that match neither the state before nor the state after the revert; resolve the differences by hand.')
  }

  /** The proof for an intent written before snapshots: the revert was a commit on the branch. */
  private async legacyApplied(workspacePath: string, operationId: string, startSha: string, prior?: { afterSha: string }): Promise<{ startSha: string; end: Snapshot } | undefined> {
    const head = await gitAsync(workspacePath, ['rev-parse', 'HEAD'])
    if (!prior && head === startSha) return undefined
    if (prior ? prior.afterSha !== head : (await commitParentsAsync(workspacePath, head))[0] !== startSha || !(await gitAsync(workspacePath, ['log', '-1', '--format=%B'])).includes(operationId)) throw new Error('Code revert recovery HEAD does not match the operation.')
    return { startSha, end: { sha: head, tree: await treeOfAsync(workspacePath, head), head } }
  }
}

import { readDirectLifecycleRef } from '../lifecycle/WorktreeRetirementService'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from '../actions/ThreadActionService'
import { withGitMutationLocks } from '../actions/GitOperationCoordinator'
import { changedPaths, git, tryGit } from '../actions/git'
import { describeGit, restoreChange, sameTree, takeSnapshot } from '../actions/snapshots'
import { ChangeReceiptService } from '../actions/ChangeReceiptService'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import type { WorkspaceActor } from '../../shared/workspace'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import type { ChildIntegrationRecord, ExternalEffect, GitRecord } from '../../shared/threadActions'

export interface ChildIntegrationRequest {
  agentId: string
  retainedResultId?: string
  operationId?: string
  heldThreadLease?: ThreadLeaseHandle
  actor?: WorkspaceActor
  externalEffects?: ExternalEffect[]
  runId?: string
  turnId?: string
  workerWorktree: string
  /**
   * The worker's result: the snapshot of its files that its task or workflow step ended with. The worker may have
   * moved on since, so nothing else about its worktree (files, HEAD, branch) is read.
   */
  pinnedWorkerSha: string
  /** The code the worker started from, a commit or a snapshot: the base of the merge. */
  spawnBaseSha: string
  threadWorkspace: string
  actionId?: string
  signal?: AbortSignal
}

/** What `prepared` records: the pinned request and what recovery needs to tell whether the files changed. */
interface IntegrationIntent {
  preSnapshot: string
  workerSha: string
  spawnBaseSha: string
  expectedTree: string
}

/** The worker's change overlaps with edits in the thread: nothing was changed, and the files are named. */
export class ChildIntegrationConflictError extends AppError {
  constructor(readonly files: string[]) {
    super({
      code: 'integration_conflict',
      message: `Child integration conflict: ${files.join(', ') || 'some files'}. Nothing was changed; the worker's result stays pinned.`,
      details: { files }, errorInfo: { category: 'conflict', retryable: false }
    })
    this.name = 'ChildIntegrationConflictError'
  }
}

/**
 * Brings a worker's result into the thread as files. The base is the code the worker started from, `ours` is a
 * fresh snapshot of the thread (uncommitted turn work included, left exactly where it is) and `theirs` is the
 * worker's snapshot; `restoreChange` merges them by three-way merge and rewrites only the files the merge changes.
 * Nothing is committed, no branch or HEAD moves, and a conflict refuses with the file names and changes nothing.
 */
export class ChildAgentIntegrationService {
  private readonly journal: ThreadJournal
  private readonly actions: ThreadActionService
  constructor(private readonly threadDirectory: string) {
    this.journal = new ThreadJournal(threadDirectory)
    this.actions = new ThreadActionService(threadDirectory)
  }

  async integrate(request: ChildIntegrationRequest): Promise<ChildIntegrationRecord> {
    return withGitMutationLocks(this.threadDirectory, request.threadWorkspace, 'child-integration', async () => {
      const receipts = new ChangeReceiptService(this.threadDirectory)
      if (resolveRepositoryIdentity(request.workerWorktree).key !== resolveRepositoryIdentity(request.threadWorkspace).key) throw new Error('Worker belongs to a different repository.')
      // A pinned result does not depend on the live worktree, which may be running or hold newer files.
      if (!tryGit(request.workerWorktree, ['cat-file', '-e', `${request.pinnedWorkerSha}^{commit}`]).ok) throw new Error('The delegated result is no longer in the repository.')
      const workerSha = git(request.workerWorktree, ['rev-parse', `${request.pinnedWorkerSha}^{commit}`])
      const previous = request.operationId ? receipts.list().find((item) => item.operationId === request.operationId) : undefined
      const pending = request.operationId ? this.journal.latestByOperation().get(request.operationId) : undefined
      if (previous && (previous.kind !== 'integration' || previous.contributions[0]?.resultSha !== workerSha || previous.contributions[0]?.actorId !== request.agentId)) throw new Error('Integration operation identity was reused for a different result.')
      if (pending?.state === 'recovery_required') throw new Error('The earlier integration of this result is waiting for recovery; abort it or resolve it first.')
      const completed = request.operationId ? this.journal.list().find((item) => item.operationId === request.operationId && item.state === 'completed') : undefined
      if (completed) {
        const { retainedRef: _retainedRef, ...record } = completed.details as ChildIntegrationRecord & { retainedRef?: string }
        return record
      }
      const inFlight = pending && ['prepared', 'git_applied'].includes(pending.state)
      const intent = inFlight ? this.intentOf(request.operationId!) : undefined
      if (inFlight && (!intent || intent.workerSha !== workerSha || intent.spawnBaseSha !== request.spawnBaseSha)) throw new Error('Integration recovery requires its original pinned request.')
      const operationId = request.operationId ?? randomUUID()
      const top = git(request.threadWorkspace, ['rev-parse', '--show-toplevel'])
      const threadId = new ThreadWorkspaceManager(this.threadDirectory).load()?.threadId
      // The receipt was recorded and only the action's bookkeeping was interrupted: the files are already merged.
      if (previous) return this.completeIntegration(request, operationId, workerSha, previous.beforeSha, previous.afterSha, previous.git)
      if (!tryGit(top, ['cat-file', '-e', `${request.spawnBaseSha}^{commit}`]).ok) throw new Error('The worker’s spawn base is no longer in the repository.')
      // A worker that changed nothing has no result to merge; this is read from the files, not from commits.
      if (sameTree(request.workerWorktree, workerSha, request.spawnBaseSha)) throw new Error('Worker produced no change.')
      const ours = takeSnapshot(top, { reason: `before subagent result ${request.agentId}`, threadId, operationId })
      // A repeated run (recovery, or an explicit retry of an interrupted one) merges from the files as they are now:
      // changes that already landed are the same on both sides, so only what is missing is written.
      const merged = restoreChange(top, { base: request.spawnBaseSha, ours: ours.sha, theirs: workerSha, reason: `subagent result ${request.agentId}`, threadId, operationId }, (expectedTree) => {
        if (inFlight) return
        this.journal.append({
          operationId,
          operationType: 'child-integration',
          state: 'prepared',
          expectedPreState: { preSnapshot: ours.sha, workerSha, spawnBaseSha: request.spawnBaseSha, expectedTree } satisfies IntegrationIntent,
          details: { request: { agentId: request.agentId, retainedResultId: request.retainedResultId, operationId, workerWorktree: request.workerWorktree, spawnBaseSha: request.spawnBaseSha, pinnedWorkerSha: workerSha, threadWorkspace: request.threadWorkspace, actionId: request.actionId, actor: request.actor, externalEffects: request.externalEffects, runId: request.runId, turnId: request.turnId } }
        })
      })
      if ('conflicts' in merged) {
        // A retried operation must not stay pending and lock the thread; the result is still pinned for another try.
        if (inFlight) this.journal.append({ operationId, operationType: 'child-integration', state: 'cancelled', details: { conflictFiles: merged.conflicts, workerSha } })
        throw new ChildIntegrationConflictError(merged.conflicts)
      }
      const { record } = describeGit(top, ours.sha, merged.snapshot)
      return this.completeIntegration(request, operationId, workerSha, intent?.preSnapshot ?? ours.sha, merged.snapshot.sha, record)
    }, request.signal, request.heldThreadLease)
  }

  /** The latest `prepared` intent of an operation. One written before snapshots (a merge commit) is read as the same pinned request. */
  private intentOf(operationId: string): IntegrationIntent | undefined {
    const prepared = [...this.journal.list()].reverse().find((item) => item.operationId === operationId && item.state === 'prepared')?.expectedPreState as
      (Partial<IntegrationIntent> & { preMergeSha?: string; workerHeadSha?: string; spawnBaseSha?: string }) | undefined
    if (!prepared) return undefined
    const workerSha = prepared.workerSha ?? prepared.workerHeadSha
    const preSnapshot = prepared.preSnapshot ?? prepared.preMergeSha
    if (!workerSha || !preSnapshot || !prepared.spawnBaseSha) return undefined
    return { preSnapshot, workerSha, spawnBaseSha: prepared.spawnBaseSha, expectedTree: prepared.expectedTree ?? '' }
  }

  private completeIntegration(request: ChildIntegrationRequest, operationId: string, workerSha: string, beforeSha: string, afterSha: string, gitRecord?: GitRecord): ChildIntegrationRecord {
    const actions = this.actions.list()
    const previousReceipt = new ChangeReceiptService(this.threadDirectory).list().find((item) => item.operationId === operationId)
    const previousParent = previousReceipt?.actionId ? actions.find((item) => item.id === previousReceipt.actionId && item.id !== operationId) : undefined
    const parent = previousParent ?? (request.actionId ? actions.find((item) => item.id === request.actionId) : actions.find((item) => item.state === 'running' && item.turnId === request.turnId))
    const actionId = parent?.id ?? operationId
    const retainedRef = `refs/mousse/agents/${request.retainedResultId ?? request.agentId}`
    const previousPin = readDirectLifecycleRef(request.threadWorkspace, retainedRef)
    git(request.threadWorkspace, ['update-ref', '--no-deref', retainedRef, workerSha, previousPin ?? '0'.repeat(workerSha.length)])
    const receipt = new ChangeReceiptService(this.threadDirectory).record(request.threadWorkspace, {
      operationId, kind: 'integration', actor: request.actor ?? { kind: 'agent', id: request.agentId },
      turnId: request.turnId, runId: request.runId, actionId,
      beforeSha, afterSha,
      introducedCommits: [],
      contributions: [{ actorId: request.agentId, baseSha: request.spawnBaseSha, resultSha: workerSha }], externalEffects: request.externalEffects ?? [],
      ...(gitRecord ? { git: gitRecord } : {})
    })
    const changed = changedPaths(request.threadWorkspace, beforeSha, afterSha)
    const record: ChildIntegrationRecord = {
      receiptId: receipt.id, operationId, preMergeSha: beforeSha,
      agentId: request.agentId,
      spawnBaseSha: request.spawnBaseSha,
      workerHeadSha: workerSha,
      integrationSha: afterSha,
      changedPaths: changed.map((item) => item.path)
    }
    if (parent) {
      if (!parent.childIntegrations.some((item) => item.integrationSha === afterSha)) parent.childIntegrations.push(record)
    } else if (!actions.some((item) => item.id === actionId)) {
      const latest = actions.at(-1)
      actions.push({
        id: actionId, receiptId: receipt.id, turnId: request.turnId ?? operationId,
        conversationBranchId: new ThreadWorkspaceManager(this.threadDirectory).load()?.conversationBranchId ?? 'main',
        actor: request.actor ?? { kind: 'agent', id: request.agentId }, runId: request.runId,
        parentActionId: latest?.id, presentationMessageStart: latest?.presentationMessageEnd ?? 0,
        presentationMessageEnd: latest?.presentationMessageEnd ?? 0,
        // Code-only integration deliberately has no conversation start boundary.
        nativeContextBoundary: latest?.nativeContextBoundary ?? { messageIndex: 0, compactionGeneration: 0, fidelity: 'legacy' },
        startSha: beforeSha, endSha: afterSha, commits: [],
        childIntegrations: [record], changedPaths: changed,
        externalEffects: request.externalEffects ?? [], ...(gitRecord ? { git: gitRecord } : {}),
        reversible: true, state: 'completed', createdAt: receipt.createdAt, completedAt: receipt.createdAt
      })
    }
    this.actions.replace(actions)
    this.journal.append({
      operationId,
      operationType: 'child-integration',
      state: 'completed',
      details: { ...record, retainedRef }
    })
    return record
  }

  async recoverPending(threadWorkspace: string, heldThreadLease?: ThreadLeaseHandle): Promise<void> {
    for (const entry of this.journal.latestByOperation().values()) {
      if (!['child-integration', 'change-integration'].includes(entry.operationType) || !['prepared', 'git_applied'].includes(entry.state)) continue
      const intent = this.journal.list().find((item) => item.operationId === entry.operationId && item.state === 'prepared')
      const request = (intent?.details as { request?: ChildIntegrationRequest & { expectedWorkerHead?: string } } | undefined)?.request
      if (!request || request.threadWorkspace !== threadWorkspace) throw new Error('Integration recovery workspace does not match its durable owner.')
      // A request written before snapshots named the worker's result as `expectedWorkerHead`.
      await this.integrate({ ...request, pinnedWorkerSha: request.pinnedWorkerSha ?? request.expectedWorkerHead!, heldThreadLease })
    }
  }
}

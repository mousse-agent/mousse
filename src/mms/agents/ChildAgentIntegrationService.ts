import { readDirectLifecycleRef } from '../lifecycle/WorktreeRetirementService'
import { randomUUID } from 'node:crypto'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from '../actions/ThreadActionService'
import { withGitMutationLocks } from '../actions/GitOperationCoordinator'
import { changedPaths, commitParents, git, MOUSSE_COMMIT_ENV, requireClean, tryGit } from '../actions/git'
import { ChangeReceiptService } from '../actions/ChangeReceiptService'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import type { WorkspaceActor } from '../../shared/workspace'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import type { ChildIntegrationRecord, ExternalEffect } from '../../shared/threadActions'

export interface ChildIntegrationRequest {
  agentId: string
  retainedResultId?: string
  operationId?: string
  heldThreadLease?: ThreadLeaseHandle
  actor?: WorkspaceActor
  externalEffects?: ExternalEffect[]
  runId?: string
  turnId?: string
  expectedDestinationHead?: string
  workerWorktree: string
  workerBranch: string
  spawnBaseSha: string
  expectedWorkerHead?: string
  threadWorkspace: string
  actionId?: string
  signal?: AbortSignal
}

export class ChildAgentIntegrationService {
  private readonly journal: ThreadJournal
  private readonly actions: ThreadActionService
  constructor(private readonly threadDirectory: string) {
    this.journal = new ThreadJournal(threadDirectory)
    this.actions = new ThreadActionService(threadDirectory)
  }

  async integrate(request: ChildIntegrationRequest): Promise<ChildIntegrationRecord> {
    const expectedDestination = request.expectedDestinationHead ?? git(request.threadWorkspace, ['rev-parse', 'HEAD'])
    return withGitMutationLocks(this.threadDirectory, request.threadWorkspace, 'child-integration', async () => {
      const receipts = new ChangeReceiptService(this.threadDirectory)
      const previous = request.operationId ? receipts.list().find((item) => item.operationId === request.operationId) : undefined
      const pending = request.operationId ? this.journal.latestByOperation().get(request.operationId) : undefined
      if (previous || pending) {
        if (previous && (previous.kind !== 'integration' || previous.contributions[0]?.resultSha !== (request.expectedWorkerHead ?? git(request.workerWorktree, ['rev-parse', 'HEAD'])) || previous.contributions[0]?.actorId !== request.agentId)) throw new Error('Integration operation identity was reused for a different result.')
        const completed = this.journal.list().find((item) => item.operationId === request.operationId && item.state === 'completed')
        if (completed) {
          const { retainedRef: _retainedRef, ...record } = completed.details as ChildIntegrationRecord & { retainedRef?: string }
          return record
        }
        const intent = this.journal.list().find((item) => item.operationId === request.operationId && item.state === 'prepared')
        const expected = intent?.expectedPreState as { preMergeSha: string; workerHeadSha: string; spawnBaseSha: string } | undefined
        if (!expected || expected.workerHeadSha !== (request.expectedWorkerHead ?? git(request.workerWorktree, ['rev-parse', 'HEAD'])) || expected.spawnBaseSha !== request.spawnBaseSha) throw new Error('Integration recovery requires its original pinned request.')
        requireClean(request.threadWorkspace, 'Thread workspace')
        const head = git(request.threadWorkspace, ['rev-parse', 'HEAD'])
        const parents = commitParents(request.threadWorkspace, head)
        if (previous?.afterSha === head || (parents[0] === expected.preMergeSha && parents[1] === expected.workerHeadSha)) {
          return this.completeIntegration(request, request.operationId!, expected.preMergeSha, expected.workerHeadSha, head)
        }
        if (head !== expected.preMergeSha) throw new Error('Integration recovery HEAD does not match the original operation.')
        // Git was not applied. An explicit retry may execute this same pinned intent once.
      }
      if (resolveRepositoryIdentity(request.workerWorktree).key !== resolveRepositoryIdentity(request.threadWorkspace).key) throw new Error('Worker belongs to a different repository.')
      requireClean(request.workerWorktree, 'Worker worktree')
      requireClean(request.threadWorkspace, 'Thread workspace')
      const actualBranch = git(request.workerWorktree, ['branch', '--show-current'])
      if (actualBranch !== request.workerBranch) throw new Error(`Worker branch changed: expected ${request.workerBranch}, found ${actualBranch}`)
      const workerHeadSha = git(request.workerWorktree, ['rev-parse', 'HEAD'])
      if (request.expectedWorkerHead && request.expectedWorkerHead !== workerHeadSha) throw new Error('Worker HEAD changed after readiness validation.')
      if (workerHeadSha === request.spawnBaseSha) throw new Error('Worker produced no authored commit.')
      const preMergeSha = git(request.threadWorkspace, ['rev-parse', 'HEAD'])
      if (preMergeSha !== expectedDestination) throw new Error('Integration destination HEAD changed after readiness validation.')
      if (!tryGit(request.workerWorktree, ['merge-base', '--is-ancestor', request.spawnBaseSha, workerHeadSha]).ok) throw new Error('Worker history no longer descends from its spawn base.')
      const operationId = request.operationId ?? randomUUID()
      this.journal.append({
        operationId,
        operationType: 'child-integration',
        state: 'prepared',
        expectedPreState: { preMergeSha, workerHeadSha, spawnBaseSha: request.spawnBaseSha },
        details: { request: { agentId: request.agentId, retainedResultId: request.retainedResultId, operationId, workerWorktree: request.workerWorktree, workerBranch: request.workerBranch, spawnBaseSha: request.spawnBaseSha, expectedWorkerHead: workerHeadSha, expectedDestinationHead: preMergeSha, threadWorkspace: request.threadWorkspace, actionId: request.actionId, actor: request.actor, externalEffects: request.externalEffects, runId: request.runId, turnId: request.turnId } }
      })
      const merge = tryGit(request.threadWorkspace, ['merge', '--no-ff', '--no-edit', workerHeadSha], MOUSSE_COMMIT_ENV)
      if (!merge.ok) {
        const conflictFiles = git(request.threadWorkspace, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean)
        this.journal.append({
          operationId,
          operationType: 'child-integration',
          state: 'recovery_required',
          details: { preMergeSha, workerHeadSha, conflictFiles, error: merge.stderr }
        })
        throw new Error(`Child integration conflict: ${conflictFiles.join(', ')}`)
      }
      const integrationSha = git(request.threadWorkspace, ['rev-parse', 'HEAD'])
      return this.completeIntegration(request, operationId, preMergeSha, workerHeadSha, integrationSha)
    }, request.signal, request.heldThreadLease)
  }
  private completeIntegration(request: ChildIntegrationRequest, operationId: string, preMergeSha: string, workerHeadSha: string, integrationSha: string): ChildIntegrationRecord {
      const actions = this.actions.list()
      const previousReceipt = new ChangeReceiptService(this.threadDirectory).list().find((item) => item.operationId === operationId)
      const previousParent = previousReceipt?.actionId ? actions.find((item) => item.id === previousReceipt.actionId && item.id !== operationId) : undefined
      const parent = previousParent ?? (request.actionId ? actions.find((item) => item.id === request.actionId) : actions.find((item) => item.state === 'running' && item.turnId === request.turnId))
      const actionId = parent?.id ?? operationId
      const retainedRef = `refs/mousse/agents/${request.retainedResultId ?? request.agentId}`
      const previousPin = readDirectLifecycleRef(request.threadWorkspace, retainedRef)
      git(request.threadWorkspace, ['update-ref', '--no-deref', retainedRef, workerHeadSha, previousPin ?? '0'.repeat(workerHeadSha.length)])
      const receipt = new ChangeReceiptService(this.threadDirectory).record(request.threadWorkspace, {
        operationId, kind: 'integration', actor: request.actor ?? { kind: 'agent', id: request.agentId },
        turnId: request.turnId, runId: request.runId, actionId,
        beforeSha: preMergeSha, afterSha: integrationSha,
        introducedCommits: preMergeSha === integrationSha ? [] : [integrationSha],
        contributions: [{ actorId: request.agentId, baseSha: request.spawnBaseSha, resultSha: workerHeadSha }], externalEffects: request.externalEffects ?? []
      })
      const record: ChildIntegrationRecord = {
        receiptId: receipt.id, operationId, preMergeSha,
        agentId: request.agentId,
        spawnBaseSha: request.spawnBaseSha,
        workerHeadSha,
        integrationSha,
        mainlineParent: 1,
        changedPaths: changedPaths(request.threadWorkspace, preMergeSha, integrationSha).map((item) => item.path)
      }
      if (parent) {
        if (!parent.childIntegrations.some((item) => item.integrationSha === integrationSha)) parent.childIntegrations.push(record)
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
          startSha: preMergeSha, endSha: integrationSha, commits: receipt.introducedCommits,
          childIntegrations: [record], changedPaths: changedPaths(request.threadWorkspace, preMergeSha, integrationSha),
          externalEffects: request.externalEffects ?? [], reversible: true, state: 'completed', createdAt: receipt.createdAt, completedAt: receipt.createdAt
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
      const request = (intent?.details as { request?: ChildIntegrationRequest } | undefined)?.request
      if (!request || request.threadWorkspace !== threadWorkspace) throw new Error('Integration recovery workspace does not match its durable owner.')
      await this.integrate({ ...request, heldThreadLease })
    }
  }

}

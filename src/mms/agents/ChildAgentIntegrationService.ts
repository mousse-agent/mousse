import { randomUUID } from 'node:crypto'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadActionService } from '../actions/ThreadActionService'
import { withGitMutationLocks } from '../actions/GitOperationCoordinator'
import { changedPaths, git, MOUSSE_COMMIT_ENV, requireClean, tryGit } from '../actions/git'
import { ChangeReceiptService } from '../actions/ChangeReceiptService'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import type { WorkspaceActor } from '../../shared/workspace'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import type { ChildIntegrationRecord } from '../../shared/threadActions'

export interface ChildIntegrationRequest {
  agentId: string
  operationId?: string
  heldThreadLease?: ThreadLeaseHandle
  actor?: WorkspaceActor
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
      const previous = request.operationId && receipts.list().find((item) => item.operationId === request.operationId)
      if (previous) {
        const completed = this.journal.list().find((item) => item.operationId === request.operationId && item.state === 'completed')
        if (completed) {
          const { retainedRef: _retainedRef, ...record } = completed.details as ChildIntegrationRecord & { retainedRef?: string }
          return record
        }
        throw new Error('Integration was applied and requires operation recovery.')
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
        state: 'running',
        expectedPreState: { preMergeSha, workerHeadSha, spawnBaseSha: request.spawnBaseSha }
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
      const retainedRef = `refs/mousse/agents/${request.agentId}`
      git(request.threadWorkspace, ['update-ref', retainedRef, workerHeadSha])
      const receipt = receipts.record(request.threadWorkspace, {
        operationId, kind: 'integration', actor: request.actor ?? { kind: 'agent', id: request.agentId },
        turnId: request.turnId, runId: request.runId, actionId: request.actionId,
        beforeSha: preMergeSha, afterSha: integrationSha,
        introducedCommits: preMergeSha === integrationSha ? [] : [integrationSha],
        contributions: [{ actorId: request.agentId, baseSha: request.spawnBaseSha, resultSha: workerHeadSha }], externalEffects: []
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
      if (request.actionId) {
        const actions = this.actions.list(); const action = actions.find((item) => item.id === request.actionId)
        if (action && !action.childIntegrations.some((item) => item.integrationSha === integrationSha)) {
          action.childIntegrations.push(record); this.actions.replace(actions)
        }
      }
      this.journal.append({
        operationId,
        operationType: 'child-integration',
        state: 'completed',
        details: { ...record, retainedRef }
      })
      return record
    }, request.signal, request.heldThreadLease)
  }
}

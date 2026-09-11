import { WORKFLOW_RUN_CAPABILITY, WORKFLOW_RUN_METHODS, type WorkflowRunListPage, type WorkflowRunStartParams, type WorkflowRunTracePage } from '../../shared/workflowRunPlatform'
import type { WorkflowRunSnapshot, WorkflowRuntimePort } from '../../shared/workflows'
import type { ApprovalService } from '../execution/ApprovalService'
import { DomainHandlerRegistry, DomainRpcError } from '../protocol/domainRegistry'
import { decodeWorkflowRunCursor, validateWorkflowRunParams } from './runDomainValidation'
import { boundWorkflowRunResponse, workflowRunEventView, workflowRunSummary, workflowRunView } from './runView'

type RunOwner = { profileId: string; deferExecution?: boolean }
export interface WorkflowRunDomainRuntime extends Pick<WorkflowRuntimePort, 'get' | 'list' | 'trace' | 'pause' | 'cancel'> {
  resume(runId: string, owner: RunOwner & { reconcile?: 'retry' | 'abandon' }): Promise<WorkflowRunSnapshot>
  approve(runId: string, owner: RunOwner, decision: { approvalId: string; approved: boolean; actorId: string }): Promise<WorkflowRunSnapshot>
  answer(runId: string, owner: RunOwner, answer: { instanceKey: string; data: unknown }): Promise<WorkflowRunSnapshot>
}
export interface WorkflowRunAdmission {
  readonly connectionId: string
  readonly source: 'gui' | 'cli'
}
export interface WorkflowRunDomainServices {
  readonly profileId: string
  readonly runtime: WorkflowRunDomainRuntime
  readonly approvals: Pick<ApprovalService, 'get'>
  /** Resolve thread/project ownership, immutable revisions and policy before durable admission. */
  start(params: WorkflowRunStartParams, admission: WorkflowRunAdmission): Promise<WorkflowRunSnapshot>
}

function assertOwner(snapshot: WorkflowRunSnapshot, profileId: string, runId?: string): void {
  if (snapshot.manifest.profileId !== profileId || (runId && snapshot.manifest.runId !== runId)) throw new DomainRpcError('profile_mismatch', 'Workflow run does not belong to the admitted profile')
}

/** Kept separate from definition CRUD so execution is advertised only after host composition. */
export function registerWorkflowRunMethods(domains: DomainHandlerRegistry, servicesForProfile: (profileId: string) => WorkflowRunDomainServices | Promise<WorkflowRunDomainServices>): void {
  for (const method of WORKFLOW_RUN_METHODS) domains.register({
    method, scope: 'profile', capability: WORKFLOW_RUN_CAPABILITY, requiredCapabilities: [WORKFLOW_RUN_CAPABILITY],
    validate: (value) => validateWorkflowRunParams(method, value),
    async handle(context, params, binding) {
      const profileId = binding!.profileId
      const services = await servicesForProfile(profileId)
      if (services.profileId !== profileId) throw new DomainRpcError('profile_mismatch', 'Workflow service does not belong to the admitted profile')
      const owner = { profileId, deferExecution: true }
      const runId = params.runId as string
      const present = async (snapshot: WorkflowRunSnapshot) => {
        assertOwner(snapshot, profileId, runId)
        const approval = snapshot.pendingApprovalId ? services.approvals.get(snapshot.pendingApprovalId, profileId) : undefined
        const trace = await services.runtime.trace(snapshot.manifest.runId, owner)
        if (trace.runId !== snapshot.manifest.runId || trace.events.some((event) => event.runId !== trace.runId)) throw new DomainRpcError('run_mismatch', 'Trace does not belong to this workflow run')
        return workflowRunView(snapshot, trace.events, approval)
      }
      try {
        if (method === 'workflowRuns.start') {
          if (!context.connection?.id) throw new DomainRpcError('profile_binding_required', 'Workflow starts require an admitted connection')
          const snapshot = await services.start({ ...params, profileId } as unknown as WorkflowRunStartParams, Object.freeze({ connectionId: context.connection.id, source: context.connection.clientType === 'gui' ? 'gui' : 'cli' }))
          if (snapshot.manifest.definitionId !== params.definitionId) throw new DomainRpcError('run_mismatch', 'Admission returned a different workflow definition')
          return await present(snapshot)
        }
        if (method === 'workflowRuns.list') {
          const before = params.before === undefined ? undefined : decodeWorkflowRunCursor(params.before)
          const rows = await services.runtime.list({ profileId, threadId: params.threadId as string | undefined })
          if (rows.some((row) => row.profileId !== profileId)) throw new DomainRpcError('profile_mismatch', 'History contains a different profile')
          const matching = rows.filter((row) => (!params.definitionId || row.definitionId === params.definitionId) && (!before || row.createdAt < before.createdAt || (row.createdAt === before.createdAt && row.runId < before.runId)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId))
          const page = matching.slice(0, params.limit as number | undefined ?? 30)
          const last = page[page.length - 1]
          return boundWorkflowRunResponse<WorkflowRunListPage>({ runs: page.map(workflowRunSummary), nextCursor: matching.length > page.length && last ? last.createdAt + '|' + last.runId : undefined })
        }
        const current = await services.runtime.get(runId, owner)
        assertOwner(current, profileId, runId)
        if (method === 'workflowRuns.get') return await present(current)
        if (method === 'workflowRuns.trace') {
          const trace = await services.runtime.trace(runId, owner)
          if (trace.runId !== runId || trace.events.some((event) => event.runId !== runId)) throw new DomainRpcError('run_mismatch', 'Trace does not belong to this workflow run')
          const after = params.afterSequence as number | undefined ?? 0
          const events = trace.events.filter((event) => event.seq > after).sort((a, b) => a.seq - b.seq)
          const page = events.slice(0, params.limit as number | undefined ?? 50).map(workflowRunEventView)
          return boundWorkflowRunResponse<WorkflowRunTracePage>({ events: page, afterSequence: page[page.length - 1]?.seq ?? after, hasMore: events.length > page.length })
        }
        switch (method) {
          case 'workflowRuns.pause': return await present(await services.runtime.pause(runId, owner))
          case 'workflowRuns.resume': return await present(await services.runtime.resume(runId, owner))
          case 'workflowRuns.cancel': return await present(await services.runtime.cancel(runId, owner, params.reason as string | undefined))
          case 'workflowRuns.approve': {
            const approval = services.approvals.get(params.approvalId as string, profileId)
            const view = workflowRunView(current, [], approval)
            const pending = view.pendingApproval
            if (!pending || pending.approvalId !== params.approvalId || pending.nodeId !== params.nodeId || pending.instanceKey !== params.instanceKey || pending.attempt !== params.attempt) throw new DomainRpcError('stale_approval', 'This node attempt is no longer waiting for the displayed approval')
            if (!Number.isFinite(Date.parse(approval!.expiresAt)) || Date.parse(approval!.expiresAt) <= Date.now()) throw new DomainRpcError('approval_expired', 'This approval has expired')
            return await present(await services.runtime.approve(runId, owner, { approvalId: pending.approvalId, approved: params.approved as boolean, actorId: context.connection!.id }))
          }
          case 'workflowRuns.answer': {
            const pending = workflowRunView(current, []).pendingInput
            if (!pending || pending.instanceKey !== params.instanceKey || pending.nodeId !== params.nodeId) throw new DomainRpcError('stale_input', 'This node instance is no longer waiting for the displayed input')
            return await present(await services.runtime.answer(runId, owner, { instanceKey: pending.instanceKey, data: params.data }))
          }
          case 'workflowRuns.reconcile': {
            if (params.decision !== 'fail') throw new DomainRpcError('reconciliation_unavailable', 'This runtime supports marking an uncertain run failed; it cannot accept or replay the external effect')
            const unknown = workflowRunView(current, []).unknownEffect
            if (!unknown || unknown.nodeId !== params.nodeId || unknown.instanceKey !== params.instanceKey || unknown.attempt !== params.attempt) throw new DomainRpcError('stale_effect', 'This node attempt no longer has the displayed uncertain effect')
            return await present(await services.runtime.resume(runId, { ...owner, reconcile: 'abandon' }))
          }
        }
      } catch (error) {
        if (error instanceof DomainRpcError) throw error
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
        if (code === 'ENOENT') throw new DomainRpcError('run_not_found', 'Workflow run or required execution record was not found in this profile')
        if (code && ['WORKFLOW_CONCURRENCY_CONFLICT', 'profile_mismatch', 'invalid_input', 'dependency_missing', 'executor_unavailable', 'budget_exceeded', 'approval_required', 'cancelled'].includes(code)) throw new DomainRpcError(code, error instanceof Error ? error.message.slice(0, 4096) : 'Workflow request failed')
        throw new DomainRpcError('workflow_request_failed', 'The workflow request could not be completed')
      }
    }
  })
}

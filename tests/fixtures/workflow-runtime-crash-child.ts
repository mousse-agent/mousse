import { appendFileSync } from 'node:fs'
import { CancellationRegistry } from '../../src/mms/execution/CancellationRegistry'
import { ExecutionPolicyService } from '../../src/mms/execution/ExecutionPolicyService'
import { WorkflowRegistry } from '../../src/mms/workflows/registry/WorkflowRegistry'
import { WorkflowRunService } from '../../src/mms/workflows/engine/WorkflowRunService'

const profileRoot = String(process.env.MATRIX_PROFILE_ROOT)
const profileId = process.env.MATRIX_PROFILE_ID ?? 'matrix'
const mode = process.env.MATRIX_MODE ?? 'run'
const runId = process.env.MATRIX_RUN_ID
const marker = String(process.env.MATRIX_MARKER)
const definitionId = String(process.env.MATRIX_DEFINITION_ID)
const revisionId = String(process.env.MATRIX_REVISION_ID)
const fault = process.env.MATRIX_FAULT
const childControl = process.env.MATRIX_CHILD_CONTROL
const failAgent = process.env.MATRIX_FAIL_AGENT === '1'
const policy = {
  allowedTools: ['workflow.node', 'workflow.agent', 'workflow.approval'],
  allowedCapabilities: ['model.invoke', 'human.input', 'human.approval'],
  allowedEffects: ['pure', 'read', 'write', 'external', 'unknown']
} as const

let dispatched = false
const service = new WorkflowRunService({
  profileId,
  profileRoot,
  registry: new WorkflowRegistry({ profileId, profileRoot }),
  policy: new ExecutionPolicyService(),
  cancellation: new CancellationRegistry(),
  adapters: {
    agent: {
      kind: 'agent',
      async invoke(request) {
        appendFileSync(marker, `${request.idempotencyKey}\n`)
        dispatched = true
        if (!childControl) process.send?.({ type: 'READY', idempotencyKey: request.idempotencyKey })
        if (failAgent) throw new Error('fixture external adapter crashed after dispatch')
        if (mode === 'run' && !fault) await new Promise<void>(() => undefined)
        return { output: { dispatched: true } }
      }
    }
  },
  faults: fault === 'afterNestedResult'
    ? { afterNestedResult: () => process.kill(process.pid, 'SIGKILL') }
    : fault === 'afterNestedCheckpoint'
      ? { afterNestedCheckpoint: () => process.kill(process.pid, 'SIGKILL') }
      : undefined
})

const main = async () => {
  let snapshot = mode === 'run'
    ? await service.start({ profileId, threadId: 'matrix-thread', actor: { kind: 'workflow' }, source: 'cli', definitionId, revisionId, input: {}, installationPolicy: policy })
    : await service.resume(runId!, { profileId, reconcile: 'retry' })
  if (snapshot.pendingApprovalId && mode === 'run') {
    snapshot = await service.approve(snapshot.manifest.runId, { profileId }, { approvalId: snapshot.pendingApprovalId, approved: true, actorId: 'fixture' })
  }
  if (mode === 'run' && childControl) {
    process.send?.({ type: 'READY', state: snapshot.manifest.state })
    await new Promise<void>(() => undefined)
  }
  if (mode === 'resume' && childControl) {
    const child = (await service.list({ profileId })).find((candidate) => candidate.parentRunId === snapshot.manifest.runId)
    if (!child) throw new Error('child workflow was not durably linked')
    const childSnapshot = await service.get(child.runId, { profileId })
    if (childControl === 'input') {
      const pending = childSnapshot.pendingWaits?.find((wait) => wait.pendingInput)?.pendingInput
      if (!pending) throw new Error('child input wait was not recovered')
      await service.answer(child.runId, { profileId }, { instanceKey: pending.instanceKey, data: 'fixture answer' })
    } else if (childControl === 'approval') {
      const approvalId = childSnapshot.pendingWaits?.find((wait) => wait.approvalId)?.approvalId
      if (!approvalId) throw new Error('child approval wait was not recovered')
      await service.approve(child.runId, { profileId }, { approvalId, approved: true, actorId: 'fixture' })
    } else if (childControl === 'timer') {
      await new Promise((resolve) => setTimeout(resolve, 60))
      await service.resume(child.runId, { profileId })
    } else if (childControl === 'unknown') {
      await service.resume(child.runId, { profileId, reconcile: 'abandon' })
    }
    snapshot = await service.resume(snapshot.manifest.runId, { profileId, reconcile: 'retry' })
  }
  process.send?.({ type: 'DONE', state: snapshot.manifest.state, dispatched })
}

void main().catch((error) => {
  process.send?.({ type: 'ERROR', message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})

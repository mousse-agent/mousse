import { appendFileSync } from 'node:fs'
import { CancellationRegistry } from '../../src/mms/execution/CancellationRegistry'
import { ExecutionPolicyService } from '../../src/mms/execution/ExecutionPolicyService'
import { WorkflowRegistry } from '../../src/mms/workflows/registry/WorkflowRegistry'
import { WorkflowRunService } from '../../src/mms/workflows/engine/WorkflowRunService'

const profileRoot = String(process.env.MATRIX_PROFILE_ROOT)
const profileId = 'matrix'
const mode = process.env.MATRIX_MODE ?? 'run'
const runId = process.env.MATRIX_RUN_ID
const marker = String(process.env.MATRIX_MARKER)
const definitionId = String(process.env.MATRIX_DEFINITION_ID)
const revisionId = String(process.env.MATRIX_REVISION_ID)
const policy = {
  allowedTools: ['workflow.node', 'workflow.agent'],
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
        process.send?.({ type: 'READY', idempotencyKey: request.idempotencyKey })
        if (mode === 'run') await new Promise<void>(() => undefined)
        return { output: { dispatched: true } }
      }
    }
  }
})

const main = async () => {
  const snapshot = mode === 'run'
    ? await service.start({ profileId, threadId: 'matrix-thread', actor: { kind: 'workflow' }, source: 'cli', definitionId, revisionId, input: {}, installationPolicy: policy })
    : await service.resume(runId!, { profileId, reconcile: 'retry' })
  process.send?.({ type: 'DONE', state: snapshot.manifest.state, dispatched })
}

void main().catch((error) => {
  process.send?.({ type: 'ERROR', message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})

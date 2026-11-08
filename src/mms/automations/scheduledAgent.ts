import type { AgentRuntimeHostBindings, AgentRuntimeToolApprovalRequest } from '../../shared/agents/execution'
import type { AgentRuntimeKind } from '../../shared/agents/types'
import type { ScheduledRunAgent } from '../../shared/types'
import { canonicalJson, sha256Hex } from '../../shared/agents/hashes'
import type { AgentDefinitionRegistry } from '../agentDefinitions/AgentDefinitionRegistry'
import type { AgentResolver } from '../agentDefinitions/AgentResolver'
import { approvalTooLongReason, assertRuntimeSettingsSupported } from '../agentDefinitions/runtimePolicy'
import type { MmsProfileServices } from '../MmsProfileServices'
import type { ScheduledAgentRunner } from '../orchestrator/OrchestratorService'

const APPROVAL_ARGUMENT_MAX_BYTES = 6 * 1024

/** Why a job's saved agent cannot run now, in words for the run's record; undefined when it can. */
export function savedAgentRefusal(record: { flags: { enabled: boolean; archived: boolean }; published?: { revision: string } }, name: string): string | undefined {
  if (record.flags.archived) return `${name} was archived. Choose another agent for this automation.`
  if (!record.flags.enabled) return `${name} is turned off. Turn it on in the Library to run this automation.`
  if (!record.published?.revision) return `Publish ${name} before an automation runs it.`
  return undefined
}

/**
 * Runs a job's saved agent for one occurrence (`ScheduledJob.agent`): the agent's latest published revision, on the
 * occurrence's thread, as an unattended `schedule` run. What it may use is its own grants; a tool that needs a person
 * asks on the thread, where the run waits for the answer and Needs you lists it.
 */
export function createScheduledAgentRunner(deps: {
  services: Pick<MmsProfileServices, 'profileId' | 'orchestrator' | 'questions'>
  registry: AgentDefinitionRegistry
  resolverFor: (runtimeKind: AgentRuntimeKind, projectPath: string) => Promise<AgentResolver>
}): ScheduledAgentRunner {
  return async (input) => {
    const record = deps.registry.get(input.definitionId)
    const name = record.settings.identity.name || 'This agent'
    const refusal = savedAgentRefusal(record, name)
    if (refusal) throw new Error(refusal)
    const revision = record.published!.revision
    const resolver = await deps.resolverFor(record.runtimeKind, input.workspaceRoot)
    const resolved = resolver.resolve({ definitionId: input.definitionId, revision, task: input.prompt })
    const agent: ScheduledRunAgent = { definitionId: input.definitionId, name: resolved.settings.identity.name || name, revision: resolved.revision }
    if (resolved.settings.memory.scope !== 'thread' && resolved.settings.memory.scope !== 'off') {
      return { status: 'failed', text: '', error: `${agent.name} keeps memory across threads, which automations do not run yet.`, agent }
    }
    const host: AgentRuntimeHostBindings = {
      workspaceRoots: [input.workspaceRoot],
      approveToolRequest: (request) => approveOnThread(deps.services, input.threadId, request, input.signal)
    }
    assertRuntimeSettingsSupported(resolved, host)
    const result = await deps.services.orchestrator.runAgentDefinition({
      profileId: deps.services.profileId,
      resolved,
      runId: input.runId,
      threadId: input.threadId,
      projectPath: input.workspaceRoot,
      input: input.prompt,
      source: 'schedule',
      host,
      context: { profileId: deps.services.profileId, threadId: input.threadId, definitionId: input.definitionId, history: [], selectedFiles: [], memory: { scope: resolved.settings.memory.scope, entries: [] } },
      signal: input.signal
    })
    return { status: result.status, text: result.text, ...(result.error ? { error: result.error.message } : {}), agent }
  }
}

/** A tool call the agent's grants send to a person: asked on the run's thread, with its exact arguments. */
async function approveOnThread(
  services: Pick<MmsProfileServices, 'questions'>,
  threadId: string,
  request: AgentRuntimeToolApprovalRequest,
  signal: AbortSignal
) {
  if (request.threadId !== threadId || signal.aborted) return { status: 'cancelled' as const }
  const json = canonicalJson(request.arguments)
  if (Buffer.byteLength(json, 'utf8') > APPROVAL_ARGUMENT_MAX_BYTES) return { status: 'denied' as const, reason: approvalTooLongReason(request) }
  if (sha256Hex(json) !== request.argumentDigest) return { status: 'denied' as const }
  try {
    const answers = await services.questions.requestAnswers([{ id: 'approval', prompt: `Allow ${request.canonicalToolName}?\nDigest: ${request.argumentDigest}\nArguments: ${json}`,
      options: [{ id: 'approve', label: 'Allow this action' }, { id: 'reject', label: 'Reject' }] }], threadId)
    const approved = !signal.aborted && answers.approval === 'approve'
    return { status: approved ? 'approved' as const : 'denied' as const, digest: request.argumentDigest }
  } catch {
    return { status: 'cancelled' as const }
  }
}

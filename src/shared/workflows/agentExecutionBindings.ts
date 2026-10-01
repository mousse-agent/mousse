import type { AgentRuntimeKind } from '../agents/types'
import type { ExecutionPolicyLayer } from '../execution/types'
import type { WorkflowExecutionBindings } from './executionBindings'

/** Additive field root must merge onto `WorkflowExecutionBindings`. */
export const WORKFLOW_AGENT_BINDINGS_FIELD = 'agents' as const

export const WORKFLOW_MAIN_AGENT_DEFINITION_ID = 'main'

export const WORKFLOW_AGENT_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
export const WORKFLOW_AGENT_BINDINGS_MAX_BYTES = 8 * 1024 * 1024

/** Host-pinned agent identity. Full settings live in the digest-addressed snapshot artifact. */
export interface WorkflowAgentPin {
  kind: 'main' | 'user'
  requestedDefinitionId?: string
  requestedRevision?: string
  definitionId: string
  revision: string
  snapshotHash: string
  runtimeKind: AgentRuntimeKind
}

/**
 * Additive workflow execution binding. Persist before effect admission.
 * Root/child merge this onto `WorkflowExecutionBindings.agents`.
 */
export interface WorkflowAgentExecutionBindings {
  version: 1
  profileId: string
  snapshotDigest: string
  pins: WorkflowAgentPin[]
}

export type WorkflowExecutionBindingsWithAgents = WorkflowExecutionBindings & {
  [WORKFLOW_AGENT_BINDINGS_FIELD]: WorkflowAgentExecutionBindings
}

export function mergeWorkflowAgentBindings(
  bindings: WorkflowExecutionBindings,
  agents: WorkflowAgentExecutionBindings
): WorkflowExecutionBindingsWithAgents {
  if (bindings.profileId !== agents.profileId) {
    throw Object.assign(new Error('Workflow agent bindings belong to another profile'), { code: 'profile_mismatch' })
  }
  return { ...structuredClone(bindings), agents: structuredClone(agents) }
}

export function mergeWorkflowAgentInstallationPolicy(
  base: ExecutionPolicyLayer,
  agents: ExecutionPolicyLayer
): ExecutionPolicyLayer {
  return {
    ...base,
    allowedTools: [...new Set([...(base.allowedTools ?? []), ...(agents.allowedTools ?? [])])],
    allowedCapabilities: [...new Set([...(base.allowedCapabilities ?? []), ...(agents.allowedCapabilities ?? [])])],
    allowedEffects: [...new Set([...(base.allowedEffects ?? []), ...(agents.allowedEffects ?? [])])] as ExecutionPolicyLayer['allowedEffects']
  }
}

export function mergeWorkflowAgentPreparation(
  base: { bindings: WorkflowExecutionBindings; installationPolicy: ExecutionPolicyLayer },
  agents: { bindings: WorkflowAgentExecutionBindings; installationPolicy: ExecutionPolicyLayer }
): { bindings: WorkflowExecutionBindingsWithAgents; installationPolicy: ExecutionPolicyLayer } {
  return {
    bindings: mergeWorkflowAgentBindings(base.bindings, agents.bindings),
    installationPolicy: mergeWorkflowAgentInstallationPolicy(base.installationPolicy, agents.installationPolicy)
  }
}

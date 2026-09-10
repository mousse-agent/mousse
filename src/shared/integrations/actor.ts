import type { AgentTypeId } from '../settings'
import type { McpServerConfig, McpToolDescriptor, SkillDescriptor } from '../integrations'

export type IntegrationActorKind = 'main' | 'agent' | 'workflow'

export interface IntegrationActor {
  kind: IntegrationActorKind
  agentType?: AgentTypeId
  agentId?: string
  runId?: string
  /** Explicit skill installation or registry ids. When set, only these may be visible. */
  skillIds?: string[]
  /** Explicit MCP installation or registry ids. When set, only these may be visible. */
  mcpServerIds?: string[]
  /** Optional per-tool grants using provider names, tool names, or `server/tool`. */
  mcpToolIds?: string[]
}

export interface IntegrationPolicySlice {
  enabled: boolean
  enableForMainAgent: boolean
  enableForAgents: Record<AgentTypeId, boolean>
}

export function defaultIntegrationActor(subagent: boolean): IntegrationActor {
  return subagent ? { kind: 'agent', agentType: 'mousse' } : { kind: 'main' }
}

export function actorUsesMainAgentGates(actor: IntegrationActor): boolean {
  return actor.kind === 'main'
}

export function actorAgentType(actor: IntegrationActor): AgentTypeId | undefined {
  if (actor.kind === 'main') return undefined
  return actor.agentType ?? (actor.kind === 'agent' ? 'mousse' : undefined)
}

export function policyEnabledForActor(
  policy: IntegrationPolicySlice,
  actor: IntegrationActor
): boolean {
  if (!policy.enabled) return false
  if (actorUsesMainAgentGates(actor)) return policy.enableForMainAgent
  const agentType = actorAgentType(actor)
  if (!agentType) return false
  return policy.enableForAgents[agentType] === true
}

export function matchesIntegrationIdentity(
  enabled: Set<string>,
  identities: Array<string | undefined>
): boolean {
  if (enabled.size === 0) return false
  for (const identity of identities) {
    if (identity && enabled.has(identity)) return true
  }
  return false
}

export function uniqueNameIdentity(
  name: string,
  items: Array<{ name: string; id: string }>
): string | undefined {
  const matches = items.filter((item) => item.name === name)
  return matches.length === 1 ? matches[0].id : undefined
}

export function skillIdentities(skill: SkillDescriptor): string[] {
  return [skill.installationId, skill.id, skill.name].filter((value): value is string => Boolean(value))
}

export function serverIdentities(server: McpServerConfig): string[] {
  return [server.installationId, server.id, server.name].filter((value): value is string => Boolean(value))
}

export function toolIdentities(tool: McpToolDescriptor): string[] {
  return [
    tool.providerName,
    tool.id,
    tool.toolName,
    `${tool.serverName}/${tool.toolName}`,
    tool.installationId ? `${tool.installationId}/${tool.toolName}` : undefined
  ].filter((value): value is string => Boolean(value))
}

import type {
  McpServerConfig,
  McpToolDescriptor,
  MousseIntegrationsSettings,
  SkillDescriptor,
  SkillsRegistrySnapshot
} from '../../../shared/integrations'
import {
  actorAgentType,
  matchesIntegrationIdentity,
  policyEnabledForActor,
  serverIdentities,
  skillIdentities,
  toolIdentities,
  uniqueNameIdentity,
  type IntegrationActor
} from '../../../shared/integrations/actor'

export function resolveEffectiveSkills(args: {
  snapshot: SkillsRegistrySnapshot
  settings: MousseIntegrationsSettings['skills']
  actor: IntegrationActor
}): SkillDescriptor[] {
  const { snapshot, settings, actor } = args
  if (!policyEnabledForActor(settings, actor)) return []

  const selected = new Set(actor.skillIds?.length ? actor.skillIds : settings.enabledSkills)
  if (selected.size === 0) return []

  const uniqueNames = new Map<string, string>()
  for (const skill of snapshot.skills) {
    const unique = uniqueNameIdentity(
      skill.name,
      snapshot.skills.map((entry) => ({ name: entry.name, id: entry.id }))
    )
    if (unique) uniqueNames.set(skill.name, unique)
  }

  return snapshot.skills.filter((skill) => {
    if (skill.archived) return false
    if (skill.enabled === false) return false
    if (skill.isActive === false) return false
    if (actor.skillIds?.length) {
      return matchesIntegrationIdentity(selected, skillIdentities(skill))
    }
    return (
      matchesIntegrationIdentity(selected, skillIdentities(skill)) ||
      (uniqueNames.get(skill.name) === skill.id && selected.has(skill.name))
    )
  })
}

export function resolveEffectiveMcpServers(args: {
  servers: McpServerConfig[]
  settings: MousseIntegrationsSettings['mcp']
  actor: IntegrationActor
}): McpServerConfig[] {
  const { servers, settings, actor } = args
  if (!policyEnabledForActor(settings, actor)) return []

  const selected = new Set(actor.mcpServerIds?.length ? actor.mcpServerIds : settings.enabledServers)
  if (selected.size === 0) return []

  return servers.filter((server) => {
    if (server.enabled === false || server.status === 'disabled') return false
    if (actor.mcpServerIds?.length) {
      return matchesIntegrationIdentity(selected, serverIdentities(server))
    }
    const unique = uniqueNameIdentity(
      server.name,
      servers.map((entry) => ({ name: entry.name, id: entry.id }))
    )
    return (
      matchesIntegrationIdentity(selected, serverIdentities(server)) ||
      (unique === server.id && selected.has(server.name))
    )
  })
}

export function isMcpToolAllowedForActor(
  tool: McpToolDescriptor,
  server: McpServerConfig | undefined,
  actor: IntegrationActor
): boolean {
  if (!server || server.enabled === false || server.status === 'disabled') return false
  if (server.enabledTools?.length && !server.enabledTools.includes(tool.toolName)) return false
  if (server.deniedTools?.includes(tool.toolName)) return false
  if (!actor.mcpToolIds?.length) return true
  const allowed = new Set(actor.mcpToolIds)
  return matchesIntegrationIdentity(allowed, toolIdentities(tool))
}

export function describeActorGrant(actor: IntegrationActor): string {
  const agentType = actorAgentType(actor)
  if (actor.kind === 'main') return 'main-agent'
  if (agentType) return `agent:${agentType}`
  return actor.kind
}

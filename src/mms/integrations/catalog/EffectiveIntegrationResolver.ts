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
  toolIdentities,
  type IntegrationActor
} from '../../../shared/integrations/actor'

export function resolveEffectiveSkills(args: {
  snapshot: SkillsRegistrySnapshot
  settings: MousseIntegrationsSettings['skills']
  actor: IntegrationActor
}): SkillDescriptor[] {
  const { snapshot, settings, actor } = args
  if (!policyEnabledForActor(settings, actor)) return []

  const explicitActorGrant = Boolean(actor.skillIds?.length)
  const selected = new Set(actor.skillIds?.length ? actor.skillIds : settings.enabledSkills)
  if (selected.size === 0) return []

  return snapshot.skills.filter((skill) => {
    if (skill.archived) return false
    if (skill.enabled === false) return false
    const managed = skill.managed !== false && skill.source !== 'mousse-project-external'
    if (!managed && !explicitActorGrant) return false
    if (!managed) return Boolean(skill.installationId && selected.has(skill.installationId))
    if (skill.isActive === false) return false
    return matchesIntegrationIdentity(selected, [skill.installationId, skill.id])
  })
}

export function resolveEffectiveMcpServers(args: {
  servers: McpServerConfig[]
  settings: MousseIntegrationsSettings['mcp']
  actor: IntegrationActor
}): McpServerConfig[] {
  const { servers, settings, actor } = args
  if (!policyEnabledForActor(settings, actor)) return []

  const explicitActorGrant = Boolean(actor.mcpServerIds?.length)
  const selected = new Set(actor.mcpServerIds?.length ? actor.mcpServerIds : settings.enabledServers)
  if (selected.size === 0) return []

  return servers.filter((server) => {
    if (server.enabled === false || server.status === 'disabled') return false
    const managed = server.managed !== false && server.source !== 'mousse-project-external'
    if (!managed && !explicitActorGrant) return false
    if (!managed) return Boolean(server.installationId && selected.has(server.installationId))
    return matchesIntegrationIdentity(selected, [server.installationId, server.id])
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

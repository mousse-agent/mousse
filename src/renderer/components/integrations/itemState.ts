import type { McpServerConfig, MousseIntegrationsSettings, SkillDescriptor } from '../../../shared/integrations'

export type IntegrationKind = 'skills' | 'mcp'
type Kind = IntegrationKind
/** Settings-side gates and selection lists for skills and MCP servers. */
export type IntegrationGates = Pick<MousseIntegrationsSettings, 'skills' | 'mcp'>

export const itemId = (item: SkillDescriptor | McpServerConfig) => item.installationId ?? item.id

function installedOn(kind: Kind, item: SkillDescriptor | McpServerConfig): boolean {
  if (item.enabled === false) return false
  return kind === 'skills' ? !(item as SkillDescriptor).archived && (item as SkillDescriptor).isActive !== false : true
}

function selectedIn(integrations: IntegrationGates | undefined, kind: Kind, item: SkillDescriptor | McpServerConfig): boolean {
  if (!integrations) return true
  if (!integrations[kind].enabled) return false
  const selected = kind === 'skills' ? integrations.skills.enabledSkills : integrations.mcp.enabledServers
  return selected.includes(itemId(item)) || selected.includes(item.id)
}

/** Whether a row's switch reads on: installed, selected, and its hidden gate on. */
export function isIntegrationItemOn(kind: Kind, item: SkillDescriptor | McpServerConfig, integrations?: IntegrationGates): boolean {
  return installedOn(kind, item) && selectedIn(integrations, kind, item)
}

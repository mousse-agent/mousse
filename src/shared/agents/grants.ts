import type { AgentIntegrationLookup } from './types'
import type {
  AgentBuiltinToolsSettings,
  AgentMcpSettings,
  AgentSkillsSettings,
  DeniedAgentGrant,
  EffectiveAgentGrantEntry,
  EffectiveAgentGrants
} from './types'

export function resolveSkillGrants(
  settings: AgentSkillsSettings,
  lookup: AgentIntegrationLookup
): { grants: EffectiveAgentGrantEntry[]; denied: DeniedAgentGrant[] } {
  const grants: EffectiveAgentGrantEntry[] = []
  const denied: DeniedAgentGrant[] = []
  const explicit = new Map(settings.selections.map((selection) => [selection.skillId, selection]))

  const candidateIds =
    settings.mode === 'inherit'
      ? Array.from(new Set([...lookup.listProfileSkillIds(), ...explicit.keys()]))
      : [...explicit.keys()]

  for (const skillId of candidateIds) {
    const selection = explicit.get(skillId)
    if (selection?.enabled === false) {
      denied.push({ kind: 'skill', id: skillId, reason: 'Explicitly disabled on the definition.' })
      continue
    }
    if (settings.mode === 'explicit' && !selection) continue
    if (settings.mode === 'inherit' && !selection && !lookup.listProfileSkillIds().includes(skillId)) continue
    const record = lookup.getSkill(skillId)
    if (!record || !record.available) {
      denied.push({ kind: 'skill', id: skillId, reason: 'Skill is not installed or not available to this profile.' })
      continue
    }
    if (selection?.pinRevision && selection.pinRevision !== record.revision) {
      denied.push({
        kind: 'skill',
        id: skillId,
        reason: `Pinned skill revision ${selection.pinRevision} is not available to this profile.`
      })
      continue
    }
    grants.push({
      id: skillId,
      source: selection ? 'explicit' : 'inherited',
      revision: selection?.pinRevision ?? record.revision,
      hash: record.hash
    })
  }
  return { grants, denied }
}

export function resolveMcpGrants(
  settings: AgentMcpSettings,
  lookup: AgentIntegrationLookup
): { grants: Array<EffectiveAgentGrantEntry & { serverId: string; toolName: string }>; denied: DeniedAgentGrant[] } {
  const grants: Array<EffectiveAgentGrantEntry & { serverId: string; toolName: string }> = []
  const denied: DeniedAgentGrant[] = []

  const configuredServers = new Map(settings.servers.map((server) => [server.serverId, server]))
  const candidates = settings.mode === 'inherit'
    ? lookup.listMcpTools()
    : settings.servers.flatMap((server) =>
        server.tools.map((tool) => lookup.getMcpTool(server.serverId, tool.toolName) ?? {
          serverId: server.serverId,
          toolName: tool.toolName,
          available: false
        })
      )

  for (const tool of candidates) {
    const server = configuredServers.get(tool.serverId)
    const selection = server?.tools.find((item) => item.toolName === tool.toolName)
    if (server?.enabled === false) {
      denied.push({
        kind: 'mcp',
        id: `${tool.serverId}/${tool.toolName}`,
        reason: 'MCP server is explicitly disabled on the definition.'
      })
      continue
    }
    if (selection?.enabled === false) {
      denied.push({
        kind: 'mcp',
        id: `${tool.serverId}/${tool.toolName}`,
        reason: 'MCP tool is explicitly disabled on the definition.'
      })
      continue
    }
    if (settings.mode === 'explicit' && (!server?.enabled || !selection?.enabled)) continue
    if (!tool.available) {
      denied.push({
        kind: 'mcp',
        id: `${tool.serverId}/${tool.toolName}`,
        reason: 'MCP tool is not available to this profile.'
      })
      continue
    }
    grants.push({
      id: `${tool.serverId}/${tool.toolName}`,
      serverId: tool.serverId,
      toolName: tool.toolName,
      source: selection ? 'explicit' : 'inherited',
      revision: tool.revision,
      hash: tool.hash
    })
  }

  for (const server of settings.servers) {
    if (!server.enabled || server.tools.length > 0) continue
    if (settings.mode === 'explicit') {
      denied.push({
        kind: 'mcp',
        id: server.serverId,
        reason: 'A server toggle is not carte blanche; list tools explicitly or inherit profile tools.'
      })
    }
  }

  return { grants, denied }
}

export function resolveBuiltinToolGrants(
  settings: AgentBuiltinToolsSettings,
  lookup: AgentIntegrationLookup
): { grants: EffectiveAgentGrantEntry[]; denied: DeniedAgentGrant[] } {
  const profileTools = lookup.listProfileBuiltinToolIds()
  const grants: EffectiveAgentGrantEntry[] = []
  const denied: DeniedAgentGrant[] = []
  const allow = new Set(settings.allowlist)

  const candidates = settings.mode === 'inherit' ? profileTools : settings.allowlist
  for (const toolId of candidates) {
    if (settings.mode === 'inherit' && allow.size > 0 && !allow.has(toolId)) {
      denied.push({ kind: 'tool', id: toolId, reason: 'Built-in tool is not on the definition allowlist.' })
      continue
    }
    if (settings.mode === 'explicit' && !profileTools.includes(toolId)) {
      denied.push({ kind: 'tool', id: toolId, reason: 'Built-in tool is not granted by the profile.' })
      continue
    }
    grants.push({
      id: toolId,
      source: settings.mode === 'inherit' && !settings.allowlist.includes(toolId) ? 'inherited' : settings.mode === 'inherit' ? 'inherited' : 'explicit'
    })
  }
  return { grants, denied }
}

export function resolveEffectiveGrants(
  settings: {
    skills: AgentSkillsSettings
    mcp: AgentMcpSettings
    tools: AgentBuiltinToolsSettings
  },
  lookup: AgentIntegrationLookup
): EffectiveAgentGrants {
  const skills = resolveSkillGrants(settings.skills, lookup)
  const mcp = resolveMcpGrants(settings.mcp, lookup)
  const tools = resolveBuiltinToolGrants(settings.tools, lookup)
  return {
    skills: skills.grants,
    mcpTools: mcp.grants,
    builtinTools: tools.grants,
    denied: [...skills.denied, ...mcp.denied, ...tools.denied]
  }
}

export function grantDependencyHashes(grants: EffectiveAgentGrants): Record<string, string> {
  const hashes: Record<string, string> = {}
  for (const skill of grants.skills) {
    if (skill.hash) hashes[`skill:${skill.id}`] = skill.hash
  }
  for (const tool of grants.mcpTools) {
    if (tool.hash) hashes[`mcp:${tool.id}`] = tool.hash
  }
  return hashes
}

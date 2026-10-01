import type {
  AgentIntegrationLookup,
  AgentMcpLookupRecord,
  AgentModelCapabilityProfile,
  AgentModelLookup,
  AgentModelRef,
  AgentSkillLookupRecord
} from '../../shared/agents/types'

export interface StaticModelEntry extends AgentModelCapabilityProfile {}

export class StaticAgentModelLookup implements AgentModelLookup {
  constructor(private readonly models: StaticModelEntry[]) {}

  resolve(ref: AgentModelRef): AgentModelCapabilityProfile | null {
    const match = this.models.find(
      (entry) => entry.ref.providerId === ref.providerId && entry.ref.modelId === ref.modelId
    )
    if (!match) return null
    return {
      ...match,
      ref: { ...match.ref, ...ref }
    }
  }
}

export interface StaticIntegrationState {
  skills?: AgentSkillLookupRecord[]
  mcpTools?: AgentMcpLookupRecord[]
  builtinToolIds?: string[]
}

export class StaticAgentIntegrationLookup implements AgentIntegrationLookup {
  constructor(private readonly state: StaticIntegrationState = {}) {}

  listProfileSkillIds(): string[] {
    return (this.state.skills ?? []).filter((skill) => skill.available).map((skill) => skill.id)
  }

  listProfileBuiltinToolIds(): string[] {
    return [...(this.state.builtinToolIds ?? [])]
  }

  getSkill(id: string): AgentSkillLookupRecord | null {
    return this.state.skills?.find((skill) => skill.id === id) ?? null
  }

  listMcpTools(serverId?: string): AgentMcpLookupRecord[] {
    const tools = this.state.mcpTools ?? []
    return serverId ? tools.filter((tool) => tool.serverId === serverId) : tools
  }

  getMcpTool(serverId: string, toolName: string): AgentMcpLookupRecord | null {
    return this.state.mcpTools?.find((tool) => tool.serverId === serverId && tool.toolName === toolName) ?? null
  }
}

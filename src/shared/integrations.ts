import type { AgentTypeId, LlmProviderId } from './settings'

export type IntegrationScope = 'global' | 'project' | 'generated'

export type IntegrationDiagnosticLevel = 'info' | 'warning' | 'error'

export interface IntegrationDiagnostic {
  level: IntegrationDiagnosticLevel
  message: string
  source?: string
  path?: string
  targetId?: string
}

export type McpTransport = 'stdio' | 'http' | 'sse'

export type McpConfigSource =
  | 'mousse'
  | 'cursor-global'
  | 'cursor-project'
  | 'claude-project'
  | 'codex-project'
  | 'opencode-project'
  | 'generated-agent'

export type McpServerStatus =
  | 'disabled'
  | 'configured'
  | 'starting'
  | 'connected'
  | 'failed'
  | 'missing-env'
  | 'auth-required'

export interface McpAuthConfig {
  clientId?: string
  clientSecret?: string
  scopes?: string[]
}

export interface McpServerConfig {
  id: string
  name: string
  source: McpConfigSource
  scope: IntegrationScope
  configPath?: string
  transport: McpTransport
  status: McpServerStatus
  enabled?: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  auth?: McpAuthConfig
  missingEnvVars?: string[]
  diagnostics?: IntegrationDiagnostic[]
}

export interface McpConfigSourceDescriptor {
  source: McpConfigSource
  scope: IntegrationScope
  path: string
  format: 'cursor-json' | 'claude-json' | 'codex-toml' | 'opencode-json' | 'mousse-json'
  exists: boolean
}

export interface McpRegistrySnapshot {
  servers: McpServerConfig[]
  sources: McpConfigSourceDescriptor[]
  diagnostics: IntegrationDiagnostic[]
}

export interface McpToolDescriptor {
  id: string
  serverId: string
  serverName: string
  toolName: string
  providerName: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpToolCallLog {
  serverId: string
  serverName: string
  toolName: string
  providerName: string
  arguments: Record<string, unknown>
  status: 'started' | 'completed' | 'failed'
  resultSummary?: string
  error?: string
}

export type SkillSource =
  | 'cursor-global'
  | 'cursor-project'
  | 'agents-global'
  | 'agents-project'
  | 'claude-global'
  | 'claude-project'
  | 'codex-global'
  | 'codex-project'
  | 'opencode-global'
  | 'opencode-project'
  | 'generated-agent'

export interface SkillDescriptor {
  id: string
  name: string
  description: string
  rootPath: string
  skillPath: string
  scope: IntegrationScope
  source: SkillSource
  paths?: string[]
  'disable-model-invocation'?: boolean
  metadata?: Record<string, unknown>
  compatibility?: string[] | Record<string, unknown>
  hasScripts?: boolean
  hasAssets?: boolean
  hasReferences?: boolean
  isActive?: boolean
  duplicateOf?: string
  diagnostics?: IntegrationDiagnostic[]
}

export interface SkillSourceDescriptor {
  source: SkillSource
  scope: IntegrationScope
  path: string
  exists: boolean
}

export interface SkillsRegistrySnapshot {
  skills: SkillDescriptor[]
  sources: SkillSourceDescriptor[]
  diagnostics: IntegrationDiagnostic[]
}

export interface SkillReadResult {
  skill: SkillDescriptor
  content: string
}

export interface AgentConfigPreparationResult {
  agentId: string
  cliType: AgentTypeId
  generatedFiles: string[]
  cleanupPaths: string[]
  env: Record<string, string>
  warnings: string[]
  logs: string[]
}

export interface AgentIntegrationPolicy {
  enableForMainAgent: boolean
  enableForAgents: Record<AgentTypeId, boolean>
}

export interface SkillModelSettings {
  llmProvider: LlmProviderId
  model: string
}

export interface MousseIntegrationsSettings {
  mcp: AgentIntegrationPolicy & {
    enabled: boolean
    enabledServers: string[]
  }
  skills: AgentIntegrationPolicy & {
    enabled: boolean
    enabledSkills: string[]
    model: Record<string, SkillModelSettings>
  }
}

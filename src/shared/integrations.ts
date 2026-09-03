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

export interface MousseToolsSettings {
  enabled: boolean
  enabledTools: string[]
}

export type MousseBuiltInToolGroupId = 'project' | 'interaction' | 'tasks' | 'actions' | 'skills'

export interface MousseBuiltInToolGroupInfo {
  id: MousseBuiltInToolGroupId
  label: string
  description: string
}

export const MOUSSE_BUILTIN_TOOL_GROUPS: MousseBuiltInToolGroupInfo[] = [
  { id: 'project', label: 'Project tools', description: 'File, shell and git tools.' },
  { id: 'interaction', label: 'Interaction', description: 'Questions and document previews.' },
  { id: 'tasks', label: 'Tasks', description: 'Thread task queue management.' },
  { id: 'actions', label: 'Quick actions', description: 'Reusable chat header buttons.' },
  { id: 'skills', label: 'Skill helpers', description: 'List and load agent skills.' }
]

export interface MousseBuiltInToolInfo {
  id: string
  label: string
  description: string
  group: MousseBuiltInToolGroupId
}

export const MOUSSE_BUILTIN_TOOLS: MousseBuiltInToolInfo[] = [
  { id: 'read', label: 'read', description: 'Read text files from the project.', group: 'project' },
  { id: 'bash', label: 'bash', description: 'Run shell commands in the project root.', group: 'project' },
  { id: 'edit', label: 'edit', description: 'Apply targeted edits to project files.', group: 'project' },
  { id: 'write', label: 'write', description: 'Write full file contents in the project.', group: 'project' },
  { id: 'grep', label: 'grep', description: 'Search file contents inside the project.', group: 'project' },
  { id: 'find', label: 'find', description: 'Find files by name inside the project.', group: 'project' },
  { id: 'ls', label: 'ls', description: 'List files and directories in the project.', group: 'project' },
  { id: 'git_status', label: 'git_status', description: 'Get git status for the project repository.', group: 'project' },
  { id: 'git_diff', label: 'git_diff', description: 'Get a git diff for one file.', group: 'project' },
  { id: 'ask_user', label: 'ask_user', description: 'Ask the user clarifying questions.', group: 'interaction' },
  { id: 'show_document', label: 'show_document', description: 'Open a markdown document preview.', group: 'interaction' },
  { id: 'list_tasks', label: 'list_tasks', description: 'List tasks in the thread queue.', group: 'tasks' },
  { id: 'create_task', label: 'create_task', description: 'Create a task in the thread queue.', group: 'tasks' },
  { id: 'update_task', label: 'update_task', description: 'Update an existing task by id.', group: 'tasks' },
  { id: 'create_quick_action', label: 'create_quick_action', description: 'Create a reusable quick-action button.', group: 'actions' },
  { id: 'list_skills', label: 'list_skills', description: 'List available agent skills.', group: 'skills' },
  { id: 'load_skill', label: 'load_skill', description: 'Load a skill’s instructions by name or id.', group: 'skills' }
]

export const MOUSSE_BUILTIN_TOOL_IDS: string[] = MOUSSE_BUILTIN_TOOLS.map((tool) => tool.id)

export interface MousseIntegrationsSettings {
  tools: MousseToolsSettings
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

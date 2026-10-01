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
  | 'mousse-project-external'
  | 'cursor-global'
  | 'cursor-project'
  | 'claude-project'
  | 'codex-project'
  | 'opencode-project'
  | 'generated-agent'

export type McpServerStatus =
  | 'disabled'
  | 'configured'
  | 'discovered'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'degraded'
  | 'error'
  | 'missing-env'
  | 'auth-required'

export type McpAuthMode = 'anonymous' | 'static' | 'oauth'

export type McpErrorCategory =
  | 'missing'
  | 'disabled'
  | 'unreachable'
  | 'auth-required'
  | 'unauthorized'
  | 'cancelled'
  | 'timeout'
  | 'schema-incompatible'
  | 'missing-env'
  | 'missing-executable'
  | 'protocol'
  | 'dns'
  | 'tls'
  | 'http'
  | 'unknown'

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
  authMode?: McpAuthMode
  missingEnvVars?: string[]
  diagnostics?: IntegrationDiagnostic[]
  /** Profile that owns this installation. Absent for external discoveries. */
  profileId?: string
  /** Stable project identity. Project managed storage is profile-owned; external discoveries are read-only. */
  projectId?: string
  /** True only for profile-owned managed records. */
  managed?: boolean
  /** Stable installation identity used for grants and live connections. */
  installationId?: string
  /** Canonical hash of connection-affecting configuration bytes. */
  configRevision?: string
  /** Optional allowlist of tool names on this server. */
  enabledTools?: string[]
  /** Optional denylist of tool names on this server. */
  deniedTools?: string[]
}

export interface McpConfigSourceDescriptor {
  source: McpConfigSource
  scope: IntegrationScope
  path: string
  format: 'cursor-json' | 'claude-json' | 'codex-toml' | 'opencode-json' | 'mousse-json'
  exists: boolean
  projectId?: string
  profileId?: string
  managed?: boolean
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
  outputSchema?: Record<string, unknown>
  installationId?: string
  configRevision?: string
  profileId?: string
  schemaError?: string
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
  | 'mousse-profile'
  | 'mousse-project'
  | 'mousse-project-external'

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
  compatibility?: string[] | Record<string, unknown> | string
  hasScripts?: boolean
  hasAssets?: boolean
  hasReferences?: boolean
  isActive?: boolean
  duplicateOf?: string
  diagnostics?: IntegrationDiagnostic[]
  profileId?: string
  /** Stable project identity. Project managed storage is profile-owned; external discoveries are read-only. */
  projectId?: string
  /** True only for profile-owned managed records. */
  managed?: boolean
  installationId?: string
  revision?: string
  contentHash?: string
  enabled?: boolean
  archived?: boolean
  license?: string
  allowedTools?: string
  executableAssets?: string[]
}

export interface SkillSourceDescriptor {
  source: SkillSource
  scope: IntegrationScope
  path: string
  exists: boolean
  projectId?: string
  profileId?: string
  managed?: boolean
}

export interface SkillsRegistrySnapshot {
  skills: SkillDescriptor[]
  sources: SkillSourceDescriptor[]
  diagnostics: IntegrationDiagnostic[]
}

export interface SkillReadResult {
  skill: SkillDescriptor
  content: string
  /** Markdown body after closed frontmatter. Exact bytes aside from normalized reads. */
  body?: string
  frontmatter?: Record<string, unknown>
  files?: SkillPackageFile[]
}

export interface SkillPackageFile {
  relativePath: string
  bytes: number
  executable?: boolean
}

export interface AgentConfigPreparationResult {
  agentId: string
  cliType: AgentTypeId
  generatedFiles: string[]
  cleanupPaths: string[]
  env: Record<string, string>
  warnings: string[]
  logs: string[]
  unsupportedCapabilities: IntegrationDiagnostic[]
  /** Runtime-specific exact tool names keyed by stable `serverId/toolName` identities. */
  runtimeMcpToolNames?: Record<string, string>
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
  /** Built-ins known when enabledTools was last saved, so newly added tools can default on. */
  knownTools?: string[]
}

export type MousseBuiltInToolGroupId = 'project' | 'interaction' | 'tasks' | 'actions' | 'skills' | 'web' | 'browser' | 'devgui'

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
  { id: 'skills', label: 'Skill helpers', description: 'List and load agent skills.' },
  { id: 'web', label: 'Web', description: 'Search and fetch public web content.' },
  { id: 'browser', label: 'Browser', description: 'Host-selected in-app tab or managed browser tools.' },
  { id: 'devgui', label: 'Dev GUI', description: 'Development-only self-inspection of the Electron window.' }
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
  { id: 'present_plan', label: 'present_plan', description: 'Present an implementation plan as an approval card.', group: 'interaction' },
  { id: 'show_document', label: 'show_document', description: 'Open a markdown document preview.', group: 'interaction' },
  { id: 'list_tasks', label: 'list_tasks', description: 'List tasks in the thread queue.', group: 'tasks' },
  { id: 'create_task', label: 'create_task', description: 'Create a task in the thread queue.', group: 'tasks' },
  { id: 'update_task', label: 'update_task', description: 'Update an existing task by id.', group: 'tasks' },
  { id: 'create_quick_action', label: 'create_quick_action', description: 'Create a reusable quick-action button.', group: 'actions' },
  { id: 'list_skills', label: 'list_skills', description: 'List available agent skills.', group: 'skills' },
  { id: 'load_skill', label: 'load_skill', description: 'Load a skill’s instructions by name or id.', group: 'skills' },
  { id: 'web_search', label: 'web_search', description: 'Search the public web with Exa or Parallel.', group: 'web' },
  { id: 'web_fetch', label: 'web_fetch', description: 'Fetch bounded readable content from an HTTP(S) URL.', group: 'web' },
  { id: 'browser_open', label: 'browser_open', description: 'Open a host-selected in-app tab or managed browser session.', group: 'browser' },
  { id: 'browser_tabs', label: 'browser_tabs', description: 'List or mutate tabs in the current browser session.', group: 'browser' },
  { id: 'browser_observe', label: 'browser_observe', description: 'Collect a bounded semantic browser observation.', group: 'browser' },
  { id: 'browser_screenshot', label: 'browser_screenshot', description: 'Capture a browser tab image when visual inspection is needed (image-capable models only).', group: 'browser' },
  { id: 'browser_find', label: 'browser_find', description: 'Find observed elements by text or role.', group: 'browser' },
  { id: 'browser_act', label: 'browser_act', description: 'Perform one validated browser action against a fresh observation.', group: 'browser' },
  { id: 'browser_wait', label: 'browser_wait', description: 'Wait for an explicit bounded browser condition.', group: 'browser' },
  { id: 'browser_extract', label: 'browser_extract', description: 'Extract bounded untrusted text from an observed region.', group: 'browser' },
  { id: 'browser_request_human', label: 'browser_request_human', description: 'Create a durable human-control handoff for a browser session.', group: 'browser' },
  { id: 'mousse_gui_screenshot', label: 'mousse_gui_screenshot', description: 'Dev only: capture the live Electron window.', group: 'devgui' },
  { id: 'mousse_gui_console', label: 'mousse_gui_console', description: 'Dev only: read the renderer console buffer.', group: 'devgui' },
  { id: 'mousse_gui_reload', label: 'mousse_gui_reload', description: 'Dev only: reload the renderer (Ctrl+R).', group: 'devgui' },
  { id: 'mousse_gui_devtools', label: 'mousse_gui_devtools', description: 'Dev only: open/close/toggle DevTools.', group: 'devgui' },
  { id: 'mousse_gui_evaluate', label: 'mousse_gui_evaluate', description: 'Dev only: run JS in the renderer (DOM inspection).', group: 'devgui' },
  { id: 'mousse_gui_status', label: 'mousse_gui_status', description: 'Dev only: check dev-window attach state (instant).', group: 'devgui' }
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

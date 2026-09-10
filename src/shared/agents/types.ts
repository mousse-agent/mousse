import type { AgentTypeId } from '../settings'
import type { AgentDefinitionIssue } from './errors'

/** Distinct from the runtime `Agent` record in `shared/types.ts`. */
export const AGENT_DEFINITION_SCHEMA_VERSION = 1 as const

export const AGENT_RUNTIME_KINDS = [
  'mousse',
  'claude-code',
  'codex',
  'opencode',
  'cursor-agents-cli'
] as const satisfies readonly AgentTypeId[]

export type AgentRuntimeKind = (typeof AGENT_RUNTIME_KINDS)[number]

export const AGENT_CAPABILITY_KINDS = [
  'reasoning',
  'vision',
  'tools',
  'json_schema',
  'browser_structured',
  'browser_hybrid',
  'browser_native',
  'long_context'
] as const

export type AgentCapabilityKind = (typeof AGENT_CAPABILITY_KINDS)[number]

export const AGENT_GRANT_MODES = ['inherit', 'explicit'] as const
export type AgentGrantMode = (typeof AGENT_GRANT_MODES)[number]

export const AGENT_GRANT_SOURCES = ['inherited', 'explicit'] as const
export type AgentGrantSource = (typeof AGENT_GRANT_SOURCES)[number]

export type AgentOutputFormat = 'markdown' | 'json' | 'schema'
export type AgentMemoryScope = 'off' | 'thread' | 'profile_agent'
export type AgentBrowserMode = 'disabled' | 'structured' | 'hybrid' | 'native'
export type AgentWorkspaceMode = 'read_only' | 'thread_worktree' | 'dedicated_child_worktree'
export type AgentScriptExecutionMode = 'sandboxed' | 'workspace'
export type AgentUnattendedBehavior = 'pause' | 'skip' | 'fail'
export type AgentApprovalPolicy = 'inherit' | 'always' | 'unattended_deny' | 'unattended_allow_readonly'
export type AgentAttachmentPolicy = 'none' | 'explicit' | 'thread'
export type AgentVerbosity = 'concise' | 'normal' | 'verbose'
export type AgentCitationPreference = 'none' | 'inline' | 'footnotes'
export type AgentFallbackRetryCategory = 'rate_limit' | 'timeout' | 'unavailable' | 'content_filter'
export type AgentContextSourceKind = 'thread' | 'selected_files' | 'project_instructions' | 'attachment'
export type AgentTraceRetention = 'none' | 'run' | 'profile'

export interface AgentIdentitySettings {
  name: string
  slug: string
  purpose: string
  tags: string[]
}

export interface AgentInstructionsSettings {
  /** Relative bundle path. Canonical value is `system.md`. */
  systemPromptFile: string
}

export interface AgentModelRef {
  providerId: string
  modelId: string
  familyId?: string
  variantId?: string
  effort?: string
  speed?: string
  context?: string
}

export interface AgentPrimaryModelSettings {
  ref: AgentModelRef
  capabilityOverrides: Partial<Record<AgentCapabilityKind, AgentModelRef>>
}

export interface AgentFallbackSettings {
  enabled: boolean
  models: AgentModelRef[]
  retryOn: AgentFallbackRetryCategory[]
  allowHigherCost: boolean
}

export interface AgentOutputSettings {
  language?: string
  tone?: string
  verbosity: AgentVerbosity
  citationPreference: AgentCitationPreference
  format: AgentOutputFormat
  jsonSchema?: Record<string, unknown>
}

export interface AgentContextSource {
  kind: AgentContextSourceKind
  required: boolean
  path?: string
}

export interface AgentContextSettings {
  includeCurrentThread: boolean
  selectedFiles: string[]
  includeProjectInstructions: boolean
  attachmentPolicy: AgentAttachmentPolicy
  maxContextTokens?: number
  sources: AgentContextSource[]
}

export interface AgentMemorySettings {
  scope: AgentMemoryScope
  retentionDays?: number
}

export interface AgentSkillSelection {
  skillId: string
  enabled: boolean
  pinRevision?: string
}

export interface AgentSkillsSettings {
  mode: AgentGrantMode
  selections: AgentSkillSelection[]
}

export interface AgentMcpToolSelection {
  toolName: string
  enabled: boolean
}

export interface AgentMcpServerSelection {
  serverId: string
  enabled: boolean
  tools: AgentMcpToolSelection[]
}

export interface AgentMcpSettings {
  mode: AgentGrantMode
  servers: AgentMcpServerSelection[]
}

export interface AgentBuiltinToolsSettings {
  mode: AgentGrantMode
  allowlist: string[]
}

export interface AgentBrowserSettings {
  mode: AgentBrowserMode
  workspaceId?: string
  allowedDomains: string[]
  traceRetention: AgentTraceRetention
}

export interface AgentDelegationSettings {
  allowedChildDefinitionIds: string[]
  maxConcurrentChildren: number
  maxDepth: number
}

export interface AgentWorkspaceSettings {
  mode: AgentWorkspaceMode
  permittedRoots: string[]
}

export interface AgentScriptPolicy {
  enabled: boolean
  interpreters: string[]
  executionMode: AgentScriptExecutionMode
  allowNetwork: boolean
  allowFilesystem: boolean
}

export interface AgentApprovalSettings {
  askUser: boolean
  policy: AgentApprovalPolicy
  unattendedBehavior: AgentUnattendedBehavior
}

export interface AgentLimitsSettings {
  maxTurns: number
  maxToolCalls: number
  maxElapsedMs: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxCostUsd?: number
  maxArtifactBytes: number
}

export interface AgentRecoverySettings {
  retryCount: number
  backoffMs: number
  transientCategories: AgentFallbackRetryCategory[]
  stopCondition?: string
  finalReportTemplate?: string
}

export interface AgentExample {
  id: string
  name: string
  prompt: string
  expectedSchema?: Record<string, unknown>
  assertions?: string[]
  fixtureContext?: Record<string, unknown>
}

/**
 * Orb palettes and related presentation belong to root.
 * Definitions may persist an opaque record; this module never interprets it.
 */
export type AgentVisualMetadata = Record<string, unknown>

export interface AgentDefinitionSettings {
  identity: AgentIdentitySettings
  instructions: AgentInstructionsSettings
  primaryModel: AgentPrimaryModelSettings
  fallbacks: AgentFallbackSettings
  output: AgentOutputSettings
  context: AgentContextSettings
  memory: AgentMemorySettings
  skills: AgentSkillsSettings
  mcp: AgentMcpSettings
  tools: AgentBuiltinToolsSettings
  browser: AgentBrowserSettings
  delegation: AgentDelegationSettings
  workspace: AgentWorkspaceSettings
  script: AgentScriptPolicy
  approval: AgentApprovalSettings
  limits: AgentLimitsSettings
  recovery: AgentRecoverySettings
  examples: AgentExample[]
}

export interface AgentLibraryFlags {
  enabled: boolean
  favorite: boolean
  archived: boolean
}

export interface AgentDefinitionManifest {
  schemaVersion: typeof AGENT_DEFINITION_SCHEMA_VERSION
  id: string
  runtimeKind: AgentRuntimeKind
  settings: AgentDefinitionSettings
}

export interface AgentPublishedRevision {
  revision: string
  visualRevision: string
  publishedAt: string
  dependencyHashes: Record<string, string>
}

export interface AgentDefinitionRecord {
  profileId: string
  id: string
  runtimeKind: AgentRuntimeKind
  settings: AgentDefinitionSettings
  systemPrompt: string
  visual: AgentVisualMetadata
  flags: AgentLibraryFlags
  draftHash: string
  semanticHash: string
  visualHash: string
  published?: AgentPublishedRevision
  createdAt: string
  updatedAt: string
}

export interface AgentDefinitionSummary {
  profileId: string
  id: string
  runtimeKind: AgentRuntimeKind
  name: string
  slug: string
  purpose: string
  tags: string[]
  enabled: boolean
  favorite: boolean
  archived: boolean
  draftHash: string
  semanticHash: string
  visualHash: string
  publishedRevision?: string
  updatedAt: string
}

export interface AgentImmutableRevision {
  definitionId: string
  profileId: string
  runtimeKind: AgentRuntimeKind
  revision: string
  visualRevision: string
  settings: AgentDefinitionSettings
  systemPrompt: string
  visual: AgentVisualMetadata
  dependencyHashes: Record<string, string>
  publishedAt: string
}

export interface AgentExportBundle {
  format: 'mousse-agent'
  formatVersion: 1
  manifest: AgentDefinitionManifest
  files: Record<string, string>
  visual: AgentVisualMetadata
  publishedRevision?: AgentPublishedRevision
}

export interface AgentModelCapabilityProfile {
  ref: AgentModelRef
  available: boolean
  label?: string
  efforts: string[]
  speeds: string[]
  contexts: string[]
  capabilities: AgentCapabilityKind[]
  unavailableReasons: string[]
}

export interface EffectiveAgentGrantEntry {
  id: string
  source: AgentGrantSource
  revision?: string
  hash?: string
}

export interface DeniedAgentGrant {
  kind: 'skill' | 'mcp' | 'tool'
  id: string
  reason: string
}

export interface EffectiveAgentGrants {
  skills: EffectiveAgentGrantEntry[]
  mcpTools: Array<EffectiveAgentGrantEntry & { serverId: string; toolName: string }>
  builtinTools: EffectiveAgentGrantEntry[]
  denied: DeniedAgentGrant[]
}

export interface ResolvedAgentInstructions {
  applicationRules: string
  profileProjectContext: string
  definitionInstructions: string
  workflowNodeInstructions: string
  task: string
  compiled: string
}

export interface ResolvedAgentDefinition {
  definitionId: string
  profileId: string
  revision: string
  visualRevision: string
  runtimeKind: AgentRuntimeKind
  settings: AgentDefinitionSettings
  instructions: ResolvedAgentInstructions
  model: {
    primary: AgentModelCapabilityProfile
    fallbacks: AgentModelCapabilityProfile[]
    capabilityOverrides: Partial<Record<AgentCapabilityKind, AgentModelCapabilityProfile>>
  }
  grants: EffectiveAgentGrants
  dependencyHashes: Record<string, string>
  visual: AgentVisualMetadata
  issues: AgentDefinitionIssue[]
}

export interface CreateAgentDefinitionInput {
  runtimeKind?: AgentRuntimeKind
  settings: Partial<AgentDefinitionSettings> & {
    identity: AgentIdentitySettings
  }
  systemPrompt?: string
  visual?: AgentVisualMetadata
  flags?: Partial<Pick<AgentLibraryFlags, 'enabled' | 'favorite'>>
}

export interface SaveAgentDraftInput {
  expectedDraftHash: string
  runtimeKind?: AgentRuntimeKind
  settings?: Partial<AgentDefinitionSettings>
  systemPrompt?: string
  visual?: AgentVisualMetadata
  flags?: Partial<Pick<AgentLibraryFlags, 'enabled' | 'favorite'>>
}

export interface AgentRuntimeCompatibility {
  runtimeKind: AgentRuntimeKind
  native: boolean
  supportedSettingPointers: string[]
  unsupportedSettingPointers: string[]
  notes: string[]
}

export interface AgentModelLookup {
  resolve(ref: AgentModelRef): AgentModelCapabilityProfile | null
}

export interface AgentSkillLookupRecord {
  id: string
  revision?: string
  hash?: string
  available: boolean
}

export interface AgentMcpLookupRecord {
  serverId: string
  toolName: string
  revision?: string
  hash?: string
  available: boolean
}

export interface AgentIntegrationLookup {
  listProfileSkillIds(): string[]
  listProfileBuiltinToolIds(): string[]
  getSkill(id: string): AgentSkillLookupRecord | null
  listMcpTools(serverId?: string): AgentMcpLookupRecord[]
  getMcpTool(serverId: string, toolName: string): AgentMcpLookupRecord | null
}

export interface AgentResolveRequest {
  definitionId: string
  revision?: string
  applicationRules?: string
  profileProjectContext?: string
  workflowNodeInstructions?: string
  task?: string
}

export const AGENT_BUNDLE_FILES = {
  manifest: 'agent.json',
  systemPrompt: 'system.md',
  visual: 'visual.json',
  examples: 'examples.json'
} as const

export const AGENT_SYSTEM_PROMPT_FILE = AGENT_BUNDLE_FILES.systemPrompt

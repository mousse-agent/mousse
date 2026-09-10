import type { LlmProviderOption } from '../../../shared/settings'
import type { AgentDefinitionError, AgentDefinitionIssue } from '../../../shared/agents/errors'
import type {
  AgentDefinitionRecord,
  AgentDefinitionSummary,
  AgentExportBundle,
  AgentModelRef,
  AgentPublishedRevision,
  AgentRuntimeKind,
  CreateAgentDefinitionInput,
  SaveAgentDraftInput
} from '../../../shared/agents/types'

/** Host-enriched list row. Diagnostics are optional; the daemon remains authoritative. */
export interface AgentLibraryItem extends AgentDefinitionSummary {
  model?: AgentModelRef
  modelLabel?: string
  lastRunAt?: string
  issues?: AgentDefinitionIssue[]
  visual?: unknown
}

export interface AgentDefinitionListQuery {
  profileId: string
  archived?: boolean
}

export interface AgentTryRunRequest {
  profileId: string
  id: string
  expectedDraftHash?: string
  revision?: string
  prompt: string
  exampleId?: string
}

export interface AgentTryRunResult {
  ok: boolean
  status: 'completed' | 'failed' | 'blocked'
  summary: string
  trace: Array<{ at: string; message: string }>
  issues?: AgentDefinitionIssue[]
}

export interface AgentValidateRequest {
  profileId: string
  id?: string
  expectedDraftHash?: string
}

export interface AgentValidateResult {
  issues: AgentDefinitionIssue[]
}

/**
 * Typed MMS port. Root binds this to `agentDefinitions.*` protocol methods after
 * profile binding. Production UI never constructs a success-faking adapter.
 */
export interface AgentDefinitionsClient {
  list(query: AgentDefinitionListQuery): Promise<AgentLibraryItem[]>
  get(query: { profileId: string; id: string }): Promise<AgentDefinitionRecord>
  create(query: { profileId: string } & CreateAgentDefinitionInput): Promise<AgentDefinitionRecord>
  saveDraft(
    query: { profileId: string; id: string; runtimeKind?: AgentRuntimeKind } & SaveAgentDraftInput
  ): Promise<AgentDefinitionRecord>
  publish(query: {
    profileId: string
    id: string
    expectedDraftHash: string
  }): Promise<AgentPublishedRevision>
  archive(query: { profileId: string; id: string }): Promise<AgentDefinitionRecord>
  duplicate(query: { profileId: string; id: string }): Promise<AgentDefinitionRecord>
  importBundle(query: {
    profileId: string
    bundle: AgentExportBundle
    conflict?: 'fail' | 'rename'
  }): Promise<AgentDefinitionRecord>
  exportBundle(query: { profileId: string; id: string; revision?: string }): Promise<AgentExportBundle>
  validate(query: AgentValidateRequest): Promise<AgentValidateResult>
  tryRun(query: AgentTryRunRequest): Promise<AgentTryRunResult>
}

export interface AgentEditorSkillOption {
  id: string
  name: string
  revision?: string
  available: boolean
}

export interface AgentEditorMcpToolOption {
  toolName: string
  available: boolean
}

export interface AgentEditorMcpServerOption {
  serverId: string
  name: string
  tools: AgentEditorMcpToolOption[]
}

export interface AgentEditorCatalogs {
  providers: LlmProviderOption[]
  skills: AgentEditorSkillOption[]
  mcpServers: AgentEditorMcpServerOption[]
  builtinTools: Array<{ id: string; label: string }>
  childDefinitions: Array<{ id: string; name: string }>
  browserWorkspaces: Array<{ id: string; name: string }>
}

export function isAgentDefinitionClientError(error: unknown): error is AgentDefinitionError {
  return Boolean(error && typeof error === 'object' && 'code' in error && 'message' in error)
}

export const AGENT_RUNTIME_LABELS: Record<AgentRuntimeKind, string> = {
  mousse: 'Mousse',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  'cursor-agents-cli': 'Cursor Agents CLI'
}

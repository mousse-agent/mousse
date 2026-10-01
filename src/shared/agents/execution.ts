import type {
  AgentApprovalPolicy,
  AgentAttachmentPolicy,
  AgentFallbackRetryCategory,
  AgentFallbackSettings,
  AgentMemoryScope,
  AgentRuntimeKind,
  AgentScriptExecutionMode,
  AgentUnattendedBehavior,
  AgentWorkspaceMode,
  EffectiveAgentGrants,
  ResolvedAgentDefinition
} from './types'

export type AgentExecutionStatus = 'completed' | 'failed' | 'cancelled'

export type AgentExecutionLimitKind = 'turns' | 'tool_calls' | 'input_tokens' | 'output_tokens' | 'cost_usd' | 'elapsed_ms'

export type AgentExecutionSource = 'editor' | 'workflow' | 'cli' | 'schedule' | 'channel' | 'chat'

export type AgentRuntimeToolClassification = 'read' | 'write' | 'script' | 'mcp' | 'ask' | 'other'

export type AgentRuntimeToolApprovalStatus = 'approved' | 'denied' | 'cancelled'

export interface AgentExecutionLimit {
  kind: AgentExecutionLimitKind
  limit: number
  actual?: number
}

export interface AgentExecutionBudget {
  maxTurns: number
  maxToolCalls: number
  maxElapsedMs: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxCostUsd?: number
}

export interface AgentExecutionUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsd?: number
  elapsedMs: number
}

export interface AgentExecutionHistoryEntry {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  at: string
  name?: string
}

export interface AgentExecutionError {
  code: string
  message: string
  retryable: boolean
  /** Additive structured details. CLI capability reports may merge later without renaming this field. */
  details?: Record<string, unknown>
}

export interface AgentRuntimeUnsupportedSetting {
  pointer: string
  reason: string
  hostBinding?: string
}

export interface AgentRuntimeWorkspacePolicy {
  mode: AgentWorkspaceMode
  /** Host-canonicalized absolute roots. Definition permittedRoots cannot expand this set. */
  canonicalRoots: string[]
}

export interface AgentRuntimeScriptPolicy {
  enabled: boolean
  allowFilesystem: boolean
  allowNetwork: boolean
  executionMode: AgentScriptExecutionMode
  interpreters: string[]
}

export interface AgentRuntimeApprovalPolicy {
  askUser: boolean
  policy: AgentApprovalPolicy
  unattendedBehavior: AgentUnattendedBehavior
}

export interface AgentRuntimeFallbackPolicy {
  enabled: boolean
  retryOn: AgentFallbackRetryCategory[]
  allowHigherCost: boolean
  retryCount: number
  backoffMs: number
}

/**
 * Immutable host-owned policy compiled from the resolved definition plus trusted
 * host authority. Renderer/provider content must not supply this object.
 */
export interface AgentRuntimePolicy {
  profileId: string
  threadId: string
  runId: string
  definitionId: string
  definitionRevision: string
  source: AgentExecutionSource
  workspace: AgentRuntimeWorkspacePolicy
  script: AgentRuntimeScriptPolicy
  approval: AgentRuntimeApprovalPolicy
  memoryScope: AgentMemoryScope
  includeCurrentThread: boolean
  includeProjectInstructions: boolean
  attachmentPolicy: AgentAttachmentPolicy
  maxContextTokens?: number
  fallbacks: AgentRuntimeFallbackPolicy
  fallbackModels: ResolvedAgentDefinition['model']['fallbacks']
}

export interface AgentRuntimeToolApprovalRequest {
  runId: string
  profileId: string
  threadId: string
  definitionId: string
  definitionRevision: string
  toolName: string
  canonicalToolName: string
  classification: AgentRuntimeToolClassification
  arguments: Record<string, unknown>
  argumentDigest: string
  workspacePaths: string[]
}

export interface AgentRuntimeToolApprovalDecision {
  status: AgentRuntimeToolApprovalStatus
  /** Must equal the request digest; any other value is treated as stale. */
  digest?: string
  reason?: string
}

export type AgentRuntimeToolApprovalCallback = (
  request: AgentRuntimeToolApprovalRequest
) => Promise<AgentRuntimeToolApprovalDecision>

/** Trusted-host authority. Never accept this from renderer or provider content. */
export interface AgentRuntimeHostBindings {
  /** Canonical absolute workspace roots the host allows this run to touch. */
  workspaceRoots?: string[]
  /** Required when workspace.mode is dedicated_child_worktree. */
  dedicatedWorktreeRoot?: string
  /**
   * Exact tool-request approval. Absence is not approval. Never default auto-approve.
   * Revalidated after the await, immediately before side effects.
   */
  approveToolRequest?: AgentRuntimeToolApprovalCallback
}

export interface AgentRuntimeAttachment {
  name: string
  content: string
  path?: string
}

export interface AgentRuntimeSelectedFile {
  path: string
  content: string
}

export interface AgentRuntimeMemoryEntry {
  content: string
}

/**
 * Profile/thread-owned snapshot supplied by the host. The runtime never reads
 * global user state, accounts, or other profiles/threads.
 */
export interface AgentRuntimeContextSnapshot {
  profileId: string
  threadId: string
  definitionId?: string
  history?: AgentExecutionHistoryEntry[]
  attachments?: AgentRuntimeAttachment[]
  projectInstructions?: string
  selectedFiles?: AgentRuntimeSelectedFile[]
  memory?: {
    scope: AgentMemoryScope
    entries: AgentRuntimeMemoryEntry[]
  }
}

export interface AgentExecutionRequest {
  /** Profile selected by the caller; it must match the resolved immutable snapshot. */
  profileId: string
  resolved: ResolvedAgentDefinition
  threadId: string
  projectPath?: string
  input?: string
  runId?: string
  source?: AgentExecutionSource
  signal?: AbortSignal
  /** A caller may lower definition limits, but cannot raise them. */
  budget?: Partial<AgentExecutionBudget>
  /** Trusted host authority. Renderer/provider content must not populate this. */
  host?: AgentRuntimeHostBindings
  /** Host-supplied profile/thread snapshot. Never inferred from global user state. */
  context?: AgentRuntimeContextSnapshot
}

export interface AgentExecutionResult {
  runId: string
  profileId: string
  threadId: string
  definitionId: string
  definitionRevision: string
  runtimeKind: AgentRuntimeKind
  status: AgentExecutionStatus
  text: string
  history: AgentExecutionHistoryEntry[]
  usage: AgentExecutionUsage
  error?: AgentExecutionError
}

export interface AgentRuntimeAttemptUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
  turns: number
  toolCalls: number
}

export interface AgentRuntimeEffectTracker {
  dispatched: boolean
  attemptUsage: AgentRuntimeAttemptUsage
}

export interface AgentRuntimeInput {
  runId: string
  profileId: string
  threadId: string
  projectPath?: string
  runtimeKind: AgentRuntimeKind
  model: ResolvedAgentDefinition['model']
  systemPrompt: string
  userMessage: string
  grants: EffectiveAgentGrants
  budget: AgentExecutionBudget
  signal: AbortSignal
  /** Present for native runs compiled by AgentExecutionService. Optional for older adapters. */
  policy?: AgentRuntimePolicy
  approveToolRequest?: AgentRuntimeToolApprovalCallback
  effects?: AgentRuntimeEffectTracker
  /** Prior thread turns only; the current user message is applied separately. */
  conversation?: AgentExecutionHistoryEntry[]
  fallbacks?: AgentFallbackSettings
}

export interface AgentRuntimeResult {
  text: string
  history?: AgentExecutionHistoryEntry[]
  usage?: Partial<AgentExecutionUsage>
  limit?: AgentExecutionLimit
}

/** Root binds this to the existing Mousse native loop/provider transport. */
export interface NativeAgentRuntimePort {
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>
}

/** Root binds this to the existing CLI process/config runner. */
export interface CliAgentRuntimePort {
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>
}

export interface AgentExecutionBindings {
  native?: NativeAgentRuntimePort
  cli?: Partial<Record<Exclude<AgentRuntimeKind, 'mousse'>, CliAgentRuntimePort>>
  now?: () => number
  id?: () => string
  /** Default host authority when a request does not supply its own. */
  host?: AgentRuntimeHostBindings
}

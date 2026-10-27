import type {
  AgentApprovalPolicy,
  AgentBrowserMode,
  AgentAttachmentPolicy,
  AgentFallbackRetryCategory,
  AgentFallbackSettings,
  AgentMemoryScope,
  AgentOutputFormat,
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
  /**
   * Nobody watches this run as it goes (`definitionRunUnattended`: a schedule, a channel, a workflow
   * node, a bridge dispatch). Where the runtime's shell is not contained, its shell commands are
   * refused rather than asked about. Absent: a person started it.
   */
  unattended?: true
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
  /**
   * The run was not started by a person who watches it, whatever its source says (a workflow node
   * started from the CLI, a bridge dispatch from a peer): `AgentRuntimePolicy.unattended`.
   */
  unattended?: boolean
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
  /** The runtime's trace (a fallback it skipped, a candidate it moved from). */
  trace?: string[]
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
  /** The definition's settings a runtime must hold besides its tools and limits (`definitionFeatureGaps`). */
  features?: AgentRuntimeFeatures
}

/** A definition's output, browser, memory and delegation settings, as its runtime must hold them. */
export interface AgentRuntimeFeatures {
  outputFormat: AgentOutputFormat
  browserMode: AgentBrowserMode
  memoryScope: AgentMemoryScope
  /** Any delegation setting is on (children, depth or allowed child definitions). */
  delegation: boolean
}

export interface AgentRuntimeResult {
  text: string
  history?: AgentExecutionHistoryEntry[]
  usage?: Partial<AgentExecutionUsage>
  limit?: AgentExecutionLimit
  /** What the runtime decided along the way that the result does not show (a fallback it skipped). */
  trace?: string[]
}

/**
 * Runs a definition's model turns. Root binds it to the harness gateway (`definitionRuntime.ts`):
 * every stored `runtimeKind` goes to the same port, and the instance comes from the model ref.
 */
export interface AgentRuntimePort {
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>
}

/** @deprecated The in-process loop's name for `AgentRuntimePort`; it goes with that loop. */
export type NativeAgentRuntimePort = AgentRuntimePort

export interface AgentExecutionBindings {
  runtime?: AgentRuntimePort
  now?: () => number
  id?: () => string
  /** Default host authority when a request does not supply its own. */
  host?: AgentRuntimeHostBindings
}

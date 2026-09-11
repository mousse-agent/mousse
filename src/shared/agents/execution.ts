import type { AgentRuntimeKind, EffectiveAgentGrants, ResolvedAgentDefinition } from './types'

export type AgentExecutionStatus = 'completed' | 'failed' | 'cancelled'

export type AgentExecutionLimitKind = 'turns' | 'tool_calls' | 'input_tokens' | 'output_tokens' | 'cost_usd' | 'elapsed_ms'

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

export interface AgentExecutionRequest {
  /** Profile selected by the caller; it must match the resolved immutable snapshot. */
  profileId: string
  resolved: ResolvedAgentDefinition
  threadId: string
  projectPath?: string
  input?: string
  runId?: string
  source?: 'editor' | 'workflow' | 'cli' | 'schedule' | 'channel'
  signal?: AbortSignal
  /** A caller may lower definition limits, but cannot raise them. */
  budget?: Partial<AgentExecutionBudget>
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
  error?: { code: string; message: string; retryable: boolean }
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
}

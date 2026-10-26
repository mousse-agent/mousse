// Adapted from @earendil-works/pi-ai 0.85.1 `dist/types.d.ts` and `dist/utils/diagnostics.d.ts`
// (MIT, Copyright (c) Mario Zechner): the message types, frozen as Mousse's transcript schema.
// See THIRD_PARTY_NOTICES.md.

/**
 * Mousse's canonical transcript (`NativeLlmContext`): the messages a thread keeps for handoffs,
 * fork and undo. The shape is the one pi-ai 0.85.1 writes, so stored transcripts read unchanged;
 * Mousse owns it from here and it no longer follows pi-ai upgrades.
 */

export interface TextContent {
  type: 'text'
  text: string
  textSignature?: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
  /** The thinking was redacted by the provider; the opaque payload is in `thinkingSignature`. */
  redacted?: boolean
}

export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export interface ToolCall {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, any>
  thoughtSignature?: string
  /** OpenAI Responses namespace for calls to dynamically loaded or namespaced tools. */
  namespace?: string
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Subset of `cacheWrite` written with 1h retention. */
  cacheWrite1h?: number
  /** Reasoning tokens, a subset of `output`, when the provider reports them. */
  reasoning?: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

export type StopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface DeferredHandle {
  provider: string
  modelId: string
  api: string
  id: string
  expiresAt?: number
  pollAfterMs?: number
  data?: JsonValue
}

/** A diagnostic the runtime attached to a reply; kept as stored, never read by Mousse. */
export interface AssistantMessageDiagnostic {
  type: string
  timestamp: number
  error?: { name?: string; message: string; stack?: string; code?: string | number }
  details?: Record<string, unknown>
}

export interface UserMessage {
  role: 'user'
  content: string | (TextContent | ImageContent)[]
  timestamp: number
}

export interface AssistantMessage {
  role: 'assistant'
  content: (TextContent | ThinkingContent | ToolCall)[]
  api: string
  provider: string
  model: string
  responseModel?: string
  responseId?: string
  /** Exact provider-native effort level used for this response. */
  providerThinkingLevel?: string
  diagnostics?: AssistantMessageDiagnostic[]
  usage: Usage
  stopReason: StopReason
  deferred?: DeferredHandle
  errorMessage?: string
  rawStopReason?: string
  endTurn?: boolean
  timestamp: number
}

export interface ToolResultMessage<TDetails = any> {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  details?: TDetails
  /** Usage from the tool execution itself, if any. */
  usage?: Usage
  /** Tool names that became available after this result. */
  addedToolNames?: string[]
  isError: boolean
  timestamp: number
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

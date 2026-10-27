/**
 * The streaming events a turn reports while it runs: text, thinking and tool activity. Every
 * runtime emits these shapes and the orchestrator's transcript consumes them.
 */

import type { ActivityPatch } from '../../shared/agentActivity'

export interface LlmToolEvent {
  kind: 'mcp_tool_call' | 'mcp_tool_result' | 'skill_loaded' | 'build_tool_call' | 'build_tool_result'
  title: string
  summary: string
  details: string[]
  response?: string
}

export interface StreamingLlmToolEvent extends LlmToolEvent {
  /** `update` carries a running call's streamed output or changed fields; it never starts or ends the call. */
  phase: 'start' | 'update' | 'complete'
  callId?: string
  /** The call's arguments when the runtime reports them apart from `response` (a bounded record, see `recordSubagentCall`). */
  input?: Record<string, unknown>
  /**
   * The typed fields the provider has. The assembler fills `id`, `callId`, `status` and the
   * timestamps; a provider closing a call it never saw end sends `{ status: 'interrupted', interruptedBy, summary }`.
   */
  activity?: ActivityPatch
  /** The provider's call id of the call this one ran under; the assembler maps it to that row's id. */
  parentCallId?: string
}

export type LlmToolEventHandler = (event: StreamingLlmToolEvent) => void

export interface StreamingLlmThinkingEvent {
  phase: 'start' | 'delta' | 'complete'
  content: string
}

export type LlmThinkingEventHandler = (event: StreamingLlmThinkingEvent) => void

export interface StreamingLlmTextEvent {
  phase: 'start' | 'delta' | 'complete'
  content: string
  /** Content-block identity supplied by the provider stream. */
  contentIndex: number
}

export type LlmTextEventHandler = (event: StreamingLlmTextEvent) => void

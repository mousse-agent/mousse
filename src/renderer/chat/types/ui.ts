// Mousse Chat SDK — shadcn/helpers inspired headless types
// Borrowed principles: typed parts, writer callback, generic UIMessage shape.
// Unlike ai SDK, canonical type is ChatMessage (durably persisted) with parts derived for UI.

import type { ChatMessage, ChatImageAttachment, TurnPhase } from '../../../shared/types'

export type ChatRole = 'user' | 'assistant' | 'system'

export type TextPart = { type: 'text'; text: string; id?: string; state?: 'streaming' | 'done' }
export type ReasoningPart = { type: 'reasoning'; text: string; id?: string; state?: 'streaming' | 'done' }
export type ToolPart = {
  type: 'tool'
  toolName: string
  toolCallId: string
  state: 'input-available' | 'output-available' | 'output-error' | 'output-denied'
  input?: unknown
  output?: unknown
  title?: string
}
export type FilePart = { type: 'file'; mediaType: string; url: string; filename?: string }
export type SourcePart = { type: 'source-url'; sourceId: string; url: string; title?: string }
export type DataPart = { type: string; id?: string; data: unknown; transient?: boolean } // data-* convention
export type StepPart = { type: 'step-start' }
export type CustomPart = { type: 'custom'; kind: string }

export type ChatPart = TextPart | ReasoningPart | ToolPart | FilePart | SourcePart | DataPart | StepPart | CustomPart

export interface MousseUIMessage {
  id: string
  role: ChatRole
  parts: ChatPart[]
  createdAt: string
  turnId?: string
  actionId?: string
  metadata?: Record<string, unknown> & { modelName?: string; turnPhase?: TurnPhase }
}

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'tool_running' | 'awaiting_input'

export function chatStatusFromPhase(phase: TurnPhase): ChatStatus {
  if (phase === 'queued') return 'submitted'
  if (phase === 'thinking' || phase === 'finalizing') return 'streaming'
  if (phase === 'streaming') return 'streaming'
  if (phase === 'tool_running') return 'tool_running'
  if (phase === 'awaiting_input') return 'awaiting_input'
  return 'ready'
}

/** Adapter: legacy ChatMessage -> MousseUIMessage parts */
export function toUIMessage(msg: ChatMessage): MousseUIMessage {
  const parts: ChatPart[] = []
  if (msg.kind === 'thinking' && msg.thinking) {
    parts.push({ type: 'reasoning', text: msg.thinking.content, state: msg.thinking.status === 'processing' ? 'streaming' : 'done' })
  } else if (msg.toolCall) {
    parts.push({
      type: 'tool',
      toolName: msg.toolCall.title,
      toolCallId: msg.id,
      state: msg.toolCall.status === 'processing' ? 'input-available' : 'output-available',
      input: msg.toolCall.details,
      output: msg.toolCall.response,
      title: msg.toolCall.title,
    })
  } else if (msg.kind === 'plan_card' && msg.planCard) {
    parts.push({ type: 'data-plan-card', data: msg.planCard } as DataPart)
    if (msg.content.trim()) parts.push({ type: 'text', text: msg.content })
  } else if (msg.kind === 'progress' || msg.kind === 'warning' || msg.kind === 'context_compaction') {
    parts.push({ type: `data-${msg.kind}` as string, data: msg.content } as DataPart)
  } else if (msg.role === 'assistant' && msg.streaming) {
    parts.push({ type: 'text', text: msg.content, state: 'streaming' })
  } else {
    // User / assistant text
    if (msg.content) parts.push({ type: 'text', text: msg.content, state: 'done' })
    if (msg.images?.length) {
      for (const img of msg.images) {
        parts.push({ type: 'file', mediaType: img.mimeType, url: `data:${img.mimeType};base64,${img.data}`, filename: img.name })
      }
    }
  }
  return {
    id: msg.id,
    role: msg.role as ChatRole,
    parts,
    createdAt: msg.timestamp,
    turnId: msg.turnId,
    actionId: msg.actionId,
    metadata: msg.responseMetadata ? { ...msg.responseMetadata } : undefined,
  }
}

export function fromUIMessage(ui: MousseUIMessage): ChatMessage {
  const text = ui.parts.filter((p): p is TextPart => p.type === 'text').map(p => p.text).join('\n\n')
  const reasoning = ui.parts.find((p): p is ReasoningPart => p.type === 'reasoning')
  const tool = ui.parts.find((p): p is ToolPart => p.type === 'tool')
  const isStreaming = ui.parts.some(p => (p as TextPart).state === 'streaming' || (p as ReasoningPart).state === 'streaming' || (p as ToolPart).state === 'input-available')
  const images: ChatImageAttachment[] = ui.parts.filter((p): p is FilePart => p.type === 'file').map(p => ({ name: p.filename ?? 'file', mimeType: p.mediaType, data: p.url }))
  return {
    id: ui.id,
    role: ui.role,
    content: text || reasoning?.text || '',
    timestamp: ui.createdAt,
    turnId: ui.turnId,
    actionId: ui.actionId,
    streaming: isStreaming || undefined,
    thinking: reasoning ? { content: reasoning.text, status: reasoning.state === 'streaming' ? 'processing' : 'complete' } : undefined,
    toolCall: tool ? { title: tool.title ?? tool.toolName, summary: '', details: Array.isArray(tool.input) ? tool.input as string[] : [], response: typeof tool.output === 'string' ? tool.output : undefined, status: tool.state === 'input-available' ? 'processing' : 'complete' } : undefined,
    images: images.length ? images : undefined,
  }
}

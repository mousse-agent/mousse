import { v4 as uuidv4 } from 'uuid'
import { parseProviderToolCall } from '../../../../shared/toolCallDisplay'
import type { ChatMessage, TurnPhase } from '../../../../shared/types'
import type {
  StreamingLlmTextEvent,
  StreamingLlmThinkingEvent,
  StreamingLlmToolEvent
} from '../../../orchestrator/LlmClient'

/**
 * Where an assembler keeps its open-message bookkeeping. The orchestrator's `ThreadSession`
 * already carries these fields, so the assembler works on them in place and its other readers
 * keep working.
 */
export interface TranscriptStreamState {
  activeAssistantMessageId: string | null
  activeThinkingMessageId: string | null
  /** Provider tool call id → timeline message id, for calls still running. */
  activeToolCallMessageIds: Map<string, string>
  /** `replace` mode: the reply most recently completed by a `complete` text event. */
  lastCompletedAssistantMessageId?: string | null
  lastCompletedAssistantContent?: string
  /** `append` mode: text of the completed segments of the open reply. */
  assistantStreamBase?: string
}

/** Transcript and stream operations the assembler drives; the owner keeps the transcript. */
export interface TranscriptHooks {
  getMessage(id: string): ChatMessage | undefined
  /** Appends to the transcript; does not emit. */
  addMessage(message: ChatMessage): void
  /** Replaces the message with the same id; does not emit. */
  updateMessage(message: ChatMessage): void
  /** Removes the message and resynchronises observers and storage. */
  removeMessage(id: string): void
  emitAdded(message: ChatMessage): void
  emitUpdated(message: ChatMessage): void
  /** `force` writes now; otherwise the owner may debounce. */
  persist(force: boolean): void
  /** `blockedOnWait`: every running tool call is a wait tool (see `WAIT_TOOL_NAMES`). */
  setPhase(phase: TurnPhase, patch?: { activeMessageId?: string; blockedOnWait?: boolean }): void
}

/**
 * Tools that only block until other work finishes or time passes. While every running call of a
 * turn is one of these, the thread shows Waiting instead of Working. Mousse's own delegation
 * tools return at once and wake the parent later, so they are not here.
 * - `TaskOutput`: Claude Code waiting for a background shell or subagent (older Claude Code).
 */
export const WAIT_TOOL_NAMES: ReadonlySet<string> = new Set(['TaskOutput'])

/**
 * How a text event's `content` relates to the open reply. `replace`: each delta and `complete`
 * carries the whole reply so far (pi loop, vendor runtimes); `complete` closes the reply.
 * `append`: content is relative to the text of earlier completed segments, and `complete` only
 * folds the segment into that base; the owner closes the reply after the turn.
 */
export type TranscriptTextMode = 'replace' | 'append'

/**
 * Turns streamed text, thinking and tool events into `ChatMessage` mutations (SPEC §13.4 shared
 * builders): one assistant reply, one thinking message at a time, and one timeline message per
 * tool call, with the turn phase following the stream.
 */
export class TranscriptAssembler {
  /** The `blockedOnWait` last published with `tool_running`. */
  private blockedOnWait = false

  constructor(
    private readonly hooks: TranscriptHooks,
    private readonly state: TranscriptStreamState,
    private readonly mode: TranscriptTextMode = 'replace'
  ) {}

  /** Forgets the previous turn's open messages (the messages themselves stay). */
  reset(): void {
    this.state.activeToolCallMessageIds.clear()
    this.blockedOnWait = false
    this.state.activeThinkingMessageId = null
    this.state.activeAssistantMessageId = null
    this.state.lastCompletedAssistantMessageId = null
    this.state.lastCompletedAssistantContent = ''
    if (this.mode === 'append') this.state.assistantStreamBase = ''
  }

  text(event: StreamingLlmTextEvent): void {
    if (event.phase === 'start') {
      if (!this.state.activeAssistantMessageId) {
        const message = this.startAssistant()
        this.state.activeAssistantMessageId = message.id
        if (this.mode === 'append') this.state.assistantStreamBase = ''
      }
      return
    }
    const messageId = this.state.activeAssistantMessageId
    if (!messageId) return
    if (this.mode === 'append') {
      const combined = (this.state.assistantStreamBase ?? '') + event.content
      if (event.phase === 'complete') this.state.assistantStreamBase = combined
      this.updateAssistant(messageId, combined, true)
      return
    }
    if (event.phase === 'delta') {
      this.updateAssistant(messageId, event.content, true)
      return
    }
    this.updateAssistant(messageId, event.content, false)
    this.state.lastCompletedAssistantMessageId = messageId
    this.state.lastCompletedAssistantContent = event.content
    this.state.activeAssistantMessageId = null
  }

  thinking(event: StreamingLlmThinkingEvent): void {
    if (event.phase === 'start') {
      const message: ChatMessage = {
        id: uuidv4(),
        role: 'system',
        kind: 'thinking',
        content: '',
        timestamp: new Date().toISOString(),
        thinking: { content: '', status: 'processing' }
      }
      this.add(message)
      this.state.activeThinkingMessageId = message.id
      this.hooks.setPhase('thinking')
      return
    }
    const messageId = this.state.activeThinkingMessageId
    if (!messageId) return
    const status = event.phase === 'complete' ? 'complete' : 'processing'
    this.updateThinking(messageId, event.content, status)
    if (status === 'complete') this.state.activeThinkingMessageId = null
  }

  tool(event: StreamingLlmToolEvent): void {
    // Build tools render as MCP calls in the timeline.
    const kind =
      event.kind === 'build_tool_call'
        ? 'mcp_tool_call'
        : event.kind === 'build_tool_result'
          ? 'mcp_tool_result'
          : event.kind

    if (event.phase === 'start' && event.callId) {
      // A runtime that learns a running call's arguments after it started repeats the start with
      // them: that fills in the call's row, it does not open another.
      const openId = this.state.activeToolCallMessageIds.get(event.callId)
      const open = openId ? this.hooks.getMessage(openId) : undefined
      if (open?.toolCall && event.input) {
        const updated: ChatMessage = { ...open, toolCall: { ...open.toolCall, input: { ...open.toolCall.input, ...event.input } } }
        this.hooks.updateMessage(updated)
        this.hooks.emitUpdated(updated)
        this.hooks.persist(false)
        return
      }
      const parsed = parseProviderToolCall(event)
      const message = this.addTimeline(kind, {
        title: event.title,
        summary: event.summary,
        details: event.details,
        response: event.response,
        status: 'processing',
        ...(parsed.toolName ? { toolName: parsed.toolName } : {}),
        ...((event.input ?? parsed.input) ? { input: event.input ?? parsed.input } : {})
      })
      this.state.activeToolCallMessageIds.set(event.callId, message.id)
      this.setToolPhase()
      return
    }

    if (event.phase === 'complete' && event.callId) {
      const messageId = this.state.activeToolCallMessageIds.get(event.callId)
      if (messageId) {
        const existing = this.hooks.getMessage(messageId)
        if (existing) {
          const parsed = parseProviderToolCall(event)
          const updated: ChatMessage = {
            ...existing,
            toolCall: {
              title: event.title,
              summary: event.summary,
              details: event.details,
              response: event.response,
              status: 'complete',
              // Preserve start-phase args: complete events carry result text, not args JSON.
              toolName: parsed.toolName ?? existing.toolCall?.toolName,
              input: event.input ? { ...existing.toolCall?.input, ...event.input } : (existing.toolCall?.input ?? parsed.input)
            }
          }
          this.hooks.updateMessage(updated)
          this.hooks.emitUpdated(updated)
          this.hooks.persist(true)
        }
        this.state.activeToolCallMessageIds.delete(event.callId)
        if (this.state.activeToolCallMessageIds.size === 0)
          this.hooks.setPhase(this.state.activeAssistantMessageId ? 'streaming' : 'thinking')
        // A command finishing can leave only wait tools running.
        else if (this.isBlockedOnWait() !== this.blockedOnWait) this.setToolPhase()
        return
      }
      // A complete for a call this turn never saw start is recorded as a finished call below.
    }

    const parsed = parseProviderToolCall(event)
    this.addTimeline(kind, {
      title: event.title,
      summary: event.summary,
      details: event.details,
      response: event.response,
      status: 'complete',
      ...(parsed.toolName ? { toolName: parsed.toolName } : {}),
      ...((event.input ?? parsed.input) ? { input: event.input ?? parsed.input } : {})
    })
  }

  /** Opens an empty streaming assistant reply and moves the turn to `streaming`. */
  startAssistant(): ChatMessage {
    const message: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      streaming: true
    }
    this.add(message)
    this.hooks.setPhase('streaming', { activeMessageId: message.id })
    return message
  }

  /** Rewrites an assistant reply; a non-streaming update is persisted at once. */
  updateAssistant(
    messageId: string,
    content: string,
    streaming: boolean,
    responseMetadata?: ChatMessage['responseMetadata'],
    incomplete?: boolean
  ): void {
    const existing = this.hooks.getMessage(messageId)
    if (!existing) return
    const updated: ChatMessage = {
      ...existing,
      content,
      streaming,
      ...(responseMetadata ? { responseMetadata } : {}),
      ...(incomplete ? { incomplete: true } : {})
    }
    this.hooks.updateMessage(updated)
    this.hooks.emitUpdated(updated)
    this.hooks.persist(!streaming)
  }

  /** Content of the open assistant reply, or undefined when none is open. */
  openAssistantContent(): string | undefined {
    const messageId = this.state.activeAssistantMessageId
    return messageId ? (this.hooks.getMessage(messageId)?.content ?? '') : undefined
  }

  /**
   * After a failed or stopped turn: keeps the open reply as an incomplete `content`, or removes it
   * when `content` is empty and `removeWhenEmpty`. Returns false when no reply was open.
   */
  abandonAssistant(content: string, removeWhenEmpty: boolean): boolean {
    const messageId = this.state.activeAssistantMessageId
    if (!messageId) return false
    if (!content && removeWhenEmpty) this.hooks.removeMessage(messageId)
    else this.updateAssistant(messageId, content, false, undefined, true)
    this.state.activeAssistantMessageId = null
    return true
  }

  /** After the turn: completes a thinking message the stream left processing. */
  closeThinking(): void {
    const messageId = this.state.activeThinkingMessageId
    if (!messageId) return
    const message = this.hooks.getMessage(messageId)
    if (message?.thinking?.status === 'processing')
      this.updateThinking(messageId, message.thinking.content, 'complete')
    this.state.activeThinkingMessageId = null
  }

  private setToolPhase(): void {
    this.blockedOnWait = this.isBlockedOnWait()
    this.hooks.setPhase('tool_running', this.blockedOnWait ? { blockedOnWait: true } : undefined)
  }

  /** True when tool calls are running and every one is a wait tool. */
  private isBlockedOnWait(): boolean {
    if (this.state.activeToolCallMessageIds.size === 0) return false
    for (const messageId of this.state.activeToolCallMessageIds.values()) {
      const call = this.hooks.getMessage(messageId)?.toolCall
      // Vendor runtimes name the tool in the title; the pi loop parses it into `toolName`.
      if (!WAIT_TOOL_NAMES.has(call?.toolName ?? call?.title ?? '')) return false
    }
    return true
  }

  private add(message: ChatMessage): void {
    this.hooks.addMessage(message)
    this.hooks.emitAdded(message)
    this.hooks.persist(false)
  }

  private addTimeline(
    kind: NonNullable<ChatMessage['kind']>,
    toolCall: NonNullable<ChatMessage['toolCall']>
  ): ChatMessage {
    const message: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      kind,
      content: '',
      timestamp: new Date().toISOString(),
      toolCall
    }
    this.add(message)
    return message
  }

  private updateThinking(
    messageId: string,
    content: string,
    status: NonNullable<ChatMessage['thinking']>['status']
  ): void {
    const existing = this.hooks.getMessage(messageId)
    if (!existing) return
    const updated: ChatMessage = { ...existing, thinking: { content, status } }
    this.hooks.updateMessage(updated)
    this.hooks.emitUpdated(updated)
    this.hooks.persist(status === 'complete')
  }
}

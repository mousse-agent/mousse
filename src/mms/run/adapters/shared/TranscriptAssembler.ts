import { v4 as uuidv4 } from 'uuid'
import {
  ACTIVITY_CHECKPOINT_MS,
  BACKGROUND_SUMMARY,
  INTERRUPTED_SUMMARY,
  activityFromToolCall,
  applyToolResult,
  capRecord,
  mergeActivityPatch,
  type ActivityInterruptedBy,
  type ActivityPatch,
  type ActivityStatus,
  type AgentActivityItem
} from '../../../../shared/agentActivity'
import { subagentToolName } from '../../../../shared/subagentTools'
import { parseProviderToolCall } from '../../../../shared/toolCallDisplay'
import type { ChatMessage, TurnPhase } from '../../../../shared/types'
import type {
  StreamingLlmTextEvent,
  StreamingLlmThinkingEvent,
  StreamingLlmToolEvent
} from '../../../harness/turnEvents'

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
  /**
   * Provider tool call id → timeline message id for every call of the turn, finished ones too, so a
   * child that starts after its parent completed still finds the parent's row. Cleared on `reset()`.
   */
  callToMessage?: Map<string, string>
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
  /** The Run Engine run the current turn executes, stamped on each activity item. */
  currentRunId?(): string | undefined
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

/** A running item's output reaches clients at most this often. */
const ACTIVITY_EMIT_MS = 100

/** Emit and save bookkeeping of one running item. */
interface ItemStream {
  lastEmit: number
  lastCheckpoint: number
  timer?: ReturnType<typeof setTimeout>
}

/** A provider patch without the fields the assembler decides: identity, status and timestamps. */
function withoutOutcome(patch: ActivityPatch): ActivityPatch {
  const {
    id: _id,
    callId: _callId,
    parentId: _parentId,
    runId: _runId,
    status: _status,
    interruptedBy: _by,
    startedAt: _startedAt,
    endedAt: _endedAt,
    ...rest
  } = patch
  return rest as ActivityPatch
}

/**
 * An item whose call ended without a result. A settled turn's backgrounded subagent and open plan
 * (`no_result` only) are done: the first handed its work off, the second has no completion event.
 * Stop and a restart always win, so they stay interrupted and a restart note can still name them.
 */
function settleInterrupted(item: AgentActivityItem, by: ActivityInterruptedBy, summary: string, endedAt: string): AgentActivityItem {
  const { interruptedBy: _by, ...rest } = item
  if (by === 'no_result' && item.kind === 'subagent' && item.background) {
    return { ...rest, status: 'done', summary: BACKGROUND_SUMMARY, endedAt } as AgentActivityItem
  }
  if (by === 'no_result' && item.kind === 'plan') return { ...rest, status: 'done', endedAt } as AgentActivityItem
  return { ...rest, status: 'interrupted', interruptedBy: by, summary, endedAt } as AgentActivityItem
}

/**
 * Turns streamed text, thinking and tool events into `ChatMessage` mutations (SPEC §13.4 shared
 * builders): one assistant reply, one thinking message at a time, and one timeline message per
 * tool call, with the turn phase following the stream.
 */
export class TranscriptAssembler {
  /** The `blockedOnWait` last published with `tool_running`. */
  private blockedOnWait = false
  private readonly callToMessage: Map<string, string>
  private readonly streams = new Map<string, ItemStream>()

  constructor(
    private readonly hooks: TranscriptHooks,
    private readonly state: TranscriptStreamState,
    private readonly mode: TranscriptTextMode = 'replace'
  ) {
    this.callToMessage = state.callToMessage ?? new Map()
  }

  /**
   * Forgets the previous turn's open messages (the messages themselves stay). A call still open
   * is closed as stopped first, so no item outlives its turn.
   */
  reset(): void {
    this.closeOpenTools('stop')
    this.callToMessage.clear()
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
      if (open?.toolCall && (event.input || event.activity || event.parentCallId)) {
        this.refillOpenTool(open, event)
        return
      }
      const parsed = parseProviderToolCall(event)
      const message = this.addTimeline(kind, this.startToolCall(event, parsed), (id) => this.startItem(id, event, parsed))
      this.state.activeToolCallMessageIds.set(event.callId, message.id)
      this.callToMessage.set(event.callId, message.id)
      this.streams.set(message.id, { lastEmit: Date.now(), lastCheckpoint: Date.now() })
      this.setToolPhase()
      return
    }

    if (event.phase === 'update') {
      this.updateTool(event)
      return
    }

    if (event.phase === 'complete' && event.callId) {
      const messageId = this.state.activeToolCallMessageIds.get(event.callId)
      if (messageId) {
        const existing = this.hooks.getMessage(messageId)
        if (existing?.activity) {
          const parsed = parseProviderToolCall(event)
          const item = this.finishItem(existing.activity, event)
          const updated: ChatMessage = {
            ...existing,
            activity: item,
            toolCall: this.completeToolCall(event, parsed, existing.toolCall)
          }
          this.endStream(messageId)
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
      // A repeat of a result, or one that arrives after the turn closed the call, has no row to
      // change: the call already ended, and its row says how.
      if (this.callToMessage.has(event.callId)) return
      // A complete for a call this turn never saw start is recorded as a finished call below.
    }

    const parsed = parseProviderToolCall(event)
    const message = this.addTimeline(kind, this.completeToolCall(event, parsed, undefined), (id) =>
      this.finishItem(this.startItem(id, event, parsed), event)
    )
    if (event.callId) this.callToMessage.set(event.callId, message.id)
  }

  /**
   * Ends every call still running when the turn ended. A call the provider never reported a result
   * for is `interrupted`, never done: `stop` (the user stopped the turn or it failed), `no_result`
   * (it settled and this call has no result) or `daemon_restart` (a profile shutdown aborted it).
   */
  closeOpenTools(reason: ActivityInterruptedBy): void {
    let changed = false
    for (const messageId of this.state.activeToolCallMessageIds.values()) {
      const existing = this.hooks.getMessage(messageId)
      if (!existing?.activity) continue
      const item = settleInterrupted(existing.activity, reason, INTERRUPTED_SUMMARY[reason], new Date().toISOString())
      const updated: ChatMessage = {
        ...existing,
        activity: item,
        ...(existing.toolCall ? { toolCall: { ...existing.toolCall, status: 'complete' as const } } : {})
      }
      this.hooks.updateMessage(updated)
      this.hooks.emitUpdated(updated)
      changed = true
    }
    for (const messageId of [...this.streams.keys()]) this.endStream(messageId)
    this.state.activeToolCallMessageIds.clear()
    this.blockedOnWait = false
    if (changed) this.hooks.persist(true)
  }

  /** The row's `toolCall` when a call starts: the short provider strings, never the arguments or a result. */
  private startToolCall(
    event: StreamingLlmToolEvent,
    parsed: { toolName?: string; input?: Record<string, unknown> }
  ): NonNullable<ChatMessage['toolCall']> {
    const toolName = parsed.toolName ?? event.activity?.toolName ?? event.title
    const input = event.input ?? parsed.input
    return {
      title: event.title,
      summary: event.summary,
      details: event.details,
      status: 'processing',
      ...(parsed.toolName ? { toolName: parsed.toolName } : {}),
      // Only a Mousse subagent call keeps its (bounded) record; any other arguments live on the item, capped.
      ...(subagentToolName(toolName) && input ? { input } : {})
    }
  }

  private completeToolCall(
    event: StreamingLlmToolEvent,
    parsed: { toolName?: string; input?: Record<string, unknown> },
    existing: ChatMessage['toolCall'] | undefined
  ): NonNullable<ChatMessage['toolCall']> {
    const toolName = parsed.toolName ?? existing?.toolName
    const subagent = subagentToolName(toolName ?? event.activity?.toolName ?? event.title)
    const input = event.input ? { ...existing?.input, ...event.input } : (existing?.input ?? parsed.input)
    return {
      title: event.title,
      summary: event.summary,
      details: event.details,
      status: 'complete',
      // Preserve start-phase args: complete events carry result text, not args JSON.
      ...(toolName ? { toolName } : {}),
      ...(subagent && input ? { input } : {})
    }
  }

  /** The item of a call that has just started: the provider's typed fields over what the name and arguments say. */
  private startItem(
    id: string,
    event: StreamingLlmToolEvent,
    parsed: { toolName?: string; input?: Record<string, unknown> }
  ): AgentActivityItem {
    const toolName = event.activity?.toolName ?? parsed.toolName ?? event.title
    const server = event.details.find((detail) => detail.startsWith('Server:'))?.slice('Server:'.length).trim().split(/\s+/)[0]
    const startedAt = new Date().toISOString()
    const draft = activityFromToolCall({ toolName, input: event.input ?? parsed.input, startedAt, ...(server ? { server } : {}) })
    const runId = this.hooks.currentRunId?.()
    const parentId = event.parentCallId ? this.callToMessage.get(event.parentCallId) : undefined
    const item = {
      ...draft,
      id,
      callId: event.callId ?? id,
      status: 'running' as const,
      ...(parentId ? { parentId } : {}),
      ...(runId ? { runId } : {})
    } as AgentActivityItem
    return event.activity ? { ...mergeActivityPatch(item, withoutOutcome(event.activity)), status: 'running' } : item
  }

  /** A repeated start of a running call: its arguments or typed fields arrived after it started. */
  private refillOpenTool(open: ChatMessage, event: StreamingLlmToolEvent): void {
    let activity = open.activity
    if (activity && event.activity) activity = mergeActivityPatch(activity, withoutOutcome(event.activity))
    if (activity && event.input && activity.kind === 'generic' && !event.activity?.input) {
      activity = { ...activity, input: capRecord({ ...activity.input, ...event.input }) }
    }
    // A parent the provider only names on a repeated start.
    const parentId = activity && !activity.parentId && event.parentCallId ? this.callToMessage.get(event.parentCallId) : undefined
    if (activity && parentId && parentId !== activity.id) activity = { ...activity, parentId }
    const toolName = open.toolCall?.toolName ?? open.activity?.toolName ?? open.toolCall?.title ?? ''
    const keepsInput = !activity || subagentToolName(toolName) !== null
    const updated: ChatMessage = {
      ...open,
      ...(activity ? { activity } : {}),
      ...(event.input && keepsInput && open.toolCall
        ? { toolCall: { ...open.toolCall, input: { ...open.toolCall.input, ...event.input } } }
        : {})
    }
    this.hooks.updateMessage(updated)
    this.hooks.emitUpdated(updated)
    this.hooks.persist(false)
  }

  /** Streamed output or changed fields of a running call: kept in memory, emitted and saved at most every so often. */
  private updateTool(event: StreamingLlmToolEvent): void {
    const messageId = event.callId ? this.state.activeToolCallMessageIds.get(event.callId) : undefined
    const existing = messageId ? this.hooks.getMessage(messageId) : undefined
    if (!messageId || !existing?.activity || !event.activity) return
    const activity = mergeActivityPatch(existing.activity, withoutOutcome(event.activity), 'append')
    const updated: ChatMessage = { ...existing, activity }
    this.hooks.updateMessage(updated)
    const stream = this.streams.get(messageId) ?? { lastEmit: 0, lastCheckpoint: Date.now() }
    this.streams.set(messageId, stream)
    const now = Date.now()
    if (now - stream.lastEmit >= ACTIVITY_EMIT_MS) {
      stream.lastEmit = now
      this.hooks.emitUpdated(updated)
    } else if (!stream.timer) {
      stream.timer = setTimeout(() => {
        stream.timer = undefined
        stream.lastEmit = Date.now()
        const latest = this.hooks.getMessage(messageId)
        if (latest) this.hooks.emitUpdated(latest)
      }, ACTIVITY_EMIT_MS - (now - stream.lastEmit))
      stream.timer.unref?.()
    }
    // A running item is rewritten with the whole thread file, so it checkpoints, not per delta.
    if (now - stream.lastCheckpoint >= ACTIVITY_CHECKPOINT_MS) {
      stream.lastCheckpoint = now
      this.hooks.persist(false)
    }
  }

  private endStream(messageId: string): void {
    const stream = this.streams.get(messageId)
    if (stream?.timer) clearTimeout(stream.timer)
    this.streams.delete(messageId)
  }

  /** The item once its call reported a result (or was closed by its provider). */
  private finishItem(started: AgentActivityItem, event: StreamingLlmToolEvent): AgentActivityItem {
    const patch = event.activity
    const endedAt = new Date().toISOString()
    // A closer's summary goes through `settleInterrupted`, which may turn the item into done.
    const folded = patch && patch.status === 'interrupted' ? { ...withoutOutcome(patch), summary: undefined } : patch && withoutOutcome(patch)
    let item = folded ? mergeActivityPatch(started, folded) : started
    const failed = /returned an error/i.test(event.summary ?? '')
    if (event.response !== undefined && patch?.output === undefined) {
      item = applyToolResult(item, { response: event.response, failed })
    }
    if (event.input && item.kind === 'generic' && !patch?.input) {
      item = { ...item, input: capRecord({ ...item.input, ...event.input }) }
    }
    if (patch?.status === 'interrupted') {
      const by = patch.interruptedBy ?? 'stop'
      return settleInterrupted(item, by, patch.summary ?? INTERRUPTED_SUMMARY[by], endedAt)
    }
    const status: ActivityStatus = patch?.status === 'done' || patch?.status === 'failed' ? patch.status : failed ? 'failed' : 'done'
    const { interruptedBy: _interruptedBy, ...rest } = item
    return { ...rest, status, endedAt, ...(patch?.summary ? { summary: patch.summary } : {}) } as AgentActivityItem
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
      const message = this.hooks.getMessage(messageId)
      const call = message?.toolCall
      // Vendor runtimes name the tool in the title; the pi loop parses it into `toolName`.
      if (!WAIT_TOOL_NAMES.has(message?.activity?.toolName ?? call?.toolName ?? call?.title ?? '')) return false
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
    toolCall: NonNullable<ChatMessage['toolCall']>,
    activity?: (id: string) => AgentActivityItem
  ): ChatMessage {
    const id = uuidv4()
    const message: ChatMessage = {
      id,
      role: 'system',
      kind,
      content: '',
      timestamp: new Date().toISOString(),
      toolCall,
      ...(activity ? { activity: activity(id) } : {})
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

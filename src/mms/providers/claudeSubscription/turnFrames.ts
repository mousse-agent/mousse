import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  ACTIVITY_DESCRIPTION_CHARS,
  INTERRUPTED_SUMMARY,
  type ActivityInterruptedBy,
  type ActivityPatch,
  type ProviderToolEvent
} from '../../../shared/agentActivity'
import { recordSubagentCall, toolResultText } from '../../../shared/subagentTools'
import { claudeActivityComplete, claudeActivityStart, claudeCallContext, type ClaudeCallContext } from './claudeActivity'
import type { ClaudeMetricsCollector } from './metrics'
import { observeRateLimit, RejectedWindows } from './usageLimit'

/** Where a turn's frames are reported; the slice of the chat input the stream needs. */
export interface TurnFrameSink {
  onText: (text: string) => void
  onThinking?: (text: string) => void
  onTool?: (event: ProviderToolEvent) => void
}

/**
 * What one turn has streamed so far: the reply text, the thinking, the tools in flight and the
 * session id. Both ways of running a turn (a one-shot query and a live one) feed their frames here;
 * what a result means stays with the caller.
 */
export class TurnFrames {
  text = ''
  thinking = ''
  sessionId: string | undefined
  readonly tools = new Map<string, string>()
  /**
   * What each open call's result reader needs of its arguments (their kind and a few short fields,
   * never the arguments), so a call with huge arguments is still read as what it is. Dropped when the
   * call closes.
   */
  private readonly contexts = new Map<string, ClaudeCallContext>()
  /** A Mousse subagent call's bounded record input (its title, subagent and delegation id), per open call. */
  private readonly recordInputs = new Map<string, Record<string, unknown>>()
  /** The call a subagent's call ran under, per open call. */
  private readonly parents = new Map<string, string | undefined>()
  /** Open calls whose result was a hand-off placeholder: only these end on their task's notification. */
  private readonly handedOff = new Set<string>()
  /** A task's end that arrived before its call's placeholder result, kept until that result says whether it is the call's end. */
  private readonly earlyEnds = new Map<string, Record<string, unknown>>()
  /** Where the text of the current segment starts (a steer starts a new one); a result fills it in when it streamed nothing. */
  segmentStart = 0
  /** The plan windows Claude Code rejected during this turn (a one-shot query; a live run keeps its own). */
  readonly rateLimits = new RejectedWindows()

  constructor(
    private readonly sink: TurnFrameSink,
    private readonly metrics: ClaudeMetricsCollector
  ) {}

  /** A steer cut the turn here: what follows is a new paragraph. */
  breakParagraph(): void {
    if (this.text) this.text += '\n\n'
    this.segmentStart = this.text.length
  }

  /** The turn streamed no text of its own since the last break. */
  get segmentEmpty(): boolean {
    return this.text.length === this.segmentStart
  }

  observe(message: SDKMessage): void {
    this.metrics.observe(message)
    observeRateLimit(message, this.rateLimits)
    this.sessionId = message.session_id || this.sessionId
    if (message.type === 'stream_event') {
      const event = message.event
      if (event.type === 'content_block_delta' && !message.parent_tool_use_id) {
        if (event.delta.type === 'text_delta') {
          this.text += event.delta.text
          this.sink.onText(this.text)
        }
        if (event.delta.type === 'thinking_delta') {
          this.thinking += event.delta.thinking
          this.sink.onThinking?.(this.thinking)
        }
      }
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        const parent = message.parent_tool_use_id ?? undefined
        // A call of a subagent this turn does not have open (a background agent of an earlier turn) is not this turn's.
        if (parent && !this.tools.has(parent)) return
        this.open(event.content_block.id, event.content_block.name, parent)
        // A subagent call's row is marked as recorded from the start, before its arguments are known.
        const record = recordSubagentCall(event.content_block.name, undefined, {})
        const activity = claudeActivityStart(event.content_block.name, undefined, !parent)
        this.sink.onTool?.({
          phase: 'start',
          callId: event.content_block.id,
          title: event.content_block.name,
          toolName: event.content_block.name,
          ...(record ? { record } : {}),
          ...(activity ? { activity } : {}),
          ...(parent ? { parentCallId: parent } : {})
        })
      }
    }
    // A tool_use block's arguments are complete only in the assistant message that holds it.
    if (message.type === 'assistant' && Array.isArray(message.message.content))
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue
        const parent = message.parent_tool_use_id ?? undefined
        // A subagent's calls may not have streamed a start of their own: the message that holds them opens them,
        // but only under a call this turn has open (a background agent of an earlier turn keeps sending frames).
        if (!this.tools.has(block.id) && parent && this.tools.has(parent)) this.open(block.id, block.name, parent)
        if (!this.tools.has(block.id)) continue
        const name = this.tools.get(block.id)!
        const input = record(block.input) ?? {}
        const isRoot = !this.parents.get(block.id)
        // The arguments are known now: a subagent call's row names its subagent before the call returns,
        // and every other call gets the typed fields its arguments carry.
        const subagentRecord = recordSubagentCall(block.name, block.input, {})
        const activity = claudeActivityStart(name, input, isRoot)
        this.contexts.set(block.id, claudeCallContext(name, input, isRoot))
        if (subagentRecord) this.recordInputs.set(block.id, subagentRecord.input)
        if (subagentRecord || activity) {
          this.sink.onTool?.({
            phase: 'start',
            callId: block.id,
            title: name,
            toolName: name,
            ...(subagentRecord ? { record: subagentRecord } : {}),
            ...(activity ? { activity } : {}),
            ...(this.parents.get(block.id) ? { parentCallId: this.parents.get(block.id) } : {})
          })
        }
      }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      const results = message.message.content.filter((block) => block.type === 'tool_result')
      for (const block of results) {
        if (block.type !== 'tool_result' || !this.tools.has(block.tool_use_id)) continue
        const callId = block.tool_use_id
        const title = this.tools.get(callId)!
        const text = toolResultText(block.content)
        const isError = block.is_error === true
        const subagentRecord = recordSubagentCall(title, this.recordInputs.get(callId), { text, isError })
        // `tool_use_result` is the message's one structured output: it is this call's only when it answers one call.
        const completion = claudeActivityComplete(
          this.contexts.get(callId) ?? claudeCallContext(title, undefined, !this.parents.get(callId)),
          results.length === 1 ? message.tool_use_result : undefined,
          text,
          isError
        )
        if (completion.handedOff) {
          // The call returned a placeholder and the work goes on: the row stays open until its notification
          // or the end of the turn, which closes it as handed off (a subagent) or without a result.
          this.handedOff.add(callId)
          if (completion.activity) this.sink.onTool?.({ phase: 'update', callId, title, toolName: title, activity: completion.activity })
          const early = this.earlyEnds.get(callId)
          if (early) this.endTask(callId, early)
          continue
        }
        this.sink.onTool?.({
          phase: 'complete',
          callId,
          title,
          ...(subagentRecord ? { record: subagentRecord } : {}),
          ...(completion.activity ? { toolName: title, activity: completion.activity } : {})
        })
        this.forget(callId)
      }
    }
    if (message.type === 'system') this.observeTask(message as unknown as Record<string, unknown>)
  }

  private open(callId: string, name: string, parent: string | undefined): void {
    this.tools.set(callId, name)
    this.parents.set(callId, parent)
    this.contexts.set(callId, claudeCallContext(name, undefined, !parent))
  }

  private forget(callId: string): void {
    this.tools.delete(callId)
    this.contexts.delete(callId)
    this.recordInputs.delete(callId)
    this.parents.delete(callId)
    this.handedOff.delete(callId)
    this.earlyEnds.delete(callId)
  }

  /**
   * A task's own frames. `task_started` names the task of an open call (and says whether it was handed
   * off). A foreground command or agent that runs a while is a task too, and reports its end before its
   * result: that end is the result's to settle, so `task_notification` closes only a call whose result
   * was a hand-off placeholder. A call this turn does not have open is not touched: a notification that
   * arrives after the turn settled belongs to the continuation run.
   */
  private observeTask(frame: Record<string, unknown>): void {
    const callId = typeof frame.tool_use_id === 'string' ? frame.tool_use_id : undefined
    const title = callId ? this.tools.get(callId) : undefined
    if (!callId || title === undefined) return
    const kind = this.contexts.get(callId)?.kind
    if (frame.subtype === 'task_started') {
      const taskId = typeof frame.task_id === 'string' ? frame.task_id : undefined
      const background = frame.is_backgrounded === true && kind === 'subagent'
      if ((kind !== 'subagent' && kind !== 'command') || (!taskId && !background)) return
      this.sink.onTool?.({
        phase: 'update',
        callId,
        title,
        toolName: title,
        activity: { kind, ...(taskId ? { nativeId: taskId } : {}), ...(background ? { background: true } : {}) } as ActivityPatch
      })
      return
    }
    if (frame.subtype !== 'task_notification') return
    if (this.handedOff.has(callId)) this.endTask(callId, frame)
    // Kept in case the placeholder result is still to come; a result that is the call's own ends it first.
    else this.earlyEnds.set(callId, frame)
  }

  /** The end of a handed-off call's task: done, failed or stopped, with the task's own summary. */
  private endTask(callId: string, frame: Record<string, unknown>): void {
    const title = this.tools.get(callId)
    if (title === undefined) return
    const kind = this.contexts.get(callId)?.kind
    const summary = typeof frame.summary === 'string' && frame.summary.trim() ? clipSummary(frame.summary) : undefined
    const usage = record(frame.usage)
    const duration = typeof usage?.duration_ms === 'number' && (kind === 'subagent' || kind === 'command') ? usage.duration_ms : undefined
    const outcome =
      frame.status === 'failed'
        ? { status: 'failed' }
        : frame.status === 'stopped'
          ? { status: 'interrupted', interruptedBy: 'stop' }
          : { status: 'done' }
    this.sink.onTool?.({
      phase: 'complete',
      callId,
      title,
      toolName: title,
      activity: { ...outcome, ...(summary ? { summary } : {}), ...(duration !== undefined ? { durationMs: duration } : {}) } as ActivityPatch
    })
    this.forget(callId)
  }

  /**
   * Tools still open when the turn ends are closed so the transcript never shows them running, and
   * never as done: `stop` when the turn was stopped or failed, `no_result` when it settled and this
   * call has no result (the saved row then says so, except for work that was handed off).
   */
  closeTools(reason: Extract<ActivityInterruptedBy, 'stop' | 'no_result'>): void {
    for (const [callId, title] of [...this.tools]) {
      this.sink.onTool?.({
        phase: 'complete',
        callId,
        title,
        toolName: title,
        activity: { status: 'interrupted', interruptedBy: reason, summary: INTERRUPTED_SUMMARY[reason] }
      })
      // Closed: a task frame that names it later is not this turn's to show.
      this.forget(callId)
    }
  }
}

function clipSummary(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > ACTIVITY_DESCRIPTION_CHARS ? `${clean.slice(0, ACTIVITY_DESCRIPTION_CHARS - 1)}…` : clean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

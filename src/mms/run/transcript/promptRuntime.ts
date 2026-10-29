import type { ActivityPatch, ProviderToolEvent } from '../../../shared/agentActivity'
import type { StreamingLlmTextEvent, StreamingLlmThinkingEvent, StreamingLlmToolEvent } from '../../harness/turnEvents'

/**
 * Shared pieces of the prompt-injected vendor runtimes (SPEC §13.4): they run their own loop and
 * system prompt, report cumulative text, and take prior turns as a prompt preamble. Their applet
 * guidance is part of the turn bridge's session instructions, the catalogue part of its preamble.
 */

/**
 * Relays a runtime's cumulative text (each callback carries everything so far) as the
 * start/delta/complete events the transcript expects: `start` before the first delta, and
 * `complete` only when something started. `break` closes the current segment: the next update
 * starts a new one with only what came after.
 */
export class CumulativeStream {
  private started = false
  private latest = ''
  /** How much of the runtime's cumulative text the closed segments hold. */
  private offset = 0
  private seen = 0

  constructor(private readonly emit: (phase: 'start' | 'delta' | 'complete', content: string) => void) {}

  update(content: string): void {
    this.seen = content.length
    const segment = this.offset ? content.slice(this.offset).replace(/^\s+/, '') : content
    if (this.offset && !segment) return
    if (!this.started) {
      this.emit('start', '')
      this.started = true
    }
    this.latest = segment
    this.emit('delta', segment)
  }

  /** Closes the stream with `content` (default: the latest update). No-op if nothing started. */
  complete(content: string = this.latest): void {
    if (this.started) this.emit('complete', content)
  }

  /** Closes the current segment (a thought before a tool call); what streams next opens another. */
  break(): void {
    if (!this.started) return
    this.complete()
    this.started = false
    this.latest = ''
    this.offset = this.seen
  }
}

/** A vendor runtime's tool start/update/complete, as an MCP-style timeline call. */
export type RuntimeToolEvent = ProviderToolEvent

export function runtimeToolEvent(event: RuntimeToolEvent): StreamingLlmToolEvent {
  const { record } = event
  const activity: ActivityPatch | undefined =
    event.activity || event.toolName ? { ...(event.toolName ? { toolName: event.toolName } : {}), ...event.activity } : undefined
  return {
    kind: 'mcp_tool_call',
    phase: event.phase,
    callId: event.callId,
    title: event.title,
    summary: record?.failed ? 'The MCP tool returned an error.' : (event.toolName ?? event.title),
    details: [],
    ...(record ? { input: record.input, ...(record.response ? { response: record.response } : {}) } : {}),
    ...(activity ? { activity } : {}),
    ...(event.parentCallId ? { parentCallId: event.parentCallId } : {})
  }
}

/** The part of a turn sink (`TurnSink`) the text and thinking relays write to. */
export interface StreamSink {
  text(event: StreamingLlmTextEvent): void
  thinking(event: StreamingLlmThinkingEvent): void
}

/** Text and thinking relays for one turn, bound to the sink. */
export function promptStreams(sink: StreamSink): { text: CumulativeStream; thinking: CumulativeStream } {
  return {
    text: new CumulativeStream((phase, content) => sink.text({ phase, content, contentIndex: 0 })),
    thinking: new CumulativeStream((phase, content) => sink.thinking({ phase, content }))
  }
}

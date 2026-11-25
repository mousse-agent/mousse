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
 *
 * A new segment keeps the runtime's text exactly as written (leading blank lines, indentation), except
 * for a separator the source itself put between two parts (`markSyntheticSeparator`): a segment that
 * begins there drops it. A segment opens only on text that is not all whitespace.
 */
export class CumulativeStream {
  private started = false
  private latest = ''
  /** How much of the runtime's cumulative text the closed segments hold. */
  private offset = 0
  private seen = 0
  /** Separators the source put into its cumulative text, by the offset where each starts. */
  private readonly syntheticSeparators = new Map<number, string>()

  constructor(private readonly emit: (phase: 'start' | 'delta' | 'complete', content: string) => void) {}

  update(content: string): void {
    if (!this.started) {
      const start = this.resolveStart(content)
      const segment = start ? content.slice(start) : content
      // Nothing worth a row yet: an empty or whitespace-only part waits for the text after it.
      if (!segment.trim()) return
      this.offset = start
      for (const pos of this.syntheticSeparators.keys()) if (pos < start) this.syntheticSeparators.delete(pos)
      this.seen = content.length
      this.emit('start', '')
      this.started = true
      this.latest = segment
      this.emit('delta', segment)
      return
    }
    this.seen = content.length
    const segment = this.segment(content)
    if (segment === this.latest) return
    this.latest = segment
    this.emit('delta', segment)
  }

  /**
   * The source put `sep` into its cumulative text at `atOffset` (a blank line between two replies, or
   * two summaries): a segment that opens there drops it. Recorded whether a segment is open or not.
   */
  markSyntheticSeparator(atOffset: number, sep = '\n\n'): void {
    this.syntheticSeparators.set(atOffset, sep)
  }

  /**
   * Whether `content` adds something visible to this stream: new non-whitespace text, or a changed
   * snapshot. Another stream breaks only for that, so an empty or whitespace-only update leaves its row open.
   */
  hasContentDelta(content: string): boolean {
    const segment = this.segment(content)
    if (!this.started) return segment.trim().length > 0
    if (segment.startsWith(this.latest)) return segment.slice(this.latest.length).trim().length > 0
    return segment.trim() !== this.latest.trim()
  }

  /**
   * Closes the stream with the runtime's cumulative `content` (default: the latest update), of
   * which the open segment gets only what came after the last break. No-op if nothing started.
   */
  complete(content?: string): void {
    if (!this.started) return
    this.emit('complete', (content === undefined ? '' : this.segment(content)) || this.latest)
  }

  /** Closes the current segment (a thought or a note before a tool call); what streams next opens another. */
  break(): void {
    if (!this.started) return
    this.emit('complete', this.latest)
    this.started = false
    this.latest = ''
    this.offset = this.seen
  }

  /** What of the runtime's cumulative text came after the last break, verbatim. */
  private segment(content: string): string {
    const start = this.resolveStart(content)
    return start ? content.slice(start) : content
  }

  /**
   * Where the next segment begins: past the last break and, while no segment is open, past each
   * separator the source recorded there (with any whitespace before it that opened no segment).
   */
  private resolveStart(content: string): number {
    let start = this.offset
    if (this.started || start === 0) return start
    while (start > 0) {
      let next: [number, string] | undefined
      for (const entry of this.syntheticSeparators) {
        const [pos] = entry
        if (pos >= start && pos <= content.length && (!next || pos < next[0])) next = entry
      }
      if (!next) break
      const [pos, sep] = next
      if (content.slice(start, pos).trim().length !== 0 || !content.startsWith(sep, pos)) break
      start = pos + sep.length
    }
    return start
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

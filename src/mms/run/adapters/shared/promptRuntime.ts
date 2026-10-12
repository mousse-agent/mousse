import { APPLET_GENERATION_GUIDANCE } from '../../../../shared/appletGuidance'
import type { StreamingLlmToolEvent } from '../../../orchestrator/LlmClient'
import type { TurnSink } from '../ProviderAdapter'

/**
 * Shared pieces of the prompt-injected vendor runtimes (SPEC §13.4): they run their own loop and
 * system prompt, report cumulative text, and take prior turns as a prompt preamble.
 */

/**
 * Applet instructions for a runtime with its own system prompt: the guidance the pi loop's system
 * prompt carries, followed by the conversation's applet catalogue. Undefined when applets are off.
 */
export function withAppletGuidance(catalogue: string | undefined): string | undefined {
  return catalogue === undefined ? undefined : APPLET_GENERATION_GUIDANCE + catalogue
}

/**
 * Relays a runtime's cumulative text (each callback carries everything so far) as the
 * start/delta/complete events the transcript expects: `start` before the first delta, and
 * `complete` only when something started.
 */
export class CumulativeStream {
  private started = false
  private latest = ''

  constructor(private readonly emit: (phase: 'start' | 'delta' | 'complete', content: string) => void) {}

  update(content: string): void {
    if (!this.started) {
      this.emit('start', '')
      this.started = true
    }
    this.latest = content
    this.emit('delta', content)
  }

  /** Closes the stream with `content` (default: the latest update). No-op if nothing started. */
  complete(content: string = this.latest): void {
    if (this.started) this.emit('complete', content)
  }
}

/** A vendor runtime's tool start/complete, as an MCP-style timeline call. */
export interface RuntimeToolEvent {
  phase: 'start' | 'complete'
  callId: string
  title: string
  toolName?: string
}

export function runtimeToolEvent(event: RuntimeToolEvent): StreamingLlmToolEvent {
  return {
    kind: 'mcp_tool_call',
    phase: event.phase,
    callId: event.callId,
    title: event.title,
    summary: event.toolName ?? event.title,
    details: []
  }
}

/** Text and thinking relays for one turn, bound to the sink. */
export function promptStreams(sink: TurnSink): { text: CumulativeStream; thinking: CumulativeStream } {
  return {
    text: new CumulativeStream((phase, content) => sink.text({ phase, content, contentIndex: 0 })),
    thinking: new CumulativeStream((phase, content) => sink.thinking({ phase, content }))
  }
}

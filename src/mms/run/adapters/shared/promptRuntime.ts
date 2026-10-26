import type { ActivityPatch, ProviderToolEvent } from '../../../../shared/agentActivity'
import type { StreamingLlmToolEvent } from '../../../harness/turnEvents'
import type { TurnSink } from '../ProviderAdapter'

/**
 * Shared pieces of the prompt-injected vendor runtimes (SPEC §13.4): they run their own loop and
 * system prompt, report cumulative text, and take prior turns as a prompt preamble. Their applet
 * guidance is part of the turn bridge's session instructions, the catalogue part of its preamble.
 */

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

/** Text and thinking relays for one turn, bound to the sink. */
export function promptStreams(sink: TurnSink): { text: CumulativeStream; thinking: CumulativeStream } {
  return {
    text: new CumulativeStream((phase, content) => sink.text({ phase, content, contentIndex: 0 })),
    thinking: new CumulativeStream((phase, content) => sink.thinking({ phase, content }))
  }
}

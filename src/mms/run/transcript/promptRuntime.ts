import { BACKGROUND_SUMMARY, INTERRUPTED_SUMMARY, type ActivityPatch, type ProviderToolEvent } from '../../../shared/agentActivity'
import { classifyCuaCall, guardedInput, guardedOutput, guardedTitle, isGuardedCall, mousseToolOfName, normalizeUseToolTarget } from '../../../shared/cuaActivity'
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
    ...(record ? { input: record.input, ...(record.response ? { response: record.response } : {}) } : event.input ? { input: event.input } : {}),
    ...(activity ? { activity } : {}),
    ...(event.parentCallId ? { parentCallId: event.parentCallId } : {})
  }
}

/** What a runtime knows of a call beside its event: its name, the `use_tool` target it read, and how it ended. */
export interface ToolEventHint {
  toolName?: string
  useToolTarget?: string
  /** The call's arguments, when the event does not carry them where the guard reads them. */
  args?: unknown
  /** `unfinished`: the run ended before the call reported its end. */
  status?: string
}

/** Summaries a closer writes, which say nothing of the call itself. */
const CLOSING_SUMMARIES: ReadonlySet<string> = new Set([...Object.values(INTERRUPTED_SUMMARY), BACKGROUND_SUMMARY])

/** A provider's server name, kept only when it is a plain name. */
function plainServer(server: unknown): string | undefined {
  return typeof server === 'string' && /^[\w.-]{1,64}$/.test(server) ? server : undefined
}

function argsJson(response: string | undefined): Record<string, unknown> | undefined {
  const trimmed = response?.trim()
  if (!trimmed?.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Holds every tool event of one turn to what a transcript may keep of a computer use call (`src/shared/cuaActivity.ts`),
 * following each call by its id from its first start to its end: a runtime that names the call or its `use_tool` target
 * only on some of its events (ACP's updates, Cursor's unfinished closure, Claude Code's first start) still gets the
 * call's row held from the first. Any other call's event passes unchanged, except that a call the run left
 * `unfinished` ends interrupted.
 */
export class CuaRowGuard {
  private readonly calls = new Map<string, { toolName?: string; useToolTarget?: string; input?: Record<string, unknown> }>()

  constructor(private readonly options: { aborted?: () => boolean } = {}) {}

  apply(event: StreamingLlmToolEvent, hint: ToolEventHint = {}): StreamingLlmToolEvent {
    const closed = this.closeUnfinished(event, hint.status)
    const known = event.callId ? this.calls.get(event.callId) : undefined
    const named = hint.toolName ?? event.activity?.toolName
    // A name that reads as a Mousse tool is kept over one that does not (a title, a later event's other spelling).
    const toolName = known?.toolName && (mousseToolOfName(known.toolName) || !named) ? known.toolName : (named ?? known?.toolName)
    const args = hint.args ?? event.activity?.input ?? event.input ?? (event.phase === 'start' ? argsJson(event.response) : undefined)
    const target = normalizeUseToolTarget(hint.useToolTarget) ?? known?.useToolTarget
    const call = classifyCuaCall(toolName, { input: args, useToolTarget: target })
    const resolved = call.kind === 'use_tool_cua' ? call.tool : call.kind === 'use_tool_other' ? call.inner : target
    const input = args !== undefined && isGuardedCall(call) ? guardedInput(call, args) : undefined
    if (event.callId) {
      if (event.phase === 'complete') this.calls.delete(event.callId)
      else this.calls.set(event.callId, { ...(toolName ? { toolName } : {}), ...(resolved ? { useToolTarget: resolved } : {}), ...((input ?? known?.input) ? { input: input ?? known?.input } : {}) })
    }
    if (call.kind === 'other') return closed
    // A `use_tool` of any other tool keeps its row as it is, and says which tool it ran.
    if (call.kind === 'use_tool_other') return { ...closed, activity: { ...closed.activity, useToolTarget: call.inner } }

    const patch = closed.activity
    const failed = patch?.status === 'failed' || hint.status === 'failed' || /returned an error/i.test(closed.summary ?? '')
    const title = guardedTitle(call, input ?? known?.input)
    const server = plainServer(patch && 'server' in patch ? patch.server : undefined)
    const output = closed.phase === 'complete' && patch?.status !== 'interrupted' ? guardedOutput(call, patch?.output ?? closed.response, failed) : undefined
    const activity: ActivityPatch = {
      kind: 'generic',
      ...(toolName ? { toolName } : {}),
      ...(server ? { server } : {}),
      ...(patch?.status ? { status: patch.status } : closed.phase === 'complete' && failed ? { status: 'failed' as const } : {}),
      ...(patch?.interruptedBy ? { interruptedBy: patch.interruptedBy } : {}),
      ...(patch?.summary && CLOSING_SUMMARIES.has(patch.summary) ? { summary: patch.summary } : {}),
      ...(patch?.notMovable ? { notMovable: true } : {}),
      ...(input ? { input } : {}),
      ...(output !== undefined ? { output } : {})
    }
    const { input: _input, response: _response, ...rest } = closed
    return { ...rest, title, summary: failed ? 'The tool returned an error.' : title, details: [], activity }
  }

  /** A call the run ended before it reported its end: interrupted, by a Stop or for want of a result. */
  private closeUnfinished(event: StreamingLlmToolEvent, status: string | undefined): StreamingLlmToolEvent {
    if (status !== 'unfinished' || event.phase !== 'complete' || event.activity?.status) return event
    const interruptedBy = this.options.aborted?.() ? 'stop' : 'no_result'
    return { ...event, activity: { ...event.activity, status: 'interrupted', interruptedBy, summary: INTERRUPTED_SUMMARY[interruptedBy] } }
  }
}

/**
 * One turn's tool events as timeline calls (`runtimeToolEvent`), each held by the turn's `CuaRowGuard`. An adapter
 * makes one per turn and sends every tool event through it.
 */
export function createRuntimeToolMapper(options: { aborted?: () => boolean } = {}): (event: RuntimeToolEvent & { status?: string }) => StreamingLlmToolEvent {
  const guard = new CuaRowGuard(options)
  return (event) =>
    guard.apply(runtimeToolEvent(event), {
      ...(event.toolName ? { toolName: event.toolName } : {}),
      ...(event.useToolTarget ? { useToolTarget: event.useToolTarget } : {}),
      ...(event.status ? { status: event.status } : {})
    })
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

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeMetricsCollector } from './metrics'

/** Where a turn's frames are reported; the slice of the chat input the stream needs. */
export interface TurnFrameSink {
  onText: (text: string) => void
  onThinking?: (text: string) => void
  onTool?: (event: { phase: 'start' | 'complete'; callId: string; title: string; toolName?: string }) => void
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
  /** Where the text of the current segment starts (a steer starts a new one); a result fills it in when it streamed nothing. */
  segmentStart = 0

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
        this.tools.set(event.content_block.id, event.content_block.name)
        this.sink.onTool?.({
          phase: 'start',
          callId: event.content_block.id,
          title: event.content_block.name,
          toolName: event.content_block.name
        })
      }
    }
    if (message.type === 'user' && Array.isArray(message.message.content))
      for (const block of message.message.content) {
        if (block.type === 'tool_result' && this.tools.has(block.tool_use_id)) {
          this.sink.onTool?.({
            phase: 'complete',
            callId: block.tool_use_id,
            title: this.tools.get(block.tool_use_id)!
          })
          this.tools.delete(block.tool_use_id)
        }
      }
  }

  /** Tools still open when the turn ends are closed so the transcript never shows them running. */
  closeTools(): void {
    for (const [callId, title] of this.tools) this.sink.onTool?.({ phase: 'complete', callId, title })
  }
}

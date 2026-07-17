import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage
} from '@earendil-works/pi-ai'
import type { ChatMessage, NativeLlmContext } from '../../shared/types'

export const NATIVE_CONTEXT_VERSION = 1 as const
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000
const MESSAGE_OVERHEAD = 4

export function createNativeContext(messages: Message[] = []): NativeLlmContext {
  return { version: NATIVE_CONTEXT_VERSION, messages: structuredClone(messages), fidelity: 'native', activeStartIndex: 0 }
}

export function migrateLegacyContext(messages: ChatMessage[]): NativeLlmContext {
  const transcript: Message[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const images: ImageContent[] = (message.images ?? [])
        .filter((image) => image.data && image.mimeType)
        .map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }))
      const content = images.length
        ? ([{ type: 'text', text: message.content || '(image attachment)' }, ...images] satisfies Array<TextContent | ImageContent>)
        : message.content
      transcript.push({ role: 'user', content, timestamp: Date.parse(message.timestamp) || Date.now() })
    } else if (message.role === 'assistant' && message.kind !== 'thinking') {
      // This intentionally does not invent native tool data or reasoning from UI cards.
      transcript.push(legacyAssistant(message.content, Date.parse(message.timestamp) || Date.now()))
    }
  }
  return { version: NATIVE_CONTEXT_VERSION, messages: transcript, fidelity: 'legacy-estimated', activeStartIndex: 0 }
}

export function userMessage(content: string, images?: Array<{ mimeType: string; data: string }>): UserMessage {
  const validImages = (images ?? []).filter((image) => image.data && image.mimeType)
  return {
    role: 'user',
    content: validImages.length
      ? [
          { type: 'text', text: content || '(image attachment)' },
          ...validImages.map((image): ImageContent => ({ type: 'image', data: image.data, mimeType: image.mimeType }))
        ]
      : content,
    timestamp: Date.now()
  }
}

function legacyAssistant(content: string, timestamp: number): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text: content }], api: 'openai-completions',
    provider: 'openai', model: 'legacy-text-only', usage: emptyUsage(), stopReason: 'stop', timestamp
  }
}

function emptyUsage(): AssistantMessage['usage'] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

export function getActiveMessages(context: NativeLlmContext): Message[] {
  const recent = context.messages.slice(Math.max(0, context.activeStartIndex))
  if (!context.compaction?.summary) return recent
  const summary: UserMessage = {
    role: 'user',
    content: `[Compacted conversation summary]\n${context.compaction.summary}`,
    timestamp: context.compaction.createdAt
  }
  return [summary, ...recent]
}

export function estimateMessageTokens(message: Message): number {
  let chars = 0
  if (message.role === 'user') {
    chars = typeof message.content === 'string'
      ? message.content.length
      : message.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
  } else if (message.role === 'assistant') {
    chars = message.content.reduce((sum, block) => {
      if (block.type === 'text') return sum + block.text.length
      if (block.type === 'thinking') return sum + block.thinking.length
      return sum + block.name.length + block.id.length + JSON.stringify(block.arguments).length
    }, 0)
  } else {
    chars = message.toolCallId.length + message.toolName.length + message.content.reduce(
      (sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
  }
  // Images are provider-tokenized; never estimate them from raw base64 length.
  return Math.ceil(chars / 4) + MESSAGE_OVERHEAD
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

/** Pi-style active estimate: trust the last provider usage, then estimate only trailing data. */
export function estimateActiveContextTokens(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'assistant' || message.stopReason === 'aborted' || message.stopReason === 'error') continue
    const measured = message.usage.totalTokens ||
      message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite
    if (measured > 0) return measured + estimateMessagesTokens(messages.slice(i + 1))
  }
  return estimateMessagesTokens(messages)
}

export function shouldCompactNativeContext(
  activeTokens: number,
  contextWindow: number,
  reserveTokens = DEFAULT_COMPACTION_RESERVE_TOKENS
): boolean {
  return activeTokens > contextWindow - reserveTokens
}

export function compactNativeContext(
  context: NativeLlmContext,
  keepRecentTokens = DEFAULT_COMPACTION_KEEP_RECENT_TOKENS
): NativeLlmContext {
  const start = context.activeStartIndex
  let tokens = 0
  let cut = context.messages.length
  for (let i = context.messages.length - 1; i >= start; i -= 1) {
    tokens += estimateMessageTokens(context.messages[i])
    cut = i
    if (tokens >= keepRecentTokens) break
  }
  // Never retain a tool result without the assistant tool-call batch that owns it.
  while (cut > start && context.messages[cut]?.role === 'toolResult') cut -= 1
  if (cut <= start) return context
  const summarized = context.messages.slice(start, cut)
  const summary = buildStructuredSummary(summarized, context.compaction?.summary)
  return {
    ...context,
    activeStartIndex: cut,
    compaction: {
      generation: (context.compaction?.generation ?? 0) + 1,
      summary,
      tokensBefore: estimateMessagesTokens(getActiveMessages(context)),
      createdAt: Date.now()
    }
  }
}

function buildStructuredSummary(messages: Message[], previous?: string): string {
  // Keep the deterministic fallback small. The retained suffix is the authoritative
  // detail; a summary that approaches the discarded text would defeat compaction.
  const visible = messages.map(messageToSummaryText).filter(Boolean).join('\n').slice(-1_200)
  return [
    'Goal:', visible || '(No recoverable visible text.)',
    'Constraints / preferences:', previous ? `Carry forward the prior summary:\n${previous.slice(-1_200)}` : '(None explicitly recorded.)',
    'Progress:', 'Older native messages were compacted after completing their tool batches.',
    'Key decisions:', 'Preserve provider-native semantics in the retained transcript.',
    'Next steps:', 'Continue from the retained recent messages and verify outstanding work.'
  ].join('\n\n')
}

function messageToSummaryText(message: Message): string {
  if (message.role === 'user') return `User: ${typeof message.content === 'string' ? message.content : message.content.filter((b): b is TextContent => b.type === 'text').map((b) => b.text).join('')}`
  if (message.role === 'assistant') return `Assistant: ${message.content.filter((b): b is TextContent => b.type === 'text').map((b) => b.text).join('')}`
  const result = message as ToolResultMessage
  return `Tool ${result.toolName}: ${result.content.filter((b): b is TextContent => b.type === 'text').map((b) => b.text).join('')}`
}

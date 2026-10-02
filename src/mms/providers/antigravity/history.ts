import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { NativeLlmContext } from '../../../shared/types'

/** Persisted conversation lineage, excluding binary images and private reasoning. */
export function antigravityHistory(context: NativeLlmContext, end = context.messages.length): string {
  const messages = context.messages.slice(Math.min(context.activeStartIndex, end), end).map((message) => ({
    role: message.role,
    ...(message.role === 'toolResult' ? { toolName: message.toolName } : {}),
    content: typeof message.content === 'string' ? message.content : message.content
      .filter((part) => part.type !== 'thinking')
      .map((part) => part.type === 'image' ? { type: 'image', mimeType: part.mimeType } : part)
  }))
  return messages.length || context.compaction?.summary
    ? JSON.stringify({ summary: context.compaction?.summary, messages })
    : ''
}

/** ACP reports no token usage. Preserve its text in the canonical transcript. */
export function antigravityAssistantMessage(text: string, model: string): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text }], provider: 'antigravity', model,
    api: 'openai-completions', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  }
}

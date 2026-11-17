/**
 * How the context gauge estimates a model context's messages. Kept free of the orchestrator's other modules: the
 * thread database read worker runs it too (`ThreadDbEngine.gauge`), so the daemon only sums what the worker found.
 */
import type { Message } from '../../shared/transcript'
import { isMissingPlaceholder } from '../data/threadDb/threadBlobs'

export const MESSAGE_OVERHEAD = 4
/** What one image counts, whatever its size. */
const IMAGE_TOKENS = 1_024

export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

export function estimateMessageTokens(message: Message): number {
  let chars = 0
  let images = 0
  if (message.role === 'user') {
    if (typeof message.content === 'string') chars = message.content.length
    else {
      chars = message.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
      images = message.content.filter((block) => block.type === 'image').length
    }
  } else if (message.role === 'assistant') {
    chars = message.content.reduce((sum, block) => {
      if (block.type === 'text') return sum + block.text.length
      if (block.type === 'thinking') return sum + block.thinking.length
      return sum + block.name.length + block.id.length + JSON.stringify(block.arguments).length
    }, 0)
  } else {
    chars = message.toolCallId.length + message.toolName.length + message.content.reduce(
      (sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
    images = message.content.filter((block) => block.type === 'image').length
  }
  return Math.ceil(chars / 4) + MESSAGE_OVERHEAD + images * IMAGE_TOKENS
}

/**
 * One message's estimate: its tokens, and how the gauge splits it into prompts and responses, thinking, tool calls
 * and results, and compaction summary. An assistant message's split is per block, so it can differ from `tokens`.
 */
export type MessageEstimate = [tokens: number, conversation: number, thinking: number, toolData: number, summary: number]

export function estimateMessage(message: Message): MessageEstimate {
  const tokens = estimateMessageTokens(message)
  if (message.role === 'user') {
    const text = typeof message.content === 'string' ? message.content : message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    return text.startsWith('[Compacted conversation summary]') ? [tokens, 0, 0, 0, tokens] : [tokens, tokens, 0, 0, 0]
  }
  if (message.role === 'toolResult') return [tokens, 0, 0, tokens, 0]
  let conversation = MESSAGE_OVERHEAD, thinking = 0, toolData = 0
  for (const block of message.content) {
    if (block.type === 'thinking') thinking += estimateTokens(block.thinking)
    else if (block.type === 'toolCall') toolData += estimateTokens(block.name + block.id + JSON.stringify(block.arguments))
    else conversation += estimateTokens(block.text)
  }
  return [tokens, conversation, thinking, toolData, 0]
}

/**
 * An image whose stored bytes could not be read (its data is a missing-blob placeholder) is sent to the model as a
 * short note instead, never as image data. The stored context keeps its reference, so the image comes back if its
 * file does. Changes `messages` in place.
 */
export function withoutMissingImages(messages: Message[]): Message[] {
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    content.forEach((part, index) => {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'image' && isMissingPlaceholder((part as { data?: unknown }).data)) {
        content[index] = { type: 'text', text: '[image unavailable]' }
      }
    })
  }
  return messages
}

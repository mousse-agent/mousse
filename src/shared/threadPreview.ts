import type { ChatMessage } from './types'

/** The longest reply preview a thread keeps (`Thread.lastReply`), in characters. The row cuts it further with an ellipsis. */
export const REPLY_PREVIEW_CHARS = 160

/**
 * A reply as one short line of plain text: code blocks, images and Markdown marks dropped, links as their text,
 * whitespace collapsed, cut at `max` characters with an ellipsis. Empty when nothing readable is left.
 */
export function replyPreviewText(text: string, max = REPLY_PREVIEW_CHARS): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...plain]
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : plain
}

/** Whether a message is a reply the agent wrote, as the transcript shows it: not a tool call, note or marker. */
function isReply(message: ChatMessage): boolean {
  return message.role === 'assistant' && !message.hidden && !message.inherited &&
    (message.kind === undefined || message.kind === 'message' || message.kind === 'plan_card')
}

/** The preview of the latest reply in `messages` (`Thread.lastReply`); undefined when there is none with text. */
export function latestReplyPreview(messages: readonly ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isReply(message) || !message.content) continue
    const preview = replyPreviewText(message.content)
    if (preview) return preview
  }
  return undefined
}

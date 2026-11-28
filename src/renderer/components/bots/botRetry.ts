import type { BotChatMessage } from '../../../shared/bots/personal/chat'
import { MAX_BOT_CHAT_ATTACHMENTS, MAX_BOT_CHAT_TEXT, type BotChatAttachment } from '../../../shared/bots/personal/methods'

/**
 * What Retry on a failed chat turn sends again: the owner's words and files of the turn that failed. A file of a bot of
 * another computer is named by its place there (`remote`) and sent from its copy here.
 */
export interface BotRetry {
  text: string
  attachments: Array<BotChatAttachment & { remote?: string }>
  replyTo?: string
}

/**
 * What Retry on the bot's failed message `failed` sends again, or null when it offers no Retry: the line has a way out
 * of its own (sign in, open providers, resume, pick a model), it is not a failed turn of the chat (work's failures have
 * no message of the owner's in their turn), or the owner already wrote after it (a Retry then would answer out of
 * order). The owner's messages of that turn are sent again as one, in their order, with their files and the reply the
 * first one made.
 */
export function botRetryOf(messages: readonly BotChatMessage[], failed: BotChatMessage): BotRetry | null {
  if (failed.author !== 'bot' || failed.kind !== 'error' || !failed.error || failed.error.action || !failed.activationId) return null
  if (messages.some((message) => message.author === 'owner' && message.seq > failed.seq)) return null
  const asked = messages.filter((message) => message.author === 'owner' && message.activationId === failed.activationId && message.seq < failed.seq)
  if (!asked.length) return null
  // As much as one message carries: a turn that joined several sends their first words and files, never a refused send.
  const text = asked.map((message) => message.text.trim()).filter(Boolean).join('\n\n').slice(0, MAX_BOT_CHAT_TEXT)
  const attachments = asked.flatMap((message) => message.attachments ?? []).filter((file) => file.path || file.remote).slice(0, MAX_BOT_CHAT_ATTACHMENTS)
    .map(({ name, path, remote }) => ({ name, path, ...(remote ? { remote } : {}) }))
  if (!text && !attachments.length) return null
  const replyTo = asked[0]!.replyTo?.id
  return { text, attachments, ...(replyTo ? { replyTo } : {}) }
}

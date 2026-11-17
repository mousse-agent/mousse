import type { AgentOrigin } from './types'

/** Starts every message a personal bot sends into one of its owner's threads ("use your threads"). */
export const BOT_MESSAGE_PREFIX = '[Message from your bot'

/** Ends it, as the closing line ends an agent's. */
export const BOT_MESSAGE_END = '[End of message from your bot]'

/**
 * The words an agent wrote, from a message stored with its origin: the text between the header Mousse wrote and the
 * closing line (`AgentOrigin.body`). A bot's message stored before it kept those lengths has them found in its text.
 * The whole text when the origin says nothing about them (a message stored before it did, an agent's note on its own
 * thread) or when the lengths do not fit the text.
 */
export function agentMessageWords(content: string, origin: Pick<AgentOrigin, 'kind' | 'body'> | { kind: string } | null | undefined): string {
  if (origin?.kind !== 'agent') return content
  const body = (origin as Pick<AgentOrigin, 'body'>).body ?? legacyBotMessageBody(content)
  if (!body || !Number.isSafeInteger(body.head) || !Number.isSafeInteger(body.tail) || body.head < 0 || body.tail < 0) return content
  const end = content.length - body.tail
  return body.head <= end ? content.slice(body.head, end) : content
}

/**
 * Where the bot's words sit in a bot's message stored before its origin kept that: after the header, which ends at its
 * first "]" and a blank line (the bot's name in it carries no brackets), and before the closing line.
 */
function legacyBotMessageBody(content: string): { head: number; tail: number } | undefined {
  const closing = `\n\n${BOT_MESSAGE_END}`
  if (!content.startsWith(BOT_MESSAGE_PREFIX) || !content.endsWith(closing)) return undefined
  const at = content.indexOf(']\n\n', BOT_MESSAGE_PREFIX.length)
  return at < 0 ? undefined : { head: at + 3, tail: closing.length }
}

import type { ChatMessage } from '../../../shared/types'

/**
 * A bot's status line: what it said it is doing now, its latest words before a step of its turn ("Checking prices at
 * Indian stores now"). The app shows it beside the bot's typing dots until the reply comes. Its reply is written after
 * its last step, so it is never a status line.
 */

/** The steps of a turn: a status line is the bot's words before one. */
const STEP_KINDS: ReadonlySet<string> = new Set(['tool_call', 'mcp_tool_call', 'build_tool_call'])

/**
 * The longest status line sent. The bot is asked for one short line; this only bounds what a long paragraph sends to
 * every window, and the app shows what comes in full, wrapping it.
 */
export const BOT_STATUS_MAX_CHARS = 280

export function isStepMessage(message: Pick<ChatMessage, 'kind'>): boolean {
  return message.kind !== undefined && STEP_KINDS.has(message.kind)
}

/**
 * The status line of a turn whose last message is a step: the bot's latest words in that turn, one line (whitespace
 * folded). Undefined when the last message is no step, or the bot said nothing in this turn before it.
 */
export function statusLineOf(messages: readonly ChatMessage[]): string | undefined {
  const last = messages.at(-1)
  if (!last || !isStepMessage(last)) return undefined
  for (let index = messages.length - 2; index >= 0; index--) {
    const message = messages[index]!
    // The turn began here: anything older is an earlier turn's.
    if (message.role === 'user' || (last.turnId && message.turnId && message.turnId !== last.turnId)) return undefined
    if (message.role !== 'assistant' || (message.kind !== undefined && message.kind !== 'message')) continue
    const text = message.content.replace(/\s+/g, ' ').trim()
    if (!text) continue
    return text.length > BOT_STATUS_MAX_CHARS ? `${text.slice(0, BOT_STATUS_MAX_CHARS - 1).trimEnd()}…` : text
  }
  return undefined
}

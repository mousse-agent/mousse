import type { BotChatMessage } from './chat'
import { nudgeNotificationText } from './questions'
import type { ThreadNotificationEvent } from '../../settings'

/**
 * What a bot's chat row announces (Bot Phase 1 §5.7), as the thread event whose channels it uses:
 * a run report, a reply, a notice or an error is `completed`; an open ask is `question`. The
 * owner's own messages, service lines, answered asks and rows older than `maxAgeMs` (a changed old row, such as
 * a forgotten memory's blanked text) announce nothing. Chips never notify: they are not rows.
 */
export function botNotificationKind(
  message: Pick<BotChatMessage, 'author' | 'at' | 'ask' | 'question' | 'systemLine' | 'action'>,
  now = Date.now(),
  maxAgeMs = 10 * 60_000
): ThreadNotificationEvent | null {
  if (message.author !== 'bot' || message.systemLine) return null
  const at = Date.parse(message.at)
  if (Number.isFinite(at) && now - at > maxAgeMs) return null
  if (message.action) return message.action.status === 'open' ? 'question' : null
  if (message.ask) return message.ask.status === 'open' ? 'question' : null
  // A bot's question with answers to tap (`question_ask`) is announced as a question, as an ask is.
  if (message.question) return message.question.status === 'open' ? 'question' : null
  return 'completed'
}

/** The words of a bot notification: the bot's name as the title, then what it wants or said. */
export function botNotificationContent(
  botName: string | undefined,
  message: Pick<BotChatMessage, 'text' | 'ask' | 'error' | 'question' | 'plainFrom' | 'replyTo' | 'action'>
): { title: string; body: string } {
  const title = botName?.trim() || 'Your bot'
  if (message.action) return { title, body: `Wants to ${message.action.title[0]?.toLowerCase() ?? ''}${message.action.title.slice(1)}` }
  if (message.ask) return { title, body: `Wants to ${message.ask.title}` }
  if (message.error) return { title, body: message.error.text }
  // A question: its words and its answers, "Which flat? — Flat A / Flat B". A nudge names the question it reminds of,
  // from the bubble it replies to as that is now: "Still need your answer: Which flat? — Flat A / Flat B".
  if (message.question) {
    const reminds = message.question.nudge && message.replyTo && !message.replyTo.gone && message.replyTo.text.trim() ? nudgeNotificationText(message.replyTo.text) : undefined
    const asked = reminds ?? (message.plainFrom !== undefined ? message.text.slice(0, message.plainFrom) : message.text).replace(/\s+/g, ' ').trim()
    const answers = message.question.choices.map((choice) => choice.label).join(' / ')
    const body = answers ? `${asked} — ${answers}` : asked
    return { title, body: body.length > 140 ? `${body.slice(0, 139)}…` : body || 'New message' }
  }
  const line = message.text
    .split('\n')
    .map((part) => part.replace(/[*_`#>[\]]/g, '').replace(/^\s*(?:[-+]|\d+\.)\s+/, '').trim())
    .find(Boolean)
  if (!line) return { title, body: 'New message' }
  return { title, body: line.length > 140 ? `${line.slice(0, 139)}…` : line }
}

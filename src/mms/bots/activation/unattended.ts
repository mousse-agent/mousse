import { THREAD_MESSAGE_KEY_PREFIX } from '../../../shared/bots/personal/jobs'
import type { BotActivationRow } from '../store/BotStore'

/**
 * The chat turns no person started and no person waits on: a wake-up (`wake:`), a thread's notice (`job:`) or message
 * (`threadmsg:`), and another bot's message (`botmsg:`). They may end silently (`[SILENT]`), and while they run the
 * chat shows nothing of them: no typing, working line or streaming words. A question's default answer (`question:`)
 * always says what it went with, so it is not one of them.
 */
const UNATTENDED_CHAT_KEYS = ['wake:', 'job:', 'botmsg:', THREAD_MESSAGE_KEY_PREFIX] as const

export function unattendedChatTurn(row: Pick<BotActivationRow, 'lane' | 'idempotencyKey'>): boolean {
  return row.lane === 'chat' && UNATTENDED_CHAT_KEYS.some((key) => row.idempotencyKey.startsWith(key))
}

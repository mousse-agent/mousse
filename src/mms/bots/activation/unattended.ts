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

/**
 * Which notices one turn takes in together (`BotEngine.noticeBatchInTx`): those that may act on the owner's threads (a
 * wake-up, a thread's notice or message: `acting`), or another bot's message, which only reads them (`botmsg`). A batch
 * never holds both, so it never gains a power one of its notices lacked. Undefined: not a notice.
 */
export type NoticeClass = 'acting' | 'botmsg'

export function noticeClass(row: Pick<BotActivationRow, 'lane' | 'idempotencyKey'>): NoticeClass | undefined {
  if (!unattendedChatTurn(row)) return undefined
  return row.idempotencyKey.startsWith('botmsg:') ? 'botmsg' : 'acting'
}

/** A notice that starts at once, without waiting for others to settle: a thread the bot started waits on it. */
export function fastNotice(row: Pick<BotActivationRow, 'trigger'>): boolean {
  return row.trigger.kind === 'manual' && row.trigger.fast === true
}

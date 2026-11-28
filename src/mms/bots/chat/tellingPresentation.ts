import type { BotChatMessage } from '../../../shared/bots/personal/chat'
import { botNotificationContent } from '../../../shared/bots/personal/notification'
import type { BotTelling } from '../../../shared/bots/personal/telling'

/**
 * The sound limits every bot notification of a profile shares, this computer's bots and the other computers' alike:
 * at most six sounds an hour, and at most one per bot in ten minutes. Kept in memory; a restart resets them.
 */
export class TellingSounds {
  private readonly botSounds = new Map<string, number>()
  private profileSounds: number[] = []

  /** Whether a notification of `bots` may sound now; counts it when it may. */
  soundFor(bots: string[], now: number): boolean {
    this.profileSounds = this.profileSounds.filter(at => now - at < 3600_000)
    if (this.profileSounds.length >= 6 || !bots.some(bot => now - (this.botSounds.get(bot) ?? -Infinity) >= 600_000)) return false
    this.profileSounds.push(now)
    for (const bot of bots) this.botSounds.set(bot, now)
    return true
  }
}

/** One message a notification tells of. */
export interface TellingItem {
  /** How the notification names the bot: its id here, or `<node>:<botId>` for another computer's bot. */
  botId: string
  name: string
  messageId: string
  seq: number
  tell: 'now' | 'soon' | 'later'
  /** An ask, a question, an action waiting for the owner or an error: it goes first, and "needs you". */
  needsYou: boolean
  /**
   * The message, read only for the one that heads the notification (a local row is projected once per notification),
   * and whether it is an ask, question or action: a notification it heads is a question.
   */
  heading(): { message: TellingWords; asks: boolean }
}

export type TellingWords = Pick<BotChatMessage, 'text' | 'ask' | 'error' | 'question' | 'plainFrom' | 'replyTo' | 'action'>

/**
 * The words of one notification of `items`, for this computer's bots and the other computers' alike: what needs the
 * owner first, then in chat order; one message under the bot's name, several as a count, a backlog under `closed`.
 */
export function tellingOf(id: string, items: TellingItem[], sound: boolean, closed: false | string = false): BotTelling {
  const priority = (item: TellingItem): number => item.tell === 'later' ? 0 : item.needsYou ? 2 : 1
  const rows = [...items].sort((a, b) => priority(b) - priority(a) || a.seq - b.seq)
  const first = rows[0]!
  const heading = first.heading()
  const names = [...new Set(rows.map(r => r.name))]
  const { body } = botNotificationContent(first.name, heading.message)
  const summary = names.map(name => {
    const group = rows.filter(r => r.name === name)
    return group.some(r => r.needsYou) ? `${name} needs you` : `${name} ${group.length} ${group.length === 1 ? 'message' : 'messages'}`
  }).join(' · ')
  const title = rows.length === 1 ? names[0]! : closed ? `${closed}: ${summary}` : `${names.join(', ')} · ${rows.length} messages`
  return {
    id,
    rows: rows.map(r => ({ botId: r.botId, messageId: r.messageId, seq: r.seq, tell: r.tell })),
    title,
    body,
    kind: heading.asks ? 'question' : 'completed',
    sound
  }
}

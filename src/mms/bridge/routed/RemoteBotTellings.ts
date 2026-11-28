import { randomUUID } from 'node:crypto'
import type { NodeId } from '../../../shared/net'
import type { BotAttention, BotTelling } from '../../../shared/bots/personal/telling'
import { qualifyId } from '../../../shared/threadRef'
import { TellingSounds, tellingOf, type TellingItem } from '../../bots/chat/tellingPresentation'
import type { RemoteBotMessage } from '../remote/RemoteBots'
import type { BotFeedRow } from '../remote/BotStreamSources'

/** How long a fold of `soon` messages takes in more, as `BotTellings` does. */
const FOLD_MS = 120_000
/** At most this many of a bot's newest messages are asked for to word its notifications (the feed lists at most 20). */
const MESSAGES_ASKED = 20
/**
 * How long after a feed is live again (it caught up after opening, or its computer came back) what it sends still only
 * sets what is known: the bot's computer publishes a fresh snapshot for a reader that opens its feed, which can come
 * just after the feed caught up, and holds what came while this computer was away.
 */
export const OPEN_SETTLE_MS = 5_000

export interface RemoteBotTellingsOptions {
  /** Tells this computer's windows (`bots.tell`), as this computer's own bots' notifications are told. */
  emit(telling: BotTelling): void
  /** A bot this computer muted or hid (`bot-marks.json`), by its ref (`<node>:<botId>`): it tells nothing. */
  quiet(ref: string): boolean
  /** The sound limits shared with this computer's own bots (`BotTellings.sounds`); absent while it has none. */
  sounds(): TellingSounds | undefined
  /** The bot's chat as copied here while it is shown (`RemoteBotChats`): asked before its computer is. */
  cached?(node: NodeId, botId: string): RemoteBotMessage[]
  /** The bot's newest messages, from its computer (`bots.chat.list`). */
  messages(node: NodeId, botId: string, limit: number): Promise<RemoteBotMessage[]>
  clock?: { now(): number }
  openSettleMs?: number
}

/** What is known of one bot of another computer: its feed's open attention and how far its chat is read. */
interface Bot {
  node: NodeId
  botId: string
  name: string
  readSeq: number
  /** The feed's open attention, by message id. */
  open: Map<string, BotAttention>
  /** Attention ids already seen here (told, kept quiet, or there when the feed was first read): never told again. */
  seen: Set<string>
}

/**
 * Notifications here for the bots of the user's other computers, as `BotTellings` tells this computer's own: a `now`
 * message on its own, `soon` messages folded for two minutes, the same words and the same sound limits, and a click
 * opens the bot's chat (each row names the bot by its ref, `<node>:<botId>`).
 *
 * It follows each computer's bots feed (`RemoteBotRegistry`), whose rows carry the bot's read mark and the messages
 * that still want the owner (`attention`). Only a live change tells. What a feed sends from the moment it (re)opens or
 * its computer goes away until a few seconds after it is live again (`OPEN_SETTLE_MS`), after a start, a reconnect, a
 * reopened feed or a copy installed, only sets what is known; so does the first row of a bot this computer had not
 * listed (a bot newly in reach). So nothing is told twice and nothing old is told late; what came meanwhile shows as
 * unread in the list. Nothing is kept on disk: after a restart every bot is new again. A bot muted or hidden here tells
 * nothing. A notification is withdrawn once none of its
 * messages wants the owner any more: read on any device (the read mark passes it), answered, or gone. A bot this
 * computer loses, or a computer it no longer reaches bots of, takes its notifications and what was known with it.
 *
 * Nothing runs on a start or on a thread's or turn's start: it works on feed changes only, and asks the bot's computer
 * for words only for a message it is about to tell.
 */
export class RemoteBotTellings {
  private readonly bots = new Map<string, Bot>()
  /** Until when each computer's feed only sets what is known: unset until the feed is first live, Infinity while opening. */
  private readonly settling = new Map<NodeId, number>()
  private readonly banners = new Map<string, TellingItem[]>()
  private fold: { id: string; until: number; items: TellingItem[] } | undefined
  private readonly ownSounds = new TellingSounds()
  private closed = false

  constructor(private readonly options: RemoteBotTellingsOptions) {}

  private now(): number {
    return (this.options.clock ?? Date).now()
  }

  close(): void {
    this.closed = true
  }

  /** The computer's feed is (re)opening, or the computer went away: what it sends until it is live again sets what is known. */
  unbase(node: NodeId): void {
    this.settling.set(node, Infinity)
  }

  /** The computer's feed is live again (it caught up, or the computer is back): a few seconds more set what is known. */
  opened(node: NodeId): void {
    this.settling.set(node, this.now() + (this.options.openSettleMs ?? OPEN_SETTLE_MS))
  }

  /**
   * A snapshot of `node`'s bots feed: `live` once the feed has caught up with the computer. One sent before the feed is
   * live, or within `OPEN_SETTLE_MS` of it, tells nothing.
   */
  feed(node: NodeId, rows: readonly BotFeedRow[], live: boolean): void {
    if (this.closed) return
    // The first live snapshot since the feed opened or the computer came back starts the settling, if nothing did yet.
    if (live && (this.settling.get(node) ?? Infinity) === Infinity) this.opened(node)
    const baseline = !live || this.now() < this.settling.get(node)!
    const listed = new Set(rows.map((row) => row.id))
    const gone = [...this.bots.values()].filter((bot) => bot.node === node && !listed.has(bot.botId)).map((bot) => bot.botId)
    if (gone.length) this.lose(node, gone)
    const fresh: Array<{ bot: Bot; entries: BotAttention[]; row: BotFeedRow }> = []
    for (const row of rows) {
      const ref = qualifyId(node, row.id)
      const attention = attentionOf(row)
      let bot = this.bots.get(ref)
      // A bot not listed here before (newly in reach, or first seen since a start): what it has is not news.
      const first = !bot
      if (!bot) {
        bot = { node, botId: row.id, name: row.name, readSeq: 0, open: new Map(), seen: new Set() }
        this.bots.set(ref, bot)
      }
      bot.name = row.name
      bot.readSeq = typeof row.readSeq === 'number' ? row.readSeq : 0
      bot.open = new Map(attention.map((entry) => [entry.id, entry]))
      const known = bot.seen
      const entries = baseline || first ? [] : attention.filter((entry) => !known.has(entry.id))
      // Only what the feed still lists is kept: a message leaves attention for good once read or answered.
      bot.seen = new Set(attention.map((entry) => entry.id))
      if (entries.length && !this.isQuiet(ref)) fresh.push({ bot, entries: entries.reverse(), row })
    }
    this.withdrawSettled()
    for (const each of fresh) void this.tell(each.bot, each.entries, each.row)
  }

  /** Bots this computer no longer reaches on `node` (all of them when none are named): their notifications go. */
  lose(node: NodeId, botIds?: Iterable<string>): void {
    const refs = botIds ? new Set([...botIds].map((botId) => qualifyId(node, botId))) : undefined
    for (const [ref, bot] of [...this.bots]) if (bot.node === node && (!refs || refs.has(ref))) this.bots.delete(ref)
    const gone = (item: TellingItem): boolean => refs ? refs.has(item.botId) : item.botId.startsWith(`${node}:`)
    for (const [id, items] of [...this.banners]) {
      if (!items.some(gone)) continue
      const left = items.filter((item) => !gone(item) && this.stillOpen(item))
      if (!left.length) this.withdraw(id)
      else {
        // Its other bots' messages stay told, without the lost bot's, and without a sound.
        this.banners.set(id, left)
        if (this.fold?.id === id) this.fold.items = left
        this.emit(tellingOf(id, left, false))
      }
    }
  }

  private isQuiet(ref: string): boolean {
    try {
      return this.options.quiet(ref)
    } catch {
      return false
    }
  }

  /** Whether the message still wants the owner, as the bot's feed last said. */
  private stillOpen(item: TellingItem): boolean {
    const bot = this.bots.get(item.botId)
    return !!bot && item.seq > bot.readSeq && bot.open.has(item.messageId)
  }

  /** A notification none of whose messages wants the owner any more is taken back. */
  private withdrawSettled(): void {
    for (const [id, items] of [...this.banners]) if (!items.some((item) => this.stillOpen(item))) this.withdraw(id)
  }

  private withdraw(id: string): void {
    this.banners.delete(id)
    if (this.fold?.id === id) this.fold = undefined
    this.emit({ id, rows: [], title: '', body: '', kind: 'completed', sound: false })
  }

  private emit(telling: BotTelling): void {
    try {
      this.options.emit(telling)
    } catch {
      // A window that can't be told now misses this one; the chat and its unread count still show it.
    }
  }

  /** Tells the bot's new messages, worded from the messages themselves (`entries` oldest first). */
  private async tell(bot: Bot, entries: BotAttention[], row: BotFeedRow): Promise<void> {
    const ref = qualifyId(bot.node, bot.botId)
    const words = await this.messagesOf(bot, entries)
    if (this.closed || this.bots.get(ref) !== bot || this.isQuiet(ref)) return
    const items = entries
      .map((entry) => itemOf(ref, bot.name, entry, words.get(entry.id) ?? fallback(row, entry)))
      .filter((item) => this.stillOpen(item))
    if (!items.length) return
    const now = this.now()
    for (const item of items.filter((each) => each.tell === 'now')) {
      const id = `bt_${randomUUID()}`
      this.emit(tellingOf(id, [item], true))
      this.banners.set(id, [item])
    }
    const soon = items.filter((each) => each.tell === 'soon')
    if (!soon.length) return
    const base = this.fold && this.fold.until >= now ? this.fold : { id: `bt_${randomUUID()}`, until: now + FOLD_MS, items: [] }
    const folded = [...base.items.filter((item) => this.stillOpen(item) && !this.isQuiet(item.botId)), ...soon]
    this.fold = { ...base, items: folded }
    const sound = (this.options.sounds() ?? this.ownSounds).soundFor([ref], now)
    this.emit(tellingOf(base.id, folded, sound))
    this.banners.set(base.id, folded)
  }

  /** The messages named, from the copy here when it has them, else from the bot's computer; none when it can't say. */
  private async messagesOf(bot: Bot, entries: BotAttention[]): Promise<Map<string, RemoteBotMessage>> {
    const wanted = new Set(entries.map((entry) => entry.id))
    const found = new Map<string, RemoteBotMessage>()
    const take = (messages: readonly RemoteBotMessage[]): void => {
      for (const message of messages) if (wanted.has(message.id)) found.set(message.id, message)
    }
    try {
      take(this.options.cached?.(bot.node, bot.botId) ?? [])
    } catch {
      // No copy to read: the bot's computer is asked.
    }
    if (found.size < wanted.size) {
      try {
        take(await this.options.messages(bot.node, bot.botId, MESSAGES_ASKED))
      } catch {
        // Worded from the feed alone.
      }
    }
    return found
  }
}

/** The feed row's attention, as this build reads it: entries with an id, a sequence and a loudness. */
function attentionOf(row: BotFeedRow): BotAttention[] {
  const list = Array.isArray(row.telling?.attention) ? row.telling.attention : []
  return list.filter(
    (entry): entry is BotAttention =>
      !!entry && typeof entry === 'object' && typeof entry.id === 'string' && Number.isSafeInteger(entry.seq) && (entry.tell === 'now' || entry.tell === 'soon')
  )
}

function itemOf(ref: string, name: string, entry: BotAttention, message: Pick<RemoteBotMessage, 'id' | 'text' | 'ask' | 'error' | 'question' | 'plainFrom' | 'replyTo' | 'action'>): TellingItem {
  const action = entry.id.startsWith('bm_action_')
  return {
    botId: ref,
    name: name.trim() || 'Your bot',
    messageId: entry.id,
    seq: entry.seq,
    tell: entry.tell,
    needsYou: Boolean(message.ask || message.question || message.error || message.action || action),
    heading: () => ({ message, asks: Boolean(message.ask || message.question || message.action || action) })
  }
}

/** A message whose words could not be read: the bot's latest reply line when it is that message, else "New message". */
function fallback(row: BotFeedRow, entry: BotAttention): Pick<RemoteBotMessage, 'id' | 'text'> {
  return { id: entry.id, text: row.telling?.latest?.id === entry.id ? (row.lastReply ?? '') : '' }
}

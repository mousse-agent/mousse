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
/** What came while no window was open is told once one opens, as `BotTellings` tells its backlog: within a day only. */
const HELD_MS = 86_400_000
/** The backlog told once a window opens, under the words `BotTellings` uses for its own. */
const CLOSED_LABEL = 'While Mousse was closed'

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
}

/** What is known of one bot of another computer: its feed's open attention, how far its chat is read and was seen. */
interface Bot {
  node: NodeId
  botId: string
  name: string
  readSeq: number
  /** The feed's open attention, by message id. */
  open: Map<string, BotAttention>
  /** The highest sequence of the bot's attention this computer has seen: only a message past it is news. */
  topSeq: number
}

/**
 * A new message seen while no window was open, told once one opens: only what telling it needs. One stays held only
 * while its bot's feed still lists it (at most twenty a bot), it is less than a day old and the bot is not quiet here.
 */
interface Held {
  ref: string
  entry: BotAttention
  /** Its words should its bot's computer not give them: the feed's latest reply line, or none. */
  fallback: string
  at: number
}

/**
 * Notifications here for the bots of the user's other computers, as `BotTellings` tells this computer's own: a `now`
 * message on its own, `soon` messages folded for two minutes, the same words and the same sound limits, and a click
 * opens the bot's chat (each row names the bot by its ref, `<node>:<botId>`).
 *
 * It follows each computer's bots feed (`RemoteBotRegistry`), whose rows carry the bot's read mark and the messages
 * that still want the owner (`attention`). A message is news once: when its sequence passes the highest this computer
 * has seen of the bot. What a computer's feed sends until it first catches up after a start only sets what is known,
 * and so does the first row of a bot this computer had not listed (a bot newly in reach): nothing kept on disk is
 * needed for a restart never to repeat a notification. What came while a computer was away (a reconnect, a reopened
 * feed) and arrives as its feed catches up is told then, folded and without a sound, as `BotTellings` tells what came
 * while Mousse was closed; so is what came while no window was open, once one opens, if it is less than a day old. A bot muted or hidden here
 * tells nothing. A notification is withdrawn once none of its messages wants the owner any more: read on any device
 * (the read mark passes it), answered, or gone. A bot this computer loses, or a computer it no longer reaches bots of,
 * takes its notifications and what was known with it.
 *
 * Nothing runs on a start or on a thread's or turn's start: it works on feed changes only, and asks the bot's computer
 * for words only for a message it is about to tell.
 */
export class RemoteBotTellings {
  private readonly bots = new Map<string, Bot>()
  /** Computers whose feed caught up since the start: before that, what they send only sets what is known. */
  private readonly based = new Set<NodeId>()
  /** Computers catching up after being away: what is new until their feed caught up again is told as a backlog. */
  private readonly catching = new Set<NodeId>()
  /** The silent fold each computer's catch-up is told in. */
  private readonly catchFolds = new Map<NodeId, string>()
  private readonly held = new Map<string, Held>()
  private readonly banners = new Map<string, TellingItem[]>()
  private fold: { id: string; until: number; items: TellingItem[] } | undefined
  private readonly ownSounds = new TellingSounds()
  private windows = 0
  private closed = false

  constructor(private readonly options: RemoteBotTellingsOptions) {}

  private now(): number {
    return (this.options.clock ?? Date).now()
  }

  close(): void {
    this.closed = true
  }

  /** How many windows show notifications: until one does, new messages are held, then told as one silent fold. */
  attach(windows: number): void {
    const opening = windows > 0 && this.windows === 0
    this.windows = windows
    if (!opening || this.closed) return
    this.pruneHeld()
    if (!this.held.size) return
    const held = [...this.held.values()]
    this.held.clear()
    void this.tellHeld(held)
  }

  /** A bot was muted, hidden or marked otherwise here: what is held of a bot now quiet goes. */
  marksChanged(): void {
    this.pruneHeld()
  }

  /** The computer's feed is reopening, or the computer went away: what is new once it is back is told as a backlog. */
  reconnecting(node: NodeId): void {
    if (!this.based.has(node)) return
    this.catching.add(node)
    this.catchFolds.delete(node)
  }

  /**
   * The computer's feed caught up (what it replays as it opens is in: the Bridge's copy, then what the computer has
   * that the copy lacks), or the computer is back with its feed still attached: what it sends from now on is live.
   */
  caughtUp(node: NodeId): void {
    this.based.add(node)
    this.catching.delete(node)
  }

  /**
   * A snapshot of `node`'s bots feed. Until its feed first caught up since the start, a snapshot only sets what is
   * known; while it catches up after being away, what is new in it is told as a backlog.
   */
  feed(node: NodeId, rows: readonly BotFeedRow[]): void {
    if (this.closed) return
    const start = !this.based.has(node)
    const backlog = this.catching.has(node)
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
        bot = { node, botId: row.id, name: row.name, readSeq: 0, open: new Map(), topSeq: 0 }
        this.bots.set(ref, bot)
      }
      bot.name = row.name
      bot.readSeq = typeof row.readSeq === 'number' ? row.readSeq : 0
      bot.open = new Map(attention.map((entry) => [entry.id, entry]))
      const top = bot.topSeq
      bot.topSeq = Math.max(top, ...attention.map((entry) => entry.seq))
      if (start || first) continue
      // An older message coming back into the feed's list (one newer was answered) is not news: it was seen.
      const entries = attention.filter((entry) => entry.seq > top)
      if (entries.length && !this.isQuiet(ref)) fresh.push({ bot, entries: entries.reverse(), row })
    }
    this.withdrawSettled()
    this.pruneHeld()
    for (const each of fresh) {
      if (!this.windows) {
        const ref = qualifyId(node, each.bot.botId)
        const at = this.now()
        for (const entry of each.entries) this.hold({ ref, entry, fallback: fallback(each.row, entry), at })
      } else void this.tell(each.bot, each.entries, each.row, backlog)
    }
  }

  private hold(held: Held): void {
    this.held.set(`${held.ref}\n${held.entry.id}`, held)
  }

  /** Whether a held message is still to be told: its bot's feed lists it unread, it is recent and the bot not quiet. */
  private stillHeld(held: Held, now = this.now()): boolean {
    const bot = this.bots.get(held.ref)
    return !!bot && now - held.at <= HELD_MS && held.entry.seq > bot.readSeq && bot.open.has(held.entry.id) && !this.isQuiet(held.ref)
  }

  private pruneHeld(): void {
    const now = this.now()
    for (const [key, held] of [...this.held]) if (!this.stillHeld(held, now)) this.held.delete(key)
  }

  /** Bots this computer no longer reaches on `node` (all of them when none are named): their notifications go. */
  lose(node: NodeId, botIds?: Iterable<string>): void {
    const refs = botIds ? new Set([...botIds].map((botId) => qualifyId(node, botId))) : undefined
    for (const [ref, bot] of [...this.bots]) if (bot.node === node && (!refs || refs.has(ref))) this.bots.delete(ref)
    for (const [key, held] of [...this.held]) if (refs ? refs.has(held.ref) : held.ref.startsWith(`${node}:`)) this.held.delete(key)
    if (!refs) {
      this.based.delete(node)
      this.catching.delete(node)
      this.catchFolds.delete(node)
    }
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
    for (const [node, fold] of [...this.catchFolds]) if (fold === id) this.catchFolds.delete(node)
    this.emit({ id, rows: [], title: '', body: '', kind: 'completed', sound: false })
  }

  private emit(telling: BotTelling): void {
    try {
      this.options.emit(telling)
    } catch {
      // A window that can't be told now misses this one; the chat and its unread count still show it.
    }
  }

  /** The items of `entries` that still want the owner, worded from the messages themselves. */
  private async itemsOf(bot: Bot, entries: BotAttention[], fallbackOf: (entry: BotAttention) => string): Promise<TellingItem[]> {
    const ref = qualifyId(bot.node, bot.botId)
    const words = await this.messagesOf(bot, entries)
    if (this.closed || this.bots.get(ref) !== bot || this.isQuiet(ref)) return []
    return entries
      .map((entry) => itemOf(ref, bot.name, entry, words.get(entry.id) ?? { id: entry.id, text: fallbackOf(entry) }))
      .filter((item) => this.stillOpen(item))
  }

  /** An item still to be told now: its bot is the one it was worded for, its message unread, and the bot not quiet. */
  private stillToTell(item: TellingItem, bot: Bot): boolean {
    return this.bots.get(item.botId) === bot && this.stillOpen(item) && !this.isQuiet(item.botId)
  }

  /** Tells the bot's new messages (`entries` oldest first): live, or as the backlog of a computer back from away. */
  private async tell(bot: Bot, entries: BotAttention[], row: BotFeedRow, backlog: boolean): Promise<void> {
    const items = await this.itemsOf(bot, entries, (entry) => fallback(row, entry))
    if (!items.length) return
    if (!this.windows) {
      // The last window closed while the words were asked for: held until one opens.
      const at = this.now()
      for (const item of items) {
        const entry = entries.find((each) => each.id === item.messageId)!
        this.hold({ ref: item.botId, entry, fallback: fallback(row, entry), at })
      }
      return
    }
    if (backlog) {
      // What came while the computer was away: one silent fold for its catch-up, as a backlog is told.
      const id = this.catchFolds.get(bot.node) ?? `bt_${randomUUID()}`
      this.catchFolds.set(bot.node, id)
      const folded = [...(this.banners.get(id) ?? []).filter((item) => this.stillOpen(item) && !this.isQuiet(item.botId)), ...items]
      this.emit(tellingOf(id, folded, false))
      this.banners.set(id, folded)
      return
    }
    const ref = qualifyId(bot.node, bot.botId)
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

  /** What came while no window was open, less than a day old and still wanting the owner: one silent fold. */
  private async tellHeld(held: Held[]): Promise<void> {
    // What was read, answered or quieted meanwhile is dropped before its bot's computer is asked for any words.
    const now = this.now()
    const byBot = new Map<Bot, Held[]>()
    for (const each of held) {
      if (!this.stillHeld(each, now)) continue
      const bot = this.bots.get(each.ref)!
      byBot.set(bot, [...(byBot.get(bot) ?? []), each])
    }
    const worded: Array<{ item: TellingItem; bot: Bot; held: Held }> = []
    for (const [bot, list] of byBot) {
      const byId = new Map(list.map((each) => [each.entry.id, each]))
      const entries = list.map((each) => each.entry).sort((a, b) => a.seq - b.seq)
      for (const item of await this.itemsOf(bot, entries, (entry) => byId.get(entry.id)!.fallback)) worded.push({ item, bot, held: byId.get(item.messageId)! })
    }
    if (this.closed) return
    // Each one again, as the words of another bot were asked for meanwhile.
    const left = worded.filter((each) => this.stillToTell(each.item, each.bot))
    if (!left.length) return
    if (!this.windows) {
      // Every window closed while the words were asked for: held until one opens.
      for (const each of left) this.hold(each.held)
      return
    }
    const items = left.map((each) => each.item)
    const id = `bt_${randomUUID()}`
    this.emit(tellingOf(id, items, false, CLOSED_LABEL))
    this.banners.set(id, items)
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
function fallback(row: BotFeedRow, entry: BotAttention): string {
  return row.telling?.latest?.id === entry.id ? (row.lastReply ?? '') : ''
}

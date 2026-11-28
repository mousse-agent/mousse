import type { BotChatMessage, BotChip, BotSummary } from '../../../shared/bots/personal/chat'
import type { BotAttention } from '../../../shared/bots/personal/telling'
import type { BotReachPort } from '../../protocol/botReachPort'
import { NetError } from '../../../shared/net'
import { mmsJson } from './jsonOutput'
import { fittedBotMessage, fittedBotPage, remoteBotSummary, type RemoteBotMessage, type RemoteBotPage } from './RemoteBots'
import type { ThreadSourceEvent } from './ThreadStreamAdapter'

/**
 * The bot streams of one device on the bot's computer: the bots feed (`bridge.bots.open`) and one bot's chat
 * (`bridge.bot.open`). Each is read by that device alone (`privateStreams.ts`), and carries only the bots it reaches:
 * its bot level here is not Off and each bot's Devices include it (`BotReachPort`). No thread switch decides them.
 */

/** How another device knows what to tell of a bot, and when to take it back (`BotEngine.feedTelling`). */
export interface BotFeedTelling {
  /** The bot's newest message in its chat, and how loudly it asked to be told (`tell`); absent for an empty chat. */
  latest?: { id: string; seq: number; author: 'owner' | 'bot'; tell?: 'now' | 'soon' | 'later' }
  /**
   * The messages past `readSeq` that ask to be told now or soon and still want the owner (an open ask, question or
   * action, or a reply not read yet), newest first, at most 20: a notification of one that leaves this list is withdrawn.
   */
  attention: BotAttention[]
}

/** One bot as another device lists it: its summary as the phone lists have it, its live chip, and its read state here. */
export type BotFeedRow = BotSummary & {
  activity?: BotChip
  /** How far the owner has read its chat, on any device: the bot's computer owns it (`bots.chat.markRead`). */
  readSeq: number
  telling: BotFeedTelling
}

/** The bots feed: every bot the reader reaches, oldest first. One snapshot per change. */
export interface BotsFeedSnapshot {
  kind: 'mousse.bots'
  version: 1
  bots: BotFeedRow[]
  /**
   * The reader's bot level here (Settings, Devices), so its window learns at once when it changes: it then asks
   * `bridge.access.mine` for the level the gate lets through. Absent from an older computer.
   */
  level?: 'use' | 'full'
}

/** One bot's chat: its row and its newest messages, as `bots.chat.list` answers another device. */
export interface BotStreamSnapshot {
  kind: 'mousse.bot'
  version: 1
  bot: BotFeedRow
  page: RemoteBotPage
}

/** A bot's stream records: a chat row added or changed, the bot's row, its live chip and its reply as it is written. */
export interface BotStreamEvents {
  'bots.message': { botId: string; message: RemoteBotMessage }
  'bots.changed': { botId: string; bot: BotFeedRow }
  'bots.activity': { botId: string; activationId: string; chip: BotChip | null; status?: string }
  /**
   * The bot's chat turn writing its reply, from the bot's home thread: the reply's text so far (`text`, assistant rows
   * only), or a new message or step there (`added`) that ends the reply shown. Display only, never stored.
   */
  'bots.reply': { botId: string; messageId: string; role: string; kind?: string; text?: string; added: boolean }
}

interface Emitter {
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
}

/** What the bot streams read of the profile's personal bots (`BotEngine`). */
export interface BotStreamsBotsPort {
  service: {
    list(): { bots: BotSummary[] }
    summary(botId: string): BotSummary
    chatList(botId: string, page?: { beforeSeq?: number; limit?: number }): ReturnType<import('../../bots/chat/BotChatService').BotChatService['chatList']>
  }
  liveActivity(botId: string): { chip?: BotChip } | undefined
  feedTelling(botId: string): BotFeedTelling & { readSeq: number }
  /** `changed`, `message` and `activity`, as `bots.changed`, `bots.message` and `bots.activity`. */
  events: Emitter
}

export interface BotStreamsServices {
  personalBots?: BotStreamsBotsPort | null
  botReach?: BotReachPort
  /** The bot's reply as its chat turn writes it comes from its home thread's messages. */
  orchestrator: Emitter
}

/** Coalesces a burst (a send changes the bot, adds a row and starts a turn) into one snapshot or one row. */
const SETTLE_MS = 40
/**
 * A live reply carries at most this much of its text, measured as it is sent (JSON-encoded, escapes included): with
 * the ids around it, well inside one delta (32 KiB).
 */
export const REPLY_BYTES = 24 * 1024

function rowOf(port: BotStreamsBotsPort, bot: BotSummary): BotFeedRow {
  const { readSeq, ...telling } = port.feedTelling(bot.id)
  const chip = port.liveActivity(bot.id)?.chip
  return { ...remoteBotSummary(bot), ...(chip ? { activity: chip } : {}), readSeq, telling }
}

/** A string's size as the delta encodes it (`canonicalJson` writes a string as `JSON.stringify` does). */
const encodedBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text))

/** Cuts text to its longest start that encodes in `REPLY_BYTES`, never through a character. */
export function clipped(text: string): string {
  if (encodedBytes(text) <= REPLY_BYTES) return text
  // Each code unit encodes in at least one byte, so the cut is within the first REPLY_BYTES of them.
  let low = 0
  let high = Math.min(text.length, REPLY_BYTES)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encodedBytes(text.slice(0, middle)) <= REPLY_BYTES) low = middle
    else high = middle - 1
  }
  const last = text.charCodeAt(low - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? low - 1 : low)
}

type Source = {
  snapshot(): unknown
  watch(listener: (event: ThreadSourceEvent) => void, onError?: (error: unknown) => void): () => void
}

/** The bots feed of `reader`: the bots it reaches, with their rows, live chips, read state and telling metadata. */
export function botsFeedSource(services: BotStreamsServices, reader: string): Source {
  const read = (): BotsFeedSnapshot => {
    const port = services.personalBots
    let bots: BotFeedRow[] = []
    if (port) {
      try {
        const hidden = services.botReach?.hiddenFor(reader)
        bots = port.service.list().bots.filter((bot) => !hidden?.(bot.id)).map((bot) => rowOf(port, bot))
      } catch {
        // Bots that can't be read are listed as none, as the lists do.
        bots = []
      }
    }
    let level: BotsFeedSnapshot['level']
    try {
      const raw = services.botReach?.level(reader)
      if (raw === 'use' || raw === 'full') level = raw
    } catch {
      // Not readable now: the reader keeps the level it has.
    }
    return { kind: 'mousse.bots', version: 1, bots, ...(level ? { level } : {}) }
  }
  return {
    snapshot: () => mmsJson(read()),
    watch: (listener, onError) => {
      let last = JSON.stringify(read())
      let pending: ReturnType<typeof setTimeout> | undefined
      let stopped = false
      const check = (): void => {
        if (stopped) return
        try {
          const next = JSON.stringify(read())
          if (next === last) return
          last = next
          listener({ snapshot: true })
        } catch (error) {
          if (onError) onError(error)
          else throw error
        }
      }
      const poke = (): void => {
        if (stopped || pending !== undefined) return
        pending = setTimeout(() => {
          pending = undefined
          check()
        }, SETTLE_MS)
      }
      const disposers: Array<() => void> = []
      const events = services.personalBots?.events
      if (events)
        for (const event of ['changed', 'message', 'activity']) {
          events.on(event, poke)
          disposers.push(() => events.off(event, poke))
        }
      // A bot's Devices, the reader's bot level, or the devices on the account changed: a bot it no longer reaches leaves.
      if (services.botReach) disposers.push(services.botReach.onChange(poke))
      return () => {
        stopped = true
        if (pending !== undefined) clearTimeout(pending)
        for (const dispose of disposers.splice(0)) dispose()
      }
    }
  }
}

/** One bot's chat for `reader`, which must reach it: its row, its newest messages, then each change as it comes. */
export function botStreamSource(services: BotStreamsServices, reader: string, botId: string): Source {
  const port = (): BotStreamsBotsPort => {
    const bots = services.personalBots
    if (!bots) throw new NetError('stream_unknown', 'This bot is gone.')
    return bots
  }
  const reached = (): void => {
    if (services.botReach && !services.botReach.canReach(botId, reader)) throw new NetError('stream_unknown', 'This bot is gone.')
  }
  const row = (): BotFeedRow => {
    const bots = port()
    let summary: BotSummary
    try {
      summary = bots.service.summary(botId)
    } catch {
      throw new NetError('stream_unknown', 'This bot is gone.')
    }
    return rowOf(bots, summary)
  }
  return {
    snapshot: () => {
      reached()
      const bot = row()
      const snapshot: BotStreamSnapshot = { kind: 'mousse.bot', version: 1, bot, page: fittedBotPage(port().service.chatList(botId), botId) }
      return mmsJson(snapshot)
    },
    watch: (listener, onError) => {
      const bots = port()
      let stopped = false
      let pending: ReturnType<typeof setTimeout> | undefined
      let last = ''
      let home: string | undefined
      try {
        const first = row()
        last = JSON.stringify(first)
        home = first.homeThreadId
      } catch {
        // Read again at the next change.
      }
      const send = (event: ThreadSourceEvent): void => {
        if (stopped) return
        try {
          listener(event)
        } catch (error) {
          if (onError) onError(error)
          else throw error
        }
      }
      const refreshRow = (): void => {
        if (stopped || pending !== undefined) return
        pending = setTimeout(() => {
          pending = undefined
          if (stopped) return
          let next: BotFeedRow
          try {
            next = row()
          } catch {
            // A bot deleted meanwhile: the bot's computer ends the stream (`BridgeProfileService`).
            return
          }
          home = next.homeThreadId ?? home
          const text = JSON.stringify(next)
          if (text === last) return
          last = text
          send({ type: 'bots.changed', data: { botId, bot: next } satisfies BotStreamEvents['bots.changed'] })
        }, SETTLE_MS)
      }
      const changed = (event: { botId?: unknown }): void => {
        if (event?.botId === botId) refreshRow()
      }
      const message = (event: { botId?: unknown; message?: BotChatMessage }): void => {
        if (event?.botId !== botId || !event.message) return
        send({ type: 'bots.message', data: { botId, message: fittedBotMessage(event.message, botId) } satisfies BotStreamEvents['bots.message'] })
        // Its unread count, last line and telling metadata move with it.
        refreshRow()
      }
      const activity = (event: { botId?: unknown; activationId?: string; chip?: BotChip | null; status?: string }): void => {
        if (event?.botId !== botId || typeof event.activationId !== 'string') return
        send({
          type: 'bots.activity',
          ephemeral: true,
          data: { botId, activationId: event.activationId, chip: event.chip ?? null, ...(event.status ? { status: event.status } : {}) } satisfies BotStreamEvents['bots.activity']
        })
      }
      const reply = (added: boolean) => (payload: { threadId?: string; message?: { id?: unknown; role?: unknown; kind?: unknown; content?: unknown; hidden?: unknown } }): void => {
        const message = payload?.message
        if (!home || payload?.threadId !== home || !message || typeof message.id !== 'string' || message.hidden === true) return
        const role = typeof message.role === 'string' ? message.role : ''
        const text = role === 'assistant' && typeof message.content === 'string' ? clipped(message.content) : undefined
        // Only what changes the reply shown: its words, or a new message or step that ends it.
        if (text === undefined && !added) return
        send({
          type: 'bots.reply',
          ephemeral: true,
          data: {
            botId,
            messageId: message.id,
            role,
            ...(typeof message.kind === 'string' ? { kind: message.kind } : {}),
            ...(text !== undefined ? { text } : {}),
            added
          } satisfies BotStreamEvents['bots.reply']
        })
      }
      const added = reply(true)
      const updated = reply(false)
      bots.events.on('changed', changed)
      bots.events.on('message', message)
      bots.events.on('activity', activity)
      services.orchestrator.on('thread-message', added)
      services.orchestrator.on('thread-message-updated', updated)
      return () => {
        stopped = true
        if (pending !== undefined) clearTimeout(pending)
        bots.events.off('changed', changed)
        bots.events.off('message', message)
        bots.events.off('activity', activity)
        services.orchestrator.off('thread-message', added)
        services.orchestrator.off('thread-message-updated', updated)
      }
    }
  }
}

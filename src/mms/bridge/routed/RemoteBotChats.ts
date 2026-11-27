import { NetError, newId, type NetErrorCode, type NodeId, type StreamDescriptor } from '../../../shared/net'
import type { BridgeHub } from '../hub'
import type { BridgeClient } from '../peers'
import { privateRecordSubject } from '../remote/privateStreams'
import type { BotFeedRow, BotStreamEvents } from '../remote/BotStreamSources'
import type { RemoteBotMessage } from '../remote/RemoteBots'
import type { SqliteRemoteBots } from './remoteBotStore'

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

/** A chat row as the copy takes it: an object with an id and a sequence, nothing else checked here. */
const isMessage = (value: unknown): value is RemoteBotMessage =>
  isRecord(value) && typeof value.id === 'string' && value.id !== '' && Number.isSafeInteger(value.seq)

/** What a bot's chat stream ending with says: the bot's computer no longer lets this one reach the bot. */
export const LOST_BOT_CODES: ReadonlySet<string> = new Set(['forbidden', 'stream_unknown'])

/** What a window showing a remote bot's chat hears while it is open. */
export interface RemoteBotChatListener {
  /** The copy changed: the chat's snapshot came, or a message was added or changed. Read it with `messages`. */
  changed?(): void
  /** The bot's row, from its chat stream. */
  row?(bot: BotFeedRow): void
  /** A display-only note (`bots.activity`, `bots.reply`): shown, never kept. */
  delta?(type: string, data: unknown): void
  /** The chat stream ended (`code`); the copy stays unless the bot was lost. */
  ended?(code: string): void
}

export interface RemoteBotChatsOptions {
  hub: Pick<BridgeHub, 'attach' | 'dropCopy'>
  /** A client for calls to `node`, on the transport it is reached by (`PeerDirectory.client`). */
  client(node: NodeId): Pick<BridgeClient, 'rpc'>
  store: SqliteRemoteBots
  /** Whether a chat of `botId` may be opened now: its computer lists it, is reached, and did not refuse this one. */
  openable(node: NodeId, botId: string): boolean
  /** The bot's computer ended its chat because this computer no longer reaches the bot. */
  lost(node: NodeId, botId: string): void
  /** Best effort writes say what failed, once until they work again. */
  safely<T>(what: string, work: () => T): T | undefined
}

interface OpenChat {
  node: NodeId
  botId: string
  listeners: Set<RemoteBotChatListener>
  handle?: { close(): void }
  attaching?: Promise<void>
}

const keyOf = (node: NodeId, botId: string): string => `${node}\u0000${botId}`

/** The subject the records of a bot's chat stream carry (`privateRecordSubject` on the bot's computer). */
export const botChatSubject = (botId: string): string => privateRecordSubject({ reader: '' as NodeId, kind: 'bot', subject: botId })

/**
 * The bounded copy of the chats of other computers' bots, for reading one while its computer is offline. A chat is
 * filled from its stream (`bridge.bot.open`) while it is open here: the stream's snapshot takes the place of the copy,
 * then each message added or changed is written. Display-only notes are passed to the window and never written. The
 * copy holds the newest messages of each bot, within the caps of `REMOTE_BOT_COPY_LIMITS`, and goes with the bot when
 * this computer loses it (`lose`).
 */
export class RemoteBotChats {
  private readonly chats = new Map<string, OpenChat>()
  private closed = false

  constructor(private readonly options: RemoteBotChatsOptions) {}

  /** The copy of a bot's chat, oldest first: what was last received, whether its computer is reached or not. */
  messages(node: NodeId, botId: string): RemoteBotMessage[] {
    return this.options.safely('read a bot chat copy', () => this.options.store.messages(node, botId)) ?? []
  }

  /** The chats open here now, for the tests and the Devices screens. */
  openChats(): Array<{ node: NodeId; botId: string; attached: boolean }> {
    return [...this.chats.values()].map((chat) => ({ node: chat.node, botId: chat.botId, attached: !!chat.handle }))
  }

  /**
   * Opens a bot's chat stream on its computer and keeps the copy filled while `listener` holds it. A chat already open
   * here takes the listener alongside the others. Refused with `peer_offline` when the bot can't be reached now, and
   * `stream_unknown` when it is not listed.
   */
  async open(node: NodeId, botId: string, listener: RemoteBotChatListener = {}): Promise<{ close(): void }> {
    if (this.closed) throw new NetError('cancelled')
    if (!this.options.openable(node, botId)) throw new NetError('peer_offline')
    const key = keyOf(node, botId)
    let chat = this.chats.get(key)
    if (!chat) {
      chat = { node, botId, listeners: new Set() }
      this.chats.set(key, chat)
    }
    chat.listeners.add(listener)
    const release = { close: () => this.release(chat!, listener) }
    if (chat.handle) return release
    try {
      await (chat.attaching ??= this.attach(chat).finally(() => {
        chat!.attaching = undefined
      }))
    } catch (error) {
      this.release(chat, listener)
      throw error
    }
    return release
  }

  private async attach(chat: OpenChat): Promise<void> {
    const { node, botId } = chat
    const handle = await this.options.hub.attach(
      { nodeId: node, entityId: botChatSubject(botId) },
      (update) => {
        if (update.kind === 'snapshot') this.snapshot(chat, update.value)
        else this.event(chat, update.type, update.data)
      },
      (code) => this.ended(chat, code),
      this.streamOptions(node, botId),
      // Display only: passed on as it comes, never written.
      (type, data) => this.each(chat, (listener) => listener.delta?.(type, data))
    )
    if (this.closed || this.chats.get(keyOf(node, botId)) !== chat || !chat.listeners.size) {
      handle.close()
      return
    }
    chat.handle = handle
  }

  /** How a bot's chat stream is attached: in the bots' own room, opened by asking the bot's computer. */
  private streamOptions(node: NodeId, botId: string) {
    return {
      room: 'bots' as const,
      open: async () => {
        const opened = await this.options.client(node).rpc('bridge.bot.open', { botId }, { id: newId('rpc'), deadlineMs: 30_000 })
        const { descriptor, head } = (isRecord(opened) ? opened : {}) as { descriptor?: StreamDescriptor; head?: { epoch: number; seq: number } }
        return { descriptor: descriptor as StreamDescriptor, head: head as { epoch: number; seq: number } }
      }
    }
  }

  private snapshot(chat: OpenChat, value: unknown): void {
    if (!isRecord(value) || value.kind !== 'mousse.bot' || !isRecord(value.page) || !Array.isArray(value.page.messages)) return
    const messages = value.page.messages.filter(isMessage)
    this.options.safely('copy a bot chat', () => this.options.store.replaceChat(chat.node, chat.botId, messages))
    if (isRecord(value.bot)) this.each(chat, (listener) => listener.row?.(value.bot as unknown as BotFeedRow))
    this.each(chat, (listener) => listener.changed?.())
  }

  private event(chat: OpenChat, type: string, data: unknown): void {
    if (!isRecord(data) || data.botId !== chat.botId) return
    if (type === 'bots.message') {
      const { message } = data as unknown as BotStreamEvents['bots.message']
      if (!isMessage(message)) return
      this.options.safely('copy a bot chat message', () => this.options.store.putMessage(chat.node, chat.botId, message))
      this.each(chat, (listener) => listener.changed?.())
    } else if (type === 'bots.changed' && isRecord(data.bot)) {
      this.each(chat, (listener) => listener.row?.(data.bot as unknown as BotFeedRow))
    }
  }

  private ended(chat: OpenChat, code: NetErrorCode | string): void {
    chat.handle = undefined
    if (this.chats.get(keyOf(chat.node, chat.botId)) === chat) this.chats.delete(keyOf(chat.node, chat.botId))
    this.each(chat, (listener) => listener.ended?.(code))
    chat.listeners.clear()
    // The bot's computer no longer lets this one reach the bot (or the bot is gone): the row and the copy go with it.
    if (LOST_BOT_CODES.has(code)) this.options.lost(chat.node, chat.botId)
  }

  private each(chat: OpenChat, call: (listener: RemoteBotChatListener) => void): void {
    for (const listener of [...chat.listeners]) {
      try {
        call(listener)
      } catch {
        // One window's failure does not keep the others from hearing.
      }
    }
  }

  private release(chat: OpenChat, listener: RemoteBotChatListener): void {
    chat.listeners.delete(listener)
    if (chat.listeners.size) return
    if (this.chats.get(keyOf(chat.node, chat.botId)) === chat) this.chats.delete(keyOf(chat.node, chat.botId))
    const handle = chat.handle
    chat.handle = undefined
    handle?.close()
  }

  /**
   * This computer lost the bot (its computer dropped it from the feed or refused this one): its open chat ends, and
   * its copy goes at once, with the copy of its stream the Bridge kept. Nothing of the chat is left on disk.
   */
  lose(node: NodeId, botIds: Iterable<string>): void {
    for (const botId of botIds) {
      const chat = this.chats.get(keyOf(node, botId))
      if (chat) {
        this.chats.delete(keyOf(node, botId))
        const handle = chat.handle
        chat.handle = undefined
        handle?.close()
        this.each(chat, (listener) => listener.ended?.('stream_unknown'))
        chat.listeners.clear()
      }
      this.options.safely('drop a bot chat copy', () => this.options.store.dropChat(node, botId))
      void this.options.hub
        .dropCopy({ nodeId: node, entityId: botChatSubject(botId) }, this.streamOptions(node, botId))
        .catch(() => false)
    }
  }

  /** Every chat of `node` that is open here ends: its computer went out of reach. The copies stay. */
  detachComputer(node: NodeId): void {
    for (const chat of [...this.chats.values()]) {
      if (chat.node !== node) continue
      this.chats.delete(keyOf(chat.node, chat.botId))
      const handle = chat.handle
      chat.handle = undefined
      handle?.close()
      this.each(chat, (listener) => listener.ended?.('peer_offline'))
      chat.listeners.clear()
    }
  }

  close(): void {
    this.closed = true
    for (const chat of this.chats.values()) {
      const handle = chat.handle
      chat.handle = undefined
      handle?.close()
    }
    this.chats.clear()
  }
}

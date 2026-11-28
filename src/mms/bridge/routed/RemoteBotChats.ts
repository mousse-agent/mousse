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

/** The errors the bot's computer itself answered an open with, as opposed to this computer's own checks. */
const ownerAnswers = new WeakSet<object>()

/** Runs a call to the bot's computer, marking what it answers with as its answer. */
export async function askOwner<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error && typeof error === 'object') ownerAnswers.add(error)
    throw error
  }
}

/**
 * What the bot's computer said when asked to open a bots stream: `refused` when it does not let this one reach its
 * bots (`forbidden`, with its reason such as `bots_off`, or a blocked computer), `gone` when the bot is not there or not
 * reachable by this one (`stream_unknown`: the owner answers both the same, word for word). Undefined for anything
 * else, and for every error this computer raised itself (the Bridge's checks of its copy, a dropped session): those
 * never lose a bot.
 */
export function ownerSaid(error: unknown): 'refused' | 'gone' | undefined {
  if (!error || typeof error !== 'object' || !ownerAnswers.has(error)) return undefined
  const code = (error as { code?: unknown }).code
  if (code === 'forbidden' || code === 'computer_forbidden') return 'refused'
  if (code === 'stream_unknown') return 'gone'
  return undefined
}

/**
 * How a stream that ended for a passing reason ends: the session went, a deadline, a full room. Any other end while
 * the computer is reached (the Bridge's copy no longer checks, or the bot's computer closed the stream) drops the
 * Bridge's copy of the stream; whether the bots are still reached is the computer's answer to the next open, never the
 * bare code of the end, which this computer's own checks raise too.
 */
export const PASSING_END_CODES: ReadonlySet<string> = new Set(['cancelled', 'peer_offline', 'computer_offline', 'deadline_exceeded', 'rate_limited'])

/** What a window showing a remote bot's chat hears while it is open. */
export interface RemoteBotChatListener {
  /** The copy changed: the chat's snapshot came, or a message was added or changed. Read it with `messages`. */
  changed?(): void
  /**
   * The chat's snapshot came (after `changed`): its newest messages as the bot's computer has them now, which may hold
   * some the stream did not carry while it was closed.
   */
  snapshot?(): void
  /** A message was added or changed, as the stream carried it (after `changed`). */
  message?(message: RemoteBotMessage): void
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
  /** The bot's computer refused to open its chat: this computer no longer reaches the bot. */
  lost(node: NodeId, botId: string): void
  /** Whether `node` is reached now. */
  online(node: NodeId): boolean
  /**
   * The Bridge's copy of these chats' streams is to be reset (the chat's copy went to keep the total, or the stream
   * ended in a way that leaves the copy in doubt). The caller keeps it until it is done.
   */
  resetStreamCopies(node: NodeId, botIds: readonly string[]): void
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
      // The bot's computer said no to this bot: its row and copy go. The Bridge's own failures lose nothing.
      if (ownerSaid(error)) this.options.lost(node, botId)
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
        const opened = await askOwner(() => this.options.client(node).rpc('bridge.bot.open', { botId }, { id: newId('rpc'), deadlineMs: 30_000 }))
        const { descriptor, head } = (isRecord(opened) ? opened : {}) as { descriptor?: StreamDescriptor; head?: { epoch: number; seq: number } }
        return { descriptor: descriptor as StreamDescriptor, head: head as { epoch: number; seq: number } }
      }
    }
  }

  private snapshot(chat: OpenChat, value: unknown): void {
    if (!isRecord(value) || value.kind !== 'mousse.bot' || !isRecord(value.page) || !Array.isArray(value.page.messages)) return
    const messages = value.page.messages.filter(isMessage)
    this.trimmed(this.options.safely('copy a bot chat',() => this.options.store.replaceChat(chat.node, chat.botId, messages, this.kept())))
    if (isRecord(value.bot)) this.each(chat, (listener) => listener.row?.(value.bot as unknown as BotFeedRow))
    this.each(chat, (listener) => listener.changed?.())
    this.each(chat, (listener) => listener.snapshot?.())
  }

  private event(chat: OpenChat, type: string, data: unknown): void {
    if (!isRecord(data) || data.botId !== chat.botId) return
    if (type === 'bots.message') {
      const { message } = data as unknown as BotStreamEvents['bots.message']
      if (!isMessage(message)) return
      this.trimmed(this.options.safely('copy a bot chat message', () => this.options.store.putMessage(chat.node, chat.botId, message, this.kept())))
      this.each(chat, (listener) => listener.changed?.())
      this.each(chat, (listener) => listener.message?.(message))
    } else if (type === 'bots.changed' && isRecord(data.bot)) {
      this.each(chat, (listener) => listener.row?.(data.bot as unknown as BotFeedRow))
    }
  }

  /** The chats open here, which the total cap never takes. */
  private kept(): Array<{ node: NodeId; bot: string }> {
    return [...this.chats.values()].map((chat) => ({ node: chat.node, bot: chat.botId }))
  }

  /** Chats the total cap took from the copy: the Bridge's copy of their streams goes too, so the cap holds on disk. */
  private trimmed(dropped: Array<{ node: NodeId; bot: string }> | undefined): void {
    const byNode = new Map<NodeId, string[]>()
    for (const each of dropped ?? []) byNode.set(each.node, [...(byNode.get(each.node) ?? []), each.bot])
    for (const [other, bots] of byNode) this.options.resetStreamCopies(other, bots)
  }

  /**
   * The chat stream ended. The copy stays: a bot is lost only when its computer says so, by its feed or by refusing
   * the next open, never on the bare code of an end, which this computer's own checks raise too. An end for a passing
   * reason keeps the Bridge's copy of the stream; any other, while the computer is reached, resets it.
   */
  private ended(chat: OpenChat, code: NetErrorCode | string): void {
    chat.handle = undefined
    if (this.chats.get(keyOf(chat.node, chat.botId)) === chat) this.chats.delete(keyOf(chat.node, chat.botId))
    this.each(chat, (listener) => listener.ended?.(code))
    chat.listeners.clear()
    if (!PASSING_END_CODES.has(code) && this.options.online(chat.node)) this.options.resetStreamCopies(chat.node, [chat.botId])
  }

  /** Resets the Bridge's copy of a bot chat's stream (the next open reads it fresh). */
  dropStreamCopy(node: NodeId, botId: string): Promise<boolean> {
    return this.options.hub.dropCopy({ nodeId: node, entityId: botChatSubject(botId) }, this.streamOptions(node, botId))
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
   * This computer lost the bot (its computer dropped it from the feed or refused this one): its open chat ends. The
   * copies, on disk and the Bridge's, are dropped by the caller (`RemoteBotRegistry`), which tries again until they go.
   */
  lose(node: NodeId, botIds: Iterable<string>): void {
    for (const botId of botIds) {
      const chat = this.chats.get(keyOf(node, botId))
      if (!chat) continue
      this.chats.delete(keyOf(node, botId))
      const handle = chat.handle
      chat.handle = undefined
      handle?.close()
      this.each(chat, (listener) => listener.ended?.('stream_unknown'))
      chat.listeners.clear()
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

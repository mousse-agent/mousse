import { BOT_METHODS, type BotMethod, type BotMethodRow } from '../../../shared/bots/personal/methodTable'
import { isId, type NodeId } from '../../../shared/net'
import { parseQualifiedId } from '../../../shared/threadRef'
import { DomainRpcError } from '../../protocol/domainRegistry'
import type { HandlerContext } from '../../protocol/handlers'
import type { BotRouterPort } from '../../protocol/botRouterPort'
import type { RemoteBotMessage } from '../remote/RemoteBots'
import { AttachedBots, type AttachedBotEvent } from './attachedBots'
import { qualifyBotResult } from './botIds'
import { computerOffline, notAvailableRemotely, type ComputerRef } from './computerErrors'
import type { RemoteBotRegistry, RemoteBotRow } from './RemoteBotRegistry'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import type { RoutedClient } from './RoutedClient'

/** How long a read that has a copy here waits for the bot's computer before it answers from the copy, marked stale. */
const READ_WAIT_MS = 4_000
/** Keys a window sends that name this computer's own binding; the bot's computer has its own. */
const LOCAL_BINDING_KEYS = new Set(['profileId', 'expectedProfileId'])

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const rowOf = (method: string): BotMethodRow | undefined =>
  Object.hasOwn(BOT_METHODS, method) ? (BOT_METHODS[method as BotMethod] as BotMethodRow) : undefined

/** A listed bot of another computer as a window's Bots list has it: its summary, and where it lives. */
function windowRow(row: RemoteBotRow): BotSummary {
  // What the feed adds for telling and reading is the viewing computer's own business, not the window's.
  const { botId: _botId, node, computerName, offline, readSeq: _readSeq, telling: _telling, activity: _activity, id, ...summary } = row
  return { ...(qualifyBotResult(node, summary) as Omit<BotSummary, 'id'>), id, lives: { node, name: computerName, ...(offline ? { offline } : {}) } }
}

export interface BotRouterOptions {
  /** Calls to other computers, on the transport their threads use (`ThreadRouter.client`). */
  client: Pick<RoutedClient, 'callBot'>
  /** The other computers' bots as this one lists them, with the copies of their chats. */
  registry: Pick<RemoteBotRegistry, 'row' | 'rows' | 'onChange'> & { chats: Pick<RemoteBotRegistry['chats'], 'open' | 'messages'> }
  /** Whether a session with `node` is open now. */
  online(node: NodeId): boolean
  /** The name a person knows `node` by. */
  name(node: NodeId): string
  self(): string | undefined
  /** Whether Bridge is on: bots of other computers are reached at all. */
  enabled(): boolean
  /** Tells this computer's windows what a bot's chat in view says. */
  emit(type: AttachedBotEvent, data: Record<string, unknown>): void
  /** Hears when a window's connection closes, so its chats in view are let go. */
  onConnectionClosed?(listener: (id: string) => void): () => void
  /** Tests make the wait for a read shorter. */
  readWaitMs?: number
}

/**
 * Sends a window's call about a bot of another of the user's computers to the computer it lives on, and brings back
 * what that computer answers, named as this computer names it.
 *
 * A call names its bot by a qualified id (`<node>:<botId>`), or names a computer and no bot (`node`, for `bots.create`
 * and New bot's choices). It is sent as that computer's own remote bot method (`remoteBotMethods`), which holds it to
 * the gate every other device meets there: the device's bot level, the bot's Devices, and for a chat turn the device's
 * thread ceiling. This side never decides what a device may do; it only refuses what can't go at all:
 *
 * - Only a window routes (`gui`). The command line, agents and bots of this computer never reach another computer's
 *   bot through this daemon, and are refused.
 * - A row the bot's computer keeps to its own window (`local`), or does not offer other devices yet (no `remote`), is
 *   refused here without asking.
 * - A plain id is this computer's bot: the call is not routed.
 * - A write to a computer that is not reached now fails at once with `computer_offline`; nothing is kept to send later.
 *   A write whose reply is lost is found again by the same request id (`RoutedClient.callBot`), never run twice.
 * - A read of a bot's chat waits at most four seconds, then answers from the copy kept here (`RemoteBotChats`),
 *   marked `stale`; other reads of a computer that is not reached fail at once.
 *
 * Nothing here is on a thread's or a turn's start, and a bot call takes none of the slots of large thread reads.
 */
export class BotRouter implements BotRouterPort {
  readonly attached: AttachedBots
  /** Window bindings whose end is already watched. */
  private readonly watched = new WeakSet<AbortSignal>()
  private readonly offClosed?: () => void

  constructor(private readonly options: BotRouterOptions) {
    this.attached = new AttachedBots({
      chats: options.registry.chats,
      openable: (node, botId) => {
        const row = options.registry.row(node, botId)
        return !!row && !row.offline && options.online(node) && options.enabled()
      },
      onChange: (listener) => options.registry.onChange(listener),
      emit: options.emit
    })
    this.offClosed = options.onConnectionClosed?.((id) => this.attached.dropLeases(id))
  }

  computer(node: NodeId): ComputerRef {
    return { node, name: this.options.name(node) }
  }

  /**
   * The other computers' bots as a window lists them beside this computer's own: each summary under its qualified id,
   * its threads named as this computer names them, and the computer it lives on (`lives`), offline while that computer
   * can't be reached. Read from memory and the copy on disk; it never waits on another computer.
   */
  list(ctx: HandlerContext): BotSummary[] {
    if (ctx.connection?.clientType !== 'gui' || ctx.connection.bridgeCaller)
      throw new DomainRpcError('forbidden', 'Only a Mousse window can list the bots of other computers.')
    return this.options.registry.rows().map(windowRow)
  }

  async dispatch(ctx: HandlerContext, method: string, params: unknown): Promise<{ result: unknown } | undefined> {
    const row = rowOf(method)
    if (!row || !isRecord(params)) return undefined
    const ref = parseQualifiedId(params.botId)
    const target = params.node
    // A plain id, and no computer named: this computer's bot.
    if (!ref && target === undefined) return undefined
    if (target !== undefined && (typeof target !== 'string' || !isId('node', target)))
      throw new DomainRpcError('invalid_params', 'node is not a computer.')
    if (ref && target !== undefined && target !== ref.node)
      throw new DomainRpcError('invalid_params', 'A bot lives on one computer: name it by its id alone.')
    const node = (ref?.node ?? target) as NodeId
    const computer = this.computer(node)
    if (!this.options.enabled()) throw computerOffline(computer)
    // Only a window routes. The CLI and the agents' shells reach the daemon as other kinds of connection.
    if (ctx.connection?.clientType !== 'gui' || ctx.connection.bridgeCaller)
      throw new DomainRpcError('forbidden', 'Only a Mousse window can use a bot of another computer.')
    if (node === this.selfNode())
      throw new DomainRpcError('invalid_params', 'That bot is on this computer. Use its own id.')
    // Kept to the bot's own computer (a `local` row has no `remote`), or not offered to other devices yet: never asked.
    if (!row.remote) throw notAvailableRemotely(computer, method)
    const owner = this.ownerParams(method, row.remote, params, ref?.id)
    const write = row.remote.mutating
    // Nothing is kept here to send later: the client refuses a call to a computer it does not reach at once.
    const signal = ctx.connection.lifetime
    if (method === 'bots.chat.list' && ref) return { result: await this.chatList(node, ref.id, owner, signal) }
    const raw = await this.options.client.callBot(node, method, owner, {
      write,
      ...(write && typeof params.clientRequestId === 'string' && params.clientRequestId ? { idem: params.clientRequestId } : {}),
      ...(signal ? { signal } : {})
    })
    return { result: qualifyBotResult(node, raw) }
  }

  /** What the bot's computer is asked: its own bot id, and only the keys its row takes from another device. */
  private ownerParams(
    method: string,
    remote: NonNullable<BotMethodRow['remote']>,
    given: Record<string, unknown>,
    botId: string | undefined
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const takes = new Set([...remote.required, ...(remote.optional ?? [])])
    for (const [key, value] of Object.entries(given)) {
      if (value === undefined || key === 'node' || LOCAL_BINDING_KEYS.has(key)) continue
      if (!takes.has(key)) throw new DomainRpcError('invalid_params', `${method} does not take ${key} for a bot on another computer.`)
      out[key] = key === 'botId' ? botId : value
    }
    const missing = remote.required.find((key) => out[key] === undefined)
    if (missing) throw new DomainRpcError('invalid_params', `${method} needs ${missing}.`)
    return out
  }

  /** A bot's chat: from its computer, or from the copy here if that computer does not answer within a few seconds. */
  private async chatList(node: NodeId, botId: string, owner: Record<string, unknown>, lifetime?: AbortSignal): Promise<unknown> {
    const wait = AbortSignal.timeout(this.options.readWaitMs ?? READ_WAIT_MS)
    try {
      const raw = await this.options.client.callBot(node, 'bots.chat.list', owner, {
        write: false,
        signal: lifetime ? AbortSignal.any([lifetime, wait]) : wait
      })
      return qualifyBotResult(node, raw)
    } catch (error) {
      const code = error instanceof DomainRpcError ? error.code : undefined
      const away = code === 'computer_offline' || code === 'deadline_exceeded' || (code === 'cancelled' && wait.aborted)
      const copy = away && !lifetime?.aborted ? this.fromCopy(node, botId, owner) : undefined
      if (copy) return copy
      throw error
    }
  }

  /** The chat as last copied here, marked `stale`; undefined for a bot this computer does not list. */
  private fromCopy(node: NodeId, botId: string, owner: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!this.options.registry.row(node, botId)) return undefined
    let messages: RemoteBotMessage[] = this.options.registry.chats.messages(node, botId)
    if (typeof owner.beforeSeq === 'number') messages = messages.filter((message) => message.seq < (owner.beforeSeq as number))
    if (typeof owner.limit === 'number') messages = messages.slice(-owner.limit)
    return { messages: qualifyBotResult(node, messages), stale: true }
  }

  async focus(ctx: HandlerContext, botId: string, focused: boolean): Promise<{ routed: boolean; focused: boolean }> {
    const ref = parseQualifiedId(botId)
    if (!ref || !this.options.enabled()) return { routed: false, focused: false }
    if (ctx.connection?.clientType !== 'gui' || ctx.connection.bridgeCaller)
      throw new DomainRpcError('forbidden', 'Only a Mousse window can use a bot of another computer.')
    if (ref.node === this.selfNode()) throw new DomainRpcError('invalid_params', 'That bot is on this computer. Use its own id.')
    const lease = ctx.connection.id
    const node = ref.node as NodeId
    if (!focused) {
      this.attached.unfocus(lease, node, ref.id)
      return { routed: true, focused: false }
    }
    // The lease ends with the window's binding: a window that closes or switches profile lets go of what it showed.
    const lifetime = ctx.connection.lifetime
    if (lifetime) {
      if (lifetime.aborted) return { routed: true, focused: false }
      if (!this.watched.has(lifetime)) {
        this.watched.add(lifetime)
        lifetime.addEventListener('abort', () => this.attached.dropLeases(lease), { once: true })
      }
    }
    await this.attached.focus(lease, node, ref.id)
    return { routed: true, focused: true }
  }

  private selfNode(): string | undefined {
    try {
      return this.options.self()
    } catch {
      return undefined
    }
  }

  close(): void {
    this.offClosed?.()
    this.attached.close()
  }
}

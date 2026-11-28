import type { NodeId } from '../../../shared/net'
import { qualifyId } from '../../../shared/threadRef'
import type { RemoteBotChatListener, RemoteBotChats } from './RemoteBotChats'
import { qualifyBotResult } from './botIds'

/** The events a window hears of a bot of another computer while it shows its chat, named as this computer names it. */
export type AttachedBotEvent = 'bots.message' | 'bots.changed' | 'bots.activity'

export interface AttachedBotsOptions {
  chats: Pick<RemoteBotChats, 'open'>
  /** Whether the bot is listed here and its computer reached now, so its chat stream can be opened. */
  openable(node: NodeId, botId: string): boolean
  /** Hears when the listed bots change: a feed arrived, a computer came back or went. */
  onChange(listener: () => void): () => void
  /** Tells this computer's windows. */
  emit(type: AttachedBotEvent, data: Record<string, unknown>): void
}

interface Held {
  node: NodeId
  botId: string
  qualified: string
  /** The windows that show it now, by connection. */
  leases: Set<string>
  handle?: { close(): void }
  opening?: Promise<void>
}

const keyOf = (node: NodeId, botId: string): string => `${node}\u0000${botId}`
/** How soon a chat whose stream ended is opened again, if it is still shown, listed and reached. */
const REOPEN_MS = 1_000

/**
 * The chats of other computers' bots that this computer's windows have in view. A bot's chat stream (`bridge.bot.open`,
 * through `RemoteBotChats`) is open while at least one window shows the chat, and closed when the last one lets go or
 * goes away, so the bot's computer sends it only while it is looked at. A chat that can't be opened now (its computer
 * is away, its feed has not listed it yet) keeps its windows' leases and opens when the listed bots change.
 */
export class AttachedBots {
  private readonly held = new Map<string, Held>()
  private readonly byLease = new Map<string, Set<string>>()
  private readonly offChange: () => void
  private closed = false

  constructor(private readonly options: AttachedBotsOptions) {
    this.offChange = options.onChange(() => this.reopen())
  }

  /** A window shows the chat of `botId` on `node`. Resolves once its stream is open, or can't be now. */
  async focus(lease: string, node: NodeId, botId: string): Promise<void> {
    if (this.closed) return
    const key = keyOf(node, botId)
    let held = this.held.get(key)
    if (!held) this.held.set(key, (held = { node, botId, qualified: qualifyId(node, botId), leases: new Set() }))
    held.leases.add(lease)
    let leased = this.byLease.get(lease)
    if (!leased) this.byLease.set(lease, (leased = new Set()))
    leased.add(key)
    await this.open(held)
  }

  /** A window no longer shows it: the stream closes when no window does. */
  unfocus(lease: string, node: NodeId, botId: string): void {
    const key = keyOf(node, botId)
    const leased = this.byLease.get(lease)
    leased?.delete(key)
    if (leased && !leased.size) this.byLease.delete(lease)
    const held = this.held.get(key)
    if (!held) return
    held.leases.delete(lease)
    this.release(held)
  }

  /** The window is gone: every chat it showed is let go. */
  dropLeases(lease: string): void {
    const leased = this.byLease.get(lease)
    if (!leased) return
    this.byLease.delete(lease)
    for (const key of leased) {
      const held = this.held.get(key)
      if (!held) continue
      held.leases.delete(lease)
      this.release(held)
    }
  }

  /** The chats in view, for the tests and the device screens. */
  state(): Array<{ node: NodeId; botId: string; windows: number; open: boolean }> {
    return [...this.held.values()].map((held) => ({ node: held.node, botId: held.botId, windows: held.leases.size, open: !!held.handle }))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.offChange()
    for (const held of this.held.values()) {
      const handle = held.handle
      held.handle = undefined
      handle?.close()
    }
    this.held.clear()
    this.byLease.clear()
  }

  private release(held: Held): void {
    if (held.leases.size) return
    this.held.delete(keyOf(held.node, held.botId))
    const handle = held.handle
    held.handle = undefined
    handle?.close()
  }

  /** Opens what windows show and is not open: the listed bots changed, so some may be reachable now. */
  private reopen(): void {
    for (const held of this.held.values()) if (!held.handle && !held.opening) void this.open(held)
  }

  private open(held: Held): Promise<void> {
    if (this.closed || held.handle || !held.leases.size) return Promise.resolve()
    if (held.opening) return held.opening
    if (!this.options.openable(held.node, held.botId)) return Promise.resolve()
    held.opening = this.options.chats
      .open(held.node, held.botId, this.listener(held))
      .then((handle) => {
        // Let go of meanwhile: the stream closes again at once.
        if (this.closed || !held.leases.size || this.held.get(keyOf(held.node, held.botId)) !== held) handle.close()
        else held.handle = handle
      })
      // Away, or lost: the lease stays, and the next change of the listed bots tries again if it is listed.
      .catch(() => undefined)
      .finally(() => {
        held.opening = undefined
      })
    return held.opening
  }

  private listener(held: Held): RemoteBotChatListener {
    const { node, qualified } = held
    return {
      message: (message) => this.options.emit('bots.message', { botId: qualified, message: qualifyBotResult(node, message) as Record<string, unknown> }),
      row: (bot) => this.options.emit('bots.changed', { botId: qualified, bot: qualifyBotResult(node, { ...bot, id: qualified }) as Record<string, unknown> }),
      delta: (type, data) => {
        if (type === 'bots.activity' && data && typeof data === 'object' && !Array.isArray(data))
          this.options.emit('bots.activity', { ...(data as Record<string, unknown>), botId: qualified })
      },
      // The stream ended; the windows' leases stay, and it opens again when the bot is listed and reached.
      ended: () => {
        held.handle = undefined
        if (this.closed || !held.leases.size) return
        const again = setTimeout(() => this.reopen(), REOPEN_MS)
        again.unref?.()
      }
    }
  }
}

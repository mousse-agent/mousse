import { NetError, type NodeId } from '../../../shared/net'
import { botLevelReaches, type BotLevel } from '../../../shared/net/local'
import type { BotBrowserAck, BotBrowserFrameEvent, BotBrowserHold, BotBrowserHoldRequest, BotBrowserSent, BotBrowserView } from '../../../shared/bots/personal/browser'
import { isBotId } from '../../bots/definitions/BotDefinitionStore'
import { isCount, isWatchId } from '../../browser/viewer/watchedParams'
import type { BotBrowsers } from '../../bots/browser/BotBrowsers'
import type { BotReachPort } from '../../protocol/botReachPort'
import { Channel, toWireError, type EngineStream } from '../../netEngine/session/transport'
import type { EngineMessage } from '../../netEngine/session/frame'

/**
 * A bot's browser as the user's other computers see it (`docs/plans/remote-bots.md`, live view): its pictures on one
 * `mousse.botview` stream per view, and its state, takeover and input through the remote rows (`bots.browser.*`).
 *
 * - Watching needs Use, and the bot within the device's reach; taking over and input need Full. Both are read on every
 *   watch renewal and every call, and a device that loses them loses the view (the stream is reset `forbidden`) and its
 *   hold (it ends as if its lease ran out) at once (`reconcile`).
 * - Pictures go under the stream's credit: the next is written only once the last has left (`Channel.drained`), and the
 *   browser's own latest-wins slot (`WatchedBrowser`) drops the ones in between. Nothing is stored or sent again.
 * - A remote view is small: at most `REMOTE_VIEW_MAX_WIDTH` pixels wide and `REMOTE_VIEW_MAX_FPS` pictures a second
 *   (about 60 KB a picture at 5 a second), and it never lays the bot's page out at its own size.
 */

/** The widest picture another computer is sent. */
export const REMOTE_VIEW_MAX_WIDTH = 1280
/** The most pictures a second another computer is sent. */
export const REMOTE_VIEW_MAX_FPS = 5
/** One part of a picture on the stream: under one engine message (64 KiB) with its header. */
export const REMOTE_VIEW_PART_BYTES = 48 * 1024

/** A watch, sent first on a view's stream and again to renew it (or change its size). */
export interface BotViewWatch {
  t: 'watch'
  botId: string
  watchId: string
  width: number
  fps: number
  viewId?: string
}

/** The bot's computer's messages on a view's stream. */
export type BotViewMessage =
  /** The answer to each watch: the browser's state. */
  | { t: 'view'; browser: BotBrowserView }
  /** A watch refused; the stream ends after it. */
  | { t: 'error'; error: ReturnType<typeof toWireError> }
  /** An update; with a picture, its bytes come in `pieces` messages (this one carries the first). */
  | { t: 'update'; event: Omit<BotBrowserFrameEvent, 'botId' | 'frame'> & { frame?: Omit<NonNullable<BotBrowserFrameEvent['frame']>, 'data'> }; pieces?: number }
  /** The next part of a picture. */
  | { t: 'part' }

/** What another computer's calls and views use of the bots' browsers. */
export type RemoteBrowsersPort = Pick<BotBrowsers, 'view' | 'watch' | 'unwatch' | 'hold' | 'send' | 'open' | 'endHoldsOf'>

/** What a view counted: pictures, their bytes, and how long it ran. */
export interface BotViewCount {
  frames: number
  bytes: number
  ms: number
}

interface View {
  node: string
  channel: Channel
  connectionId: string
  botId?: string
  watchId?: string
  ended: boolean
  /** Ends the browser's watch with the stream. */
  lifetime: AbortController
  startedAt: number
  frames: number
  bytes: number
}

export class RemoteBotBrowsers {
  private readonly views = new Set<View>()
  /** The devices that took a bot's browser over, by node, with the bots they took. */
  private readonly holders = new Map<string, Set<string>>()
  private serial = 0
  private readonly offReach?: () => void

  constructor(private readonly options: {
    browsers(): RemoteBrowsersPort | undefined
    /** Whether the bot is there; throws when it is not. */
    bot(botId: string): void
    reach?: Pick<BotReachPort, 'level' | 'canReach'> & Partial<Pick<BotReachPort, 'onChange'>>
    now?(): number
    /** Each view's count when it ends (the real check's numbers). */
    counted?(count: BotViewCount): void
  }) {
    this.offReach = options.reach?.onChange?.(() => this.reconcile())
  }

  private level(node: string): BotLevel {
    try {
      return this.options.reach?.level(node) ?? 'full'
    } catch {
      return 'off'
    }
  }

  private allowed(node: string, botId: string, level: 'use' | 'full'): boolean {
    if (!this.options.reach) return true
    return botLevelReaches(this.level(node), level) && this.options.reach.canReach(botId, node)
  }

  private browsers(): RemoteBrowsersPort {
    const browsers = this.options.browsers()
    if (!browsers) throw new NetError('conflict', 'Bots are unavailable on this computer.')
    return browsers
  }

  /** The connection id another device's calls are bound to here: one per device, apart from this computer's own. */
  static connectionOf(node: string): string {
    return `remote:${node}`
  }

  // ------------------------------------------------------------------ the remote rows (after `remoteBotMethods`' gate)

  view(node: string, botId: string, viewId?: string): Promise<{ browser: BotBrowserView }> {
    return this.browsers().view(botId, { connectionId: RemoteBotBrowsers.connectionOf(node), ...(viewId ? { viewId } : {}) }).then((browser) => ({ browser: withoutFrame(browser) }))
  }

  async hold(node: string, botId: string, viewId: string, request: BotBrowserHoldRequest): Promise<{ browser: BotBrowserView; hold?: BotBrowserHold }> {
    if (request.op === 'take') this.holders.set(node, (this.holders.get(node) ?? new Set()).add(botId))
    const answer = await this.browsers().hold(botId, viewId, request, RemoteBotBrowsers.connectionOf(node))
    return { ...answer, browser: withoutFrame(answer.browser) }
  }

  send(node: string, botId: string, viewId: string, holdId: string, inputs: BotBrowserSent[]): Promise<{ acks: BotBrowserAck[]; lastSeq: number }> {
    return this.browsers().send(botId, viewId, holdId, inputs, RemoteBotBrowsers.connectionOf(node))
  }

  async open(node: string, botId: string, input: { url?: string; viewId?: string; platform?: 'mac' | 'other' }): Promise<{ browser: BotBrowserView; hold?: BotBrowserHold }> {
    if (input.viewId) this.holders.set(node, (this.holders.get(node) ?? new Set()).add(botId))
    const answer = await this.browsers().open(botId, input.url, { connectionId: RemoteBotBrowsers.connectionOf(node), ...(input.viewId ? { viewId: input.viewId } : {}), ...(input.platform ? { platform: input.platform } : {}) })
    return { ...answer, browser: withoutFrame(answer.browser) }
  }

  // ------------------------------------------------------------------ the live view (`mousse.botview`)

  /** A view's stream another computer opened (the engine checked its pairing; this checks the bot level). */
  accept(node: NodeId | string, stream: EngineStream): void {
    const channel = new Channel(stream)
    const view: View = {
      node,
      channel,
      connectionId: `${RemoteBotBrowsers.connectionOf(node)}:v${++this.serial}`,
      ended: false,
      lifetime: new AbortController(),
      startedAt: this.now(),
      frames: 0,
      bytes: 0
    }
    this.views.add(view)
    channel.onEnd(() => this.end(view))
    let queue = Promise.resolve()
    channel.onMessage((message) => {
      // One watch at a time, in order: each is answered before the next is read.
      queue = queue.then(() => this.watch(view, message)).catch(() => undefined)
    })
  }

  private async watch(view: View, message: EngineMessage): Promise<void> {
    if (view.ended) return
    const watch = message.header as Partial<BotViewWatch>
    try {
      if (
        watch.t !== 'watch' ||
        !isBotId(watch.botId) ||
        !isWatchId(watch.watchId) ||
        !isCount(watch.width, 1, 10_000) ||
        !isCount(watch.fps, 1, 60) ||
        (watch.viewId !== undefined && !isWatchId(watch.viewId)) ||
        (view.botId !== undefined && (view.botId !== watch.botId || view.watchId !== watch.watchId))
      )
        throw new NetError('bad_request')
      this.admit(view.node, watch.botId)
      const browsers = this.browsers()
      const botId = watch.botId
      view.botId = botId
      view.watchId = watch.watchId
      const browser = await browsers.watch(botId, watch.watchId, {
        width: Math.min(REMOTE_VIEW_MAX_WIDTH, watch.width),
        fps: Math.min(REMOTE_VIEW_MAX_FPS, watch.fps),
        connectionId: view.connectionId,
        ...(watch.viewId ? { viewId: watch.viewId } : {}),
        lifetime: view.lifetime.signal,
        emit: (event) => this.emit(view, event)
      })
      if (view.ended) return
      view.channel.send({ t: 'view', browser: withoutFrame(browser) } satisfies BotViewMessage)
    } catch (error) {
      if (view.ended) return
      try {
        view.channel.send({ t: 'error', error: toWireError(error) } satisfies BotViewMessage)
      } catch {
        // Gone already.
      }
      this.reset(view, error instanceof NetError ? error.code : 'refused')
    }
  }

  /** Watching needs Use and the bot in the device's reach, read on each watch; a bot that is not there answers alike. */
  private admit(node: string, botId: string): void {
    const level = this.level(node)
    if (level === 'off') throw new NetError('forbidden', "This computer doesn't let this device reach its bots.", { details: { reason: 'bots_off' } })
    if (!this.allowed(node, botId, 'use')) throw new NetError('stream_unknown', 'This bot is gone.')
    try {
      this.options.bot(botId)
    } catch {
      throw new NetError('stream_unknown', 'This bot is gone.')
    }
  }

  /** One update, its picture in parts; resolves once the stream took it, so the browser holds the next until then. */
  private async emit(view: View, event: BotBrowserFrameEvent): Promise<void> {
    if (view.ended || !view.channel.isOpen()) throw new NetError('peer_offline')
    const { botId: _botId, frame, ...rest } = event
    if (!frame) {
      view.channel.send({ t: 'update', event: rest } satisfies BotViewMessage)
    } else {
      const { data, ...meta } = frame
      const bytes = Buffer.from(data, 'base64')
      const parts: Uint8Array[] = []
      for (let at = 0; at < bytes.length; at += REMOTE_VIEW_PART_BYTES) parts.push(bytes.subarray(at, at + REMOTE_VIEW_PART_BYTES))
      if (!parts.length) parts.push(new Uint8Array())
      view.channel.send({ t: 'update', event: { ...rest, frame: meta }, pieces: parts.length } satisfies BotViewMessage, [parts[0]!])
      for (const part of parts.slice(1)) view.channel.send({ t: 'part' } satisfies BotViewMessage, [part])
      view.frames += 1
      view.bytes += bytes.length
    }
    await view.channel.drained()
  }

  private reset(view: View, reason: string): void {
    if (view.ended) return
    view.channel.reset(reason)
    this.end(view)
  }

  private end(view: View): void {
    if (view.ended) return
    view.ended = true
    this.views.delete(view)
    view.lifetime.abort()
    if (view.botId && view.watchId) this.options.browsers()?.unwatch(view.botId, view.watchId, view.connectionId)
    this.options.counted?.({ frames: view.frames, bytes: view.bytes, ms: this.now() - view.startedAt })
  }

  /**
   * A device's reach changed, or a bot went: each view it may no longer watch ends at once (`forbidden`), and each hold
   * it may no longer have ends as if its lease ran out.
   */
  reconcile(): void {
    for (const view of [...this.views]) {
      if (view.botId === undefined) continue
      let present = true
      try {
        this.options.bot(view.botId)
      } catch {
        present = false
      }
      if (!present) this.reset(view, 'stream_unknown')
      else if (!this.allowed(view.node, view.botId, 'use')) this.reset(view, 'forbidden')
    }
    for (const [node, bots] of [...this.holders]) {
      for (const botId of [...bots]) {
        if (this.allowed(node, botId, 'full')) continue
        bots.delete(botId)
        void this.options.browsers()?.endHoldsOf(botId, RemoteBotBrowsers.connectionOf(node)).catch(() => undefined)
      }
      if (!bots.size) this.holders.delete(node)
    }
  }

  /** The views open now (tests). */
  get viewCount(): number {
    return this.views.size
  }

  close(): void {
    this.offReach?.()
    for (const view of [...this.views]) this.reset(view, 'closed')
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

/** A view's state alone: a picture goes on the view's stream, never in a call's reply. */
function withoutFrame(browser: BotBrowserView): BotBrowserView {
  if (!(browser as { frame?: unknown }).frame) return browser
  const { frame: _frame, ...rest } = browser as BotBrowserView & { frame?: unknown }
  return rest as BotBrowserView
}

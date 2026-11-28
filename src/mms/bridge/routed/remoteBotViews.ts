import { NetError, isNetErrorCode, type NodeId } from '../../../shared/net'
import { BOT_BROWSER_FRAME_EVENT, type BotBrowserFrameEvent, type BotBrowserView } from '../../../shared/bots/personal/browser'
import { DomainRpcError } from '../../protocol/domainRegistry'
import { Channel, fromWireError, type EngineStream } from '../../netEngine/session/transport'
import { engineLimits } from '../../netEngine/limits'
import type { EngineMessage } from '../../netEngine/session/frame'
import type { BotViewMessage, BotViewWatch } from '../remote/RemoteBotBrowsers'
import { qualifyBotResult } from './botIds'
import { computerOffline, type ComputerRef } from './computerErrors'

/**
 * This computer's windows watching the browser of a bot on another computer (`docs/plans/remote-bots.md`, live view).
 *
 * Each view a window shows has one `mousse.botview` stream to the bot's computer, opened by its first watch and kept
 * while the window renews it; unwatched, the window gone or the computer lost, it closes. Pictures come in parts and go
 * on to the window as `bots.browser.frame`, the same event as a bot of this computer's, under the bot's qualified id.
 * Nothing is opened at app start or by a thread: only a view on screen opens one, and it uses the bot places of the
 * connection, so it never takes a thread's (the engine counts it as bulk, behind bot chat and calls).
 */

/** How long a watch waits for the bot's computer's answer. */
const ANSWER_MS = 10_000

/** The window a view shows in: its connection to this daemon. */
export interface BotViewWindow {
  id: string
  emit(type: string, data: unknown): unknown
  lifetime?: AbortSignal
}

interface Assembling {
  event: Extract<BotViewMessage, { t: 'update' }>['event']
  left: number
  parts: Uint8Array[]
}

interface View {
  key: string
  node: NodeId
  /** The bot's id on its own computer. */
  botId: string
  watchId: string
  window: BotViewWindow
  channel: Channel
  answers: Array<{ resolve(view: { browser: BotBrowserView }): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>
  assembling?: Assembling
  ended: boolean
  /** Ended by this side (unwatched, the window gone): the window is not told it stalled. */
  closing: boolean
  /** Why the bot's computer ended the view, when it said (`end`). */
  endReason?: string
  frames: number
  bytes: number
  startedAt: number
  release?: () => void
}

export interface RemoteBotViewsOptions {
  /** Opens a `mousse.botview` stream to `node`; throws when it is not connected. */
  open(node: NodeId): EngineStream
  online(node: NodeId): boolean
  computer(node: NodeId): ComputerRef
  answerMs?: number
  /** How long a closed view waits for the other side to end its half before resetting the stream. */
  lingerMs?: number
  /** Each view's count when it ends (the real check's numbers). */
  counted?(count: { node: NodeId; frames: number; bytes: number; ms: number }): void
}

export class RemoteBotViews {
  private readonly views = new Map<string, View>()

  constructor(private readonly options: RemoteBotViewsOptions) {}

  private static keyOf(windowId: string, node: string, botId: string, watchId: string): string {
    return `${windowId}\u0000${node}\u0000${botId}\u0000${watchId}`
  }

  /** A window's watch of a bot's browser there, first or renewed: answers the browser's state as the bot's computer says. */
  watch(window: BotViewWindow, node: NodeId, botId: string, input: { watchId: string; width: number; fps: number; viewId?: string }): Promise<{ browser: BotBrowserView }> {
    const key = RemoteBotViews.keyOf(window.id, node, botId, input.watchId)
    let view = this.views.get(key)
    if (!view || view.ended) {
      if (!this.options.online(node)) return Promise.reject(computerOffline(this.options.computer(node)))
      // A window shows one view of a bot at a time: a new watch of it replaces the old one.
      for (const other of [...this.views.values()]) if (other.window.id === window.id && other.node === node && other.botId === botId) this.close(other)
      let stream: EngineStream
      try {
        stream = this.options.open(node)
      } catch (error) {
        // An older pairing that has no view streams says to update; anything else reads as the computer offline.
        const code = (error as { code?: unknown } | null)?.code
        return Promise.reject(refusalOf(code === 'incompatible_peer' ? 'not_supported' : undefined, this.options.computer(node)))
      }
      view = this.start(key, window, node, botId, input.watchId, stream)
    }
    const watch: BotViewWatch = { t: 'watch', botId, watchId: input.watchId, width: input.width, fps: input.fps, ...(input.viewId ? { viewId: input.viewId } : {}) }
    const current = view
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = current.answers.findIndex((answer) => answer.timer === timer)
        if (at >= 0) current.answers.splice(at, 1)
        reject(computerOffline(this.options.computer(node)))
      }, this.options.answerMs ?? ANSWER_MS)
      current.answers.push({ resolve, reject, timer })
      try {
        current.channel.send({ ...watch })
      } catch {
        this.end(current, 'peer_offline')
      }
    })
  }

  /** The window stopped watching: its stream closes. */
  unwatch(windowId: string, node: NodeId, botId: string, watchId: string): void {
    const view = this.views.get(RemoteBotViews.keyOf(windowId, node, botId, watchId))
    if (view) this.close(view)
  }

  /** A window's connection closed: each view it had closes. */
  endWindow(windowId: string): void {
    for (const view of [...this.views.values()]) if (view.window.id === windowId) this.close(view)
  }

  /** The views open now (tests and the real check). */
  get viewCount(): number {
    return this.views.size
  }

  close(view?: View): void {
    if (!view) {
      for (const each of [...this.views.values()]) this.close(each)
      return
    }
    view.closing = true
    if (!view.ended) this.linger(view.channel)
    this.end(view)
  }

  /**
   * Ends this side of a view's stream, and resets it if the other side never ends its own (an older Mousse there): a
   * stream keeps its place in both helpers until both sides ended it.
   */
  private linger(channel: Channel): void {
    let peerEnded = false
    const timer = setTimeout(() => {
      if (!peerEnded) channel.reset('cancelled')
    }, this.options.lingerMs ?? engineLimits().tunnelCloseLingerMs)
    timer.unref?.()
    channel.onEnd(() => {
      peerEnded = true
      clearTimeout(timer)
    })
    try {
      channel.end()
    } catch {
      clearTimeout(timer)
      channel.reset('cancelled')
    }
  }

  private start(key: string, window: BotViewWindow, node: NodeId, botId: string, watchId: string, stream: EngineStream): View {
    const view: View = { key, node, botId, watchId, window, channel: new Channel(stream), answers: [], ended: false, closing: false, frames: 0, bytes: 0, startedAt: Date.now() }
    this.views.set(key, view)
    view.channel.onMessage((message) => this.heard(view, message))
    view.channel.onEnd((reason) => this.end(view, reason ?? view.endReason ?? 'peer_offline'))
    if (window.lifetime) {
      const lifetime = window.lifetime
      const end = () => this.close(view)
      lifetime.addEventListener('abort', end, { once: true })
      view.release = () => lifetime.removeEventListener('abort', end)
      if (lifetime.aborted) end()
    }
    return view
  }

  private heard(view: View, message: EngineMessage): void {
    if (view.ended) return
    const header = message.header as BotViewMessage
    switch (header.t) {
      case 'view': {
        const answer = view.answers.shift()
        if (answer) {
          clearTimeout(answer.timer)
          answer.resolve(qualifyBotResult(view.node, { browser: header.browser }) as { browser: BotBrowserView })
        }
        return
      }
      case 'error': {
        const answer = view.answers.shift()
        if (answer) {
          clearTimeout(answer.timer)
          answer.reject(fromWireError(header.error))
        }
        return
      }
      case 'update': {
        const parts = typeof header.pieces === 'number' ? header.pieces : 0
        if (!parts || !header.event.frame) {
          const { frame: _frame, ...event } = header.event
          this.deliver(view, event)
          return
        }
        view.assembling = { event: header.event, left: parts - 1, parts: [...message.parts.slice(0, 1)] }
        if (view.assembling.left <= 0) this.assembled(view)
        return
      }
      case 'end':
        view.endReason = typeof header.reason === 'string' ? header.reason : undefined
        return
      case 'part': {
        const assembling = view.assembling
        if (!assembling || !message.parts[0]) return
        assembling.parts.push(message.parts[0])
        assembling.left -= 1
        if (assembling.left <= 0) this.assembled(view)
        return
      }
      default:
        return
    }
  }

  private assembled(view: View): void {
    const assembling = view.assembling!
    view.assembling = undefined
    const bytes = Buffer.concat(assembling.parts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)))
    view.frames += 1
    view.bytes += bytes.length
    this.deliver(view, { ...assembling.event, frame: { ...assembling.event.frame!, data: bytes.toString('base64') } })
  }

  private deliver(view: View, event: Omit<BotBrowserFrameEvent, 'botId'>): void {
    const out: BotBrowserFrameEvent = { ...event, botId: `${view.node}:${view.botId}` } as BotBrowserFrameEvent
    try {
      void Promise.resolve(view.window.emit(BOT_BROWSER_FRAME_EVENT, out)).catch(() => undefined)
    } catch {
      // The window went: its connection's end closes the view.
    }
  }

  private end(view: View, reason?: string): void {
    if (view.ended) return
    view.ended = true
    if (this.views.get(view.key) === view) this.views.delete(view.key)
    view.release?.()
    // The other side ended the view: this side's half ends too, so neither helper keeps the stream's place.
    if (!view.closing) {
      try {
        view.channel.end()
      } catch {
        view.channel.reset('cancelled')
      }
    }
    const error = refusalOf(reason, this.options.computer(view.node))
    for (const answer of view.answers.splice(0)) {
      clearTimeout(answer.timer)
      answer.reject(error)
    }
    // Pictures stopped without the window asking: it says it is not updating, and its next renewal opens a new stream.
    if (!view.closing) this.deliver(view, { watchId: view.watchId, stalled: reason === 'forbidden' || reason === 'stream_unknown' ? reason : 'offline' })
    this.options.counted?.({ node: view.node, frames: view.frames, bytes: view.bytes, ms: Date.now() - view.startedAt })
  }
}

/** What a watch whose stream ended answers: the bot's computer's refusal, or that computer offline. */
function refusalOf(reason: string | undefined, computer: ComputerRef): Error {
  if (reason === 'not_supported') return new DomainRpcError('incompatible_peer', `Update Mousse on ${computer.name} to watch its bots' browsers.`)
  if (reason && isNetErrorCode(reason) && reason !== 'peer_offline') return new NetError(reason)
  return computerOffline(computer)
}

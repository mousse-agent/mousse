import { NetError } from '../../../shared/net/errors'
import type { NodeId } from '../../../shared/net'
import { ROUTED_LARGE_READS, routedNetMethod } from '../../../shared/bridge/routed'
import { engineLimits } from '../limits'
import {
  ENGINE_LABELS,
  type EngineConnection,
  type EngineLabel,
  type EngineStream
} from '../session/transport'
import type { AppChannel, HandleSink, StreamClass } from './appChannel'

/** The class a stream travels in (§3.2): bulk for blobs, staged writes and the large reads, else interactive. */
export function classOf(label: EngineLabel, method?: string): StreamClass {
  if (label === 'mousse.blob' || label === 'mousse.put') return 'bulk'
  if (label === 'mousse.rpc' && method && LARGE.has(method)) return 'bulk'
  return 'interactive'
}
const LARGE = new Set(ROUTED_LARGE_READS.map(routedNetMethod))

type Event = { kind: 'data'; bytes: Uint8Array } | { kind: 'end'; reason?: string }

/** One stream of a helper connection, by its handle (or before the helper has named one). */
class HelperStream implements EngineStream {
  private handle?: number
  private readonly early: Array<{ bytes: Uint8Array; fin: boolean }> = []
  private readonly dataListeners: Array<(bytes: Uint8Array) => void> = []
  private readonly endListeners: Array<(reason?: string) => void> = []
  private readonly held: Event[] = []
  private writable = true
  private ended = false
  constructor(
    readonly label: EngineLabel,
    readonly cls: StreamClass,
    private readonly channel: AppChannel,
    private readonly gone: () => void
  ) {}

  /** The sink the channel delivers this stream's bytes to. */
  readonly sink: HandleSink = {
    data: (bytes, fin) => {
      if (bytes.byteLength) this.deliver({ kind: 'data', bytes })
      if (fin) this.deliver({ kind: 'end' })
    },
    reset: (code) => {
      this.writable = false
      this.deliver({ kind: 'end', reason: code })
    }
  }

  /** The helper named the stream: what was written before goes out now. */
  bound(handle: number): void {
    this.handle = handle
    for (const write of this.early.splice(0)) this.channel.send(handle, write.bytes, write.fin)
  }
  /** The stream never opened. */
  failed(reason: string): void {
    this.writable = false
    this.early.length = 0
    this.deliver({ kind: 'end', reason })
  }

  write(bytes: Uint8Array): void {
    if (!this.writable) throw new NetError('peer_offline')
    if (this.handle === undefined) this.early.push({ bytes: Uint8Array.from(bytes), fin: false })
    else this.channel.send(this.handle, bytes)
  }
  end(): void {
    if (!this.writable) return
    this.writable = false
    if (this.handle === undefined) this.early.push({ bytes: new Uint8Array(0), fin: true })
    else this.channel.send(this.handle, new Uint8Array(0), true)
  }
  reset(reason = 'reset'): void {
    const wasOpen = this.writable || !this.ended
    this.writable = false
    if (this.handle !== undefined && wasOpen) this.channel.reset(this.handle, reason)
    this.early.length = 0
    this.deliver({ kind: 'end', reason })
  }
  onData(listener: (bytes: Uint8Array) => void): void {
    this.dataListeners.push(listener)
    this.flush()
  }
  onEnd(listener: (reason?: string) => void): void {
    this.endListeners.push(listener)
    this.flush()
  }

  private deliver(event: Event): void {
    if (this.ended) return
    this.held.push(event)
    this.flush()
  }
  private flush(): void {
    if (!this.dataListeners.length && !this.endListeners.length) return
    while (this.held.length && !this.ended) {
      const event = this.held.shift()!
      if (event.kind === 'data') for (const listener of this.dataListeners) listener(event.bytes)
      else {
        this.ended = true
        this.writable = false
        for (const listener of this.endListeners) listener(event.reason)
        this.gone()
      }
    }
  }
}

/** One connection the helper reported up (`conn.up`), as the engine session uses it. */
export class HelperConnection implements EngineConnection {
  private readonly streamListeners: Array<(stream: EngineStream) => void> = []
  private readonly closeListeners: Array<(reason: string) => void> = []
  private readonly early: EngineStream[] = []
  private open_ = true
  private live = 0
  /** This side's opens past the connection's stream cap, in order. */
  private readonly waiting: Array<() => void> = []
  readonly id: string
  constructor(
    private readonly channel: AppChannel,
    /** The helper's number for the connection: per spawn, never reused. */
    readonly conn: number,
    readonly peer: NodeId,
    readonly direction: 'inbound' | 'outbound',
    readonly grant?: string,
    readonly endpoint?: string,
    /** The role this computer holds at the peer, on an outbound connection (`conn.up` says, when it knows). */
    readonly role?: string
  ) {
    this.id = String(conn)
  }

  open(label: EngineLabel, method?: string): EngineStream {
    if (!this.open_) throw new NetError('peer_offline')
    const stream = new HelperStream(label, classOf(label, method), this.channel, () =>
      this.released()
    )
    const start = (): void => {
      if (!this.open_) return stream.failed('peer_offline')
      this.live += 1
      this.channel
        .openStream(this.conn, label, stream.cls, stream.sink)
        .then((handle) => {
          stream.bound(handle)
          if (!this.open_) stream.reset('peer_offline')
        })
        .catch((error) => stream.failed(error instanceof NetError ? error.code : 'peer_offline'))
    }
    if (this.live < engineLimits().appStreamsPerConnection) start()
    else this.waiting.push(start)
    return stream
  }

  /** A stream the other side opened (`stream.incoming`), accepted. */
  incoming(handle: number, label: EngineLabel, cls: StreamClass): void {
    if (!this.open_ || this.live >= engineLimits().appStreamsPerConnection) {
      this.channel.reset(handle, 'refused')
      return
    }
    this.live += 1
    const stream = new HelperStream(label, cls, this.channel, () => this.released())
    this.channel.bind(handle, cls, stream.sink)
    stream.bound(handle)
    void this.channel
      .request('stream.accept', { handle })
      .catch(() => stream.failed('peer_offline'))
    if (this.streamListeners.length) for (const listener of this.streamListeners) listener(stream)
    else this.early.push(stream)
  }

  onStream(listener: (stream: EngineStream) => void): void {
    this.streamListeners.push(listener)
    for (const stream of this.early.splice(0)) listener(stream)
  }
  onClose(listener: (reason: string) => void): void {
    if (!this.open_) listener('closed')
    else this.closeListeners.push(listener)
  }
  /** Ends this side's use of the connection: its streams reset. The helper closes the connection itself. */
  close(reason: string): void {
    if (!this.open_) return
    this.open_ = false
    this.waiting.length = 0
    for (const listener of this.closeListeners.splice(0)) listener(reason)
  }
  isOpen(): boolean {
    return this.open_ && this.channel.isOpen()
  }

  private released(): void {
    this.live = Math.max(0, this.live - 1)
    const next = this.waiting.shift()
    next?.()
  }
}

/** The pairing a helper identity belongs to, and the grant it holds on this computer. */
export interface HelperPeers {
  byIdentity(identity: string): { node: NodeId; grant: string; endpoint: string } | undefined
}

/**
 * The app's view of its helper: the connections it reports up and down, the streams on them, dials, pairing
 * requests and whether networking is paused. Every connection that comes up for a known pairing goes to `attach`;
 * one for an identity not recorded yet (the connection a `join` brings up comes before its reply) waits until
 * `claim`. When the helper exits, every connection closes.
 */
export class EngineHelper {
  private readonly connections = new Map<number, HelperConnection>()
  /** Connections up for an identity with no pairing here yet, by the helper's number. */
  private readonly unclaimed = new Map<number, Record<string, unknown>>()
  private readonly pausedListeners: Array<(reason: string | undefined) => void> = []
  /** Why networking is paused (a removal not saved yet), while it is. */
  paused?: string
  /** What the helper said of itself in `hello` (`identity`, `device`, `port`, `routes`, `build`). */
  info: Record<string, any> = {}
  constructor(
    readonly channel: AppChannel,
    private readonly options: {
      peers: HelperPeers
      attach(connection: EngineConnection): Promise<void>
      name(): string
      /** The profile the endpoint belongs to: a helper started on another profile's endpoint refuses `hello`. */
      profile?(): string
    }
  ) {
    channel.onEvent((event) => this.event(event))
    channel.onClose((reason) => {
      for (const connection of [...this.connections.values()]) connection.close(reason)
      this.connections.clear()
      this.unclaimed.clear()
    })
  }

  /** The helper's `hello` (protocol 1.0) with this computer's name and profile; answers what it said of itself. */
  async hello(): Promise<Record<string, unknown>> {
    const profile = this.options.profile?.()
    const answer = await this.channel.request('hello', {
      proto: [1, 0],
      name: this.options.name(),
      ...(profile ? { profile } : {})
    })
    this.info = answer
    this.setPaused(typeof answer.paused === 'string' ? answer.paused : undefined)
    return answer
  }

  /** Asks the helper to connect to a pairing; its `conn.up` attaches the connection. */
  async dial(identity: string): Promise<void> {
    await this.channel.request('dial', { identity })
  }

  /** A pairing request (`invite.create`, `join`, `approval.answer`, `grant.add` and the rest), as the helper answers. */
  request(
    op: string,
    fields: Record<string, unknown> = {},
    deadlineMs?: number
  ): Promise<Record<string, unknown>> {
    return this.channel.request(op, fields, deadlineMs)
  }

  /** The helper's events (`approval`, `enrolled`, `join.progress` and the rest). */
  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    return this.channel.onEvent(listener)
  }

  onPaused(listener: (reason: string | undefined) => void): void {
    this.pausedListeners.push(listener)
  }

  /** A pairing was recorded for `identity`: its connections that came up before it attach now. */
  claim(identity: string): void {
    for (const [conn, event] of [...this.unclaimed])
      if (event.identity === identity) {
        this.unclaimed.delete(conn)
        this.up(event)
      }
  }

  close(): void {
    this.channel.close()
  }

  private setPaused(reason: string | undefined): void {
    if (this.paused === reason) return
    this.paused = reason
    for (const listener of this.pausedListeners) listener(reason)
  }

  private up(event: Record<string, unknown>): void {
    const conn = event.conn as number,
      identity = event.identity as string
    const peer = this.options.peers.byIdentity(identity)
    if (!peer) {
      this.unclaimed.set(conn, event)
      return
    }
    const direction = event.dir === 'in' ? 'inbound' : 'outbound'
    // Serving authority exists only on inbound connections, from the grant `conn.up` reports (§3.6).
    const grant =
      direction === 'inbound' &&
      (typeof event.grant === 'number' || typeof event.grant === 'string')
        ? String(event.grant)
        : undefined
    if (direction === 'inbound' && grant === undefined) return
    const role = direction === 'outbound' && typeof event.role === 'string' ? event.role : undefined
    const connection = new HelperConnection(
      this.channel,
      conn,
      peer.node,
      direction,
      grant,
      peer.endpoint,
      role
    )
    this.connections.set(conn, connection)
    void this.options.attach(connection).catch(() => connection.close('refused'))
  }

  private event(event: Record<string, unknown>): void {
    if (event.ev === 'conn.up') {
      if (
        typeof event.conn !== 'number' ||
        typeof event.identity !== 'string' ||
        (event.dir !== 'in' && event.dir !== 'out')
      )
        return
      this.up(event)
      return
    }
    if (event.ev === 'conn.down') {
      if (typeof event.conn !== 'number') return
      this.unclaimed.delete(event.conn)
      const connection = this.connections.get(event.conn)
      if (!connection) return
      this.connections.delete(event.conn)
      connection.close(typeof event.reason === 'string' ? event.reason : 'closed')
      return
    }
    if (event.ev === 'net.paused') {
      this.setPaused(typeof event.reason === 'string' && event.reason ? event.reason : 'paused')
      return
    }
    if (event.ev === 'net.resumed') {
      this.setPaused(undefined)
      return
    }
    if (event.ev === 'stream.incoming') {
      const connection =
        typeof event.conn === 'number' ? this.connections.get(event.conn) : undefined
      const handle = event.handle,
        label = event.label
      if (typeof handle !== 'number') return
      // Only the engine's labels, and only on a connection that serves here (the helper resets the rest too).
      if (
        !connection ||
        connection.direction !== 'inbound' ||
        typeof label !== 'string' ||
        !(ENGINE_LABELS as readonly string[]).includes(label)
      ) {
        this.channel.reset(handle, 'refused')
        return
      }
      connection.incoming(
        handle,
        label as EngineLabel,
        event.class === 'bulk' ? 'bulk' : 'interactive'
      )
    }
  }
}

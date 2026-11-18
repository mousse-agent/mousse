import { NetError } from '../../../shared/net/errors'
import type { NodeId } from '../../../shared/net'
import { ROUTED_LARGE_READS, routedNetMethod } from '../../../shared/bridge/routed'
import { engineLimits } from '../limits'
import { ENGINE_LABELS, type EngineConnection, type EngineLabel, type EngineStream } from '../session/transport'
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
    readonly endpoint?: string
  ) {
    this.id = String(conn)
  }

  open(label: EngineLabel, method?: string): EngineStream {
    if (!this.open_) throw new NetError('peer_offline')
    const stream = new HelperStream(label, classOf(label, method), this.channel, () => this.released())
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
    void this.channel.request('stream.accept', { handle }).catch(() => stream.failed('peer_offline'))
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
 * The app's view of its helper: the connections it reports up and down, the streams on them, and dials. Every
 * connection that comes up goes to `attach`; when the helper exits, every connection closes.
 */
export class EngineHelper {
  private readonly connections = new Map<number, HelperConnection>()
  constructor(
    readonly channel: AppChannel,
    private readonly options: {
      peers: HelperPeers
      attach(connection: EngineConnection): Promise<void>
      name(): string
    }
  ) {
    channel.onEvent((event) => this.event(event))
    channel.onClose((reason) => {
      for (const connection of [...this.connections.values()]) connection.close(reason)
      this.connections.clear()
    })
  }

  /** The helper's `hello` (protocol 1.0), then this computer's name for it; answers what it said of itself. */
  async hello(): Promise<Record<string, unknown>> {
    const answer = await this.channel.request('hello', { proto: [1, 0] })
    // A helper before `config.set` keeps the name it has; nothing depends on it here.
    await this.channel.request('config.set', { name: this.options.name() }).catch(() => undefined)
    return answer
  }

  /** Asks the helper to connect to a pairing; its `conn.up` attaches the connection. */
  async dial(identity: string): Promise<void> {
    await this.channel.request('dial', { identity })
  }

  close(): void {
    this.channel.close()
  }

  private event(event: Record<string, unknown>): void {
    if (event.ev === 'conn.up') {
      const conn = event.conn,
        identity = event.identity,
        dir = event.dir
      if (typeof conn !== 'number' || typeof identity !== 'string' || (dir !== 'in' && dir !== 'out')) return
      const peer = this.options.peers.byIdentity(identity)
      if (!peer) return
      const direction = dir === 'in' ? 'inbound' : 'outbound'
      // Serving authority exists only on inbound connections, from the grant `conn.up` reports (§3.6).
      const grant = direction === 'inbound' ? (typeof event.grant === 'string' ? event.grant : undefined) : undefined
      if (direction === 'inbound' && grant === undefined) return
      const connection = new HelperConnection(this.channel, conn, peer.node, direction, grant, peer.endpoint)
      this.connections.set(conn, connection)
      void this.options.attach(connection).catch(() => connection.close('refused'))
      return
    }
    if (event.ev === 'conn.down') {
      const connection = typeof event.conn === 'number' ? this.connections.get(event.conn) : undefined
      if (!connection) return
      this.connections.delete(event.conn as number)
      connection.close(typeof event.reason === 'string' ? event.reason : 'closed')
      return
    }
    if (event.ev === 'stream.incoming') {
      const connection = typeof event.conn === 'number' ? this.connections.get(event.conn) : undefined
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
      connection.incoming(handle, label as EngineLabel, event.class === 'bulk' ? 'bulk' : 'interactive')
    }
  }
}

import { NetError } from '../../../shared/net/errors'
import type { NodeId } from '../../../shared/net'
import { ROUTED_LARGE_READS, routedNetMethod } from '../../../shared/bridge/routed'
import { parseRelayDestination } from '../../../shared/netEngine/routes'
import { engineLimits } from '../limits'
import {
  ENGINE_LABELS,
  GRANT_ROLE,
  isBotLabel,
  type EngineConnection,
  type EngineRoute,
  type EngineLabel,
  type EngineStream
} from '../session/transport'
import type { AppChannel, HandleSink, StreamClass } from './appChannel'
import { ENGINE_FEATURES, type EngineFeature } from '../../../shared/netEngine/local'

/**
 * The class a stream travels in (§3.2): bulk for blobs, staged writes, the large reads and a bot's browser pictures
 * (which the helper counts as bulk whatever it is told), else interactive.
 */
export function classOf(label: EngineLabel, method?: string): StreamClass {
  if (label === 'mousse.blob' || label === 'mousse.put' || label === 'mousse.botview') return 'bulk'
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
  /** Bytes written before the helper named the stream. */
  private earlyBytes = 0
  /** Producers waiting for the helper to name the stream (or for it to end first). */
  private readonly boundWaiters: Array<() => void> = []
  /** Whether this computer may still write on its half (false after local end/reset, peer reset, fail or drop). */
  private writable = true
  /** Whether the peer's end (FIN or reset) has been delivered to listeners. */
  private ended = false
  /** Whether the peer's half is known to be over (peer FIN/reset, or local reset/fail/drop). */
  private readEnded = false
  /** Whether `stream.open` is currently in flight to the helper. */
  private opening = false
  /** Whether `gone` has already been called for this stream. */
  private released = false
  /**
   * Why this side ended the stream before the helper named it (`conn.down` or a reset): the handle that arrives
   * later is reset at once, so it never holds credit for a stream nobody reads.
   */
  private cancelled?: string
  constructor(
    readonly label: EngineLabel,
    readonly cls: StreamClass,
    private readonly channel: AppChannel,
    private readonly gone: () => void,
    readonly role?: string
  ) {}

  /** Marks that `stream.open` has been sent to the helper and holds a slot until it settles. */
  markOpening(): void {
    this.opening = true
  }

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
    this.opening = false
    this.handle = handle
    this.earlyBytes = 0
    if (this.cancelled !== undefined) {
      this.channel.reset(handle, this.cancelled)
      this.wakeBound()
      this.releaseIfDone()
      return
    }
    for (const write of this.early.splice(0)) this.channel.send(handle, write.bytes, write.fin)
    this.wakeBound()
    this.releaseIfDone()
  }
  /** The stream never opened. */
  failed(reason: string): void {
    this.opening = false
    this.writable = false
    this.readEnded = true
    this.early.length = 0
    this.wakeBound()
    this.deliver({ kind: 'end', reason })
    this.releaseIfDone()
  }
  /**
   * The helper ended the stream with its connection (`conn.down`): its handle is released here (its credit, its
   * queue, its producers' waits) and its reader sees the end.
   */
  dropped(reason: string): void {
    this.opening = false
    this.writable = false
    this.readEnded = true
    this.early.length = 0
    if (this.handle !== undefined) this.channel.release(this.handle)
    else this.cancelled = reason
    this.wakeBound()
    this.deliver({ kind: 'end', reason })
    this.releaseIfDone()
  }

  write(bytes: Uint8Array): void {
    if (!this.writable) throw new NetError('peer_offline')
    try {
      if (this.handle !== undefined) return this.channel.send(this.handle, bytes)
      if (this.earlyBytes + bytes.byteLength > engineLimits().appStreamQueueMaxBytes)
        throw new NetError('too_large', 'The stream has too much waiting for the helper.')
      this.earlyBytes += bytes.byteLength
      this.early.push({ bytes: Uint8Array.from(bytes), fin: false })
    } catch (error) {
      if (error instanceof NetError && error.code === 'too_large') this.reset('too_large')
      throw error
    }
  }
  /** Settles once a producer may write more: the stream's queue has room, or the stream is gone. */
  async ready(): Promise<void> {
    if (this.handle === undefined && this.writable)
      await new Promise<void>((resolve) => this.boundWaiters.push(resolve))
    if (this.handle !== undefined && this.writable) await this.channel.whenRoom(this.handle)
  }
  private wakeBound(): void {
    for (const wake of this.boundWaiters.splice(0)) wake()
  }
  end(): void {
    if (!this.writable) return
    this.writable = false
    if (this.handle === undefined) this.early.push({ bytes: new Uint8Array(0), fin: true })
    else this.channel.send(this.handle, new Uint8Array(0), true)
    this.releaseIfDone()
  }
  reset(reason = 'reset'): void {
    const wasOpen = this.writable || !this.readEnded
    this.writable = false
    this.readEnded = true
    if (this.handle === undefined) this.cancelled = reason
    else if (wasOpen && this.cancelled === undefined) {
      this.cancelled = reason
      this.channel.reset(this.handle, reason)
    }
    this.early.length = 0
    this.wakeBound()
    this.deliver({ kind: 'end', reason })
    this.releaseIfDone()
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
        this.readEnded = true
        // A peer reset ends both halves; a clean peer FIN leaves our write half open so we can send our FIN.
        if (event.reason !== undefined) this.writable = false
        for (const listener of this.endListeners) listener(event.reason)
        this.releaseIfDone()
      }
    }
  }
  private releaseIfDone(): void {
    if (this.released || this.opening || this.writable || !this.readEnded) return
    this.released = true
    this.gone()
  }
}

/** The places of one pool of a connection: the thread labels', or the bot labels' (`isBotLabel`). */
class SlotPool {
  live = 0
  readonly started = new Set<HelperStream>()
  readonly waiting: Array<{ stream: HelperStream; start: () => void }> = []
  constructor(private readonly cap: () => number) {}
  hasRoom(): boolean {
    return this.live < this.cap()
  }
}

/**
 * Shared stream-slot accounting for one physical helper connection (`STREAMS_PER_CONNECTION` counts both directions
 * together, so a both-ways connection and its reverse view share one slot pool). The bot labels have places of their
 * own (`botStreamsPerConnection`), as the helper keeps them: a bot open never waits behind thread opens, and a thread
 * stream never takes a bot place.
 */
class ConnectionSlots {
  private readonly app = new SlotPool(() => engineLimits().appStreamsPerConnection)
  private readonly bot = new SlotPool(() => engineLimits().botStreamsPerConnection)
  private pool(label: EngineLabel): SlotPool {
    return isBotLabel(label) ? this.bot : this.app
  }

  hasRoom(label: EngineLabel): boolean {
    return this.pool(label).hasRoom()
  }
  admit(stream: HelperStream): void {
    const pool = this.pool(stream.label)
    pool.started.add(stream)
    pool.live += 1
  }
  enqueue(stream: HelperStream, start: () => void): void {
    this.pool(stream.label).waiting.push({ stream, start })
  }
  release(stream: HelperStream): void {
    const pool = this.pool(stream.label)
    if (!pool.started.delete(stream)) {
      const at = pool.waiting.findIndex((entry) => entry.stream === stream)
      if (at >= 0) pool.waiting.splice(at, 1)
      return
    }
    pool.live = Math.max(0, pool.live - 1)
    const next = pool.waiting.shift()
    next?.start()
  }
  clearWaitingFor(streams: Set<HelperStream>): void {
    for (const pool of [this.app, this.bot])
      for (let i = pool.waiting.length - 1; i >= 0; i -= 1) {
        if (streams.has(pool.waiting[i]!.stream)) pool.waiting.splice(i, 1)
      }
  }
}

/** One connection the helper reported up (`conn.up`), as the engine session uses it. */
export class HelperConnection implements EngineConnection {
  private readonly streamListeners: Array<(stream: EngineStream) => void> = []
  private readonly closeListeners: Array<(reason: string) => void> = []
  private readonly early: EngineStream[] = []
  /** Every stream of this connection not ended yet, to release when the connection goes down. */
  private readonly streams = new Set<HelperStream>()
  private open_ = true
  readonly id: string
  /** Shared with the reverse direction on a both-ways connection (`conn.up {both}`). */
  readonly slots: ConnectionSlots
  constructor(
    private readonly channel: AppChannel,
    /** The helper's number for the connection: per spawn, never reused. */
    readonly conn: number,
    readonly peer: NodeId,
    readonly direction: 'inbound' | 'outbound',
    readonly grant?: string,
    readonly endpoint?: string,
    /** The role this computer holds at the peer, on an outbound connection (`conn.up` says, when it knows). */
    readonly role?: string,
    /** The route it runs over (`conn.up.route`, protocol 1.1). */
    readonly route?: EngineRoute,
    /** The other way of a both-ways connection (`EngineConnection.reversed`). */
    readonly reversed?: boolean,
    slots?: ConnectionSlots
  ) {
    this.id = String(conn)
    this.slots = slots ?? new ConnectionSlots()
  }

  open(label: EngineLabel, method?: string): EngineStream {
    if (!this.open_) throw new NetError('peer_offline')
    const stream: HelperStream = new HelperStream(label, classOf(label, method), this.channel, () =>
      this.released(stream)
    )
    this.streams.add(stream)
    const start = (): void => {
      if (!this.open_) return stream.failed('peer_offline')
      this.slots.admit(stream)
      stream.markOpening()
      this.channel
        .openStream(this.conn, label, stream.cls, stream.sink)
        .then((handle) => {
          stream.bound(handle)
          if (!this.open_) stream.reset('peer_offline')
        })
        .catch((error) => stream.failed(error instanceof NetError ? error.code : 'peer_offline'))
    }
    if (this.slots.hasRoom(label)) start()
    else this.slots.enqueue(stream, start)
    return stream
  }

  /** A stream the other side opened (`stream.incoming`), accepted, with the role of the grant it is served under. */
  incoming(handle: number, label: EngineLabel, cls: StreamClass, role?: string): void {
    if (!this.open_ || !this.slots.hasRoom(label)) {
      this.channel.reset(handle, 'refused')
      return
    }
    const stream: HelperStream = new HelperStream(label, cls, this.channel, () => this.released(stream), role)
    this.slots.admit(stream)
    this.streams.add(stream)
    this.channel.bind(handle, cls, stream.sink)
    stream.bound(handle)
    void this.channel
      .request('stream.accept', { handle })
      // Refused here (the control queue is full) or by the helper: the handle and its credit go, both ways.
      .catch((error) => stream.reset(error instanceof NetError ? error.code : 'peer_offline'))
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
    this.slots.clearWaitingFor(this.streams)
    for (const listener of this.closeListeners.splice(0)) listener(reason)
  }
  /**
   * The helper closed the connection (`conn.down`), and every stream on it with it: each is released here and its
   * reader sees the end.
   */
  down(reason: string): void {
    this.close(reason)
    for (const stream of [...this.streams]) stream.dropped(reason)
    this.streams.clear()
  }
  /** This side stops using the connection's streams while the helper keeps it up (it is attached again). */
  resetStreams(reason: string): void {
    for (const stream of [...this.streams]) stream.reset(reason)
    this.streams.clear()
  }
  isOpen(): boolean {
    return this.open_ && this.channel.isOpen()
  }

  private released(stream: HelperStream): void {
    this.streams.delete(stream)
    this.slots.release(stream)
  }
}

/** The pairing a helper identity belongs to, and the grant it holds on this computer. */
export interface HelperPeers {
  /** `uses`: this computer uses that one (false for a pairing that only lets it in here); unset reads as true. */
  byIdentity(
    identity: string
  ): { node: NodeId; grant: string; endpoint: string; uses?: boolean } | undefined
}

/**
 * The app's view of its helper: the connections it reports up and down, the streams on them, dials, pairing
 * requests and whether networking is paused. Every connection that comes up for a known pairing goes to `attach`;
 * one for an identity not recorded yet (the connection a `join` brings up comes before its reply) waits until
 * `claim`. When the helper exits, every connection closes.
 */
export class EngineHelper {
  private readonly connections = new Map<number, HelperConnection>()
  /**
   * The other way of each connection that carries calls both ways (`conn.up {both}`, wire minor 3), by the helper's
   * number: on a connection this computer dialled, the other computer's calls, served under this computer's grant
   * for it (`stream.incoming {grant}`); on one it was dialled on, this computer's calls to the dialler.
   */
  private readonly reverse = new Map<number, HelperConnection>()
  /** The `conn.up` of each connection the helper holds up, by its number, until its `conn.down`. */
  private readonly ups = new Map<number, Record<string, unknown>>()
  /** The call back being tried on each inbound connection (`served`), by its number: whether it went through. */
  private readonly trying = new Map<number, Promise<boolean>>()
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
      /** A connection came up for an identity with no pairing here (the host may owe it a row, §5.1). */
      unclaimed?(identity: string, inbound: boolean): void
    }
  ) {
    channel.onEvent((event) => this.event(event))
    channel.onClose((reason) => {
      for (const connection of [...this.connections.values(), ...this.reverse.values()])
        connection.close(reason)
      this.connections.clear()
      this.reverse.clear()
      this.unclaimed.clear()
      this.ups.clear()
      this.trying.clear()
    })
  }

  /**
   * The helper's `hello` with this computer's name and profile; answers what it said of itself. The app offers
   * protocol 1.2 (pairing flow §1): a 1.2 helper lists what it implements in `features`; a 1.1 helper answers
   * `[1, 1]` with no list, and a 1.0 helper `[1, 0]`, serving 1a's messages only. The app says it takes streams of
   * grants whose role is not `owner` (`grant-roles`): a helper hands those only to an app that said so (§8.4).
   */
  async hello(): Promise<Record<string, unknown>> {
    const profile = this.options.profile?.()
    const answer = await this.channel.request('hello', {
      proto: [1, 2],
      features: ['grant-roles'],
      name: this.options.name(),
      ...(profile ? { profile } : {})
    })
    this.info = answer
    this.setPaused(typeof answer.paused === 'string' ? answer.paused : undefined)
    return answer
  }

  /**
   * Asks the helper to connect to a pairing; its `conn.up` attaches the connection. A connection the helper holds
   * up already (`already`) whose use here ended (its hello was refused) is attached again.
   */
  async dial(identity: string): Promise<{ conn?: number; already: boolean }> {
    // A connection the other computer dialled that carries calls both ways is this computer's way to it: no dial back.
    const both = this.callBack(identity)
    if (both !== undefined) return { conn: both, already: true }
    const answer = await this.channel.request('dial', { identity })
    this.reattach(identity)
    return {
      ...(typeof answer.conn === 'number' ? { conn: answer.conn } : {}),
      already: answer.already === true
    }
  }

  /**
   * Attaches again each outbound connection to `identity` the helper still holds up but whose use here ended (a
   * `mousse.hello` the other computer refused before it recorded the pairing).
   */
  reattach(identity: string): void {
    for (const [conn, event] of [...this.ups]) {
      if (event.identity !== identity || event.dir !== 'out' || this.unclaimed.has(conn)) continue
      const connection = this.connections.get(conn)
      if (connection?.isOpen()) continue
      connection?.resetStreams('cancelled')
      this.connections.delete(conn)
      this.up(event)
    }
  }

  /**
   * This computer's calls to `identity` over a connection it was dialled on that carries calls both ways: attached
   * (again, when its use ended, as a hello the other computer refused before it granted this computer). Answers that
   * connection's number, or undefined without one. The helper says `both` only once the caller's HELLO agreed it.
   */
  callBack(identity: string): number | undefined {
    if (this.options.peers.byIdentity(identity)?.uses === false) return undefined
    for (const [conn, event] of this.ups) {
      if (event.identity !== identity || event.dir !== 'in' || event.both !== true) continue
      const inbound = this.connections.get(conn)
      if (!inbound?.isOpen()) continue
      if (!this.reverse.get(conn)?.isOpen()) this.attachReverse(conn, event, 'outbound')
      return conn
    }
    return undefined
  }

  /**
   * Calls `identity` back once on a connection it dialled here, whether or not this computer uses it yet: true once
   * that computer served the call (its hello answered, so it holds a live grant for this one), false otherwise.
   */
  async served(identity: string): Promise<boolean> {
    for (const [conn, event] of [...this.ups]) {
      if (event.identity !== identity || event.dir !== 'in' || event.both !== true) continue
      if (!this.connections.get(conn)?.isOpen()) continue
      if (await this.tryCallBack(conn, event)) return true
    }
    return false
  }

  /** Calls the caller back on inbound connection `conn` once (one try at a time): whether it went through. */
  private tryCallBack(conn: number, event: Record<string, unknown>): Promise<boolean> {
    const running = this.trying.get(conn)
    if (running) return running
    const tried = new Promise<boolean>((resolve) => {
      if (!this.attachReverse(conn, event, 'outbound', undefined, resolve)) resolve(false)
    }).then((through) => {
      this.trying.delete(conn)
      return through
    })
    this.trying.set(conn, tried)
    return tried
  }

  /**
   * The other way of the both-ways connection `conn` (`event` its `conn.up`), attached as a connection of its own;
   * `settled` hears whether the attach went through.
   */
  private attachReverse(
    conn: number,
    event: Record<string, unknown>,
    direction: 'inbound' | 'outbound',
    grant?: string,
    settled?: (through: boolean) => void
  ): HelperConnection | undefined {
    const peer = this.options.peers.byIdentity(String(event.identity))
    if (!peer) return undefined
    this.reverse.get(conn)?.resetStreams('cancelled')
    const connection = new HelperConnection(
      this.channel,
      conn,
      peer.node,
      direction,
      grant,
      peer.endpoint,
      undefined,
      readRoute(event.route),
      true,
      this.connections.get(conn)?.slots
    )
    this.reverse.set(conn, connection)
    void this.options.attach(connection).then(
      () => settled?.(true),
      () => {
        connection.close('refused')
        settled?.(false)
      }
    )
    return connection
  }

  /** Whether the helper speaks protocol 1.`minor` or later (its `hello` answer). */
  speaks(minor: number): boolean {
    const proto = this.info.proto
    return Array.isArray(proto) && proto[0] === 1 && typeof proto[1] === 'number' && proto[1] >= minor
  }

  /**
   * Whether the helper implements `feature` (its 1.2 `hello` lists it). A new field or operation is sent only then:
   * an older helper ignores a field it does not know and would answer as if it had not been sent. `grant-roles` is
   * read from any helper that lists it (a 1.0 or 1.1 helper lists nothing): without it every grant is `owner`, so
   * the app lets a device in below Full control only when it is listed.
   */
  has(feature: EngineFeature): boolean {
    const features = this.info.features
    return (this.speaks(2) || feature === 'grant-roles') && Array.isArray(features) && features.includes(feature)
  }

  /** What the helper implements beyond 1.1, as its `hello` listed it. */
  features(): EngineFeature[] {
    const features = this.info.features
    if (!this.speaks(2) || !Array.isArray(features)) return []
    return features.filter((item): item is EngineFeature =>
      (ENGINE_FEATURES as readonly unknown[]).includes(item)
    )
  }

  /**
   * Sends one request and says its id at once (`join.probe.cancel` names a probe by the id of its request); the
   * reply comes as `request`'s does.
   */
  requestWithId(
    op: string,
    fields: Record<string, unknown>,
    deadlineMs: number | undefined,
    onId: (id: number) => void
  ): Promise<Record<string, unknown>> {
    return this.channel.request(op, fields, deadlineMs, undefined, onId)
  }

  /**
   * This computer stopped using `identity` while it may still use this one: the calls this computer could make back
   * on that computer's own connections end, and none is attached again (`peers.byIdentity(...).uses` is false).
   */
  dropCallBack(identity: string): void {
    for (const [conn, connection] of [...this.reverse]) {
      if (connection.direction !== 'outbound' || this.ups.get(conn)?.identity !== identity) continue
      this.reverse.delete(conn)
      connection.close('cancelled')
    }
  }

  /** The route of the connection the helper holds up as `conn`, when its `conn.up` named one. */
  routeOf(conn: number): EngineRoute | undefined {
    return readRoute(this.ups.get(conn)?.route)
  }

  /** Whether the helper holds a connection up with `identity` in that direction. */
  holds(identity: string, dir: 'in' | 'out'): boolean {
    for (const event of this.ups.values())
      if (event.identity === identity && event.dir === dir) return true
    return false
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
      try {
        this.options.unclaimed?.(identity, event.dir === 'in')
      } catch {
        // The row is owed again at the next connection or start.
      }
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
      role,
      readRoute(event.route)
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
      this.ups.set(event.conn, event)
      this.up(event)
      return
    }
    if (event.ev === 'conn.down') {
      if (typeof event.conn !== 'number') return
      this.unclaimed.delete(event.conn)
      this.ups.delete(event.conn)
      this.trying.delete(event.conn)
      const reason = typeof event.reason === 'string' ? event.reason : 'closed'
      const other = this.reverse.get(event.conn)
      this.reverse.delete(event.conn)
      other?.down(reason)
      const connection = this.connections.get(event.conn)
      if (!connection) return
      this.connections.delete(event.conn)
      connection.down(reason)
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
      const cls = event.class === 'bulk' ? 'bulk' : 'interactive'
      const role = typeof event.role === 'string' && GRANT_ROLE.test(event.role) ? event.role : undefined
      // Only the engine's labels (the helper resets the rest too).
      if (!connection || typeof label !== 'string' || !(ENGINE_LABELS as readonly string[]).includes(label)) {
        this.channel.reset(handle, 'refused')
        return
      }
      const up = this.ups.get(event.conn as number)
      if (connection.direction === 'outbound') {
        // The other computer calls this one over this computer's own connection (both ways, minor 3), under the
        // grant this computer holds for it, which the helper names.
        const grant =
          typeof event.grant === 'number' || typeof event.grant === 'string' ? String(event.grant) : undefined
        if (!up || up.both !== true || grant === undefined) {
          this.channel.reset(handle, 'refused')
          return
        }
        let served = this.reverse.get(event.conn as number)
        if (!served?.isOpen() || served.grant !== grant)
          served = this.attachReverse(event.conn as number, up, 'inbound', grant)
        if (!served) {
          this.channel.reset(handle, 'refused')
          return
        }
        served.incoming(handle, label as EngineLabel, cls, role)
        return
      }
      connection.incoming(handle, label as EngineLabel, cls, role)
      // The dialler opened a stream: this computer may call it back on the same connection, when it uses that one.
      if (
        up?.both === true &&
        !this.reverse.get(event.conn as number)?.isOpen() &&
        this.options.peers.byIdentity(String(up.identity))?.uses !== false
      )
        this.attachReverse(event.conn as number, up, 'outbound')
    }
  }
}

const ROUTE_KINDS = new Set(['tcp', 'ws', 'ssh'])
const ROUTE_CLASSES = new Set(['lan', 'tailnet', 'public', 'tunnel', 'ssh'])
const RELAY_CLASSES = new Set(['relay', 'relay_bulk'])

/** `conn.up.route` as the app keeps it; anything else is no route. */
export function readRoute(value: unknown): EngineRoute | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { kind, class: cls, destination } = value as {
    kind?: unknown
    class?: unknown
    destination?: unknown
  }
  if (typeof kind !== 'string' || typeof cls !== 'string') return undefined
  // A relay connection (Phase 3): its class and the relay it runs through.
  if (kind === 'relay')
    return RELAY_CLASSES.has(cls)
      ? {
          kind,
          class: cls as EngineRoute['class'],
          ...(typeof destination === 'string' && parseRelayDestination(destination)
            ? { destination }
            : {})
        }
      : undefined
  return ROUTE_KINDS.has(kind) && ROUTE_CLASSES.has(cls)
    ? { kind: kind as EngineRoute['kind'], class: cls as EngineRoute['class'] }
    : undefined
}

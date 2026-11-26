import { NetError } from '../../../shared/net/errors'
import type {
  BlobId,
  EventId,
  RpcId,
  StoredRecord,
  StreamHead,
  StreamId
} from '../../../shared/net'
import type { EphemeralMessage } from '../../../shared/net/wire'
import type {
  SessionState,
  StreamStore,
  SubscriptionHandlers,
  SyncSession
} from '../../net/contracts'
import { SubscriptionReceiver } from '../../net/sync/subscription'
import { engineLimits } from '../limits'
import type { EngineMessage } from './frame'
import {
  Channel,
  fromWireError,
  GRANT_ROLE,
  SESSION_FEATURES,
  type EngineConnection,
  type EngineLabel
} from './transport'

/** The part of a session that RoutedClient, RoutedStager and the Hub use; the peer directory hands one out per node. */
export type BridgeClient = Pick<
  SyncSession,
  | 'rpc'
  | 'rpcResult'
  | 'rpcCancel'
  | 'subscribe'
  | 'getBlob'
  | 'append'
  | 'putBlob'
  | 'state'
  | 'onClosed'
  | 'onEphemeral'
>

export interface EngineClientPort {
  store: StreamStore
  /**
   * The engine `verify` callback (§3.4): a record of `stream` is taken only while the stream is bound to this
   * client's pairing and the client is live. No signature or v1 author check: the pinned channel is the proof.
   */
  verify(stream: StreamId, record: StoredRecord, snapshot: boolean, client: EngineClient): void
  /** The session features said in `hello` (`SESSION_FEATURES` without it). */
  features?(): readonly string[]
}

const recordsOf = (message: EngineMessage): StoredRecord[] => {
  const rows = message.header.records
  if (!Array.isArray(rows) || message.parts.length !== rows.length * 2)
    throw new NetError('bad_request')
  return rows.map((row: { epoch: number; seq: number; recvTs: number }, index) => ({
    epoch: row.epoch,
    seq: row.seq,
    recvTs: row.recvTs,
    envelope: message.parts[index * 2]!,
    sig: message.parts[index * 2 + 1]!
  }))
}

/**
 * This computer's side of one outbound engine connection: the calls, subscriptions, blob reads and staged
 * writes it makes to the pairing `connection.peer`. A path switch (`switchTo`) moves it to a renewed connection
 * of the same pairing: what holds it (the Hub, a routed call) keeps it, and the old connection stays only for
 * the calls still running on it.
 */
export class EngineClient implements BridgeClient {
  private readonly closedListeners = new Set<(error?: Error) => void>()
  private readonly ephemeralListeners = new Set<(message: EphemeralMessage) => void>()
  private readonly subscriptions = new Set<LiveSubscription>()
  /** Exchanges still waiting for their answer, by the connection they were sent on (each one's way to fail). */
  private readonly running = new Map<EngineConnection, Set<() => void>>()
  private readonly settledListeners = new Set<() => void>()
  /** Old connections of path switches, kept until their calls are done. */
  private readonly previous = new Set<EngineConnection>()
  private current: EngineConnection
  private closed = false
  constructor(
    connection: EngineConnection,
    readonly port: EngineClientPort
  ) {
    this.current = connection
    this.watch(connection)
  }

  /** The connection new calls and subscriptions use. */
  get connection(): EngineConnection {
    return this.current
  }

  private watch(connection: EngineConnection): void {
    connection.onClose(() => {
      this.previous.delete(connection)
      for (const fail of [...(this.running.get(connection) ?? [])]) fail()
      this.wake()
      // An old path of a switch closing ends nothing here: only the current one does.
      if (this.closed || connection !== this.current) return
      this.closed = true
      for (const listener of [...this.closedListeners]) {
        try {
          listener(new NetError('peer_offline'))
        } catch {
          /* Independent listeners. */
        }
      }
    })
  }

  /** This computer's local id for the pairing. */
  get node(): EngineConnection['peer'] {
    return this.connection.peer
  }

  state(): SessionState {
    return !this.closed && this.connection.isOpen() ? 'open' : 'closed'
  }

  /** The `mousse.hello` exchange; the connection is handoff-ready once it answers. */
  async hello(
    name: string,
    deadlineMs = engineLimits().helloDeadlineMs
  ): Promise<{ name: string; features: string[]; role?: string }> {
    const reply = await this.exchange(
      'mousse.hello',
      { t: 'hello', proto: 1, name, features: [...(this.port.features?.() ?? SESSION_FEATURES)] },
      [],
      { deadlineMs, until: 'hello', keepOpen: true }
    )
    const features = Array.isArray(reply.header.features)
      ? reply.header.features.filter((feature): feature is string => typeof feature === 'string')
      : []
    // This computer's role there (§8.4), from an app that says it.
    const role = typeof reply.header.role === 'string' && GRANT_ROLE.test(reply.header.role) ? reply.header.role : undefined
    return { name: String(reply.header.name ?? ''), features, ...(role ? { role } : {}) }
  }

  /**
   * Opens the one long-lived `access.*` exchange with the other computer (it said `access-ask` in its hello): a
   * `mousse.hello` stream that starts with `access.open` and that both sides then write on. It ends with the
   * connection it was opened on.
   */
  openAccess(): Channel {
    if (this.state() !== 'open') throw new NetError('peer_offline')
    const channel = new Channel(this.current.open('mousse.hello'))
    channel.send({ t: 'access.open' })
    return channel
  }

  /**
   * Asks the other computer to pair back (§5.1 step 4): it records `routes` (this computer's addresses), connects
   * here and answers `pairback.done` once its own hello was answered.
   */
  async pairback(
    request: { routes: string[]; receipt?: string },
    deadlineMs = engineLimits().pairbackDeadlineMs
  ): Promise<void> {
    await this.exchange(
      'mousse.hello',
      {
        t: 'pairback',
        routes: request.routes,
        ...(request.receipt ? { receipt: request.receipt } : {})
      },
      [],
      { deadlineMs, until: 'pairback.done' }
    )
  }

  rpc(
    method: string,
    params: unknown,
    options: {
      id: RpcId
      idem?: string
      deadlineMs: number
      signal?: AbortSignal
      onProgress?: (data: unknown) => void
    }
  ): Promise<unknown> {
    return this.exchange(
      'mousse.rpc',
      {
        t: 'call',
        id: options.id,
        ...(options.idem === undefined ? {} : { idem: options.idem }),
        method,
        params: params ?? null,
        deadline: options.deadlineMs
      },
      [],
      options
    ).then((reply) => reply.header.result)
  }

  rpcResult(id: RpcId, options: { deadlineMs: number; signal?: AbortSignal }): Promise<unknown> {
    return this.exchange(
      'mousse.rpc',
      { t: 'result.get', id, deadline: options.deadlineMs },
      [],
      options
    ).then((reply) => reply.header.result)
  }

  async rpcCancel(id: RpcId): Promise<void> {
    const deadlineMs = engineLimits().cancelDeadlineMs
    await this.exchange('mousse.rpc', { t: 'cancel', id, deadline: deadlineMs }, [], { deadlineMs })
  }

  async getBlob(
    stream: StreamId,
    blob: BlobId,
    options?: { signal?: AbortSignal }
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    let size = -1
    await this.exchange('mousse.blob', { t: 'get', stream, blob }, [], {
      deadlineMs: engineLimits().blobDeadlineMs,
      signal: options?.signal,
      until: 'done',
      onMessage: (message) => {
        if (message.header.t === 'blob') size = Number(message.header.bytes)
        else if (message.header.t === 'bytes' && message.parts[0]) chunks.push(message.parts[0])
      }
    })
    const bytes = Buffer.concat(chunks)
    if (bytes.length !== size) throw new NetError('bad_request')
    return bytes
  }

  async append(
    stream: StreamId,
    id: EventId,
    envelope: Uint8Array,
    sig: Uint8Array
  ): Promise<{ epoch: number; seq: number; recvTs: number }> {
    const reply = await this.exchange('mousse.put', { t: 'append', stream, id }, [envelope, sig], {
      deadlineMs: engineLimits().appendDeadlineMs,
      until: 'appended'
    })
    return {
      epoch: Number(reply.header.epoch),
      seq: Number(reply.header.seq),
      recvTs: Number(reply.header.recvTs)
    }
  }

  async putBlob(stream: StreamId, blob: BlobId, bytes: Uint8Array, sealed: boolean): Promise<void> {
    if (sealed) throw new NetError('forbidden')
    await this.exchange(
      'mousse.put',
      { t: 'blob.put', stream, blob, bytes: bytes.byteLength, sealed: false },
      [],
      {
        deadlineMs: engineLimits().blobDeadlineMs,
        until: 'stored',
        after: async (channel) => {
          const chunk = engineLimits().blobChunkBytes
          for (let at = 0; at < bytes.byteLength; at += chunk) {
            channel.send({ t: 'bytes' }, [bytes.subarray(at, at + chunk)])
            // A slow host holds the next chunk back here, not in memory.
            await channel.drained()
            if (!channel.isOpen()) return
          }
          channel.send({ t: 'commit' })
        }
      }
    )
  }

  subscribe(stream: StreamId, handlers: SubscriptionHandlers): { close(): void } {
    if (this.state() !== 'open') throw new NetError('peer_offline')
    const subscription = new LiveSubscription(this, stream, handlers, () =>
      this.subscriptions.delete(subscription)
    )
    this.subscriptions.add(subscription)
    subscription.start()
    return { close: () => subscription.close() }
  }

  /**
   * The path switch (§3.6) onto `next`, a renewed connection of this pairing that answered hello: every live
   * subscription subscribes again there from this computer's cursor, and once each has its head they all move
   * over and new calls use `next`; one subscribed meanwhile moves with them. If any fails first, nothing moves and
   * the old path stays (it rejects). Calls
   * already running stay on the old connection; `drained` waits for them.
   */
  async switchTo(next: EngineConnection, deadlineMs: number): Promise<EngineConnection> {
    if (this.state() !== 'open' || !next.isOpen()) throw new NetError('peer_offline')
    const old = this.current
    const prepared: Prepared[] = []
    const moving = new Set<LiveSubscription>()
    try {
      // A subscription opened while these prepare (it starts on the old path) is prepared too, until none is
      // left: from the last check to the move nothing waits, so none can open in between.
      for (;;) {
        const fresh = [...this.subscriptions].filter((subscription) => !moving.has(subscription))
        if (!fresh.length) break
        for (const subscription of fresh) moving.add(subscription)
        await Promise.all(
          fresh.map(async (subscription) => {
            const ready = await subscription.prepare(next, deadlineMs)
            if (ready) prepared.push(ready)
          })
        )
        if (this.state() !== 'open' || !next.isOpen()) throw new NetError('peer_offline')
      }
    } catch (error) {
      for (const ready of prepared) ready.abort()
      throw error
    }
    this.current = next
    this.previous.add(old)
    this.watch(next)
    for (const ready of prepared) ready.commit()
    return old
  }

  /**
   * Resolves once nothing sent on `old` waits for its answer, or after `ms` (the calls left are cut off when
   * `old` closes and asked for again on the current connection), or when `old` closes.
   */
  drained(old: EngineConnection, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (this.running.get(old)?.size && old.isOpen() && !this.closed) return
        clearTimeout(timer)
        this.settledListeners.delete(check)
        resolve()
      }
      const timer = setTimeout(() => {
        this.settledListeners.delete(check)
        resolve()
      }, ms)
      this.settledListeners.add(check)
      check()
    })
  }

  /** Ends this computer's use of every connection it holds (the current one and old ones still draining). */
  close(reason: string): void {
    for (const connection of [...this.previous]) connection.close(reason)
    this.current.close(reason)
  }

  private wake(): void {
    for (const listener of [...this.settledListeners]) listener()
  }

  /** @internal A delta a subscription received. */
  emit(stream: StreamId, data: unknown): void {
    this.emitDelta(stream, data)
  }

  onEphemeral(listener: (message: EphemeralMessage) => void): () => void {
    this.ephemeralListeners.add(listener)
    return () => this.ephemeralListeners.delete(listener)
  }

  onClosed(listener: (error?: Error) => void): () => void {
    this.closedListeners.add(listener)
    return () => this.closedListeners.delete(listener)
  }

  private emitDelta(stream: StreamId, data: unknown): void {
    const message: EphemeralMessage = { t: 'ephemeral', stream, kind: 'delta', data }
    for (const listener of [...this.ephemeralListeners]) {
      try {
        listener(message)
      } catch {
        /* Independent listeners. */
      }
    }
  }

  /**
   * Opens a stream, sends one request and waits for its answer (`result`, or the message named in `until`).
   * A lost connection is `peer_offline`, the deadline `deadline_exceeded`, the signal `cancelled`.
   */
  private exchange(
    label: EngineLabel,
    header: EngineMessage['header'],
    parts: Uint8Array[],
    options: {
      deadlineMs: number
      signal?: AbortSignal
      onProgress?: (data: unknown) => void
      onMessage?: (message: EngineMessage) => void
      until?: string
      keepOpen?: boolean
      after?: (channel: Channel) => void | Promise<void>
    }
  ): Promise<EngineMessage> {
    if (this.state() !== 'open') return Promise.reject(new NetError('peer_offline'))
    if (options.signal?.aborted) return Promise.reject(new NetError('cancelled'))
    return new Promise<EngineMessage>((resolve, reject) => {
      const method = typeof header.method === 'string' ? header.method : undefined
      const on = this.current
      const channel = new Channel(on.open(label, method))
      const lost = (): void => finish(new NetError('peer_offline'))
      const running = this.running.get(on) ?? new Set<() => void>()
      running.add(lost)
      this.running.set(on, running)
      let settled = false
      const finish = (error: NetError | undefined, message?: EngineMessage): void => {
        if (settled) return
        settled = true
        running.delete(lost)
        if (!running.size && this.running.get(on) === running) this.running.delete(on)
        this.wake()
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (error) {
          channel.reset(error.code)
          reject(error)
        } else {
          if (!options.keepOpen) channel.end()
          resolve(message!)
        }
      }
      const abort = (): void => finish(new NetError('cancelled'))
      const timer = setTimeout(() => finish(new NetError('deadline_exceeded')), options.deadlineMs)
      options.signal?.addEventListener('abort', abort, { once: true })
      channel.onEnd(() => finish(new NetError('peer_offline')))
      channel.onMessage((message) => {
        const t = message.header.t
        if (t === 'error') return finish(fromWireError(message.header.error))
        if (t === 'progress') {
          try {
            options.onProgress?.(message.header.data)
          } catch {
            /* A progress listener does not end the call. */
          }
          return
        }
        if (t === (options.until ?? 'result')) return finish(undefined, message)
        try {
          options.onMessage?.(message)
        } catch (error) {
          finish(error instanceof NetError ? error : new NetError('internal'))
        }
      })
      const failed = (error: unknown): void =>
        finish(error instanceof NetError ? error : new NetError('internal'))
      try {
        channel.send(header, parts)
        void Promise.resolve(options.after?.(channel)).catch(failed)
      } catch (error) {
        failed(error)
      }
    })
  }
}

/** A subscription subscribed again on a renewed connection, waiting to move there. */
interface Prepared {
  commit(): void
  abort(): void
}

type ErrorCode = import('../../../shared/net/errors').NetErrorCode

/**
 * One subscription of a client. Its channel is on the client's current connection; a path switch subscribes it
 * again on the renewed one (`prepare`) and moves it there (`commit`), so whoever holds it sees no change.
 */
class LiveSubscription {
  private channel?: Channel
  private stopped = false
  private snapshotHead?: StreamHead
  private readonly offClosed: () => void
  private readonly receiver: SubscriptionReceiver
  constructor(
    private readonly client: EngineClient,
    readonly stream: StreamId,
    handlers: SubscriptionHandlers,
    private readonly gone: () => void
  ) {
    const { port } = client
    this.offClosed = client.onClosed(() => this.fail('peer_offline'))
    this.receiver = new SubscriptionReceiver(
      stream,
      port.store,
      handlers,
      (record, snapshot) => port.verify(stream, record, snapshot, client),
      (snapshot) => this.send(snapshot ? { t: 'snapshot.get' } : this.subscribeHeader())
    )
  }

  start(): void {
    const channel = new Channel(this.client.connection.open('mousse.sub'))
    this.channel = channel
    channel.onEnd((reason) => this.ended(channel, reason))
    channel.onMessage((message) => {
      if (this.channel === channel) this.handle(message)
    })
    this.send(this.subscribeHeader())
  }

  /**
   * Subscribes again on `next` from this computer's cursor and resolves once the owner answered with its head.
   * What comes after waits until `commit`. Nothing to move (stopped) resolves undefined.
   */
  prepare(next: EngineConnection, deadlineMs: number): Promise<Prepared | undefined> {
    if (this.stopped) return Promise.resolve(undefined)
    return new Promise<Prepared | undefined>((resolve, reject) => {
      const channel = new Channel(next.open('mousse.sub'))
      const early: EngineMessage[] = []
      let phase: 'waiting' | 'ready' | 'moved' | 'dropped' = 'waiting'
      let endedWith: { reason?: string } | undefined
      const drop = (): void => {
        if (phase === 'moved' || phase === 'dropped') return
        phase = 'dropped'
        clearTimeout(timer)
        this.closeChannel(channel)
      }
      const refuse = (error: NetError): void => {
        if (phase !== 'waiting') return
        drop()
        reject(error)
      }
      const timer = setTimeout(() => refuse(new NetError('deadline_exceeded')), deadlineMs)
      channel.onEnd((reason) => {
        if (phase === 'waiting') return refuse(new NetError('peer_offline'))
        if (phase === 'ready') endedWith = { ...(reason === undefined ? {} : { reason }) }
        else if (phase === 'moved') this.ended(channel, reason)
      })
      channel.onMessage((message) => {
        if (phase === 'moved') {
          if (this.channel === channel) this.handle(message)
          return
        }
        if (phase === 'dropped') return
        const t = message.header.t
        if (phase === 'waiting' && (t === 'end' || t === 'error'))
          return refuse(fromWireError(message.header.error))
        // Deltas are display notes the old channel carries until the move; this one's are not shown twice.
        if (t !== 'delta') early.push(message)
        if (phase === 'waiting' && t === 'subscribed') {
          phase = 'ready'
          clearTimeout(timer)
          resolve({ commit, abort: drop })
        }
      })
      const commit = (): void => {
        if (phase !== 'ready') return
        phase = 'moved'
        const old = this.channel
        this.channel = channel
        this.closeChannel(old)
        if (this.stopped) return drop()
        // From the head the owner gave here: what the old channel already stored is skipped as a repeat.
        this.receiver.close()
        for (const message of early.splice(0)) {
          if (this.stopped || this.channel !== channel) return
          this.handle(message.header.t === 'subscribed' ? this.caughtUpTo(message) : message)
        }
        if (endedWith) this.ended(channel, endedWith.reason)
      }
      try {
        channel.send(this.subscribeHeader())
      } catch {
        refuse(new NetError('peer_offline'))
      }
    })
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    this.offClosed()
    this.gone()
    this.receiver.close()
    this.closeChannel(this.channel)
  }

  /**
   * Ends a subscription's stream cleanly (`unsubscribe` + FIN) and resets it after a short linger if an older peer
   * leaves its half open, so it never leaks a connection stream slot.
   */
  private closeChannel(channel: Channel | undefined): void {
    if (!channel) return
    const alreadyEnded = !channel.isOpen()
    let peerEnded = alreadyEnded
    const timer = alreadyEnded
      ? undefined
      : setTimeout(() => {
          if (!peerEnded) channel.reset('cancelled')
        }, engineLimits().tunnelCloseLingerMs)
    timer?.unref?.()
    if (!alreadyEnded) {
      channel.onEnd(() => {
        peerEnded = true
        clearTimeout(timer)
      })
    }
    try {
      channel.send({ t: 'unsubscribe' })
      channel.end()
    } catch {
      clearTimeout(timer)
      channel.reset('cancelled')
    }
  }

  /**
   * The new channel's `subscribed`, with its head moved up to the cursor here when the old channel stored more
   * since (same generation): those records come on the new channel too and are skipped as repeats.
   */
  private caughtUpTo(message: EngineMessage): EngineMessage {
    const head = message.header.head as StreamHead | undefined
    const cursor = this.client.port.store.cursor(this.stream)
    if (!head || cursor.epoch !== head.epoch || cursor.seq <= head.seq) return message
    return {
      ...message,
      header: {
        ...message.header,
        head: { epoch: head.epoch, seq: cursor.seq },
        replayThrough: cursor.seq
      }
    }
  }

  private subscribeHeader(): EngineMessage['header'] {
    return {
      t: 'subscribe',
      stream: this.stream,
      after: this.client.port.store.cursor(this.stream)
    }
  }

  private ended(channel: Channel, reason: string | undefined): void {
    if (this.channel !== channel) return
    this.fail(reason === undefined ? 'cancelled' : 'peer_offline')
  }

  private fail(code: ErrorCode): void {
    if (this.stopped) return
    this.stopped = true
    this.offClosed()
    this.gone()
    this.channel?.reset(code)
    this.receiver.error(code)
  }

  private send(header: EngineMessage['header']): void {
    if (this.stopped) return
    try {
      this.channel!.send(header)
    } catch (error) {
      this.fail(error instanceof NetError ? error.code : 'internal')
    }
  }

  private handle(message: EngineMessage): void {
    if (this.stopped) return
    const h = message.header
    try {
      switch (h.t) {
        case 'subscribed':
          this.snapshotHead = h.head as StreamHead
          return this.receiver.subscribed(h.head as StreamHead, Number(h.replayThrough))
        case 'records':
          return this.receiver.receive(recordsOf(message))
        case 'caughtUp':
          return this.receiver.caughtUp()
        case 'snapshotRequired':
          return this.receiver.snapshotRequired(h.head as StreamHead)
        case 'snapshot':
          return this.receiver.snapshotChunk(
            h.target as StreamHead,
            recordsOf(message),
            h.done === true
          )
        case 'delta':
          return this.client.emit(this.stream, h.data)
        case 'end':
        case 'error':
          return this.fail(fromWireError(h.error).code)
        default:
          throw new NetError('bad_request')
      }
    } catch (error) {
      // The cursor here is ahead of or in another generation than the owner's: take its snapshot.
      if (error instanceof NetError && error.code === 'snapshot_required' && this.snapshotHead)
        return this.receiver.snapshotRequired(this.snapshotHead)
      this.fail(error instanceof NetError ? error.code : 'internal')
    }
  }
}

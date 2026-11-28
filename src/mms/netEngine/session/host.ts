import { NetError } from '../../../shared/net/errors'
import type {
  BlobId,
  EventId,
  RpcId,
  StoredRecord,
  StreamHead,
  StreamId
} from '../../../shared/net'
import type { AppendOutcome, BlobStore, EngineCaller, StreamStore } from '../../net/contracts'
import type { DurableRpcDispatcher } from '../../net/sync/rpcDispatcher'
import { engineControl, engineLimits } from '../limits'
import { isBotNetMethod } from '../../../shared/bots/personal/methodTable'
import type { EngineMessage } from './frame'
import {
  Channel,
  SESSION_FEATURES,
  toWireError,
  type EngineConnection,
  type EngineStream
} from './transport'

/** The bytes of records one message may carry: the rest of it is the header's. */
const recordsBudget = (): number => engineLimits().maxMessageBytes - engineLimits().headerReserveBytes

/** What the host side of an engine session needs from the profile. */
export interface EngineHostPort {
  rpc: Pick<DurableRpcDispatcher, 'dispatch' | 'result' | 'cancel'>
  store: StreamStore
  blobs: BlobStore
  now(): number
  /** The caller behind an inbound connection now: a serving pairing whose grant matches, or a refusal. */
  caller(connection: EngineConnection): EngineCaller
  /** Aborted when the pairing is revoked or removed (`teardown`); a lost connection does not abort handlers. */
  revoked(caller: EngineCaller): AbortSignal
  /** §4.4: throws `forbidden` unless the caller may read `stream` now. Checked for every batch. */
  assertReadable(stream: StreamId, caller: EngineCaller): void
  canFetchBlob(stream: StreamId, blob: BlobId, caller: EngineCaller): boolean
  /** Request artifacts: the only streams a caller writes into (its own input artifacts). */
  artifacts: {
    acceptBlob(stream: StreamId, blob: BlobId, bytes: number, sealed: boolean, caller: EngineCaller): void
    blobCommitted(stream: StreamId, blob: BlobId, bytes: number, sealed: boolean, caller: EngineCaller): void
    append(stream: StreamId, id: EventId, envelope: Uint8Array, sig: Uint8Array, caller: EngineCaller): AppendOutcome
  }
  name(): string
  /**
   * The joiner asks for the other direction (§5.1 step 5): this computer records its addresses and connects back.
   * Resolves once its own `hello` there was answered; the reply is `pairback.done`.
   */
  pairback?(caller: EngineCaller, request: { routes: string[]; receipt?: string }): Promise<void>
  /** A `mousse.tunnel` stream from a caller this connection serves: one editor tunnel (Phase 1b §9.2). */
  tunnel?(connection: EngineConnection, stream: EngineStream): void
  /**
   * Whether `stream` is a bot stream (the bots feed, a bot's chat): those are served on `mousse.botsub` alone, and every
   * other on `mousse.sub` alone. Absent: no stream is a bot's.
   */
  botStream?(stream: StreamId): boolean
  /** The method of an earlier call of `caller`'s, by its id, so its result is asked for on the label it rode on. */
  callMethod?(id: RpcId, caller: EngineCaller): string | undefined
  /** A `mousse.botview` stream from a caller this connection serves: one live view of a bot's browser. */
  botview?(connection: EngineConnection, stream: EngineStream): void
  /** The caller said its name in `hello` (`<computer> (<profile>)`, or empty) and its app's session features. */
  calledBy?(caller: EngineCaller, name: string, features: string[]): void
  /** The session features said in the hello reply (`SESSION_FEATURES` without it). */
  features?(): readonly string[]
  /**
   * The caller opened its `access.*` exchange (`access.open`) on `channel`, and later messages on it. The caller is
   * checked again for each one; without this port `access.open` is `bad_request`.
   */
  access?: {
    open(caller: EngineCaller, connection: EngineConnection, channel: Channel): void
    message(caller: EngineCaller, channel: Channel, header: EngineMessage['header']): void
  }
}

/**
 * Serves one inbound engine connection: the calls, subscriptions, blob reads and staged writes of the pairing
 * it belongs to. Nothing is served to a caller whose pairing is not serving or whose grant does not match, and
 * every delivered batch is checked again (§4.4).
 */
export class EngineHost {
  private readonly subscriptions = new Set<HostSubscription>()
  /** The caller's `access.*` exchanges on this connection (opened with `access.open`). */
  private readonly accessChannels = new WeakSet<Channel>()
  private closed = false
  constructor(
    readonly connection: EngineConnection,
    private readonly port: EngineHostPort
  ) {
    connection.onStream((stream) => this.accept(stream))
    connection.onClose(() => this.close())
  }

  /** Sends what was added to a stream to each subscription that is caught up on it. */
  notify(stream: StreamId): void {
    for (const sub of this.subscriptions) if (sub.stream === stream) sub.pump()
  }
  publishDelta(stream: StreamId, data: unknown, key?: string): void {
    for (const sub of this.subscriptions) if (sub.stream === stream) sub.delta(data, key)
  }
  fail(stream: StreamId, code: import('../../../shared/net').NetErrorCode): void {
    for (const sub of [...this.subscriptions]) if (sub.stream === stream) sub.end(new NetError(code))
  }
  serves(stream: StreamId): boolean {
    for (const sub of this.subscriptions) if (sub.stream === stream && sub.live) return true
    return false
  }
  /** Ends every subscription this connection serves (a revocation, or a stream closed for its reader). */
  endSubscriptions(filter?: (stream: StreamId) => boolean): void {
    for (const sub of [...this.subscriptions])
      if (!filter || filter(sub.stream)) sub.end(new NetError('forbidden'))
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const sub of [...this.subscriptions]) sub.drop()
  }

  private accept(stream: EngineStream): void {
    if (stream.label === 'mousse.tunnel' || stream.label === 'mousse.botview') {
      // The tunnels and the browser views read their own stream; the caller is checked here first, and each one's own
      // refusal as it opens (the editor's; the bot level and the bot's Devices).
      try {
        if (this.closed) throw new NetError('peer_offline')
        this.port.caller(this.connection)
      } catch {
        stream.reset('forbidden')
        return
      }
      const serve = stream.label === 'mousse.tunnel' ? this.port.tunnel : this.port.botview
      if (serve) serve(this.connection, stream)
      else stream.reset('not_supported')
      return
    }
    const channel = new Channel(stream)
    let count = 0
    let sub: HostSubscription | undefined
    const refuse = (error: unknown): void => {
      // Once this side has answered (an upload refused at its first message, whose chunks were already on the
      // way), what follows is read and dropped: a reset now could discard the answer before it leaves.
      if (!channel.isOpen()) return
      try {
        channel.send({ t: 'error', error: toWireError(error) })
        channel.end()
      } catch {
        channel.reset('internal')
      }
    }
    channel.onMessage((message) => {
      const first = count++ === 0
      try {
        if (this.closed) throw new NetError('peer_offline')
        // Read for every message: a pairing removed or a grant replaced serves nothing more.
        const caller = this.port.caller(this.connection)
        if (stream.label === 'mousse.sub' || stream.label === 'mousse.botsub') {
          if (first) {
            if (message.header.t !== 'subscribe') throw new NetError('bad_request')
            // A bot stream only on the bot label, and every other stream only on the thread one.
            const bot = this.port.botStream?.(message.header.stream as StreamId) === true
            if (bot !== (stream.label === 'mousse.botsub')) throw new NetError('forbidden')
            const created = new HostSubscription(
              message.header.stream as StreamId,
              channel,
              caller,
              this.port,
              () => this.subscriptions.delete(created)
            )
            sub = created
            this.subscriptions.add(created)
            channel.onEnd(() => created.drop())
          }
          sub?.request(message.header)
          return
        }
        void this.route(stream.label, channel, message, first, caller, stream.role).catch(refuse)
      } catch (error) {
        if (sub) sub.end(error)
        else refuse(error)
      }
    })
  }

  private async route(
    label: EngineStream['label'],
    channel: Channel,
    message: EngineMessage,
    first: boolean,
    caller: EngineCaller,
    /** The role of the grant the stream is served under, when the helper named it. */
    role?: string
  ): Promise<void> {
    const h = message.header
    switch (label) {
      case 'mousse.hello':
        if (this.accessChannels.has(channel)) {
          this.port.access!.message(caller, channel, h)
          return
        }
        if (h.t === 'access.open') {
          if (!first || !this.port.access) throw new NetError('bad_request')
          this.accessChannels.add(channel)
          this.port.access.open(caller, this.connection, channel)
          return
        }
        if (h.t === 'hello') {
          const features = Array.isArray(h.features)
            ? h.features.filter((feature): feature is string => typeof feature === 'string')
            : []
          this.port.calledBy?.(caller, typeof h.name === 'string' ? h.name : '', features)
          // The caller's role here now (§8.4): it learns a role edit from the hello of the connection the edit
          // makes it open again. It only records it; this side enforces from its own grant.
          channel.send({
            t: 'hello',
            proto: 1,
            name: this.port.name(),
            features: [...(this.port.features?.() ?? SESSION_FEATURES)],
            ...(role ? { role } : {})
          })
        }
        else if (h.t === 'pairback') {
          if (!this.port.pairback) throw new NetError('bad_request')
          const routes = Array.isArray(h.routes)
            ? h.routes.filter((route): route is string => typeof route === 'string')
            : []
          await this.port.pairback(caller, {
            routes,
            ...(typeof h.receipt === 'string' ? { receipt: h.receipt } : {})
          })
          channel.send({ t: 'pairback.done' })
          channel.end()
        } else throw new NetError('bad_request')
        return
      case 'mousse.rpc':
      case 'mousse.botrpc':
        if (!first) throw new NetError('bad_request')
        return this.rpc(channel, h, caller, label === 'mousse.botrpc')
      case 'mousse.sub':
      case 'mousse.botsub':
      case 'mousse.botview':
        return
      case 'mousse.blob':
        if (!first || h.t !== 'get') throw new NetError('bad_request')
        return this.blob(channel, h.stream as StreamId, h.blob as BlobId, caller)
      case 'mousse.put':
        return this.put(channel, message, caller, first)
      case 'mousse.tunnel':
        return
    }
  }

  /** `bot`: the call came on the bot label, which carries bot calls alone; the thread label carries no bot call. */
  private async rpc(channel: Channel, h: EngineMessage['header'], caller: EngineCaller, bot: boolean): Promise<void> {
    const deadlineMs = Number(h.deadline)
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > engineLimits().maxCallDeadlineMs)
      throw new NetError('bad_request')
    const id = h.id as RpcId
    if (h.t === 'cancel' || h.t === 'result.get') {
      const method = this.port.callMethod?.(id, caller)
      if (method !== undefined && isBotNetMethod(method) !== bot) throw new NetError('forbidden')
    } else if (h.t === 'call' && typeof h.method === 'string' && isBotNetMethod(h.method) !== bot)
      throw new NetError('forbidden')
    if (h.t === 'cancel') {
      await this.port.rpc.cancel(id, caller)
      channel.send({ t: 'result', result: null })
      channel.end()
      return
    }
    if (h.t === 'result.get') {
      const result = await this.port.rpc.result(id, caller, {
        deadlineAt: this.port.now() + deadlineMs,
        signal: this.port.revoked(caller)
      })
      channel.send({ t: 'result', result })
      channel.end()
      return
    }
    if (h.t !== 'call' || typeof h.method !== 'string') throw new NetError('bad_request')
    // A handler runs to its deadline: a lost connection does not stop it (the caller asks for its result on the
    // next one); only a revocation does.
    const deadline = AbortSignal.timeout(deadlineMs)
    const signals = [deadline, this.port.revoked(caller)]
    // The path-switch check's control: the old path closing (PATH_REPLACED) aborts what still runs on it.
    if (engineControl('abort-on-path-replaced')) {
      const replaced = new AbortController()
      this.connection.onClose(() => replaced.abort(new NetError('peer_offline')))
      signals.push(replaced.signal)
    }
    const signal = AbortSignal.any(signals)
    try {
      const result = await this.port.rpc.dispatch(
        h.method,
        h.params,
        typeof h.idem === 'string' ? h.idem : undefined,
        {
          id,
          caller,
          signal,
          deadlineAt: this.port.now() + deadlineMs,
          progress: (data) => {
            if (channel.isOpen()) channel.send({ t: 'progress', data })
          }
        }
      )
      if (!channel.isOpen()) return
      channel.send({ t: 'result', result })
      channel.end()
    } catch (error) {
      if (!channel.isOpen()) return
      channel.send({ t: 'error', error: toWireError(error) })
      channel.end()
    }
  }

  private async blob(channel: Channel, stream: StreamId, blob: BlobId, caller: EngineCaller): Promise<void> {
    if (!this.port.canFetchBlob(stream, blob, caller)) throw new NetError('forbidden')
    const size = this.port.blobs.size(blob)
    const { maxBlobBytes, blobChunkBytes } = engineLimits()
    if (size === undefined || size > maxBlobBytes) throw new NetError('bad_request')
    channel.send({ t: 'blob', bytes: size })
    for (let at = 0; at < size; at += blobChunkBytes) {
      if (!channel.isOpen()) return
      if (!this.port.canFetchBlob(stream, blob, caller)) throw new NetError('forbidden')
      channel.send({ t: 'bytes' }, [this.port.blobs.read(blob, at, Math.min(blobChunkBytes, size - at))])
      // A slow reader holds the next chunk back here, not in memory.
      await channel.drained()
    }
    if (!channel.isOpen()) return
    channel.send({ t: 'done' })
    channel.end()
  }

  private readonly uploads = new WeakMap<
    Channel,
    { stream: StreamId; blob: BlobId; bytes: number; upload: ReturnType<BlobStore['begin']>; at: number }
  >()
  private async put(channel: Channel, message: EngineMessage, caller: EngineCaller, first: boolean): Promise<void> {
    const h = message.header
    if (first && h.t === 'append') {
      const [envelope, sig] = message.parts
      if (!envelope || !sig) throw new NetError('bad_request')
      const outcome = this.port.artifacts.append(h.stream as StreamId, h.id as EventId, envelope, sig, caller)
      channel.send({ t: 'appended', epoch: outcome.epoch, seq: outcome.seq, recvTs: outcome.recvTs })
      channel.end()
      return
    }
    if (first && h.t === 'blob.put') {
      const stream = h.stream as StreamId,
        blob = h.blob as BlobId,
        bytes = Number(h.bytes)
      if (h.sealed !== false || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > engineLimits().maxBlobBytes)
        throw new NetError('forbidden')
      this.port.artifacts.acceptBlob(stream, blob, bytes, false, caller)
      this.uploads.set(channel, { stream, blob, bytes, upload: this.port.blobs.begin(blob, bytes, false), at: 0 })
      channel.onEnd((reason) => {
        if (reason !== undefined) this.uploads.get(channel)?.upload.abort()
      })
      return
    }
    const upload = this.uploads.get(channel)
    if (!upload) throw new NetError('bad_request')
    try {
      this.port.artifacts.acceptBlob(upload.stream, upload.blob, upload.bytes, false, caller)
      if (h.t === 'bytes') {
        const part = message.parts[0]
        if (!part || upload.at + part.byteLength > upload.bytes) throw new NetError('bad_request')
        upload.upload.write(upload.at, part)
        upload.at += part.byteLength
        return
      }
      if (h.t !== 'commit' || upload.at !== upload.bytes) throw new NetError('bad_request')
      upload.upload.commit()
      this.uploads.delete(channel)
      this.port.artifacts.blobCommitted(upload.stream, upload.blob, upload.bytes, false, caller)
      channel.send({ t: 'stored' })
      channel.end()
    } catch (error) {
      this.uploads.delete(channel)
      upload.upload.abort()
      throw error
    }
  }
}

/**
 * One subscription served to a caller: replay from its cursor, then live records as they are stored, each
 * batch checked again. A cursor the store cannot serve gets `snapshotRequired`, and the caller asks for the
 * snapshot on the same stream.
 */
class HostSubscription {
  live = false
  private cursor?: StreamHead
  private pumping = false
  private ended = false
  /** Counts each `subscribe` and `snapshot.get`: a replay or snapshot that waited for room stops if a newer one began. */
  private run = 0
  constructor(
    readonly stream: StreamId,
    private readonly channel: Channel,
    private readonly caller: EngineCaller,
    private readonly port: EngineHostPort,
    private readonly forget: () => void
  ) {}

  request(h: EngineMessage['header']): void {
    if (this.ended) return
    const run = ++this.run
    const done = (work: Promise<void>): void =>
      void work.catch((error) => {
        if (this.run === run) this.end(error)
      })
    try {
      if (h.t === 'subscribe') done(this.serve(h.after as StreamHead, run))
      else if (h.t === 'snapshot.get') done(this.snapshot(run))
      else if (h.t === 'unsubscribe') this.drop()
      else throw new NetError('bad_request')
    } catch (error) {
      this.end(error)
    }
  }

  /** Waits for room on the stream; answers whether this run still goes on. */
  private async room(run: number): Promise<boolean> {
    await this.channel.drained()
    return this.run === run && !this.ended && this.channel.isOpen()
  }

  private async serve(after: StreamHead, run: number): Promise<void> {
    if (
      !after ||
      !Number.isSafeInteger(after.epoch) ||
      !Number.isSafeInteger(after.seq) ||
      after.epoch < 0 ||
      after.seq < 0
    )
      throw new NetError('bad_request')
    this.live = false
    this.port.assertReadable(this.stream, this.caller)
    const store = this.port.store
    if (store.snapshotReason(this.stream, after)) return this.requireSnapshot()
    const head = store.head(this.stream)
    this.channel.send({ t: 'subscribed', head, replayThrough: head.seq })
    let cursor = { ...after }
    while (cursor.seq < head.seq) {
      const page = this.page(cursor, head.seq)
      if (!page) return this.requireSnapshot()
      cursor = this.send(page)
      if (!(await this.room(run))) return
    }
    this.port.assertReadable(this.stream, this.caller)
    this.channel.send({ t: 'caughtUp' })
    this.cursor = cursor
    this.live = true
    this.pump()
  }

  /**
   * Sends what was stored after the cursor. Runs on every notification; a batch is checked before it goes, and the
   * next waits for room on the stream (a notification meanwhile finds the pump running, which reads to the head).
   */
  pump(): void {
    void this.pumpPages()
  }
  private async pumpPages(): Promise<void> {
    if (!this.live || this.pumping || this.ended || !this.cursor) return
    this.pumping = true
    const run = this.run
    try {
      for (;;) {
        const head = this.port.store.head(this.stream)
        if (head.epoch !== this.cursor.epoch) {
          this.live = false
          return this.requireSnapshot()
        }
        if (head.seq <= this.cursor.seq) return
        const page = this.page(this.cursor, head.seq)
        if (!page) {
          this.live = false
          return this.requireSnapshot()
        }
        this.cursor = this.send(page)
        if (!(await this.room(run)) || !this.live || !this.cursor) return
      }
    } catch (error) {
      this.end(error)
    } finally {
      this.pumping = false
    }
  }

  delta(data: unknown, key?: string): void {
    if (!this.live || this.ended) return
    try {
      this.port.assertReadable(this.stream, this.caller)
      this.channel.send({ t: 'delta', data, ...(key === undefined ? {} : { key }) })
    } catch (error) {
      this.end(error)
    }
  }

  private async snapshot(run: number): Promise<void> {
    this.live = false
    const reader = this.port.store.openSnapshot(this.stream)
    try {
      let done = false
      while (!done) {
        this.port.assertReadable(this.stream, this.caller)
        const page = reader.next(recordsBudget(), engineLimits().recordsPerMessage)
        done = page.done
        if (!done && !page.records.length) throw new NetError('storage_corrupt')
        this.channel.send(
          { t: 'snapshot', target: reader.target, done, records: page.records.map(meta) },
          parts(page.records)
        )
        if (!done && !(await this.room(run))) return
      }
    } finally {
      reader.close()
    }
  }

  private requireSnapshot(): void {
    this.channel.send({ t: 'snapshotRequired', head: this.port.store.head(this.stream) })
  }

  private page(cursor: StreamHead, through: number): StoredRecord[] | undefined {
    try {
      const page = this.port.store.read(this.stream, cursor, through, recordsBudget())
      if (!page.records.length) throw new NetError('storage_corrupt')
      return page.records
    } catch (error) {
      if (error instanceof NetError && error.code === 'snapshot_required') return undefined
      throw error
    }
  }

  private send(records: StoredRecord[]): StreamHead {
    this.port.assertReadable(this.stream, this.caller)
    this.channel.send({ t: 'records', records: records.map(meta) }, parts(records))
    const last = records.at(-1)!
    return { epoch: last.epoch, seq: last.seq }
  }

  end(error: unknown): void {
    if (this.ended) return
    try {
      if (this.channel.isOpen()) {
        this.channel.send({ t: 'end', error: toWireError(error) })
        this.channel.end()
      }
    } catch {
      this.channel.reset('internal')
    }
    this.drop()
  }

  drop(): void {
    if (this.ended) return
    this.ended = true
    this.live = false
    this.forget()
    // End this computer's half of the stream so neither side's helper keeps a half-closed stream open.
    try {
      this.channel.end()
    } catch {
      this.channel.reset('cancelled')
    }
  }
}

const meta = (record: StoredRecord) => ({ epoch: record.epoch, seq: record.seq, recvTs: record.recvTs })
const parts = (records: StoredRecord[]): Uint8Array[] =>
  records.flatMap((record) => [record.envelope, record.sig])

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
import { engineLimits } from '../limits'
import type { EngineMessage } from './frame'
import { Channel, toWireError, type EngineConnection, type EngineStream } from './transport'

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
}

/**
 * Serves one inbound engine connection: the calls, subscriptions, blob reads and staged writes of the pairing
 * it belongs to. Nothing is served to a caller whose pairing is not serving or whose grant does not match, and
 * every delivered batch is checked again (§4.4).
 */
export class EngineHost {
  private readonly subscriptions = new Set<HostSubscription>()
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
    const channel = new Channel(stream)
    let count = 0
    let sub: HostSubscription | undefined
    const refuse = (error: unknown): void => {
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
        if (stream.label === 'mousse.sub') {
          if (first) {
            if (message.header.t !== 'subscribe') throw new NetError('bad_request')
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
        void this.route(stream.label, channel, message, first, caller).catch(refuse)
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
    caller: EngineCaller
  ): Promise<void> {
    const h = message.header
    switch (label) {
      case 'mousse.hello':
        if (h.t === 'hello') channel.send({ t: 'hello', proto: 1, name: this.port.name() })
        return
      case 'mousse.rpc':
        if (!first) throw new NetError('bad_request')
        return this.rpc(channel, h, caller)
      case 'mousse.sub':
        return
      case 'mousse.blob':
        if (!first || h.t !== 'get') throw new NetError('bad_request')
        return this.blob(channel, h.stream as StreamId, h.blob as BlobId, caller)
      case 'mousse.put':
        return this.put(channel, message, caller, first)
    }
  }

  private async rpc(channel: Channel, h: EngineMessage['header'], caller: EngineCaller): Promise<void> {
    const deadlineMs = Number(h.deadline)
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > engineLimits().maxCallDeadlineMs)
      throw new NetError('bad_request')
    const id = h.id as RpcId
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
    const signal = AbortSignal.any([deadline, this.port.revoked(caller)])
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
    }
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
  constructor(
    readonly stream: StreamId,
    private readonly channel: Channel,
    private readonly caller: EngineCaller,
    private readonly port: EngineHostPort,
    private readonly forget: () => void
  ) {}

  request(h: EngineMessage['header']): void {
    if (this.ended) return
    try {
      if (h.t === 'subscribe') this.serve(h.after as StreamHead)
      else if (h.t === 'snapshot.get') this.snapshot()
      else if (h.t === 'unsubscribe') this.drop()
      else throw new NetError('bad_request')
    } catch (error) {
      this.end(error)
    }
  }

  private serve(after: StreamHead): void {
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
    }
    this.port.assertReadable(this.stream, this.caller)
    this.channel.send({ t: 'caughtUp' })
    this.cursor = cursor
    this.live = true
    this.pump()
  }

  /** Sends what was stored after the cursor. Runs on every notification; a batch is checked before it goes. */
  pump(): void {
    if (!this.live || this.pumping || this.ended || !this.cursor) return
    this.pumping = true
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

  private snapshot(): void {
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
  }
}

const meta = (record: StoredRecord) => ({ epoch: record.epoch, seq: record.seq, recvTs: record.recvTs })
const parts = (records: StoredRecord[]): Uint8Array[] =>
  records.flatMap((record) => [record.envelope, record.sig])

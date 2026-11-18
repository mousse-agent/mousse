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
import { Channel, fromWireError, type EngineConnection, type EngineLabel } from './transport'

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
 * writes it makes to the pairing `connection.peer`.
 */
export class EngineClient implements BridgeClient {
  private readonly closedListeners = new Set<(error?: Error) => void>()
  private readonly ephemeralListeners = new Set<(message: EphemeralMessage) => void>()
  private closed = false
  constructor(
    readonly connection: EngineConnection,
    private readonly port: EngineClientPort
  ) {
    connection.onClose(() => {
      if (this.closed) return
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
  async hello(name: string, deadlineMs = engineLimits().helloDeadlineMs): Promise<{ name: string }> {
    const reply = await this.exchange('mousse.hello', { t: 'hello', proto: 1, name }, [], {
      deadlineMs,
      until: 'hello',
      keepOpen: true
    })
    return { name: String(reply.header.name ?? '') }
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
        after: (channel) => {
          const chunk = engineLimits().blobChunkBytes
          for (let at = 0; at < bytes.byteLength; at += chunk)
            channel.send({ t: 'bytes' }, [bytes.subarray(at, at + chunk)])
          channel.send({ t: 'commit' })
        }
      }
    )
  }

  subscribe(stream: StreamId, handlers: SubscriptionHandlers): { close(): void } {
    if (this.state() !== 'open') throw new NetError('peer_offline')
    let channel: Channel | undefined
    let stopped = false
    let snapshotHead: StreamHead | undefined
    const offClosed = this.onClosed(() => fail('peer_offline'))
    const fail = (code: import('../../../shared/net/errors').NetErrorCode): void => {
      if (stopped) return
      stopped = true
      offClosed()
      channel?.reset(code)
      receiver.error(code)
    }
    const send = (header: EngineMessage['header']): void => {
      if (stopped) return
      try {
        channel!.send(header)
      } catch (error) {
        fail(error instanceof NetError ? error.code : 'internal')
      }
    }
    const receiver = new SubscriptionReceiver(
      stream,
      this.port.store,
      handlers,
      (record, snapshot) => this.port.verify(stream, record, snapshot, this),
      (snapshot) =>
        send(snapshot ? { t: 'snapshot.get' } : { t: 'subscribe', stream, after: this.port.store.cursor(stream) })
    )
    channel = new Channel(this.connection.open('mousse.sub'))
    channel.onEnd((reason) => fail(reason === undefined ? 'cancelled' : 'peer_offline'))
    channel.onMessage((message) => {
      if (stopped) return
      const h = message.header
      try {
        switch (h.t) {
          case 'subscribed':
            snapshotHead = h.head as StreamHead
            return receiver.subscribed(h.head as StreamHead, Number(h.replayThrough))
          case 'records':
            return receiver.receive(recordsOf(message))
          case 'caughtUp':
            return receiver.caughtUp()
          case 'snapshotRequired':
            return receiver.snapshotRequired(h.head as StreamHead)
          case 'snapshot':
            return receiver.snapshotChunk(h.target as StreamHead, recordsOf(message), h.done === true)
          case 'delta':
            return this.emitDelta(stream, h.data)
          case 'end':
          case 'error':
            return fail(fromWireError(h.error).code)
          default:
            throw new NetError('bad_request')
        }
      } catch (error) {
        // The cursor here is ahead of or in another generation than the owner's: take its snapshot.
        if (error instanceof NetError && error.code === 'snapshot_required' && snapshotHead)
          return receiver.snapshotRequired(snapshotHead)
        fail(error instanceof NetError ? error.code : 'internal')
      }
    })
    send({ t: 'subscribe', stream, after: this.port.store.cursor(stream) })
    return {
      close: () => {
        if (stopped) return
        stopped = true
        offClosed()
        receiver.close()
        try {
          channel?.send({ t: 'unsubscribe' })
          channel?.end()
        } catch {
          channel?.reset('cancelled')
        }
      }
    }
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
      after?: (channel: Channel) => void
    }
  ): Promise<EngineMessage> {
    if (this.state() !== 'open') return Promise.reject(new NetError('peer_offline'))
    if (options.signal?.aborted) return Promise.reject(new NetError('cancelled'))
    return new Promise<EngineMessage>((resolve, reject) => {
      const method = typeof header.method === 'string' ? header.method : undefined
      const channel = new Channel(this.connection.open(label, method))
      let settled = false
      const finish = (error: NetError | undefined, message?: EngineMessage): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        offClosed()
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
      const offClosed = this.onClosed(() => finish(new NetError('peer_offline')))
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
      try {
        channel.send(header, parts)
        options.after?.(channel)
      } catch (error) {
        finish(error instanceof NetError ? error : new NetError('internal'))
      }
    })
  }
}

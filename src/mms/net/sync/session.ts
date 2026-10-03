import { createHash, timingSafeEqual } from 'node:crypto'
import type { BlobId, EventId, NodeDelegation, Roster, RpcArtifactRef, RpcId, Signed, SpaceId, SpaceDiscoveryGetMessage, SpaceIdentityGetMessage, SpaceStreamDiscoveryProof, StoredRecord, StreamDescriptor, StreamHead, StreamId, UserId, WireError, WireMessage } from '../../../shared/net'
import { isBlobId, isId } from '../../../shared/net/ids'
import { NetError, NET_ERRORS, type NetErrorCode } from '../../../shared/net/errors'
import { laneFor } from '../../../shared/net/wire'
import { SESSION_CAPABILITIES, type SessionCapability } from '../../../shared/net/capabilities'
import { BLOB_CHUNK_BYTES, DEFAULT_MAX_BLOB_BYTES, NET_PROTO_MAJOR, NET_PROTO_MINOR, PREAUTH_DEADLINE_MS, PREAUTH_MAX_BYTES, SESSION_MAX_BLOB_TRANSFERS, SESSION_MAX_INFLIGHT_RPCS, SESSION_MAX_SUBSCRIPTIONS, SESSION_PING_INTERVAL_MS, SESSION_MAX_SPACE_PROOFS, SPACE_PROOF_DEADLINE_MS } from '../../../shared/net/limits'
import { validateSignedDocument } from '../../../shared/net/schemas'
import type { BlobStore, BlobUpload, Clock, IdentityService, Mux, MuxMessage, QualifiedClockEstimate, SecureChannel, SessionState, SnapshotReader, StreamAuthority, StreamStore, SubscriptionHandlers, SyncSession } from '../contracts'
import { createMux } from '../link/mux'
import { systemClock } from '../clock'
import { decodeEnvelope, encodeMessage, parseProtocolJson } from './codec'
import { SubscriptionReceiver } from './subscription'

/** The durable RPC executor owns request aliases, idempotency and effect recovery. */
export interface SessionRpcPort {
  request(message: Extract<WireMessage, { t: 'rpc.request' }>, peer: SyncSession['peer'], signal: AbortSignal, progress: (data: unknown) => void): Promise<unknown>
  result(id: RpcId, peer: SyncSession['peer']): Promise<unknown>
  cancel(id: RpcId, peer: SyncSession['peer']): Promise<void>
}
export interface SessionDiscoveryPort {
  get(request:SpaceDiscoveryGetMessage,peer:SyncSession['peer']):SpaceStreamDiscoveryProof
  revalidate(request:SpaceDiscoveryGetMessage,proof:SpaceStreamDiscoveryProof,peer:SyncSession['peer']):void
  /** Original recipient leases needed by independently verified controls; retained as history only. */
  evidence?(request:SpaceDiscoveryGetMessage,proof:SpaceStreamDiscoveryProof,peer:SyncSession['peer']):readonly Signed[]
  /** Original recipient proof for incremental/snapshot controls, never CURRENT authority. */
  recordEvidence?(stream:StreamId,records:readonly StoredRecord[],peer:SyncSession['peer']):readonly Signed[]
}
export interface SessionIdentityPort {
  get(request:SpaceIdentityGetMessage,peer:SyncSession['peer']):Signed
  revalidate(request:SpaceIdentityGetMessage,roster:Signed,peer:SyncSession['peer']):void
}

export interface SyncSessionOptions {
  channel: SecureChannel
  /** Omit to construct the production mux with exact preauth byte accounting. */
  mux?: Mux
  /** Gateway-owned mux already accounts accepted application DATA bytes. */
  muxHasPreauthObserver?: boolean
  initialHello?: MuxMessage
  initialPreauthBytes?: number
  preauthDeadlineMs?: number
  identity: IdentityService
  store: StreamStore
  authority?: StreamAuthority
  blobs?: BlobStore
  rpc?: SessionRpcPort
  discovery?:SessionDiscoveryPort
  spaceIdentity?:SessionIdentityPort
  clock?: Clock
  capabilities?: SessionCapability[]
  /** Already trusted stream scope. Space membership/projection guards must be supplied. */
  canReceive?: (descriptor: StreamDescriptor, peer: SyncSession['peer']) => boolean
  verifyRecord?: (record: StoredRecord, descriptor: StreamDescriptor, snapshot: boolean) => void
  /** End-to-end current delegation, signature and persistent counter validation. */
  verifyPresence?: (message: Extract<WireMessage, { t: 'presence' }>, peer: SyncSession['peer']) => boolean
  localRoutes?: () => Signed
  onPeerRoutes?: (routes: Signed, peer: SyncSession['peer']) => void
  /** Bounded retained evidence for a prepared Space snapshot; never grants a pin. */
  retainRosterEvidence?: (roster: Signed, peer: SyncSession['peer']) => void
  onAuthenticated?: () => void
  signal?: AbortSignal
}

type Pending = { resolve(value: unknown): void; reject(error: unknown): void; cancel(): void; progress?: (value: unknown) => void; request?: WireMessage }
type Upload = { upload: BlobUpload; stream: StreamId; size: number; sealed: boolean }
type Download = { stream: StreamId; chunks: Buffer[]; bytes: number }
const equalKey = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'base64url'), y = Buffer.from(b, 'base64url')
  return x.length === y.length && timingSafeEqual(x, y)
}
function wireError(error: unknown): WireError {
  const code = error instanceof NetError ? error.code : 'internal'
  // Do not serialize arbitrary provider/OS messages, credentials or payloads.
  return { code, message: NET_ERRORS[code].message, retryable: NET_ERRORS[code].retryable }
}
const remoteError = (error: WireError): NetError => new NetError(error.code)

/** Authenticated normal session. Enrollment-only composition is implemented in P2. */
export class NetSyncSession implements SyncSession {
  private readonly clock: Clock
  private readonly mux: Mux
  private currentState: SessionState = 'connecting'
  private authenticatedPeer?: SyncSession['peer']
  private helloReceived = false
  private ackReceived = false
  private ackSent = false
  private preauthMessageBytes = 0
  private localCaps: SessionCapability[]
  private negotiatedCaps: SessionCapability[] = []
  private negotiatedMinor = NET_PROTO_MINOR
  private preauthBytes = 0
  private handshakeTimer: { cancel(): void }
  private pingTimer?: { cancel(): void }
  private expiryTimer?: { cancel(): void }
  private revocationTimer?: { cancel(): void }
  private revocationFence?: unknown
  private pingNumber = 0
  private unanswered = 0
  private probes = new Map<number, { wall: number; mono: number }>()
  private estimate?: QualifiedClockEstimate
  private subscriptions = new Map<StreamId, SubscriptionReceiver>()
  private serving = new Map<StreamId, { cancelled: boolean; live: boolean }>()
  private snapshotJobs = new Map<StreamId, { controller: AbortController; reader: SnapshotReader }>()
  private sendingUploads = new Set<BlobId>()
  private blobJobs = new Map<BlobId, AbortController>()
  private snapshotWaiting = new Set<StreamId>()
  private snapshotReceiving = new Set<StreamId>()
  private pending = new Map<string, Pending>()
  private uploads = new Map<BlobId, Upload>()
  private downloads = new Map<BlobId, Download>()
  private rpcControllers = new Map<RpcId, AbortController>()
  private spaceProofJobs=new Map<number,AbortController>()
  private spaceProofTimes:number[]=[]
  private ephemerals = new Set<(message: Extract<WireMessage, { t: 'presence' | 'ephemeral' }>) => void>()
  private closedListeners = new Set<(error?: Error) => void>()
  private cleanup: Array<() => void> = []
  private openResolve!: () => void
  private openReject!: (error: unknown) => void
  readonly opened: Promise<void>

  constructor(private readonly options: SyncSessionOptions) {
    this.clock = options.clock ?? systemClock
    const deadline = options.preauthDeadlineMs ?? PREAUTH_DEADLINE_MS
    const received = options.initialPreauthBytes ?? 0
    if (!Number.isSafeInteger(deadline) || deadline <= 0 || deadline > PREAUTH_DEADLINE_MS || !Number.isSafeInteger(received) || received < 0 || received > PREAUTH_MAX_BYTES || (options.initialHello && options.initialHello.header.t !== 'hello')) throw new NetError('bad_request')
    this.preauthBytes = received
    this.mux = options.mux ?? createMux(options.channel.stream, { clock: this.clock, onBytesReceived: count => this.recordPreauthBytes(count) })
    this.localCaps = [...new Set(options.capabilities ?? ['streams.v1' as const, ...(options.blobs ? ['blobs.v1' as const] : []), ...(options.rpc ? ['rpc.v1' as const] : []),...(options.discovery||options.spaceIdentity?['space.discovery.v1' as const]:[])])].filter(cap => cap !== 'presence.v1' || !!options.verifyPresence)
    this.opened = new Promise((resolve, reject) => { this.openResolve = resolve; this.openReject = reject })
    // Callers may attach their open handler after constructing the other endpoint.
    void this.opened.catch(() => {})
    this.handshakeTimer = this.clock.setTimeout(() => this.fail(new NetError('deadline_exceeded')), deadline)
    const count = (bytes: Buffer): void => {
      if (this.currentState === 'connecting') {
        this.preauthBytes += bytes.length
        if (this.preauthBytes > PREAUTH_MAX_BYTES) this.fail(new NetError('too_large'))
      }
    }
    if (options.mux && !options.muxHasPreauthObserver) {
      // Externally supplied muxes get a conservative raw byte guard, including frame overhead.
      options.channel.stream.on('data', count)
      this.cleanup.push(() => options.channel.stream.off('data', count))
    }
    this.cleanup.push(this.mux.onMessage((lane, message) => {
      if (this.currentState === 'closed' || this.currentState === 'closing') return
      if (this.revocationFence) return
      try {
        if (lane !== laneFor(message.header)) throw new NetError('bad_request')
        void this.receive(message).catch(error => this.fail(error))
      } catch (error) { this.fail(error) }
    }))
    this.cleanup.push(this.mux.onClose(error => this.fail(error ?? new NetError('peer_offline'), true)))
    this.cleanup.push(options.identity.onRosterChanged(user => {
      if (user === this.authenticatedPeer?.user || user === options.identity.self()?.user) {
        try {
          if (this.currentState === 'open') {
            this.revalidateIdentity(); this.refreshExpiry()
            if (user === options.identity.self()?.user) {
              const roster = options.identity.roster()
              if (roster) void this.send({ t: 'rosterUpdate', roster }).catch(error => this.fail(error))
            }
          }
        } catch (error) {
          const roster = user === options.identity.self()?.user ? options.identity.roster() : undefined
          if (this.currentState === 'open' && roster && error instanceof NetError && error.code === 'revoked' && !this.revocationFence) {
            // Fence work immediately, but flush signed revocation before teardown.
            this.revocationFence = error
            for (const controller of this.rpcControllers.values()) controller.abort()
            this.revocationTimer = this.clock.setTimeout(() => this.fail(error, true), 1000)
            void this.mux.send('control', { header: { t: 'rosterUpdate', roster }, parts: [] }).then(() => this.fail(error, true), () => this.fail(error, true))
          } else this.fail(error)
        }
      }
    }))
    if (options.signal) {
      const abort = (): void => this.fail(new NetError('cancelled'))
      options.signal.addEventListener('abort', abort, { once: true })
      this.cleanup.push(() => options.signal?.removeEventListener('abort', abort))
      if (options.signal.aborted) abort()
    }
    if (this.currentState !== 'closed') {
      try {
        const self = options.identity.self()
        if (!self) throw new NetError('not_enrolled')
        const roster = options.identity.roster()
        if (!roster) throw new NetError('not_enrolled')
        const delegation = this.currentDelegation(self.user, self.node)
        void this.send({ t: 'hello', protoMajor: NET_PROTO_MAJOR, protoMinor: NET_PROTO_MINOR, caps: this.localCaps, node: self.node, roster, delegation: delegation.signed, ...(options.localRoutes ? { routes: options.localRoutes() } : {}), now: this.clock.now() }).catch(error => this.fail(error))
      } catch (error) { this.fail(error) }
    }
    if (options.initialHello && this.currentState !== 'closed') void this.receive(options.initialHello).catch(error => this.fail(error))
  }

  /** Mux byte observer: includes unknown/unfinished messages before dispatch. */
  recordPreauthBytes(count: number): void {
    if (this.currentState !== 'connecting') return
    this.preauthBytes += count
    if (this.preauthBytes > PREAUTH_MAX_BYTES) throw new NetError('too_large')
  }

  get peer(): SyncSession['peer'] { if (!this.authenticatedPeer) throw new NetError('not_enrolled'); return this.authenticatedPeer }
  state(): SessionState { return this.currentState }
  clockOffsetMs(): number { return this.estimate?.offsetMs ?? 0 }
  clockEstimate(): QualifiedClockEstimate | undefined {
    if (!this.estimate) return undefined
    return { ...this.estimate, wallDeltaMs: this.clock.now() - (this.sampleWall ?? 0) - (this.clock.monotonic() - this.estimate.measuredAtMonotonic) }
  }
  discoverSpaceStream(space:SpaceId,stream:StreamId,metaHead:StreamHead,options?:{signal?:AbortSignal}):Promise<SpaceStreamDiscoveryProof>{
    this.requireCap('space.discovery.v1');this.spaceProofCapacity()
    const n=this.nextNumber();return this.request(`discovery:${n}`,{t:'space.discovery.get',n,space,stream,metaHead},[],SPACE_PROOF_DEADLINE_MS,options?.signal) as Promise<SpaceStreamDiscoveryProof>
  }
  spaceIdentity(space:SpaceId,user:UserId,metaHead:StreamHead,options?:{signal?:AbortSignal}):Promise<Signed>{
    this.requireCap('space.discovery.v1');this.spaceProofCapacity()
    const n=this.nextNumber();return this.request(`identity:${n}`,{t:'space.identity.get',n,space,user,metaHead},[],SPACE_PROOF_DEADLINE_MS,options?.signal) as Promise<Signed>
  }
  private sampleWall?: number

  subscribe(stream: StreamId, handlers: SubscriptionHandlers): { close(): void } {
    this.requireCap('streams.v1'); this.readScope(stream)
    if (this.subscriptions.has(stream)) throw new NetError('conflict')
    if (this.subscriptions.size >= SESSION_MAX_SUBSCRIPTIONS) throw new NetError('rate_limited')
    const receiver = new SubscriptionReceiver(stream, this.options.store, handlers,
      (record, snapshot) => this.verifyRecord(stream, record, snapshot),
      snapshot => {
        if (snapshot) { this.snapshotWaiting.add(stream); this.pumpSnapshots() }
        else { this.snapshotReceiving.delete(stream); this.snapshotWaiting.delete(stream); this.pumpSnapshots(); void this.send({ t: 'subscribe', stream, after: this.cursorHead(stream) }).catch(error => this.fail(error)) }
      })
    this.subscriptions.set(stream, receiver)
    void this.send({ t: 'subscribe', stream, after: this.cursorHead(stream) }).catch(error => this.fail(error))
    return { close: () => {
      if (this.subscriptions.get(stream) !== receiver) return
      receiver.close(); this.subscriptions.delete(stream)
      this.snapshotWaiting.delete(stream); this.snapshotReceiving.delete(stream); this.pumpSnapshots()
      if (this.currentState === 'open') void this.send({ t: 'unsubscribe', stream }).catch(error => this.fail(error))
    } }
  }

  append(stream: StreamId, id: EventId, envelope: Uint8Array, sig: Uint8Array): Promise<{ epoch: number; seq: number; recvTs: number }> {
    this.requireCap('streams.v1')
    const decoded = decodeEnvelope(envelope).envelope
    if (decoded.id !== id || decoded.stream !== stream) throw new NetError('bad_request')
    return this.request(`append:${id}`, { t: 'append', stream, id, parts: [envelope.length, sig.length] }, [envelope, sig], 10_000) as Promise<{ epoch: number; seq: number; recvTs: number }>
  }
  metaHead(stream: StreamId): Promise<StreamHead> {
    this.requireCap('streams.v1'); this.readScope(stream)
    if (this.options.store.getStream(stream)?.kind !== 'space.meta') throw new NetError('bad_request')
    const n = this.nextNumber()
    return this.request(`meta:${n}`, { t: 'metaHead.get', stream, n }, [], 10_000) as Promise<StreamHead>
  }
  async putBlob(stream: StreamId, blob: BlobId, bytes: Uint8Array, sealed: boolean): Promise<void> {
    this.requireCap('blobs.v1')
    if (bytes.length > DEFAULT_MAX_BLOB_BYTES || hashBlob(bytes) !== blob) throw new NetError('conflict')
    if (this.sendingUploads.has(blob) || this.blobJobs.has(blob) || this.uploads.has(blob) || this.downloads.has(blob) || this.sendingUploads.size + this.blobJobs.size + this.uploads.size + this.downloads.size >= SESSION_MAX_BLOB_TRANSFERS) throw new NetError('rate_limited')
    const key = `blobput:${blob}`
    const result = this.makePending(key, 30_000)
    this.sendingUploads.add(blob)
    void result.catch(() => {})
    try {
      await this.send({ t: 'blob.put.begin', stream, blob, bytes: bytes.length, sealed })
      for (let offset = 0; offset < bytes.length; offset += BLOB_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + BLOB_CHUNK_BYTES)
        await this.send({ t: 'blob.chunk', blob, offset, parts: [chunk.length] }, [chunk])
      }
      await this.send({ t: 'blob.put.end', blob })
    } catch (error) { this.finish(key, undefined, error) }
    try { await result } finally { this.sendingUploads.delete(blob) }
  }
  getBlob(stream: StreamId, blob: BlobId, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
    if (options?.signal?.aborted) return Promise.reject(new NetError('cancelled'))
    this.requireCap('blobs.v1'); this.readScope(stream)
    if (this.downloads.has(blob) || this.blobJobs.has(blob) || this.sendingUploads.has(blob) || this.downloads.size + this.uploads.size + this.blobJobs.size + this.sendingUploads.size >= SESSION_MAX_BLOB_TRANSFERS) throw new NetError('rate_limited')
    this.downloads.set(blob, { stream, chunks: [], bytes: 0 })
    // There is no blob-cancel wire operation. Close the link to release both
    // transfer slots rather than retaining an unbounded abandoned transfer.
    const abort = (): void => this.close('cancelled')
    options?.signal?.addEventListener('abort', abort, { once: true })
    try {
      return (this.request(`blobget:${blob}`, { t: 'blob.get', stream, blob, offset: 0 }, [], 30_000, options?.signal) as Promise<Uint8Array>).finally(() => { this.downloads.delete(blob); options?.signal?.removeEventListener('abort', abort) })
    } catch (error) { this.downloads.delete(blob); options?.signal?.removeEventListener('abort', abort); throw error }
  }
  rpc(method: string, params: unknown, options: { id: RpcId; idem?: string; deadlineMs: number; signal?: AbortSignal; onProgress?: (data: unknown) => void }): Promise<unknown> {
    this.requireCap('rpc.v1'); this.sameUser()
    return this.request(`rpc:${options.id}`, { t: 'rpc.request', id: options.id, method, params, ...(options.idem === undefined ? {} : { idem: options.idem }), deadlineMs: options.deadlineMs }, [], options.deadlineMs, options.signal, options.onProgress)
  }
  rpcResult(id: RpcId, options: { deadlineMs: number; signal?: AbortSignal }): Promise<unknown> {
    this.requireCap('rpc.v1'); this.sameUser()
    return this.request(`rpc:${id}`, { t: 'rpc.result.get', id }, [], options.deadlineMs, options.signal)
  }
  rpcCancel(id: RpcId): Promise<void> { this.requireCap('rpc.v1'); this.sameUser(); return this.send({ t: 'rpc.cancel', id }) }
  sendEphemeral(message: Extract<WireMessage, { t: 'presence' | 'ephemeral' }>): void {
    this.requireCap('presence.v1'); this.ephemeralScope(message.stream)
    void this.send(message).catch(error => this.fail(error))
  }
  onEphemeral(listener: (message: Extract<WireMessage, { t: 'presence' | 'ephemeral' }>) => void): () => void { this.ephemerals.add(listener); return () => this.ephemerals.delete(listener) }
  onClosed(listener: (error?: Error) => void): () => void { this.closedListeners.add(listener); return () => this.closedListeners.delete(listener) }
  close(code: NetErrorCode = 'cancelled'): void { this.fail(new NetError(code), true) }

  /** After a local authority transaction commits; all serving sessions recheck ACLs. */
  async publishRecord(stream: StreamId, record: StoredRecord): Promise<void> {
    if (!this.serving.get(stream)?.live || this.currentState !== 'open') return
    this.authorizedRead(stream)
    await this.sendRecords(stream, [record], false)
  }

  /** Trusted authority failure: terminate only an already authorized serving subscription. */
  async failServingStream(stream: StreamId, code: NetErrorCode): Promise<void> {
    const attempt = this.serving.get(stream)
    if (!attempt || this.currentState !== 'open') return
    attempt.cancelled = true; this.serving.delete(stream); this.cancelSnapshot(stream)
    await this.send({ t: 'error', re: stream, error: wireError(new NetError(code)) })
  }

  private async receive(message: MuxMessage): Promise<void> {
    const h = message.header
    if (this.currentState === 'connecting') {
      if (this.options.mux) {
        this.preauthMessageBytes += encodeMessage(h, message.parts).length
        if (this.preauthMessageBytes > PREAUTH_MAX_BYTES) throw new NetError('too_large')
      }
      if (h.t === 'hello') { await this.hello(h); return }
      if (h.t === 'helloAck') { this.helloAck(h); return }
      if (h.t === 'goAway') throw remoteError(h.error)
      throw new NetError('forbidden', 'Domain traffic before authentication.')
    }
    this.requireOpen()
    switch (h.t) {
      case 'hello': case 'helloAck': throw new NetError('bad_request')
      case 'goAway': throw remoteError(h.error)
      case 'error': {
        if (h.re) {
          const sub = this.subscriptions.get(h.re as StreamId)
          if (sub) {
            sub.error(h.error.code); this.subscriptions.delete(h.re as StreamId)
            this.snapshotReceiving.delete(h.re as StreamId); this.snapshotWaiting.delete(h.re as StreamId); this.pumpSnapshots()
          }
          this.finish(h.re, undefined, remoteError(h.error))
        }
        return
      }
      case 'ping': await this.send({ t: 'pong', n: h.n, now: this.clock.now() }); return
      case 'pong': this.pong(h.n, h.now); return
      case 'rosterUpdate': {
        const doc = parseProtocolJson(Buffer.from(h.roster.payload, 'base64url')) as Roster
        if (!validateSignedDocument('roster', doc)) throw new NetError('bad_delegation')
        const root = this.options.identity.pinnedRootKey(doc.owner)
        // A third user's document is historical proof relayed by this peer.
        // A membership-derived root pin does not make that relay CURRENT.
        if (!root || doc.owner !== this.peer.user) { if (!this.options.retainRosterEvidence) throw new NetError('bad_delegation'); this.options.retainRosterEvidence(h.roster, this.peer); return }
        this.options.retainRosterEvidence?.(h.roster, this.peer)
        this.options.identity.acceptRoster(h.roster, root); this.revalidateIdentity(); return
      }
      case 'revoked': return // Hint only. Independently verified roster controls teardown.
      case 'subscribe': this.requireCap('streams.v1'); await this.serve(h.stream, h.after); return
      case 'unsubscribe': this.serving.get(h.stream) && (this.serving.get(h.stream)!.cancelled = true); this.serving.delete(h.stream); this.cancelSnapshot(h.stream); return
      case 'subscribed': this.requireCap('streams.v1'); this.subscriptions.get(h.stream)?.subscribed(h.head, h.replayThrough); return
      case 'events': this.requireCap('streams.v1'); if (!this.subscriptions.has(h.stream)) return; this.readScope(h.stream); this.receiver(h.stream).receive(recordsFrom(h.records, message.parts)); return
      case 'caughtUp': this.requireCap('streams.v1'); this.subscriptions.get(h.stream)?.caughtUp(); return
      case 'snapshotRequired': this.requireCap('streams.v1'); this.subscriptions.get(h.stream)?.snapshotRequired(h.head); return
      case 'snapshot.get': this.requireCap('streams.v1'); await this.serveSnapshot(h.stream); return
      case 'snapshot.chunk': this.requireCap('streams.v1'); if (!this.subscriptions.has(h.stream)) return; this.readScope(h.stream); this.receiver(h.stream).snapshotChunk({ epoch: h.epoch, seq: h.throughSeq }, recordsFrom(h.records, message.parts), h.done); return
      case 'metaHead.get':
        this.requireCap('streams.v1')
        try {
          this.authorizedRead(h.stream)
          if (this.options.store.getStream(h.stream)?.kind !== 'space.meta') throw new NetError('bad_request')
          await this.send({ t: 'metaHead', stream: h.stream, n: h.n, head: this.options.store.head(h.stream), now: this.clock.now() })
        } catch (error) { await this.send({ t: 'error', re: `meta:${h.n}`, error: wireError(error) }) }
        return
      case 'metaHead': {
        this.requireCap('streams.v1')
        const request = this.pending.get(`meta:${h.n}`)?.request
        if (request?.t === 'metaHead.get' && request.stream !== h.stream) throw new NetError('conflict')
        this.finish(`meta:${h.n}`, h.head); return
      }
      case 'space.discovery.get':case 'space.identity.get':this.requireCap('space.discovery.v1');await this.serveSpaceProof(h);return
      case 'space.proof.cancel':this.requireCap('space.discovery.v1');this.spaceProofJobs.get(h.n)?.abort();return
      case 'space.discovery.result':{
        this.requireCap('space.discovery.v1');const key=`discovery:${h.n}`,request=this.pending.get(key)?.request
        if(!request)return
        if(request.t!=='space.discovery.get'||request.space!==h.space||request.stream!==h.stream||!sameHead(request.metaHead,h.metaHead))throw new NetError('conflict')
        if('error'in h){this.finish(key,undefined,remoteError(h.error));return}
        const rows=recordsFrom([h.parent,...h.controls],message.parts)
        this.finish(key,{descriptor:h.descriptor,metaHead:h.metaHead,head:h.head,parentOpenEvent:rows[0],controllerEvents:rows.slice(1)} satisfies SpaceStreamDiscoveryProof);return
      }
      case 'space.identity.result':{
        this.requireCap('space.discovery.v1');const key=`identity:${h.n}`,request=this.pending.get(key)?.request
        if(!request)return
        if(request.t!=='space.identity.get'||request.space!==h.space||request.user!==h.user||!sameHead(request.metaHead,h.metaHead))throw new NetError('conflict')
        this.finish(key,'error'in h?undefined:h.roster,'error'in h?remoteError(h.error):undefined);return
      }
      case 'append': {
        this.requireCap('streams.v1')
        let result: ReturnType<StreamAuthority['append']>
        try {
          if (!this.options.authority) throw new NetError('forbidden')
          result = this.options.authority.append(h.stream, h.id, message.parts[0], message.parts[1], this.peer)
        } catch (error) { await this.send({ t: 'appendResult', stream: h.stream, id: h.id, error: wireError(error) }); return }
        await this.send({ t: 'appendResult', stream: h.stream, id: h.id, epoch: result.epoch, seq: result.seq, recvTs: result.recvTs })
        if (result.kind === 'stored') {
          const record = this.options.store.getById(h.stream, h.id)
          if (record) await this.publishRecord(h.stream, record)
        }
        return
      }
      case 'appendResult': {
        this.requireCap('streams.v1')
        const request = this.pending.get(`append:${h.id}`)?.request
        if (request?.t === 'append' && request.stream !== h.stream) throw new NetError('conflict')
        this.finish(`append:${h.id}`, 'error' in h ? undefined : { epoch: h.epoch, seq: h.seq, recvTs: h.recvTs }, 'error' in h ? remoteError(h.error) : undefined); return
      }
      case 'blob.put.begin': this.requireCap('blobs.v1'); this.beginUpload(h); return
      case 'blob.chunk': this.requireCap('blobs.v1'); this.blobChunk(h, message.parts[0]); return
      case 'blob.put.end': this.requireCap('blobs.v1'); await this.endUpload(h.blob); return
      case 'blob.put.result': this.requireCap('blobs.v1'); this.finish(`blobput:${h.blob}`, undefined, h.error ? remoteError(h.error) : undefined); return
      case 'blob.get': this.requireCap('blobs.v1'); await this.serveBlob(h.stream, h.blob, h.offset); return
      case 'blob.end': {
        this.requireCap('blobs.v1')
        const download = this.downloads.get(h.blob)
        if (!download) throw new NetError('bad_request')
        const bytes = Buffer.concat(download.chunks, download.bytes)
        this.finish(`blobget:${h.blob}`, bytes, h.error ? remoteError(h.error) : hashBlob(bytes) !== h.blob ? new NetError('conflict') : undefined)
        return
      }
      case 'rpc.request': this.requireCap('rpc.v1'); this.sameUser(); await this.serveRpc(h); return
      case 'rpc.result.get':
        this.requireCap('rpc.v1'); this.sameUser()
        try { if (!this.options.rpc) throw new NetError('forbidden'); await this.send(resultMessage(h.id, await this.options.rpc.result(h.id, this.peer))) }
        catch (error) { await this.send({ t: 'rpc.result', id: h.id, error: wireError(error) }) }
        return
      case 'rpc.cancel': this.requireCap('rpc.v1'); this.sameUser(); if (!this.options.rpc) throw new NetError('forbidden'); await this.options.rpc.cancel(h.id, this.peer); this.rpcControllers.get(h.id)?.abort(); return
      case 'rpc.progress': this.requireCap('rpc.v1'); this.pending.get(`rpc:${h.id}`)?.progress?.(h.data); return
      case 'rpc.result': {
        this.requireCap('rpc.v1')
        if (!('error' in h) && h.blob && JSON.stringify(resultMessage(h.id, h.result).blob) !== JSON.stringify(h.blob)) throw new NetError('bad_request')
        this.finish(`rpc:${h.id}`, 'error' in h ? undefined : h.result, 'error' in h ? remoteError(h.error) : undefined); return
      }
      case 'presence': case 'ephemeral':
        this.requireCap('presence.v1'); this.ephemeralScope(h.stream)
        if (h.t === 'presence' && !this.options.verifyPresence?.(h, this.peer)) return
        for (const listener of this.ephemerals) listener(h)
        return
      default: throw new NetError('forbidden') // Enrollment / space admission are quarantine services, never normal domain RPC.
    }
  }

  private async hello(h: Extract<WireMessage, { t: 'hello' }>): Promise<void> {
    if (this.helloReceived || h.protoMajor !== NET_PROTO_MAJOR) throw new NetError(h.protoMajor !== NET_PROTO_MAJOR ? 'incompatible_peer' : 'bad_request')
    if (!h.roster || !h.delegation) throw new NetError('not_enrolled')
    const claims = parseProtocolJson(Buffer.from(h.delegation.payload, 'base64url')) as NodeDelegation
    if (!validateSignedDocument('nodeDelegation', claims)) throw new NetError('bad_delegation')
    const root = this.options.identity.pinnedRootKey(claims.owner)
    if (!root) throw new NetError('bad_delegation')
    const delegation = this.options.identity.verifySigned<NodeDelegation>(h.delegation, root)
    if (delegation.subject !== h.node || !equalKey(delegation.keys.transport, this.options.channel.peerTransportKey)) throw new NetError('peer_key_mismatch')
    if (delegation.issuedAt > this.clock.now() || delegation.expiresAt <= this.clock.now()) throw new NetError('bad_delegation')
    this.options.identity.acceptRoster(h.roster, root)
    const current = this.currentDelegation(delegation.owner, delegation.subject)
    if (current.document.keyEpoch !== delegation.keyEpoch || !equalKey(current.document.keys.sign, delegation.keys.sign) || !equalKey(current.document.keys.agree, delegation.keys.agree) || !equalKey(current.document.keys.transport, delegation.keys.transport)) throw new NetError('bad_delegation')
    if (h.routes) {
      const routes = this.options.identity.verifySigned<{ node: string }>(h.routes, delegation.keys.sign)
      if (!validateSignedDocument('routes', routes) || routes.node !== h.node) throw new NetError('bad_signature')
    }
    // Same-key renewals do not strand disconnected peers; current roster claims
    // determine capabilities even when their hello carries an older valid lease.
    this.authenticatedPeer = { node: delegation.subject, user: delegation.owner, delegation: current.document }
    if (h.routes) this.options.onPeerRoutes?.(h.routes, this.authenticatedPeer)
    this.negotiatedCaps = this.localCaps.filter(cap => h.caps.includes(cap) && SESSION_CAPABILITIES.includes(cap))
    if (!this.negotiatedCaps.includes('streams.v1')) throw new NetError('incompatible_peer')
    this.negotiatedMinor = Math.min(NET_PROTO_MINOR, h.protoMinor)
    this.helloReceived = true
    await this.send({ t: 'helloAck', protoMinor: this.negotiatedMinor, caps: this.negotiatedCaps, now: this.clock.now() })
    this.ackSent = true
    this.tryOpen()
  }
  private helloAck(h: Extract<WireMessage, { t: 'helloAck' }>): void {
    if (!this.helloReceived || this.ackReceived || h.protoMinor !== this.negotiatedMinor || h.caps.length !== this.negotiatedCaps.length || h.caps.some(cap => !this.negotiatedCaps.includes(cap))) throw new NetError('incompatible_peer')
    this.ackReceived = true; this.tryOpen()
  }
  private tryOpen(): void {
    if (!this.helloReceived || !this.ackReceived || !this.ackSent || this.currentState !== 'connecting') return
    this.revalidateIdentity(); this.currentState = 'open'; this.handshakeTimer.cancel()
    this.options.onAuthenticated?.(); this.openResolve(); this.schedulePing()
    this.refreshExpiry()
  }
  private refreshExpiry(): void {
    this.expiryTimer?.cancel()
    const self = this.options.identity.self()!
    const own = this.currentDelegation(self.user, self.node).document
    this.expiryTimer = this.clock.setTimeout(() => this.fail(new NetError('bad_delegation')), Math.max(0, Math.min(this.peer.delegation.expiresAt, own.expiresAt) - this.clock.now()))
  }
  private currentDelegation(user: SyncSession['peer']['user'], node: SyncSession['peer']['node']): { signed: Signed; document: NodeDelegation } {
    const root = this.options.identity.pinnedRootKey(user), signed = this.options.identity.roster(user)
    if (!root || !signed) throw new NetError('not_enrolled')
    if (this.options.identity.rosterState(user) !== 'ok') throw new NetError('roster_conflict')
    const roster = this.options.identity.verifySigned<Roster>(signed, root)
    if (!validateSignedDocument('roster', roster) || roster.owner !== user) throw new NetError('bad_delegation')
    const candidates = roster.nodes.map(signed => ({ signed, document: this.options.identity.verifySigned<NodeDelegation>(signed, root) })).filter(entry => entry.document.subject === node)
    candidates.sort((a, b) => b.document.keyEpoch - a.document.keyEpoch || b.document.issuedAt - a.document.issuedAt)
    const current = candidates[0]
    if (!current || !validateSignedDocument('nodeDelegation', current.document) || current.document.owner !== user || current.document.issuedAt > this.clock.now() || current.document.expiresAt <= this.clock.now()) throw new NetError('bad_delegation')
    if (roster.revoked.some(row => row.subject === node && row.throughKeyEpoch >= current.document.keyEpoch)) throw new NetError('revoked')
    return current
  }
  private revalidateIdentity(): void {
    const self = this.options.identity.self()
    if (!self) throw new NetError('not_enrolled')
    this.currentDelegation(self.user, self.node)
    if (this.authenticatedPeer) {
      const current = this.currentDelegation(this.peer.user, this.peer.node).document
      if (current.keyEpoch !== this.peer.delegation.keyEpoch || !equalKey(current.keys.transport, this.options.channel.peerTransportKey)) throw new NetError('bad_delegation')
      this.authenticatedPeer = { ...this.peer, delegation: current }
    }
  }
  private requireOpen(): void { if (this.revocationFence) throw this.revocationFence; if (this.currentState !== 'open') throw new NetError('peer_offline'); this.revalidateIdentity() }
  private requireCap(cap: SessionCapability): void { this.requireOpen(); if (!this.negotiatedCaps.includes(cap)) throw new NetError('forbidden') }
  private sameUser(): void { if (this.peer.user !== this.options.identity.self()?.user) throw new NetError('forbidden') }
  private ephemeralScope(stream: StreamId): void {
    const descriptor = this.options.store.getStream(stream)
    if (descriptor?.authority === this.options.identity.self()?.node) this.authorizedRead(stream)
    else this.readScope(stream)
  }
  private readScope(stream: StreamId): StreamDescriptor {
    this.requireOpen()
    const descriptor = this.options.store.getStream(stream)
    if (!descriptor) throw new NetError('stream_unknown')
    if (descriptor.authority !== this.peer.node) throw new NetError('forbidden')
    if (this.options.canReceive) { if (!this.options.canReceive(descriptor, this.peer)) throw new NetError('forbidden') }
    else if (descriptor.kind !== 'node.thread' || this.peer.user !== this.options.identity.self()?.user || !this.currentDelegation(this.options.identity.self()!.user, this.options.identity.self()!.node).document.caps.includes('read')) throw new NetError('forbidden')
    return descriptor
  }
  private verifyRecord(stream: StreamId, record: StoredRecord, snapshot: boolean): void {
    const descriptor = this.readScope(stream), envelope = decodeEnvelope(record.envelope).envelope
    if (descriptor.kind.startsWith('space.')) {
      if (!this.options.verifyRecord) throw new NetError('forbidden')
      // Concrete Space history validators authenticate before staging publishes.
      // Roots proved by preceding staged membership are deliberately not global pins.
      this.options.verifyRecord(record, descriptor, snapshot)
      return
    }
    this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, envelope.ts, 'history')
    if (descriptor.kind === 'node.thread' && (envelope.author.node !== descriptor.authority || envelope.author.user !== this.peer.user)) throw new NetError('forbidden')
    this.options.verifyRecord?.(record, descriptor, snapshot)
  }
  private authorizedRead(stream: StreamId): void {
    this.requireOpen()
    if (!this.options.authority?.canRead(stream, this.peer)) throw new NetError('forbidden')
    if (this.options.store.getStream(stream)?.authority !== this.options.identity.self()?.node) throw new NetError('forbidden')
  }
  private cursorHead(stream: StreamId): StreamHead { const cursor = this.options.store.cursor(stream); return { epoch: cursor.epoch, seq: cursor.seq } }
  private receiver(stream: StreamId): SubscriptionReceiver { const receiver = this.subscriptions.get(stream); if (!receiver) throw new NetError('bad_request'); return receiver }
  private async serve(stream: StreamId, after: StreamHead): Promise<void> {
    this.authorizedRead(stream)
    if (!this.serving.has(stream) && this.serving.size >= SESSION_MAX_SUBSCRIPTIONS) throw new NetError('rate_limited')
    const old = this.serving.get(stream); if (old) old.cancelled = true
    const attempt = { cancelled: false, live: false }; this.serving.set(stream, attempt)
    const head = this.options.store.head(stream), reason = this.options.store.snapshotReason(stream, after)
    if (reason) { await this.send({ t: 'snapshotRequired', stream, reason, head }); return }
    attempt.live = true
    await this.send({ t: 'subscribed', stream, head, replayThrough: head.seq })
    if (attempt.cancelled) return
    let cursor = { ...after }
    while (!attempt.cancelled && cursor.seq < head.seq) {
      this.authorizedRead(stream)
      const page = this.options.store.read(stream, cursor, head.seq, 512 * 1024)
      if (!page.records.length) throw new NetError('storage_corrupt')
      await this.sendRecords(stream, page.records, true)
      cursor = { epoch: page.records.at(-1)!.epoch, seq: page.records.at(-1)!.seq }
    }
    if (!attempt.cancelled) { this.authorizedRead(stream); await this.send({ t: 'caughtUp', stream }) }
  }
  private pumpSnapshots(): void {
    while (this.currentState === 'open' && this.snapshotReceiving.size < 4 && this.snapshotWaiting.size) {
      const stream = this.snapshotWaiting.values().next().value!
      this.snapshotWaiting.delete(stream); this.snapshotReceiving.add(stream)
      void this.send({ t: 'snapshot.get', stream }).catch(error => this.fail(error))
    }
  }
  private cancelSnapshot(stream: StreamId): void {
    const job = this.snapshotJobs.get(stream)
    if (!job) return
    this.snapshotJobs.delete(stream); job.controller.abort(); job.reader.close()
  }
  private async serveSnapshot(stream: StreamId): Promise<void> {
    this.authorizedRead(stream)
    // Duplicate requests coalesce while the original transfer owns the stream.
    if (this.snapshotJobs.has(stream)) return
    if (this.snapshotJobs.size >= 8) throw new NetError('rate_limited')
    const reader = this.options.store.openSnapshot(stream), controller = new AbortController()
    const job = { reader, controller }; this.snapshotJobs.set(stream, job)
    try {
      let done = false
      while (!done && !controller.signal.aborted) {
        this.authorizedRead(stream)
        const page = reader.next(512 * 1024, 499)
        done = page.done
        if (!done && !page.records.length) throw new NetError('storage_corrupt')
        await this.sendRecords(stream, page.records, true, { target: reader.target, done }, controller.signal)
      }
    } catch (error) { if (!controller.signal.aborted) throw error }
    finally { if (this.snapshotJobs.get(stream) === job) { this.snapshotJobs.delete(stream); reader.close() } }
  }
  private async sendRecords(stream: StreamId, records: StoredRecord[], replay: boolean, snapshot?: { target: StreamHead; done: boolean }, signal?: AbortSignal): Promise<void> {
    // A fresh subscriber needs the original signed lease before historical events.
    const evidence = new Map<string, Signed>()
    for (const record of records) {
      const envelope = decodeEnvelope(record.envelope).envelope
      const roster = this.options.identity.historicalRosterFor(envelope.author, envelope.ts)
      if (!roster) throw new NetError('bad_delegation')
      evidence.set(roster.sig, roster)
    }
    const recipients=this.options.discovery?.recordEvidence?.(stream,records,this.peer)??[]
    for(const roster of recipients)evidence.set(roster.sig,roster)
    if(recipients.length&&(evidence.size>64||[...evidence.values()].reduce((n,roster)=>n+Buffer.byteLength(JSON.stringify(roster)),0)>512*1024))throw new NetError('too_large')
    for (const roster of evidence.values()) {this.authorizedRead(stream);await this.send({ t: 'rosterUpdate', roster }, [], signal)}
    this.authorizedRead(stream)
    const parts = records.flatMap(record => [record.envelope, record.sig])
    const rows = records.map(({ epoch, seq, recvTs }) => ({ epoch, seq, recvTs }))
    await this.send(snapshot ? { t: 'snapshot.chunk', stream, epoch: snapshot.target.epoch, throughSeq: snapshot.target.seq, records: rows, done: snapshot.done, parts: parts.map(part => part.length) } : { t: 'events', stream, records: rows, replay, parts: parts.map(part => part.length) }, parts, signal)
  }
  private beginUpload(h: Extract<WireMessage, { t: 'blob.put.begin' }>): void {
    if (!this.options.blobs || !this.options.authority || h.bytes > DEFAULT_MAX_BLOB_BYTES) throw new NetError('forbidden')
    if (this.uploads.has(h.blob) || this.downloads.has(h.blob) || this.blobJobs.has(h.blob) || this.sendingUploads.has(h.blob) || this.uploads.size + this.downloads.size + this.blobJobs.size + this.sendingUploads.size >= SESSION_MAX_BLOB_TRANSFERS) throw new NetError('rate_limited')
    this.options.authority.acceptBlob(h.stream, h.blob, h.bytes, h.sealed, this.peer)
    this.uploads.set(h.blob, { upload: this.options.blobs.begin(h.blob, h.bytes, h.sealed), stream: h.stream, size: h.bytes, sealed: h.sealed })
  }
  private blobChunk(h: Extract<WireMessage, { t: 'blob.chunk' }>, bytes: Uint8Array): void {
    const upload = this.uploads.get(h.blob), download = this.downloads.get(h.blob)
    if (upload && download) throw new NetError('conflict')
    if (upload) {
      if (!this.options.authority) throw new NetError('forbidden')
      this.options.authority.acceptBlob(upload.stream, h.blob, upload.size, upload.sealed, this.peer)
      upload.upload.write(h.offset, bytes); return
    }
    if (!download || h.offset !== download.bytes || download.bytes + bytes.length > DEFAULT_MAX_BLOB_BYTES) throw new NetError('bad_request')
    this.readScope(download.stream); download.chunks.push(Buffer.from(bytes)); download.bytes += bytes.length
  }
  private async endUpload(blob: BlobId): Promise<void> {
    const upload = this.uploads.get(blob)
    if (!upload) throw new NetError('bad_request')
    try { this.authorizedUpload(upload, blob); upload.upload.commit(); this.options.authority?.blobCommitted?.(upload.stream, blob, upload.size, upload.sealed, this.peer); await this.send({ t: 'blob.put.result', blob }) }
    catch (error) { upload.upload.abort(); await this.send({ t: 'blob.put.result', blob, error: wireError(error) }) }
    finally { this.uploads.delete(blob) }
  }
  private authorizedUpload(upload: Upload, blob: BlobId): void {
    this.requireOpen()
    if (!this.options.authority) throw new NetError('forbidden')
    this.options.authority.acceptBlob(upload.stream, blob, upload.size, upload.sealed, this.peer)
  }
  private async serveBlob(stream: StreamId, blob: BlobId, offset: number): Promise<void> {
    if (this.blobJobs.has(blob)) return
    if (this.sendingUploads.has(blob) || this.downloads.has(blob) || this.uploads.has(blob)) throw new NetError('conflict')
    if (this.blobJobs.size + this.uploads.size + this.downloads.size + this.sendingUploads.size >= SESSION_MAX_BLOB_TRANSFERS) throw new NetError('rate_limited')
    const controller = new AbortController(); this.blobJobs.set(blob, controller)
    try {
      const store = this.options.blobs
      if (!store || !this.options.authority?.canFetchBlob(stream, blob, this.peer)) throw new NetError('forbidden')
      const size = store.size(blob)
      if (size === undefined || offset > size || size > DEFAULT_MAX_BLOB_BYTES) throw new NetError('bad_request')
      for (let at = offset; at < size; at += BLOB_CHUNK_BYTES) {
        this.requireOpen()
        if (!this.options.authority.canFetchBlob(stream, blob, this.peer)) throw new NetError('forbidden')
        const bytes = store.read(blob, at, Math.min(BLOB_CHUNK_BYTES, size - at))
        await this.send({ t: 'blob.chunk', blob, offset: at, parts: [bytes.length] }, [bytes], controller.signal)
      }
      await this.send({ t: 'blob.end', blob })
    } catch (error) { if (!controller.signal.aborted) await this.send({ t: 'blob.end', blob, error: wireError(error) }) }
    finally { this.blobJobs.delete(blob) }
  }
  private async serveRpc(h: Extract<WireMessage, { t: 'rpc.request' }>): Promise<void> {
    const controller = new AbortController()
    if (this.rpcControllers.has(h.id) || this.rpcControllers.size >= SESSION_MAX_INFLIGHT_RPCS) throw new NetError('rate_limited')
    this.rpcControllers.set(h.id, controller)
    const timer = this.clock.setTimeout(() => controller.abort(), h.deadlineMs)
    try {
      if (!this.options.rpc) throw new NetError('forbidden')
      const result = await this.options.rpc.request(h, this.peer, controller.signal, data => { void this.send({ t: 'rpc.progress', id: h.id, data }).catch(error => this.fail(error)) })
      await this.send(resultMessage(h.id, result))
    } catch (error) { await this.send({ t: 'rpc.result', id: h.id, error: wireError(error) }) }
    finally { timer.cancel(); this.rpcControllers.delete(h.id) }
  }
  private spaceProofCapacity():void {if([...this.pending.keys()].filter(key=>key.startsWith('discovery:')||key.startsWith('identity:')).length>=SESSION_MAX_SPACE_PROOFS)throw new NetError('rate_limited')}
  private async serveSpaceProof(request:SpaceDiscoveryGetMessage|SpaceIdentityGetMessage):Promise<void>{
    const errorResult=(error:unknown):WireMessage=>request.t==='space.discovery.get'?{t:'space.discovery.result',n:request.n,space:request.space,stream:request.stream,metaHead:request.metaHead,error:wireError(error)}:{t:'space.identity.result',n:request.n,space:request.space,user:request.user,metaHead:request.metaHead,error:wireError(error)}
    const now=this.clock.monotonic();this.spaceProofTimes=this.spaceProofTimes.filter(at=>now>=at&&now-at<10000)
    if(this.spaceProofJobs.has(request.n)||this.spaceProofJobs.size>=SESSION_MAX_SPACE_PROOFS||this.spaceProofTimes.length>=20){await this.send(errorResult(new NetError('rate_limited')));return}
    this.spaceProofTimes.push(now)
    const controller=new AbortController();this.spaceProofJobs.set(request.n,controller);const timer=this.clock.setTimeout(()=>controller.abort(),SPACE_PROOF_DEADLINE_MS)
    try{
      if(request.t==='space.identity.get'){
        const port=this.options.spaceIdentity;if(!port)throw new NetError('forbidden');const roster=port.get(request,this.peer),response:WireMessage={t:'space.identity.result',n:request.n,space:request.space,user:request.user,metaHead:request.metaHead,roster}
        encodeMessage(response);await Promise.resolve();if(controller.signal.aborted)return;this.requireOpen();port.revalidate(request,roster,this.peer);await this.send(response,[],controller.signal)
      }else{
        const port=this.options.discovery;if(!port)throw new NetError('forbidden');const proof=port.get(request,this.peer),records=[proof.parentOpenEvent,...proof.controllerEvents],parts=records.flatMap(record=>[record.envelope,record.sig]),rows=records.map(({epoch,seq,recvTs})=>({epoch,seq,recvTs})),response:WireMessage={t:'space.discovery.result',n:request.n,space:request.space,stream:request.stream,metaHead:proof.metaHead,descriptor:proof.descriptor,head:proof.head,parent:rows[0],controls:rows.slice(1),parts:parts.map(part=>part.length)}
        if(!sameHead(proof.metaHead,request.metaHead))throw new NetError('meta_stale');encodeMessage(response,parts)
        const evidence=new Map<string,Signed>();for(const record of records){const envelope=decodeEnvelope(record.envelope).envelope,roster=this.options.identity.historicalRosterFor(envelope.author,envelope.ts);if(!roster)throw new NetError('bad_delegation');evidence.set(roster.sig,roster)}
        for(const roster of port.evidence?.(request,proof,this.peer)??[])evidence.set(roster.sig,roster)
        if(evidence.size>64||[...evidence.values()].reduce((n,roster)=>n+Buffer.byteLength(JSON.stringify(roster)),0)>512*1024)throw new NetError('too_large')
        for(const roster of evidence.values()){if(controller.signal.aborted)return;this.requireOpen();port.revalidate(request,proof,this.peer);await this.send({t:'rosterUpdate',roster},[],controller.signal)}
        if(controller.signal.aborted)return;this.requireOpen();port.revalidate(request,proof,this.peer);await this.send(response,parts,controller.signal)
      }
    }catch(error){if(!controller.signal.aborted&&this.currentState==='open')await this.send(errorResult(error))}
    finally{timer.cancel();if(this.spaceProofJobs.get(request.n)===controller)this.spaceProofJobs.delete(request.n)}
  }
  private schedulePing(): void {
    this.pingTimer = this.clock.setTimeout(() => {
      if (this.currentState !== 'open') return
      if (this.unanswered >= 3) { this.fail(new NetError('peer_offline')); return }
      const n = this.nextNumber()
      this.unanswered++; this.probes.clear(); this.probes.set(n, { wall: this.clock.now(), mono: this.clock.monotonic() })
      void this.send({ t: 'ping', n, now: this.clock.now() }).catch(error => this.fail(error))
      this.schedulePing()
    }, SESSION_PING_INTERVAL_MS)
  }
  private pong(n: number, peerNow: number): void {
    const probe = this.probes.get(n)
    if (!probe) return
    this.probes.delete(n); this.unanswered = 0
    const wall = this.clock.now(), mono = this.clock.monotonic(), rtt = mono - probe.mono
    if (rtt < 0 || rtt > 5_000 || Math.abs(wall - probe.wall - rtt) > 1_000) { this.estimate = undefined; return }
    this.sampleWall = wall
    this.estimate = { offsetMs: peerNow - (probe.wall + wall) / 2, measuredAtMonotonic: mono, rttMs: rtt, wallDeltaMs: 0 }
  }
  private nextNumber(): number { if (this.pingNumber >= Number.MAX_SAFE_INTEGER) throw new NetError('conflict'); return ++this.pingNumber }
  private makePending(key: string, deadlineMs: number, signal?: AbortSignal, progress?: (value: unknown) => void): Promise<unknown> {
    this.requireOpen()
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 86_400_000) throw new NetError('bad_request')
    if (this.pending.has(key)) throw new NetError('conflict')
    if (this.pending.size >= SESSION_MAX_INFLIGHT_RPCS) throw new NetError('rate_limited')
    if (signal?.aborted) throw new NetError('cancelled')
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {const request=this.pending.get(key)?.request;if((request?.t==='space.discovery.get'||request?.t==='space.identity.get')&&this.currentState==='open')void this.send({t:'space.proof.cancel',n:request.n}).catch(error=>this.fail(error));this.finish(key, undefined, new NetError('deadline_exceeded'))}, deadlineMs)
      const abort = (): void => {
        const request = this.pending.get(key)?.request
        if (request?.t === 'rpc.request' && this.currentState === 'open') {
          void this.send({ t: 'rpc.cancel', id: request.id }).catch(error => this.fail(error))
        }
        if((request?.t==='space.discovery.get'||request?.t==='space.identity.get')&&this.currentState==='open')void this.send({t:'space.proof.cancel',n:request.n}).catch(error=>this.fail(error))
        this.finish(key, undefined, new NetError('cancelled'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(key, { resolve, reject, progress, cancel: () => { timer.cancel(); signal?.removeEventListener('abort', abort) } })
    })
  }
  private request(key: string, header: WireMessage, parts: Uint8Array[], deadlineMs: number, signal?: AbortSignal, progress?: (value: unknown) => void): Promise<unknown> {
    const result = this.makePending(key, deadlineMs, signal, progress)
    this.pending.get(key)!.request = header
    void this.send(header, parts, signal).catch(error => this.finish(key, undefined, error))
    return result
  }
  private finish(key: string, value?: unknown, error?: unknown): void {
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key); pending.cancel()
    if (error) pending.reject(error); else pending.resolve(value)
  }
  private send(header: WireMessage, parts: Uint8Array[] = [], signal?: AbortSignal): Promise<void> {
    if (this.revocationFence) return Promise.reject(this.revocationFence)
    if (this.currentState === 'closed' || this.currentState === 'closing') return Promise.reject(new NetError('peer_offline'))
    return this.mux.send(laneFor(header), { header, parts }, signal)
  }
  private fail(cause: unknown, teardown = false): void {
    if (this.currentState === 'closed' || this.currentState === 'closing') return
    // Aborted domain jobs cannot destroy the queued revocation. Only its flush,
    // bounded deadline, transport closure or an explicit local close owns teardown.
    if (this.revocationFence && !teardown) return
    const transportCode = (cause as { code?: unknown })?.code
    const error = cause instanceof NetError ? cause
      : ['ECONNRESET', 'EPIPE', 'ECANCELED', 'ETIMEDOUT', 'ECONNABORTED', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(String(transportCode))
        ? new NetError('route_unreachable', undefined, { cause })
        : cause instanceof Error ? cause : new NetError('internal')
    this.currentState = 'closing'; this.handshakeTimer.cancel(); this.pingTimer?.cancel(); this.expiryTimer?.cancel(); this.revocationTimer?.cancel()
    for (const callback of this.cleanup.splice(0)) callback()
    for (const receiver of this.subscriptions.values()) {
      try { receiver.error(error instanceof NetError ? error.code : 'internal') } catch { /* Continue connection cleanup after an observer/storage error. */ }
    }
    this.subscriptions.clear()
    for (const attempt of this.serving.values()) attempt.cancelled = true
    this.serving.clear()
    for (const stream of [...this.snapshotJobs.keys()]) this.cancelSnapshot(stream)
    this.snapshotWaiting.clear(); this.snapshotReceiving.clear()
    for (const controller of this.blobJobs.values()) controller.abort()
    for(const controller of this.spaceProofJobs.values())controller.abort();this.spaceProofJobs.clear()
    this.blobJobs.clear(); this.sendingUploads.clear()
    for (const upload of this.uploads.values()) { try { upload.upload.abort() } catch { /* Incomplete uploads remain invisible for startup cleanup. */ } }
    this.uploads.clear(); this.downloads.clear()
    for (const controller of this.rpcControllers.values()) controller.abort()
    this.rpcControllers.clear()
    for (const key of [...this.pending.keys()]) this.finish(key, undefined, error)
    this.mux.close(error); this.options.channel.close(); this.currentState = 'closed'
    this.openReject(error)
    for (const listener of this.closedListeners) { try { listener(error) } catch { /* One observer cannot retain the connection. */ } }
    this.closedListeners.clear(); this.ephemerals.clear()
  }
}

function recordsFrom(rows: Array<{ epoch: number; seq: number; recvTs: number }>, parts: Uint8Array[]): StoredRecord[] {
  return rows.map((row, index) => ({ ...row, envelope: parts[index * 2], sig: parts[index * 2 + 1] }))
}
function sameHead(a:StreamHead,b:StreamHead):boolean{return a.epoch===b.epoch&&a.seq===b.seq}
function hashBlob(bytes: Uint8Array): BlobId { return `blb_${createHash('sha256').update(bytes).digest('hex')}` as BlobId }
function resultMessage(id: RpcId, result: unknown): { t: 'rpc.result'; id: RpcId; result: unknown; blob?: RpcArtifactRef } {
  const value = result as { kind?: string; artifact?: RpcArtifactRef; descriptor?: StreamDescriptor } | null
  const ref = value?.artifact
  if (value?.kind === 'bridge.artifact.result.v1' && ref && isId('stream', ref.stream) && isId('event', ref.event) && isBlobId(ref.blob) && value.descriptor?.id === ref.stream && value.descriptor.kind === 'node.artifact') return { t: 'rpc.result', id, result, blob: ref }
  return { t: 'rpc.result', id, result }
}

import { createHash } from 'node:crypto'
import { BLOB_CHUNK_BYTES, DEFAULT_MAX_BLOB_BYTES, NET_PROTO_MINOR, NetError, isBlobId, isId, newId, validateStreamDescriptor } from '../../shared/net'
import type { BlobId, EventId, NodeId, RpcArtifactRef, RpcId, StreamDescriptor, StreamId } from '../../shared/net'
import type { AppendOutcome, BlobStore, Clock, IdentityService, KeyStore, RpcContext, RpcMethod, StreamAuthority, StreamStore, SyncSession } from '../net/contracts'
import { canonicalJson, decodeEnvelope, encodeEnvelope } from '../net/sync/codec'
import type { DurableRpcDispatcher } from '../net/sync/rpcDispatcher'
import type { NetDatabase } from '../net/store/database'

export interface BridgeArtifactResult {
  kind: 'bridge.artifact.result.v1'
  descriptor: StreamDescriptor
  artifact: RpcArtifactRef
}

/** A stream grants exactly one same-user request's registered method capability. */
export class BridgeArtifacts implements StreamAuthority {
  constructor(private readonly options: {
    db: NetDatabase; identity: IdentityService; keys: KeyStore; store: StreamStore; blobs: BlobStore
    rpc: DurableRpcDispatcher; clock: Clock; fallback: StreamAuthority
    ownsRequest?: (rpc: RpcId, method: string, target: NodeId) => boolean
    canonicalRequest?: (rpc: RpcId, method: string, target: NodeId) => RpcId | undefined
    onPublished?: (stream: StreamId, record: import('../../shared/net').StoredRecord) => void
  }) {
    options.db.database.exec('CREATE TABLE IF NOT EXISTS net_bridge_artifacts(caller TEXT NOT NULL,rpc TEXT NOT NULL,method TEXT NOT NULL,stream TEXT NOT NULL UNIQUE,PRIMARY KEY(caller,rpc,method)) STRICT')
    options.db.database.exec('CREATE TABLE IF NOT EXISTS net_bridge_artifact_uploads(stream TEXT NOT NULL,blob TEXT NOT NULL,caller TEXT NOT NULL,PRIMARY KEY(stream,blob,caller)) STRICT')
    options.rpc.setResultPublisher((result, context, method) => this.prepareResult(result, context, method))
    options.rpc.register({ method: 'bridge.artifacts.open', capability: 'read', mutating: true,
      validate: params => {
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw new NetError('bad_request')
        const p = params as Record<string, unknown>
        if (Object.keys(p).length !== 2 || !isId('rpc', p.forRpcId) || typeof p.forMethod !== 'string') throw new NetError('bad_request')
        return { forRpcId: p.forRpcId, forMethod: p.forMethod }
      },
      capabilityFor: params => {
        const name = (params as { forMethod: string }).forMethod
        const method = options.rpc.methodInfo(name)
        if (!method?.uploadEnabled || method.capabilityFor) throw new NetError('forbidden')
        return method.capability
      },
      authorize: (params, context) => { const p = params as { forMethod: string }; if (!options.rpc.authorizedMethod(p.forMethod, context.caller).uploadEnabled) throw new NetError('forbidden') },
      handle: async (params, context) => {
        const p = params as { forRpcId: RpcId; forMethod: string }
        const method = options.rpc.authorizedMethod(p.forMethod, context.caller)
        return options.db.transaction(() => this.ensure(p.forRpcId, method, context.caller))
      }
    })
  }

  canRead(stream: StreamId, peer: SyncSession['peer']): boolean {
    const descriptor = this.options.store.getStream(stream)
    if (descriptor?.kind !== 'node.artifact') return this.options.fallback.canRead(stream, peer)
    try { this.scope(descriptor, peer); return true } catch { return false }
  }
  canFetchBlob(stream: StreamId, blob: BlobId, peer: SyncSession['peer']): boolean {
    const descriptor = this.options.store.getStream(stream)
    if (descriptor?.kind !== 'node.artifact') return this.options.fallback.canFetchBlob(stream, blob, peer)
    return this.canRead(stream, peer) && this.options.blobs.isReferenced(blob, stream)
  }
  acceptBlob(stream: StreamId, blob: BlobId, bytes: number, sealed: boolean, peer: SyncSession['peer']): void {
    const descriptor = this.options.store.getStream(stream)
    if (descriptor?.kind !== 'node.artifact') return this.options.fallback.acceptBlob(stream, blob, bytes, sealed, peer)
    const method = this.scope(descriptor, peer)
    if (!method.uploadEnabled || !isBlobId(blob) || sealed || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > DEFAULT_MAX_BLOB_BYTES) throw new NetError('forbidden')
  }
  blobCommitted(stream: StreamId, blob: BlobId, bytes: number, sealed: boolean, peer: SyncSession['peer']): void {
    const descriptor = this.options.store.getStream(stream)
    if (descriptor?.kind !== 'node.artifact') { this.options.fallback.blobCommitted?.(stream, blob, bytes, sealed, peer); return }
    this.acceptBlob(stream, blob, bytes, sealed, peer)
    if (this.options.blobs.size(blob) !== bytes) throw new NetError('conflict')
    this.options.db.transaction(() => { this.options.db.charge(1); this.options.db.database.prepare('INSERT OR IGNORE INTO net_bridge_artifact_uploads VALUES(?,?,?)').run(stream, blob, peer.node) })
  }
  append(stream: StreamId, id: EventId, bytes: Uint8Array, sig: Uint8Array, peer: SyncSession['peer']): AppendOutcome {
    const descriptor = this.options.store.getStream(stream)
    if (descriptor?.kind !== 'node.artifact') return this.options.fallback.append(stream, id, bytes, sig, peer)
    const method = this.scope(descriptor, peer), envelope = decodeEnvelope(bytes).envelope as import('../../shared/net').Envelope<'artifact.published'>, binding = descriptor.artifact!
    if (!method.uploadEnabled || envelope.type !== 'artifact.published' || envelope.sealed || envelope.minor > NET_PROTO_MINOR || envelope.id !== id || envelope.stream !== stream || envelope.author.node !== peer.node || envelope.author.user !== peer.user || envelope.body?.purpose !== 'input' || envelope.body.rpc !== binding.rpc || !envelope.blobs?.length) throw new NetError('forbidden')
    this.options.identity.verifyAuthor(envelope.author, bytes, sig, this.options.clock.now(), 'newWork')
    for (const ref of envelope.blobs) {
      if (ref.sealed || this.options.blobs.size(ref.id) !== ref.bytes) throw new NetError('bad_request')
      if (!this.options.db.database.prepare('SELECT 1 FROM net_bridge_artifact_uploads WHERE stream=? AND blob=? AND caller=?').get(stream, ref.id, peer.node)) throw new NetError('forbidden', 'This request did not upload the referenced bytes.')
    }
    return this.options.db.transaction(() => {
      const outcome = this.options.store.appendAsAuthority(stream, { id, envelope: bytes, sig, recvTs: this.options.clock.now() })
      for (const ref of envelope.blobs!) this.options.blobs.addRef(ref.id, stream, id)
      return outcome
    })
  }

  /** Receiver must have journalled this request; a host descriptor cannot grant scope. */
  canReceive(descriptor: StreamDescriptor, peer: SyncSession['peer']): boolean {
    try {
      const self = this.options.identity.self(), binding = descriptor.artifact
      if (!self || descriptor.kind !== 'node.artifact' || descriptor.authority !== peer.node || peer.user !== self.user || !binding || binding.user !== self.user || binding.caller !== self.node || !this.options.ownsRequest?.(binding.rpc, binding.method, peer.node)) return false
      const own = this.localPeer()
      return this.options.rpc.authorizedMethod(binding.method, own).capability === binding.capability
    } catch { return false }
  }
  verifyRecord(record: import('../../shared/net').StoredRecord, descriptor: StreamDescriptor): void {
    if (descriptor.kind !== 'node.artifact') return
    const envelope = decodeEnvelope(record.envelope).envelope as import('../../shared/net').Envelope<'artifact.published'>, binding = descriptor.artifact!
    if (envelope.type !== 'artifact.published' || envelope.minor > NET_PROTO_MINOR || envelope.sealed || envelope.body?.rpc !== binding.rpc || !envelope.blobs?.length || envelope.author.user !== binding.user) throw new NetError('forbidden')
    if (envelope.body.purpose === 'input' ? envelope.author.node !== binding.caller : envelope.author.node !== descriptor.authority) throw new NetError('forbidden')
  }
  input(ref: RpcArtifactRef, context: RpcContext, method: string): Uint8Array {
    const descriptor = this.options.store.getStream(ref.stream)
    if (!descriptor || descriptor.kind !== 'node.artifact') throw new NetError('forbidden')
    if (!this.scope(descriptor, context.caller).uploadEnabled) throw new NetError('forbidden')
    const original = this.options.rpc.originalRequest(context.id, context.caller, method) ?? context.id
    if (descriptor.artifact!.rpc !== original || descriptor.artifact!.method !== method) throw new NetError('forbidden')
    const record = this.options.store.getById(ref.stream, ref.event)
    if (!record) throw new NetError('forbidden')
    this.verifyRecord(record, descriptor)
    const envelope = decodeEnvelope(record.envelope).envelope as import('../../shared/net').Envelope<'artifact.published'>
    this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, envelope.ts, 'history')
    if (envelope.type !== 'artifact.published' || envelope.body?.purpose !== 'input' || !envelope.blobs?.some(row => row.id === ref.blob) || !this.options.blobs.isReferenced(ref.blob, ref.stream)) throw new NetError('forbidden')
    return this.read(ref.blob)
  }
  async resolveResult(value: unknown, session: SyncSession, rpc: RpcId, method: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new NetError('cancelled')
    if (!value || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'bridge.artifact.result.v1') return value
    const result = value as BridgeArtifactResult, descriptor = result.descriptor, ref = result.artifact
    const original = this.options.canonicalRequest?.(rpc, method, session.peer.node) ?? rpc
    if (!this.options.ownsRequest?.(rpc, method, session.peer.node) || Object.keys(result).length !== 3 || !validateStreamDescriptor(descriptor) || !ref || Object.keys(ref).length !== 3 || !isId('stream', ref.stream) || !isId('event', ref.event) || !isBlobId(ref.blob) || descriptor.id !== ref.stream || descriptor.artifact?.rpc !== original || descriptor.artifact.method !== method || !this.canReceive(descriptor, session.peer)) throw new NetError('forbidden')
    this.options.store.createStream(descriptor, 1)
    if (!this.options.store.getById(ref.stream, ref.event)) {
      await new Promise<void>((resolve, reject) => {
        let subscription: { close(): void } | undefined, closed = false
        const finish = (error?: unknown): void => { if (closed) return; closed = true; timer.cancel(); subscription?.close(); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
        const abort = (): void => finish(new NetError('cancelled'))
        const timer = this.options.clock.setTimeout(() => finish(new NetError('deadline_exceeded')), 30_000)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) { abort(); return }
        try { subscription = session.subscribe(ref.stream, {
          onRecord: record => { if (decodeEnvelope(record.envelope).envelope.id === ref.event) finish() },
          onCaughtUp: () => { if (!this.options.store.getById(ref.stream, ref.event)) finish(new NetError('forbidden')) },
          onSnapshotInstalled: () => { if (this.options.store.getById(ref.stream, ref.event)) finish(); else finish(new NetError('forbidden')) },
          onError: code => finish(new NetError(code))
        }) } catch (error) { finish(error) }
        if (closed) subscription?.close()
      })
    }
    if (!this.canReceive(descriptor, session.peer)) throw new NetError('forbidden')
    const record = this.options.store.getById(ref.stream, ref.event)!
    this.verifyRecord(record, descriptor)
    const envelope = decodeEnvelope(record.envelope).envelope as import('../../shared/net').Envelope<'artifact.published'>
    this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, envelope.ts, 'history')
    const publication = envelope.blobs?.find(row => row.id === ref.blob)
    if (envelope.body?.purpose !== 'result' || !publication || publication.sealed) throw new NetError('forbidden')
    const bytes = await session.getBlob(ref.stream, ref.blob, { signal })
    if (signal?.aborted) throw new NetError('cancelled')
    if (bytes.length !== publication.bytes || `blb_${createHash('sha256').update(bytes).digest('hex')}` !== ref.blob) throw new NetError('conflict')
    let decoded: unknown
    try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new NetError('bad_request') }
    if (!Buffer.from(canonicalJson(decoded)).equals(bytes)) throw new NetError('bad_request')
    return decoded
  }
  private scope(descriptor: StreamDescriptor, peer: SyncSession['peer']): RpcMethod {
    const self = this.options.identity.self(), binding = descriptor.artifact
    if (!self || descriptor.authority !== self.node || !binding || binding.user !== self.user || peer.user !== self.user || peer.node !== binding.caller) throw new NetError('forbidden')
    const method = this.options.rpc.authorizedMethod(binding.method, peer)
    if (method.capability !== binding.capability) throw new NetError('forbidden')
    return method
  }
  private ensure(id: RpcId, method: RpcMethod, peer: SyncSession['peer']): StreamDescriptor {
    const rpc = this.options.rpc.originalRequest(id, peer, method.method) ?? id
    const held = this.options.db.database.prepare('SELECT stream FROM net_bridge_artifacts WHERE caller=? AND rpc=? AND method=?').get(peer.node, rpc, method.method)
    if (held) {
      const descriptor = this.options.store.getStream(held.stream as StreamId)
      if (!descriptor || descriptor.artifact?.capability !== method.capability) throw new NetError('storage_corrupt')
      return descriptor
    }
    const descriptor: StreamDescriptor = { id: newId('stream'), kind: 'node.artifact', authority: this.options.identity.self()!.node, artifact: { user: peer.user, caller: peer.node, rpc, method: method.method, capability: method.capability }, createdAt: this.options.clock.now() }
    this.options.store.createStream(descriptor, 1)
    this.options.db.charge(1)
    this.options.db.database.prepare('INSERT INTO net_bridge_artifacts VALUES(?,?,?,?)').run(peer.node, rpc, method.method, descriptor.id)
    return descriptor
  }
  private prepareResult(result: unknown, context: RpcContext, method: RpcMethod): { result: BridgeArtifactResult; commit(): void } {
    const bytes = canonicalJson(result)
    const publication = this.preparePublication(bytes, 'application/json', context, method.method)
    return { result: { kind: 'bridge.artifact.result.v1', descriptor: publication.descriptor, artifact: publication.ref }, commit: publication.commit }
  }
  /** Filesystem bytes are prepared outside the bounded terminal SQL transaction. */
  preparePublication(bytes: Uint8Array, mime: string, context: RpcContext, name: string): { descriptor: StreamDescriptor; ref: RpcArtifactRef; commit(): void } {
    const method = this.options.rpc.authorizedMethod(name, context.caller)
    if (typeof mime !== 'string' || !mime.length || mime.length > 128) throw new NetError('bad_request')
    if (bytes.byteLength > DEFAULT_MAX_BLOB_BYTES) throw new NetError('too_large', 'RPC artifact exceeds the local blob bound.')
    const blob = `blb_${createHash('sha256').update(bytes).digest('hex')}` as BlobId
    const upload = this.options.blobs.begin(blob, bytes.length, false)
    try { for (let offset = 0; offset < bytes.length; offset += BLOB_CHUNK_BYTES) upload.write(offset, bytes.subarray(offset, offset + BLOB_CHUNK_BYTES)); upload.commit() } catch (error) { upload.abort(); throw error }
    const descriptor = this.options.db.transaction(() => this.ensure(context.id, method, context.caller))
    const self = this.localPeer(), event = newId('event')
    const envelope = encodeEnvelope({ v: 1, minor: 0, id: event, stream: descriptor.id, type: 'artifact.published', crit: false, author: { user: self.user, node: self.node, keyEpoch: self.delegation.keyEpoch }, ts: this.options.clock.now(), body: { rpc: descriptor.artifact!.rpc, purpose: 'result' }, blobs: [{ id: blob, bytes: bytes.length, mime }] })
    const sig = this.options.keys.signAsNode(envelope)
    return { descriptor, ref: { stream: descriptor.id, event, blob }, commit: () => {
      this.scope(descriptor, context.caller)
      const position = this.options.store.appendAsAuthority(descriptor.id, { id: event, envelope, sig, recvTs: this.options.clock.now() })
      this.options.blobs.addRef(blob, descriptor.id, event)
      this.options.db.afterCommit(() => this.options.onPublished?.(descriptor.id, { ...position, envelope, sig }))
    } }
  }
  private localPeer(): SyncSession['peer'] {
    const identity = this.options.identity, self = identity.self(), root = self && identity.pinnedRootKey(self.user), signed = identity.roster()
    if (!self || !root || !signed) throw new NetError('not_enrolled')
    const roster = identity.verifySigned<import('../../shared/net').Roster>(signed, root)
    const delegation = roster.nodes.map(row => identity.verifySigned<import('../../shared/net').NodeDelegation>(row, root)).filter(row => row.subject === self.node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (!delegation) throw new NetError('bad_delegation')
    return { ...self, delegation }
  }
  private read(blob: BlobId): Uint8Array {
    const size = this.options.blobs.size(blob)
    if (size === undefined || size > DEFAULT_MAX_BLOB_BYTES) throw new NetError('bad_request')
    const parts: Uint8Array[] = []
    for (let at = 0; at < size; at += BLOB_CHUNK_BYTES) parts.push(this.options.blobs.read(blob, at, Math.min(BLOB_CHUNK_BYTES, size - at)))
    const bytes = Buffer.concat(parts)
    if (`blb_${createHash('sha256').update(bytes).digest('hex')}` !== blob) throw new NetError('conflict')
    return bytes
  }
}

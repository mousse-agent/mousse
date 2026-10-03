import type { BlobId, EventId, NodeDelegation, Roster, StreamId } from '../../../shared/net'
import { NetError } from '../../../shared/net/errors'
import { NET_PROTO_MINOR } from '../../../shared/net/limits'
import type { AppendOutcome, BlobStore, Clock, IdentityService, StreamAuthority, StreamStore, SyncSession } from '../contracts'
import { decodeEnvelope } from './codec'

/** Same-user Bridge scope. Spaces require their independent meta authorization service. */
export class NodeStreamAuthority implements StreamAuthority {
  constructor(private readonly identity: IdentityService, private readonly store: StreamStore, private readonly blobs: BlobStore, private readonly clock: Clock) {}
  canRead(stream: StreamId, peer: SyncSession['peer']): boolean {
    try {
      const descriptor = this.store.getStream(stream)
      if (!descriptor || descriptor.authority !== this.identity.self()?.node || peer.user !== this.identity.self()?.user) return false
      const delegation = this.current(peer)
      if (descriptor.kind === 'node.thread') return delegation.caps.includes('read')
      // Artifact scopes also require the durable request-alias registry (P3).
      return false
    } catch { return false }
  }
  append(stream: StreamId, id: EventId, bytes: Uint8Array, sig: Uint8Array, peer: SyncSession['peer']): AppendOutcome {
    const descriptor = this.store.getStream(stream), self = this.identity.self()
    if (!descriptor || !self) throw new NetError('stream_unknown')
    const envelope = decodeEnvelope(bytes).envelope
    this.current(peer)
    if (descriptor.kind !== 'node.thread' || descriptor.authority !== self.node || peer.node !== self.node || peer.user !== self.user) throw new NetError('forbidden')
    if (envelope.id !== id || envelope.stream !== stream || envelope.author.node !== peer.node || envelope.author.user !== peer.user || envelope.sealed || envelope.minor > NET_PROTO_MINOR) throw new NetError('bad_request')
    this.identity.verifyAuthor(envelope.author, bytes, sig, this.clock.now(), 'newWork')
    if (envelope.blobs?.some(blob => !this.blobs.has(blob.id))) throw new NetError('bad_request')
    return this.store.appendAsAuthority(stream, { id, envelope: bytes, sig, recvTs: this.clock.now() })
  }
  canFetchBlob(stream: StreamId, blob: BlobId, peer: SyncSession['peer']): boolean { return this.canRead(stream, peer) && this.blobs.isReferenced(blob, stream) }
  acceptBlob(_stream: StreamId, _blob: BlobId, _bytes: number, _sealed: boolean, _peer: SyncSession['peer']): void {
    // node.thread is authority-write-only; uploads use request-bound P3 artifacts.
    throw new NetError('forbidden')
  }
  private current(peer: SyncSession['peer']): NodeDelegation {
    const root = this.identity.pinnedRootKey(peer.user), signed = this.identity.roster(peer.user)
    if (!root || !signed || this.identity.rosterState(peer.user) !== 'ok') throw new NetError('roster_conflict')
    const roster = this.identity.verifySigned<Roster>(signed, root)
    const rows = roster.nodes.map(row => this.identity.verifySigned<NodeDelegation>(row, root)).filter(row => row.subject === peer.node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)
    const node = rows[0]
    if (!node || node.keyEpoch !== peer.delegation.keyEpoch || node.expiresAt <= this.clock.now() || node.issuedAt > this.clock.now()) throw new NetError('bad_delegation')
    if (roster.revoked.some(row => row.subject === node.subject && row.throughKeyEpoch >= node.keyEpoch)) throw new NetError('revoked')
    return node
  }
}

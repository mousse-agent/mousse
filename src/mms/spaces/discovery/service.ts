import type { IdentityService, KeyStore, StreamStore, SyncSession } from '../../net/contracts'
import type { SessionDiscoveryPort } from '../../net/sync/session'
import { NetDatabase, same } from '../../net/store/database'
import { verifyDocument } from '../../net/identity/crypto'
import { decodeEnvelope } from '../../net/sync/codec'
import type { MetaProjection, SpaceHostService } from '../host'
import type { PrivateSpaceService } from '../private'
import {
  NetError,
  SPACE_DISCOVERY_MAX_CONTROLS,
  SPACE_DISCOVERY_MAX_CONTROL_BYTES,
  spaceMetaStream,
  type NodeDelegation,
  type BotDelegation,
  type Roster,
  type Signed,
  type SpaceDiscoveryGetMessage,
  type SpaceStreamDiscoveryProof,
  type StoredRecord,
  type StreamDescriptor,
  type StreamId,
  type SpaceId,
  type UserId,
  type BotId
} from '../../../shared/net'
export interface SpaceDiscoveryOptions {
  db: NetDatabase
  identity: IdentityService
  historyIdentity: IdentityService
  keys: KeyStore
  store: StreamStore
  meta: MetaProjection
  private: PrivateSpaceService
  host: SpaceHostService
}
/** Exact-ID, current-authority discovery. Every source lookup is restricted to the active generation. */
export class SpaceStreamDiscoveryService implements SessionDiscoveryPort {
  constructor(readonly options: SpaceDiscoveryOptions) {
    options.db.transaction(() =>
      options.db.database.exec(`
 CREATE INDEX IF NOT EXISTS net_space_discovery_controls ON net_records(generation,json_extract(CAST(envelope AS TEXT),'$.type'),epoch,seq);
 CREATE INDEX IF NOT EXISTS net_space_discovery_openings ON net_records(generation,json_extract(CAST(envelope AS TEXT),'$.type'),json_extract(CAST(envelope AS TEXT),'$.body.stream'));
 `)
    )
  }
  get(request: SpaceDiscoveryGetMessage, peer: SyncSession['peer']): SpaceStreamDiscoveryProof {
    const { db, identity, keys, store, meta, host, private: priv } = this.options
    if (db.inTransaction) throw new NetError('bad_request')
    const state = meta.state(request.space),
      self = identity.self(),
      head = store.head(spaceMetaStream(request.space))
    if (
      !state ||
      state.frozen ||
      state.upgradeRequired ||
      !self ||
      self.user !== state.descriptor.owner ||
      self.node !== state.descriptor.hostNode ||
      keys.nodeKeys().transport !== state.descriptor.hostTransportKey
    )
      throw new NetError('forbidden')
    if (!same(request.metaHead, state.applied) || !same(head, state.applied))
      throw new NetError('meta_stale')
    if (
      !host.canRead(spaceMetaStream(request.space), peer) ||
      identity.pinnedRootKey(peer.user) !== state.members.get(peer.user)?.rootKey
    )
      throw new NetError('not_member')
    const descriptor = store.getStream(request.stream)
    if (
      !descriptor ||
      descriptor.space !== request.space ||
      descriptor.authority !== state.descriptor.hostNode ||
      !['space.thread', 'space.private'].includes(descriptor.kind) ||
      !descriptor.parent ||
      !host.canRead(descriptor.id, peer) ||
      !host.canRead(descriptor.parent, peer)
    )
      throw new NetError('forbidden')
    if (descriptor.kind === 'space.thread' && !host.threadBinding(descriptor.id))
      throw new NetError('forbidden')
    if (descriptor.kind === 'space.private' && !priv.authorizationAudience(descriptor))
      throw new NetError('forbidden')
    const streamHead = store.head(descriptor.id)
    if (streamHead.seq < 1) throw new NetError('forbidden')
    const parent = this.opening(descriptor),
      controllerEvents: StoredRecord[] = []
    if (descriptor.kind === 'space.private') {
      const gen = this.generation(descriptor.id),
        rows = db.database
          .prepare(
            "SELECT epoch,seq,length(envelope)+length(sig) AS bytes FROM net_records WHERE generation=? AND json_extract(CAST(envelope AS TEXT),'$.type')='participants.changed' ORDER BY epoch,seq LIMIT 65"
          )
          .all(gen)
      if (
        !rows.length ||
        rows.length > SPACE_DISCOVERY_MAX_CONTROLS ||
        rows.reduce((n, row) => n + Number(row.bytes), 0) > SPACE_DISCOVERY_MAX_CONTROL_BYTES
      )
        throw new NetError('too_large')
      for (const row of rows) {
        const record = db.database
          .prepare(
            'SELECT epoch,seq,recv_ts,envelope,sig FROM net_records WHERE generation=? AND epoch=? AND seq=?'
          )
          .get(gen, row.epoch!, row.seq!)!
        controllerEvents.push(stored(record))
      }
      const current = priv.state(descriptor.id)!,
        last = controllerEvents.at(-1)!
      if (
        !same(current.position, { epoch: last.epoch, seq: last.seq }) ||
        !same(current.control, decodeEnvelope(last.envelope).envelope.body)
      )
        throw new NetError('meta_stale')
    }
    return {
      descriptor,
      metaHead: request.metaHead,
      head: streamHead,
      parentOpenEvent: parent,
      controllerEvents
    }
  }
  revalidate(
    request: SpaceDiscoveryGetMessage,
    proof: SpaceStreamDiscoveryProof,
    peer: SyncSession['peer']
  ): void {
    const current = this.get(request, peer)
    if (
      !same(current.descriptor, proof.descriptor) ||
      !same(current.metaHead, proof.metaHead) ||
      !same(current.head, proof.head) ||
      !sameRecord(current.parentOpenEvent, proof.parentOpenEvent) ||
      current.controllerEvents.length !== proof.controllerEvents.length ||
      current.controllerEvents.some(
        (record, index) => !sameRecord(record, proof.controllerEvents[index])
      )
    )
      throw new NetError('meta_stale')
  }
  evidence(
    request: SpaceDiscoveryGetMessage,
    proof: SpaceStreamDiscoveryProof,
    peer: SyncSession['peer']
  ): readonly Signed[] {
    this.revalidate(request, proof, peer)
    return this.recipientEvidence(request.space, proof.controllerEvents)
  }
  recordEvidence(
    stream: StreamId,
    records: readonly StoredRecord[],
    peer: SyncSession['peer']
  ): readonly Signed[] {
    const { db, store, host, private: priv } = this.options,
      descriptor = store.getStream(stream)
    if (descriptor?.kind !== 'space.private') return []
    if (db.inTransaction) throw new NetError('bad_request')
    if (!descriptor.space || !host.canRead(stream, peer) || !priv.authorizationAudience(descriptor))
      throw new NetError('forbidden')
    const controls = records.filter(
      (record) => decodeEnvelope(record.envelope).envelope.type === 'participants.changed'
    )
    if (
      controls.length > SPACE_DISCOVERY_MAX_CONTROLS ||
      controls.reduce((n, record) => n + record.envelope.length + record.sig.length, 0) >
        SPACE_DISCOVERY_MAX_CONTROL_BYTES
    )
      throw new NetError('too_large')
    for (const record of controls) {
      const envelope = decodeEnvelope(record.envelope).envelope,
        original = store.getById(stream, envelope.id)
      if (envelope.stream !== stream || !original || !sameRecord(original, record))
        throw new NetError('meta_stale')
    }
    return this.recipientEvidence(descriptor.space, controls)
  }
  private recipientEvidence(space: SpaceId, controls: readonly StoredRecord[]): readonly Signed[] {
    const evidence = new Map<string, Signed>(),
      { meta, private: priv, identity } = this.options
    for (const record of controls) {
      const envelope = decodeEnvelope(record.envelope).envelope,
        body = envelope.body as {
          participants: Array<UserId | BotId>
          wrapped: Array<{ node: string; recipientAgreementKey: string }>
        },
        users = new Map<UserId, BotDelegation[]>()
      for (const participant of body.participants) {
        const bot = participant.startsWith('bot_')
            ? meta.botAt(space, participant as BotId, envelope.auth!)
            : undefined,
          user = participant.startsWith('usr_') ? (participant as UserId) : bot?.owner,
          member = user && meta.memberAt(space, user, envelope.auth!)
        if (!user || !member) throw new NetError('bad_delegation')
        const bots = users.get(user) ?? []
        if (bot)
          bots.push(verifyDocument<BotDelegation>(bot.delegation, member.rootKey, 'botDelegation'))
        users.set(user, bots)
      }
      for (const [user, bots] of users) {
        const member = meta.memberAt(space, user, envelope.auth!)!,
          candidates = new Map<string, Signed>(),
          current = identity.roster(user),
          retained = priv.options.rosterAt?.(space, user, envelope.ts, member.rootKey)
        const add = (signed: Signed | undefined) => {
          if (signed) candidates.set(signed.sig, signed)
        }
        add(current)
        add(retained)
        const known = current && verifyDocument<Roster>(current, member.rootKey, 'roster'),
          owned =
            known?.nodes
              .map((row) => verifyDocument<NodeDelegation>(row, member.rootKey, 'nodeDelegation'))
              .filter(
                (node) =>
                  node.owner === user &&
                  body.wrapped.some(
                    (wrap) =>
                      wrap.node === node.subject && wrap.recipientAgreementKey === node.keys.agree
                  )
              ) ?? []
        for (const node of owned)
          add(
            identity.historicalRosterFor(
              { user, node: node.subject, keyEpoch: node.keyEpoch },
              envelope.ts
            )
          )
        for (const bot of bots)
          add(
            identity.historicalRosterFor(
              { bot: bot.subject, node: bot.hostNode, keyEpoch: bot.keyEpoch },
              envelope.ts
            )
          )
        const expected = new Map(
            owned.map((node) => [
              node.subject,
              body.wrapped.find(
                (wrap) =>
                  wrap.node === node.subject && wrap.recipientAgreementKey === node.keys.agree
              )!.recipientAgreementKey
            ])
          ),
          accepted: Array<{ signed: Signed; roster: Roster }> = []
        for (const signed of candidates.values()) {
          const roster = verifyDocument<Roster>(signed, member.rootKey, 'roster')
          if (
            roster.owner !== user ||
            roster.rootKey !== member.rootKey ||
            roster.issuedAt > envelope.ts
          )
            continue
          const latest = new Map<string, NodeDelegation>()
          for (const row of roster.nodes) {
            const node = verifyDocument<NodeDelegation>(row, member.rootKey, 'nodeDelegation'),
              before = latest.get(node.subject)
            if (node.owner !== user) throw new NetError('bad_delegation')
            if (
              !before ||
              node.keyEpoch > before.keyEpoch ||
              (node.keyEpoch === before.keyEpoch && node.issuedAt > before.issuedAt)
            )
              latest.set(node.subject, node)
          }
          const eligible = [...latest.values()].filter(
            (node) =>
              node.issuedAt <= envelope.ts &&
              envelope.ts < node.expiresAt &&
              !roster.revoked.some(
                (r) =>
                  r.subject === node.subject &&
                  r.throughKeyEpoch >= node.keyEpoch &&
                  r.revokedAt <= envelope.ts
              )
          )
          if (
            eligible.length !== expected.size ||
            eligible.some((node) => expected.get(node.subject) !== node.keys.agree) ||
            bots.some(
              (bot) =>
                !roster.bots.some((row) => {
                  const lease = verifyDocument<BotDelegation>(row, member.rootKey, 'botDelegation')
                  return (
                    lease.owner === user &&
                    lease.subject === bot.subject &&
                    lease.keyEpoch === bot.keyEpoch &&
                    lease.hostNode === bot.hostNode &&
                    lease.keys.sign === bot.keys.sign &&
                    lease.issuedAt <= envelope.ts &&
                    envelope.ts < lease.expiresAt &&
                    !roster.revoked.some(
                      (r) =>
                        r.subject === lease.subject &&
                        r.throughKeyEpoch >= lease.keyEpoch &&
                        r.revokedAt <= envelope.ts
                    )
                  )
                })
            )
          )
            continue
          accepted.push({ signed, roster })
        }
        accepted.sort(
          (a, b) =>
            b.roster.issuedAt - a.roster.issuedAt ||
            b.roster.recoveryEpoch - a.roster.recoveryEpoch ||
            b.roster.version - a.roster.version
        )
        if (!accepted.length) throw new NetError('bad_delegation')
        evidence.set(accepted[0].signed.sig, accepted[0].signed)
        if (
          evidence.size > 64 ||
          [...evidence.values()].reduce(
            (n, signed) => n + Buffer.byteLength(JSON.stringify(signed)),
            0
          ) >
            512 * 1024
        )
          throw new NetError('too_large')
      }
    }
    return [...evidence.values()]
  }
  /** Consumer adoption requires exact original committed parent bytes before any descriptor or key changes. */
  accept(proof: SpaceStreamDiscoveryProof, peer: SyncSession['peer']): void {
    const { db, store, meta, identity, historyIdentity, private: priv } = this.options,
      descriptor = proof.descriptor,
      state = descriptor.space && meta.state(descriptor.space),
      self = identity.self()
    if (db.inTransaction) throw new NetError('bad_request')
    if (
      !state ||
      state.frozen ||
      state.upgradeRequired ||
      !self ||
      !state.members.has(self.user) ||
      !same(state.applied, proof.metaHead) ||
      peer.user !== state.descriptor.owner ||
      peer.node !== state.descriptor.hostNode ||
      peer.delegation.keys.transport !== state.descriptor.hostTransportKey ||
      descriptor.authority !== peer.node ||
      !descriptor.parent
    )
      throw new NetError('forbidden')
    const envelope = decodeEnvelope(proof.parentOpenEvent.envelope).envelope,
      body = envelope.body as { stream?: string; private?: boolean },
      original = store.getById(descriptor.parent, envelope.id),
      parent = store.getStream(descriptor.parent)
    if (
      !original ||
      !sameRecord(original, proof.parentOpenEvent) ||
      !parent ||
      parent.space !== descriptor.space ||
      parent.authority !== descriptor.authority ||
      envelope.stream !== parent.id ||
      envelope.type !== 'thread.opened' ||
      body.stream !== descriptor.id ||
      body.private !== (descriptor.kind === 'space.private') ||
      !meta.canRead(descriptor.space!, parent, self.user)
    )
      throw new NetError('forbidden')
    const existing = store.getStream(descriptor.id)
    if (existing) {
      if (!same(existing, descriptor)) throw new NetError('conflict')
      if (
        descriptor.kind === 'space.private' &&
        (!priv.state(descriptor.id) || !priv.canRead(descriptor, this.selfPeer()))
      )
        throw new NetError('forbidden')
      return
    }
    if (descriptor.kind === 'space.private') {
      priv.acceptBootstrap({
        descriptor,
        controllerEvents: proof.controllerEvents,
        parentOpenEvent: proof.parentOpenEvent
      })
    } else {
      const author = historyIdentity.verifyAuthor(
        envelope.author,
        original.envelope,
        original.sig,
        envelope.ts,
        'history'
      )
      if (
        descriptor.kind !== 'space.thread' ||
        proof.controllerEvents.length ||
        author.kind !== 'node' ||
        author.user !== state.owner ||
        author.node !== descriptor.authority ||
        !envelope.auth ||
        meta.memberAt(descriptor.space!, author.user, envelope.auth)?.role !== 'owner' ||
        !meta.canRead(descriptor.space!, descriptor, self.user)
      )
        throw new NetError('forbidden')
      store.createStream(descriptor, proof.head.epoch)
    }
  }
  private generation(stream: string): string {
    const row = this.options.db.database
      .prepare('SELECT active_generation FROM net_streams WHERE id=?')
      .get(stream)
    if (!row) throw new NetError('stream_unknown')
    return row.active_generation as string
  }
  private opening(descriptor: StreamDescriptor): StoredRecord {
    const rows = this.options.db.database
      .prepare(
        "SELECT epoch,seq,recv_ts,envelope,sig FROM net_records WHERE generation=? AND json_extract(CAST(envelope AS TEXT),'$.type')='thread.opened' AND json_extract(CAST(envelope AS TEXT),'$.body.stream')=? LIMIT 2"
      )
      .all(this.generation(descriptor.parent!), descriptor.id)
    if (rows.length !== 1) throw new NetError('forbidden')
    return stored(rows[0])
  }
  private selfPeer(): SyncSession['peer'] {
    const identity = this.options.identity,
      self = identity.self()!,
      root = identity.pinnedRootKey(self.user)!,
      roster = identity.verifySigned<Roster>(identity.roster()!, root),
      delegation = roster.nodes
        .map((s) => identity.verifySigned<NodeDelegation>(s, root))
        .filter((row) => row.subject === self.node)
        .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (!delegation) throw new NetError('bad_delegation')
    return { ...self, delegation }
  }
}
function stored(row: Record<string, unknown>): StoredRecord {
  return {
    epoch: row.epoch as number,
    seq: row.seq as number,
    recvTs: row.recv_ts as number,
    envelope: new Uint8Array(row.envelope as Uint8Array),
    sig: new Uint8Array(row.sig as Uint8Array)
  }
}
function sameRecord(a: StoredRecord, b: StoredRecord): boolean {
  return (
    a.epoch === b.epoch &&
    a.seq === b.seq &&
    a.recvTs === b.recvTs &&
    Buffer.from(a.envelope).equals(b.envelope) &&
    Buffer.from(a.sig).equals(b.sig)
  )
}

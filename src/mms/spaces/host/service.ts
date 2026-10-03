import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppendOutcome, BlobStore, Clock, IdentityService, KeyStore, MuxMessage, SecureChannel, StreamAuthority, StreamStore, SyncSession } from '../../net/contracts';
import type { SpaceJoinAdmissionPort } from '../../net/enrollment/quarantine';
import { invitationProof, invitationProofKey } from '../../net/enrollment/service';
import { decodeBase64, signedDocument, verifyDocument } from '../../net/identity/crypto';
import { canonicalJson, decodeEnvelope, encodeMessage, parseProtocolJson } from '../../net/sync/codec';
import { NetDatabase, json } from '../../net/store/database';
import { SqliteQuotaRateLedger } from '../../net/store/limits';
import { systemClock } from '../../net/clock';
import { DEFAULT_MAX_BLOB_BYTES, SPACE_DEFAULT_QUOTA_BYTES, NET_ERRORS, NetError, newId, isCritical, isKnownEventType } from '../../../shared/net';
import type { BlobId, BotId, Envelope, EventId, ExecutionId, MemberRecord, NodeDelegation, Roster, Signed, SpaceDescriptor, SpaceId, SpaceInviteAuthorization, SpaceJoinRequestMessage, SpaceSettings, StoredRecord, StreamDescriptor, StreamId } from '../../../shared/net';
import { MetaProjection } from './meta';
import { encodeSpaceInvite } from './invite';
type Peer = SyncSession['peer'];
export interface PrivateSpaceAuthorization {
    canRead(stream: StreamDescriptor, peer: Peer): boolean;
    canWrite(stream: StreamDescriptor, envelope: Envelope, peer: Peer): boolean;
    canUpload(stream: StreamDescriptor, peer: Peer): boolean;
}
export interface BotSpaceAuthorization {
    canWrite(stream: StreamDescriptor, envelope: Envelope, peer: Peer, binding?: ThreadBinding): boolean;
}
export interface ThreadBinding {
    space: SpaceId;
    stream: StreamId;
    parent: StreamId;
    bot: BotId;
    trigger: EventId;
    execution: ExecutionId;
}
export interface SpaceHostOptions {
    db: NetDatabase;
    identity: IdentityService;
    keys: KeyStore;
    store: StreamStore;
    projection: MetaProjection;
    limits: SqliteQuotaRateLedger;
    routes(): Signed;
    blobs?: BlobStore;
    clock?: Clock;
    privateAuthorization?: PrivateSpaceAuthorization;
    botAuthorization?: BotSpaceAuthorization;
}
const fail = (code: ConstructorParameters<typeof NetError>[0]): never => { throw new NetError(code); };
const same = (a: unknown, b: unknown) => json(a) === json(b);
function compare(a: string, b: string): boolean { try {
    const x = decodeBase64(a), y = decodeBase64(b);
    return x.length === y.length && timingSafeEqual(x, y);
}
catch {
    return false;
} }
/** Space authority. Every read/fanout/blob check consults the current projection;
 * bearer receipts, stream ordering, pins and accounting commit together. */
export class SpaceHostService implements StreamAuthority, SpaceJoinAdmissionPort {
    private listeners = new Set<(stream: StreamId, record: StoredRecord) => void>();
    private readonly clock: Clock;
    constructor(readonly options: SpaceHostOptions) {
        this.clock = options.clock ?? systemClock;
        options.db.transaction(() => options.db.database.exec(`
      CREATE TABLE IF NOT EXISTS net_space_host_invites(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,authorization TEXT NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS net_space_host_receipts(invite TEXT NOT NULL,space_id TEXT NOT NULL,user TEXT NOT NULL,claims TEXT NOT NULL,stream TEXT NOT NULL,event TEXT NOT NULL,retain_until INTEGER NOT NULL,PRIMARY KEY(invite,user));
      CREATE TABLE IF NOT EXISTS net_space_thread_bindings(stream TEXT PRIMARY KEY,space_id TEXT NOT NULL,binding TEXT NOT NULL);
    `));
    }
    onAppend(listener: (stream: StreamId, record: StoredRecord) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private selfPeer(): Peer { const self = this.options.identity.self(); if (!self)
        return fail('not_enrolled'); const root = this.options.identity.pinnedRootKey(self.user), signed = this.options.identity.roster(self.user); if (!root || !signed)
        return fail('not_enrolled'); const roster = verifyDocument<Roster>(signed, root, 'roster'), rows = roster.nodes.map(row => verifyDocument<NodeDelegation>(row, root, 'nodeDelegation')).filter(row => row.subject === self.node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt); if (!rows[0])
        return fail('bad_delegation'); return { user: self.user, node: self.node, delegation: rows[0] }; }
    private host(space: SpaceId, writes = false): SpaceDescriptor { const p = this.options.projection.assertUsable(space, writes), self = this.options.identity.self(), owner = this.options.projection.member(space, p.owner!)!; const descriptor = verifyDocument<SpaceDescriptor>(p.descriptor!, owner.rootKey, 'spaceDescriptor'); if (!this.verifyPeer(this.selfPeer()))
        return fail('bad_delegation'); if (descriptor.hostNode !== self?.node || descriptor.hostTransportKey !== this.options.keys.nodeKeys().transport)
        return fail('forbidden'); return descriptor; }
    private verifyPeer(peer: Peer): boolean {
        try {
            const root = this.options.identity.pinnedRootKey(peer.user), signed = this.options.identity.roster(peer.user);
            if (!root || !signed || this.options.identity.rosterState(peer.user) === 'conflict')
                return false;
            const roster = verifyDocument<Roster>(signed, root, 'roster'), row = roster.nodes.map(s => verifyDocument<NodeDelegation>(s, root, 'nodeDelegation')).filter(d => d.subject === peer.node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0];
            return !!row && same(row, peer.delegation) && row.owner === peer.user && row.issuedAt <= this.clock.now() && this.clock.now() < row.expiresAt && (roster.revoked.find(r => r.subject === peer.node)?.throughKeyEpoch ?? 0) < row.keyEpoch;
        }
        catch {
            return false;
        }
    }
    create(input: {
        name: string;
        displayName?: string;
        settings?: Partial<SpaceSettings>;
    }): {
        space: SpaceId;
        meta: StreamId;
        descriptor: Signed;
    } {
        const peer = this.selfPeer(), self = this.options.identity.self()!;
        if (!self.isAuthority || !this.options.keys.rootKey())
            return fail('forbidden');
        const space = newId('space'), meta = newId('stream'), routes = this.options.routes(), now = this.clock.now(), root = this.options.identity.pinnedRootKey(peer.user)!, settings: SpaceSettings = { name: input.name, membersMayAddBots: true, maxBlobBytes: DEFAULT_MAX_BLOB_BYTES, minProtoMinor: 0, ...input.settings };
        const descriptor = signedDocument({ v: 1, space, owner: peer.user, hostNode: peer.node, hostTransportKey: peer.delegation.keys.transport, routes, epoch: 1, issuedAt: now } satisfies SpaceDescriptor, bytes => this.options.keys.signAsRoot(bytes));
        this.options.db.transaction(() => {
            this.options.store.createStream({ id: meta, kind: 'space.meta', authority: peer.node, space, createdAt: now }, 1);
            this.options.limits.configureQuota({ kind: 'space', space }, SPACE_DEFAULT_QUOTA_BYTES);
            this.configurePrincipal(space, peer.user);
            const record = this.signed(meta, 'space.created', { descriptor, settings, owner: { user: peer.user, rootKey: root, role: 'owner', displayName: input.displayName ?? peer.delegation.name } }, { metaEpoch: 1, metaSeq: 0 });
            this.storeMeta(space, record, peer);
        });
        return { space, meta, descriptor };
    }
    private configurePrincipal(space: SpaceId, principal: string): void { const scope = { kind: 'space' as const, space }; if (!this.options.db.database.prepare('SELECT 1 FROM net_rate_config WHERE scope=? AND principal=?').get(json(scope), `events/${principal}`))
        this.options.limits.configureRate(scope, `events/${principal}`, 20, 10000); if (!this.options.db.database.prepare('SELECT 1 FROM net_rate_config WHERE scope=? AND principal=?').get(json(scope), `uploads/${principal}`))
        this.options.limits.configureRate(scope, `uploads/${principal}`, 60 * 1024 * 1024, 3600000); }
    private signed(stream: StreamId, type: string, body: unknown, auth?: Envelope['auth'], refs?: Envelope['refs']): {
        id: EventId;
        envelope: Uint8Array;
        sig: Uint8Array;
        recvTs: number;
    } { const peer = this.selfPeer(), space = this.options.store.getStream(stream)?.space, p = space && this.options.projection.position(space); const envelope: Envelope = { v: 1, minor: 0, id: newId('event'), stream, type, crit: isCritical({ type, crit: false }, this.options.store.getStream(stream)?.kind === 'space.meta'), author: { user: peer.user, node: peer.node, keyEpoch: peer.delegation.keyEpoch }, ts: this.clock.now(), auth: auth ?? (p ? { metaEpoch: p.epoch, metaSeq: p.seq } : undefined), body, ...(refs ? { refs } : {}) }; const bytes = canonicalJson(envelope); return { id: envelope.id, envelope: bytes, sig: this.options.keys.signAsNode(bytes), recvTs: this.clock.now() }; }
    private storeMeta(space: SpaceId, input: {
        id: EventId;
        envelope: Uint8Array;
        sig: Uint8Array;
        recvTs: number;
    }, peer: Peer): AppendOutcome {
        const stream = this.options.store.getStream(decodeEnvelope(input.envelope).envelope.stream)!;
        if (!stream || stream.space !== space || stream.kind !== 'space.meta')
            return fail('bad_request');
        const head = this.options.store.head(stream.id), candidate = { ...input, epoch: head.epoch, seq: head.seq + 1 };
        if (head.seq)
            this.options.projection.validate(space, candidate);
        const outcome = this.options.store.appendAsAuthority(stream.id, input);
        if (outcome.kind === 'stored') {
            const record = { ...input, ...outcome };
            this.options.projection.applyRecord(stream, record, 'newWork');
            const envelope = decodeEnvelope(input.envelope).envelope;
            if (envelope.type === 'member.joined')
                this.configurePrincipal(space, (envelope.body as any).member.user);
            this.account(space, peer.user, input.id, input.envelope.length + input.sig.length);
            this.publish(stream.id, record);
        }
        return outcome;
    }
    private account(space: SpaceId, principal: string, id: string, bytes: number): void { this.options.limits.chargeRate({ kind: 'space', space }, `events/${principal}`, id, this.clock.now()); this.options.limits.reserveQuota({ kind: 'space', space }, `event/${id}`, bytes); }
    private publish(stream: StreamId, record: StoredRecord): void { this.options.db.afterCommit(() => { for (const listener of this.listeners)
        listener(stream, record); }); }
    metaStream(space: SpaceId): StreamId { const stream = this.options.store.listStreams({ space, kind: 'space.meta' })[0]; if (!stream)
        return fail('stream_unknown'); return stream.id; }
    postMeta(space: SpaceId, type: string, body: unknown): AppendOutcome { this.host(space, true); const peer = this.selfPeer(), input = this.signed(this.metaStream(space), type, body); return this.append(this.metaStream(space), input.id, input.envelope, input.sig, peer); }
    createChannel(space: SpaceId, name: string): StreamId { const descriptor = this.host(space, true), stream = newId('stream'); this.options.db.transaction(() => { this.options.store.createStream({ id: stream, kind: 'space.channel', space, authority: descriptor.hostNode, createdAt: this.clock.now() }, descriptor.epoch); this.postMeta(space, 'channel.created', { stream, name }); }); return stream; }
    createThread(input: Omit<ThreadBinding, 'stream'> & {
        title: string;
    }): StreamId {
        const descriptor = this.host(input.space, true), channel = this.options.projection.channel(input.space, input.parent), bot = this.options.projection.bot(input.space, input.bot), trigger = this.options.store.getById(input.parent, input.trigger);
        if (!channel || channel.archived || !bot || !trigger || !decodeEnvelope(trigger.envelope).envelope.refs?.mentions?.includes(input.bot))
            return fail('forbidden');
        const stream = newId('stream'), binding: ThreadBinding = { space: input.space, stream, parent: input.parent, bot: input.bot, trigger: input.trigger, execution: input.execution };
        this.options.db.transaction(() => { this.options.store.createStream({ id: stream, kind: 'space.thread', space: input.space, parent: input.parent, authority: descriptor.hostNode, createdAt: this.clock.now() }, descriptor.epoch); this.options.db.charge(1, Buffer.byteLength(json(binding))); this.options.db.database.prepare('INSERT INTO net_space_thread_bindings VALUES(?,?,?)').run(stream, input.space, json(binding)); const record = this.signed(input.parent, 'thread.opened', { stream, title: input.title, private: false }, undefined, { replyTo: input.trigger }); this.append(input.parent, record.id, record.envelope, record.sig, this.selfPeer()); });
        return stream;
    }
    threadBinding(stream: StreamId): ThreadBinding | undefined { const row = this.options.db.database.prepare('SELECT binding FROM net_space_thread_bindings WHERE stream=?').get(stream); return row ? JSON.parse(row.binding as string) : undefined; }
    canRead(streamId: StreamId, peer: Peer): boolean { try {
        const stream = this.options.store.getStream(streamId);
        if (!stream?.space || !this.verifyPeer(peer))
            return false;
        this.host(stream.space);
        if (!this.options.projection.member(stream.space, peer.user))
            return false;
        if (stream.kind === 'space.private')
            return this.options.privateAuthorization?.canRead(stream, peer) === true;
        return this.options.projection.canRead(stream.space, stream, peer.user);
    }
    catch {
        return false;
    } }
    append(streamId: StreamId, id: EventId, bytes: Uint8Array, sig: Uint8Array, peer: Peer): AppendOutcome {
        const stream = this.options.store.getStream(streamId);
        if (!stream?.space)
            return fail('stream_unknown');
        const { envelope } = decodeEnvelope(bytes), space = stream.space;
        this.host(space, true);
        if (!this.canRead(streamId, peer))
            return fail('not_member');
        if (envelope.stream !== streamId || envelope.id !== id || envelope.author.node !== peer.node || envelope.author.user && envelope.author.user !== peer.user)
            return fail('forbidden');
        const verified = this.options.identity.verifyAuthor(envelope.author, bytes, sig, this.clock.now(), 'newWork'), p = this.options.projection.position(space)!;
        if (!envelope.auth || envelope.auth.metaEpoch !== p.epoch || envelope.auth.metaSeq > p.seq)
            return fail('meta_stale');
        if (envelope.minor < p.settings!.minProtoMinor)
            return fail('incompatible_peer');
        if (isCritical(envelope, stream.kind === 'space.meta') && (!isKnownEventType(envelope.type) || envelope.minor > 0))
            return fail('upgrade_required');
        const previous = this.options.store.getById(streamId, id);
        if (previous) {
            if (!Buffer.from(previous.envelope).equals(Buffer.from(bytes)) || !Buffer.from(previous.sig).equals(Buffer.from(sig)))
                return fail('conflict');
            return { kind: 'duplicate', epoch: previous.epoch, seq: previous.seq, recvTs: previous.recvTs };
        }
        if (stream.kind !== 'space.meta') {
            if (stream.kind === 'space.private') {
                if (!this.options.privateAuthorization?.canWrite(stream, envelope, peer))
                    return fail('forbidden');
            }
            else if (verified.kind === 'bot') {
                if (!this.options.projection.bot(space, verified.bot) || !this.options.botAuthorization?.canWrite(stream, envelope, peer, this.threadBinding(streamId)))
                    return fail('forbidden');
            }
            else if (stream.kind === 'space.thread') {
                if (!['message.posted', 'message.edited', 'message.deleted'].includes(envelope.type))
                    return fail('forbidden');
                const binding = this.threadBinding(streamId);
                if (!binding || !this.options.projection.canSteer(space, binding.bot, peer.user) || envelope.refs?.thread !== streamId || envelope.refs?.replyTo !== binding.trigger || envelope.refs?.execution !== binding.execution)
                    return fail('forbidden');
            }
            else {
                const decision = this.options.projection.canWrite(space, stream, envelope, verified);
                if (!decision.ok)
                    return fail(decision.code);
                if (envelope.refs?.thread || envelope.refs?.execution)
                    return fail('forbidden');
                if (envelope.type === 'thread.opened' || envelope.type === 'thread.closed') {
                    const binding = this.threadBinding((envelope.body as any).stream);
                    if (!binding || binding.parent !== streamId || binding.space !== space)
                        return fail('forbidden');
                }
            }
            if (envelope.type === 'message.edited' || envelope.type === 'message.deleted') {
                const target = envelope.refs?.subject && this.options.store.getById(streamId, envelope.refs.subject), role = this.options.projection.member(space, peer.user)?.role;
                if (!target)
                    return fail('bad_request');
                const author = decodeEnvelope(target.envelope).envelope.author;
                if (!author.user || author.user !== peer.user && role !== 'owner' && role !== 'admin')
                    return fail('forbidden');
            }
        }
        return this.options.db.transaction(() => {
            for (const blob of envelope.blobs ?? [])
                if (!this.options.blobs?.has(blob.id) || this.options.blobs.size(blob.id) !== blob.bytes || blob.bytes > p.settings!.maxBlobBytes || (stream.kind === 'space.private') !== !!blob.sealed)
                    return fail('forbidden');
            let outcome: AppendOutcome;
            if (stream.kind === 'space.meta')
                outcome = this.storeMeta(space, { id, envelope: bytes, sig, recvTs: this.clock.now() }, peer);
            else {
                outcome = this.options.store.appendAsAuthority(streamId, { id, envelope: bytes, sig, recvTs: this.clock.now() });
                this.account(space, peer.user, id, bytes.length + sig.length);
                this.publish(streamId, { epoch: outcome.epoch, seq: outcome.seq, recvTs: outcome.recvTs, envelope: bytes, sig });
            }
            for (const blob of envelope.blobs ?? [])
                this.options.blobs!.addRef(blob.id, streamId, id);
            this.options.db.checkpoint('spaces.append.beforeCommit');
            return outcome;
        });
    }
    post(stream: StreamId, text: string, refs?: Envelope['refs']): AppendOutcome { const record = this.signed(stream, 'message.posted', { text }, undefined, refs); return this.append(stream, record.id, record.envelope, record.sig, this.selfPeer()); }
    canFetchBlob(stream: StreamId, blob: BlobId, peer: Peer): boolean { return this.canRead(stream, peer) && this.options.blobs?.isReferenced(blob, stream) === true; }
    acceptBlob(streamId: StreamId, blob: BlobId, bytes: number, sealed: boolean, peer: Peer): void {
        const stream = this.options.store.getStream(streamId);
        if (!stream?.space || !this.canRead(streamId, peer))
            return fail('forbidden');
        const p = this.options.projection.assertUsable(stream.space, true);
        if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > p.settings!.maxBlobBytes)
            return fail('too_large');
        if (stream.kind === 'space.meta' || (stream.kind === 'space.private') !== sealed)
            return fail('forbidden');
        if (stream.kind === 'space.channel' && this.options.projection.channel(stream.space, stream.id)?.archived)
            return fail('forbidden');
        // Upload authorization includes the concrete private/thread write port.
        if (stream.kind === 'space.private' && this.options.privateAuthorization?.canUpload(stream, peer) !== true)
            return fail('forbidden');
        if (stream.kind === 'space.thread') {
            const binding = this.threadBinding(stream.id);
            if (!binding || !this.options.projection.canSteer(stream.space, binding.bot, peer.user))
                return fail('forbidden');
        }
        this.options.db.transaction(() => { this.options.limits.chargeRate({ kind: 'space', space: stream.space! }, `uploads/${peer.user}`, `blob/${blob}`, this.clock.now(), bytes); this.options.limits.reserveQuota({ kind: 'space', space: stream.space! }, `blob/${blob}`, bytes); });
    }
    invite(space: SpaceId, input: {
        role?: 'member' | 'admin';
        uses?: number;
        ttlMs?: number;
        joiner?: MemberRecord['user'];
    } = {}): {
        text: string;
        invite: SpaceInviteAuthorization['invite'];
        expiresAt: number;
    } {
        const descriptor = this.host(space, true), peer = this.selfPeer(), p = this.options.projection.position(space)!, member = this.options.projection.member(space, peer.user)!, now = this.clock.now(), ttl = input.ttlMs ?? 86400000;
        if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400000 || !Number.isSafeInteger(input.uses ?? 1) || (input.uses ?? 1) < 1 || (input.uses ?? 1) > 256)
            return fail('bad_request');
        if (!('encryptedAtRest' in this.options.keys) || typeof this.options.keys.encryptedAtRest !== 'function' || this.options.keys.encryptedAtRest() !== true)
            return fail('keystore_locked');
        if (member.role !== 'owner' && !(member.role === 'admin' && (input.role ?? 'member') === 'member'))
            return fail('forbidden');
        const roster = this.options.identity.roster(peer.user)!, root = this.options.identity.pinnedRootKey(peer.user)!, rosterDoc = verifyDocument<Roster>(roster, root, 'roster'), delegation = rosterDoc.nodes.find(s => same(verifyDocument<NodeDelegation>(s, root, 'nodeDelegation'), peer.delegation))!, invite = newId('invite'), token = randomBytes(32), expiresAt = Math.min(now + ttl, peer.delegation.expiresAt);
        const authorization = this.options.identity.signAsNode({ v: 1, invite, space, epoch: descriptor.epoch, issuer: { user: peer.user, node: peer.node, delegation }, auth: { metaEpoch: p.epoch, metaSeq: p.seq }, role: input.role ?? 'member', issuedAt: now, expiresAt, uses: input.uses ?? 1, ...(input.joiner ? { joiner: input.joiner } : {}) } satisfies SpaceInviteAuthorization);
        const owner = this.options.projection.member(space, descriptor.owner)!, ownerRoster = this.options.identity.roster(owner.user)!;
        const text = encodeSpaceInvite({ v: 1, descriptor: p.descriptor!, ownerRootKey: owner.rootKey, ownerRoster, authorization, issuerRootKey: root, issuerRoster: roster, token: token.toString('base64url') });
        this.registerInvite(space, authorization, invitationProofKey(token, 'space'));
        token.fill(0);
        return { text, invite, expiresAt };
    }
    registerInvite(space: SpaceId, authorization: Signed, proofKey: Uint8Array): void {
        this.host(space, true);
        if (!('encryptedAtRest' in this.options.keys) || typeof this.options.keys.encryptedAtRest !== 'function' || this.options.keys.encryptedAtRest() !== true)
            return fail('keystore_locked');
        if (proofKey.length !== 32)
            return fail('invite_invalid');
        const raw = parseProtocolJson(decodeBase64(authorization.payload)) as SpaceInviteAuthorization;
        const fake: MemberRecord = { user: raw.joiner ?? newId('user'), rootKey: Buffer.alloc(32).toString('base64url'), role: raw.role, displayName: 'Invite validation' };
        this.options.projection.checkInvite(space, authorization, fake, 1, this.clock.now());
        const previous = this.options.db.database.prepare('SELECT authorization FROM net_space_host_invites WHERE id=?').get(raw.invite);
        if (previous) {
            if (!same(JSON.parse(previous.authorization as string), authorization) || !Buffer.from(this.options.keys.getSecret(`spaces/${raw.invite}/proof`) ?? []).equals(Buffer.from(proofKey)))
                return fail('conflict');
            return;
        }
        this.options.keys.putSecret(`spaces/${raw.invite}/proof`, proofKey);
        this.options.db.transaction(() => { this.options.db.charge(1, Buffer.byteLength(json(authorization))); this.options.db.database.prepare('INSERT INTO net_space_host_invites VALUES(?,?,?,\'active\',?)').run(raw.invite, space, json(authorization), raw.expiresAt); });
    }
    revokeInvite(invite: string): void { const row = this.options.db.database.prepare('SELECT space_id FROM net_space_host_invites WHERE id=?').get(invite); if (!row)
        return fail('invite_invalid'); const space = row.space_id as SpaceId; this.host(space, true); if (this.options.projection.member(space, this.selfPeer().user)?.role !== 'owner')
        return fail('forbidden'); this.options.db.transaction(() => { this.options.db.charge(1); this.options.db.database.prepare("UPDATE net_space_host_invites SET state='revoked' WHERE id=?").run(invite); }); }
    redeem(request: SpaceJoinRequestMessage, channel: SecureChannel): MuxMessage {
        try {
            return this.redeemOrThrow(request, channel);
        }
        catch (error) {
            const code = error instanceof NetError ? error.code : 'internal';
            return { header: { t: 'space.join.result', space: request.space, error: { code, message: NET_ERRORS[code].message, retryable: NET_ERRORS[code].retryable } }, parts: [] };
        }
    }
    redeemOrThrow(request: SpaceJoinRequestMessage, channel: SecureChannel): MuxMessage {
        if (encodeMessage(request).length > 16 * 1024)
            return fail('too_large');
        this.host(request.space, true);
        const row = this.options.db.database.prepare('SELECT * FROM net_space_host_invites WHERE id=? AND space_id=?').get(request.invite, request.space);
        if (!row || row.state !== 'active')
            return fail('invite_invalid');
        const proofKey = this.options.keys.getSecret(`spaces/${request.invite}/proof`);
        if (!proofKey || !compare(request.proof, invitationProof(proofKey, channel.exporter('EXPORTER-mousse-net-space-join', 32), request)))
            return fail('invite_invalid');
        const roster = verifyDocument<Roster>(request.roster, request.rootKey, 'roster'), delegation = verifyDocument<NodeDelegation>(request.delegation, request.rootKey, 'nodeDelegation'), now = this.clock.now();
        if (roster.owner !== request.user || roster.rootKey !== request.rootKey || delegation.owner !== request.user || delegation.subject !== request.node || delegation.issuedAt > now || now >= delegation.expiresAt || !roster.nodes.some(s => same(s, request.delegation)))
            return fail('bad_delegation');
        const current = roster.nodes.map(s => verifyDocument<NodeDelegation>(s, request.rootKey, 'nodeDelegation')).filter(d => d.subject === request.node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0];
        if (!same(current, delegation) || (roster.revoked.find(r => r.subject === request.node)?.throughKeyEpoch ?? 0) >= delegation.keyEpoch)
            return fail('revoked');
        if (!compare(delegation.keys.transport, channel.peerTransportKey))
            return fail('peer_key_mismatch');
        const pin = this.options.identity.pinnedRootKey(request.user);
        if (pin && pin !== request.rootKey)
            return fail('conflict');
        const { proof: _proof, ...stable } = request, claims = json(stable), receipt = this.options.db.database.prepare('SELECT * FROM net_space_host_receipts WHERE invite=? AND user=?').get(request.invite, request.user);
        if (receipt) {
            if (!this.verifyPeer({ user: request.user, node: request.node, delegation }))
                return fail('bad_delegation');
            if (receipt.claims !== claims || now >= Number(receipt.retain_until))
                return fail('invite_invalid');
            const original = this.options.store.getById(receipt.stream as StreamId, receipt.event as EventId);
            if (!original)
                return fail('storage_corrupt');
            return this.joinResult(request.space, original);
        }
        if (now >= Number(row.expires))
            return fail('invite_invalid');
        const authorization = JSON.parse(row.authorization as string) as Signed, invite = parseProtocolJson(decodeBase64(authorization.payload)) as SpaceInviteAuthorization, member: MemberRecord = { user: request.user, rootKey: request.rootKey, role: invite.role, displayName: request.name };
        return this.options.db.transaction(() => {
            const uses = Number(this.options.db.database.prepare('SELECT count(*) AS n FROM net_space_host_receipts WHERE invite=?').get(request.invite)!.n), use = uses + 1;
            this.options.projection.checkInvite(request.space, authorization, member, use, now);
            this.options.identity.pinUser(request.user, request.rootKey);
            const adopted = this.options.identity.acceptRoster(request.roster, request.rootKey);
            if (adopted.state === 'conflict')
                return fail('roster_conflict');
            if (!this.verifyPeer({ user: request.user, node: request.node, delegation }))
                return fail('bad_delegation');
            this.configurePrincipal(request.space, request.user);
            const input = this.signed(this.metaStream(request.space), 'member.joined', { member, invite: authorization, inviteUse: use }), outcome = this.storeMeta(request.space, input, this.selfPeer()), record = { epoch: outcome.epoch, seq: outcome.seq, recvTs: outcome.recvTs, envelope: input.envelope, sig: input.sig };
            this.options.db.charge(1, Buffer.byteLength(claims));
            this.options.db.database.prepare('INSERT INTO net_space_host_receipts VALUES(?,?,?,?,?,?,?)').run(request.invite, request.space, request.user, claims, this.metaStream(request.space), input.id, Math.max(invite.expiresAt, delegation.expiresAt));
            this.options.db.checkpoint('spaces.join.beforeCommit');
            return this.joinResult(request.space, record);
        });
    }
    private joinResult(space: SpaceId, record: StoredRecord): MuxMessage { return { header: { t: 'space.join.result', space, descriptor: this.options.projection.position(space)!.descriptor!, member: { epoch: record.epoch, seq: record.seq, recvTs: record.recvTs }, parts: [record.envelope.length, record.sig.length] }, parts: [new Uint8Array(record.envelope), new Uint8Array(record.sig)] }; }
    retain(stream: StreamId, throughSeq: number): void { const descriptor = this.options.store.getStream(stream); if (!descriptor?.space)
        return fail('stream_unknown'); this.host(descriptor.space, true); if (descriptor.kind === 'space.meta')
        return fail('forbidden'); this.options.store.truncate(stream, throughSeq); }
}

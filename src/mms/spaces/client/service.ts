import type { Clock, IdentityService, KeyStore, MuxMessage, Outbox, OutboxEntry, SecureChannel, StreamStore, SyncSession } from '../../net/contracts';
import { NetDatabase, json } from '../../net/store/database';
import { systemClock } from '../../net/clock';
import { createMux } from '../../net/link/mux';
import { invitationProof, invitationProofKey } from '../../net/enrollment/service';
import { canonicalJson, decodeEnvelope, parseProtocolJson, encodeMessage } from '../../net/sync/codec';
import { decodeBase64, verifyBytes, verifyDocument } from '../../net/identity/crypto';
import { NetError, newId, isCritical, isKnownEventType, NET_PROTO_MAJOR, NET_PROTO_MINOR, PREAUTH_MAX_BYTES } from '../../../shared/net';
import type { Envelope, EnvelopeAuthRef, EventId, MemberRecord, NetErrorCode, NodeDelegation, Roster, Signed, SpaceDescriptor, SpaceInviteAuthorization, SpaceId, SpaceJoinRequestMessage, SpaceJoinResultMessage, StoredRecord, StreamDescriptor, StreamId } from '../../../shared/net';
import { parseSpaceInvite, type SpaceInviteContainer, type MetaProjection, type ThreadBinding } from '../host';
import type { PrivateSpaceService } from '../private';
export interface SpaceClientBinding {
    space: SpaceId;
    descriptor: Signed;
    ownerRootKey: string;
    meta: StreamId;
    state: 'awaitingMeta' | 'active' | 'offline' | 'blocked';
    receipt: {
        epoch: number;
        seq: number;
        recvTs: number;
        envelope: string;
        sig: string;
    };
}
interface JoinJournal {
    invite: SpaceJoinRequestMessage['invite'];
    container: Omit<SpaceInviteContainer, 'token'>;
    stable: Omit<SpaceJoinRequestMessage, 'proof'>;
    state: 'prepared' | 'joined';
    binding?: SpaceClientBinding;
}
export interface SpaceClientOptions {
    db: NetDatabase;
    identity: IdentityService;
    keys: KeyStore;
    store: StreamStore;
    outbox: Outbox;
    meta: MetaProjection;
    private?: PrivateSpaceService;
    clock?: Clock;
    localRoutes(): Signed;
    connectJoin(descriptor: SpaceDescriptor, signal: AbortSignal, evidence: { ownerRootKey: string; ownerRoster: Signed }): Promise<SecureChannel>;
    connectSpace(descriptor: SpaceDescriptor, signal: AbortSignal): Promise<SyncSession>;
    /** Root-owned deterministic/verified bootstrap mapping. */
    metaStream(descriptor: SpaceDescriptor): StreamId;
    memberAt?(space: SpaceId, user: MemberRecord['user'], auth: EnvelopeAuthRef): MemberRecord | undefined;
    threadBinding?(stream: StreamId): ThreadBinding | undefined;
    verifyBotRecord?(record: StoredRecord, descriptor: StreamDescriptor): void;
    canWriteBotRecord?(descriptor: StreamDescriptor, envelope: Envelope, peer: SyncSession['peer'], binding?: ThreadBinding): boolean;
    /** Root composes afterStored inside the stream/cursor transaction. */
    atomicStoreHooks: true;
    /** Local resource guards; they do not change protocol validity. */
    maxPendingEvents?: number;
    maxPendingBytes?: number;
}
const fail = (code: NetErrorCode): never => { throw new NetError(code); };
const same = (a: unknown, b: unknown): boolean => json(a) === json(b);
/** Member replica and durable sender. Snapshots/display never invoke execution.
 * All transmissions reuse the originally journaled id, bytes and signature. */
export class SpaceClientService {
    private readonly clock: Clock;
    private sessions = new Map<SpaceId, SyncSession>();
    private subscriptions = new Map<StreamId, {
        close(): void;
    }>();
    private listeners = new Set<(space: SpaceId) => void>();
    private flushing = new Map<SpaceId, Promise<void>>();
    private controllers = new Map<SpaceId, AbortController>();
    constructor(readonly options: SpaceClientOptions) {
        this.clock = options.clock ?? systemClock;
        if (options.atomicStoreHooks !== true) return fail('bad_request');
        options.db.transaction(() => options.db.database.exec(`
    CREATE TABLE IF NOT EXISTS net_space_client_join(invite TEXT PRIMARY KEY,space_id TEXT NOT NULL,journal TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS net_space_client_binding(space_id TEXT PRIMARY KEY,binding TEXT NOT NULL);
  `));
    }
    onChanged(listener: (space: SpaceId) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private notify(space: SpaceId): void { this.options.db.afterCommit(() => { for (const listener of this.listeners)
        listener(space); }); }
    binding(space: SpaceId): SpaceClientBinding | undefined { const row = this.options.db.database.prepare('SELECT binding FROM net_space_client_binding WHERE space_id=?').get(space); return row ? JSON.parse(row.binding as string) : undefined; }
    list(): SpaceClientBinding[] { return this.options.db.database.prepare('SELECT binding FROM net_space_client_binding ORDER BY space_id').all().map(row => JSON.parse(row.binding as string)); }
    private save(binding: SpaceClientBinding): void { const text = json(binding); this.options.db.charge(1, Buffer.byteLength(text)); this.options.db.database.prepare('INSERT INTO net_space_client_binding VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET binding=excluded.binding').run(binding.space, text); this.notify(binding.space); }
    private journal(invite: SpaceJoinRequestMessage['invite']): JoinJournal { const row = this.options.db.database.prepare('SELECT journal FROM net_space_client_join WHERE invite=?').get(invite); if (!row)
        return fail('invite_invalid'); return JSON.parse(row.journal as string); }
    private saveJournal(journal: JoinJournal): void { const text = json(journal); this.options.db.charge(1, Buffer.byteLength(text)); this.options.db.database.prepare('INSERT INTO net_space_client_join VALUES(?,?,?) ON CONFLICT(invite) DO UPDATE SET journal=excluded.journal').run(journal.invite, journal.stable.space, text); }
    private self() { const self = this.options.identity.self(); if (!self)
        return fail('not_enrolled'); const root = this.options.identity.pinnedRootKey(self.user)!, rosterSigned = this.options.identity.roster(self.user)!; const roster = verifyDocument<Roster>(rosterSigned, root, 'roster'), rows = roster.nodes.map(s => ({ signed: s, delegation: verifyDocument<NodeDelegation>(s, root, 'nodeDelegation') })).filter(r => r.delegation.subject === self.node).sort((a, b) => b.delegation.keyEpoch - a.delegation.keyEpoch || b.delegation.issuedAt - a.delegation.issuedAt); if (!rows[0] || this.options.identity.rosterState(self.user) === 'conflict')
        return fail('bad_delegation'); return { ...self, root, roster: rosterSigned, ...rows[0] }; }
    prepareJoin(text: string, name?: string): SpaceJoinRequestMessage['invite'] {
        const invite = parseSpaceInvite(text), self = this.self(), displayName = name ?? self.delegation.name;
        if (!displayName || [...displayName].length > 256)
            return fail('bad_request');
        if (invite.authorization.expiresAt <= this.clock.now())
            return fail('invite_invalid');
        if (!('encryptedAtRest' in this.options.keys) || typeof this.options.keys.encryptedAtRest !== 'function' || this.options.keys.encryptedAtRest() !== true)
            return fail('keystore_locked');
        const pin = this.options.identity.pinnedRootKey(invite.descriptor.owner);
        if (pin && pin !== invite.container.ownerRootKey)
            return fail('conflict');
        const old = this.options.db.database.prepare('SELECT journal FROM net_space_client_join WHERE invite=?').get(invite.authorization.invite);
        if (old) {
            const journal = JSON.parse(old.journal as string) as JoinJournal;
            if (!same(journal.container.authorization, invite.container.authorization) || journal.stable.name !== displayName || !Buffer.from(this.options.keys.getSecret(`spaces/join/${journal.invite}/token`) ?? []).equals(invite.token))
                return fail('conflict');
            return journal.invite;
        }
        const { token: _token, ...container } = invite.container, journal: JoinJournal = { invite: invite.authorization.invite, container, state: 'prepared', stable: { t: 'space.join.request', invite: invite.authorization.invite, space: invite.descriptor.space, user: self.user, rootKey: self.root, node: self.node, delegation: self.signed, roster: self.roster, name: displayName } };
        this.options.keys.putSecret(`spaces/join/${journal.invite}/token`, invite.token);
        this.options.db.transaction(() => this.saveJournal(journal));
        return journal.invite;
    }
    joinRequest(invite: SpaceJoinRequestMessage['invite'], channel: SecureChannel): SpaceJoinRequestMessage { const journal = this.journal(invite), descriptor = verifyDocument<SpaceDescriptor>(journal.container.descriptor, journal.container.ownerRootKey, 'spaceDescriptor'), token = this.options.keys.getSecret(`spaces/join/${invite}/token`); if (!token)
        return fail('invite_invalid'); if (channel.peerTransportKey !== descriptor.hostTransportKey)
        return fail('peer_key_mismatch'); return { ...journal.stable, proof: invitationProof(invitationProofKey(token, 'space'), channel.exporter('EXPORTER-mousse-net-space-join', 32), journal.stable) }; }
    async join(invite: SpaceJoinRequestMessage['invite'], signal?: AbortSignal): Promise<SpaceClientBinding> {
        const journal = this.journal(invite);
        if (journal.state === 'joined' && journal.binding)
            return journal.binding;
        const descriptor = verifyDocument<SpaceDescriptor>(journal.container.descriptor, journal.container.ownerRootKey, 'spaceDescriptor'), controller = new AbortController(), abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted)
            abort();
        if (this.options.identity.pinnedRootKey(descriptor.owner) && this.options.identity.rosterState(descriptor.owner) === 'conflict')
            return fail('roster_conflict');
        const channel = await this.options.connectJoin(descriptor, controller.signal, { ownerRootKey: journal.container.ownerRootKey, ownerRoster: journal.container.ownerRoster }), request = this.joinRequest(invite, channel);
        let preauthBytes = 0, requestSent = false;
        const mux = createMux(channel.stream, { clock: this.clock, onBytesReceived: count => { if (!requestSent) {
                preauthBytes += count;
                if (preauthBytes > PREAUTH_MAX_BYTES)
                    return fail('too_large');
            } } });
        if (encodeMessage(request, []).length > PREAUTH_MAX_BYTES) {
            mux.close();
            channel.close();
            return fail('too_large');
        }
        let stopMessage: () => void = () => { }, stopClose: () => void = () => { }, timer: ReturnType<Clock['setTimeout']> | undefined;
        try {
            return await new Promise<SpaceClientBinding>((resolve, reject) => {
                let hello = false, ack = false, ackSent = false, sent = false;
                const sendRequest = () => { if (hello && ack && ackSent && !sent) {
                    sent = true;
                    requestSent = true;
                    void mux.send('control', { header: request, parts: [] }, controller.signal).catch(reject);
                } };
                timer = this.clock.setTimeout(() => { controller.abort(); reject(new NetError('deadline_exceeded')); }, 10000);
                controller.signal.addEventListener('abort', () => reject(new NetError('cancelled')), { once: true });
                stopClose = mux.onClose(error => reject(error ?? new NetError('peer_offline')));
                stopMessage = mux.onMessage((lane, message) => {
                    try {
                        if (lane !== 'control' || (message.header.t !== 'space.join.result' && message.parts.length))
                            return fail('forbidden');
                        const header = message.header;
                        if (header.t === 'hello') {
                            if (hello || header.node !== descriptor.hostNode || header.protoMajor !== NET_PROTO_MAJOR || !header.delegation || !header.roster)
                                return fail('bad_delegation');
                            const node = verifyDocument<NodeDelegation>(header.delegation, journal.container.ownerRootKey, 'nodeDelegation'), roster = verifyDocument<Roster>(header.roster, journal.container.ownerRootKey, 'roster');
                            const latest = roster.nodes.map(s => verifyDocument<NodeDelegation>(s, journal.container.ownerRootKey, 'nodeDelegation')).filter(d => d.subject === descriptor.hostNode).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0];
                            if (node.subject !== descriptor.hostNode || node.owner !== descriptor.owner || node.keys.transport !== channel.peerTransportKey || roster.owner !== descriptor.owner || !roster.nodes.some(s => same(s, header.delegation)) || !same(latest, node) || node.issuedAt > this.clock.now() || this.clock.now() >= node.expiresAt || roster.revoked.some(r => r.subject === node.subject && r.throughKeyEpoch >= node.keyEpoch))
                                return fail('bad_delegation');
                            hello = true;
                            void mux.send('control', { header: { t: 'helloAck', protoMinor: Math.min(NET_PROTO_MINOR, header.protoMinor), caps: ['enroll.v1'], now: this.clock.now() }, parts: [] }, controller.signal).then(() => { ackSent = true; sendRequest(); }, reject);
                        }
                        else if (header.t === 'helloAck') {
                            if (ack || header.protoMinor !== NET_PROTO_MINOR || header.caps.length !== 1 || header.caps[0] !== 'enroll.v1')
                                return fail('incompatible_peer');
                            ack = true;
                            sendRequest();
                        }
                        else if (header.t === 'space.join.result' && sent) {
                            resolve(this.acceptJoin(invite, message, channel));
                        }
                        else
                            return fail('forbidden');
                    }
                    catch (error) {
                        reject(error);
                    }
                });
                const header = { t: 'hello' as const, protoMajor: NET_PROTO_MAJOR, protoMinor: NET_PROTO_MINOR, caps: ['enroll.v1' as const], node: request.node, delegation: request.delegation, roster: request.roster, routes: this.options.localRoutes(), now: this.clock.now() };
                void mux.send('control', { header, parts: [] }, controller.signal).catch(reject);
            });
        }
        finally {
            timer?.cancel();
            stopMessage();
            stopClose();
            mux.close();
            channel.close();
            signal?.removeEventListener('abort', abort);
        }
    }
    acceptJoin(invite: SpaceJoinRequestMessage['invite'], message: MuxMessage, channel: SecureChannel): SpaceClientBinding {
        const journal = this.journal(invite), result = message.header as SpaceJoinResultMessage;
        if (result.t !== 'space.join.result')
            return fail('bad_request');
        if ('error' in result)
            return fail(result.error.code);
        const descriptor = verifyDocument<SpaceDescriptor>(result.descriptor, journal.container.ownerRootKey, 'spaceDescriptor'), original = verifyDocument<SpaceDescriptor>(journal.container.descriptor, journal.container.ownerRootKey, 'spaceDescriptor');
        if (!same(descriptor, original) || result.space !== journal.stable.space || descriptor.hostTransportKey !== channel.peerTransportKey || message.parts.length !== 2)
            return fail('invite_invalid');
        const envelope = decodeEnvelope(message.parts[0]).envelope, member = (envelope.body as Envelope<'member.joined'>['body'])?.member, authorization = parseProtocolJson(decodeBase64(journal.container.authorization.payload)) as SpaceInviteAuthorization;
        if (envelope.ts < authorization.issuedAt || envelope.ts >= authorization.expiresAt || authorization.joiner !== undefined && authorization.joiner !== journal.stable.user)
            return fail('invite_invalid');
        if (envelope.type !== 'member.joined' || envelope.author.user !== descriptor.owner || envelope.author.node !== descriptor.hostNode || !member || member.user !== journal.stable.user || member.rootKey !== journal.stable.rootKey || member.displayName !== journal.stable.name || member.role !== authorization.role || !same((envelope.body as any).invite, journal.container.authorization) || !Number.isSafeInteger((envelope.body as any).inviteUse) || (envelope.body as any).inviteUse < 1 || (envelope.body as any).inviteUse > authorization.uses)
            return fail('invite_invalid');
        const roster = verifyDocument<Roster>(journal.container.ownerRoster, journal.container.ownerRootKey, 'roster'), node = roster.nodes.map(s => verifyDocument<NodeDelegation>(s, journal.container.ownerRootKey, 'nodeDelegation')).find(d => d.subject === descriptor.hostNode && d.keyEpoch === envelope.author.keyEpoch && d.issuedAt <= envelope.ts && envelope.ts < d.expiresAt);
        if (!node)
            return fail('bad_delegation');
        verifyBytes(message.parts[0], message.parts[1], node.keys.sign);
        const meta = this.options.metaStream(descriptor);
        if (envelope.stream !== meta || result.member.epoch !== descriptor.epoch || !envelope.auth || envelope.auth.metaEpoch !== descriptor.epoch || envelope.auth.metaSeq >= result.member.seq)
            return fail('invite_invalid');
        if (journal.state === 'joined' && journal.binding) {
            if (journal.binding.receipt.envelope !== Buffer.from(message.parts[0]).toString('base64url') || journal.binding.receipt.sig !== Buffer.from(message.parts[1]).toString('base64url') || !same(result.member, { epoch: journal.binding.receipt.epoch, seq: journal.binding.receipt.seq, recvTs: journal.binding.receipt.recvTs }))
                return fail('conflict');
            return journal.binding;
        }
        const binding: SpaceClientBinding = { space: descriptor.space, descriptor: result.descriptor, ownerRootKey: journal.container.ownerRootKey, meta, state: 'awaitingMeta', receipt: { ...result.member, envelope: Buffer.from(message.parts[0]).toString('base64url'), sig: Buffer.from(message.parts[1]).toString('base64url') } };
        this.options.db.transaction(() => { this.options.identity.pinUser(descriptor.owner, binding.ownerRootKey); const adopted = this.options.identity.acceptRoster(journal.container.ownerRoster, binding.ownerRootKey); if (adopted.state === 'conflict')
            return fail('roster_conflict'); this.options.store.createStream({ id: meta, kind: 'space.meta', space: descriptor.space, authority: descriptor.hostNode, createdAt: descriptor.issuedAt }, descriptor.epoch); this.save(binding); journal.state = 'joined'; journal.binding = binding; this.saveJournal(journal); this.options.db.checkpoint('spaces.client.join.beforeCommit'); });
        return binding;
    }
    canReceive(descriptor: StreamDescriptor, peer: SyncSession['peer']): boolean { try {
        if (!descriptor.space)
            return false;
        const binding = this.binding(descriptor.space);
        if (!binding)
            return false;
        const pinned = verifyDocument<SpaceDescriptor>(binding.descriptor, binding.ownerRootKey, 'spaceDescriptor');
        if (descriptor.authority !== pinned.hostNode || peer.node !== pinned.hostNode || peer.user !== pinned.owner)
            return false;
        if (descriptor.kind === 'space.meta')
            return descriptor.id === binding.meta;
        const self = this.self();
        if (descriptor.kind === 'space.private')
            return this.options.private?.canRead(descriptor, { user: self.user, node: self.node, delegation: self.delegation }) === true;
        return this.options.meta.canRead(descriptor.space, descriptor, self.user);
    }
    catch {
        return false;
    } }
    verifyRecord(record: StoredRecord, descriptor: StreamDescriptor, snapshot: boolean): void {
        const envelope = decodeEnvelope(record.envelope).envelope;
        if (!descriptor.space || envelope.stream !== descriptor.id)
            return fail('bad_request');
        if (descriptor.kind === 'space.meta') {
            if (!snapshot)
                this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, envelope.ts, 'history');
            return;
        }
        this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, envelope.ts, 'history');
        const state = this.options.meta.assertUsable(descriptor.space), auth = envelope.auth;
        if (!auth || auth.metaEpoch !== state.epoch || auth.metaSeq > state.seq)
            return fail('meta_stale');
        if (isCritical(envelope, false) && (!isKnownEventType(envelope.type) || envelope.minor > 0)) {
            this.options.meta.block(descriptor.space, 'upgradeRequired');
            return;
        }
        if (descriptor.kind === 'space.private') {
            if (snapshot)
                return;
            if (envelope.type === 'participants.changed')
                this.options.private?.validateControl(descriptor, record.envelope, record.sig, 'history');
            else if (!envelope.sealed)
                return fail('forbidden');
            else if(envelope.author.bot&&envelope.type.startsWith('bot.run.')){
                if(!this.options.private?.historyState(descriptor.id,envelope.sealed.keyEpoch)||!this.options.verifyBotRecord)return fail('forbidden');
                this.options.verifyBotRecord(record,descriptor);
            }
        }
        else if (envelope.author.bot) {
            if (!this.options.verifyBotRecord)
                return fail('forbidden');
            this.options.verifyBotRecord(record, descriptor);
        }
        else if (!envelope.author.user || !(this.options.memberAt ?? ((space, user, auth) => this.options.meta.memberAt(space, user, auth)))(descriptor.space, envelope.author.user, auth))
            return fail('meta_stale');
    }
    afterStored(record: StoredRecord, descriptor: StreamDescriptor): void { if (!descriptor.space)
        return; this.options.db.transaction(() => { if (descriptor.kind === 'space.meta')
        this.options.meta.apply(descriptor.space!, record);
    else if (descriptor.kind === 'space.private')
        this.options.private?.applyStored(descriptor, record, 'history'); this.reconcile(record, descriptor.id); const binding = this.binding(descriptor.space!); if (binding) {
        const self = this.options.identity.self();
        binding.state = self && ['active', 'frozen'].includes(this.options.meta.position(descriptor.space!)?.status ?? '') && this.options.meta.member(descriptor.space!, self.user) ? 'active' : 'blocked';
        this.save(binding);
        this.options.db.afterCommit(() => this.closeUnauthorized(descriptor.space!));
    } this.options.db.checkpoint('spaces.client.apply.beforeCommit'); }); }
    private reconcile(record: StoredRecord, stream: StreamId): void { const envelope = decodeEnvelope(record.envelope).envelope, entry = this.options.outbox.get(envelope.id); if (!entry)
        return; if (entry.stream !== stream || !Buffer.from(entry.envelope).equals(Buffer.from(record.envelope)) || !Buffer.from(entry.sig).equals(Buffer.from(record.sig)))
        return fail('conflict'); if (entry.state !== 'failed')
        this.options.outbox.markSent(entry.id, { epoch: record.epoch, seq: record.seq }); }
    async connect(space: SpaceId, signal?: AbortSignal): Promise<void> {
        const binding = this.binding(space);
        if (!binding)
            return fail('not_member');
        this.disconnect(space);
        const controller = new AbortController();
        this.controllers.set(space, controller);
        if (signal?.aborted)
            controller.abort(signal.reason);
        else
            signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
        const descriptor = verifyDocument<SpaceDescriptor>(binding.descriptor, binding.ownerRootKey, 'spaceDescriptor'), session = await this.options.connectSpace(descriptor, controller.signal);
        this.sessions.set(space, session);
        session.onClosed(() => { if (this.sessions.get(space) === session) {
            if (session.state() === 'closed')
                this.sessions.delete(space);
            const binding = this.binding(space);
            if (binding)
                this.options.db.transaction(() => { binding.state = 'offline'; this.save(binding); });
        } });
        await this.subscribe(binding.meta, session);
        for (const channel of this.options.meta.entities<{
            stream: StreamId;
        }>(space, 'channel'))
            if (!this.options.store.getStream(channel.stream))
                this.options.store.createStream({ id: channel.stream, kind: 'space.channel', space, authority: descriptor.hostNode, createdAt: descriptor.issuedAt }, descriptor.epoch);
        await this.flush(space);
    }
    async subscribe(stream: StreamId, session?: SyncSession): Promise<void> {
        const descriptor = this.options.store.getStream(stream);
        if (!descriptor?.space)
            return fail('stream_unknown');
        const active = session ?? this.sessions.get(descriptor.space);
        if (!active)
            return fail('peer_offline');
        this.subscriptions.get(stream)?.close();
        return new Promise((resolve, reject) => { const subscription = active.subscribe(stream, { onRecord: record => { this.reconcile(record, stream); }, onCaughtUp: () => { if (descriptor.kind === 'space.meta') {
                const binding = this.binding(descriptor.space!);
                if (binding)
                    this.options.db.transaction(() => { const self = this.options.identity.self(); binding.state = self && ['active', 'frozen'].includes(this.options.meta.position(binding.space)?.status ?? '') && this.options.meta.member(binding.space, self.user) ? 'active' : 'blocked'; this.save(binding); });
            } resolve(); }, onSnapshotInstalled: () => { const binding = this.binding(descriptor.space!); if (binding)
                this.options.db.transaction(() => { const self = this.options.identity.self(); binding.state = self && ['active', 'frozen'].includes(this.options.meta.position(binding.space)?.status ?? '') && this.options.meta.member(binding.space, self.user) ? 'active' : 'blocked'; this.save(binding); }); }, onError: code => { if (code === 'upgrade_required')
                this.options.meta.block(descriptor.space!, 'upgradeRequired'); reject(new NetError(code)); } }); this.subscriptions.set(stream, subscription); });
    }
    queue(stream: StreamId, type: string, body: unknown, refs?: Envelope['refs']): EventId {
        const descriptor = this.options.store.getStream(stream);
        if (!descriptor?.space)
            return fail('stream_unknown');
        if (this.binding(descriptor.space)?.state === 'blocked')
            return fail('not_member');
        const self = this.self(), meta = this.options.meta.assertUsable(descriptor.space, true);
        if (!this.options.meta.member(descriptor.space, self.user))
            return fail('not_member');
        this.queueBudget(descriptor.space);
        if (descriptor.kind === 'space.private') {
            if (!this.options.private)
                return fail('forbidden');
            return this.options.private.seal(stream, type, body, refs).id;
        }
        const envelope: Envelope = { v: 1, minor: 0, id: newId('event'), stream, type, crit: isCritical({ type, crit: false }, descriptor.kind === 'space.meta'), author: { user: self.user, node: self.node, keyEpoch: self.delegation.keyEpoch }, ts: this.clock.now(), auth: { metaEpoch: meta.epoch, metaSeq: meta.seq }, body, ...(refs ? { refs } : {}) }, bytes = canonicalJson(envelope), sig = this.options.keys.signAsNode(bytes), author = this.options.identity.verifyAuthor(envelope.author, bytes, sig, envelope.ts, 'newWork');
        if (descriptor.kind === 'space.thread') {
            const binding = this.options.threadBinding?.(stream);
            if (!binding || !this.options.meta.canSteer(descriptor.space, binding.bot, self.user) || refs?.execution !== binding.execution || refs.replyTo !== binding.trigger || refs.thread !== stream)
                return fail('forbidden');
        }
        else {
            if (refs?.thread || refs?.execution)
                return fail('forbidden');
            const decision = this.options.meta.canWrite(descriptor.space, descriptor, envelope, author);
            if (!decision.ok)
                return fail(decision.code);
        }
        this.options.outbox.enqueue({ id: envelope.id, stream, envelope: bytes, sig });
        this.notify(descriptor.space);
        return envelope.id;
    }
    post(stream: StreamId, text: string, refs?: Envelope['refs']): EventId { return this.queue(stream, 'message.posted', { text }, refs); }
    flush(space: SpaceId): Promise<void> { const existing = this.flushing.get(space); if (existing)
        return existing; const pending = this.flushNow(space).finally(() => this.flushing.delete(space)); this.flushing.set(space, pending); return pending; }
    private async flushNow(space: SpaceId): Promise<void> {
        const session = this.sessions.get(space);
        if (!session || session.state() !== 'open')
            return;
        const binding = this.binding(space);
        if (!binding)
            return;
        let advertised;
        try {
            advertised = await session.metaHead(binding.meta);
        }
        catch (error) {
            if (error instanceof NetError && ['forbidden', 'not_member', 'upgrade_required'].includes(error.code)) {
                this.options.db.transaction(() => { binding.state = 'blocked'; this.save(binding); });
                for (const stream of this.options.store.listStreams({ space }))
                    for (const entry of this.options.outbox.due(stream.id))
                        if (entry.state === 'pending')
                            this.options.outbox.markFailed(entry.id, error.code);
            }
            return;
        }
        const local = this.options.meta.position(space);
        if (!local || local.epoch !== advertised.epoch || local.seq < advertised.seq)
            return;
        for (const stream of this.options.store.listStreams({ space }))
            for (const entry of this.options.outbox.due(stream.id)) {
                if (this.options.private?.isPrepared(entry.id))
                    continue;
                const known = this.options.store.getById(stream.id, entry.id);
                if (known) {
                    this.reconcile(known, stream.id);
                    continue;
                }
                let meta;
                try {
                    meta = this.options.meta.assertUsable(space, true);
                    const self = this.self();
                    if (!this.options.meta.member(space, self.user))
                        return fail('not_member');
                    const envelope = decodeEnvelope(entry.envelope).envelope;
                    if (envelope.auth?.metaEpoch !== meta.epoch) {
                        if (entry.state === 'pending')
                            this.options.outbox.markFailed(entry.id, 'conflict');
                        continue;
                    }
                    if (stream.kind === 'space.channel' && this.options.meta.channel(space, stream.id)?.archived)
                        return fail('forbidden');
                    if (stream.kind === 'space.private') {
                        if (this.options.private?.canWrite(stream, envelope, { user: self.user, node: self.node, delegation: self.delegation }) !== true)
                            return fail('forbidden');
                    }
                    else if(envelope.author.bot){
                        const author=this.options.identity.verifyAuthor(envelope.author,entry.envelope,entry.sig,this.clock.now(),'newWork')
                        if(author.kind!=='bot' || author.user!==self.user || author.node!==self.node || this.options.canWriteBotRecord?.(stream,envelope,{user:self.user,node:self.node,delegation:self.delegation},this.options.threadBinding?.(stream.id))!==true)return fail('forbidden')
                    }
                    else if (stream.kind === 'space.thread') {
                        const binding = this.options.threadBinding?.(stream.id);
                        if (!binding || !this.options.meta.canSteer(space, binding.bot, self.user) || envelope.refs?.thread !== stream.id || envelope.refs?.replyTo !== binding.trigger || envelope.refs?.execution !== binding.execution)
                            return fail('forbidden');
                    }
                    else {
                        const author = this.options.identity.verifyAuthor(envelope.author, entry.envelope, entry.sig, this.clock.now(), 'newWork'), decision = this.options.meta.canWrite(space, stream, envelope, author);
                        if (!decision.ok)
                            return fail(decision.code);
                    }
                }
                catch (error) {
                    if (error instanceof NetError && entry.state === 'pending')
                        this.options.outbox.markFailed(entry.id, error.code);
                    continue;
                }
                this.options.outbox.markAttempt(entry.id);
                try {
                    const result = await session.append(stream.id, entry.id, entry.envelope, entry.sig);
                    this.options.outbox.markSent(entry.id, result);
                }
                catch (error) {
                    if (error instanceof NetError && !error.retryable && !['cancelled', 'internal'].includes(error.code))
                        this.options.outbox.markFailed(entry.id, error.code);
                    if (session.state() !== 'open')
                        return;
                    // The first receipt must be acknowledged or reconciled
                    // before later records in this stream can leave the outbox.
                    break;
                }
            }
    }
    private queueBudget(space: SpaceId): void { const row = this.options.db.database.prepare("SELECT count(*) AS n,coalesce(sum(length(envelope)+length(sig)),0) AS bytes FROM net_outbox WHERE space_id=? AND state IN ('pending','unknown')").get(space)!; if (Number(row.n) >= (this.options.maxPendingEvents ?? 4096) || Number(row.bytes) + 65536 + 64 > (this.options.maxPendingBytes ?? 16 * 1024 * 1024))
        return fail('too_large'); }
    outbox(stream: StreamId): OutboxEntry[] { return this.options.outbox.list(stream); }
    private closeUnauthorized(space: SpaceId): void { const session = this.sessions.get(space); if (!session)
        return; for (const [stream, subscription] of this.subscriptions) {
        const descriptor = this.options.store.getStream(stream);
        if (descriptor?.space === space && descriptor.kind !== 'space.meta' && !this.canReceive(descriptor, session.peer)) {
            subscription.close();
            this.subscriptions.delete(stream);
        }
    } }
    disconnect(space: SpaceId): void { this.controllers.get(space)?.abort(); this.controllers.delete(space); this.sessions.get(space)?.close(); this.sessions.delete(space); for (const [stream, subscription] of this.subscriptions)
        if (this.options.store.getStream(stream)?.space === space) {
            subscription.close();
            this.subscriptions.delete(stream);
        } }
    close(): void { for (const space of this.controllers.keys())
        this.disconnect(space); }
}

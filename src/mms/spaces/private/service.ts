import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Clock, IdentityService, KeyStore, Outbox, PrivateStreamKeys, StreamStore, SyncSession } from '../../net/contracts';
import { NetDatabase, json } from '../../net/store/database';
import { systemClock } from '../../net/clock';
import { canonicalJson, decodeEnvelope, parseProtocolJson } from '../../net/sync/codec';
import { decodeBase64, verifyDocument } from '../../net/identity/crypto';
import { validateEventBody } from '../../../shared/net/schemas';
import { NetError, newId, isId, isCritical, isKnownEventType, DEFAULT_MAX_BLOB_BYTES } from '../../../shared/net';
import type { BlobId, BotId, Envelope, EnvelopeAuthRef, EventId, MemberRecord, NodeDelegation, NodeId, Roster, SpaceId, StreamHead, StoredRecord, StreamDescriptor, StreamId, UserId } from '../../../shared/net';
import type { MetaProjection } from '../host';
import type { PrivateSpaceAuthorization } from '../host/service';
type Control = NonNullable<Envelope<'participants.changed'>['body']>;
type Peer = SyncSession['peer'];
export interface PrivateState {
    space: SpaceId;
    stream: StreamId;
    controller: UserId;
    control: Control;
    position: {
        epoch: number;
        seq: number;
    };
    blocked: boolean;
}
export interface PrivateServiceOptions {
    db: NetDatabase;
    identity: IdentityService;
    keys: KeyStore;
    privateKeys: PrivateStreamKeys;
    store: StreamStore;
    meta: MetaProjection;
    outbox: Outbox;
    clock?: Clock;
    /** Historical membership is proved by signed meta, never a host member list. */
    rosterAt?(space: SpaceId, user: UserId, at: number, rootKey: string): import('../../../shared/net').Signed | undefined;
    memberAt?(space: SpaceId, user: UserId, auth: EnvelopeAuthRef): MemberRecord | undefined;
    /** A root-owned creation gate must bind the exact initial control to a proven parent. */
    publishParentOpen?(event: {
        id: EventId;
        stream: StreamId;
        envelope: Uint8Array;
        sig: Uint8Array;
    }): Promise<{
        epoch: number;
        seq: number;
        recvTs: number;
    }>;
    publishCreation?(descriptor: StreamDescriptor, control: {
        id: EventId;
        envelope: Uint8Array;
        sig: Uint8Array;
    }): Promise<{
        epoch: number;
        seq: number;
        recvTs: number;
    }>;
    canBotWrite?(descriptor: StreamDescriptor, envelope: Envelope, peer: Peer): boolean;
    /** Exact immutable execution/trigger/current-audience proof; never a general cross-stream read grant. */
    validateExecutionReferences?(descriptor: StreamDescriptor, envelope: Envelope, peer: Peer): boolean;
    /** Called only after this snapshot validator independently verifies the controlling signed audience. */
    verifyBotRecord?(record:StoredRecord,descriptor:StreamDescriptor,verifiedControl:PrivateState):void;
    onControlChanged?(before: PrivateState | undefined, after: PrivateState): void;
}
/** Local activation guards reserve room for wrapped-key and projection writes.
 * They are resource limits, not membership or wire-validity rules. */
export const PRIVATE_BOOTSTRAP_MAX_CONTROLS = 64;
export const PRIVATE_BOOTSTRAP_MAX_CONTROL_BYTES = 128 * 1024;
const fail = (code: ConstructorParameters<typeof NetError>[0]): never => { throw new NetError(code); };
const same = (a: unknown, b: unknown): boolean => json(a) === json(b);
export function privateContentAAD(envelope: Envelope): Uint8Array { const { body: _body, sealed: _sealed, ...metadata } = envelope; return Buffer.concat([Buffer.from('mousse-net/private-content/v1\0'), canonicalJson(metadata)]); }
/** Enclosing signature/participant/placement gate for the P1 crypto primitive.
 * Host projections receive ciphertext and authenticated controls only. */
export class PrivateSpaceService implements PrivateSpaceAuthorization {
    readonly maxRecordsPerAppend = 64;
    supports(descriptor: StreamDescriptor): boolean { return descriptor.kind === 'space.private'; }
    private readonly clock: Clock;
    constructor(readonly options: PrivateServiceOptions) {
        this.clock = options.clock ?? systemClock;
        options.db.transaction(() => options.db.database.exec(`
    CREATE TABLE IF NOT EXISTS net_space_private_state(stream TEXT PRIMARY KEY,space_id TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS net_space_private_history(stream TEXT NOT NULL,space_id TEXT NOT NULL,key_epoch INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(stream,key_epoch));
    CREATE TABLE IF NOT EXISTS net_space_private_snapshot(gen TEXT PRIMARY KEY,stream TEXT NOT NULL,space_id TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS net_space_private_snapshot_controls(gen TEXT NOT NULL,stream TEXT NOT NULL,space_id TEXT NOT NULL,ordinal INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(gen,ordinal));
    CREATE TABLE IF NOT EXISTS net_space_private_prepared(stream TEXT PRIMARY KEY,space_id TEXT NOT NULL,descriptor TEXT NOT NULL,event TEXT NOT NULL,parent_event TEXT NOT NULL);
  `));
        this.cleanupStages();
    }
    private cleanupStages(maxRows = Infinity): void { let removed = 0; for (const table of ['net_space_private_snapshot_controls', 'net_space_private_snapshot'])
        for (;;) {
            const rows = this.options.db.database.prepare(`SELECT rowid FROM ${table} WHERE gen NOT IN (SELECT json_extract(progress,'$.carry.gen') FROM net_snapshot_progress WHERE json_extract(progress,'$.carry.gen') IS NOT NULL) LIMIT ?`).all(Math.min(500, maxRows - removed));
            if (!rows.length)
                break;
            this.options.db.transaction(() => { this.options.db.charge(rows.length); for (const row of rows)
                this.options.db.database.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(row.rowid!); });
            removed += rows.length;
            if (removed >= maxRows)
                return;
        } }
    isPrepared(id: EventId): boolean { return !!this.options.db.database.prepare('SELECT 1 FROM net_space_private_prepared WHERE event=? OR parent_event=?').get(id, id); }
    /** Owner-local pre-created descriptors require the exact committed original opening, never a caller-authored substitute. */
    validatePreparedOpening(descriptor:StreamDescriptor,parent:Pick<StoredRecord,'envelope'|'sig'>):boolean {
        try {
            const row=this.options.db.database.prepare('SELECT descriptor,event,parent_event FROM net_space_private_prepared WHERE stream=? AND space_id=?').get(descriptor.id,descriptor.space!),self=this.self(),stored=this.options.store.getStream(descriptor.id);
            if(!row||descriptor.kind!=='space.private'||descriptor.authority!==self.node||!stored||!same(stored,descriptor)||!same(JSON.parse(row.descriptor as string),descriptor))return false;
            const original=this.options.outbox.get(row.parent_event as EventId),control=this.options.outbox.get(row.event as EventId);
            if(!original||!control||original.state==='failed'||control.state==='failed'||!Buffer.from(original.envelope).equals(parent.envelope)||!Buffer.from(original.sig).equals(parent.sig))return false;
            const envelope=decodeEnvelope(parent.envelope).envelope,author=this.options.identity.verifyAuthor(envelope.author,parent.envelope,parent.sig,envelope.ts,'newWork'),body=envelope.body as Envelope<'thread.opened'>['body'];
            if(author.kind!=='node'||author.user!==self.user||author.node!==self.node||envelope.id!==original.id||envelope.stream!==descriptor.parent||envelope.type!=='thread.opened'||body?.stream!==descriptor.id||body.private!==true||body.title!=='Private aside'||envelope.sealed||envelope.refs||envelope.blobs)return false;
            const initial=this.validateControl(descriptor,control.envelope,control.sig,'live');
            return initial.controller===author.user&&initial.keyEpoch===1&&initial.visibilityEpoch===1&&same(initial.participants,descriptor.participants);
        }catch{return false;}
    }
    validatePreparedControl(descriptor:StreamDescriptor,record:Pick<StoredRecord,'envelope'|'sig'>,parent:StoredRecord):boolean {
        try{
            if(this.state(descriptor.id)||this.options.store.head(descriptor.id).seq!==0||!this.validatePreparedOpening(descriptor,parent))return false;
            const row=this.options.db.database.prepare('SELECT event FROM net_space_private_prepared WHERE stream=?').get(descriptor.id),original=row&&this.options.outbox.get(row.event as EventId);
            if(!original||original.state==='failed'||!Buffer.from(original.envelope).equals(record.envelope)||!Buffer.from(original.sig).equals(record.sig))return false;
            const envelope=decodeEnvelope(parent.envelope).envelope,indexed=this.options.store.getById(descriptor.parent!,envelope.id);
            if(!indexed||indexed.epoch!==parent.epoch||indexed.seq!==parent.seq||indexed.recvTs!==parent.recvTs||!Buffer.from(indexed.envelope).equals(parent.envelope)||!Buffer.from(indexed.sig).equals(parent.sig))return false;
            const control=this.validateControl(descriptor,record.envelope,record.sig,'live');
            return control.controller===envelope.author.user&&control.keyEpoch===1&&control.visibilityEpoch===1;
        }catch{return false;}
    }
    state(stream: StreamId): PrivateState | undefined { const row = this.options.db.database.prepare('SELECT state FROM net_space_private_state WHERE stream=?').get(stream); return row ? JSON.parse(row.state as string) : undefined; }
    validateCreation(input: {
        descriptor: StreamDescriptor;
        controllerEvent: {
            envelope: Uint8Array;
            sig: Uint8Array;
        };
        parentOpenEvent: StoredRecord;
    }, purpose: 'live' | 'history' = 'live'): Control {
        const { descriptor, controllerEvent, parentOpenEvent } = input, control = decodeEnvelope(controllerEvent.envelope).envelope, parent = decodeEnvelope(parentOpenEvent.envelope).envelope, meta = descriptor.space && this.options.meta.assertUsable(descriptor.space, purpose === 'live');
        if (!descriptor.space || !descriptor.parent || !meta || descriptor.kind !== 'space.private' || this.state(descriptor.id) || this.options.store.getStream(descriptor.id))
            return fail('conflict');
        const host = JSON.parse(decodeBase64(meta.descriptor!.payload).toString()).hostNode, body = parent.body as Envelope<'thread.opened'>['body'];
        if (descriptor.authority !== host || parent.stream !== descriptor.parent || parent.type !== 'thread.opened' || !body?.private || body.stream !== descriptor.id || parent.author.bot || parent.author.user !== control.author.user || body.title !== 'Private aside')
            return fail('forbidden');
        const parentDescriptor = this.options.store.getStream(descriptor.parent);
        if (!parentDescriptor || parentDescriptor.kind !== 'space.channel' || parentDescriptor.space !== descriptor.space || parentDescriptor.authority !== descriptor.authority || !parent.auth || parent.auth.metaEpoch !== meta.epoch || parent.auth.metaSeq > meta.seq || !this.member(descriptor.space, parent.author.user!, parent.auth)) return fail('forbidden');
        const committed = this.options.store.getById(descriptor.parent, parent.id);
        if (!committed || committed.epoch !== parentOpenEvent.epoch || committed.seq !== parentOpenEvent.seq || !Buffer.from(committed.envelope).equals(Buffer.from(parentOpenEvent.envelope)) || !Buffer.from(committed.sig).equals(Buffer.from(parentOpenEvent.sig)))
            return fail('forbidden');
        this.options.identity.verifyAuthor(parent.author, parentOpenEvent.envelope, parentOpenEvent.sig, parent.ts, purpose === 'live' ? 'newWork' : 'history');
        return this.validateControl(descriptor, controllerEvent.envelope, controllerEvent.sig, purpose);
    }
    acceptCreation(input: {
        descriptor: StreamDescriptor;
        controllerEvent: StoredRecord;
        parentOpenEvent: StoredRecord;
    }): void {
        this.options.db.transaction(() => { this.validateCreation(input); if (input.controllerEvent.epoch !== 1 || input.controllerEvent.seq !== 1)
            return fail('conflict'); this.options.store.createStream(input.descriptor, 1); this.options.store.applyFromAuthority(input.descriptor.id, [input.controllerEvent]); this.applyStored(input.descriptor, input.controllerEvent, 'history'); this.options.db.checkpoint('spaces.private.creation.beforeCommit'); });
    }
    /** Proof-carrying recipient discovery: verify the entire control chain before
     * adopting any key. Sparse stream positions are allowed because ciphertext
     * between controls has no participant-authority effect. */
    acceptBootstrap(input: {
        descriptor: StreamDescriptor;
        controllerEvents: readonly StoredRecord[];
        parentOpenEvent: StoredRecord;
    }): void {
        const { descriptor, controllerEvents, parentOpenEvent } = input;
        if (!controllerEvents.length || controllerEvents.length > PRIVATE_BOOTSTRAP_MAX_CONTROLS || controllerEvents.reduce((n, r) => n + r.envelope.length + r.sig.length, 0) > PRIVATE_BOOTSTRAP_MAX_CONTROL_BYTES)
            return fail('too_large');
        this.validateCreation({ descriptor, controllerEvent: controllerEvents[0], parentOpenEvent }, 'history');
        if (controllerEvents[0].epoch !== 1 || controllerEvents[0].seq !== 1)
            return fail('conflict');
        let before: PrivateState | undefined;
        for (const record of controllerEvents) {
            const envelope = decodeEnvelope(record.envelope).envelope;
            this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, envelope.ts, 'history');
            if (record.epoch !== 1 || before && record.seq <= before.position.seq)
                return fail('conflict');
            const control = this.validateMeaning(descriptor, envelope, 'history', { before });
            before = { space: descriptor.space!, stream: descriptor.id, controller: control.controller, control, position: { epoch: record.epoch, seq: record.seq }, blocked: false };
        }
        const self = this.self();
        if (!this.options.meta.member(descriptor.space!, self.user) || !before!.control.participants.includes(self.user) || !before!.control.wrapped.some(w => w.node === self.node && w.recipientAgreementKey === self.delegation.keys.agree))
            return fail('forbidden');
        this.options.db.transaction(() => { this.options.store.createStream(descriptor, 1); this.options.store.applyFromAuthority(descriptor.id, [controllerEvents[0]]); let previous: PrivateState | undefined; for (const record of controllerEvents) {
            this.applyStored(descriptor, record, 'history', { before: previous });
            previous = this.state(descriptor.id);
        } const state = this.state(descriptor.id)!; this.options.db.afterCommit(() => this.options.onControlChanged?.(undefined, state)); this.options.db.checkpoint('spaces.private.bootstrap.beforeCommit'); });
    }
    private historical(stream: StreamId, keyEpoch: number): PrivateState | undefined { const row = this.options.db.database.prepare('SELECT state FROM net_space_private_history WHERE stream=? AND key_epoch=?').get(stream, keyEpoch); return row ? JSON.parse(row.state as string) : undefined; }
    /** Only controls previously verified and durably adopted by this service. */
    historyState(stream: StreamId, keyEpoch: number): PrivateState | undefined { return this.historical(stream, keyEpoch); }
    authorizationAudience(descriptor:StreamDescriptor):{visibilityEpoch:number;participantHash:string}|undefined {
        try{if(descriptor.kind!=='space.private'||!same(this.descriptor(descriptor.id),descriptor))return;const state=this.current(descriptor.id);return{visibilityEpoch:state.control.visibilityEpoch,participantHash:createHash('sha256').update(canonicalJson(state.control.participants)).digest('base64url')};}catch{return;}
    }
    private descriptor(stream: StreamId): StreamDescriptor { const descriptor = this.options.store.getStream(stream); if (!descriptor?.space || descriptor.kind !== 'space.private' || !descriptor.parent)
        return fail('stream_unknown'); return descriptor; }
    private member(space: SpaceId, user: UserId, auth?: EnvelopeAuthRef): MemberRecord | undefined { if (auth)
        return (this.options.memberAt ?? ((space, user, auth) => this.options.meta.memberAt(space, user, auth)))(space, user, auth); return this.options.meta.member(space, user); }
    private self() { const self = this.options.identity.self(); if (!self)
        return fail('not_enrolled'); const root = this.options.identity.pinnedRootKey(self.user), signed = this.options.identity.roster(self.user); if (!root || !signed)
        return fail('bad_delegation'); const roster = verifyDocument<Roster>(signed, root, 'roster'), delegation = roster.nodes.map(row => verifyDocument<NodeDelegation>(row, root, 'nodeDelegation')).filter(row => row.subject === self.node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]; if (!delegation || delegation.issuedAt > this.clock.now() || this.clock.now() >= delegation.expiresAt || this.options.identity.rosterState(self.user) === 'conflict')
        return fail('bad_delegation'); return { ...self, delegation }; }
    private recipients(space: SpaceId, participants: Array<UserId | BotId>, auth?: EnvelopeAuthRef, at = this.clock.now()): Array<NodeDelegation> {
        const users = new Set<UserId>(), botNodes = new Set<NodeId>();
        for (const participant of participants) {
            if (isId('user', participant)) {
                if (!this.member(space, participant, auth))
                    return fail('not_member');
                users.add(participant);
            }
            else {
                const bot = this.options.meta.bot(space, participant);
                if (!bot || !participants.includes(bot.owner))
                    return fail('forbidden');
                users.add(bot.owner);
                const root = this.options.identity.pinnedRootKey(bot.owner);
                if (!root)
                    return fail('meta_stale');
                const delegation = verifyDocument<any>(bot.delegation, root, 'botDelegation');
                botNodes.add(delegation.hostNode);
            }
        }
        const result = new Map<NodeId, NodeDelegation>();
        for (const user of users) {
            const member = this.member(space, user, auth), signed = auth && this.options.rosterAt ? this.options.rosterAt(space, user, at, member?.rootKey ?? '') : this.options.identity.roster(user);
            if (!member || !signed)
                return fail('meta_stale');
            if (!auth && this.options.identity.rosterState(user) === 'conflict')
                return fail('roster_conflict');
            const roster = verifyDocument<Roster>(signed, member.rootKey, 'roster'), latest = new Map<NodeId, NodeDelegation>();
            for (const row of roster.nodes) {
                const node = verifyDocument<NodeDelegation>(row, member.rootKey, 'nodeDelegation'), before = latest.get(node.subject);
                if (!before || node.keyEpoch > before.keyEpoch || node.keyEpoch === before.keyEpoch && node.issuedAt > before.issuedAt)
                    latest.set(node.subject, node);
            }
            for (const node of latest.values())
                if (node.issuedAt <= at && at < node.expiresAt && !(roster.revoked.some(r => r.subject === node.subject && r.throughKeyEpoch >= node.keyEpoch && (!auth || r.revokedAt <= at))))
                    result.set(node.subject, node);
        }
        for (const node of botNodes)
            if (!result.has(node))
                return fail('bad_delegation');
        if (result.size > 256)
            return fail('too_large');
        return [...result.values()];
    }
    validateControl(descriptor: StreamDescriptor, bytes: Uint8Array, sig: Uint8Array, purpose: 'live' | 'history' = 'live'): Control {
        const { envelope } = decodeEnvelope(bytes);
        this.options.identity.verifyAuthor(envelope.author, bytes, sig, envelope.ts, purpose === 'live' ? 'newWork' : 'history');
        return this.validateMeaning(descriptor, envelope, purpose);
    }
    private validateMeaning(descriptor: StreamDescriptor, envelope: Envelope, purpose: 'live' | 'history', staged?: {
        before: PrivateState | undefined;
    }): Control {
        const body = envelope.body as Control, before = staged ? staged.before : this.state(descriptor.id), meta = this.options.meta.position(descriptor.space!);
        if (descriptor.kind !== 'space.private' || !descriptor.space || envelope.stream !== descriptor.id || envelope.type !== 'participants.changed' || envelope.sealed || !body)
            return fail('bad_request');
        if (envelope.author.bot || envelope.author.user !== body.controller || before && before.controller !== body.controller)
            return fail('forbidden');
        if (!envelope.auth || !meta || envelope.auth.metaEpoch !== meta.epoch || envelope.auth.metaSeq > meta.seq)
            return fail('meta_stale');
        if (envelope.minor > 0)
            return fail('upgrade_required');
        if (!body.participants.includes(body.controller) || !same(body.participants, [...new Set(body.participants)].sort()) || new Set(body.writers.map(w => w.node)).size !== body.writers.length || new Set(body.writers.map(w => w.noncePrefix)).size !== body.writers.length || new Set(body.wrapped.map(w => w.node)).size !== body.wrapped.length)
            return fail('conflict');
        if (!this.member(descriptor.space, body.controller, purpose === 'history' ? envelope.auth : undefined))
            return fail('not_member');
        if (!before) {
            if (body.keyEpoch !== 1 || body.visibilityEpoch !== 1 || !same(descriptor.participants, body.participants))
                return fail('conflict');
        }
        else if (body.keyEpoch === before.control.keyEpoch) {
            if (body.visibilityEpoch !== before.control.visibilityEpoch || !same(body.participants, before.control.participants) || !before.control.wrapped.every(w => body.wrapped.some(next => same(w, next))) || !before.control.writers.every(w => body.writers.some(next => same(w, next))))
                return fail('conflict');
            if (same(body, before.control) && purpose === 'history')
                return body;
        }
        else if (body.keyEpoch !== before.control.keyEpoch + 1 || body.visibilityEpoch !== before.control.visibilityEpoch + (same(body.participants, before.control.participants) ? 0 : 1))
            return fail('conflict');
        const recipients = this.recipients(descriptor.space, body.participants, purpose === 'history' ? envelope.auth : undefined, envelope.ts);
        for (const wrap of body.wrapped) {
            const node = recipients.find(n => n.subject === wrap.node);
            if (!node) {
                const known = before?.control.wrapped.some(w => w.node === wrap.node);
                return fail(known ? 'revoked' : 'bad_delegation');
            }
            if (node.keys.agree !== wrap.recipientAgreementKey)
                return fail('bad_delegation');
        }
        if (body.wrapped.length !== recipients.length || recipients.some(node => !body.wrapped.some(w => w.node === node.subject)) || body.writers.length !== body.wrapped.length || body.writers.some(writer => !body.wrapped.some(w => w.node === writer.node)))
            return fail('bad_delegation');
        return body;
    }
    /** Call inside the authority/replica event+cursor transaction. */
    applyStored(descriptor: StreamDescriptor, record: StoredRecord, purpose: 'live' | 'history' = 'history', replay?: {
        before: PrivateState | undefined;
    }): void {
        const envelope = decodeEnvelope(record.envelope).envelope;
        if (envelope.type !== 'participants.changed') {
            if (isCritical(envelope, false) && (!isKnownEventType(envelope.type) || envelope.minor > 0))
                this.block(descriptor.id);
            return;
        }
        this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, envelope.ts, purpose === 'live' ? 'newWork' : 'history');
        const body = this.validateMeaning(descriptor, envelope, purpose, replay), before = this.state(descriptor.id), state: PrivateState = { space: descriptor.space!, stream: descriptor.id, controller: body.controller, control: body, position: { epoch: record.epoch, seq: record.seq }, blocked: false };
        if (before && same(before.position, state.position) && same(before.control, body))
            return;
        this.options.db.transaction(() => { this.options.db.charge(2, Buffer.byteLength(json(body)) * 2); this.options.privateKeys.accept(descriptor.id, body); const text = json(state); this.options.db.charge(2, Buffer.byteLength(text) * 2); this.options.db.database.prepare('INSERT INTO net_space_private_state VALUES(?,?,?) ON CONFLICT(stream) DO UPDATE SET state=excluded.state').run(descriptor.id, descriptor.space!, text); this.options.db.database.prepare('INSERT INTO net_space_private_history VALUES(?,?,?,?) ON CONFLICT(stream,key_epoch) DO UPDATE SET state=excluded.state').run(descriptor.id, descriptor.space!, body.keyEpoch, text); this.options.db.checkpoint('spaces.private.beforeCommit'); if (!replay)
            this.options.db.afterCommit(() => this.options.onControlChanged?.(before, state)); });
    }
    /** Isolated, signed full-control history; no active key/state changes while staging. */
    append(records: readonly StoredRecord[], descriptor: StreamDescriptor, target: StreamHead, carry: unknown): unknown {
        if (descriptor.kind !== 'space.private' || !descriptor.space)
            return fail('bad_request');
        let gen = carry && typeof carry === 'object' ? (carry as {
            gen?: string;
        }).gen : undefined;
        let staging: {
            last?: StreamHead;
            before?: PrivateState;
            controls: number;
            bytes: number;
        };
        if (gen) {
            const row = this.options.db.database.prepare('SELECT state FROM net_space_private_snapshot WHERE gen=? AND stream=?').get(gen, descriptor.id);
            if (!row)
                return fail('conflict');
            staging = JSON.parse(row.state as string);
        }
        else {
            this.cleanupStages(100);
            gen = randomUUID();
            staging = { controls: 0, bytes: 0 };
        }
        for (const record of records) {
            const envelope = decodeEnvelope(record.envelope).envelope;
            if (envelope.stream !== descriptor.id || record.epoch !== target.epoch || staging.last && record.seq !== staging.last.seq + 1 || !staging.last && record.seq !== 1)
                return fail('snapshot_required');
            this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, envelope.ts, 'history');
            if (isCritical(envelope, false) && (!isKnownEventType(envelope.type) || envelope.minor > 0))
                return fail('upgrade_required');
            if (envelope.type === 'participants.changed') {
                const body = this.validateMeaning(descriptor, envelope, 'history', { before: staging.before }), serialized = json({ epoch: record.epoch, seq: record.seq, recvTs: record.recvTs, envelope: Buffer.from(record.envelope).toString('base64url'), sig: Buffer.from(record.sig).toString('base64url') });
                staging.controls++;
                staging.bytes += record.envelope.length + record.sig.length;
                if (staging.controls > PRIVATE_BOOTSTRAP_MAX_CONTROLS || staging.bytes > PRIVATE_BOOTSTRAP_MAX_CONTROL_BYTES)
                    return fail('too_large');
                this.options.db.charge(1, Buffer.byteLength(serialized));
                this.options.db.database.prepare('INSERT INTO net_space_private_snapshot_controls VALUES(?,?,?,?,?)').run(gen, descriptor.id, descriptor.space, staging.controls, serialized);
                staging.before = { space: descriptor.space, stream: descriptor.id, controller: body.controller, control: body, position: { epoch: record.epoch, seq: record.seq }, blocked: false };
            }
            else {
                if (!staging.before || !envelope.sealed || envelope.body !== undefined || envelope.sealed.keyEpoch !== staging.before.control.keyEpoch)
                    return fail('forbidden');
                const nonce = decodeBase64(envelope.sealed.nonce, 12);
                if (!staging.before.control.writers.some(w => w.node === envelope.author.node && decodeBase64(w.noncePrefix, 4).equals(nonce.subarray(0, 4))))
                    return fail('forbidden');
                if(envelope.author.bot&&envelope.type.startsWith('bot.run.')){
                    if(!this.options.verifyBotRecord)return fail('forbidden');
                    this.options.verifyBotRecord(record,descriptor,structuredClone(staging.before));
                }
            }
            staging.last = { epoch: record.epoch, seq: record.seq };
        }
        const text = json(staging);
        this.options.db.charge(1, Buffer.byteLength(text));
        this.options.db.database.prepare('INSERT INTO net_space_private_snapshot VALUES(?,?,?,?) ON CONFLICT(gen) DO UPDATE SET state=excluded.state').run(gen, descriptor.id, descriptor.space, text);
        return { gen };
    }
    finish(carry: unknown, descriptor: StreamDescriptor, target: StreamHead): void {
        const gen = (carry as {
            gen?: string;
        })?.gen, row = gen && this.options.db.database.prepare('SELECT state FROM net_space_private_snapshot WHERE gen=? AND stream=?').get(gen, descriptor.id);
        if (!row)
            return fail('conflict');
        const staging = JSON.parse(row.state as string);
        if (!same(staging.last, target) || !staging.before || staging.controls > PRIVATE_BOOTSTRAP_MAX_CONTROLS || staging.bytes > PRIVATE_BOOTSTRAP_MAX_CONTROL_BYTES)
            return fail('snapshot_required');
        const rows = this.options.db.database.prepare('SELECT record FROM net_space_private_snapshot_controls WHERE gen=? ORDER BY ordinal LIMIT 65').all(gen);
        if (rows.length !== staging.controls)
            return fail('conflict');
        const previous = this.state(descriptor.id);
        let before: PrivateState | undefined;
        for (const row of rows) {
            const r = JSON.parse(row.record as string);
            this.applyStored(descriptor, { epoch: r.epoch, seq: r.seq, recvTs: r.recvTs, envelope: decodeBase64(r.envelope), sig: decodeBase64(r.sig) }, 'history', { before });
            before = this.state(descriptor.id);
        }
        this.options.db.afterCommit(() => this.options.onControlChanged?.(previous, before!));
        this.options.db.charge(rows.length + 1);
        this.options.db.database.prepare('DELETE FROM net_space_private_snapshot_controls WHERE gen=?').run(gen);
        this.options.db.database.prepare('DELETE FROM net_space_private_snapshot WHERE gen=?').run(gen);
        this.options.db.checkpoint('spaces.private.snapshot.beforeCommit');
    }
    block(stream: StreamId): void { const state = this.state(stream); if (state)
        this.options.db.transaction(() => { const before = structuredClone(state); state.blocked = true; this.options.db.charge(1); this.options.db.database.prepare('UPDATE net_space_private_state SET state=? WHERE stream=?').run(json(state), stream); this.options.db.afterCommit(() => this.options.onControlChanged?.(before, state)); }); }
    private current(stream: StreamId): PrivateState { const state = this.state(stream), descriptor = this.descriptor(stream); this.options.meta.assertUsable(descriptor.space!, true); if (!state || state.blocked)
        return fail('meta_stale'); const recipients = this.recipients(state.space, state.control.participants); if (!state.control.wrapped.every(w => recipients.some(node => node.subject === w.node && node.keys.agree === w.recipientAgreementKey)))
        return fail('revoked'); return state; }
    canRead(descriptor: StreamDescriptor, peer: Peer): boolean { try {
        const state = this.state(descriptor.id);
        if (!state || state.blocked || !this.options.meta.member(descriptor.space!, peer.user))
            return false;
        this.options.meta.assertUsable(descriptor.space!);
        return state.control.participants.includes(peer.user) && state.control.wrapped.some(w => w.node === peer.node && w.recipientAgreementKey === peer.delegation.keys.agree);
    }
    catch {
        return false;
    } }
    canUpload(descriptor: StreamDescriptor, peer: Peer): boolean { try {
        this.current(descriptor.id);
        return this.canRead(descriptor, peer);
    }
    catch {
        return false;
    } }
    canWrite(descriptor: StreamDescriptor, envelope: Envelope, peer: Peer): boolean {
        try {
            if (envelope.author.node !== peer.node || envelope.author.user && envelope.author.user !== peer.user)
                return false;
            if (envelope.type === 'participants.changed') {
                this.validateMeaning(descriptor, envelope, 'live');
                return envelope.author.user === peer.user;
            }
            const state = this.current(descriptor.id);
            if (envelope.author.bot && this.options.canBotWrite?.(descriptor, envelope, peer) !== true)
                return false;
            if (!this.canRead(descriptor, peer) || !envelope.sealed || envelope.body !== undefined || envelope.sealed.keyEpoch !== state.control.keyEpoch)
                return false;
            const nonce = decodeBase64(envelope.sealed.nonce, 12);
            if (!state.control.writers.some(w => w.node === peer.node && decodeBase64(w.noncePrefix, 4).equals(nonce.subarray(0, 4))))
                return false;
            if (envelope.type === 'bot.permission.granted' || envelope.type === 'bot.permission.denied') {
                const subject = envelope.refs?.subject;
                if (!subject)
                    return false;
                const request = this.options.store.getById(descriptor.id, subject);
                if (!request)
                    return false;
                const author = decodeEnvelope(request.envelope).envelope.author, bot = author.bot && this.options.meta.bot(descriptor.space!, author.bot);
                if (!bot || bot.owner !== peer.user)
                    return false;
            }
            return this.referencesAllowed(descriptor, envelope, peer);
        }
        catch {
            return false;
        }
    }
    private referencesAllowed(descriptor: StreamDescriptor, envelope: Envelope, peer?: Peer): boolean {
        const refs = envelope.refs;
        if (!refs)
            return !['message.edited', 'message.deleted', 'bot.permission.granted', 'bot.permission.denied'].includes(envelope.type);
        if (refs.thread && refs.thread !== descriptor.id)
            return false;
        if (refs.mentions?.some(bot => !this.state(descriptor.id)?.control.participants.includes(bot) || !this.options.meta.bot(descriptor.space!, bot)))
            return false;
        const missing = [refs.subject, refs.replyTo].some(id => id && !this.options.store.getById(descriptor.id, id));
        if (missing && (!peer || !envelope.author.bot || !refs.execution || !envelope.type.startsWith('bot.run.') || envelope.type === 'bot.run.expired' || this.options.validateExecutionReferences?.(descriptor, envelope, peer) !== true))
            return false;
        if (['message.edited', 'message.deleted'].includes(envelope.type)) {
            if (!refs.subject)
                return false;
            const subject = decodeEnvelope(this.options.store.getById(descriptor.id, refs.subject)!.envelope).envelope;
            if (subject.author.user !== envelope.author.user || subject.author.bot !== envelope.author.bot)
                return false;
        }
        if (refs.execution && !this.options.canBotWrite?.(descriptor, envelope, peer ?? this.self()))
            return false;
        return true;
    }
    prepareCreation(space: SpaceId, parent: StreamId, participants: Array<UserId | BotId>): {
        descriptor: StreamDescriptor;
        event: {
            id: EventId;
            envelope: Uint8Array;
            sig: Uint8Array;
        };
        parentEvent: {
            id: EventId;
            envelope: Uint8Array;
            sig: Uint8Array;
        };
    } {
        const self = this.self(), meta = this.options.meta.assertUsable(space, true), channel = this.options.meta.channel(space, parent);
        if (!channel || channel.archived || !participants.includes(self.user))
            return fail('forbidden');
        const sorted = [...new Set(participants)].sort(), recipients = this.recipients(space, sorted), id = newId('stream'), descriptor: StreamDescriptor = { id, kind: 'space.private', space, parent, authority: JSON.parse(decodeBase64(meta.descriptor!.payload).toString()).hostNode, participants: sorted, createdAt: this.clock.now() };
        return this.options.db.transaction(() => {
            this.options.store.createStream(descriptor, meta.epoch);
            const body = this.options.privateKeys.rotate(id, recipients.map(node => ({ node: node.subject, agree: node.keys.agree })), { controller: self.user, participants: sorted, visibilityEpoch: 1 })!, event = this.signControl(id, body), parentEnvelope: Envelope = { v: 1, minor: 0, id: newId('event'), stream: parent, type: 'thread.opened', crit: false, author: { user: self.user, node: self.node, keyEpoch: self.delegation.keyEpoch }, ts: this.clock.now(), auth: { metaEpoch: meta.epoch, metaSeq: meta.seq }, body: { stream: id, title: 'Private aside', private: true } }, parentBytes = canonicalJson(parentEnvelope), parentEvent = { id: parentEnvelope.id, envelope: parentBytes, sig: this.options.keys.signAsNode(parentBytes) };
            this.options.db.transaction(() => { this.options.outbox.enqueue({ ...parentEvent, stream: parent }); this.options.outbox.enqueue({ ...event, stream: decodeEnvelope(event.envelope).envelope.stream }); this.options.db.charge(1, Buffer.byteLength(json(event.id))); this.options.db.database.prepare('INSERT INTO net_space_private_prepared VALUES(?,?,?,?,?)').run(id, space, json(descriptor), event.id, parentEvent.id); });
            this.options.db.checkpoint('spaces.private.prepare.beforeCommit');
            return { descriptor, event, parentEvent };
        });
    }
    async publishCreation(stream: StreamId): Promise<void> { const row = this.options.db.database.prepare('SELECT descriptor,event,parent_event FROM net_space_private_prepared WHERE stream=?').get(stream); if (!row || !this.options.publishCreation)
        return fail('forbidden'); const descriptor = JSON.parse(row.descriptor as string), entry = this.options.outbox.get(row.event as EventId)!, parent = this.options.outbox.get(row.parent_event as EventId)!; if (entry.state === 'failed' || parent.state === 'failed')
        return fail(entry.error ?? parent.error ?? 'forbidden'); if (parent.state !== 'sent') {
        if (!this.options.publishParentOpen)
            return fail('forbidden');
        this.options.outbox.markAttempt(parent.id);
        const parentPosition = await this.options.publishParentOpen(parent);
        this.options.db.transaction(() => { this.options.store.applyFromAuthority(parent.stream, [{ ...parentPosition, envelope: parent.envelope, sig: parent.sig }]); this.options.outbox.markSent(parent.id, parentPosition); });
    } this.options.outbox.markAttempt(entry.id); const position = await this.options.publishCreation(descriptor, entry); this.options.db.transaction(() => { this.options.store.applyFromAuthority(stream, [{ ...position, envelope: entry.envelope, sig: entry.sig }]); this.applyStored(descriptor, { ...position, envelope: entry.envelope, sig: entry.sig }, 'live'); this.options.outbox.markSent(entry.id, position); this.options.db.charge(1); this.options.db.database.prepare('DELETE FROM net_space_private_prepared WHERE stream=?').run(stream); }); }
    signControl(stream: StreamId, body: Control): {
        id: EventId;
        envelope: Uint8Array;
        sig: Uint8Array;
    } { const self = this.self(), descriptor = this.descriptor(stream), meta = this.options.meta.assertUsable(descriptor.space!, true), envelope: Envelope = { v: 1, minor: 0, id: newId('event'), stream, type: 'participants.changed', crit: true, author: { user: self.user, node: self.node, keyEpoch: self.delegation.keyEpoch }, ts: this.clock.now(), auth: { metaEpoch: meta.epoch, metaSeq: meta.seq }, body }, bytes = canonicalJson(envelope); return { id: envelope.id, envelope: bytes, sig: this.options.keys.signAsNode(bytes) }; }
    rotate(stream: StreamId, participants: Array<UserId | BotId>): {
        id: EventId;
        envelope: Uint8Array;
        sig: Uint8Array;
    } { const before = this.state(stream), self = this.self(); if (!before || before.controller !== self.user)
        return fail('forbidden'); return this.options.db.transaction(() => { const sorted = [...new Set(participants)].sort(), recipients = this.recipients(before.space, sorted), body = this.options.privateKeys.rotate(stream, recipients.map(n => ({ node: n.subject, agree: n.keys.agree })), { controller: self.user, participants: sorted, visibilityEpoch: before.control.visibilityEpoch + (same(before.control.participants, sorted) ? 0 : 1) })!, event = this.signControl(stream, body); this.options.outbox.enqueue({ ...event, stream: decodeEnvelope(event.envelope).envelope.stream }); return event; }); }
    rewrap(stream: StreamId, recipient: NodeId): {
        id: EventId;
        envelope: Uint8Array;
        sig: Uint8Array;
    } { const state = this.current(stream), self = this.self(); if (state.controller !== self.user || state.control.wrapped.some(w => w.node === recipient))
        return fail('forbidden'); const node = this.recipients(state.space, state.control.participants).find(n => n.subject === recipient); if (!node)
        return fail('forbidden'); const wrap = this.options.privateKeys.rewrap(stream, state.control.keyEpoch, { node: recipient, agree: node.keys.agree }), prefixes = new Set(state.control.writers.map(w => w.noncePrefix)); let prefix: string; do {
        prefix = randomBytes(4).toString('base64url');
    } while (prefixes.has(prefix)); const event = this.signControl(stream, { ...state.control, wrapped: [...state.control.wrapped, wrap].sort((a, b) => a.node.localeCompare(b.node)), writers: [...state.control.writers, { node: recipient, noncePrefix: prefix }].sort((a, b) => a.node.localeCompare(b.node)) }); this.options.outbox.enqueue({ ...event, stream: decodeEnvelope(event.envelope).envelope.stream }); return event; }
    seal(stream: StreamId, type: string, body: unknown, refs?: Envelope['refs'], blobs?: Envelope['blobs']): {
        id: EventId;
        envelope: Uint8Array;
        sig: Uint8Array;
    } { const state = this.current(stream), self = this.self(); if (!state.control.participants.includes(self.user) || !validateEventBody(type as any, body))
        return fail('forbidden'); const meta = this.options.meta.position(state.space)!, envelope: Envelope = { v: 1, minor: 0, id: newId('event'), stream, type, crit: isCritical({ type, crit: false }, false), author: { user: self.user, node: self.node, keyEpoch: self.delegation.keyEpoch }, ts: this.clock.now(), auth: { metaEpoch: meta.epoch, metaSeq: meta.seq }, ...(refs ? { refs } : {}), ...(blobs ? { blobs } : {}) }; if (!this.referencesAllowed(this.descriptor(stream), envelope))
        return fail('forbidden'); envelope.sealed = this.options.privateKeys.seal(stream, canonicalJson(body), privateContentAAD(envelope)); const bytes = canonicalJson(envelope), event = { id: envelope.id, envelope: bytes, sig: this.options.keys.signAsNode(bytes) }; this.options.outbox.enqueue({ ...event, stream: decodeEnvelope(event.envelope).envelope.stream }); return event; }
    open(stream: StreamId, record: StoredRecord): unknown { const { envelope } = decodeEnvelope(record.envelope); this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, envelope.ts, 'history'); if (envelope.stream !== stream)
        return fail('forbidden'); if (!isKnownEventType(envelope.type) || envelope.minor > 0) {
        if (isCritical(envelope, false))
            this.block(stream);
        return undefined;
    } if (envelope.stream !== stream || !envelope.sealed || !this.historical(stream, envelope.sealed.keyEpoch))
        return fail('forbidden'); const body = parseProtocolJson(this.options.privateKeys.open(stream, envelope.sealed, privateContentAAD(envelope))); if (!validateEventBody(envelope.type as any, body))
        return fail('bad_request'); return body; }
    sealBlob(stream: StreamId, plaintext: Uint8Array): {
        id: BlobId;
        bytes: Uint8Array;
        keyEpoch: number;
    } { this.current(stream); if (plaintext.length + 37 > DEFAULT_MAX_BLOB_BYTES)
        return fail('too_large'); const blob = this.options.privateKeys.sealBlob(stream, plaintext), id = `blb_${createHash('sha256').update(blob.bytes).digest('hex')}` as BlobId; return { id, ...blob }; }
    openBlob(stream: StreamId, record: StoredRecord, id: BlobId, bytes: Uint8Array): Uint8Array { const envelope = decodeEnvelope(record.envelope).envelope; this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, envelope.ts, 'history'); if (envelope.stream !== stream || !envelope.sealed || !envelope.blobs?.some(b => b.id === id && b.sealed && b.bytes === bytes.length) || `blb_${createHash('sha256').update(bytes).digest('hex')}` !== id)
        return fail('forbidden'); return this.options.privateKeys.openBlob(stream, envelope.sealed.keyEpoch, bytes); }
}

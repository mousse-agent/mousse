import { randomUUID } from 'node:crypto';
import type { IdentityService, StreamStore, MetaState as PublicMetaState, MetaDecision, VerifiedAuthor } from '../../net/contracts';
import type { MetaSnapshotValidator } from '../../net/store/streams';
import { NetDatabase, json } from '../../net/store/database';
import { decodeEnvelope } from '../../net/sync/codec';
import { verifyDocument, verifyBytes, decodeBase64 } from '../../net/identity/crypto';
import { BOT_PROFILES, DEFAULT_MAX_BLOB_BYTES, isAllowedBotPolicy, isKnownEventType, isCritical, NetError } from '../../../shared/net';
import type { BotRecord, Envelope, EnvelopeAuthor, MemberRecord, NetErrorCode, NodeDelegation, Roster, RoutesRecord, Signed, SpaceDescriptor, SpaceId, SpaceInviteAuthorization, SpaceSettings, StoredRecord, StreamDescriptor, StreamHead, StreamId, UserId } from '../../../shared/net';
export interface MetaState {
    space: SpaceId;
    stream: StreamId;
    status: 'absent' | 'active' | 'frozen' | 'upgradeRequired' | 'blocked';
    epoch: number;
    seq: number;
    descriptor?: Signed;
    owner?: UserId;
    settings?: SpaceSettings;
    freezeReason?: string;
    blockedCode?: NetErrorCode;
}
export interface MetaProjectionOptions {
    db: NetDatabase;
    identity: IdentityService;
    store: StreamStore;
    /** Independently signed retained evidence, never an implicit trust pin. */
    historyRoster?(author: EnvelopeAuthor, at: number, rootKey: string): Signed | undefined;
    /** Root-owned bulk checkpoint, invoked inside final generation activation. */
    activatePins?(roots: readonly {
        user: UserId;
        rootKey: string;
    }[]): void;
}
interface Generation {
    generation: string;
    space: SpaceId;
    stream: StreamId;
}
interface Channel {
    stream: StreamId;
    name: string;
    archived: boolean;
}
const reject = (code: NetErrorCode): never => { throw new NetError(code); };
const equal = (a: unknown, b: unknown): boolean => json(a) === json(b);
/** Durable deterministic projection. Staging uses isolated normalized rows;
 * the persisted snapshot carry is only an opaque generation identifier. */
export class MetaProjection implements MetaSnapshotValidator {
    readonly maxRecordsPerAppend = 64;
    constructor(readonly options: MetaProjectionOptions) {
        options.db.transaction(() => options.db.database.exec(`
      CREATE TABLE IF NOT EXISTS net_space_meta_active(space_id TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS net_space_meta_state(generation TEXT PRIMARY KEY, space_id TEXT NOT NULL, stream TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS net_space_meta_entities(generation TEXT NOT NULL, space_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT, PRIMARY KEY(generation,kind,id));
      CREATE TABLE IF NOT EXISTS net_space_meta_roles(generation TEXT NOT NULL, space_id TEXT NOT NULL, user TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL, role TEXT, value TEXT, PRIMARY KEY(generation,user,epoch,seq));
      CREATE TABLE IF NOT EXISTS net_space_meta_bot_history(generation TEXT NOT NULL,space_id TEXT NOT NULL,bot TEXT NOT NULL,epoch INTEGER NOT NULL,seq INTEGER NOT NULL,registered_epoch INTEGER NOT NULL,registered_seq INTEGER NOT NULL,value TEXT,PRIMARY KEY(generation,bot,epoch,seq));
      CREATE TABLE IF NOT EXISTS net_space_meta_violations(generation TEXT NOT NULL, space_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL, code TEXT NOT NULL, PRIMARY KEY(generation,epoch,seq));
    `));
        // NetDatabase first discards abandoned stream stages on restart. Reclaim
        // their isolated projection rows in separately bounded transactions. Live
        // carries and the current projection pointers remain protected.
        for (const table of ['net_space_meta_entities', 'net_space_meta_roles', 'net_space_meta_bot_history', 'net_space_meta_violations', 'net_space_meta_state']) {
            for (;;) {
                const rows = options.db.database.prepare(`SELECT rowid FROM ${table} WHERE generation NOT IN (SELECT generation FROM net_space_meta_active) AND generation NOT IN (SELECT json_extract(progress,'$.carry.generation') FROM net_snapshot_progress WHERE json_extract(progress,'$.carry.generation') IS NOT NULL) LIMIT 500`).all();
                if (!rows.length)
                    break;
                options.db.transaction(() => { options.db.charge(rows.length); for (const row of rows)
                    options.db.database.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(row.rowid!); });
            }
        }
    }
    state(space: SpaceId): PublicMetaState | undefined {
        const p = this.position(space);
        if (!p?.descriptor || !p.owner || !p.settings)
            return undefined;
        const members = new Map(this.entities<MemberRecord>(space, 'member').map(m => [m.user, { rootKey: m.rootKey, role: m.role, displayName: m.displayName }]));
        const bots = new Map(this.entities<BotRecord>(space, 'bot').map(b => [b.bot, { owner: b.owner, delegation: verifyDocument<any>(b.delegation, this.member(space, b.owner)!.rootKey, 'botDelegation'), profile: b.profile, policy: b.policy, displayName: b.displayName }]));
        return { space, owner: p.owner, descriptor: JSON.parse(decodeBase64(p.descriptor.payload).toString()), frozen: p.status === 'frozen', settings: p.settings, members, bots, channels: new Map(this.entities<Channel>(space, 'channel').map(c => [c.stream, { name: c.name, archived: c.archived }])), applied: { epoch: p.epoch, seq: p.seq }, upgradeRequired: p.status === 'upgradeRequired' || p.status === 'blocked' };
    }
    check(space: SpaceId, envelope: Envelope, author: VerifiedAuthor, purpose: 'live' | 'history'): MetaDecision {
        try {
            const g = this.generation(space);
            if (!g)
                return reject('stream_unknown');
            const p = this.stateFor(g);
            if (purpose === 'live' && (author.verifyOnly || author.revoked))
                return reject('bad_delegation');
            if (author.kind !== 'node' || author.user !== envelope.author.user || author.node !== envelope.author.node)
                return reject('forbidden');
            this.transition(g, p, { epoch: envelope.type === 'space.descriptor' ? (envelope.body as any).descriptor ? JSON.parse(decodeBase64((envelope.body as any).descriptor.payload).toString()).epoch : p.epoch : p.epoch, seq: envelope.type === 'space.descriptor' ? 1 : p.seq + 1, recvTs: envelope.ts, envelope: new Uint8Array(), sig: new Uint8Array() }, envelope, purpose === 'history', false);
            return { ok: true };
        }
        catch (error) {
            if (!(error instanceof NetError))
                throw error;
            return { ok: false, code: error.code, reason: error.message };
        }
    }
    apply(space: SpaceId, record: StoredRecord): {
        applied: boolean;
        violation?: string;
    } {
        const stream = this.options.store.listStreams({ space, kind: 'space.meta' })[0];
        if (!stream)
            return reject('stream_unknown');
        const before = this.position(space), next = this.applyRecord(stream, record, 'history');
        const violation = this.violations(space).find(v => v.epoch === record.epoch && v.seq === record.seq);
        return { applied: next.seq !== before?.seq || next.epoch !== before?.epoch, ...(violation ? { violation: violation.code } : {}) };
    }
    canRead(space: SpaceId, stream: StreamDescriptor, user: UserId): boolean {
        try {
            this.assertUsable(space);
            if (stream.space !== space || !this.member(space, user) || this.options.identity.rosterState(user) === 'conflict')
                return false;
            return stream.kind === 'space.meta' || this.publicChannel(space,stream) !== undefined;
        }
        catch {
            return false;
        }
    }
    /** Public ancestry is bounded and never crosses into another space, authority or private stream. */
    publicChannel(space: SpaceId, stream: StreamDescriptor): StreamId | undefined {
        const seen = new Set<StreamId>();
        let current: StreamDescriptor | undefined = stream;
        for (let depth=0;current && depth<32;depth++) {
            if (current.space !== space || current.authority !== stream.authority || seen.has(current.id)) return;
            seen.add(current.id);
            if (current.kind === 'space.channel') return this.channel(space,current.id) ? current.id : undefined;
            if (current.kind !== 'space.thread' || !current.parent) return;
            current=this.options.store.getStream(current.parent);
        }
    }
    canWrite(space: SpaceId, stream: StreamDescriptor, envelope: Envelope, author: VerifiedAuthor): MetaDecision {
        try {
            const p = this.assertUsable(space, true);
            if (stream.space !== space || envelope.stream !== stream.id || !envelope.auth || envelope.auth.metaEpoch !== p.epoch || envelope.auth.metaSeq > p.seq)
                return reject('meta_stale');
            if (envelope.minor < p.settings!.minProtoMinor)
                return reject('incompatible_peer');
            if (author.verifyOnly || author.revoked)
                return reject('bad_delegation');
            if (author.kind !== 'node' || !this.member(space, author.user))
                return reject('forbidden');
            if (stream.kind === 'space.meta')
                return this.check(space, envelope, author, 'live');
            if (stream.kind !== 'space.channel' || this.channel(space, stream.id)?.archived)
                return reject('forbidden');
            if (envelope.refs?.thread || envelope.refs?.execution)
                return reject('forbidden');
            if (!isKnownEventType(envelope.type) || envelope.minor > 0) {
                if (isCritical(envelope, false))
                    return reject('upgrade_required');
                return { ok: true };
            }
            if (!['message.posted', 'message.edited', 'message.deleted', 'thread.opened', 'thread.closed'].includes(envelope.type))
                return reject('forbidden');
            if (envelope.type === 'message.edited' || envelope.type === 'message.deleted') {
                const target = envelope.refs?.subject && this.options.store.getById(stream.id, envelope.refs.subject), member = this.member(space, author.user);
                if (!target)
                    return reject('bad_request');
                const original = decodeEnvelope(target.envelope).envelope.author;
                if (!original.user || original.user !== author.user && member?.role !== 'owner' && member?.role !== 'admin')
                    return reject('forbidden');
            }
            if (envelope.type === 'thread.opened' || envelope.type === 'thread.closed') {
                const child = this.options.store.getStream((envelope.body as any).stream);
                // A signed private opening reserves an identity only. Its first
                // complete authenticated participant control creates the stream.
                if (!child && envelope.type === 'thread.opened' && (envelope.body as any).private === true) return { ok: true };
                if (!child || child.space !== space || child.parent !== stream.id || child.kind !== 'space.thread' && child.kind !== 'space.private')
                    return reject('forbidden');
            }
            return { ok: true };
        }
        catch (error) {
            if (!(error instanceof NetError))
                throw error;
            return { ok: false, code: error.code, reason: error.message };
        }
    }
    canSteer(space: SpaceId, bot: string, user: UserId): boolean { try {
        this.assertUsable(space, true);
        const b = this.bot(space, bot), m = this.member(space, user);
        if (!b || !m)
            return false;
        return b.owner === user || b.policy.steer.kind === 'everyone' || (b.policy.steer.kind === 'roles' && b.policy.steer.roles.includes(m.role));
    }
    catch {
        return false;
    } }
    private generation(space: SpaceId): string | undefined { return this.options.db.database.prepare('SELECT generation FROM net_space_meta_active WHERE space_id=?').get(space)?.generation as string | undefined; }
    private stateFor(generation: string): MetaState { const row = this.options.db.database.prepare('SELECT state FROM net_space_meta_state WHERE generation=?').get(generation); if (!row)
        return reject('conflict'); const state = JSON.parse(row.state as string) as MetaState; const descriptor = this.get<Signed>(generation, 'descriptor', 'current'); if (descriptor)
        state.descriptor = descriptor; return state; }
    position(space: SpaceId): MetaState | undefined { const g = this.generation(space); return g ? this.stateFor(g) : undefined; }
    private save(generation: string, state: MetaState): void { const { descriptor, ...persisted } = state; if (descriptor && !equal(this.get(generation, 'descriptor', 'current') ?? null, descriptor))
        this.put(generation, state, 'descriptor', 'current', descriptor); const text = json(persisted); this.options.db.charge(1, Buffer.byteLength(text)); this.options.db.database.prepare('INSERT INTO net_space_meta_state VALUES(?,?,?,?) ON CONFLICT(generation) DO UPDATE SET state=excluded.state').run(generation, state.space, state.stream, text); }
    private newGeneration(descriptor: StreamDescriptor): Generation {
        if (descriptor.kind !== 'space.meta' || !descriptor.space)
            return reject('bad_request');
        const g = { generation: randomUUID(), space: descriptor.space, stream: descriptor.id };
        this.save(g.generation, { space: g.space, stream: g.stream, status: 'absent', epoch: 1, seq: 0 });
        return g;
    }
    private get<T>(generation: string, kind: string, id: string): T | undefined { const row = this.options.db.database.prepare('SELECT value FROM net_space_meta_entities WHERE generation=? AND kind=? AND id=?').get(generation, kind, id); return row?.value ? JSON.parse(row.value as string) : undefined; }
    private put(generation: string, state: MetaState, kind: string, id: string, value: unknown): void { const text = value === null ? null : json(value); this.options.db.charge(1, text ? Buffer.byteLength(text) : 0); this.options.db.database.prepare('INSERT INTO net_space_meta_entities VALUES(?,?,?,?,?) ON CONFLICT(generation,kind,id) DO UPDATE SET value=excluded.value').run(generation, state.space, kind, id, text); }
    member(space: SpaceId, user: UserId): MemberRecord | undefined { const g = this.generation(space); return g ? this.get(g, 'member', user) : undefined; }
    channel(space: SpaceId, stream: StreamId): Channel | undefined { const g = this.generation(space); return g ? this.get(g, 'channel', stream) : undefined; }
    bot(space: SpaceId, bot: string): BotRecord | undefined { const g = this.generation(space); return g ? this.activeBot(g, bot) : undefined; }
    private activeBot(g: string, id: string): BotRecord | undefined { const bot = this.get<BotRecord>(g, 'bot', id), position = this.get<StreamHead>(g, 'botPosition', id); if (!bot || !position || !this.get(g, 'member', bot.owner))
        return undefined; const removed = this.options.db.database.prepare('SELECT 1 FROM net_space_meta_roles WHERE generation=? AND user=? AND role IS NULL AND (epoch>? OR (epoch=? AND seq>=?)) LIMIT 1').get(g, bot.owner, position.epoch, position.epoch, position.seq); return removed ? undefined : bot; }
    entities<T>(space: SpaceId, kind: 'member' | 'channel' | 'bot' | 'invite'): T[] { const g = this.generation(space); if (!g)
        return []; const result = this.options.db.database.prepare('SELECT value FROM net_space_meta_entities WHERE generation=? AND kind=? AND value IS NOT NULL ORDER BY id').all(g, kind).map(row => JSON.parse(row.value as string)); return (kind === 'bot' ? result.filter(row => this.bot(space, row.bot)) : result) as T[]; }
    violations(space: SpaceId): Array<{
        epoch: number;
        seq: number;
        code: string;
    }> { const g = this.generation(space); return g ? this.options.db.database.prepare('SELECT epoch,seq,code FROM net_space_meta_violations WHERE generation=? ORDER BY epoch,seq').all(g) as never : []; }
    private roleAt(g: string, user: UserId, position: {
        metaEpoch: number;
        metaSeq: number;
    }): string | undefined { const row = this.options.db.database.prepare('SELECT role FROM net_space_meta_roles WHERE generation=? AND user=? AND (epoch<? OR (epoch=? AND seq<=?)) ORDER BY epoch DESC,seq DESC LIMIT 1').get(g, user, position.metaEpoch, position.metaEpoch, position.metaSeq); return row?.role as string | undefined; }
    memberAt(space: SpaceId, user: UserId, position: { metaEpoch: number; metaSeq: number }): MemberRecord | undefined {
        const generation = this.generation(space);
        if (!generation) return undefined;
        const row = this.options.db.database.prepare('SELECT value FROM net_space_meta_roles WHERE generation=? AND user=? AND (epoch<? OR (epoch=? AND seq<=?)) ORDER BY epoch DESC,seq DESC LIMIT 1').get(generation, user, position.metaEpoch, position.metaEpoch, position.metaSeq);
        return row?.value ? JSON.parse(row.value as string) : undefined;
    }
    /** Exact generation-scoped validated history; missing old evidence never falls back to the current bot. */
    botAt(space: SpaceId, bot: string, position: { metaEpoch: number; metaSeq: number }): BotRecord | undefined {
        const generation = this.generation(space);
        if (!generation || !Number.isSafeInteger(position.metaEpoch) || !Number.isSafeInteger(position.metaSeq) || position.metaEpoch < 1 || position.metaSeq < 0) return undefined;
        const state = this.stateFor(generation);
        if (position.metaEpoch > state.epoch || position.metaEpoch === state.epoch && position.metaSeq > state.seq) return undefined;
        const row = this.options.db.database.prepare('SELECT value,registered_epoch,registered_seq FROM net_space_meta_bot_history WHERE generation=? AND bot=? AND (epoch<? OR (epoch=? AND seq<=?)) ORDER BY epoch DESC,seq DESC LIMIT 1').get(generation,bot,position.metaEpoch,position.metaEpoch,position.metaSeq);
        if (!row?.value) return undefined;
        const value = JSON.parse(row.value as string) as BotRecord;
        if (!this.memberAt(space,value.owner,position)) return undefined;
        const removed = this.options.db.database.prepare('SELECT 1 FROM net_space_meta_roles WHERE generation=? AND user=? AND role IS NULL AND (epoch>? OR (epoch=? AND seq>=?)) AND (epoch<? OR (epoch=? AND seq<=?)) LIMIT 1').get(generation,value.owner,row.registered_epoch!,row.registered_epoch!,row.registered_seq!,position.metaEpoch,position.metaEpoch,position.metaSeq);
        return removed ? undefined : value;
    }
    /** Explicit upgrade/recovery: reconstruct evidence from the retained signed full meta history, never current entities. */
    rebuildBotHistory(space: SpaceId): void {
        if (this.options.db.inTransaction) return reject('bad_request');
        const state = this.position(space);
        if (!state) return reject('stream_unknown');
        const reader = this.options.store.openSnapshot(state.stream), stage = this.options.store.beginSnapshot(state.stream,reader.target);
        try {
            for (;;) { const page = reader.next(256 * 1024,32); stage.append(page.records); if (page.done) break; }
            stage.commit();
        } catch (error) { stage.abort(); throw error; }
        finally { reader.close(); }
    }
    canSteerAt(space: SpaceId, bot: string, user: UserId, position: { metaEpoch: number; metaSeq: number }): boolean {
        const record = this.botAt(space,bot,position), member = this.memberAt(space,user,position);
        return !!record && !!member && (record.owner === user || record.policy.steer.kind === 'everyone' || record.policy.steer.kind === 'roles' && record.policy.steer.roles.includes(member.role));
    }
    private botChange(g: string, state: MetaState, bot: string, value: BotRecord | null, record: StoredRecord, registered: StreamHead): void {
        this.put(g,state,'bot',bot,value);
        const text = value ? json(value) : null;
        this.options.db.charge(1,text ? Buffer.byteLength(text) : 0);
        this.options.db.database.prepare('INSERT INTO net_space_meta_bot_history VALUES(?,?,?,?,?,?,?,?)').run(g,state.space,bot,record.epoch,record.seq,registered.epoch,registered.seq,text);
    }
    private memberChange(g: string, state: MetaState, user: UserId, member: MemberRecord | null, record: StoredRecord): void {
        this.put(g, state, 'member', user, member);
        this.options.db.charge(1, member ? Buffer.byteLength(json(member)) : 0);
        this.options.db.database.prepare('INSERT INTO net_space_meta_roles VALUES(?,?,?,?,?,?,?)').run(g, state.space, user, record.epoch, record.seq, member?.role ?? null, member ? json(member) : null);
    }
    descriptor(signed: Signed, root: string, at: number, history: boolean): SpaceDescriptor {
        const descriptor = verifyDocument<SpaceDescriptor>(signed, root, 'spaceDescriptor');
        const identity = this.options.identity, rosterSigned = history ? identity.historicalRosterFor({ user: descriptor.owner, node: descriptor.hostNode, keyEpoch: this.hostEpoch(descriptor.owner, descriptor.hostNode, at) }, at) : identity.roster(descriptor.owner);
        if (!rosterSigned)
            return reject('meta_stale');
        const roster = verifyDocument<Roster>(rosterSigned, root, 'roster');
        const delegated = roster.nodes.map(row => verifyDocument<NodeDelegation>(row, root, 'nodeDelegation')).filter(row => row.subject === descriptor.hostNode && row.owner === descriptor.owner && row.issuedAt <= at && at < row.expiresAt).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0];
        if (!delegated || descriptor.hostTransportKey !== delegated.keys.transport || descriptor.issuedAt > at)
            return reject('bad_delegation');
        if (!history && (identity.rosterState(descriptor.owner) === 'conflict' || (roster.revoked.find(row => row.subject === delegated.subject)?.throughKeyEpoch ?? 0) >= delegated.keyEpoch))
            return reject('revoked');
        const routes = verifyDocument<RoutesRecord>(descriptor.routes, delegated.keys.sign, 'routes');
        if (routes.node !== descriptor.hostNode || routes.issuedAt > descriptor.issuedAt || !routes.routes.length)
            return reject('bad_delegation');
        return descriptor;
    }
    private hostEpoch(user: UserId, node: string, at: number): number {
        const root = this.options.identity.pinnedRootKey(user), signed = this.options.identity.roster(user);
        if (!root || !signed)
            return reject('meta_stale');
        const roster = verifyDocument<Roster>(signed, root, 'roster'), rows = roster.nodes.map(row => verifyDocument<NodeDelegation>(row, root, 'nodeDelegation')).filter(row => row.subject === node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt);
        // Current rosters retain verify-only delegations; a missing original epoch
        // requires independently retained historical roster evidence.
        for (const row of rows) {
            if (this.options.identity.historicalRosterFor({ user, node: row.subject, keyEpoch: row.keyEpoch }, at)) return row.keyEpoch;
        }
        return reject('meta_stale');
    }
    assertUsable(space: SpaceId, writes = false): MetaState { const state = this.position(space); if (!state || state.status === 'absent')
        return reject('stream_unknown'); if (state.status === 'upgradeRequired')
        return reject('upgrade_required'); if (state.status === 'blocked')
        return reject(state.blockedCode??'bad_signature'); if (writes && state.status === 'frozen')
        return reject('space_frozen'); return state; }
    block(space: SpaceId, status: 'upgradeRequired' | 'blocked'): void { const g = this.generation(space); if (!g)
        return reject('stream_unknown'); this.options.db.transaction(() => { const state = this.stateFor(g); state.status = status; this.save(g, state); }); }
    checkInvite(space: SpaceId, signed: Signed, member: MemberRecord, use: number, at: number, history = false, generation = this.generation(space)): SpaceInviteAuthorization {
        if (!generation)
            return reject('meta_stale');
        const state = this.stateFor(generation), raw = JSON.parse(decodeBase64(signed.payload).toString()) as SpaceInviteAuthorization;
        const issuer = this.get<MemberRecord>(generation, 'member', raw.issuer?.user);
        if (!issuer)
            return reject('invite_invalid');
        const delegated = verifyDocument<NodeDelegation>(raw.issuer.delegation, issuer.rootKey, 'nodeDelegation'), invite = verifyDocument<SpaceInviteAuthorization>(signed, delegated.keys.sign, 'inviteAuthorization');
        if (delegated.owner !== issuer.user || delegated.subject !== invite.issuer.node || invite.issuedAt < delegated.issuedAt || invite.issuedAt >= delegated.expiresAt || at < delegated.issuedAt || at >= delegated.expiresAt)
            return reject('invite_invalid');
        if (!history) {
            if (!this.options.identity.roster(issuer.user))
                return reject('meta_stale');
            this.options.identity.verifyAuthor({ user: issuer.user, node: delegated.subject, keyEpoch: delegated.keyEpoch }, decodeBase64(signed.payload), decodeBase64(signed.sig, 64), at, 'newWork');
        }
        if (invite.space !== space || invite.epoch !== state.epoch || invite.auth.metaEpoch !== state.epoch || invite.auth.metaSeq > state.seq || invite.issuedAt > at || at >= invite.expiresAt || invite.expiresAt - invite.issuedAt > 86400000 || invite.expiresAt > delegated.expiresAt || invite.expiresAt <= invite.issuedAt || invite.role !== member.role || (invite.joiner && invite.joiner !== member.user) || !Number.isSafeInteger(use) || use < 1 || use > invite.uses)
            return reject('invite_invalid');
        const issueRole = this.roleAt(generation, issuer.user, invite.auth), currentRole = issuer.role;
        const allowed = (role: string | undefined) => role === 'owner' || (role === 'admin' && invite.role === 'member');
        if (!allowed(issueRole) || !allowed(currentRole))
            return reject('forbidden');
        const previous = this.get<{
            user: UserId;
        }>(generation, 'invite', `${invite.invite}/${use}`);
        if (previous)
            return reject('invite_invalid');
        const ordered = this.get<{
            count: number;
        }>(generation, 'inviteCounter', invite.invite)?.count ?? 0;
        if (use !== ordered + 1)
            return reject('invite_invalid');
        return invite;
    }
    private transition(g: string, state: MetaState, record: StoredRecord, envelope: Envelope, history: boolean, mutate: boolean): void {
        const body = envelope.body as any, author = envelope.author.user, identity = this.options.identity;
        if (envelope.author.bot || !author)
            return reject('forbidden');
        if (state.status === 'upgradeRequired')
            return reject('upgrade_required');
        if (state.status === 'blocked')
            return reject('bad_signature');
        if (!isKnownEventType(envelope.type) || envelope.minor > 0)
            return reject('upgrade_required');
        const activation = envelope.type === 'space.descriptor' && record.epoch > state.epoch;
        if (!envelope.auth || envelope.auth.metaEpoch !== state.epoch || envelope.auth.metaSeq > state.seq || (activation && envelope.auth.metaSeq !== state.seq))
            return reject('meta_stale');
        if (!activation && record.epoch !== state.epoch)
            return reject('conflict');
        if (!activation && state.descriptor && JSON.parse(decodeBase64(state.descriptor.payload).toString()).epoch !== record.epoch)
            return reject('conflict');
        if (state.status === 'frozen' && !activation && !(envelope.type === 'space.frozen' && body.reason === state.freezeReason))
            return reject('space_frozen');
        const member = this.get<MemberRecord>(g, 'member', author), role = member?.role, admin = role === 'owner' || role === 'admin';
        const put = (kind: string, id: string, value: unknown) => { if (mutate)
            this.put(g, state, kind, id, value); };
        const change = (user: UserId, value: MemberRecord | null) => { if (mutate)
            this.memberChange(g, state, user, value, record); };
        switch (envelope.type) {
            case 'space.created': {
                if (state.status !== 'absent' || record.epoch !== 1 || record.seq !== 1 || envelope.auth.metaSeq !== 0)
                    return reject('conflict');
                if (body.owner.role !== 'owner' || body.owner.user !== author || identity.pinnedRootKey(author) !== body.owner.rootKey)
                    return reject('forbidden');
                if (body.settings.maxBlobBytes > DEFAULT_MAX_BLOB_BYTES)
                    return reject('too_large');
                const descriptor = this.descriptor(body.descriptor, body.owner.rootKey, record.recvTs, history);
                if (descriptor.space !== state.space || descriptor.owner !== author || descriptor.epoch !== 1)
                    return reject('conflict');
                if (mutate) {
                    state.owner = author;
                    state.descriptor = body.descriptor;
                    state.settings = body.settings;
                    state.status = 'active';
                    change(author, body.owner);
                }
                break;
            }
            case 'space.descriptor': {
                if (role !== 'owner' || !activation || state.status !== 'frozen' || record.seq !== 1)
                    return reject('forbidden');
                const descriptor = this.descriptor(body.descriptor, member!.rootKey, record.recvTs, history);
                if (descriptor.space !== state.space || descriptor.owner !== state.owner || descriptor.epoch !== record.epoch)
                    return reject('conflict');
                if (mutate) {
                    state.descriptor = body.descriptor;
                    state.epoch = descriptor.epoch;
                    state.status = 'active';
                    delete state.freezeReason;
                }
                break;
            }
            case 'space.frozen':
                if (role !== 'owner')
                    return reject('forbidden');
                if (mutate) {
                    state.status = 'frozen';
                    state.freezeReason = body.reason;
                }
                break;
            case 'settings.changed':
                if (!admin)
                    return reject('forbidden');
                if (body.settings.maxBlobBytes > DEFAULT_MAX_BLOB_BYTES)
                    return reject('too_large');
                if (body.settings.minProtoMinor !== undefined && body.settings.minProtoMinor < state.settings!.minProtoMinor)
                    return reject('downgrade_unsupported');
                if (mutate)
                    state.settings = { ...state.settings!, ...body.settings };
                break;
            case 'member.joined': {
                const target = body.member as MemberRecord, existing = this.get<MemberRecord>(g, 'member', target.user), pin = identity.pinnedRootKey(target.user);
                if (target.role === 'owner')
                    return reject('forbidden');
                if (existing && (!equal(existing, target)))
                    return reject('conflict');
                if (pin && pin !== target.rootKey)
                    return reject('conflict');
                if (body.invite !== undefined) {
                    const descriptor = verifyDocument<SpaceDescriptor>(state.descriptor!, this.get<MemberRecord>(g, 'member', state.owner!)!.rootKey, 'spaceDescriptor');
                    if (envelope.author.node !== descriptor.hostNode || author !== descriptor.owner)
                        return reject('forbidden');
                    const invite = this.checkInvite(state.space, body.invite, target, body.inviteUse, record.recvTs, history, g);
                    put('invite', `${invite.invite}/${body.inviteUse}`, { user: target.user, rootKey: target.rootKey });
                    put('inviteCounter', invite.invite, { count: body.inviteUse });
                }
                else if (!(role === 'owner' || (role === 'admin' && target.role === 'member')))
                    return reject('forbidden');
                if (existing)
                    break;
                if (mutate && !history)
                    identity.pinUser(target.user, target.rootKey);
                change(target.user, target);
                break;
            }
            case 'member.left':
            case 'member.removed': {
                const target = this.get<MemberRecord>(g, 'member', body.user);
                if (!target)
                    return reject('bad_request');
                if (target.role === 'owner' || (envelope.type === 'member.left' ? author !== target.user : !(role === 'owner' || (role === 'admin' && target.role === 'member'))))
                    return reject('forbidden');
                // Bot visibility is joined to current owner membership. One member
                // tombstone therefore revokes every owned bot without a 256-row burst.
                change(target.user, null);
                break;
            }
            case 'member.roleChanged': {
                const target = this.get<MemberRecord>(g, 'member', body.user);
                if (!target)
                    return reject('bad_request');
                if (target.role === 'owner' || body.role === 'owner' || !(role === 'owner' || (role === 'admin' && target.user === author && body.role === 'member')))
                    return reject('forbidden');
                change(target.user, { ...target, role: body.role });
                break;
            }
            case 'bot.added': {
                const bot = body.record as BotRecord;
                if (!member || bot.owner !== author || (!admin && !state.settings?.membersMayAddBots) || !BOT_PROFILES.includes(bot.profile) || !isAllowedBotPolicy(bot.profile, bot.policy))
                    return reject('forbidden');
                if (this.activeBot(g, bot.bot))
                    return reject('conflict');
                const delegated = verifyDocument<any>(bot.delegation, member.rootKey, 'botDelegation');
                if (delegated.subject !== bot.bot || delegated.owner !== bot.owner || record.recvTs < delegated.issuedAt || record.recvTs >= delegated.expiresAt)
                    return reject('bad_delegation');
                if (!history) {
                    const rosterSigned = identity.roster(author);
                    if (!rosterSigned)
                        return reject('meta_stale');
                    const roster = verifyDocument<Roster>(rosterSigned, member.rootKey, 'roster');
                    const current = roster.bots.map(s => verifyDocument<any>(s, member.rootKey, 'botDelegation')).filter(d => d.subject === bot.bot).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0];
                    if (identity.rosterState(author) === 'conflict' || !current || !equal(current, delegated) || (roster.revoked.find(r => r.subject === bot.bot)?.throughKeyEpoch ?? 0) >= delegated.keyEpoch)
                        return reject('bad_delegation');
                }
                if (mutate) this.botChange(g,state,bot.bot,bot,record,{epoch:record.epoch,seq:record.seq});
                put('botPosition', bot.bot, { epoch: record.epoch, seq: record.seq });
                break;
            }
            case 'bot.removed':
            case 'bot.policyChanged': {
                const bot = this.activeBot(g, body.bot);
                if (!bot)
                    return reject('bad_request');
                if (envelope.type === 'bot.removed') {
                    if (bot.owner !== author && !admin)
                        return reject('forbidden');
                    if (mutate) this.botChange(g,state,bot.bot,null,record,this.get<StreamHead>(g,'botPosition',bot.bot)!);
                }
                else {
                    if (bot.owner !== author)
                        return reject('forbidden');
                    const next = { ...bot, profile: body.profile ?? bot.profile, policy: body.policy ?? bot.policy };
                    if (!BOT_PROFILES.includes(next.profile) || !isAllowedBotPolicy(next.profile, next.policy))
                        return reject('forbidden');
                    const delegated = verifyDocument<any>(bot.delegation, member!.rootKey, 'botDelegation');
                    if (record.recvTs < delegated.issuedAt || record.recvTs >= delegated.expiresAt)
                        return reject('bad_delegation');
                    if (!history) {
                        const rosterSigned = identity.roster(author);
                        if (!rosterSigned)
                            return reject('meta_stale');
                        const roster = verifyDocument<Roster>(rosterSigned, member!.rootKey, 'roster'), current = roster.bots.map(s => verifyDocument<any>(s, member!.rootKey, 'botDelegation')).filter(d => d.subject === bot.bot).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0];
                        if (!current || !equal(current, delegated) || (roster.revoked.find(r => r.subject === bot.bot)?.throughKeyEpoch ?? 0) >= delegated.keyEpoch)
                            return reject('bad_delegation');
                    }
                    if (mutate) this.botChange(g,state,bot.bot,next,record,this.get<StreamHead>(g,'botPosition',bot.bot)!);
                }
                break;
            }
            case 'channel.created': {
                if (!admin)
                    return reject('forbidden');
                if (this.get(g, 'channel', body.stream))
                    return reject('conflict');
                const stream = this.options.store.getStream(body.stream), descriptor = JSON.parse(decodeBase64(state.descriptor!.payload).toString()) as SpaceDescriptor;
                if (stream && (stream.kind !== 'space.channel' || stream.space !== state.space || stream.authority !== descriptor.hostNode) || !stream && !history)
                    return reject('conflict');
                put('channel', body.stream, { stream: body.stream, name: body.name, archived: false });
                break;
            }
            case 'channel.renamed':
            case 'channel.archived': {
                if (!admin)
                    return reject('forbidden');
                const channel = this.get<Channel>(g, 'channel', body.stream);
                if (!channel || (envelope.type === 'channel.renamed' && channel.archived))
                    return reject('bad_request');
                put('channel', body.stream, envelope.type === 'channel.archived' ? { ...channel, archived: true } : { ...channel, name: body.name });
                break;
            }
            default: return reject('forbidden');
        }
    }
    validate(space: SpaceId, record: StoredRecord, purpose: 'newWork' | 'history' = 'newWork'): void { const g = this.generation(space); if (!g)
        return reject('stream_unknown'); const state = this.stateFor(g), { envelope } = decodeEnvelope(record.envelope); this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, record.recvTs, purpose); this.transition(g, state, record, envelope, purpose === 'history', false); }
    /** Called inside the same transaction as authority append / replica apply. */
    applyRecord(stream: StreamDescriptor, record: StoredRecord, purpose: 'newWork' | 'history' = 'history'): MetaState {
        return this.options.db.transaction(() => {
            let g = this.generation(stream.space!);
            if (!g) {
                const created = this.newGeneration(stream);
                g = created.generation;
                this.options.db.charge(1);
                this.options.db.database.prepare('INSERT INTO net_space_meta_active VALUES(?,?)').run(stream.space!, g);
            }
            return this.applyTo(g, record, purpose === 'history');
        });
    }
    private applyTo(g: string, record: StoredRecord, history: boolean): MetaState {
        const state = this.stateFor(g);
        if (state.status === 'upgradeRequired' || state.status === 'blocked')
            return state;
        if (record.epoch === state.epoch && record.seq <= state.seq)
            return state;
        if (record.epoch === state.epoch ? record.seq !== state.seq + 1 : record.epoch <= state.epoch || record.seq !== 1)
            return reject('snapshot_required');
        const { envelope } = decodeEnvelope(record.envelope);
        if (envelope.stream !== state.stream)
            return reject('bad_request');
        try {
            this.verifyAuthor(g, envelope, record, history);
        }
        catch (error) {
            if (!history)
                throw error;
            state.status = 'blocked';state.blockedCode=error instanceof NetError?error.code:'bad_signature';
            this.save(g, state);
            return state;
        }
        try {
            this.transition(g, state, record, envelope, history, true);
        }
        catch (error) {
            if (!history)
                throw error;
            if (!(error instanceof NetError))
                throw error;
            if (error.code === 'upgrade_required') {
                state.status = 'upgradeRequired';
                this.save(g, state);
                return state;
            }
            this.options.db.charge(1);
            this.options.db.database.prepare('INSERT INTO net_space_meta_violations VALUES(?,?,?,?,?)').run(g, state.space, record.epoch, record.seq, error.code);
        }
        state.epoch = record.epoch;
        state.seq = record.seq;
        this.save(g, state);
        this.options.db.checkpoint('spaces.meta.beforeCommit');
        return state;
    }
    private verifyAuthor(g: string, envelope: Envelope, record: StoredRecord, history: boolean): void {
        if (!history) {
            this.options.identity.verifyAuthor(envelope.author, record.envelope, record.sig, record.recvTs, 'newWork');
            return;
        }
        const author = envelope.author;
        if (!author.user) {
            this.options.identity.verifyAuthor(author, record.envelope, record.sig, record.recvTs, 'history');
            return;
        }
        const row = this.options.db.database.prepare('SELECT value FROM net_space_meta_roles WHERE generation=? AND user=? AND value IS NOT NULL ORDER BY epoch DESC,seq DESC LIMIT 1').get(g, author.user), member = row ? JSON.parse(row.value as string) as MemberRecord : undefined;
        const root = member?.rootKey ?? this.options.identity.pinnedRootKey(author.user);
        if (!root)
            return reject('meta_stale');
        const evidence = this.options.historyRoster?.(author, record.recvTs, root);
        if (!evidence) {
            this.options.identity.verifyAuthor(author, record.envelope, record.sig, record.recvTs, 'history');
            return;
        }
        const roster = verifyDocument<Roster>(evidence, root, 'roster');
        if (roster.owner !== author.user || roster.rootKey !== root)
            return reject('bad_delegation');
        const delegated = roster.nodes.map(s => verifyDocument<NodeDelegation>(s, root, 'nodeDelegation')).filter(d => d.subject === author.node && d.owner === author.user && d.keyEpoch === author.keyEpoch && d.issuedAt <= record.recvTs && record.recvTs < d.expiresAt).sort((a, b) => b.issuedAt - a.issuedAt)[0];
        if (!delegated || delegated.expiresAt - delegated.issuedAt > 7 * 86400000)
            return reject('bad_delegation');
        verifyBytes(record.envelope, record.sig, delegated.keys.sign);
    }
    append(records: readonly StoredRecord[], descriptor: StreamDescriptor, _target: StreamHead, carry: unknown): unknown {
        if (records.length > this.maxRecordsPerAppend)
            return reject('too_large');
        const token = carry as Generation | null, g = token ?? this.newGeneration(descriptor);
        if (g.space !== descriptor.space || g.stream !== descriptor.id || !this.options.db.database.prepare('SELECT generation FROM net_space_meta_state WHERE generation=? AND space_id=? AND stream=?').get(g.generation, g.space, g.stream))
            return reject('conflict');
        for (const record of records) {
            const state = this.applyTo(g.generation, record, true);
            if (state.status === 'blocked')
                return reject(state.blockedCode??'bad_signature');
            if (state.status === 'upgradeRequired')
                return reject('upgrade_required');
        }
        return g;
    }
    finish(carry: unknown, descriptor: StreamDescriptor, target: StreamHead): void {
        const g = carry as Generation;
        if (!g || g.space !== descriptor.space || g.stream !== descriptor.id)
            return reject('conflict');
        const state = this.stateFor(g.generation);
        if (state.status === 'absent' || state.status === 'blocked' || state.status === 'upgradeRequired' || state.epoch !== target.epoch || state.seq !== target.seq)
            return reject('forbidden');
        const rows = this.options.db.database.prepare('SELECT user FROM net_space_meta_roles WHERE generation=? AND value IS NOT NULL GROUP BY user LIMIT 257').all(g.generation);
        if (rows.length > 256)
            return reject('too_large');
        const roots = rows.map(row => { const member = JSON.parse(this.options.db.database.prepare('SELECT value FROM net_space_meta_roles WHERE generation=? AND user=? AND value IS NOT NULL ORDER BY epoch DESC,seq DESC LIMIT 1').get(g.generation, row.user!)!.value as string) as MemberRecord; return { user: member.user, rootKey: member.rootKey }; });
        if (this.options.activatePins)
            this.options.activatePins(roots);
        else
            for (const root of roots)
                if (this.options.identity.pinnedRootKey(root.user) !== root.rootKey)
                    return reject('meta_stale');
        this.options.db.charge(1);
        this.options.db.database.prepare('INSERT INTO net_space_meta_active VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET generation=excluded.generation').run(state.space, g.generation);
    }
}

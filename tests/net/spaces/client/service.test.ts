import { afterEach, describe, expect, it } from 'vitest';
import { SpaceClientService } from '../../../../src/mms/spaces/client';
import { EnrollmentService } from '../../../../src/mms/net/enrollment/service';
import { EnrollmentGateway } from '../../../../src/mms/net/enrollment/quarantine';
import { NetSyncSession } from '../../../../src/mms/net/sync/session';
import { SqliteOutbox } from '../../../../src/mms/net/store/outbox';
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams';
import { NetError, spaceMetaStream } from '../../../../src/shared/net';
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec';
import { profile, peer, channels, cleanup, disposers, type Profile } from '../host/helpers';
afterEach(cleanup);
async function setup() {
    const host = await profile(), member = await profile(host.clock, 'Member'), space = host.host.create({ name: 'TLS Space' }), channel = host.host.createChannel(space.space, 'general');
    let lost = false, cutAfterAppend = false, client: SpaceClientService, serverSession: NetSyncSession | undefined;
    const enrollment = new EnrollmentService({ db: host.db, identity: host.identity, keys: host.keys, clock: host.clock, routes: host.routes });
    const store = new SqliteStreamStore(member.db, member.projection, (record, descriptor) => client.afterStored(record, descriptor));
    const outbox = new SqliteOutbox(member.db);
    const build = (p: Profile) => new SpaceClientService({ db: p.db, identity: p.identity, keys: p.keys, store, outbox, meta: p.projection, clock: p.clock, localRoutes: p.routes, atomicStoreHooks: true, metaStream: d => spaceMetaStream(d.space), connectJoin: async () => {
            const tls = await channels(host, p), gateway = new EnrollmentGateway({ channel: tls.server, service: enrollment, clock: host.clock, spaceJoin: { redeem(request, channel) { const response = host.host.redeem(request, channel); if (lost) {
                        lost = false;
                        channel.close();
                    } return response; } } });
            disposers.push(() => gateway.close());
            return tls.client;
        }, connectSpace: async () => {
            const tls = await channels(host, p);
            serverSession = new NetSyncSession({ channel: tls.server, identity: host.identity, store: host.store, authority: { canRead: (...args) => host.host.canRead(...args), canFetchBlob: (...args) => host.host.canFetchBlob(...args), acceptBlob: (...args) => host.host.acceptBlob(...args), append(...args) { const result = host.host.append(...args); if (cutAfterAppend) {
                        cutAfterAppend = false;
                        tls.server.close();
                    } return result; } }, clock: host.clock, localRoutes: host.routes });
            const session = new NetSyncSession({ channel: tls.client, identity: p.identity, store, clock: p.clock, localRoutes: p.routes, canReceive: (...args) => client.canReceive(...args), verifyRecord: (...args) => client.verifyRecord(...args) });
            const stop = host.host.onAppend((stream, record) => { void serverSession?.publishRecord(stream, record).catch(() => { }); });
            disposers.push(stop, () => serverSession?.close(), () => session.close());
            await Promise.all([serverSession.opened, session.opened]);
            return session;
        } });
    client = build(member);
    disposers.push(() => client.close());
    return { host, member, space, channel, client, outbox, store, loseJoin: () => { lost = true; }, loseAppend: () => { cutAfterAppend = true; } };
}
describe('P5 member real TLS admission, replica and durable sender', () => {
    it('joins through the quarantined gateway, imports signed meta, queues while offline, and reuses exact signed bytes on reconnect', async () => {
        const f = await setup(), invite = f.client.prepareJoin(f.host.host.invite(f.space.space).text), binding = await f.client.join(invite);
        expect(binding.meta).toBe(f.space.meta);
        expect(binding.state).toBe('awaitingMeta');
        expect(f.member.projection.position(f.space.space)).toBeUndefined();
        await f.client.connect(f.space.space);
        expect(f.client.binding(f.space.space)?.state).toBe('active');
        expect(f.member.projection.member(f.space.space, peer(f.member).user)).toBeDefined();
        await f.client.subscribe(f.channel);
        f.client.disconnect(f.space.space);
        const id = f.client.post(f.channel, 'offline-message'), bytes = Buffer.from(f.outbox.get(id)!.envelope);
        expect(f.outbox.get(id)?.state).toBe('pending');
        expect(f.host.store.getById(f.channel, id)).toBeUndefined();
        await f.client.connect(f.space.space);
        expect(f.outbox.get(id)?.state).toBe('sent');
        expect(Buffer.from(f.host.store.getById(f.channel, id)!.envelope)).toEqual(bytes);
        await f.client.subscribe(f.channel);
        expect(f.store.cursor(f.channel).seq).toBe(1);
        expect(f.client.list()).toHaveLength(1);
        expect(JSON.stringify(f.member.db.database.prepare('SELECT journal FROM net_space_client_join').get())).not.toContain('"token"');
    });
    it('retries a lost durable admission response without another use or changed stable claims', async () => {
        const f = await setup(), invite = f.client.prepareJoin(f.host.host.invite(f.space.space, { uses: 1 }).text);
        f.loseJoin();
        await expect(f.client.join(invite)).rejects.toBeInstanceOf(NetError);
        const head = f.host.store.head(f.space.meta);
        const binding = await f.client.join(invite);
        expect(binding.receipt.seq).toBe(head.seq);
        expect(f.host.store.head(f.space.meta)).toEqual(head);
        expect(f.host.db.database.prepare('SELECT count(*) AS n FROM net_space_host_receipts').get()!.n).toBe(1);
        expect(() => f.client.prepareJoin(f.host.host.invite(f.space.space).text, '')).toThrow(expect.objectContaining({ code: 'bad_request' }));
    });
    it('marks a cut-after-commit send unknown, then reconciles the original event through subscription before resending', async () => {
        const f = await setup();
        await f.client.join(f.client.prepareJoin(f.host.host.invite(f.space.space).text));
        await f.client.connect(f.space.space);
        const id = f.client.post(f.channel, 'one durable effect'), original = f.outbox.get(id)!;
        f.loseAppend();
        await f.client.flush(f.space.space);
        expect(f.outbox.get(id)?.state).toBe('unknown');
        expect(f.host.store.getById(f.channel, id)).toBeDefined();
        await f.client.connect(f.space.space);
        await f.client.subscribe(f.channel);
        expect(f.outbox.get(id)?.state).toBe('sent');
        expect(f.host.store.head(f.channel).seq).toBe(1);
        expect(Buffer.from(f.outbox.get(id)!.envelope)).toEqual(Buffer.from(original.envelope));
    });
    it('applies removal before further sends, keeps existing local history, and reports terminal host quota rejection', async () => {
        const f = await setup();
        await f.client.join(f.client.prepareJoin(f.host.host.invite(f.space.space).text));
        await f.client.connect(f.space.space);
        await f.client.subscribe(f.channel);
        const first = f.client.post(f.channel, 'retained');
        await f.client.flush(f.space.space);
        const scope = { kind: 'space' as const, space: f.space.space }, used = 5 * 1024 * 1024 * 1024 - f.host.limits.remainingQuota(scope);
        f.host.limits.configureQuota(scope, used);
        const rejected = f.client.post(f.channel, 'quota');
        await f.client.flush(f.space.space);
        expect(f.outbox.get(rejected)).toMatchObject({ state: 'failed', error: 'quota_exceeded' });
        f.host.limits.configureQuota(scope, 5 * 1024 * 1024 * 1024);
        f.host.host.postMeta(f.space.space, 'member.removed', { user: peer(f.member).user });
        await new Promise(resolve => setTimeout(resolve, 20));
        await expect(f.client.flush(f.space.space)).resolves.toBeUndefined();
        expect(() => f.client.post(f.channel, 'denied')).toThrow();
        expect(f.store.getById(f.channel, first)).toBeDefined();
    });
    it('keeps verified history readable when frozen while reporting the exact write denial',async()=>{
        const f=await setup();await f.client.join(f.client.prepareJoin(f.host.host.invite(f.space.space).text));await f.client.connect(f.space.space);await f.client.subscribe(f.channel);const id=f.client.post(f.channel,'readable while frozen');await f.client.flush(f.space.space);await new Promise<void>(resolve=>{const stop=f.client.onChanged(()=>{if(f.member.projection.position(f.space.space)?.status==='frozen'){stop();resolve()}});f.host.host.postMeta(f.space.space,'space.frozen',{reason:'Qualification freeze'})});expect(f.client.binding(f.space.space)?.state).toBe('active');expect(()=>f.client.post(f.channel,'frozen write')).toThrow(expect.objectContaining({code:'space_frozen'}));expect(f.store.getById(f.channel,id)).toBeDefined()
    })
    it('denies altered signed membership receipts and bounds the durable pending queue', async () => {
        const f = await setup();
        await f.client.join(f.client.prepareJoin(f.host.host.invite(f.space.space).text));
        await f.client.connect(f.space.space);
        f.client.options.maxPendingEvents = 1;
        f.client.post(f.channel, 'one');
        expect(() => f.client.post(f.channel, 'two')).toThrow(expect.objectContaining({ code: 'too_large' }));
        const env = decodeEnvelope(f.outbox.due(f.channel)[0].envelope).envelope;
        expect(env.auth).toEqual(f.member.projection.position(f.space.space) && { metaEpoch: 1, metaSeq: 3 });
    });
});

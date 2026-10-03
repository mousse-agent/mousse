import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { openSecureChannel } from '../../../../src/mms/net/link/secureChannel';
import { fingerprint } from '../../../../src/mms/net/link/selfSignedCert';
import { createMux } from '../../../../src/mms/net/link/mux';
import { EnrollmentService } from '../../../../src/mms/net/enrollment';
import { parseSpaceInvite, spaceJoinRequest } from '../../../../src/mms/spaces/host';
import { systemClock } from '../../../../src/mms/net/clock';
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec';
import { profile, cleanup, disposers, peer, trust } from './helpers';
afterEach(cleanup);
describe('actual TCP TLS host process kill and recovery', () => {
    for (const mode of ['before', 'after'])
        it(`SIGKILL ${mode} authority commit preserves atomic admission and exact retry`, async () => {
            const a = await profile(systemClock as any), b = await profile(systemClock as any, 'Member'), space = a.host.create({ name: 'Process' }), invite = parseSpaceInvite(a.host.invite(space.space).text), executable = join(a.path, 'space-crash-child.cjs');
            buildSync({ entryPoints: [fileURLToPath(new URL('./crash-child.ts', import.meta.url))], outfile: executable, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' });
            a.store.close();
            a.db.close();
            async function child(childMode: string) {
                const processChild = spawn(process.execPath, [executable, a.path, childMode], { stdio: ['ignore', 'pipe', 'pipe'] }), exit = once(processChild, 'exit');
                disposers.push(async () => { processChild.kill('SIGKILL'); await exit; });
                let timer: ReturnType<typeof setTimeout> | undefined;
                const [chunk] = await Promise.race([once(processChild.stdout!, 'data'), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Space authority did not listen.')), 4000); })]).finally(() => { if (timer)
                    clearTimeout(timer); });
                return { processChild, exit, port: JSON.parse(chunk.toString()).port as number };
            }
            async function attempt(port: number) {
                const raw = connect(port, '127.0.0.1');
                await once(raw, 'connect');
                const channel = await openSecureChannel(raw, { role: 'client', credentials: b.keys.tlsCredentials(), expectedPeerFingerprint: fingerprint(Buffer.from(invite.descriptor.hostTransportKey, 'base64url')), deadlineMs: 3000 }), mux = createMux(channel.stream);
                disposers.push(() => mux.close(), () => channel.close());
                const enrollment = new EnrollmentService({ db: b.db, identity: b.identity, keys: b.keys, clock: systemClock, routes: b.routes }), request = spaceJoinRequest(invite, b.identity, channel, 'Member');
                let sent = false;
                const result = new Promise<any>((resolve, reject) => { mux.onClose(error => { reject(error ?? new Error('Connection closed.')); }); mux.onMessage((_lane, message) => { if (message.header.t === 'helloAck' && !sent) {
                    sent = true;
                    void mux.send('control', { header: { t: 'helloAck', protoMinor: 0, caps: ['enroll.v1'], now: systemClock.now() }, parts: [] }).then(() => mux.send('control', { header: request, parts: [] })).catch(reject);
                }
                else if (message.header.t === 'space.join.result')
                    resolve(message); }); });
                const hello = { ...enrollment.localHello(), caps: ['enroll.v1'] };
                await mux.send('control', { header: hello, parts: [] });
                return Promise.race([result, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Admission timed out.')), 3500))]);
            }
            const first = await child(mode);
            await expect(attempt(first.port)).rejects.toThrow();
            const [code, signal] = await first.exit;
            expect(code).toBeNull();
            expect(signal).toBe('SIGKILL');
            let reopened = await profile(systemClock as any, 'Owner', a.path);
            expect(reopened.store.head(space.meta).seq).toBe(mode === 'after' ? 2 : 1);
            expect(!!reopened.projection.member(space.space, peer(b).user)).toBe(mode === 'after');
            expect(!!reopened.identity.pinnedRootKey(peer(b).user)).toBe(mode === 'after');
            reopened.store.close();
            reopened.db.close();
            const healthy = await child('healthy'), receipt = await attempt(healthy.port);
            expect(receipt.header).toMatchObject({ t: 'space.join.result', member: { epoch: 1, seq: 2 } });
            expect(decodeEnvelope(receipt.parts[0]).envelope.body).toMatchObject({ member: { user: peer(b).user }, inviteUse: 1 });
            healthy.processChild.kill('SIGKILL');
            await healthy.exit;
            reopened = await profile(systemClock as any, 'Owner', a.path);
            expect(reopened.store.head(space.meta).seq).toBe(2);
            expect(reopened.db.database.prepare('SELECT count(*) AS n FROM net_space_host_receipts').get()!.n).toBe(1);
        }, 15000);
    for (const mode of ['snapshot-before', 'snapshot-after'])
        it(`SIGKILL ${mode} activates signed projection and stream cursor together`, async () => {
            const source = await profile(systemClock as any), replica = await profile(systemClock as any, 'Replica'), space = source.host.create({ name: 'Snapshot' });
            trust(replica, source);
            source.host.postMeta(space.space, 'settings.changed', { settings: { name: 'Activated' } });
            const descriptor = source.store.getStream(space.meta)!, target = source.store.head(space.meta), reader = source.store.openSnapshot(space.meta), records = reader.next(1024 * 1024, 64).records;
            reader.close();
            replica.store.createStream(descriptor, 1);
            const executable = join(replica.path, 'snapshot-crash-child.cjs'), input = join(replica.path, 'snapshot-input.json');
            buildSync({ entryPoints: [fileURLToPath(new URL('./crash-child.ts', import.meta.url))], outfile: executable, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' });
            writeFileSync(input, JSON.stringify({ descriptor, target, records: records.map(r => ({ ...r, envelope: Buffer.from(r.envelope).toString('base64url'), sig: Buffer.from(r.sig).toString('base64url') })) }));
            replica.store.close();
            replica.db.close();
            const processChild = spawn(process.execPath, [executable, replica.path, mode, input], { stdio: ['ignore', 'pipe', 'pipe'] }), exit = once(processChild, 'exit');
            disposers.push(async () => { processChild.kill('SIGKILL'); await exit; });
            const [code, signal] = await exit;
            expect(code).toBeNull();
            expect(signal).toBe('SIGKILL');
            const reopened = await profile(systemClock as any, 'Replica', replica.path);
            expect(reopened.store.cursor(space.meta).seq).toBe(mode === 'snapshot-after' ? 2 : 0);
            expect(reopened.projection.state(space.space)?.settings.name).toBe(mode === 'snapshot-after' ? 'Activated' : undefined);
            expect(reopened.db.database.prepare("SELECT count(*) AS n FROM net_generations WHERE state='staging'").get()!.n).toBe(0);
            expect(reopened.db.database.prepare('SELECT count(*) AS n FROM net_space_meta_state').get()!.n).toBe(mode === 'snapshot-after' ? 1 : 0);
        }, 10000);
});

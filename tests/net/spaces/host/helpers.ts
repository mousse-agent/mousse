import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileKeyStore, NetIdentityService } from '../../../../src/mms/net/identity';
import { NetDatabase } from '../../../../src/mms/net/store/database';
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams';
import { SqliteQuotaRateLedger } from '../../../../src/mms/net/store/limits';
import { FileBlobStore } from '../../../../src/mms/net/store/blobs';
import { MetaProjection, SpaceHostService } from '../../../../src/mms/spaces/host';
import { openSecureChannel } from '../../../../src/mms/net/link/secureChannel';
import { fingerprint } from '../../../../src/mms/net/link/selfSignedCert';
import { memoryPair } from '../../harness/MemoryTransport';
import { FakeClock } from '../../harness/FakeClock';
import type { RoutesRecord, Roster, NodeDelegation, Envelope, StreamId } from '../../../../src/shared/net';
import { newId } from '../../../../src/shared/net';
import { canonicalJson } from '../../../../src/mms/net/sync/codec';
export const disposers: Array<() => void | Promise<void>> = [];
export async function profile(clock = new FakeClock(1700000000000), name = 'Owner', directory?: string, fault?: (point: string) => void) {
    const path = directory ?? realpathSync(mkdtempSync(join(tmpdir(), 'mousse-space-host-')));
    if (!directory)
        disposers.push(() => rmSync(path, { recursive: true, force: true }));
    const db = new NetDatabase({ profileDir: path, clock, fault });
    disposers.push(() => db.close());
    const keys = new FileKeyStore(path, { passphrase: 'space-host-test-master' });
    const identity = new NetIdentityService({ database: db.database, keys, clock, coordinator: db });
    if (!directory)
        await identity.bootstrapAuthority(name);
    else
        await keys.unlock('space-host-test-master');
    let projection: MetaProjection;
    const store = new SqliteStreamStore(db, { maxRecordsPerAppend: 64, append: (...args) => projection.append(...args), finish: (...args) => projection.finish(...args) });
    disposers.push(() => store.close());
    projection = new MetaProjection({ db, identity, store, activatePins: roots => identity.pinUsers(roots) });
    const limits = new SqliteQuotaRateLedger(db), blobs = new FileBlobStore(db);
    const routes = () => identity.signAsNode({ v: 1, node: identity.self()!.node, version: 1, issuedAt: clock.now(), routes: [{ transport: 'direct', address: '127.0.0.1:4000', priority: 1 }] } satisfies RoutesRecord);
    const host = new SpaceHostService({ db, keys, identity, store, projection, limits, blobs, routes, clock });
    return { path, db, keys, identity, store, projection, limits, blobs, routes, host, clock };
}
export type Profile = Awaited<ReturnType<typeof profile>>;
export function peer(p: Profile) { const self = p.identity.self()!, root = p.identity.pinnedRootKey(self.user)!, roster = p.identity.verifySigned<Roster>(p.identity.roster()!, root); const delegation = roster.nodes.map(s => p.identity.verifySigned<NodeDelegation>(s, root)).filter(d => d.subject === self.node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]; return { user: self.user, node: self.node, delegation }; }
export function trust(a: Profile, b: Profile) { const user = b.identity.self()!.user, root = b.identity.pinnedRootKey(user)!; a.identity.pinUser(user, root); a.identity.acceptRoster(b.identity.roster()!, root); }
export function signed(p: Profile, stream: StreamId, type: string, body: unknown, auth: Envelope['auth'], extra: Partial<Envelope> = {}) { const me = peer(p), envelope: Envelope = { v: 1, minor: 0, id: newId('event'), stream, type, crit: false, author: { user: me.user, node: me.node, keyEpoch: me.delegation.keyEpoch }, ts: p.clock.now(), auth, body, ...extra }; const bytes = canonicalJson(envelope); return { id: envelope.id, envelope: bytes, sig: p.keys.signAsNode(bytes), recvTs: p.clock.now() }; }
export async function channels(a: Profile, b: Profile) { const pair = memoryPair(); disposers.push(() => pair.cut()); const [server, client] = await Promise.all([openSecureChannel(pair.b, { role: 'server', credentials: a.keys.tlsCredentials(), deadlineMs: 2000 }), openSecureChannel(pair.a, { role: 'client', credentials: b.keys.tlsCredentials(), expectedPeerFingerprint: fingerprint(Buffer.from(a.keys.nodeKeys().transport, 'base64url')), deadlineMs: 2000 })]); disposers.push(() => server.close(), () => client.close()); return { server, client, pair }; }
export async function cleanup() { for (const fn of disposers.splice(0).reverse())
    await fn(); }

/**
 * A computer's network database tidies the copies it keeps of its other computers' display streams once the service
 * has started: records no read reaches (here an archived generation a received snapshot replaced) go, and what a
 * read reaches stays. Real profile services, Net service and Bridge, restarted over the same profile.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { MmsProfileServices } from '../../../../src/mms/MmsProfileServices'
import { MousseConfigStore } from '../../../../src/mms/config/MousseConfigStore'
import { ProviderAuthService } from '../../../../src/mms/providers/ProviderAuthService'
import { DomainHandlerRegistry } from '../../../../src/mms/protocol/domainRegistry'
import { NetService } from '../../../../src/mms/net/NetService'
import { BridgeProfileService } from '../../../../src/mms/bridge/BridgeProfileService'
import { canonicalJson, encodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { FileKeyStore } from '../../../../src/mms/net/identity'
import {
  newId,
  type NodeId,
  type StoredRecord,
  type StreamDescriptor
} from '../../../../src/shared/net'

// Read once, the first time a limit is needed: the tidy runs as soon as the Bridge has started.
process.env.MOUSSE_NET_COPY_SWEEP_DELAY_MS = '0'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function profile() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'copy-tidy-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const services = new MmsProfileServices(
    MousseConfigStore.load(home),
    { homeDir: home, repoRoot: home, headless: true, requireOwnership: false },
    null,
    home,
    {
      providerAuth: auth,
      domains: new DomainHandlerRegistry(),
      installationHome: home,
      profileId: randomUUID(),
      allowLegacyProjectData: false
    }
  )
  cleanup.push(() => services.stop())
  const start = () => {
    const net: NetService = new NetService({
      profileDir: home,
      composeRuntime: (runtime) =>
        new BridgeProfileService({ services, runtime, net }).composition()
    })
    cleanup.push(() => net.shutdown())
    return net
  }
  return { home, start }
}

it('tidies what no read reaches once the service has started again, and keeps what a read reaches', async () => {
  const { start } = profile()
  let net = start()
  await net.request('net.init', { name: 'desk', listen: false })
  const { user } = net.runtime().identity.self()!
  const store = net.runtime().streams

  // The copy of another computer's thread: three records, then a snapshot of three more that replaced them.
  const other = newId('node')
  const descriptor: StreamDescriptor = {
    id: newId('stream'),
    kind: 'node.thread',
    authority: other,
    createdAt: 1
  }
  store.createStream(descriptor, 1)
  const record = (seq: number): StoredRecord => ({
    epoch: 1,
    seq,
    recvTs: 1,
    envelope: encodeEnvelope({
      v: 1,
      minor: 0,
      id: newId('event'),
      stream: descriptor.id,
      type: 'thread.event',
      crit: false,
      author: { user, node: other, keyEpoch: 1 },
      ts: 1,
      body: { threadId: 't', type: 'queue.updated', data: {} }
    }),
    sig: new Uint8Array(64).fill(1)
  })
  store.applyFromAuthority(descriptor.id, [record(1), record(2), record(3)])
  store.installSnapshot(descriptor.id, 1, 6, [record(4), record(5), record(6)])
  const db = () => {
    const runtime = net.runtime()
    return {
      generations: runtime.db.database
        .prepare('SELECT state FROM net_generations WHERE stream=? ORDER BY state')
        .all(descriptor.id)
        .map((row) => row.state),
      held: runtime.db.database
        .prepare(
          'SELECT r.seq FROM net_records r JOIN net_streams s ON s.active_generation=r.generation WHERE s.id=? ORDER BY r.seq'
        )
        .all(descriptor.id)
        .map((row) => row.seq)
    }
  }
  expect(db()).toEqual({ generations: ['active', 'archived'], held: [4, 5, 6] })
  await net.shutdown()

  net = start()
  await vi.waitFor(() => expect(db().generations).toEqual(['active']), { timeout: 15_000 })
  expect(db().held).toEqual([4, 5, 6])
}, 60_000)

it("trims the copy of another computer's lists to its newest snapshot after a start, though it is never opened", async () => {
  const { home, start } = profile()
  let net = start()
  await net.request('net.init', { name: 'desk', listen: false })
  const { user } = net.runtime().identity.self()!
  // Another computer of the same user, in the roster, which signs its lists.
  const otherKeys = new FileKeyStore(realpathSync(mkdtempSync(join(home, 'other-'))))
  await otherKeys.initialize({ asAuthority: false })
  const other = newId('node') as NodeId
  net
    .runtime()
    .identity.issueNodeDelegation({
      node: other,
      keys: otherKeys.nodeKeys(),
      name: 'laptop',
      caps: ['read']
    })
  const descriptor: StreamDescriptor = {
    id: newId('stream'),
    kind: 'node.thread',
    authority: other,
    createdAt: 1
  }
  const store = net.runtime().streams
  store.createStream(descriptor, 1)
  let seq = 0
  const signed = (type: string, body: unknown): StoredRecord => {
    const envelope = encodeEnvelope({
      v: 1,
      minor: 0,
      id: newId('event'),
      stream: descriptor.id,
      type,
      crit: false,
      author: { user, node: other, keyEpoch: 1 },
      ts: Date.now(),
      body
    })
    return {
      epoch: 1,
      seq: ++seq,
      recvTs: Date.now(),
      envelope,
      sig: otherKeys.signAsNode(envelope)
    }
  }
  // Each change of its lists is a whole snapshot (begin, chunk, end), as that computer publishes them.
  const snapshot = (n: number): StoredRecord[] => {
    const bytes = canonicalJson({
        kind: 'mousse.lists',
        version: 1,
        n,
        threads: [{ id: `t${n}` }],
        projects: []
      }),
      id = randomUUID(),
      sha256 = createHash('sha256').update(bytes).digest('base64url'),
      threadId = 'mousse:lists'
    return [
      signed('thread.snapshot.begin', {
        threadId,
        snapshot: id,
        totalBytes: bytes.length,
        chunks: 1,
        sha256
      }),
      signed('thread.snapshot.chunk', {
        threadId,
        snapshot: id,
        index: 0,
        data: Buffer.from(bytes).toString('base64url')
      }),
      signed('thread.snapshot.end', { threadId, snapshot: id, sha256 })
    ]
  }
  for (let n = 1; n <= 40; n++) store.applyFromAuthority(descriptor.id, snapshot(n))
  // Earlier builds cut copies part-way through a snapshot: this one starts at the chunk of its first.
  net.runtime().db.database.prepare('DELETE FROM net_records WHERE seq=1').run()
  // The copy was attached once: the Bridge remembers it, and has not opened it since.
  net
    .runtime()
    .db.database.prepare('INSERT INTO net_bridge_hub_threads VALUES(?,?,?)')
    .run(other, 'private:mousse:lists', JSON.stringify(descriptor))
  const held = () =>
    net
      .runtime()
      .db.database.prepare(
        'SELECT r.seq FROM net_records r JOIN net_streams s ON s.active_generation=r.generation WHERE s.id=? ORDER BY r.seq'
      )
      .all(descriptor.id)
      .map((row) => row.seq)
  expect(held()).toHaveLength(119)
  await net.shutdown()

  net = start()
  await vi.waitFor(() => expect(held()).toEqual([118, 119, 120]), { timeout: 15_000 })
}, 60_000)

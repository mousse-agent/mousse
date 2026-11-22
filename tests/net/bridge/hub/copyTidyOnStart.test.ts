/**
 * A computer's network database tidies the copies it keeps of its other computers' display streams once the service
 * has started: records no read reaches (here an archived generation a received snapshot replaced) go, and what a
 * read reaches stays. Real profile services, Net service and Bridge, restarted over the same profile.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
import { encodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { newId, type StoredRecord, type StreamDescriptor } from '../../../../src/shared/net'

// Read once, the first time a limit is needed: the tidy runs as soon as the Bridge has started.
process.env.MOUSSE_NET_COPY_SWEEP_DELAY_MS = '0'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('tidies what no read reaches once the service has started again, and keeps what a read reaches', async () => {
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

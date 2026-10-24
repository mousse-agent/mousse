import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { signedDocument } from '../../../src/mms/net/identity/crypto'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { MetaProjection } from '../../../src/mms/spaces/host/meta'
import { SqliteStreamStore } from '../../../src/mms/net/store/streams'
import { FakeClock } from '../harness/FakeClock'
import {
  newId,
  type NodeId,
  type RoutesRecord,
  type Signed,
  type SpaceDescriptor
} from '../../../src/shared/net'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function keyStore(directory: string, authority: boolean) {
  const keys = new FileKeyStore(directory, { passphrase: 'host-descriptor-secret' })
  await keys.initialize({ asAuthority: authority })
  return keys
}

/** An owner whose second device hosts a Space, with the owner's roster as the only live evidence. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mousse-host-descriptor-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const clock = new FakeClock(),
    db = new NetDatabase({ profileDir: directory, clock })
  cleanup.push(() => db.close())
  const keys = await keyStore(directory, true),
    identity = new NetIdentityService({ database: db.database, keys, clock, coordinator: db })
  await identity.bootstrapAuthority('Owner computer')
  const owner = identity.self()!.user,
    root = keys.rootKey()!,
    host = newId('node') as NodeId
  const rekey = async (): Promise<Awaited<ReturnType<typeof keyStore>>> => {
    const hostKeys = await keyStore(await mkdtemp(join(tmpdir(), 'mousse-host-keys-')), false)
    identity.issueNodeDelegation({
      node: host,
      keys: hostKeys.nodeKeys(),
      name: 'Host',
      caps: ['read', 'write']
    })
    return hostKeys
  }
  const hostKeys = await rekey(),
    issuedAt = clock.now()
  const routes = signedDocument(
    {
      v: 1,
      node: host,
      version: 1,
      issuedAt,
      routes: [{ transport: 'plus-relay', address: 'wss://relay.example/v1', priority: 30 }]
    } satisfies RoutesRecord,
    (bytes) => hostKeys.signAsNode(bytes)
  )
  const descriptor: Signed = signedDocument(
    {
      v: 1,
      space: newId('space'),
      owner,
      hostNode: host,
      hostTransportKey: hostKeys.nodeKeys().transport,
      routes,
      epoch: 1,
      issuedAt
    } satisfies SpaceDescriptor,
    (bytes) => keys.signAsRoot(bytes)
  )
  const meta = new MetaProjection({ db, identity, store: new SqliteStreamStore(db) })
  return { clock, identity, root, host, rekey, descriptor, meta, issuedAt }
}

it('rejects a Space descriptor as revoked once its host delegation is dropped from the live roster', async () => {
  const f = await fixture()
  expect(f.meta.descriptor(f.descriptor, f.root, f.clock.now(), false)).toMatchObject({
    hostNode: f.host
  })
  f.identity.revoke(f.host)
  expect(() => f.meta.descriptor(f.descriptor, f.root, f.clock.now(), false)).toThrow(
    expect.objectContaining({ code: 'revoked' })
  )
}, 60_000)

it('still verifies the original descriptor from retained rosters after the host re-keys past 64 epochs', async () => {
  const f = await fixture()
  f.clock.advance(1)
  for (let index = 0; index < 66; index++) await f.rekey()
  // The live roster holds only epoch 67; epoch 1 survives in the retained history.
  expect(f.meta.descriptor(f.descriptor, f.root, f.issuedAt, true)).toMatchObject({
    hostNode: f.host
  })
  f.identity.revoke(f.host)
  expect(f.meta.descriptor(f.descriptor, f.root, f.issuedAt, true)).toMatchObject({
    hostNode: f.host
  })
  expect(() => f.meta.descriptor(f.descriptor, f.root, f.clock.now(), true)).toThrow(
    expect.objectContaining({ code: 'bad_delegation' })
  )
}, 120_000)

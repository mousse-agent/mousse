import { afterEach, expect, it, vi } from 'vitest'
import { SpaceClientService } from '../../../../src/mms/spaces/client'
import { SqliteOutbox } from '../../../../src/mms/net/store/outbox'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { spaceMetaStream } from '../../../../src/shared/net'
import { channels, cleanup, disposers, profile } from '../host/helpers'

afterEach(cleanup)

async function withheldHello() {
  const host = await profile(),
    member = await profile(host.clock, 'Member'),
    space = host.host.create({ name: 'Join deadline' })
  let client: SpaceClientService
  const store = new SqliteStreamStore(member.db, member.projection, (record, descriptor) =>
    client.afterStored(record, descriptor)
  )
  disposers.push(() => store.close())
  client = new SpaceClientService({
    db: member.db,
    identity: member.identity,
    keys: member.keys,
    store,
    outbox: new SqliteOutbox(member.db),
    meta: member.projection,
    clock: member.clock,
    localRoutes: member.routes,
    atomicStoreHooks: true,
    metaStream: (descriptor) => spaceMetaStream(descriptor.space),
    // Complete actual TLS, then withhold the enrollment hello. No invitation
    // claims reach the authority and no durable membership receipt is issued.
    connectJoin: async () => {
      const tls = await channels(host, member)
      return tls.client
    },
    connectSpace: async () => {
      throw Error('No Space link expected before admission')
    }
  })
  disposers.push(() => client.close())
  const invite = client.prepareJoin(host.host.invite(space.space).text)
  return { host, member, space, client, invite, store }
}

it('reports deadline_exceeded when the join handshake timer expires over actual TLS', async () => {
  const f = await withheldHello(),
    before = f.member.clock.pending(),
    result = f.client.join(f.invite).catch((error) => error)
  await vi.waitFor(() => expect(f.member.clock.pending()).toBeGreaterThan(before))
  f.member.clock.advance(10000)
  expect(await result).toMatchObject({ code: 'deadline_exceeded' })
  expect(f.client.binding(f.space.space)).toBeUndefined()
  expect(
    f.host.db.database.prepare('SELECT count(*) AS n FROM net_space_host_receipts').get()!.n
  ).toBe(0)
  expect(f.member.clock.pending()).toBe(before)
})

it('preserves cancelled for an actual caller abort without a membership receipt or later timeout effect', async () => {
  const f = await withheldHello(),
    controller = new AbortController(),
    before = f.member.clock.pending(),
    result = f.client.join(f.invite, controller.signal).catch((error) => error)
  await vi.waitFor(() => expect(f.member.clock.pending()).toBeGreaterThan(before))
  controller.abort()
  expect(await result).toMatchObject({ code: 'cancelled' })
  expect(f.member.clock.pending()).toBe(before)
  f.member.clock.advance(10000)
  expect(f.client.binding(f.space.space)).toBeUndefined()
  expect(
    f.host.db.database.prepare('SELECT count(*) AS n FROM net_space_host_receipts').get()!.n
  ).toBe(0)
})

import { afterEach, expect, it } from 'vitest'
import { BotRecordAuthorization } from '../../../../src/mms/bots/admission'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { canonicalJson, decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { newId, type Envelope, type StreamDescriptor } from '../../../../src/shared/net'
import { SpaceHostService } from '../../../../src/mms/spaces/host'
import { setup } from '../../bots/admission/helpers'
import { channels, cleanup, disposers, peer, signed } from './helpers'

afterEach(cleanup)
it('publishes the original owner-host public acceptance on its locally prepared thread through real TLS', async () => {
  const f = await setup(),
    admitted = f.service.admit(f.message()).record,
    entry = f.outbox.list(admitted.binding!.stream)[0]
  let authority!: SpaceHostService
  const gate = new BotRecordAuthorization({
    identity: f.p.identity,
    meta: f.p.projection,
    store: f.p.store,
    binding: (space, execution) => authority.executionBinding(space, execution)
  })
  authority = new SpaceHostService({
    ...f.p.host.options,
    botAuthorization: gate,
    outbox: f.outbox
  })
  const tls = await channels(f.p, f.p),
    server = new NetSyncSession({
      channel: tls.server,
      identity: f.p.identity,
      store: f.p.store,
      authority,
      clock: f.p.clock
    }),
    client = new NetSyncSession({
      channel: tls.client,
      identity: f.p.identity,
      store: f.p.store,
      clock: f.p.clock
    })
  disposers.push(
    () => server.close(),
    () => client.close()
  )
  await Promise.all([server.opened, client.opened])
  expect(f.p.store.head(entry.stream).seq).toBe(0)
  const substitute = { ...decodeEnvelope(entry.envelope).envelope, id: newId('event') },
    bytes = canonicalJson(substitute)
  await expect(
    client.append(entry.stream, substitute.id, bytes, f.p.keys.signAsBot(f.bot, bytes))
  ).rejects.toMatchObject({ code: 'forbidden' })
  expect(authority.threadBinding(entry.stream)).toBeUndefined()
  expect(f.p.store.head(entry.stream).seq).toBe(0)
  expect(await client.append(entry.stream, entry.id, entry.envelope, entry.sig)).toMatchObject({
    epoch: 1,
    seq: 1
  })
  expect(authority.threadBinding(entry.stream)?.execution).toBe(admitted.id)
  const opening = f.p.store
    .read(f.parent, { epoch: 1, seq: 1 }, 2, 65536)
    .records.map((record) => decodeEnvelope(record.envelope).envelope)
  expect(opening).toHaveLength(1)
  expect(opening[0].type).toBe('thread.opened')
  expect(await client.append(entry.stream, entry.id, entry.envelope, entry.sig)).toMatchObject({
    epoch: 1,
    seq: 1
  })
})
it('bounds public ancestry and refuses cycles, private parents and cross-space parents', async () => {
  const f = await setup(),
    me = peer(f.p),
    channel = f.p.store.getStream(f.parent)!
  function thread(id = newId('stream'), parent = f.parent, space = f.space.space) {
    const descriptor: StreamDescriptor = {
      id,
      kind: 'space.thread',
      space,
      parent,
      authority: me.node,
      createdAt: f.p.clock.now()
    }
    f.p.store.createStream(descriptor, 1)
    return descriptor
  }
  const first = thread(),
    second = thread(newId('stream'), first.id)
  expect(f.p.projection.canRead(f.space.space, second, me.user)).toBe(true)
  const a = newId('stream'),
    b = newId('stream'),
    cycle = thread(a, b)
  thread(b, a)
  expect(f.p.projection.canRead(f.space.space, cycle, me.user)).toBe(false)
  const other = f.p.host.create({ name: 'Other space' }),
    otherChannel = f.p.host.createChannel(other.space, 'general')
  expect(
    f.p.projection.canRead(f.space.space, thread(newId('stream'), otherChannel), me.user)
  ).toBe(false)
  const privateId = newId('stream')
  f.p.store.createStream(
    {
      id: privateId,
      kind: 'space.private',
      space: f.space.space,
      parent: f.parent,
      authority: me.node,
      participants: [me.user],
      createdAt: f.p.clock.now()
    },
    1
  )
  expect(f.p.projection.canRead(f.space.space, thread(newId('stream'), privateId), me.user)).toBe(
    false
  )
  let deep = channel
  for (let i = 0; i < 33; i++) deep = thread(newId('stream'), deep.id)
  expect(f.p.projection.canRead(f.space.space, deep, me.user)).toBe(false)
})
it('registers a public reply to a real human mention on an existing bot work thread', async () => {
  const f = await setup(),
    first = f.service.admit(f.message()).record,
    original = f.outbox.list(first.binding!.stream)[0]
  let authority!: SpaceHostService
  const gate = new BotRecordAuthorization({
    identity: f.p.identity,
    meta: f.p.projection,
    store: f.p.store,
    binding: (space, execution) => authority.executionBinding(space, execution)
  })
  authority = new SpaceHostService({
    ...f.p.host.options,
    botAuthorization: gate,
    outbox: f.outbox
  })
  const tls = await channels(f.p, f.p),
    server = new NetSyncSession({
      channel: tls.server,
      identity: f.p.identity,
      store: f.p.store,
      authority,
      clock: f.p.clock
    }),
    client = new NetSyncSession({
      channel: tls.client,
      identity: f.p.identity,
      store: f.p.store,
      clock: f.p.clock
    })
  disposers.push(
    () => server.close(),
    () => client.close()
  )
  await Promise.all([server.opened, client.opened])
  await client.append(original.stream, original.id, original.envelope, original.sig)
  const meta = f.p.projection.position(f.space.space)!,
    auth = { metaEpoch: meta.epoch, metaSeq: meta.seq }
  const human = signed(f.p, original.stream, 'message.posted', { text: 'Please continue' }, auth, {
    refs: {
      execution: first.id,
      replyTo: first.trigger as Envelope['id'],
      thread: original.stream,
      mentions: [f.bot]
    }
  })
  expect(await client.append(original.stream, human.id, human.envelope, human.sig)).toMatchObject({
    seq: 2
  })
  const child = newId('stream'),
    execution = newId('execution'),
    accepted: Envelope = {
      v: 1,
      minor: 0,
      id: newId('event'),
      stream: child,
      type: 'bot.run.accepted',
      crit: false,
      author: { bot: f.bot, node: peer(f.p).node, keyEpoch: 1 },
      ts: f.p.clock.now(),
      auth,
      refs: { execution, subject: human.id, replyTo: human.id, thread: child },
      body: { title: 'Continued bot run' }
    },
    bytes = canonicalJson(accepted)
  expect(
    await client.append(child, accepted.id, bytes, f.p.keys.signAsBot(f.bot, bytes))
  ).toMatchObject({ epoch: 1, seq: 1 })
  expect(authority.threadBinding(child)).toMatchObject({
    parent: original.stream,
    trigger: human.id,
    execution
  })
  expect(authority.canRead(child, peer(f.p))).toBe(true)
  expect(f.p.projection.canRead(f.space.space, f.p.store.getStream(child)!, peer(f.p).user)).toBe(
    true
  )
  const opening = f.p.store.read(original.stream, { epoch: 1, seq: 2 }, 3, 65536).records[0]
  expect(decodeEnvelope(opening.envelope).envelope).toMatchObject({
    type: 'thread.opened',
    refs: { replyTo: human.id },
    body: { stream: child, private: false }
  })
})

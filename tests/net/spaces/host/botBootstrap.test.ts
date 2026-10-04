import { afterEach, expect, it } from 'vitest'
import { BotRecordAuthorization } from '../../../../src/mms/bots/admission'
import { SpaceHostService } from '../../../../src/mms/spaces/host'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { canonicalJson } from '../../../../src/mms/net/sync/codec'
import { newId, type Envelope, type StreamDescriptor } from '../../../../src/shared/net'
import { profile, peer, trust, signed, channels, cleanup, disposers } from './helpers'
afterEach(cleanup)
it('registers an independently signed accepted output atomically over TLS and rejects forged or second bindings', async () => {
  let rollback = false
  const host = await profile(undefined, 'Owner', undefined, (point) => {
      if (rollback && point === 'spaces.bot.bootstrap.beforeCommit')
        throw new Error('Injected receipt rollback')
    }),
    owner = await profile(host.clock, 'Bot owner'),
    space = host.host.create({ name: 'Public bot output' }),
    parent = host.host.createChannel(space.space, 'general')
  trust(host, owner)
  trust(owner, host)
  host.host.postMeta(space.space, 'member.joined', {
    member: {
      user: peer(owner).user,
      rootKey: owner.keys.rootKey()!,
      role: 'member',
      displayName: 'Bot owner'
    }
  })
  const bot = newId('bot'),
    key = owner.keys.createBotKey(bot),
    delegation = owner.identity.issueBotDelegation({
      bot,
      key,
      name: 'Bot',
      hostNode: peer(owner).node
    })
  host.identity.acceptRoster(owner.identity.roster()!, owner.keys.rootKey()!)
  const meta = host.projection.position(space.space)!,
    added = signed(
      owner,
      space.meta,
      'bot.added',
      {
        record: {
          bot,
          owner: peer(owner).user,
          delegation,
          displayName: 'Bot',
          profile: 'chat',
          policy: { steer: { kind: 'everyone' }, visibility: 'public' }
        }
      },
      { metaEpoch: meta.epoch, metaSeq: meta.seq }
    )
  host.host.append(space.meta, added.id, added.envelope, added.sig, peer(owner))
  const trigger = host.host.post(parent, 'real indexed mention', { mentions: [bot] }),
    triggerRecord = host.store.read(parent, { epoch: 1, seq: 0 }, trigger.seq, 1024 * 1024)
      .records[0]
  const triggerId = JSON.parse(Buffer.from(triggerRecord.envelope).toString()).id,
    output = newId('stream'),
    execution = newId('execution')
  const descriptor: StreamDescriptor = {
    id: output,
    kind: 'space.thread',
    space: space.space,
    parent,
    authority: peer(host).node,
    createdAt: host.clock.now()
  }
  owner.store.createStream(descriptor, 1)
  const gate = new BotRecordAuthorization({
    identity: host.identity,
    meta: host.projection,
    store: host.store,
    binding: () => undefined
  })
  const authority = new SpaceHostService({ ...host.host.options, botAuthorization: gate })
  const tls = await channels(host, owner),
    server = new NetSyncSession({
      channel: tls.server,
      identity: host.identity,
      store: host.store,
      authority,
      clock: host.clock
    }),
    client = new NetSyncSession({
      channel: tls.client,
      identity: owner.identity,
      store: owner.store,
      clock: owner.clock
    })
  disposers.push(
    () => server.close(),
    () => client.close()
  )
  await Promise.all([server.opened, client.opened])
  const position = host.projection.position(space.space)!,
    envelope: Envelope = {
      v: 1,
      minor: 0,
      id: newId('event'),
      stream: output,
      type: 'bot.run.accepted',
      crit: false,
      author: { bot, node: peer(owner).node, keyEpoch: 1 },
      ts: host.clock.now(),
      auth: { metaEpoch: position.epoch, metaSeq: position.seq },
      refs: { execution, subject: triggerId, replyTo: triggerId, thread: output },
      body: { title: 'Bot run' }
    }
  const bytes = canonicalJson(envelope),
    signature = owner.keys.signAsBot(bot, bytes),
    bad = new Uint8Array(signature)
  bad[0] ^= 1
  expect(
    gate.canRegisterAccepted(descriptor, { envelope: bytes, sig: signature }, peer(owner))
  ).toBe(true)
  await expect(client.append(output, envelope.id, bytes, bad)).rejects.toMatchObject({
    code: 'bad_signature'
  })
  expect(host.store.getStream(output)).toBeUndefined()
  rollback = true
  await expect(client.append(output, envelope.id, bytes, signature)).rejects.toMatchObject({
    code: 'internal'
  })
  expect(host.store.getStream(output)).toBeUndefined()
  expect(authority.threadBinding(output)).toBeUndefined()
  expect(host.store.head(parent).seq).toBe(1)
  rollback = false
  expect(await client.append(output, envelope.id, bytes, signature)).toMatchObject({
    epoch: 1,
    seq: 1
  })
  expect(authority.threadBinding(output)).toEqual({
    space: space.space,
    stream: output,
    parent,
    bot,
    trigger: triggerId,
    execution
  })
  expect(host.store.getStream(output)).toEqual(descriptor)
  expect(
    await client.append(output, envelope.id, bytes, signature).catch((error) => {
      throw new Error('Duplicate accepted: ' + error.code)
    })
  ).toMatchObject({ epoch: 1, seq: 1 })
  const second = { ...envelope, id: newId('event'), stream: newId('stream') }
  second.refs = { ...envelope.refs, thread: second.stream, execution: newId('execution') }
  const secondBytes = canonicalJson(second)
  await expect(
    client.append(second.stream, second.id, secondBytes, owner.keys.signAsBot(bot, secondBytes))
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(host.store.getStream(second.stream)).toBeUndefined()
  expect(host.store.head(output).seq).toBe(1)
})

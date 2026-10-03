import { afterEach, expect, it } from 'vitest'
import { BotPresenceReceiver } from '../../../../src/mms/bots/presence'
import { canonicalJson } from '../../../../src/mms/net/sync/codec'
import { newId, type PresenceMessage } from '../../../../src/shared/net'
import { profile, peer, trust, signed, cleanup } from '../../spaces/host/helpers'
afterEach(cleanup)
it('accepts independently bot-signed presence through only the exact current authority relay, retaining counter and revocation fences', async () => {
  const host = await profile(),
    owner = await profile(host.clock, 'Bot owner'),
    reader = await profile(host.clock, 'Reader'),
    space = host.host.create({ name: 'Presence relay' }),
    channel = host.host.createChannel(space.space, 'general'),
    bot = newId('bot')
  for (const member of [owner, reader]) {
    trust(host, member)
    host.host.postMeta(space.space, 'member.joined', {
      member: {
        user: peer(member).user,
        rootKey: member.keys.rootKey()!,
        role: 'member',
        displayName: peer(member).delegation.name
      }
    })
  }
  host.host.postMeta(space.space, 'settings.changed', { settings: { membersMayAddBots: true } })
  const key = owner.keys.createBotKey(bot),
    delegation = owner.identity.issueBotDelegation({
      bot,
      key,
      name: 'Relayed bot',
      hostNode: peer(owner).node
    })
  trust(host, owner)
  const at = host.projection.position(space.space)!,
    added = signed(
      owner,
      space.meta,
      'bot.added',
      {
        record: {
          bot,
          owner: peer(owner).user,
          delegation,
          displayName: 'Relayed bot',
          profile: 'chat',
          policy: { visibility: 'public', steer: { kind: 'everyone' } }
        }
      },
      { metaEpoch: at.epoch, metaSeq: at.seq }
    )
  host.host.append(space.meta, added.id, added.envelope, added.sig, peer(owner))
  for (const p of [host, owner]) trust(reader, p)
  reader.store.createStream(host.store.getStream(space.meta)!, 1)
  const source = host.store.openSnapshot(space.meta),
    stage = reader.store.beginSnapshot(space.meta, source.target)
  stage.append(source.next(1024 * 1024, 64).records)
  source.close()
  stage.commit()
  reader.store.createStream(host.store.getStream(channel)!, 1)
  let offsetMs = 0,
    measuredAtMonotonic = reader.clock.monotonic(),
    unavailable = false,
    rttMs = 20,
    wallDeltaMs = 0
  const requested: Array<[string, string]> = []
  const receiver = new BotPresenceReceiver({
    db: reader.db,
    identity: reader.identity,
    meta: reader.projection,
    store: reader.store,
    subjectClockEstimate: (_space, user, node) => {
      requested.push([user, node])
      return unavailable ? undefined : { offsetMs, rttMs, wallDeltaMs, measuredAtMonotonic }
    }
  })
  function message(counter: number, timestamp = host.clock.now()): PresenceMessage {
    const unsigned = {
      t: 'presence' as const,
      stream: channel,
      subject: bot,
      counter,
      ts: timestamp,
      state: 'workingPrivate' as const
    }
    return {
      ...unsigned,
      sig: Buffer.from(owner.keys.signAsBot(bot, canonicalJson(unsigned))).toString('base64url')
    }
  }
  expect(receiver.receive(message(1), peer(owner))).toBe(true)
  const relayed = message(2)
  expect(receiver.receive(relayed, peer(host))).toBe(true)
  expect(receiver.receive(relayed, peer(host))).toBe(false)
  expect(receiver.view(channel, bot).state).toBe('workingPrivate')
  const third = message(3)
  expect(receiver.receive(third, peer(reader))).toBe(false)
  const wrongTransport = {
    ...peer(host),
    delegation: {
      ...peer(host).delegation,
      keys: { ...peer(host).delegation.keys, transport: reader.keys.nodeKeys().transport }
    }
  }
  expect(receiver.receive(third, wrongTransport)).toBe(false)
  const other = host.identity.issueNodeDelegation({
    node: peer(reader).node,
    keys: reader.keys.nodeKeys(),
    name: 'Other owner node',
    caps: ['read']
  })
  trust(reader, host)
  const ownerRoot = host.keys.rootKey()!,
    otherPeer = {
      user: peer(host).user,
      node: peer(reader).node,
      delegation: host.identity.verifySigned<import('../../../../src/shared/net').NodeDelegation>(
        other,
        ownerRoot
      )
    }
  expect(receiver.receive(third, otherPeer)).toBe(false)
  expect(receiver.receive({ ...third, state: 'working' }, peer(host))).toBe(false)
  expect(receiver.receive(third, peer(host))).toBe(true)
  expect(new BotPresenceReceiver(receiver.options).receive(third, peer(host))).toBe(false)
  // The same qualified signing-node evidence works for direct and relayed packets.
  reader.clock.advance(180000)
  let counter = 3
  for (const skew of [-120000, 120000]) {
    for (const source of [peer(owner), peer(host)]) {
      offsetMs = skew
      measuredAtMonotonic = reader.clock.monotonic()
      expect(receiver.receive(message(++counter, reader.clock.now() + offsetMs), source)).toBe(true)
      expect(requested.at(-1)).toEqual([peer(owner).user, peer(owner).node])
    }
  }
  unavailable = true
  expect(receiver.receive(message(8), peer(owner))).toBe(false)
  expect(receiver.receive(message(8), peer(host))).toBe(false)
  unavailable = false
  offsetMs = 0
  measuredAtMonotonic = reader.clock.monotonic() - 30001
  expect(receiver.receive(message(8), peer(host))).toBe(false)
  measuredAtMonotonic = reader.clock.monotonic()
  for (const badRtt of [-1, 5001]) {
    rttMs = badRtt
    expect(receiver.receive(message(8), peer(host))).toBe(false)
  }
  rttMs = 20
  wallDeltaMs = 1001
  expect(receiver.receive(message(8), peer(host))).toBe(false)
  wallDeltaMs = 0
  measuredAtMonotonic = reader.clock.monotonic() + 1
  expect(receiver.receive(message(8), peer(owner))).toBe(false)
  measuredAtMonotonic = reader.clock.monotonic()
  offsetMs = NaN
  expect(receiver.receive(message(8), peer(host))).toBe(false)
  offsetMs = 0
  const withheld = message(8)
  reader.clock.advance(75000)
  measuredAtMonotonic = reader.clock.monotonic()
  expect(receiver.receive(withheld, peer(host))).toBe(false)
  expect(receiver.view(channel, bot).state).toBe('reconnecting')
  expect(receiver.receive(message(8), peer(host))).toBe(true)
  owner.identity.revoke(bot)
  trust(reader, owner)
  expect(receiver.receive(message(9), peer(host))).toBe(false)
  expect(receiver.view(channel, bot).state).toBe('offline')
})

import { afterEach, expect, it } from 'vitest'
import { newId, type BotRecord } from '../../../../src/shared/net'
import { profile, peer, trust, signed, cleanup } from '../../spaces/host/helpers'
afterEach(cleanup)
it('retains validated bot policy, removal and new delegation history across a real full-meta snapshot', async () => {
  const host = await profile(),
    owner = await profile(host.clock, 'Bot member'),
    reader = await profile(host.clock, 'History reader'),
    space = host.host.create({ name: 'Bot history' }),
    bot = newId('bot'),
    user = peer(owner).user
  trust(host, owner)
  host.host.postMeta(space.space, 'settings.changed', { settings: { membersMayAddBots: true } })
  const member = {
    user,
    rootKey: owner.keys.rootKey()!,
    role: 'member' as const,
    displayName: 'Bot member'
  }
  host.host.postMeta(space.space, 'member.joined', { member })
  const key = owner.keys.createBotKey(bot),
    delegation = owner.identity.issueBotDelegation({
      bot,
      key,
      name: 'Historical bot',
      hostNode: peer(owner).node
    })
  trust(host, owner)
  function post(type: string, body: unknown) {
    const at = host.projection.position(space.space)!,
      event = signed(owner, space.meta, type, body, { metaEpoch: at.epoch, metaSeq: at.seq }),
      outcome = host.host.append(space.meta, event.id, event.envelope, event.sig, peer(owner))
    return { metaEpoch: outcome.epoch, metaSeq: outcome.seq }
  }
  const record: BotRecord = {
      bot,
      owner: user,
      delegation,
      displayName: 'Bot',
      profile: 'chat',
      policy: { visibility: 'public', steer: { kind: 'everyone' } }
    },
    added = post('bot.added', { record }),
    changed = post('bot.policyChanged', {
      bot,
      policy: { visibility: 'public', steer: { kind: 'owner' } }
    })
  expect(host.projection.canSteerAt(space.space, bot, peer(host).user, added)).toBe(true)
  expect(host.projection.canSteerAt(space.space, bot, peer(host).user, changed)).toBe(false)
  expect(host.projection.canSteerAt(space.space, bot, user, changed)).toBe(true)
  const removal = host.host.postMeta(space.space, 'member.removed', { user }),
    removed = { metaEpoch: removal.epoch, metaSeq: removal.seq }
  host.host.postMeta(space.space, 'member.joined', { member })
  const rejoined = host.projection.position(space.space)!,
    afterRejoin = { metaEpoch: rejoined.epoch, metaSeq: rejoined.seq }
  expect(host.projection.botAt(space.space, bot, added)?.delegation).toEqual(delegation)
  expect(host.projection.botAt(space.space, bot, removed)).toBeUndefined()
  expect(host.projection.botAt(space.space, bot, afterRejoin)).toBeUndefined()
  const successor = owner.identity.issueBotDelegation({
    bot,
    key,
    name: 'Historical bot moved',
    hostNode: peer(owner).node
  })
  trust(host, owner)
  const readopted = post('bot.added', { record: { ...record, delegation: successor } }),
    deleted = post('bot.removed', { bot })
  expect(host.projection.botAt(space.space, bot, readopted)?.delegation).toEqual(successor)
  expect(host.projection.botAt(space.space, bot, deleted)).toBeUndefined()
  for (const p of [host, owner]) trust(reader, p)
  reader.store.createStream(host.store.getStream(space.meta)!, 1)
  const source = host.store.openSnapshot(space.meta),
    stage = reader.store.beginSnapshot(space.meta, source.target),
    records = source.next(1024 * 1024, 64).records
  source.close()
  stage.append(records)
  expect(reader.projection.botAt(space.space, bot, added)).toBeUndefined()
  stage.commit()
  expect(reader.projection.botAt(space.space, bot, added)?.delegation).toEqual(delegation)
  expect(reader.projection.botAt(space.space, bot, changed)?.policy.steer.kind).toBe('owner')
  expect(reader.projection.canSteerAt(space.space, bot, peer(host).user, added)).toBe(true)
  expect(reader.projection.canSteerAt(space.space, bot, peer(host).user, changed)).toBe(false)
  expect(reader.projection.botAt(space.space, bot, removed)).toBeUndefined()
  expect(reader.projection.botAt(space.space, bot, afterRejoin)).toBeUndefined()
  expect(reader.projection.botAt(space.space, bot, readopted)?.delegation).toEqual(successor)
  expect(reader.projection.botAt(space.space, bot, deleted)).toBeUndefined()
  expect(
    reader.projection.botAt(space.space, bot, {
      metaEpoch: deleted.metaEpoch,
      metaSeq: deleted.metaSeq + 1
    })
  ).toBeUndefined()
})

it('rebuilds pre-upgrade missing bot history only from retained signed meta evidence', async () => {
  const p = await profile(),
    space = p.host.create({ name: 'Upgrade history' }),
    bot = newId('bot'),
    key = p.keys.createBotKey(bot),
    delegation = p.identity.issueBotDelegation({
      bot,
      key,
      name: 'Upgrade bot',
      hostNode: peer(p).node
    })
  p.host.postMeta(space.space, 'bot.added', {
    record: {
      bot,
      owner: peer(p).user,
      delegation,
      displayName: 'Upgrade bot',
      profile: 'chat',
      policy: { visibility: 'public', steer: { kind: 'everyone' } }
    }
  })
  const at = p.projection.position(space.space)!,
    auth = { metaEpoch: at.epoch, metaSeq: at.seq }
  // Simulate an existing active pre-upgrade projection: current entities exist, new normalized evidence does not.
  p.db.transaction(() => p.db.database.exec('DELETE FROM net_space_meta_bot_history'))
  expect(p.projection.bot(space.space, bot)).toBeDefined()
  expect(p.projection.botAt(space.space, bot, auth)).toBeUndefined()
  expect(() => p.db.transaction(() => p.projection.rebuildBotHistory(space.space))).toThrow(
    expect.objectContaining({ code: 'bad_request' })
  )
  p.projection.rebuildBotHistory(space.space)
  expect(p.projection.botAt(space.space, bot, auth)?.delegation).toEqual(delegation)
  expect(p.store.cursor(space.meta)).toMatchObject({ epoch: auth.metaEpoch, seq: auth.metaSeq })
})

import { afterEach, expect, it, vi } from 'vitest'
import {
  BotRecordAuthorization,
  BotAdmissionService,
  BotOutbox
} from '../../../../src/mms/bots/admission'
import { SqliteBotRegistry } from '../../../../src/mms/bots/registry'
import { SqliteCompartmentStore } from '../../../../src/mms/bots/compartments'
import { SpaceHostService } from '../../../../src/mms/spaces/host'
import { SpaceClientService } from '../../../../src/mms/spaces/client'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { EnrollmentService, EnrollmentGateway } from '../../../../src/mms/net/enrollment'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { SqliteOutbox } from '../../../../src/mms/net/store/outbox'
import { SqliteExecutionLedger } from '../../../../src/mms/net/store/executions'
import { SqliteBudgetLedger } from '../../../../src/mms/net/store/budgets'
import { canonicalJson, decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { NetError, newId, spaceMetaStream } from '../../../../src/shared/net'
import { channels, cleanup, disposers, peer, profile } from '../../spaces/host/helpers'
import { setup } from './helpers'
import { RosterEvidence } from '../../../../src/mms/spaces/RosterEvidence'
import type { Roster, Signed, UserId } from '../../../../src/shared/net'
afterEach(cleanup)
it('flushes and replicates an actual expired admission from a separately joined bot owner through the guarded Space client', async () => {
  const host = await profile(),
    owner = await profile(host.clock, 'Independent bot owner'),
    bot = newId('bot'),
    key = owner.keys.createBotKey(bot),
    delegation = owner.identity.issueBotDelegation({
      bot,
      key,
      name: 'Fixture bot',
      hostNode: peer(owner).node
    }),
    space = host.host.create({ name: 'Expired wire' }),
    channel = host.host.createChannel(space.space, 'general')
  let consumer: SpaceClientService,
    server: NetSyncSession | undefined,
    remote: NetSyncSession | undefined
  const replica = new SqliteStreamStore(owner.db, owner.projection, (record, descriptor) =>
      consumer.afterStored(record, descriptor)
    ),
    outbox = new SqliteOutbox(owner.db),
    hostGate = new BotRecordAuthorization({
      identity: host.identity,
      meta: host.projection,
      store: host.store,
      binding: () => undefined
    }),
    authority = new SpaceHostService({ ...host.host.options, botAuthorization: hostGate }),
    enrollment = new EnrollmentService({
      db: host.db,
      identity: host.identity,
      keys: host.keys,
      clock: host.clock,
      routes: host.routes
    })
  const rosterEvidence = new RosterEvidence(owner.db)
  const ownRosterBeforeRelay = owner.identity.roster()
  const retainRosterEvidence = (signed: Signed, remote: { user: UserId; node: string }) => {
    if (remote.user !== peer(host).user || remote.node !== peer(host).node)
      throw new NetError('forbidden')
    const claimed = JSON.parse(Buffer.from(signed.payload, 'base64url').toString()) as Roster
    if (![peer(host).user, peer(owner).user].includes(claimed.owner))
      throw new NetError('forbidden')
    const root = owner.identity.pinnedRootKey(claimed.owner)
    if (!root || claimed.rootKey !== root) throw new NetError('bad_delegation')
    owner.identity.verifySigned<Roster>(signed, root)
    rosterEvidence.retain(signed)
  }
  const evidence = new Map<string, NonNullable<ReturnType<typeof owner.projection.state>>>()
  const ownerGate = new BotRecordAuthorization({
    identity: owner.identity,
    meta: owner.projection,
    store: replica,
    binding: () => undefined,
    historicalBot: (space, bot, auth) => {
      const value = evidence.get(`${auth.metaEpoch}/${auth.metaSeq}`)?.bots.get(bot)
      return (
        value && {
          owner: value.owner,
          hostNode: value.delegation.hostNode,
          keyEpoch: value.delegation.keyEpoch
        }
      )
    },
    historicalMember: (space, user, auth) => !!owner.projection.memberAt(space, user, auth),
    historicalCanSteer: (space, bot, user, auth) => {
      const state = evidence.get(`${auth.metaEpoch}/${auth.metaSeq}`)
      return !!state?.members.has(user) && state.bots.get(bot)?.policy.steer.kind === 'everyone'
    }
  })
  consumer = new SpaceClientService({
    db: owner.db,
    identity: owner.identity,
    keys: owner.keys,
    store: replica,
    outbox,
    meta: owner.projection,
    clock: owner.clock,
    localRoutes: owner.routes,
    metaStream: (d) => spaceMetaStream(d.space),
    atomicStoreHooks: true,
    verifyBotRecord: (record, descriptor) => ownerGate.verifyHistory(record, descriptor),
    canWriteBotRecord: (...args) => ownerGate.canWrite(...args),
    connectJoin: async () => {
      const tls = await channels(host, owner),
        gateway = new EnrollmentGateway({
          channel: tls.server,
          service: enrollment,
          clock: host.clock,
          spaceJoin: authority
        })
      disposers.push(() => gateway.close())
      return tls.client
    },
    connectSpace: async () => {
      const tls = await channels(host, owner)
      server = new NetSyncSession({
        channel: tls.server,
        identity: host.identity,
        store: host.store,
        authority,
        clock: host.clock
      })
      remote = new NetSyncSession({
        channel: tls.client,
        identity: owner.identity,
        store: replica,
        clock: owner.clock,
        retainRosterEvidence,
        canReceive: (...args) => consumer.canReceive(...args),
        verifyRecord: (...args) => consumer.verifyRecord(...args)
      })
      const current = server,
        stop = authority.onAppend((stream, record) => {
          void current.publishRecord(stream, record).catch(() => {})
        })
      disposers.push(
        stop,
        () => current.close(),
        () => remote?.close()
      )
      await Promise.all([current.opened, remote.opened])
      return remote
    }
  })
  disposers.push(
    () => consumer.close(),
    () => replica.close()
  )
  await consumer.join(consumer.prepareJoin(authority.invite(space.space).text))
  await consumer.connect(space.space)
  const added = consumer.queue(space.meta, 'bot.added', {
    record: {
      bot,
      owner: peer(owner).user,
      delegation,
      displayName: 'Fixture',
      profile: 'chat',
      policy: { steer: { kind: 'everyone' }, visibility: 'public' }
    }
  })
  await consumer.flush(space.space)
  expect(outbox.get(added)?.state).toBe('sent')
  await vi.waitFor(() => expect(owner.projection.bot(space.space, bot)).toBeDefined())
  await consumer.subscribe(channel)
  const budgets = new SqliteBudgetLedger(owner.db),
    executions = new SqliteExecutionLedger(owner.db),
    compartments = new SqliteCompartmentStore(owner.db, 'joined-owner'),
    registry = new SqliteBotRegistry({
      db: owner.db,
      identity: owner.identity,
      keys: owner.keys,
      meta: owner.projection,
      budgets,
      adapters: new Map([
        [
          'fixture',
          {
            id: 'fixture',
            supports: (profile) => profile === 'chat',
            run: async () => {
              throw Error('Expired admission started a model')
            }
          }
        ]
      ])
    }),
    config = {
      space: space.space,
      bot,
      adapter: 'fixture',
      profile: 'chat' as const,
      definitionRevision: 'v1',
      profileDigest: Buffer.alloc(32, 1).toString('base64url'),
      dailyBudgetUnits: 1000,
      runCeilingUnits: 60,
      maxConcurrent: 2,
      runsPerMemberHour: 20
    }
  registry.configure(config, owner.clock.now())
  registry.qualify(space.space, bot, 'v1', config.profileDigest)
  const trigger = authority.post(channel, 'Human mention', { mentions: [bot] })
  await vi.waitFor(() => expect(replica.head(channel).seq).toBe(trigger.seq))
  owner.clock.advance(20000)
  await vi.waitFor(() =>
    expect(remote!.clockEstimate()?.measuredAtMonotonic).toBe(owner.clock.monotonic())
  )
  owner.clock.advance(10001)
  const confirmed = await remote!.metaHead(space.meta),
    state = owner.projection.state(space.space)!
  evidence.set(`${state.applied.epoch}/${state.applied.seq}`, state)
  const output = new BotOutbox({
      db: owner.db,
      identity: owner.identity,
      keys: owner.keys,
      meta: owner.projection,
      store: replica,
      outbox,
      plan: () => {
        throw Error('Expiry allocated output')
      }
    }),
    admission = new BotAdmissionService({
      profileId: 'joined-owner',
      db: owner.db,
      clock: owner.clock,
      identity: owner.identity,
      store: replica,
      meta: owner.projection,
      registry,
      executions,
      budgets,
      compartments,
      output,
      confirmedMeta: () => ({ head: confirmed, confirmedAtMonotonic: owner.clock.monotonic() }),
      clockEstimate: () => remote!.clockEstimate()
    })
  const result = admission.admit({
      stream: channel,
      bot,
      record: replica.read(channel, { epoch: 1, seq: 0 }, 1, 65536).records[0],
      source: 'delivery'
    }),
    marker = outbox
      .list(channel)
      .find((entry) => decodeEnvelope(entry.envelope).envelope.type === 'bot.run.expired')!
  expect(result.kind).toBe('expired')
  expect(result.record.binding).toBeUndefined()
  expect(budgets.remaining(bot, space.space, owner.clock.now())).toBe(1000)
  await consumer.flush(space.space)
  expect(outbox.get(marker.id)?.state).toBe('sent')
  await vi.waitFor(() => expect(replica.getById(channel, marker.id)).toBeDefined())
  expect(remote!.state()).toBe('open')
  expect(owner.identity.roster()).toEqual(ownRosterBeforeRelay)
  expect(host.store.getById(channel, marker.id)).toBeDefined()
  expect(authority.threadBinding(channel)).toBeUndefined()
  expect(host.store.listStreams({ space: space.space })).toHaveLength(2)
  expect(
    admission.admit({
      stream: channel,
      bot,
      record: replica.read(channel, { epoch: 1, seq: 0 }, 1, 65536).records[0],
      source: 'delivery'
    }).kind
  ).toBe('duplicate')
})
it('delivers the signed expired marker on its indexed human trigger stream over real TLS without an accepted binding', async () => {
  const f = await setup()
  f.p.clock.advance(150000)
  const input = f.message(30001),
    result = f.service.admit(input),
    marker = f.outbox.list(input.stream)[0],
    env = decodeEnvelope(marker.envelope).envelope,
    descriptor = f.p.store.getStream(input.stream)!,
    evidence = f.p.projection.state(f.space.space)!
  expect(result.kind).toBe('expired')
  expect(result.record.binding).toBeUndefined()
  expect(f.budgets.remaining(f.bot, f.space.space, f.p.clock.now())).toBe(1000)
  const gate = new BotRecordAuthorization({
      identity: f.p.identity,
      meta: f.p.projection,
      store: f.p.store,
      binding: () => undefined,
      historicalBot: (space, bot, auth) =>
        space === f.space.space &&
        auth.metaEpoch === evidence.applied.epoch &&
        auth.metaSeq === evidence.applied.seq
          ? (() => {
              const value = evidence.bots.get(bot)
              return (
                value && {
                  owner: value.owner,
                  hostNode: value.delegation.hostNode,
                  keyEpoch: value.delegation.keyEpoch
                }
              )
            })()
          : undefined,
      historicalMember: (space, user, auth) => !!f.p.projection.memberAt(space, user, auth),
      historicalCanSteer: (space, bot, user, auth) =>
        space === f.space.space &&
        auth.metaEpoch === evidence.applied.epoch &&
        auth.metaSeq === evidence.applied.seq &&
        evidence.members.has(user) &&
        evidence.bots.get(bot)?.policy.steer.kind === 'everyone'
    }),
    authority = new SpaceHostService({ ...f.p.host.options, botAuthorization: gate }),
    tls = await channels(f.p, f.p),
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
  const position = await client.append(input.stream, marker.id, marker.envelope, marker.sig)
  expect(position).toMatchObject({ epoch: 1, seq: 2 })
  expect(authority.threadBinding(input.stream)).toBeUndefined()
  expect(f.p.store.listStreams({ space: f.space.space })).toHaveLength(2)
  expect(await client.append(input.stream, marker.id, marker.envelope, marker.sig)).toEqual(
    position
  )
  const consumer = new SpaceClientService({
    db: f.p.db,
    identity: f.p.identity,
    keys: f.p.keys,
    store: f.p.store,
    outbox: f.outbox,
    meta: f.p.projection,
    clock: f.p.clock,
    localRoutes: f.p.routes,
    metaStream: (d) => spaceMetaStream(d.space),
    connectJoin: async () => {
      throw new NetError('forbidden')
    },
    connectSpace: async () => {
      throw new NetError('forbidden')
    },
    atomicStoreHooks: true,
    verifyBotRecord: (record, stream) => gate.verifyHistory(record, stream)
  })
  disposers.push(() => consumer.close())
  const stored = f.p.store.getById(input.stream, marker.id)!
  expect(() => consumer.verifyRecord(stored, descriptor, false)).not.toThrow()
  const bad = { ...env, id: newId('event'), refs: { ...env.refs, subject: newId('event') } }
  let bytes = canonicalJson(bad)
  await expect(
    client.append(input.stream, bad.id, bytes, f.p.keys.signAsBot(f.bot, bytes))
  ).rejects.toMatchObject({ code: 'forbidden' })
  const progress = {
    ...env,
    id: newId('event'),
    type: 'bot.run.progress',
    body: { text: 'No admitted execution' }
  }
  bytes = canonicalJson(progress)
  await expect(
    client.append(input.stream, progress.id, bytes, f.p.keys.signAsBot(f.bot, bytes))
  ).rejects.toMatchObject({ code: 'forbidden' })
  f.p.identity.revoke(f.bot)
  expect(gate.canWrite(descriptor, env, peer(f.p))).toBe(false)
  expect(() => consumer.verifyRecord(stored, descriptor, false)).not.toThrow()
  expect(() =>
    new BotRecordAuthorization({
      identity: f.p.identity,
      meta: f.p.projection,
      store: f.p.store,
      binding: () => undefined
    }).verifyHistory(stored, descriptor)
  ).toThrow(expect.objectContaining({ code: 'forbidden' }))
})

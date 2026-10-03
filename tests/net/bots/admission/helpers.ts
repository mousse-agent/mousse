import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { BotAdmissionService, BotOutbox } from '../../../../src/mms/bots/admission'
import { SqliteBotRegistry } from '../../../../src/mms/bots/registry'
import { SqliteCompartmentStore } from '../../../../src/mms/bots/compartments'
import { SqliteExecutionLedger } from '../../../../src/mms/net/store/executions'
import { SqliteBudgetLedger } from '../../../../src/mms/net/store/budgets'
import { SqliteOutbox } from '../../../../src/mms/net/store/outbox'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { profile, cleanup, peer, signed, trust } from '../../spaces/host/helpers'
import { newId, NetError, type BotProfile } from '../../../../src/shared/net'

export async function setup(
  options: { daily?: number; ceiling?: number; concurrency?: number; rate?: number } = {}
) {
  let failing = ''
  const p = await profile(undefined, 'Bot owner', undefined, (point) => {
      if (point === failing) throw new NetError('cancelled')
    }),
    space = p.host.create({ name: 'Admission' }),
    parent = p.host.createChannel(space.space, 'general'),
    bot = newId('bot'),
    key = p.keys.createBotKey(bot),
    delegation = p.identity.issueBotDelegation({
      bot,
      key,
      name: 'Qualified fixture',
      hostNode: peer(p).node
    })
  p.host.postMeta(space.space, 'bot.added', {
    record: {
      bot,
      owner: peer(p).user,
      delegation,
      displayName: 'Fixture',
      profile: 'chat',
      policy: { steer: { kind: 'everyone' }, visibility: 'public' }
    }
  })
  const executions = new SqliteExecutionLedger(p.db),
    budgets = new SqliteBudgetLedger(p.db),
    compartments = new SqliteCompartmentStore(p.db, 'profile-a'),
    outbox = new SqliteOutbox(p.db),
    adapters = new Map<string, import('../../../../src/mms/net/contracts').BotRuntimeAdapter>([
      [
        'fixture',
        {
          id: 'fixture',
          supports: (profile: BotProfile) => profile === 'chat',
          run: async () => {
            throw Error('Admission invoked model')
          }
        }
      ]
    ]),
    registry = new SqliteBotRegistry({
      db: p.db,
      identity: p.identity,
      keys: p.keys,
      meta: p.projection,
      budgets,
      adapters
    }),
    config = {
      space: space.space,
      bot,
      adapter: 'fixture',
      profile: 'chat' as const,
      definitionRevision: 'v1',
      profileDigest: Buffer.alloc(32, 1).toString('base64url'),
      dailyBudgetUnits: options.daily ?? 1000,
      runCeilingUnits: options.ceiling ?? 60,
      maxConcurrent: options.concurrency ?? 2,
      runsPerMemberHour: options.rate ?? 20
    }
  registry.configure(config, p.clock.now())
  registry.qualify(space.space, bot, 'v1', config.profileDigest)
  const output = new BotOutbox({
    db: p.db,
    identity: p.identity,
    keys: p.keys,
    meta: p.projection,
    store: p.store,
    outbox,
    plan: () => ({
      stream: newId('stream'),
      compartment: compartments.publicId(bot, space.space),
      backingThreadId: randomUUID(),
      workspaceId: randomUUID()
    })
  })
  let fresh = true,
    offset = 0,
    rtt = 0,
    delta = 0,
    clockAge = 0
  const service = new BotAdmissionService({
    profileId: 'profile-a',
    db: p.db,
    clock: p.clock,
    identity: p.identity,
    store: p.store,
    meta: p.projection,
    registry,
    executions,
    budgets,
    compartments,
    output,
    confirmedMeta: () =>
      fresh
        ? { head: p.store.head(space.meta), confirmedAtMonotonic: p.clock.monotonic() }
        : undefined,
    clockEstimate: () => ({
      offsetMs: offset,
      rttMs: rtt,
      wallDeltaMs: delta,
      measuredAtMonotonic: p.clock.monotonic() - clockAge
    })
  })
  function message(age = 0, delay = 0, author = p) {
    const pos = p.projection.state(space.space)!.applied,
      record = signed(
        author,
        parent,
        'message.posted',
        { text: 'Public mention' },
        { metaEpoch: pos.epoch, metaSeq: pos.seq },
        { ts: p.clock.now() - age - delay, refs: { mentions: [bot] } }
      ),
      position = p.store.appendAsAuthority(parent, { ...record, recvTs: p.clock.now() - age })
    return { stream: parent, bot, record: { ...record, ...position }, source: 'delivery' as const }
  }
  return {
    p,
    space,
    parent,
    bot,
    adapters,
    service,
    registry,
    executions,
    budgets,
    compartments,
    outbox,
    message,
    setFault(point: string) {
      failing = point
    },
    setFresh(value: boolean) {
      fresh = value
    },
    setClock(value: { offset?: number; rtt?: number; delta?: number; age?: number }) {
      offset = value.offset ?? 0
      rtt = value.rtt ?? 0
      delta = value.delta ?? 0
      clockAge = value.age ?? 0
    }
  }
}

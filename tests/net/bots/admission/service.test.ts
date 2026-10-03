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
afterEach(cleanup)
import { setup } from './helpers'
describe('actual signatures and atomic bot admission', () => {
  it('commits one signed acceptance/binding/ceiling/rate and deduplicates before expiry without a second receipt', async () => {
    const f = await setup(),
      input = f.message(),
      first = f.service.admit(input)
    expect(first.kind).toBe('admitted')
    expect(first.record.binding).toBeDefined()
    const binding = first.record.binding!,
      receipts = f.outbox.list(binding.stream)
    expect(receipts).toHaveLength(1)
    const env = decodeEnvelope(receipts[0].envelope).envelope
    expect(env.refs).toMatchObject({ execution: first.record.id, replyTo: input.record.id })
    expect(env.type).toBe('bot.run.accepted')
    expect(
      f.p.identity.verifyAuthor(
        env.author,
        receipts[0].envelope,
        receipts[0].sig,
        env.ts,
        'newWork'
      ).kind
    ).toBe('bot')
    f.p.clock.advance(30001)
    expect(f.service.admit(input)).toMatchObject({
      kind: 'duplicate',
      record: { id: first.record.id }
    })
    expect(f.outbox.list(binding.stream)).toHaveLength(1)
    expect(f.budgets.remaining(f.bot, f.space.space, f.p.clock.now())).toBe(940)
    expect(f.p.db.database.prepare('SELECT count FROM net_bot_admission_rates').get()!.count).toBe(
      1
    )
    expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(1)
  })
  it.each(['bots.admit.beforeReceipt', 'outbox.enqueue.beforeCommit'])(
    'rolls back all admission writes at %s and retries the same trigger once',
    async (point) => {
      const f = await setup(),
        input = f.message()
      f.setFault(point)
      expect(() => f.service.admit(input)).toThrow(expect.objectContaining({ code: 'cancelled' }))
      for (const table of [
        'net_executions',
        'net_budget_reservations',
        'net_bot_admission_slots',
        'net_bot_admission_context',
        'net_bot_admission_rates',
        'net_bot_compartments',
        'net_outbox'
      ])
        expect(f.p.db.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0)
      f.setFault('')
      expect(f.service.admit(input).kind).toBe('admitted')
      expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_outbox').get()!.n).toBe(1)
    }
  )
  it('serializes full budget and capacity reservations, with no charges on refused second admission', async () => {
    const f = await setup({ daily: 100, ceiling: 60 }),
      first = f.service.admit(f.message())
    expect(first.kind).toBe('admitted')
    expect(() => f.service.admit(f.message())).toThrow(
      expect.objectContaining({ code: 'budget_exhausted' })
    )
    expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(1)
    expect(f.p.db.database.prepare('SELECT count FROM net_bot_admission_rates').get()!.count).toBe(
      1
    )
    const g = await setup({ concurrency: 1 })
    g.service.admit(g.message())
    expect(() => g.service.admit(g.message())).toThrow(
      expect.objectContaining({ code: 'rate_limited' })
    )
  })
  it('requires current human membership, applied confirmed meta and explicit mention; bot-authored records never execute', async () => {
    const f = await setup(),
      input = f.message()
    f.setFresh(false)
    expect(() => f.service.admit(input)).toThrow(expect.objectContaining({ code: 'meta_stale' }))
    f.setFresh(true)
    const outsider = await profile(f.p.clock)
    trust(f.p, outsider)
    expect(() => f.service.admit(f.message(0, 0, outsider))).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    const env = decodeEnvelope(input.record.envelope).envelope
    env.author = { bot: f.bot, node: peer(f.p).node, keyEpoch: 1 }
    const bytes = new TextEncoder().encode(JSON.stringify(env))
    expect(() =>
      f.service.admit({
        ...input,
        record: { ...input.record, envelope: bytes, sig: f.p.keys.signAsBot(f.bot, bytes) }
      })
    ).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(() => f.service.admit({ ...input, source: 'snapshot' as any })).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0)
  })
  it.each([
    [30000, 120000, 'admitted'],
    [30001, 0, 'expired'],
    [0, 120001, 'expired'],
    [-1, 0, 'clock_skew'],
    [0, -1, 'clock_skew']
  ] as const)('checks exact delivery/author delay boundaries %d/%d', async (age, delay, kind) => {
    const f = await setup() // Author may precede initial delegation: shift fixture time so historical signature is genuinely valid.
    f.p.clock.advance(150000)
    const input = f.message(age, delay)
    if (kind === 'clock_skew')
      expect(() => f.service.admit(input)).toThrow(expect.objectContaining({ code: kind }))
    else {
      const result = f.service.admit(input)
      expect(result.kind).toBe(kind)
      if (kind === 'expired') {
        expect(result.record.binding).toBeUndefined()
        expect(f.outbox.list(f.parent)).toHaveLength(1)
        expect(f.service.admit(input).kind).toBe('duplicate')
        expect(f.budgets.remaining(f.bot, f.space.space, f.p.clock.now())).toBe(1000)
      }
    }
  })
  it.each([{ offset: 60001 }, { rtt: 5001 }, { delta: 1001 }, { age: 30001 }])(
    'refuses unqualified clock sample before receipts: %j',
    async (clock) => {
      const f = await setup()
      f.setClock(clock)
      expect(() => f.service.admit(f.message())).toThrow(
        expect.objectContaining({ code: 'clock_skew' })
      )
      expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_outbox').get()!.n).toBe(0)
    }
  )
  it('rechecks the delivery window after output preparation before committing any reservation', async () => {
    const f = await setup(),
      input = f.message(),
      original = f.service.options.output.plan.bind(f.service.options.output)
    f.service.options.output.plan = (mention) => {
      const plan = original(mention)
      f.p.clock.advance(30001)
      return plan
    }
    const result = f.service.admit(input)
    expect(result.kind).toBe('expired')
    expect(result.record.binding).toBeUndefined()
    expect(
      f.p.db.database.prepare('SELECT count(*) AS n FROM net_budget_reservations').get()!.n
    ).toBe(0)
    expect(
      f.p.db.database.prepare('SELECT count(*) AS n FROM net_bot_admission_rates').get()!.n
    ).toBe(0)
  })
})

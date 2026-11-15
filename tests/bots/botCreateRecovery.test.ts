/** Creation boundaries: before the bot, before its turn, after its turn; retry or startup, racing and refused requests. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { BotDefinitionStore } from '../../src/mms/bots/definitions/BotDefinitionStore'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { botFixture, type BotFixture } from './botFixture'

let f: BotFixture
let reopened: BotStore | undefined
const input = { look: { colour: 'blue', accessory: 'crown' }, description: 'Track my spending.', clientRequestId: 'create-once' }
beforeEach(() => { f = botFixture() })
afterEach(() => {
  vi.restoreAllMocks()
  f.bots.close()
  reopened?.close()
  reopened = undefined
  f.close()
})

function restart(): void {
  f.bots.close()
  reopened = new BotStore({ profileHome: f.profile, clock: () => f.clock.now })
  f.bots = new BotEngine({ ...f.host, store: reopened, definitions: new BotDefinitionStore(reopened.directory, (id) => reopened!.registry(id)?.revision ?? null) })
}

for (const boundary of ['before bot', 'before home', 'before turn', 'after turn'] as const) {
  for (const recovery of ['retry', 'startup'] as const) {
    if (boundary === 'before bot' && recovery === 'startup') continue // No accepted bot exists to repair.
    it(`${recovery} keeps one bot and first turn after stopping ${boundary}`, async () => {
      f.oneShot.fail = true
      const engine = f.bots
      if (boundary === 'before bot') vi.spyOn(f.store, 'approve').mockImplementationOnce(() => { throw new Error('stopped') })
      else if (boundary === 'before home') vi.spyOn(engine, 'ensureHome').mockImplementationOnce(() => { throw new Error('stopped') })
      else {
        const enqueue = engine.enqueueChat.bind(engine)
        vi.spyOn(engine, 'enqueueChat').mockImplementationOnce(async (...args) => {
          if (boundary === 'after turn') await enqueue(...args)
          throw new Error('stopped')
        })
      }
      await expect(engine.service.create(input)).rejects.toThrow('stopped')
      const accepted = engine.service.list().bots[0]?.id
      if (boundary === 'before bot') expect(accepted).toBeUndefined()
      restart()
      if (recovery === 'startup') {
        await f.bots.reconcileOnStartup()
        await f.bots.reconcileOnStartup()
        expect(reopened!.activationByKey('create:create-once')?.botId).toBe(accepted)
      }
      const again = await f.bots.service.create(input)
      if (accepted) expect(again.bot.id).toBe(accepted)
      expect(f.bots.service.list().bots).toHaveLength(1)
      const turns = reopened!.listActivations().filter((row) => row.idempotencyKey === 'create:create-once')
      expect(turns).toHaveLength(1)
      expect(turns[0]).toMatchObject({ botId: again.bot.id, lane: 'chat' })
      expect(turns[0]!.trigger.input).toContain('set it with set_profile')
      // A different key is a separate create, even with the same description.
      await f.bots.service.create({ ...input, clientRequestId: 'another' })
      expect(f.bots.service.list().bots).toHaveLength(2)
    })
  }
}

it('two creates waiting for naming still make one bot', async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  vi.spyOn(f.bots, 'oneShotFor').mockImplementation(async () => { await waiting; return 'Penny' })
  const a = f.bots.service.create(input)
  const b = f.bots.service.create(input)
  release()
  const [first, second] = await Promise.all([a, b])
  expect(second.bot.id).toBe(first.bot.id)
  expect(f.bots.service.list().bots).toHaveLength(1)
  expect(f.store.listActivations()).toHaveLength(1)
})

it('a refused model leaves no bot and the same key can be retried', async () => {
  await expect(f.bots.service.create({ ...input, model: 'missing' })).rejects.toMatchObject({ code: 'model_unavailable' })
  expect(f.bots.service.list().bots).toHaveLength(0)
  restart()
  await f.bots.reconcileOnStartup()
  expect(f.bots.service.list().bots).toHaveLength(0)
  await f.bots.service.create(input)
  expect(f.bots.service.list().bots).toHaveLength(1)
  expect(reopened!.listActivations()).toHaveLength(1)
})

for (const firstTurn of ['missing', 'present'] as const) {
  it(`a retry after soft deletion stays refused with its first turn ${firstTurn}`, async () => {
    if (firstTurn === 'missing') {
      vi.spyOn(f.bots, 'enqueueChat').mockRejectedValueOnce(new Error('stopped'))
      await expect(f.bots.service.create(input)).rejects.toThrow('stopped')
    } else await f.bots.service.create(input)
    const botId = f.bots.service.list().bots[0]!.id
    await f.bots.service.delete(botId)
    const turns = f.store.listActivations()
    const deletedAt = f.store.registry(botId)!.deletedAt
    expect(deletedAt).toBeTruthy()
    restart()
    await f.bots.reconcileOnStartup()
    await expect(f.bots.service.create(input)).rejects.toMatchObject({ code: 'bot_not_found' })
    expect(f.bots.service.list().bots).toEqual([])
    expect(reopened!.registry(botId)!.deletedAt).toBe(deletedAt)
    expect(reopened!.botCreation('create:create-once')?.botId).toBe(botId)
    expect(reopened!.listActivations()).toEqual(turns)
    expect(reopened!.activeGrant(botId)).toBeUndefined()
  })
}

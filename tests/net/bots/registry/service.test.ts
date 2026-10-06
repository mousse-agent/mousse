import { afterEach, describe, expect, it } from 'vitest'
import { SqliteBotRegistry } from '../../../../src/mms/bots/registry'
import { SqliteBudgetLedger } from '../../../../src/mms/net/store/budgets'
import { profile, cleanup, peer } from '../../spaces/host/helpers'
import { newId, type BotProfile } from '../../../../src/shared/net'
afterEach(cleanup)
async function setup() {
  const p = await profile(),
    space = p.host.create({ name: 'Bots' }),
    bot = newId('bot'),
    key = p.keys.createBotKey(bot),
    delegation = p.identity.issueBotDelegation({ bot, key, name: 'Bot', hostNode: peer(p).node })
  p.host.postMeta(space.space, 'bot.added', {
    record: {
      bot,
      owner: peer(p).user,
      delegation,
      displayName: 'Bot',
      profile: 'chat',
      policy: { steer: { kind: 'everyone' }, visibility: 'public' }
    }
  })
  let supported = true
  const adapters = new Map([
      [
        'qualified-fixture',
        {
          id: 'qualified-fixture',
          supports: (profile: BotProfile) => supported && profile === 'chat',
          run: async () => {
            throw Error('Registry must never run a model')
          }
        }
      ]
    ]),
    registry = new SqliteBotRegistry({
      db: p.db,
      identity: p.identity,
      keys: p.keys,
      meta: p.projection,
      budgets: new SqliteBudgetLedger(p.db),
      adapters
    }),
    config = {
      space: space.space,
      bot,
      adapter: 'qualified-fixture',
      profile: 'chat' as const,
      definitionRevision: 'v1',
      profileDigest: Buffer.alloc(32, 1).toString('base64url'),
      dailyBudgetUnits: 1000,
      runCeilingUnits: 100,
      maxConcurrent: 2,
      runsPerMemberHour: 20
    }
  return {
    p,
    space,
    bot,
    registry,
    config,
    adapters,
    setSupported(value: boolean) {
      supported = value
    }
  }
}
describe('durable local registry qualifications and actual root-signed placement', () => {
  it('requires owner config and explicit matching evidence, then fences definition, runtime and stop changes', async () => {
    const f = await setup()
    f.registry.configure(f.config, f.p.clock.now())
    expect(() => f.registry.current(f.space.space, f.bot)).toThrow(
      expect.objectContaining({ code: 'profile_unsupported' })
    )
    expect(() =>
      f.registry.qualify(f.space.space, f.bot, 'wrong', f.config.profileDigest)
    ).toThrow()
    f.registry.qualify(f.space.space, f.bot, 'v1', f.config.profileDigest)
    expect(f.registry.current(f.space.space, f.bot).policy.steer.kind).toBe('everyone')
    f.setSupported(false)
    expect(() => f.registry.current(f.space.space, f.bot)).toThrow(
      expect.objectContaining({ code: 'profile_unsupported' })
    )
    f.setSupported(true)
    f.registry.stop(f.space.space, f.bot)
    expect(() => f.registry.current(f.space.space, f.bot)).toThrow(
      expect.objectContaining({ code: 'cancelled' })
    )
    f.registry.stop(f.space.space, f.bot, false)
    f.registry.configure({ ...f.config, definitionRevision: 'v2' }, f.p.clock.now())
    expect(() => f.registry.current(f.space.space, f.bot)).toThrow(
      expect.objectContaining({ code: 'profile_unsupported' })
    )
    expect(() => f.registry.configure(f.config, f.p.clock.now() + 1)).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
  })
  it('refuses revoked bot keys despite valid historical meta and persisted qualified config', async () => {
    const f = await setup()
    f.registry.configure(f.config, f.p.clock.now())
    f.registry.qualify(f.space.space, f.bot, 'v1', f.config.profileDigest)
    f.p.identity.revoke(f.bot)
    expect(() => f.registry.current(f.space.space, f.bot)).toThrow(
      expect.objectContaining({ code: 'revoked' })
    )
    const reopened = new SqliteBotRegistry({ ...f.registry.options })
    expect(reopened.get(f.space.space, f.bot)?.qualified).toBe(true)
    expect(() => reopened.current(f.space.space, f.bot)).toThrow(
      expect.objectContaining({ code: 'revoked' })
    )
  })
})

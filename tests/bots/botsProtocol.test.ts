/**
 * PR 6 §4 "Protocol": the personal-bot methods are profile-bound, validated with exact keys, and
 * reach the admitted profile's bot engine; engine errors keep their codes.
 */
import { describe, expect, it, vi } from 'vitest'
import { BotEngineError, type BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { BOTS_PERSONAL_CAPABILITY, BOTS_PERSONAL_METHODS } from '../../src/shared/bots/personal/methods'

const context = (profileId = 'p1') => ({ connection: { id: 'c', binding: { profileId, epoch: 1 }, capabilities: new Set<string>() } }) as unknown as HandlerContext
const ACTIVATION = 'act_00000000-0000-4000-8000-000000000000'

function setup() {
  const domains = new DomainHandlerRegistry()
  const engine = {
    list: vi.fn(() => []),
    activate: vi.fn(async (input: unknown) => ({ id: ACTIVATION, input })),
    approve: vi.fn(() => { throw new BotEngineError('bot_grant_changed', 'These permissions changed since they were shown.') }),
    stop: vi.fn(async () => ({ id: ACTIVATION, status: 'cancelled' })),
    refreshRuntimes: vi.fn(async () => {})
  }
  const profiles: string[] = []
  registerPersonalBotMethods(domains, (profileId) => (profiles.push(profileId), engine as unknown as BotEngine))
  return { domains, engine, profiles }
}

describe('personal bot methods', () => {
  it('registers every method, profile-bound, outside net.v1', () => {
    const { domains } = setup()
    for (const method of BOTS_PERSONAL_METHODS) expect(domains.has(method)).toBe(true)
    expect(domains.capabilities()).toEqual([BOTS_PERSONAL_CAPABILITY])
  })

  it('needs a profile binding and reaches that profile\'s engine', async () => {
    const { domains, engine, profiles } = setup()
    await expect(domains.dispatch({ connection: { id: 'c', capabilities: new Set() } } as unknown as HandlerContext, 'bots.definitions.list', {})).rejects.toMatchObject({ code: 'profile_binding_required' })
    await expect(domains.dispatch(context('p2'), 'bots.activate', { botId: 'site-editor', input: 'Fix the footer', clientRequestId: 'c-1' })).resolves.toMatchObject({ id: ACTIVATION })
    expect(profiles).toEqual(['p2'])
    expect(engine.activate).toHaveBeenCalledWith({ botId: 'site-editor', input: 'Fix the footer', clientRequestId: 'c-1' })
  })

  it('validates exact keys and values', async () => {
    const { domains } = setup()
    await expect(domains.dispatch(context(), 'bots.activate', { botId: 'Site Editor', input: 'x', clientRequestId: 'c' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(domains.dispatch(context(), 'bots.activate', { botId: 'site-editor', input: '  ', clientRequestId: 'c' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(domains.dispatch(context(), 'bots.activate', { botId: 'site-editor', input: 'x', clientRequestId: 'c', grant: 'all' })).rejects.toMatchObject({ code: 'unknown_field' })
    await expect(domains.dispatch(context(), 'bots.approve', { botId: 'site-editor', manifestDigest: 'abc' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(domains.dispatch(context(), 'bots.activations.stop', { activationId: '../x' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(domains.dispatch(context(), 'bots.activations.stop', { activationId: ACTIVATION })).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('keeps the engine\'s error codes', async () => {
    const { domains, engine } = setup()
    await expect(domains.dispatch(context(), 'bots.approve', { botId: 'site-editor', manifestDigest: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'bot_grant_changed' })
    // Approval decides on a fresh reading of the runtimes' policy facts (review r2).
    expect(engine.refreshRuntimes).toHaveBeenCalledWith('site-editor')
    expect(engine.refreshRuntimes.mock.invocationCallOrder[0]).toBeLessThan(engine.approve.mock.invocationCallOrder[0])
  })
})

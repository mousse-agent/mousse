/**
 * PR 6 §4 "Protocol", Bot Phase 1 §5.11: the personal-bot methods are the Bot UI's v2 set
 * (`bots.personal.v2`), profile-bound, validated with exact keys, and reach the admitted profile's
 * bots; the form editor's v1 methods are no longer registered for clients. Engine errors keep their
 * codes. Per-method validation is in `botsProtocolV2.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import { BotEngineError } from '../../src/mms/bots/activation/BotEngine'
import type { BotChatService } from '../../src/mms/bots/chat/BotChatService'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { BOTS_PERSONAL_METHODS, BOTS_PERSONAL_V2_CAPABILITY, BOTS_PERSONAL_V2_METHODS } from '../../src/shared/bots/personal/methods'

const context = (profileId = 'p1') => ({ connection: { id: 'c', binding: { profileId, epoch: 1 }, capabilities: new Set<string>() } }) as unknown as HandlerContext

function setup(available = true) {
  const domains = new DomainHandlerRegistry()
  const service = {
    list: vi.fn(() => ({ bots: [] })),
    pause: vi.fn(() => { throw new BotEngineError('bot_not_found', 'No bot with that id.') }),
    chatSend: vi.fn(async (input: unknown) => ({ message: { seq: 1, input } }))
  }
  const profiles: string[] = []
  registerPersonalBotMethods(domains, (profileId) => (profiles.push(profileId), available ? service as unknown as BotChatService : null))
  return { domains, service, profiles }
}

describe('personal bot methods', () => {
  it('registers the v2 methods only, profile-bound, under bots.personal.v2', () => {
    const { domains } = setup()
    for (const method of BOTS_PERSONAL_V2_METHODS) expect(domains.has(method)).toBe(true)
    // The form editor's methods stay engine functions; no client reaches them.
    for (const method of BOTS_PERSONAL_METHODS) if (!(BOTS_PERSONAL_V2_METHODS as readonly string[]).includes(method)) expect(domains.has(method), method).toBe(false)
    expect(domains.has('bots.activate')).toBe(false)
    expect(domains.has('bots.memory.reindex')).toBe(false)
    expect(domains.capabilities()).toEqual([BOTS_PERSONAL_V2_CAPABILITY])
  })

  it('needs a profile binding and reaches that profile\'s bots', async () => {
    const { domains, service, profiles } = setup()
    await expect(domains.dispatch({ connection: { id: 'c', capabilities: new Set() } } as unknown as HandlerContext, 'bots.personal.list', {})).rejects.toMatchObject({ code: 'profile_binding_required' })
    await expect(domains.dispatch(context('p2'), 'bots.chat.send', { botId: 'site-editor', text: 'Fix the footer', clientRequestId: 'c-1' })).resolves.toMatchObject({ message: { seq: 1 } })
    expect(profiles).toEqual(['p2'])
    expect(service.chatSend).toHaveBeenCalledWith({ botId: 'site-editor', text: 'Fix the footer', clientRequestId: 'c-1' })
  })

  it('validates exact keys', async () => {
    const { domains, service } = setup()
    await expect(domains.dispatch(context(), 'bots.chat.send', { botId: 'Site Editor', text: 'x', clientRequestId: 'c' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(domains.dispatch(context(), 'bots.chat.send', { botId: 'site-editor', text: 'x', clientRequestId: 'c', model: 'opus' })).rejects.toMatchObject({ code: 'unknown_field' })
    expect(service.chatSend).not.toHaveBeenCalled()
  })

  it('keeps the engine\'s error codes, and reports bots unavailable when bots.db could not be opened', async () => {
    await expect(setup().domains.dispatch(context(), 'bots.personal.pause', { botId: 'site-editor' })).rejects.toMatchObject({ code: 'bot_not_found' })
    await expect(setup(false).domains.dispatch(context(), 'bots.personal.list', {})).rejects.toMatchObject({ code: 'bots_unavailable' })
  })
})

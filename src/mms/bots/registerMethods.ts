import type { BotDefinition } from '../../shared/bots/personal/definition'
import { BOT_ESCALATION_ANSWERS, type BotEscalationAnswer } from '../../shared/bots/personal/escalation'
import { BOTS_PERSONAL_CAPABILITY, BOTS_PERSONAL_METHODS, type BotsPersonalMethod } from '../../shared/bots/personal/methods'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'
import { BotEngineError, type BotEngine } from './activation/BotEngine'
import { BotDefinitionError, isBotId } from './definitions/BotDefinitionStore'

type Params = Record<string, unknown>

const KEYS: Record<BotsPersonalMethod, readonly string[]> = {
  'bots.definitions.list': [],
  'bots.definitions.get': ['botId'],
  'bots.definitions.save': ['definition', 'expectedDraftHash'],
  'bots.definitions.publish': ['botId', 'expectedDraftHash'],
  'bots.definitions.delete': ['botId'],
  'bots.approve': ['botId', 'manifestDigest'],
  'bots.revoke': ['botId'],
  'bots.activate': ['botId', 'input', 'clientRequestId'],
  'bots.activations.list': ['botId'],
  'bots.activations.get': ['activationId'],
  'bots.activations.stop': ['activationId'],
  'bots.activations.continue': ['activationId', 'acknowledgeUncertain'],
  'bots.activations.markDone': ['activationId', 'acknowledgeUncertain'],
  'bots.escalations.list': ['activationId'],
  'bots.escalations.respond': ['escalationId', 'answer', 'amount'],
  'bots.context.reset': ['botId', 'key']
}

const HASH = /^[a-f0-9]{64}$/
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

function validate(method: BotsPersonalMethod, value: unknown): Params {
  const p = domainObject(value ?? {}, ['profileId', ...KEYS[method]])
  const needsBot = KEYS[method].includes('botId') && method !== 'bots.activations.list'
  if (needsBot && !isBotId(p.botId)) throw new DomainRpcError('invalid_params', 'A bot id is required')
  if (p.botId !== undefined && !isBotId(p.botId)) throw new DomainRpcError('invalid_params', 'Invalid bot id')
  for (const key of ['expectedDraftHash', 'manifestDigest'] as const)
    if (p[key] !== undefined && (typeof p[key] !== 'string' || !HASH.test(p[key] as string))) throw new DomainRpcError('invalid_params', `Invalid ${key}`)
  if ((method === 'bots.definitions.publish' && p.expectedDraftHash === undefined) || (method === 'bots.approve' && p.manifestDigest === undefined))
    throw new DomainRpcError('invalid_params', method === 'bots.approve' ? 'The permissions digest is required' : 'The draft hash is required')
  if (method === 'bots.definitions.save' && (!p.definition || typeof p.definition !== 'object' || Array.isArray(p.definition)))
    throw new DomainRpcError('invalid_params', 'A bot definition is required')
  if (method === 'bots.activate') {
    if (typeof p.input !== 'string' || !p.input.trim() || p.input.length > 64 * 1024) throw new DomainRpcError('invalid_params', 'The bot needs something to do')
    if (typeof p.clientRequestId !== 'string' || !REQUEST_ID.test(p.clientRequestId)) throw new DomainRpcError('invalid_params', 'A request id is required')
  }
  const activationOptional = method === 'bots.escalations.list' && p.activationId === undefined
  if (KEYS[method].includes('activationId') && !activationOptional && (typeof p.activationId !== 'string' || !/^act_[0-9a-f-]{36}$/.test(p.activationId)))
    throw new DomainRpcError('invalid_params', 'An activation id is required')
  if (p.acknowledgeUncertain !== undefined && typeof p.acknowledgeUncertain !== 'boolean') throw new DomainRpcError('invalid_params', 'acknowledgeUncertain must be true or false')
  if (method === 'bots.escalations.respond') {
    if (typeof p.escalationId !== 'string' || !/^esc_[0-9a-f-]{36}$/.test(p.escalationId)) throw new DomainRpcError('invalid_params', 'An escalation id is required')
    if (!BOT_ESCALATION_ANSWERS.includes(p.answer as BotEscalationAnswer)) throw new DomainRpcError('invalid_params', 'The answer must be allow_bot, allow_once, deny or allow_more')
    if (p.amount !== undefined && (typeof p.amount !== 'number' || !Number.isFinite(p.amount) || p.amount <= 0)) throw new DomainRpcError('invalid_params', 'The amount must be a positive number')
  }
  if (method === 'bots.context.reset' && (typeof p.key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(p.key))) throw new DomainRpcError('invalid_params', 'A context thread key is required')
  return p
}

async function handle(method: BotsPersonalMethod, p: Params, bots: BotEngine): Promise<unknown> {
  switch (method) {
    case 'bots.definitions.list': return { bots: bots.list() }
    case 'bots.definitions.get': {
      const entry = bots.get(p.botId as string)
      if (entry.published) await bots.refreshRuntimes(entry.id)
      return { ...entry, approval: entry.published ? bots.approval(entry.id) : null }
    }
    case 'bots.definitions.save': return bots.save(p.definition as BotDefinition, p.expectedDraftHash as string | undefined)
    case 'bots.definitions.publish': return { definition: bots.publish(p.botId as string, p.expectedDraftHash as string) }
    case 'bots.definitions.delete': {
      await bots.remove(p.botId as string)
      return { ok: true }
    }
    case 'bots.approve': {
      await bots.refreshRuntimes(p.botId as string)
      return bots.approve(p.botId as string, p.manifestDigest as string)
    }
    case 'bots.revoke': return { revoked: bots.revoke(p.botId as string) }
    case 'bots.activate': return bots.activate({ botId: p.botId as string, input: p.input as string, clientRequestId: p.clientRequestId as string })
    case 'bots.activations.list': return { activations: bots.listActivations(p.botId as string | undefined) }
    case 'bots.activations.get': return bots.getActivation(p.activationId as string)
    case 'bots.activations.stop': return bots.stop(p.activationId as string)
    case 'bots.activations.continue': return bots.continueActivation(p.activationId as string, { acknowledgeUncertain: p.acknowledgeUncertain === true })
    case 'bots.activations.markDone': return bots.markDone(p.activationId as string, { acknowledgeUncertain: p.acknowledgeUncertain === true })
    case 'bots.escalations.list': return { escalations: bots.listEscalations(p.activationId as string | undefined) }
    case 'bots.escalations.respond': return bots.respond({ escalationId: p.escalationId as string, answer: p.answer as BotEscalationAnswer, ...(p.amount !== undefined ? { amount: p.amount as number } : {}) })
    case 'bots.context.reset': return bots.resetContext(p.botId as string, p.key as string)
  }
}

/** Bind once before server seal. The engine comes from the daemon's admitted profile, never a client path. */
export function registerPersonalBotMethods(domains: DomainHandlerRegistry, botsForProfile: (profileId: string) => BotEngine | null | Promise<BotEngine | null>): void {
  for (const method of BOTS_PERSONAL_METHODS) {
    domains.register({
      method,
      scope: 'profile',
      capability: BOTS_PERSONAL_CAPABILITY,
      validate: (params) => validate(method, params),
      async handle(_context, params, binding) {
        try {
          const bots = await botsForProfile(binding!.profileId)
          // The profile's bots.db could not be opened: bots are unavailable, nothing else is affected.
          if (!bots) throw new DomainRpcError('bots_unavailable', 'Bots are unavailable in this profile: their data could not be opened.')
          return await handle(method, params, bots)
        } catch (error) {
          if (error instanceof BotEngineError) throw new DomainRpcError(error.code, error.message, error.details)
          if (error instanceof BotDefinitionError) throw new DomainRpcError(error.code, error.message)
          throw error
        }
      }
    })
  }
}

import { isKeyName } from '../../shared/automationKeys'
import type { SecretEntryView, SecretRequestView } from '../../shared/secretRequests'
import { DomainRpcError, domainObject, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import { SecretRequestError } from './SecretRequests'

export const SECRETS_CAPABILITY = 'secrets.v1'

/** What the secret methods need from the profile. */
export interface SecretsDomain {
  requests: {
    list(threadId: string): SecretRequestView[]
    answer(threadId: string, requestId: string, value: unknown, keep: unknown): { name: string }
    useSaved(threadId: string, requestId: string): { name: string }
    decline(threadId: string, requestId: string): void
  }
  list(): SecretEntryView[]
  delete(name: string): boolean
}

const id = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value || value.length > 256) throw new DomainRpcError('invalid_params', `${what} is required`)
  return value
}

/** Only a person at a window of this computer answers a card or removes a secret; no agent, CLI or other computer. */
function fromWindow(context: HandlerContext): void {
  if (context.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', 'Answer it in a Mousse window on the computer that runs the thread.')
}

/** A refusal in words that never repeat what was typed. */
function refusal(error: unknown): never {
  if (error instanceof DomainRpcError) throw error
  if (error instanceof SecretRequestError) throw new DomainRpcError(error.code === 'invalid' ? 'invalid_params' : 'not_found', error.message)
  // Anything else (a disk error while saving) is reported by kind only.
  throw new DomainRpcError('secret_store_failed', 'The secret could not be saved. Nothing was stored.')
}

/**
 * Secret requests (#595): `secrets.requests.*` lists a thread's open cards and answers them; `secrets.list` and
 * `secrets.delete` are Settings → Secrets. No reply, event or error holds a value.
 */
export function registerSecretMethods(domains: DomainHandlerRegistry, domainFor: (profileId: string) => Promise<SecretsDomain>): void {
  const bound = async (binding: { profileId: string } | undefined) => {
    if (!binding) throw new DomainRpcError('profile_required', 'Secrets need a profile')
    return domainFor(binding.profileId)
  }
  domains.register({
    method: 'secrets.requests.list',
    scope: 'profile',
    capability: SECRETS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'threadId'])
      id(p.threadId, 'A thread id')
      return p
    },
    async handle(_context, params, binding) {
      return { requests: (await bound(binding)).requests.list(params.threadId as string) }
    }
  })
  domains.register({
    method: 'secrets.requests.answer',
    scope: 'profile',
    capability: SECRETS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'threadId', 'requestId', 'value', 'keep'])
      id(p.threadId, 'A thread id')
      id(p.requestId, 'A request id')
      // The value's own checks run in the service, in words that never repeat it.
      if (typeof p.value !== 'string') throw new DomainRpcError('invalid_params', 'Enter the secret.')
      return p
    },
    async handle(context, params, binding) {
      fromWindow(context)
      const domain = await bound(binding)
      try {
        return domain.requests.answer(params.threadId as string, params.requestId as string, params.value, params.keep)
      } catch (error) {
        refusal(error)
      }
    }
  })
  domains.register({
    method: 'secrets.requests.useSaved',
    scope: 'profile',
    capability: SECRETS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'threadId', 'requestId'])
      id(p.threadId, 'A thread id')
      id(p.requestId, 'A request id')
      return p
    },
    async handle(context, params, binding) {
      fromWindow(context)
      const domain = await bound(binding)
      try {
        return domain.requests.useSaved(params.threadId as string, params.requestId as string)
      } catch (error) {
        refusal(error)
      }
    }
  })
  domains.register({
    method: 'secrets.requests.decline',
    scope: 'profile',
    capability: SECRETS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'threadId', 'requestId'])
      id(p.threadId, 'A thread id')
      id(p.requestId, 'A request id')
      return p
    },
    async handle(context, params, binding) {
      fromWindow(context)
      const domain = await bound(binding)
      try {
        domain.requests.decline(params.threadId as string, params.requestId as string)
        return { ok: true }
      } catch (error) {
        refusal(error)
      }
    }
  })
  domains.register({
    method: 'secrets.list',
    scope: 'profile',
    capability: SECRETS_CAPABILITY,
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    async handle(_context, _params, binding) {
      return { secrets: (await bound(binding)).list() }
    }
  })
  domains.register({
    method: 'secrets.delete',
    scope: 'profile',
    capability: SECRETS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'name'])
      if (!isKeyName(p.name)) throw new DomainRpcError('invalid_params', 'A secret name is a word like GITHUB_TOKEN')
      return p
    },
    async handle(context, params, binding) {
      fromWindow(context)
      return { deleted: (await bound(binding)).delete(params.name as string) }
    }
  })
}

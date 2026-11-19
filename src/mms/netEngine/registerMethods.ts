import { AppError } from '../../shared/errors'
import { NET_LOCAL_CAPABILITY } from '../../shared/net/local'
import { NET_ERRORS, NetError } from '../../shared/net'
import { NET_ENGINE_LOCAL_METHODS, type NetEngineLocalMethod } from '../../shared/netEngine/local'
import { DomainRpcError, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { NetEngineService } from './NetEngineService'

/** The string fields each method needs. */
const NEEDS: Partial<Record<NetEngineLocalMethod, string[]>> = {
  'netEngine.invite.cancel': ['invitation'],
  'netEngine.approve': ['request'],
  'netEngine.join': ['ticket'],
  'netEngine.retry': ['node'],
  'netEngine.remove': ['node'],
  'netEngine.address.add': ['node', 'address'],
  'netEngine.removeEverywhere.plan': ['node'],
  'netEngine.removeEverywhere': ['node'],
  'netEngine.removeEverywhere.answer': ['identity', 'host']
}

/** Every method takes an object, with the string fields it needs (`approve` takes `yes` too). */
function validate(method: NetEngineLocalMethod, params: unknown): Record<string, unknown> {
  const value = params ?? {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new DomainRpcError('bad_request', `${method} takes an object`)
  const fields = value as Record<string, unknown>
  for (const field of NEEDS[method] ?? [])
    if (typeof fields[field] !== 'string' || !fields[field])
      throw new DomainRpcError('bad_request', `${method} needs ${field}`)
  if (
    (method === 'netEngine.approve' || method === 'netEngine.removeEverywhere.answer') &&
    typeof fields.yes !== 'boolean'
  )
    throw new DomainRpcError('bad_request', `${method} needs yes`)
  if (method === 'netEngine.removeEverywhere.answer' && !Number.isSafeInteger(fields.grant))
    throw new DomainRpcError('bad_request', `${method} needs grant`)
  if (method === 'netEngine.removeEverywhere') {
    const hosts = fields.hosts
    const ok =
      Array.isArray(hosts) &&
      hosts.every(
        (h) =>
          h &&
          typeof h === 'object' &&
          typeof (h as Record<string, unknown>).host === 'string' &&
          Number.isSafeInteger((h as Record<string, unknown>).grant)
      )
    if (!ok) throw new DomainRpcError('bad_request', `${method} needs hosts [{host, grant}]`)
  }
  return fields
}

/**
 * The new networking's local methods (`NET_ENGINE_LOCAL_METHODS`), for this computer's windows only: a paired
 * computer's calls go through the engine dispatcher, which allows only `ENGINE_OWNER_METHODS`.
 */
export function registerNetEngineMethods(
  registry: DomainHandlerRegistry,
  forProfile: (id: string) => NetEngineService | Promise<NetEngineService>
): void {
  for (const method of NET_ENGINE_LOCAL_METHODS)
    registry.register({
      method,
      scope: 'profile',
      capability: NET_LOCAL_CAPABILITY,
      requiredCapabilities: [NET_LOCAL_CAPABILITY],
      validate: (params) => validate(method, params),
      async handle(context, params, binding) {
        const engine = await forProfile(binding!.profileId)
        const p = params as Record<string, any>
        try {
          switch (method) {
            case 'netEngine.status':
              return engine.status()
            case 'netEngine.enable':
              await engine.switchOn()
              return engine.status()
            case 'netEngine.disable':
              await engine.disable()
              return engine.status()
            case 'netEngine.invite': {
              await engine.tellName()
              const invite = await engine.pairing().invite(engine.ownName())
              // The window that showed the code closed, or switched profile: its invitation ends (§8).
              context.connection?.lifetime?.addEventListener(
                'abort',
                () => void engine.cancelInvite(invite.invitation),
                { once: true }
              )
              return invite
            }
            case 'netEngine.invite.cancel':
              await engine.pairing().cancelInvite(p.invitation)
              return engine.status()
            case 'netEngine.approve':
              await engine.tellName()
              await engine.pairing().approve(p.request, p.yes)
              return engine.status()
            case 'netEngine.join': {
              await engine.tellName()
              const row = await engine.pairing().join(p.ticket)
              return { node: row.localId, status: engine.status() }
            }
            case 'netEngine.retry':
              await engine.retry(p.node)
              return engine.status()
            case 'netEngine.remove':
              await engine.pairing().remove(p.node)
              return engine.status()
            case 'netEngine.address.add':
              await engine.addAddress(p.node, p.address)
              return engine.status()
            case 'netEngine.plus.signIn':
              return await engine.plus.signIn()
            case 'netEngine.plus.cancel':
              await engine.plus.cancelSignIn()
              return engine.status()
            case 'netEngine.plus.refresh':
              await engine.plus.refresh()
              return engine.status()
            case 'netEngine.plus.signOut':
              await engine.plus.signOut()
              return engine.status()
            case 'netEngine.removeEverywhere.plan': {
              const { identity } = engine.device(p.node)
              return { hosts: await engine.plus.plan(identity) }
            }
            case 'netEngine.removeEverywhere': {
              const { identity, name } = engine.device(p.node)
              await engine.plus.removeEverywhere(identity, name, p.hosts)
              return engine.status()
            }
            case 'netEngine.removeEverywhere.answer':
              await engine.plus.answer(p.identity, p.host, p.grant, p.yes)
              return engine.status()
          }
        } catch (error) {
          if (error instanceof NetError) {
            const entry = NET_ERRORS[error.code]
            throw new AppError(
              {
                code: error.code,
                message: error.message || entry.message,
                ...(error.details === undefined ? {} : { details: error.details }),
                errorInfo: { category: entry.category, retryable: entry.retryable }
              },
              error
            )
          }
          throw error
        }
      }
    })
}

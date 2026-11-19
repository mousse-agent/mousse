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
  'netEngine.address.remove': ['node', 'address'],
  'netEngine.address.use': ['node'],
  'netEngine.join.preview': ['ticket'],
  'netEngine.routes.test': ['route']
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === 'string')

/** `netEngine.routes.config`: only Reach's fields, each of its type. */
function reach(fields: Record<string, unknown>): void {
  const bad = (field: string) => new DomainRpcError('bad_request', `netEngine.routes.config: bad ${field}`)
  for (const key of Object.keys(fields))
    if (!['lan', 'tailnet', 'public', 'forwardTo', 'tunnels', 'port'].includes(key)) throw bad(key)
  for (const key of ['lan', 'tailnet'])
    if (fields[key] !== undefined && typeof fields[key] !== 'boolean') throw bad(key)
  for (const key of ['public', 'tunnels'])
    if (fields[key] !== undefined && !strings(fields[key])) throw bad(key)
  if (fields.forwardTo !== undefined && typeof fields.forwardTo !== 'string') throw bad('forwardTo')
  if (fields.port !== undefined && typeof fields.port !== 'number') throw bad('port')
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
  if (method === 'netEngine.approve' && typeof fields.yes !== 'boolean')
    throw new DomainRpcError('bad_request', `${method} needs yes`)
  if (method === 'netEngine.join' && fields.share !== undefined && !strings(fields.share))
    throw new DomainRpcError('bad_request', `${method} takes share as a list of addresses`)
  if (method === 'netEngine.routes.config') reach(fields)
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
              const row = await engine.join(p.ticket, p.share ?? [])
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
            case 'netEngine.address.remove':
              await engine.removeAddress(p.node, p.address)
              return engine.status()
            case 'netEngine.address.use':
              await engine.useOffered(p.node)
              return engine.status()
            case 'netEngine.join.preview':
              return engine.joinPreview(p.ticket)
            case 'netEngine.routes.config': {
              const { restarted } = await engine.setReach(p)
              return { restarted, status: engine.status() }
            }
            case 'netEngine.routes.test':
              return engine.testRoute(p.route)
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

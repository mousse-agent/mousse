import { AppError } from '../../shared/errors'
import { NET_LOCAL_CAPABILITY } from '../../shared/net/local'
import { NET_ERRORS, NetError } from '../../shared/net'
import { NET_ENGINE_LOCAL_METHODS, type NetEngineLocalMethod } from '../../shared/netEngine/local'
import { DomainRpcError, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { NetEngineService } from './NetEngineService'

/** Every method takes an object; these take nothing else. */
function validate(method: NetEngineLocalMethod, params: unknown): Record<string, unknown> {
  const value = params ?? {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new DomainRpcError('bad_request', `${method} takes an object`)
  return value as Record<string, unknown>
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
      async handle(_context, _params, binding) {
        const engine = await forProfile(binding!.profileId)
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

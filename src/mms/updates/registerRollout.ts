import { AppError } from '../../shared/errors'
import { NET_ERRORS, NetError } from '../../shared/net'
import { NET_LOCAL_CAPABILITY } from '../../shared/net/local'
import { isReleaseVersion } from '../../shared/remoteUpdates'
import { ROLLOUT_METHOD_LIST, ROLLOUT_METHODS, type RolloutMethod } from '../../shared/updateRollout'
import { DomainRpcError, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { UpdateRollouts } from './rollout'

type Method = RolloutMethod

const NODE = /^[0-9A-Za-z_.:-]{1,128}$/

function validate(method: Method, params: unknown): Record<string, unknown> {
  const fields = (params ?? {}) as Record<string, unknown>
  if (typeof fields !== 'object' || Array.isArray(fields)) throw new DomainRpcError('bad_request', `${method} takes an object`)
  const version = fields.version
  if ((method === ROLLOUT_METHODS.start || (method === ROLLOUT_METHODS.get && version !== undefined)) && !isReleaseVersion(version))
    throw new DomainRpcError('bad_request', `${method} needs a release version`)
  if (method === ROLLOUT_METHODS.retry && (typeof fields.node !== 'string' || !NODE.test(fields.node)))
    throw new DomainRpcError('bad_request', `${method} needs node`)
  if (method === ROLLOUT_METHODS.confirm) {
    const turns = fields.turns
    if (!turns || typeof turns !== 'object' || Array.isArray(turns) || Object.keys(turns).length > 256)
      throw new DomainRpcError('bad_request', `${method} needs turns`)
    for (const [node, count] of Object.entries(turns))
      if (!NODE.test(node) || !Number.isSafeInteger(count) || (count as number) < 0)
        throw new DomainRpcError('bad_request', `${method}: bad turns`)
  }
  return fields
}

/** Update everywhere (`updates.rollout.*`), for this computer's windows only. */
export function registerUpdateRolloutMethods(
  registry: DomainHandlerRegistry,
  forProfile: (id: string) => Promise<UpdateRollouts>
): void {
  for (const method of ROLLOUT_METHOD_LIST)
    registry.register({
      method,
      scope: 'profile',
      capability: NET_LOCAL_CAPABILITY,
      requiredCapabilities: [NET_LOCAL_CAPABILITY],
      validate: (params) => validate(method, params),
      async handle(_context, params, binding) {
        const rollouts = await forProfile(binding!.profileId)
        const p = params as Record<string, any>
        try {
          switch (method) {
            case ROLLOUT_METHODS.get:
              return await rollouts.view(p.version)
            case ROLLOUT_METHODS.start:
              return { rollout: await rollouts.start(p.version) }
            case ROLLOUT_METHODS.confirm:
              return { rollout: rollouts.confirm(p.turns) }
            case ROLLOUT_METHODS.cancel:
              await rollouts.cancel()
              return await rollouts.view()
            case ROLLOUT_METHODS.retry:
              return { rollout: rollouts.retry(p.node) }
            case ROLLOUT_METHODS.dismiss:
              rollouts.dismiss()
              return { rollout: null }
          }
        } catch (error) {
          if (error instanceof NetError) {
            const entry = NET_ERRORS[error.code]
            throw new AppError(
              {
                code: error.code,
                message: error.message || entry.message,
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

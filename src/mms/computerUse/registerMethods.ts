import type { ComputerUseStatus } from '../../shared/computerUse'
import { DomainRpcError, domainObject, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import type { ComputerUseDriver } from './ComputerUseDriver'

/**
 * Settings → Computer use: `computerUse.status` says whether Cua Driver is here (with `refresh`, it looks again now);
 * `computerUse.install` runs the official installer. Only a person at a window of this computer installs software.
 */
export function registerComputerUseMethods(domains: DomainHandlerRegistry, driverFor: (profileId: string) => Promise<ComputerUseDriver>): void {
  const bound = async (binding: { profileId: string } | undefined) => {
    if (!binding) throw new DomainRpcError('profile_required', 'Computer use needs a profile')
    return await driverFor(binding.profileId)
  }
  domains.register({
    method: 'computerUse.status',
    scope: 'profile',
    validate: (params) => {
      const raw = domainObject(params ?? {}, ['profileId', 'refresh'])
      return { refresh: raw.refresh === true }
    },
    handle: async (_context, params, binding): Promise<ComputerUseStatus> => await (await bound(binding)).status(params.refresh)
  })
  domains.register({
    method: 'computerUse.install',
    scope: 'profile',
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    handle: async (context: HandlerContext, _params, binding): Promise<ComputerUseStatus> => {
      if (context.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', 'Install Cua Driver from Settings → Computer use in a Mousse window on this computer.')
      return await (await bound(binding)).install()
    }
  })
}

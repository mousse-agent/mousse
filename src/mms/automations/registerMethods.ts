import { AUTOMATIONS_CAPABILITY, type AutomationIndex } from '../../shared/automations'
import { DomainRpcError, domainObject, type DomainHandlerRegistry } from '../protocol/domainRegistry'

/**
 * `automations.list`: the profile's automations in one read-only list (jobs, bot schedules, pull request watches).
 * The page refreshes it when the scheduler or a bot changes, and every 15 seconds while it is open.
 */
export function registerAutomationMethods(
  domains: DomainHandlerRegistry,
  indexFor: (profileId: string) => Promise<() => AutomationIndex>
): void {
  domains.register({
    method: 'automations.list',
    scope: 'profile',
    capability: AUTOMATIONS_CAPABILITY,
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    async handle(_context, _params, binding) {
      if (!binding) throw new DomainRpcError('profile_required', 'Automations need a profile')
      const index = await indexFor(binding.profileId)
      return index()
    }
  })
}

import { DomainRpcError, type TrustedProfileBinding } from '../protocol/domainRegistry'
import type { MmsProfileServices } from '../MmsProfileServices'
import { PROFILES_V1_CAPABILITY } from '../../shared/profiles/types'

const INSTALLATION_METHODS = new Set([
  'health',
  'capabilities',
  'daemon.shutdown',
  'events.subscribe',
  'providers.list',
  'providers.get',
  'providers.status',
  'providers.login',
  'providers.loginStatus',
  'providers.logout',
  'providers.setApiKey',
  'providers.deleteApiKey',
  'providers.getUsage',
  'gui.devtoolsPoll',
  'gui.devtoolsRespond'
])

export function isInstallationMethod(method: string): boolean {
  if (INSTALLATION_METHODS.has(method)) return true
  if (method.startsWith('profiles.')) return true
  if (method.startsWith('providers.')) return true
  return false
}

export async function resolveBoundServices(args: {
  installation: MmsProfileServices
  method: string
  binding?: TrustedProfileBinding
  capabilities: ReadonlySet<string>
}): Promise<{ services: MmsProfileServices; binding?: TrustedProfileBinding }> {
  if (isInstallationMethod(args.method)) {
    return { services: args.installation, binding: args.binding }
  }
  const host = args.installation.getInstallationHost()
  if (!host) return { services: args.installation, binding: args.binding }

  const activeCount = host.activeProfileCount()
  const hasProfiles = args.capabilities.has(PROFILES_V1_CAPABILITY)

  if (!args.binding) {
    if (activeCount <= 1) {
      const defaultId = host.getDefaultProfileId()
      return {
        services: args.installation,
        binding: { profileId: defaultId, epoch: 1 }
      }
    }
    throw new DomainRpcError(
      hasProfiles ? 'profile_binding_required' : 'upgrade_required',
      hasProfiles
        ? 'Bind this connection to a profile before personal operations'
        : 'Multiple profiles exist; upgrade the client and bind a profile'
    )
  }

  const record = host.manager.get(args.binding.profileId)
  if (record.status !== 'active') {
    throw new DomainRpcError('profile_archived', 'Bound profile is not active')
  }
  const services = await args.installation.getInstallationHost()!.getProfileServices(record.id)
  return { services, binding: args.binding }
}

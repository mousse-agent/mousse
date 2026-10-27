import { DomainRpcError, type TrustedProfileBinding } from '../protocol/domainRegistry'
import type { MmsProfileServices } from '../MmsProfileServices'
import { PROFILES_V1_CAPABILITY } from '../../shared/profiles/types'
import { BROWSER_SETUP_METHODS } from '../../shared/browser/setup'

const INSTALLATION_METHODS = new Set([
  ...BROWSER_SETUP_METHODS,
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
  'providers.deleteApiKey',
  'gui.devtoolsPoll',
  'gui.devtoolsRespond'
])

// These responses also contain profile-local ACP credentials/catalog state.
// The pi-ai credential service remains shared between profile service instances.
// The usage methods answer for the profile's own agents (its Codex entries) next to the shared pi-ai
// providers, so each profile sees only its own. Speech and usage refuse a provider removed from the
// bound profile (`providerAccess`), and the old Add dialog's key and sign-ins add a removed model
// API back to the bound profile, so they run on it too.
const PROFILE_PROVIDER_METHODS = new Set([
  'providers.getUsage', 'providers.getSubscriptionUsage',
  'providers.synthesizeSpeech', 'providers.transcribeAudio',
  'providers.listConfigured', 'providers.getLoginOptions', 'providers.refreshModels',
  'providers.loginOAuth', 'providers.loginApiKey', 'providers.verifyAmbient', 'providers.setApiKey', 'providers.logout',
  'providers.snapshots', 'providers.catalog.addOptions',
  'providers.instances.add', 'providers.instances.setSecret', 'providers.instances.remove',
  'providers.instances.configure', 'providers.instances.setEnabled', 'providers.instances.install',
  'providers.instances.cancelInstall', 'providers.instances.update',
  'providers.instances.signIn', 'providers.instances.respondSignIn', 'providers.instances.signOut',
  'providers.instances.recheck', 'providers.instances.refreshModels', 'providers.instances.refreshAllModels',
  'providers.instances.setModelPrefs',
  'providers.instances.move', 'providers.instances.removeInstall', 'providers.registry.search'
])

export function isInstallationMethod(method: string): boolean {
  if (PROFILE_PROVIDER_METHODS.has(method)) return false
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

import { harnessAppError, type HarnessCaps } from '../../../../../shared/harness/types'
import type { ConfiguredProvider } from '../../../../../shared/providerAuth'
import type { LlmProviderOption } from '../../../../../shared/settings'
import type { ProviderAuthService } from '../../../../providers/ProviderAuthService'
import { PI_LOOP_CAPABILITIES } from '../../../../run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../../../../run/adapters/ProviderAdapter'
import type { DriverRuntime } from '../../../driver'
import { runPiOneShot } from '../oneShot'

/** Mousse measures the pi loop's transcript itself and offers Plan mode on it. */
export const PI_LEGACY_CAPS: HarnessCaps = Object.freeze({
  ...PI_LOOP_CAPABILITIES,
  planMode: true,
  contextUsage: 'measured',
  // Mousse runs the pi loop's tools itself.
  toolControl: 'exact',
  // Spend is counted after each response; nothing refuses the next request yet.
  budgets: 'observed',
  spendLimits: 'unsupported'
})

export type PiCredentials = Partial<Pick<ProviderAuthService,
  'getConfiguredProviders' | 'getConfiguredLlmProviders' | 'has' | 'logout' | 'runOAuthLogin' | 'runApiKeyLogin' | 'refreshDynamicModels' | 'getProviderDisplayName' | 'storedApiKey' | 'models'
>>

/**
 * What every engine of a `pi:<provider>` instance shares: its provider's sign-in and models, as
 * the profile's credentials report them. The engine supplies the turn runtime.
 */
export function piInstanceRuntime(instanceId: string, providerId: string, credentials: () => PiCredentials | undefined, adapter: ProviderAdapter): DriverRuntime {
  const configuredProvider = (): ConfiguredProvider | undefined =>
    credentials()?.getConfiguredProviders?.().find((provider) => provider.id === providerId)
  const llmProvider = (): LlmProviderOption | undefined =>
    credentials()?.getConfiguredLlmProviders?.().find((provider) => provider.id === providerId)
  const signedIn = (): boolean => {
    try {
      return Boolean(providerId && credentials()?.has?.(providerId))
    } catch {
      return false
    }
  }
  return {
    adapter,
    configured: signedIn,
    configuredProvider,
    llmProvider,
    models: () => llmProvider()?.models ?? [],
    auth: async () => {
      const provider = configuredProvider()
      return signedIn()
        ? { state: 'signed_in', methodLabel: provider?.authType === 'api_key' ? 'API key' : provider?.source ?? 'Sign-in' }
        : { state: 'signed_out', methodLabel: 'API key or sign-in' }
    },
    refreshModels: async () => void (await credentials()?.refreshDynamicModels?.()),
    signIn: async (session, _cwd, method) => {
      const auth = credentials()
      if (!auth?.runOAuthLogin || !auth.runApiKeyLogin) return { success: false, error: 'Sign-in is not available' }
      return method === 'api_key' ? auth.runApiKeyLogin(session, providerId) : auth.runOAuthLogin(session, providerId)
    },
    signOut: async () => void (await credentials()?.logout?.(providerId)),
    exportApiKey: async () => credentials()?.storedApiKey?.(providerId),
    // Chat titles: one pi-ai request in Mousse's process, on either engine (`runPiOneShot`).
    oneShot: (spec, signal) => {
      const models = credentials()?.models
      if (!models) throw harnessAppError({ code: 'signed_out', message: 'Mousse has no provider credentials loaded yet.', instanceId })
      return runPiOneShot(models, providerId, spec, signal)
    },
    stop: () => {}
  }
}

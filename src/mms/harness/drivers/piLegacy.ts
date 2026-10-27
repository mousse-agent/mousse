import type { HarnessCaps } from '../../../shared/harness/types'
import type { ConfiguredProvider } from '../../../shared/providerAuth'
import type { LlmProviderOption } from '../../../shared/settings'
import { piProviderIdOf } from '../../../shared/providerInstances'
import type { ProviderAuthService } from '../../providers/ProviderAuthService'
import { PI_LOOP_CAPABILITIES, PiLoopAdapter, type PiChatClient } from '../../run/adapters/pi/PiLoopAdapter'
import { harnessAppError } from '../../../shared/harness/types'
import { decodeInstanceConfig, type DriverContext, type DriverRuntime, type HarnessDriver } from '../driver'
import { runPiOneShot } from './pi/oneShot'

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
 * The in-process pi-ai loop (`LlmClient`). Every `pi:<provider>` instance runs on it unchanged;
 * the loop and its credentials are shared by the profile, so the runtime of each instance is a
 * view of its provider's sign-in and models.
 */
export function piLegacyDriver(options: { client: () => PiChatClient; credentials?: () => PiCredentials | undefined }): HarnessDriver {
  // One loop adapter for every pi instance: the loop resolves the provider per turn.
  const adapter = new PiLoopAdapter(options.client)
  return {
    kind: 'pi',
    label: 'Mousse agent',
    binaryNames: [],
    multiInstance: false,
    privateHome: false,
    canInstall: false,
    // The loop runs a custom model with its provider's transport (`customModelDefinition`).
    customModels: true,
    // Chat titles: one pi-ai request in Mousse's process (`runPiOneShot`).
    oneShot: true,
    methodLabel: 'API key or sign-in',
    // The pi loop calls the app tools in process and proxies the user's MCP servers.
    userMcp: 'proxy',
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    caps: () => PI_LEGACY_CAPS,
    create(context: DriverContext): DriverRuntime {
      const providerId = piProviderIdOf(context.instanceId) ?? ''
      const credentials = () => options.credentials?.()
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
        oneShot: (spec, signal) => {
          const models = credentials()?.models
          if (!models) throw harnessAppError({ code: 'signed_out', message: 'Mousse has no provider credentials loaded yet.', instanceId: context.instanceId })
          return runPiOneShot(models, providerId, spec, signal)
        },
        stop: () => {}
      }
    }
  }
}

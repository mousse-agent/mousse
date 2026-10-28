import { harnessAppError } from '../../../../shared/harness/types'
import type { CredentialKind } from '../../../../shared/harness/status'
import type { ConfiguredProvider } from '../../../../shared/providerAuth'
import type { LlmProviderOption } from '../../../../shared/settings'
import type { ProviderAuthService } from '../../../providers/ProviderAuthService'
import type { ProviderAdapter } from '../../adapter'
import type { DriverRuntime } from '../../driver'
import { PI_AMBIENT_MARKER, piAmbientProvider } from '../../pi/envKeys'
import { runPiOneShot } from './oneShot'

export type PiCredentials = Partial<Pick<ProviderAuthService,
  'getConfiguredProviders' | 'getConfiguredLlmProviders' | 'has' | 'logout' | 'runOAuthLogin' | 'runApiKeyLogin' | 'refreshDynamicModels' | 'getProviderDisplayName' | 'storedApiKey' | 'models'
  | 'setApiKey' | 'verifyAmbientProvider' | 'getLoginOptions' | 'getAmbientProviderInfo'
>>

/**
 * What a `pi:<provider>` instance shares with Pi's agent: its provider's sign-in and models, as the
 * profile's credentials report them. The engine supplies the turn runtime.
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
  /**
   * What a signed-in instance runs on, by its stored credential: a subscription sign-in, the
   * environment's cloud credentials (only Bedrock's or Vertex's ambient marker), or a key. A real key
   * saved for Bedrock or Vertex is a key; a stored credential that cannot be read is `unknown`.
   */
  const piCredential = (provider: ConfiguredProvider | undefined): CredentialKind => {
    if (provider?.authType === 'oauth') return 'subscription'
    if (!piAmbientProvider(providerId)) return 'api_key'
    let key: string | undefined
    try {
      key = credentials()?.storedApiKey?.(providerId)
    } catch {
      return 'unknown'
    }
    if (key === undefined) return 'unknown'
    return key === PI_AMBIENT_MARKER ? 'ambient' : 'api_key'
  }
  return {
    adapter,
    configured: signedIn,
    configuredProvider,
    llmProvider,
    models: () => llmProvider()?.models ?? [],
    auth: async () => {
      const provider = configuredProvider()
      if (!signedIn()) return { state: 'signed_out', methodLabel: 'API key or sign-in' }
      return { state: 'signed_in', methodLabel: provider?.authType === 'api_key' ? 'API key' : provider?.source ?? 'Sign-in', credential: piCredential(provider) }
    },
    refreshModels: async () => void (await credentials()?.refreshDynamicModels?.()),
    signIn: async (session, _cwd, method) => {
      const auth = credentials()
      // The environment's cloud credentials, checked and saved as the provider's credential.
      if (method === 'ambient') {
        if (!auth?.verifyAmbientProvider) return { success: false, error: 'Sign-in is not available' }
        return { ...(await auth.verifyAmbientProvider(providerId)), sessionId: session.sessionId }
      }
      if (!auth?.runOAuthLogin || !auth.runApiKeyLogin) return { success: false, error: 'Sign-in is not available' }
      const result = await (method === 'api_key' ? auth.runApiKeyLogin(session, providerId) : auth.runOAuthLogin(session, providerId))
      // A new sign-in may unlock models listed only for it (as the old sign-in methods refreshed them).
      if (result.success) await auth.refreshDynamicModels?.().catch(() => undefined)
      return result
    },
    signOut: async () => void (await credentials()?.logout?.(providerId)),
    // The key is installation-scoped, as the old Add dialog saved it: every profile with this entry uses it.
    setSecret: async (value) => {
      const auth = credentials()
      if (!auth?.setApiKey) throw new Error('Mousse has no provider credentials loaded yet.')
      await auth.setApiKey(providerId, value)
      await auth.refreshDynamicModels?.().catch(() => undefined)
    },
    exportApiKey: async () => credentials()?.storedApiKey?.(providerId),
    // Chat titles: one pi-ai request in Mousse's process (`runPiOneShot`).
    oneShot: (spec, signal) => {
      const models = credentials()?.models
      if (!models) throw harnessAppError({ code: 'signed_out', message: 'Mousse has no provider credentials loaded yet.', instanceId })
      return runPiOneShot(models, providerId, spec, signal)
    },
    stop: () => {}
  }
}

import { harnessAppError } from '../../../../shared/harness/types'
import type { CredentialKind } from '../../../../shared/harness/status'
import type { ConfiguredProvider } from '../../../../shared/providerAuth'
import type { LlmProviderOption } from '../../../../shared/settings'
import type { ProviderAuthService } from '../../../providers/ProviderAuthService'
import type { ProviderAdapter } from '../../adapter'
import type { DriverRuntime } from '../../driver'
import { PI_AMBIENT_MARKER, piAmbientProvider } from '../../pi/envKeys'
import { piImageModels, runPiImage } from './images'
import { PI_WORKER_APIS, piOneShotModel, runPiOneShot } from './oneShot'
import { getCacheSessionId } from './stream'
import { piWorkerTransport, type StoredBedrockCredential } from './workerOneShot'

export type PiCredentials = Partial<Pick<ProviderAuthService,
  'getConfiguredProviders' | 'getConfiguredLlmProviders' | 'has' | 'logout' | 'runOAuthLogin' | 'runApiKeyLogin' | 'refreshDynamicModels' | 'getProviderDisplayName' | 'storedApiKey' | 'models'
  | 'setApiKey' | 'verifyAmbientProvider' | 'getLoginOptions' | 'getAmbientProviderInfo' | 'local' | 'localChanged' | 'credentials'
>>

/** What a single request in Pi's worker (`pi:worker`) is started with: the entry's place, environment and worker entry. */
export interface PiWorkerContext {
  profileHome: string
  /** Mousse's environment for the entry. */
  env: NodeJS.ProcessEnv
  /** The built worker entry; undefined in a build without one. */
  script: string | undefined
  /** Test seam: variables for the worker. */
  workerEnv?: Readonly<Record<string, string>>
}

/**
 * What a `pi:<provider>` instance shares with Pi's agent: its provider's sign-in and models, as the
 * profile's credentials report them. The engine supplies the turn runtime.
 */
export function piInstanceRuntime(instanceId: string, providerId: string, credentials: () => PiCredentials | undefined, adapter: ProviderAdapter, worker?: PiWorkerContext): DriverRuntime {
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
    // A local server's list is read from that server only, never with the shared catalogue's refresh.
    refreshModels: async () => {
      const auth = credentials()
      if (auth?.local?.has(providerId)) {
        if (await auth.local.refresh(providerId)) auth.localChanged?.()
        return
      }
      await auth?.refreshDynamicModels?.()
    },
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
      if (auth.local?.has(providerId)) {
        if (await auth.local.refresh(providerId).catch(() => false)) auth.localChanged?.()
        return
      }
      await auth.refreshDynamicModels?.().catch(() => undefined)
    },
    exportApiKey: async () => credentials()?.storedApiKey?.(providerId),
    // `pi:direct`: one pi-ai request in Mousse's process (`runPiOneShot`), carrying the runner's request once; a Bedrock
    // model's in Pi's worker (`pi:worker`), never in Mousse's process.
    oneShotTransport: (spec) => ({
      send: async (wire, events, signal) => {
        const models = credentials()?.models
        if (!models) throw harnessAppError({ code: 'signed_out', message: 'Mousse has no provider credentials loaded yet.', instanceId })
        const { model, effort } = piOneShotModel(models, providerId, spec)
        if (PI_WORKER_APIS.has(model.api)) {
          if (!worker) throw harnessAppError({ code: 'unsupported', reason: 'not_admitted', message: 'This build of Mousse has no Pi worker, so it cannot run single requests on this model.', instanceId })
          const level = spec.effort ?? effort
          const transport = piWorkerTransport({
            label: credentials()?.getProviderDisplayName?.(providerId) ?? providerId,
            instanceId,
            profileHome: worker.profileHome,
            script: worker.script,
            execPath: process.execPath,
            baseEnv: worker.env,
            credential: () => storedCredential(credentials(), providerId),
            ...(worker.workerEnv ? { workerEnv: worker.workerEnv } : {})
          }, () => ({
            model,
            ...(level && level !== 'off' && model.reasoning ? { reasoning: level } : {}),
            ...(spec.sessionKey ? { sessionId: getCacheSessionId(spec.sessionKey) } : {})
          }))
          return transport.send(wire, events, signal)
        }
        const { text } = await runPiOneShot(models, providerId, { ...spec, system: wire.system, prompt: wire.prompt, onActivity: () => events.activity(), onText: (chunk) => events.text(chunk), beforeSend: () => events.sending() }, signal)
        return text
      }
    }),
    // A bot's pictures (#1088): the provider's image models in pi-ai's catalogue, one request in Mousse's process.
    imageModels: () => {
      const models = credentials()?.models
      return models && signedIn() ? piImageModels(models, providerId) : []
    },
    generateImage: (spec, signal) => {
      const models = credentials()?.models
      if (!models) throw harnessAppError({ code: 'signed_out', message: 'Mousse has no provider credentials loaded yet.', instanceId })
      return runPiImage(models, providerId, spec, signal)
    },
    stop: () => {}
  }
}

/** The entry's stored credential as pi-ai's store keeps it: its key and its scoped variables. */
function storedCredential(auth: PiCredentials | undefined, providerId: string): StoredBedrockCredential | undefined {
  const stored = auth?.credentials?.get(providerId) as { type?: unknown; key?: unknown; env?: unknown } | undefined
  if (!stored || stored.type !== 'api_key') return undefined
  const env = stored.env && typeof stored.env === 'object'
    ? Object.fromEntries(Object.entries(stored.env as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined
  return { ...(typeof stored.key === 'string' && stored.key ? { key: stored.key } : {}), ...(env ? { env } : {}) }
}

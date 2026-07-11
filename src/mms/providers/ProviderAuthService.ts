import { join } from 'path'
import type { ApiKeyCredential, Credential, MutableModels } from '@earendil-works/pi-ai'
import { getEnvApiKey, getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat'
import { getModelEffortLevels } from '../../shared/modelEfforts'
import { getCursorModelMetadata } from 'pi-cursor-sdk/src/model-discovery'
import { builtinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { getOAuthProvider, getOAuthProviders } from '@earendil-works/pi-ai/oauth'
import type { LlmProviderOption } from '../../shared/settings'
import type {
  AmbientProviderInfo,
  ConfiguredProvider,
  ProviderLoginOption,
  ProviderLoginResult
} from '../../shared/providerAuth'
import { getMousseHomeDir } from '../data/paths'
import {
  CURSOR_PROVIDER_ID,
  refreshCursorPiProvider,
  registerCursorPiProvider
} from './cursorPiProvider'
import { FileCredentialStore } from './FileCredentialStore'
import { LoginSession } from './LoginSession'

const MOUSSE_AUTH_PATH = join(getMousseHomeDir(), 'auth.json')

const AMBIENT_PROVIDERS: Record<string, AmbientProviderInfo> = {
  'amazon-bedrock': {
    id: 'amazon-bedrock',
    label: 'Amazon Bedrock',
    instructions: [
      'Amazon Bedrock uses AWS credentials instead of a single API key.',
      'Set AWS_PROFILE, or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or AWS_BEARER_TOKEN_BEDROCK in your environment.',
      'Optionally set AWS_REGION (defaults to us-east-1).'
    ]
  },
  'google-vertex': {
    id: 'google-vertex',
    label: 'Google Vertex AI',
    instructions: [
      'Vertex AI uses Google Application Default Credentials.',
      'Run: gcloud auth application-default login',
      'Set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION in your environment.'
    ]
  }
}

type ProviderAuthTypeFilter = 'api_key' | 'oauth'

export class ProviderAuthService {
  readonly credentials: FileCredentialStore
  readonly models: MutableModels
  private activeSessions = new Map<string, LoginSession>()
  private initPromise: Promise<void> | null = null

  constructor() {
    this.credentials = new FileCredentialStore(MOUSSE_AUTH_PATH)
    this.models = builtinModels({ credentials: this.credentials })
  }

  init(): Promise<void> {
    this.initPromise ??= registerCursorPiProvider(this.models, this.credentials)
    return this.initPromise
  }

  private async refreshCursorProvider(forceRefresh = true): Promise<void> {
    await refreshCursorPiProvider(this.models, this.credentials, forceRefresh)
  }

  createSession(): LoginSession {
    const session = new LoginSession(crypto.randomUUID())
    this.activeSessions.set(session.sessionId, session)
    session.abort.signal.addEventListener('abort', () => {
      this.activeSessions.delete(session.sessionId)
    })
    return session
  }

  getSession(sessionId: string): LoginSession | undefined {
    return this.activeSessions.get(sessionId)
  }

  endSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId)
    session?.abort.abort()
    this.activeSessions.delete(sessionId)
  }

  has(providerId: string): boolean {
    return this.credentials.has(providerId)
  }

  getProviderDisplayName(providerId: string): string {
    const provider = this.models.getProvider(providerId) ?? builtinProviders().find((p) => p.id === providerId)
    const oauthProvider = getOAuthProviders().find((p) => p.id === providerId)
    return provider?.name ?? oauthProvider?.name ?? providerId
  }

  getConfiguredProviders(): ConfiguredProvider[] {
    return this.credentials
      .listProviderIds()
      .map((id) => {
        const credential = this.credentials.get(id)
        return {
          id,
          label: this.getProviderDisplayName(id),
          authType: credential?.type === 'oauth' ? 'oauth' : 'api_key',
          source: 'stored'
        } satisfies ConfiguredProvider
      })
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  getConfiguredLlmProviders(): LlmProviderOption[] {
    const configuredIds = this.credentials.listProviderIds()
    if (configuredIds.length === 0) return []

    return configuredIds
      .map((id) => {
        const models = this.models
          .getModels(id)
          .map((model) => {
            const metadata = id === CURSOR_PROVIDER_ID ? getCursorModelMetadata(model.id) : undefined
            const effortSources = metadata
              ? [metadata, model]
              : [model]
            let efforts: string[] | undefined
            for (const source of effortSources) {
              efforts =
                getModelEffortLevels(source) ??
                ('reasoning' in source && source.reasoning
                  ? getSupportedThinkingLevels(source as typeof model).filter((level) => level !== 'off')
                  : undefined)
              if (efforts && efforts.length > 0) break
            }

            return {
              id: model.id,
              label: model.name,
              ...(efforts && efforts.length > 0 ? { efforts } : {})
            }
          })

        return {
          id,
          label: this.getProviderDisplayName(id),
          models
        } satisfies LlmProviderOption
      })
      .filter((provider) => provider.models.length > 0)
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  getLoginOptions(authType?: ProviderAuthTypeFilter): ProviderLoginOption[] {
    const oauthIds = new Set(getOAuthProviders().map((provider) => provider.id))
    const options: ProviderLoginOption[] = []

    if (!authType || authType === 'oauth') {
      for (const provider of getOAuthProviders()) {
        options.push({
          id: provider.id,
          label: provider.name,
          authType: 'oauth',
          configured: this.credentials.has(provider.id)
        })
      }
    }

    if (!authType || authType === 'api_key') {
      const providerIds = new Set(this.models.getModels().map((model) => model.provider))
      for (const id of providerIds) {
        if (oauthIds.has(id)) continue
        options.push({
          id,
          label: this.getProviderDisplayName(id),
          authType: 'api_key',
          configured: this.credentials.has(id),
          ambient: id in AMBIENT_PROVIDERS
        })
      }
    }

    return options.sort((a, b) => a.label.localeCompare(b.label))
  }

  getAmbientProviderInfo(providerId: string): AmbientProviderInfo | undefined {
    return AMBIENT_PROVIDERS[providerId]
  }

  async runOAuthLogin(session: LoginSession, providerId: string): Promise<ProviderLoginResult> {
    const oauthProvider = getOAuthProvider(providerId)

    if (!oauthProvider) {
      return { success: false, error: `Unknown subscription provider: ${providerId}` }
    }

    try {
      const credentials = await oauthProvider.login(
        session.createOAuthCallbacks(oauthProvider.usesCallbackServer ?? false)
      )
      await this.credentials.modify(providerId, async () => ({
        type: 'oauth',
        ...credentials
      }))
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message, sessionId: session.sessionId }
    }
  }

  async runApiKeyLogin(session: LoginSession, providerId: string): Promise<ProviderLoginResult> {
    if (providerId in AMBIENT_PROVIDERS) {
      return this.verifyAmbientProvider(providerId)
    }

    const provider = this.models.getProvider(providerId) ?? builtinProviders().find((entry) => entry.id === providerId)

    try {
      const rawCredential = provider?.auth.apiKey?.login
        ? await provider.auth.apiKey.login(session.createAuthCallbacks())
        : await this.promptApiKey(session, providerId)

      await this.credentials.modify(providerId, async () => toApiKeyCredential(rawCredential))
      if (providerId === CURSOR_PROVIDER_ID) {
        await this.refreshCursorProvider()
      }
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message, sessionId: session.sessionId }
    }
  }

  private async promptApiKey(session: LoginSession, providerId: string): Promise<ApiKeyCredential> {
    const label = this.getProviderDisplayName(providerId)
    const callbacks = session.createAuthCallbacks()
    const key = await callbacks.prompt({
      type: 'secret',
      message: `Enter API key for ${label}`
    })
    return { type: 'api_key', key }
  }

  async setApiKey(providerId: string, apiKey: string, env?: Record<string, string>): Promise<void> {
    const trimmed = apiKey.trim()
    if (!trimmed) {
      throw new Error('API key cannot be empty')
    }
    await this.credentials.modify(providerId, async () => ({
      type: 'api_key',
      key: trimmed,
      ...(env && Object.keys(env).length > 0 ? { env } : {})
    }))
    if (providerId === CURSOR_PROVIDER_ID) {
      await this.refreshCursorProvider()
    }
  }

  async verifyAmbientProvider(providerId: string): Promise<ProviderLoginResult> {
    const apiKey = getEnvApiKey(providerId)
    if (!apiKey) {
      const info = AMBIENT_PROVIDERS[providerId]
      return {
        success: false,
        error: `${info?.label ?? providerId} credentials were not detected in the environment.`
      }
    }

    await this.credentials.modify(providerId, async () => ({ type: 'api_key', key: apiKey }))
    return { success: true }
  }

  async logout(providerId: string): Promise<void> {
    await this.credentials.delete(providerId)
  }
}

function toApiKeyCredential(raw: ApiKeyCredential): Credential {
  return {
    type: 'api_key',
    key: raw.key ?? '',
    ...(raw.env ? { env: raw.env } : {})
  }
}

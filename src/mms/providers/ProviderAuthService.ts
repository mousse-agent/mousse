import { dirname, join } from 'path'
import type { ApiKeyCredential, Credential, MutableModels } from '@earendil-works/pi-ai'
import { getEnvApiKey, getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat'
import { getModelEffortLevels } from '../../shared/modelEfforts'
import { getCursorModelMetadata } from 'pi-cursor-sdk/src/model-discovery'
import { builtinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { LlmProviderOption } from '../../shared/settings'
import type {
  AmbientProviderInfo,
  ConfiguredProvider,
  ProviderLoginOption,
  ProviderLoginResult,
  ProvidersUsageResponse,
  ProviderUsageWindow
} from '../../shared/providerAuth'
import { getMousseHomeDir } from '../data/paths'
import {
  isClaudeSubscriptionToken,
  CLAUDE_PROVIDER_ID,
  registerClaudeSdkProvider
} from './claudeSdkProvider'
import {
  CURSOR_PROVIDER_ID,
  registerCursorPiProvider
} from './cursorPiProvider'
import { FileCredentialStore } from './FileCredentialStore'
import { FileModelsStore } from './FileModelsStore'
import { LoginSession } from './LoginSession'
import { enhanceProvidersWithOpenAiCompatibleFetch } from './openAiCompatibleModelFetch'
import { enhanceOpenAiCodexProvider } from './openAiCodexModelFetch'
import { PiCatalogOverlay } from './piCatalogOverlay'
import { getProviderDisplayName as getProductProviderDisplayName } from './providerMetadata'
import { fetchGrokCreditsViaGrpc, grokCliBillingHeaders } from './xaiBilling'

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

/** Providers whose apiKey.login needs multiple prompts (not a single secret field). */
const GUIDED_API_KEY_PROVIDERS = new Set([
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai'
])

type ProviderAuthTypeFilter = 'api_key' | 'oauth'

/** How often to re-fetch dynamic provider model catalogs (Cursor, OpenAI-compatible, Radius, …). */
const DYNAMIC_MODELS_REFRESH_MS = 5 * 60_000
/** Upper bounds so a hung endpoint cannot stall later refreshes forever. */
const CATALOG_REFRESH_TIMEOUT_MS = 60_000

export class ProviderAuthService {
  readonly credentials: FileCredentialStore
  readonly models: MutableModels
  private readonly modelsStore: FileModelsStore
  private readonly catalogOverlay: PiCatalogOverlay
  private readonly catalogListeners = new Set<() => void>()
  private catalogSignature = ''
  private activeSessions = new Map<string, LoginSession>()
  private initPromise: Promise<void> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private refreshInFlight: Promise<void> | null = null
  private refreshQueued: Promise<void> | null = null
  private refreshController: AbortController | null = null
  private stopped = false

  constructor(authPath = join(getMousseHomeDir(), 'auth.json')) {
    const home = dirname(authPath)
    this.credentials = new FileCredentialStore(authPath)
    this.modelsStore = new FileModelsStore(join(home, 'models-cache.json'))
    this.models = builtinModels({ credentials: this.credentials, modelsStore: this.modelsStore })
    enhanceProvidersWithOpenAiCompatibleFetch(this.models.getProviders())
    enhanceOpenAiCodexProvider(this.models.getProvider('openai-codex'))
    this.catalogOverlay = new PiCatalogOverlay(join(home, 'pi-catalog-cache.json'))
    for (const provider of this.models.getProviders()) {
      // Anthropic is replaced by the Claude SDK provider, whose catalog is live.
      if (provider.id !== CLAUDE_PROVIDER_ID) this.catalogOverlay.attach(provider)
    }
  }

  /**
   * Ready the catalog without network access: register SDK-backed providers and
   * restore persisted dynamic catalogs. Network refreshes run in the background
   * and announce changes through `onCatalogChanged`.
   */
  init(): Promise<void> {
    this.initPromise ??= (async () => {
      const cachedClaude = await this.modelsStore.read(CLAUDE_PROVIDER_ID).catch(() => undefined)
      await registerClaudeSdkProvider(this.models, this.credentials, {
        allowNetwork: false,
        cached: cachedClaude?.models
      })
      await registerCursorPiProvider(this.models, this.credentials, { allowNetwork: false })
      try {
        await this.models.refresh({ allowNetwork: false })
      } catch {
        // Best-effort; static catalogs remain available.
      }
      this.catalogSignature = this.computeCatalogSignature()
      this.startPeriodicRefresh()
      if (!this.refreshInFlight) void this.refreshDynamicModels().catch(() => undefined)
    })()
    return this.initPromise
  }

  /** Subscribe to catalog changes found by background refreshes. */
  onCatalogChanged(listener: () => void): () => void {
    this.catalogListeners.add(listener)
    return () => this.catalogListeners.delete(listener)
  }

  /** Stop background catalog polling (called when MMS shuts down). */
  stop(): void {
    this.stopped = true
    this.refreshController?.abort()
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    this.catalogListeners.clear()
  }

  private startPeriodicRefresh(): void {
    if (this.stopped || this.refreshTimer) return
    this.refreshTimer = setInterval(() => {
      void this.refreshDynamicModels().catch(() => undefined)
    }, DYNAMIC_MODELS_REFRESH_MS)
    // Unref so the timer alone does not keep a headless process alive.
    this.refreshTimer.unref?.()
  }

  /**
   * Network refresh of every provider with a dynamic model list, plus the
   * published pi-ai catalog overlay. A call made while a refresh is running
   * queues one follow-up so new credentials are never skipped.
   */
  refreshDynamicModels(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.refreshInFlight) {
      this.refreshQueued ??= this.refreshInFlight.catch(() => undefined).then(() => {
        this.refreshQueued = null
        return this.refreshDynamicModels()
      })
      return this.refreshQueued
    }
    this.refreshInFlight = (async () => {
      await this.init()
      if (this.stopped) return
      const controller = new AbortController()
      this.refreshController = controller
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS)])
      try {
        // pi-ai fences catalog/cache publication after abort, including SDKs
        // whose underlying request cannot be cancelled. Register providers only
        // once at startup so late discovery cannot replace a newer provider.
        await Promise.all([
          this.models.refresh({ allowNetwork: true, signal }),
          this.catalogOverlay.refresh({ signal }).catch(() => false)
        ])
        if (!this.stopped) this.notifyIfCatalogChanged()
      } finally {
        this.refreshController = null
      }
    })().finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  private computeCatalogSignature(): string {
    return JSON.stringify(this.models.getProviders().map((provider) => ({
      id: provider.id,
      models: this.models.getModels(provider.id)
    })))
  }

  private notifyIfCatalogChanged(): void {
    const signature = this.computeCatalogSignature()
    if (signature === this.catalogSignature) return
    this.catalogSignature = signature
    for (const listener of this.catalogListeners) {
      try {
        listener()
      } catch {
        // A failing subscriber must not break catalog refresh.
      }
    }
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
    if (providerId === 'anthropic') {
      const credential = this.credentials.get(providerId)
      return credential?.type === 'api_key' && Boolean(credential.key) && !isClaudeSubscriptionToken(credential.key)
    }
    return this.credentials.has(providerId)
  }

  getProviderDisplayName(providerId: string): string {
    const provider = this.models.getProvider(providerId) ?? builtinProviders().find((p) => p.id === providerId)
    return getProductProviderDisplayName(providerId, provider?.name)
  }

  getConfiguredProviders(): ConfiguredProvider[] {
    return this.credentials
      .listProviderIds()
      .filter((id) => !id.startsWith('web-tool:'))
      .map((id) => {
        const credential = this.credentials.get(id)
        const legacyClaude = id === 'anthropic' && !this.has(id)
        return {
          id,
          label: this.getProviderDisplayName(id),
          authType: credential?.type === 'oauth' ? 'oauth' : 'api_key',
          source: legacyClaude ? 'unsupported credential; remove' : 'stored'
        } satisfies ConfiguredProvider
      })
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  /**
   * Reads never trigger network work: a refresh would supersede (abort) one
   * already in flight. Startup, the periodic timer and credential changes
   * refresh instead; this only ensures offline init has run.
   */
  private ensureCatalogInitialized(): void {
    void this.init().catch(() => undefined)
  }

  private toLlmProviderOption(id: string): LlmProviderOption | null {
    const models = this.models.getModels(id).map((model) => {
      const metadata = id === CURSOR_PROVIDER_ID ? getCursorModelMetadata(model.id) : undefined
      const effortSources = metadata ? [metadata, model] : [model]
      let efforts: string[] | undefined
      for (const source of effortSources) {
        efforts =
          getModelEffortLevels(source) ??
          ('reasoning' in source && source.reasoning
            ? getSupportedThinkingLevels(source as typeof model).filter((level) => level !== 'off')
            : undefined)
        if (efforts && efforts.length > 0) break
      }

      const speed = metadata?.supportsFast
        ? (metadata.fastOverride ?? metadata.defaultFast) ? 'fast' as const : 'slow' as const
        : undefined
      return {
        id: model.id,
        label: model.name,
        ...(efforts && efforts.length > 0 ? { efforts } : {}),
        ...(speed ? { speed } : {})
      }
    })
    if (models.length === 0) return null
    return {
      id,
      label: this.getProviderDisplayName(id),
      models
    }
  }

  /** Live catalogs for every registered provider, including ones without stored credentials. */
  getCatalogLlmProviders(): LlmProviderOption[] {
    this.ensureCatalogInitialized()
    return this.models
      .getProviders()
      .map((provider) => this.toLlmProviderOption(provider.id))
      .filter((provider): provider is LlmProviderOption => provider !== null)
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  getConfiguredLlmProviders(): LlmProviderOption[] {
    const configuredIds = this.credentials.listProviderIds().filter((id) => this.has(id))
    if (configuredIds.length === 0) return []

    this.ensureCatalogInitialized()

    return configuredIds
      .map((id) => this.toLlmProviderOption(id))
      .filter((provider): provider is LlmProviderOption => provider !== null)
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  getLoginOptions(authType?: ProviderAuthTypeFilter): ProviderLoginOption[] {
    const options: ProviderLoginOption[] = []
    const seen = new Set<string>()

    const pushOption = (option: ProviderLoginOption) => {
      const key = `${option.id}:${option.authType}`
      if (seen.has(key)) return
      seen.add(key)
      options.push(option)
    }

    // Every registered Models provider — include dual-auth as separate options.
    for (const provider of this.models.getProviders()) {
      const id = provider.id
      const configured = this.has(id)
      const label = this.getProviderDisplayName(id)
      const apiKeyAuth = provider.auth?.apiKey
      const oauthAuth = provider.auth?.oauth

      if ((!authType || authType === 'api_key') && apiKeyAuth) {
        const ambient = id in AMBIENT_PROVIDERS
        pushOption({
          id,
          label,
          authType: 'api_key',
          configured,
          ambient,
          description: ambient
            ? 'Environment credentials'
            : (apiKeyAuth.name ?? 'API key'),
          guidedLogin: !ambient && GUIDED_API_KEY_PROVIDERS.has(id)
        })
      }

      if ((!authType || authType === 'oauth') && oauthAuth && id !== 'anthropic') {
        pushOption({
          id,
          label,
          authType: 'oauth',
          configured,
          description: oauthAuth.name ?? 'Subscription / OAuth',
          guidedLogin: true
        })
      }
    }

    // Ambient-only catalog entries that may not be registered on Models yet.
    if (!authType || authType === 'api_key') {
      for (const ambient of Object.values(AMBIENT_PROVIDERS)) {
        pushOption({
          id: ambient.id,
          label: ambient.label,
          authType: 'api_key',
          configured: this.credentials.has(ambient.id),
          ambient: true,
          description: 'Environment credentials'
        })
      }
    }

    return options.sort((a, b) => {
      const byLabel = a.label.localeCompare(b.label)
      if (byLabel !== 0) return byLabel
      return a.authType.localeCompare(b.authType)
    })
  }

  getAmbientProviderInfo(providerId: string): AmbientProviderInfo | undefined {
    return AMBIENT_PROVIDERS[providerId]
  }

  async runOAuthLogin(session: LoginSession, providerId: string): Promise<ProviderLoginResult> {
    if (providerId === 'anthropic') {
      return { success: false, error: 'Claude subscription sign-in belongs to the official Claude Code agent, not the Anthropic Messages provider.' }
    }
    const provider = this.models.getProvider(providerId)
    const oauthProvider = provider?.auth.oauth

    if (!oauthProvider) {
      return { success: false, error: `Unknown subscription provider: ${providerId}` }
    }

    try {
      const credentials = await oauthProvider.login(session.createAuthCallbacks())
      await this.credentials.modify(providerId, async () => credentials)
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

      const credential = toApiKeyCredential(rawCredential)
      if (providerId === 'anthropic' && isClaudeSubscriptionToken(credential.key)) {
        throw new Error('Claude subscription credentials cannot be used as an Anthropic API key.')
      }
      await this.credentials.modify(providerId, async () => credential)
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
    if (providerId === 'anthropic' && isClaudeSubscriptionToken(trimmed)) {
      throw new Error('Claude subscription credentials cannot be used as an Anthropic API key.')
    }
    await this.credentials.modify(providerId, async () => ({
      type: 'api_key',
      key: trimmed,
      ...(env && Object.keys(env).length > 0 ? { env } : {})
    }))
  }

  async verifyAmbientProvider(providerId: string): Promise<ProviderLoginResult> {
    const apiKey = getEnvApiKey(providerId)
    if (providerId === 'anthropic' && isClaudeSubscriptionToken(apiKey)) {
      return { success: false, error: 'Claude subscription credentials cannot be used as an Anthropic API key.' }
    }
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

  /** Fetch subscription limits daemon-side; credentials never cross the protocol boundary. */
  async getUsage(): Promise<ProvidersUsageResponse> {
    // Keep every configured provider in the response so the usage view is a complete
    // provider inventory (providers without a quota API are explicitly marked unavailable).
    const configuredProviders = this.getConfiguredProviders()
    const providers = await Promise.all(
      configuredProviders.map(async (provider) => {
        if (provider.id === 'anthropic') return {
          ...provider,
          status: 'unavailable' as const,
          windows: [],
          message: 'Anthropic API key usage is billed through Claude Console; quota data is unavailable here.'
        }
        if (provider.id === 'openai-codex') return this.fetchOpenAiCodexUsage(provider)
        if (provider.id === 'xai') return this.fetchXaiUsage(provider)
        if (provider.id === 'opencode-go') return this.fetchOpenCodeGoUsage(provider)
        return {
          ...provider,
          status: 'unavailable' as const,
          windows: [],
          message: 'Usage information is not available for this provider.'
        }
      })
    )
    return { providers, fetchedAt: new Date().toISOString() }
  }

  /**
   * Provider-native subscription usage text for a single provider.
   * Shared by channel `/usage` and the desktop usage view — never derive or
   * estimate quotas, only render what the provider API returned.
   * Returns undefined when the provider has no quota API.
   */
  async getSubscriptionUsage(providerId: string): Promise<string | undefined> {
    const normalized = providerId.trim()
    if (!normalized) return undefined
    const label = this.getProviderDisplayName(normalized)
    const configured = this.getConfiguredProviders().find((entry) => entry.id === normalized)
    const provider = configured ?? { id: normalized, label, authType: 'api_key' as const }
    const usage =
      normalized === 'anthropic'
        ? undefined
        : normalized === 'openai-codex'
          ? await this.fetchOpenAiCodexUsage(provider)
          : normalized === 'xai'
            ? await this.fetchXaiUsage(provider)
            : normalized === 'opencode-go'
              ? await this.fetchOpenCodeGoUsage(provider)
              : undefined
    if (!usage) return undefined
    if (usage.status !== 'available' || usage.windows.length === 0) {
      const message =
        'message' in usage && typeof usage.message === 'string'
          ? usage.message
          : `Subscription usage is not available for ${label}.`
      return message
    }
    const lines = usage.windows.map((window) => {
      const usedPercent = Math.max(0, Math.min(100, 100 - window.remainingPercent))
      const reset = window.resetsAt ? ` (${formatUsageResetCountdown(window.resetsAt)})` : ''
      return `${window.label}: ${usedPercent}% used${reset}`
    })
    return [`${label} usage:`, ...lines.map((line) => `- ${line}`)].join('\n')
  }

  /** Stored API key with env fallback (e.g. OPENCODE_API_KEY for OpenCode Go). */
  private getStoredApiKey(providerId: string): string | undefined {
    const credential = this.credentials.get(providerId) as unknown as Record<string, unknown> | undefined
    const stored = credential && readString(credential, 'key', 'apiKey', 'api_key')
    if (stored?.trim()) return stored.trim()
    try {
      const envKey = getEnvApiKey(providerId)
      if (envKey?.trim()) return envKey.trim()
    } catch {
      // Env lookup is best-effort; stored credentials remain authoritative.
    }
    return undefined
  }

  private async refreshOAuthAccess(providerId: string): Promise<string> {
    // getAuth performs the library's normal expiry check/refresh and persists refreshed credentials.
    const model = this.models.getModels(providerId)[0]
    if (model) {
      try {
        await this.models.getAuth(model)
      } catch (error) {
        throw new Error(friendlyOAuthError(this.getProviderDisplayName(providerId), error))
      }
    }
    const credential = this.credentials.get(providerId) as unknown as Record<string, unknown> | undefined
    // pi-ai stores OAuth bearer tokens under `access`; retain aliases for imported credentials.
    const token = credential && readString(credential, 'access', 'accessToken', 'access_token', 'token')
    if (!token) {
      throw new Error(`${this.getProviderDisplayName(providerId)} session expired. Reconnect it in Settings.`)
    }
    return token
  }

  private async fetchOpenAiCodexUsage(provider: ConfiguredProvider) {
    try {
      const token = await this.refreshOAuthAccess(provider.id)
      const credential = this.credentials.get(provider.id) as unknown as Record<string, unknown> | undefined
      const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        headers: {
          authorization: `Bearer ${token}`,
          ...(readString(credential ?? {}, 'accountId', 'account_id')
            ? { 'ChatGPT-Account-Id': readString(credential ?? {}, 'accountId', 'account_id')! }
            : {})
        }
      })
      if (!response.ok) throw new Error(`Could not load Codex usage (HTTP ${response.status}).`)
      const body: unknown = await response.json()
      return { ...provider, status: 'available' as const, windows: parseOpenAiUsage(body) }
    } catch (error) {
      return {
        ...provider,
        status: 'error' as const,
        windows: [],
        message: friendlyUsageMessage(error)
      }
    }
  }

  private async fetchXaiUsage(provider: ConfiguredProvider) {
    try {
      const token = await this.refreshOAuthAccess(provider.id)
      // SuperGrok subscription usage: CLI proxy REST first, then grok.com gRPC-web
      // (REST ?format=credits currently 500s for some accounts with a serialize error).
      const headers = grokCliBillingHeaders(token)
      const [creditsRes, monthlyRes] = await Promise.all([
        fetch('https://cli-chat-proxy.grok.com/v1/billing?format=credits', { headers }),
        fetch('https://cli-chat-proxy.grok.com/v1/billing', { headers })
      ])

      if ([creditsRes.status, monthlyRes.status].some((status) => status === 401 || status === 403)) {
        throw new Error('Grok session expired. Reconnect Grok (xAI) in Settings.')
      }

      // Parse each successful response independently. One malformed/empty billing
      // representation must not hide the other one. Credits and monthly endpoints
      // have both returned each other's shapes, so try both parsers on each body.
      const windows: ProviderUsageWindow[] = []
      const seen = new Set<string>()
      const pushUnique = (next: ProviderUsageWindow[]): void => {
        for (const window of next) {
          if (seen.has(window.id)) continue
          seen.add(window.id)
          windows.push(window)
        }
      }
      if (creditsRes.ok) {
        const body = await creditsRes.json().catch(() => undefined)
        pushUnique(parseXaiCreditsUsage(body))
        pushUnique(parseXaiMonthlyUsage(body))
      }
      if (monthlyRes.ok) {
        const body = await monthlyRes.json().catch(() => undefined)
        pushUnique(parseXaiMonthlyUsage(body))
        pushUnique(parseXaiCreditsUsage(body))
      }
      if (!seen.has('weekly')) {
        pushUnique(await fetchGrokCreditsViaGrpc(token))
      }

      if (windows.length === 0) {
        if (!creditsRes.ok && !monthlyRes.ok) {
          throw new Error(`Could not load Grok usage (HTTP ${creditsRes.status || monthlyRes.status}).`)
        }
        return {
          ...provider,
          status: 'error' as const,
          windows: [],
          message: 'Grok usage was returned in an unexpected format.'
        }
      }
      return { ...provider, status: 'available' as const, windows }
    } catch (error) {
      return {
        ...provider,
        status: 'error' as const,
        windows: [],
        message: friendlyUsageMessage(error)
      }
    }
  }

  private async fetchOpenCodeGoUsage(provider: ConfiguredProvider) {
    try {
      const apiKey = this.getStoredApiKey(provider.id)
      if (!apiKey) {
        return {
          ...provider,
          status: 'error' as const,
          windows: [],
          message: 'OpenCode Go API key is not connected. Add it in Settings.'
        }
      }
      const response = await fetch('https://opencode.ai/zen/go/v1/usage', {
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json'
        },
        signal: AbortSignal.timeout(30_000)
      })
      if (response.status === 401 || response.status === 403) {
        throw new Error('OpenCode Go API key was rejected. Check the key in Settings.')
      }
      if (response.status === 429) {
        throw new Error('OpenCode Go usage is rate limited. Try again shortly.')
      }
      if (!response.ok) throw new Error(`Could not load OpenCode Go usage (HTTP ${response.status}).`)
      const body: unknown = await response.json()
      const windows = parseOpenCodeGoUsage(body)
      if (windows.length === 0) {
        return {
          ...provider,
          status: 'error' as const,
          windows: [],
          message: 'OpenCode Go usage was returned in an unexpected format.'
        }
      }
      return { ...provider, status: 'available' as const, windows }
    } catch (error) {
      return {
        ...provider,
        status: 'error' as const,
        windows: [],
        message: friendlyUsageMessage(error)
      }
    }
  }
}

/** Collapse verbose OAuth/stack traces into a short reconnect prompt. */
export function friendlyOAuthError(providerLabel: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  const lower = detail.toLowerCase()
  if (
    lower.includes('invalid_grant') ||
    lower.includes('refresh token') ||
    lower.includes('token refresh') ||
    lower.includes('oauth refresh failed') ||
    lower.includes('expired')
  ) {
    return `${providerLabel} session expired. Reconnect it in Settings.`
  }
  if (lower.includes('network') || lower.includes('enotfound') || lower.includes('fetch failed')) {
    return `Could not reach ${providerLabel}. Check your connection and try again.`
  }
  return `Could not refresh ${providerLabel} login. Reconnect it in Settings.`
}

export function friendlyUsageMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) {
    return 'Usage information could not be loaded.'
  }
  // Already user-facing short messages we threw above.
  if (
    error.message.includes('Reconnect') ||
    error.message.includes('Could not load') ||
    error.message.includes('Check your connection') ||
    error.message.includes('session expired')
  ) {
    return error.message
  }
  return friendlyOAuthError('Provider', error)
}

function readString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === 'string') return value[key] as string
  return undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/** OpenAI-style used percentages are already 0–100. */
function percentRemainingFromUsedPercent(used: unknown): number | undefined {
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined
  return Math.max(0, Math.min(100, 100 - used))
}

/**
 * Anthropic OAuth `utilization` is a 0–1 fraction (Claude Code multiplies by 100).
 * Some payloads may already send 0–100; accept both.
 */
export function percentRemainingFromUtilization(used: unknown): number | undefined {
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined
  const usedPercent = used >= 0 && used <= 1 ? used * 100 : used
  return Math.max(0, Math.min(100, 100 - usedPercent))
}

const ANTHROPIC_USAGE_WINDOWS = [
  ['five_hour', '5-hour'],
  ['seven_day', 'Weekly'],
  ['seven_day_opus', 'Weekly (Opus)'],
  ['seven_day_sonnet', 'Weekly (Sonnet)']
] as const

export function parseAnthropicUsage(value: unknown): ProviderUsageWindow[] {
  const root = object(value)
  if (!root) return []
  const rateLimits = object(root.rate_limits ?? root.rateLimits) ?? root

  return ANTHROPIC_USAGE_WINDOWS.flatMap(([id, label]) => {
    const window = object(rateLimits[id])
    if (!window) return []
    const remainingPercent =
      percentRemainingFromUtilization(window.utilization) ??
      percentRemainingFromUsedPercent(window.used_percentage ?? window.usedPercentage)
    if (remainingPercent === undefined) return []
    return [
      {
        id,
        label,
        remainingPercent,
        resetsAt: readString(window, 'resets_at', 'resetsAt')
      }
    ]
  })
}

export function parseOpenAiUsage(value: unknown): ProviderUsageWindow[] {
  const root = object(value)
  const rateLimit = object(root?.rate_limit ?? root?.rateLimit)
  if (!rateLimit) return []
  return ([rateLimit.primary_window ?? rateLimit.primaryWindow, rateLimit.secondary_window ?? rateLimit.secondaryWindow])
    .flatMap((raw) => {
      const window = object(raw)
      const duration =
        typeof window?.limit_window_seconds === 'number'
          ? window.limit_window_seconds
          : window?.window_seconds
      const remainingPercent = percentRemainingFromUsedPercent(
        window?.used_percent ?? window?.usedPercent
      )
      if (typeof duration !== 'number' || remainingPercent === undefined) return []
      const weekly = duration >= 6 * 24 * 60 * 60
      const reset = window?.reset_at ?? window?.resetAt
      const resetsAt =
        typeof reset === 'number'
          ? new Date(reset * 1000).toISOString()
          : typeof reset === 'string'
            ? reset
            : undefined
      return [
        {
          id: weekly ? 'seven_day' : 'five_hour',
          label: weekly ? 'Weekly' : '5-hour',
          remainingPercent,
          resetsAt
        }
      ]
    })
}

function readNestedNumber(value: unknown, ...keys: string[]): number | undefined {
  let current: unknown = value
  for (const key of keys) {
    const record = object(current)
    if (!record) return undefined
    current = record[key]
  }
  const parsed = typeof current === 'string' && current.trim() ? Number(current) : current
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}

/** Billing responses have shipped both directly and wrapped in `data`/`result`. */
function xaiBillingConfig(value: unknown): Record<string, unknown> | undefined {
  const root = object(value)
  if (!root) return undefined
  for (const candidate of [root, object(root.data), object(root.result), object(root.billing)]) {
    if (!candidate) continue
    const config = object(candidate.config) ?? candidate
    if (
      'creditUsagePercent' in config || 'credit_usage_percent' in config ||
      'monthlyLimit' in config || 'monthly_limit' in config ||
      'used' in config || 'includedUsed' in config ||
      'usedCredits' in config || 'used_credits' in config ||
      'totalCredits' in config || 'total_credits' in config
    ) return config
  }
  return undefined
}

/** SuperGrok weekly credits payload from cli-chat-proxy `/v1/billing?format=credits`. */
export function parseXaiCreditsUsage(value: unknown): ProviderUsageWindow[] {
  const config = xaiBillingConfig(value)
  if (!config) return []

  const usedPercent =
    readNestedNumber(config, 'creditUsagePercent') ??
    readNestedNumber(config, 'credit_usage_percent') ??
    readNestedNumber(config, 'creditUsagePercent', 'val') ??
    readNestedNumber(config, 'credit_usage_percent', 'val')

  let remainingPercent = percentRemainingFromUsedPercent(usedPercent)
  if (remainingPercent === undefined) {
    const total =
      readNestedNumber(config, 'totalCredits', 'val') ??
      readNestedNumber(config, 'total_credits', 'val') ??
      readNestedNumber(config, 'creditLimit', 'val') ??
      readNestedNumber(config, 'credit_limit', 'val')
    const used =
      readNestedNumber(config, 'usedCredits', 'val') ??
      readNestedNumber(config, 'used_credits', 'val') ??
      readNestedNumber(config, 'used', 'val') ??
      readNestedNumber(config, 'includedUsed', 'val')
    if (total !== undefined && total > 0 && used !== undefined) {
      remainingPercent = Math.max(0, Math.min(100, ((total - used) / total) * 100))
    }
  }
  if (remainingPercent === undefined) return []

  const period = object(config.currentPeriod ?? config.current_period)
  const resetsAt =
    readString(period ?? {}, 'end') ??
    readString(config, 'billingPeriodEnd', 'billing_period_end')

  return [
    {
      id: 'weekly',
      label: 'Weekly',
      remainingPercent,
      resetsAt
    }
  ]
}

/** Monthly included-usage payload from cli-chat-proxy `/v1/billing`. */
export function parseXaiMonthlyUsage(value: unknown): ProviderUsageWindow[] {
  const config = xaiBillingConfig(value)
  if (!config) return []

  const limit =
    readNestedNumber(config, 'monthlyLimit', 'val') ??
    readNestedNumber(config, 'monthly_limit', 'val')
  const used =
    readNestedNumber(config, 'used', 'val') ??
    readNestedNumber(config, 'includedUsed', 'val')
  // A zero monthly cap means this account is credits-tier (or uncapped here);
  // do not invent a window from empty quota fields.
  if (limit === undefined || limit <= 0 || used === undefined) return []

  const remainingPercent = Math.max(0, Math.min(100, ((limit - used) / limit) * 100))
  return [
    {
      id: 'monthly',
      label: 'Monthly',
      remainingPercent,
      resetsAt: readString(config, 'billingPeriodEnd', 'billing_period_end')
    }
  ]
}

const OPENCODE_GO_USAGE_WINDOWS = [
  ['rolling', 'Rolling'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly']
] as const

/**
 * OpenCode Go `GET /zen/go/v1/usage` payload:
 * `{ usage: { rolling: { status, percent, resetsAt }, weekly, monthly } }`
 * where `percent` is used percent (0-100). Mousse windows track remaining.
 */
export function parseOpenCodeGoUsage(value: unknown): ProviderUsageWindow[] {
  const root = object(value)
  if (!root) return []
  const usage = object(root.usage)
  if (!usage) return []

  const windows: ProviderUsageWindow[] = []
  for (const [id, label] of OPENCODE_GO_USAGE_WINDOWS) {
    const window = object(usage[id])
    if (!window) continue
    const status = window.status
    if (typeof status === 'string' && status.toLowerCase() !== 'ok') continue
    const percentRaw = window.percent
    const percent =
      typeof percentRaw === 'string' && percentRaw.trim()
        ? Number(percentRaw)
        : (percentRaw as number | undefined)
    if (typeof percent !== 'number' || !Number.isFinite(percent)) continue
    const remainingPercent = Math.max(0, Math.min(100, 100 - percent))
    const resetsAt = readString(window, 'resetsAt', 'resets_at')
    windows.push({ id, label, remainingPercent, resetsAt })
  }
  return windows
}

/** Compact countdown down to the minute for channel `/usage` text (`45m`, `5h 12m`, `4d 3h 12m`). */
export function formatUsageResetCountdown(resetsAt: string): string {
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return 'reset unknown'
  const deltaMs = date.getTime() - Date.now()
  if (deltaMs <= 0) return 'resets soon'
  const totalMinutes = Math.floor(deltaMs / 60_000)
  if (totalMinutes < 1) return 'resets soon'
  if (totalMinutes < 60) return `resets in ${totalMinutes}m`
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const mins = totalMinutes % 60
  if (days === 0) return `resets in ${hours}h ${mins}m`
  return `resets in ${days}d ${hours}h ${mins}m`
}

function toApiKeyCredential(raw: ApiKeyCredential): ApiKeyCredential {
  return {
    type: 'api_key',
    key: raw.key ?? '',
    ...(raw.env ? { env: raw.env } : {})
  }
}

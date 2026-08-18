import { join } from 'path'
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
  CURSOR_PROVIDER_ID,
  refreshCursorPiProvider,
  registerCursorPiProvider
} from './cursorPiProvider'
import { FileCredentialStore } from './FileCredentialStore'
import { LoginSession } from './LoginSession'
import { enhanceProvidersWithOpenAiCompatibleFetch } from './openAiCompatibleModelFetch'
import { getProviderDisplayName as getProductProviderDisplayName } from './providerMetadata'

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

/** Providers whose apiKey.login needs multiple prompts (not a single secret field). */
const GUIDED_API_KEY_PROVIDERS = new Set([
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai'
])

type ProviderAuthTypeFilter = 'api_key' | 'oauth'

/** How often to re-fetch dynamic provider model catalogs (Cursor, OpenAI-compatible, Radius, …). */
const DYNAMIC_MODELS_REFRESH_MS = 5 * 60_000

export class ProviderAuthService {
  readonly credentials: FileCredentialStore
  readonly models: MutableModels
  private activeSessions = new Map<string, LoginSession>()
  private initPromise: Promise<void> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private refreshInFlight: Promise<void> | null = null
  private stopped = false

  constructor() {
    this.credentials = new FileCredentialStore(MOUSSE_AUTH_PATH)
    this.models = builtinModels({ credentials: this.credentials })
    enhanceProvidersWithOpenAiCompatibleFetch(this.models.getProviders())
  }

  init(): Promise<void> {
    this.initPromise ??= (async () => {
      await registerCursorPiProvider(this.models, this.credentials)
      // Live catalogs (Radius, Cursor fetchModels, OpenAI-compatible /models).
      try {
        await this.models.refresh({ allowNetwork: true })
      } catch {
        // Best-effort; static catalogs remain available offline.
      }
      this.startPeriodicRefresh()
    })()
    return this.initPromise
  }

  /** Stop background catalog polling (called when MMS shuts down). */
  stop(): void {
    this.stopped = true
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  private startPeriodicRefresh(): void {
    if (this.stopped || this.refreshTimer) return
    this.refreshTimer = setInterval(() => {
      void this.refreshDynamicModels().catch(() => undefined)
    }, DYNAMIC_MODELS_REFRESH_MS)
    // Unref so the timer alone does not keep a headless process alive.
    this.refreshTimer.unref?.()
  }

  /** Force a network refresh of every provider that supports dynamic model lists. */
  async refreshDynamicModels(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      await this.init()
      if (this.stopped) return
      await this.refreshCursorProvider(true)
      await this.models.refresh({ allowNetwork: true })
    })().finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
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
    return getProductProviderDisplayName(providerId, provider?.name)
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

  private kickCatalogRefresh(): void {
    void this.init().then(() => this.models.refresh({ allowNetwork: true })).catch(() => undefined)
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

      return {
        id: model.id,
        label: model.name,
        ...(efforts && efforts.length > 0 ? { efforts } : {})
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
    this.kickCatalogRefresh()
    return this.models
      .getProviders()
      .map((provider) => this.toLlmProviderOption(provider.id))
      .filter((provider): provider is LlmProviderOption => provider !== null)
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  getConfiguredLlmProviders(): LlmProviderOption[] {
    const configuredIds = this.credentials.listProviderIds()
    if (configuredIds.length === 0) return []

    this.kickCatalogRefresh()

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
      const configured = this.credentials.has(id)
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

      if ((!authType || authType === 'oauth') && oauthAuth) {
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

  /** Fetch subscription limits daemon-side; credentials never cross the protocol boundary. */
  async getUsage(): Promise<ProvidersUsageResponse> {
    // Keep every configured provider in the response so the usage view is a complete
    // provider inventory (providers without a quota API are explicitly marked unavailable).
    const configuredProviders = this.getConfiguredProviders()
    const providers = await Promise.all(
      configuredProviders.map(async (provider) => {
        if (provider.id === 'anthropic') return this.fetchAnthropicUsage(provider)
        if (provider.id === 'openai-codex') return this.fetchOpenAiCodexUsage(provider)
        if (provider.id === 'xai') return this.fetchXaiUsage(provider)
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

  private async fetchAnthropicUsage(provider: ConfiguredProvider) {
    try {
      const token = await this.refreshOAuthAccess(provider.id)
      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'content-type': 'application/json',
          accept: 'application/json'
        }
      })
      if (response.status === 401 || response.status === 403) {
        throw new Error('Claude session expired. Reconnect Claude Pro/Max in Settings.')
      }
      if (!response.ok) throw new Error(`Could not load Claude usage (HTTP ${response.status}).`)
      const body: unknown = await response.json()
      const windows = parseAnthropicUsage(body)
      if (windows.length === 0) {
        return {
          ...provider,
          status: 'error' as const,
          windows: [],
          message: 'Claude usage was returned in an unexpected format.'
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
      // SuperGrok subscription usage lives on the Grok CLI billing proxy, not API rate-limit headers.
      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
      const [creditsRes, monthlyRes] = await Promise.all([
        fetch('https://cli-chat-proxy.grok.com/v1/billing?format=credits', { headers }),
        fetch('https://cli-chat-proxy.grok.com/v1/billing', { headers })
      ])

      if ([creditsRes.status, monthlyRes.status].some((status) => status === 401 || status === 403)) {
        throw new Error('Grok session expired. Reconnect Grok (xAI) in Settings.')
      }
      if (!creditsRes.ok && !monthlyRes.ok) {
        throw new Error(`Could not load Grok usage (HTTP ${creditsRes.status || monthlyRes.status}).`)
      }

      // Parse each successful response independently. One malformed/empty billing
      // representation must not hide the other one.
      const windows: ProviderUsageWindow[] = []
      if (creditsRes.ok) {
        const body = await creditsRes.json().catch(() => undefined)
        windows.push(...parseXaiCreditsUsage(body))
      }
      if (monthlyRes.ok) {
        const body = await monthlyRes.json().catch(() => undefined)
        windows.push(...parseXaiMonthlyUsage(body))
      }

      if (windows.length === 0) {
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
      'used' in config || 'includedUsed' in config
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
    readNestedNumber(config, 'credit_usage_percent')
  const remainingPercent = percentRemainingFromUsedPercent(usedPercent)
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

function toApiKeyCredential(raw: ApiKeyCredential): Credential {
  return {
    type: 'api_key',
    key: raw.key ?? '',
    ...(raw.env ? { env: raw.env } : {})
  }
}

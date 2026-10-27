/**
 * Installation-scoped pi-ai credentials for tests: one key store every profile shares, with the
 * catalogue and sign-in options a few providers have. Nothing reaches a provider or auth endpoint.
 */
import { vi } from 'vitest'
import type { ProviderLoginOption } from '../../../src/shared/providerAuth'

const LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  'amazon-bedrock': 'Amazon Bedrock',
  'opencode-go': 'OpenCode Go',
  'openai-codex': 'ChatGPT (retired)'
}

export class PiInstallationCredentials {
  readonly keys = new Map<string, string>()
  readonly setApiKey = vi.fn(async (providerId: string, apiKey: string) => {
    if (!apiKey.trim()) throw new Error('API key cannot be empty')
    this.keys.set(providerId, apiKey.trim())
  })
  readonly logout = vi.fn(async (providerId: string) => {
    this.keys.delete(providerId)
  })
  readonly verifyAmbientProvider = vi.fn(async (providerId: string) => {
    this.keys.set(providerId, '<ambient>')
    return { success: true }
  })
  readonly refreshDynamicModels = vi.fn(async () => {})
  readonly credentials = { listProviderIds: () => [...this.keys.keys()] }
  /** Providers the model catalogue registers without a sign-in of their own (a custom `models.json` one). */
  readonly customProviders: string[] = []
  readonly models = { getProviders: () => this.customProviders.map((id) => ({ id })) }

  has = (providerId: string): boolean => this.keys.has(providerId)
  getProviderDisplayName = (providerId: string): string => LABELS[providerId] ?? providerId
  storedApiKey = (providerId: string): string | undefined => this.keys.get(providerId)
  getConfiguredProviders = () => [...this.keys.keys()].map((id) => ({ id, label: this.getProviderDisplayName(id), authType: 'api_key' as const }))
  getConfiguredLlmProviders = () => [...this.keys.keys()].map((id) => ({ id, label: this.getProviderDisplayName(id), models: [{ id: `${id}-model`, label: 'Model' }] }))
  getAmbientProviderInfo = (providerId: string) =>
    providerId === 'amazon-bedrock' ? { id: providerId, label: 'Amazon Bedrock', instructions: ['Set AWS_PROFILE or AWS keys.'] } : undefined
  getLoginOptions = (): ProviderLoginOption[] => {
    const option = (id: string, authType: 'api_key' | 'oauth', extra: Partial<ProviderLoginOption> = {}): ProviderLoginOption =>
      ({ id, label: this.getProviderDisplayName(id), authType, configured: this.has(id), ...extra })
    return [
      option('amazon-bedrock', 'api_key', { ambient: true, description: 'Environment credentials' }),
      option('openai', 'api_key', { description: 'API key' }),
      option('openai', 'oauth', { description: 'Subscription / OAuth', guidedLogin: true }),
      option('openai-codex', 'oauth', { description: 'Retired' }),
      option('opencode-go', 'api_key', { description: 'API key' }),
      option('openrouter', 'api_key', { description: 'API key' })
    ]
  }
}

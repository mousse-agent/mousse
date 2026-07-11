import type { LlmProviderOption } from '../../shared/settings'
import type { ProviderAuthService } from '../providers/ProviderAuthService'

export function getPiLlmProviders(providerAuth: ProviderAuthService): LlmProviderOption[] {
  return providerAuth.getConfiguredLlmProviders()
}

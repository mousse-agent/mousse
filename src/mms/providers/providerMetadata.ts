/**
 * Product-facing names for providers whose API and model brands differ.
 *
 * pi-ai uses `xai` as the canonical provider ID because Grok is xAI's model
 * family. Keep that ID intact for credentials and model lookup, but mention
 * Grok in the UI so users can find the provider they are looking for.
 */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  xai: 'Grok (xAI)'
}

export function getProviderDisplayName(providerId: string, fallback?: string): string {
  return PROVIDER_DISPLAY_NAMES[providerId] ?? fallback ?? providerId
}

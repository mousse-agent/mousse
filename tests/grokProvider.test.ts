import { describe, expect, it } from 'vitest'
import { builtinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { getProviderDisplayName } from '../src/mms/providers/providerMetadata'

describe('Grok provider', () => {
  it('exposes xAI as the Grok provider in the product UI', () => {
    const provider = builtinProviders().find((entry) => entry.id === 'xai')

    expect(provider).toBeDefined()
    expect(provider?.name).toBe('xAI')
    expect(provider?.baseUrl).toBe('https://api.x.ai/v1')
    expect(provider?.auth.apiKey).toBeDefined()
    expect(getProviderDisplayName('xai', provider?.name)).toBe('Grok (xAI)')
  })

  it('includes Grok models in the xAI model catalog', () => {
    const models = builtinModels().getModels('xai')
    const modelIds = new Set(models.map((model) => model.id))

    // Upstream owns this catalog; assert on the stable Grok line rather than a
    // point release. `grok-code-fast-1` was dropped from pi-ai's xAI catalog.
    expect(modelIds).toContain('grok-4.5')
    expect(modelIds).toContain('grok-4.3')
  })
})

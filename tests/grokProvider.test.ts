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

    expect(modelIds).toContain('grok-4.5')
    expect(modelIds).toContain('grok-code-fast-1')
  })
})

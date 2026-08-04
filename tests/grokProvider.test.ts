import { describe, expect, it } from 'vitest'
import { builtinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { getProviderDisplayName } from '../src/mms/providers/providerMetadata'

describe('Grok provider', () => {
  it('exposes xAI as the Grok provider in the product UI', () => {
    const provider = builtinProviders().find((entry) => entry.id === 'xai')

    expect(provider).toBeDefined()
    expect(provider?.name).toBe('xAI')
    expect(provider?.baseUrl).toBe('https://api.x.ai/v1')
    expect(provider?.auth.apiKey).toBeDefined()
    expect(provider?.auth.oauth).toBeDefined()
    expect(provider?.auth.oauth?.name).toBe('xAI (Grok/X subscription)')
    expect(getProviderDisplayName('xai', provider?.name)).toBe('Grok (xAI)')
  })

  it('offers the upstream Grok subscription OAuth flow as a guided login', () => {
    const service = new ProviderAuthService()
    const options = service.getLoginOptions().filter((option) => option.id === 'xai')

    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'xai',
          label: 'Grok (xAI)',
          authType: 'api_key'
        }),
        expect.objectContaining({
          id: 'xai',
          label: 'Grok (xAI)',
          authType: 'oauth',
          description: 'xAI (Grok/X subscription)',
          guidedLogin: true
        })
      ])
    )
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

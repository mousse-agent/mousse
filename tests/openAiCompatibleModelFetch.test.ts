import { expect, it } from 'vitest'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { enhanceProvidersWithOpenAiCompatibleFetch } from '../src/mms/providers/openAiCompatibleModelFetch'

it('enables live /models discovery for other OpenAI-compatible providers', () => {
  const providers = builtinProviders()
  const moonshot = providers.find((provider) => provider.id === 'moonshotai')!
  const google = providers.find((provider) => provider.id === 'google')!
  expect(moonshot.refreshModels).toBeUndefined()
  enhanceProvidersWithOpenAiCompatibleFetch(providers)
  expect(moonshot.refreshModels).toBeTypeOf('function')
  expect(google.refreshModels).toBeUndefined()
})

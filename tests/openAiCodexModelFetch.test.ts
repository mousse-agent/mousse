import { describe, expect, it, vi } from 'vitest'
import { getBuiltinModels, builtinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { getModelEffortLevels } from '../src/shared/modelEfforts'
import { enhanceProvidersWithOpenAiCompatibleFetch } from '../src/mms/providers/openAiCompatibleModelFetch'
import {
  enhanceOpenAiCodexProvider,
  fetchOpenAiCodexModels
} from '../src/mms/providers/openAiCodexModelFetch'

const token = `header.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' }
})).toString('base64url')}.signature`
const credential = { type: 'oauth' as const, access: token, refresh: 'refresh', expires: Date.now() + 60_000 }
const baseline = getBuiltinModels('openai-codex')

function catalog(models: unknown[]) {
  return new Response(JSON.stringify({ models }), { status: 200 })
}

describe('OpenAI Codex model discovery', () => {
  it('loads the current account catalog and maps new model metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: '0.157.0' }))
      }
      expect(String(input)).toContain('/codex/models?client_version=0.157.0')
      expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('test-account')
      expect(new Headers(init?.headers).get('originator')).toBe('pi')
      return catalog([
        { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }] },
        { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', visibility: 'list', context_window: 272000,
          input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }] },
        { slug: 'future-model', display_name: 'Future Model', visibility: 'list', context_window: 300000,
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
        { slug: 'private-model', visibility: 'hide' }
      ])
    })
    const models = await fetchOpenAiCodexModels({ credential, baseline, signal: new AbortController().signal, fetchImpl })
    expect(models.map((model) => model.id)).toEqual(['gpt-6-astra', 'gpt-6-sol', 'future-model'])
    expect(models[1]).toMatchObject({ api: 'openai-codex-responses', provider: 'openai-codex', contextWindow: 272000 })
    expect(getModelEffortLevels(models[1]!)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(models[2]?.cost.input).toBe(0)
    expect(getModelEffortLevels(models[2]!)).toEqual(['low', 'high'])
  })

  it('keeps the bundled catalog when refresh fails', async () => {
    const credentials = new InMemoryCredentialStore()
    await credentials.modify('openai-codex', async () => credential)
    const models = builtinModels({ credentials })
    enhanceOpenAiCodexProvider(models.getProvider('openai-codex'))
    const original = models.getModels('openai-codex').map((model) => model.id)
    const fetchImpl = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', fetchImpl)
    try {
      await models.refresh({ providers: ['openai-codex'], allowNetwork: true })
      expect(models.getModels('openai-codex').map((model) => model.id)).toEqual(original)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('publishes newly listed models through the provider registry', async () => {
    const credentials = new InMemoryCredentialStore()
    await credentials.modify('openai-codex', async () => credential)
    const models = builtinModels({ credentials })
    enhanceOpenAiCodexProvider(models.getProvider('openai-codex'))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('registry.npmjs.org')
        ? new Response(JSON.stringify({ version: '0.157.0' }))
        : catalog([{ slug: 'gpt-6-sol', visibility: 'list', display_name: 'GPT-6 Sol' }])
    ))
    try {
      const result = await models.refresh({ providers: ['openai-codex'], allowNetwork: true })
      expect(result.errors.size).toBe(0)
      expect(models.getModels('openai-codex').map((model) => model.id)).toEqual(['gpt-6-sol'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

it('enables live /models discovery for other OpenAI-compatible providers', () => {
  const providers = builtinProviders()
  const moonshot = providers.find((provider) => provider.id === 'moonshotai')!
  const google = providers.find((provider) => provider.id === 'google')!
  expect(moonshot.refreshModels).toBeUndefined()
  enhanceProvidersWithOpenAiCompatibleFetch(providers)
  expect(moonshot.refreshModels).toBeTypeOf('function')
  expect(google.refreshModels).toBeUndefined()
})

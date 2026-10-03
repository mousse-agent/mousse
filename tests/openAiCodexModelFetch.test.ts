import { describe, expect, it, vi } from 'vitest'
import { zstdDecompressSync } from 'node:zlib'
import { getBuiltinModels, builtinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { InMemoryCredentialStore, type Context, type Provider } from '@earendil-works/pi-ai'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import type { LlmProviderOption } from '../src/shared/settings'
import { getModelFastToggle } from '../src/shared/modelVariants'
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
  it('exposes Fast only when the account advertises a supported speed or service tier', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => String(input).includes('registry.npmjs.org')
      ? new Response(JSON.stringify({ version: '0.157.0' }))
      : catalog([
        { slug: 'speed-model', display_name: 'Speed Model', visibility: 'list', additional_speed_tiers: ['fast'] },
        { slug: 'tier-model', display_name: 'Tier Model', visibility: 'list', service_tiers: [{ id: 'priority', name: 'Fast' }] },
        { slug: 'fast-tier-model', visibility: 'list', service_tiers: [{ id: 'fast' }] },
        { slug: 'standard-only', visibility: 'list' },
        { slug: 'ultra-only', visibility: 'list', service_tiers: [{ id: 'ultrafast' }] },
        { slug: 'malformed', visibility: 'list', additional_speed_tiers: 'fast', service_tiers: [null, 'priority'] }
      ]))
    const listed = await fetchOpenAiCodexModels({ credential, baseline, signal: new AbortController().signal, fetchImpl })
    expect(listed.filter(model => model.id.endsWith(':fast')).map(model => model.id)).toEqual([
      'speed-model:fast', 'tier-model:fast', 'fast-tier-model:fast'
    ])
    expect(listed.find(model => model.id === 'speed-model:fast')).toMatchObject({ name: 'Speed Model (fast)' })
  })

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
        : catalog([{ slug: 'gpt-6-sol', visibility: 'list', display_name: 'GPT-6 Sol',
          additional_speed_tiers: ['fast'], service_tiers: [{ id: 'priority', name: 'Fast' }],
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }])
    ))
    try {
      const result = await models.refresh({ providers: ['openai-codex'], allowNetwork: true })
      expect(result.errors.size).toBe(0)
      expect(models.getModels('openai-codex').map((model) => model.id)).toEqual(['gpt-6-sol', 'gpt-6-sol:fast'])
      const service = Object.create(ProviderAuthService.prototype) as ProviderAuthService
      Object.defineProperty(service, 'models', { value: models })
      const toCatalog = Reflect.get(ProviderAuthService.prototype, 'toLlmProviderOption') as
        (this: ProviderAuthService, id: string) => LlmProviderOption
      const options = toCatalog.call(service, 'openai-codex')
      expect(getModelFastToggle('openai-codex', 'gpt-6-sol:high', options.models)).toEqual({
        active: false, targetModelId: 'gpt-6-sol:fast:high'
      })
      expect(getModelFastToggle('openai-codex', 'gpt-6-sol:fast:high', options.models)).toEqual({
        active: true, targetModelId: 'gpt-6-sol:high'
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Codex Fast request transport', () => {
  it.each(['stream', 'streamSimple'] as const)('sends the upstream slug and priority tier through %s', async method => {
    const provider = builtinProviders().find(provider => provider.id === 'openai-codex')!
    enhanceOpenAiCodexProvider(provider)
    const model = { ...baseline[0]!, id: `${baseline[0]!.id}:fast` }
    const requests: Record<string, unknown>[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => {
      const body = new Headers(options?.headers).get('content-encoding') === 'zstd'
        ? zstdDecompressSync(Buffer.from(options?.body as Uint8Array)).toString()
        : String(options?.body)
      requests.push(JSON.parse(body))
      return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: {
        id: 'test-response', status: 'completed', output: [], service_tier: 'priority',
        usage: { input_tokens: 1, output_tokens: 0 }
      } }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const onPayload = vi.fn((payload: unknown) => ({ ...(payload as object), metadata: { test: 'preserved' } }))
    const context: Context = { messages: [{ role: 'user', content: 'test', timestamp: Date.now() }] }
    const stream = provider[method](model, context, {
      apiKey: token, transport: 'sse', fetch: fetchImpl, onPayload,
      ...(method === 'stream' ? { reasoningEffort: 'low' as const } : { reasoning: 'low' as const })
    })
    const result = await stream.result()
    expect(result.stopReason, result.errorMessage).not.toBe('error')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ model: baseline[0]!.id, service_tier: 'priority', metadata: { test: 'preserved' } })
    expect(onPayload).toHaveBeenCalledOnce()
    expect(model.id).toBe(`${baseline[0]!.id}:fast`)
  })

  it('leaves standard subscription requests and other providers untouched', () => {
    const stream = vi.fn()
    const provider = { id: 'openai-codex', getModels: () => baseline, stream, streamSimple: vi.fn() } as unknown as Provider
    enhanceOpenAiCodexProvider(provider)
    const options = { reasoningEffort: 'high' as const }
    provider.stream(baseline[0]!, { messages: [] }, options)
    expect(stream).toHaveBeenCalledWith(baseline[0], { messages: [] }, options)
    const other = { id: 'openai', stream } as unknown as Provider
    enhanceOpenAiCodexProvider(other)
    expect(other.stream).toBe(stream)
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

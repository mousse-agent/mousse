import { createProvider, type Api, type AssistantMessageEventStream, type Model, type Provider } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { guardProvider, isGuarded, refusesAnthropicRequest } from '../../src/mms/harness/pi/extension/guard'
import { ANTHROPIC_OAUTH_REFUSED, LOGIN_REFUSED } from '../../src/mms/harness/pi/extension/messages'

// The guard's rule and its wrapper, in process. `piGuardSpike` runs the same wrapper inside the
// real pinned Pi child against local recorders.

function model(api: string, baseUrl?: string): Model<Api> {
  return {
    id: `m-${api}`, name: api, api, provider: 'p', ...(baseUrl ? { baseUrl } : {}),
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100
  } as Model<Api>
}

describe('Anthropic guard rule', () => {
  it('refuses subscription tokens in a key, a header or a provider env value, and the OAuth beta', () => {
    expect(refusesAnthropicRequest({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-ant-oat01-x' })).toBe(true)
    expect(refusesAnthropicRequest({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', headers: { Authorization: 'Bearer sk-ant-ort01-x' } })).toBe(true)
    expect(refusesAnthropicRequest({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', env: { TOKEN: 'sk-ant-oat01-x' } })).toBe(true)
    expect(refusesAnthropicRequest({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', headers: { 'anthropic-beta': 'x, oauth-2025-04-20' } })).toBe(true)
  })

  it('lets only an sk-ant-api key on the Messages API without Authorization reach Anthropic hosts', () => {
    expect(refusesAnthropicRequest({ api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-api03-x' })).toBe(false)
    // No address: the Messages API's default host.
    expect(refusesAnthropicRequest({ api: 'anthropic-messages', apiKey: 'sk-ant-api03-x' })).toBe(false)
    expect(refusesAnthropicRequest({ api: 'anthropic-messages', apiKey: 'other-key' })).toBe(true)
    expect(refusesAnthropicRequest({ api: 'openai-completions', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-api03-x' })).toBe(true)
    expect(refusesAnthropicRequest({ api: 'anthropic-messages', baseUrl: 'https://claude.ai/api', apiKey: 'sk-ant-api03-x', headers: { authorization: 'Bearer x' } })).toBe(true)
    expect(refusesAnthropicRequest({ api: 'anthropic-messages', baseUrl: 'https://eu.api.anthropic.com.', apiKey: 'x' })).toBe(true)
    // Not Anthropic's: a proxy that serves the Messages API with its own key.
    expect(refusesAnthropicRequest({ api: 'anthropic-messages', baseUrl: 'https://api.kimi.com/coding', apiKey: 'kimi-key', headers: { Authorization: 'Bearer kimi' } })).toBe(false)
    expect(refusesAnthropicRequest({ api: 'anthropic-messages', baseUrl: 'https://notanthropic.com', apiKey: 'x' })).toBe(false)
  })

  it('holds an SDK base URL from the environment to the same rule when the model names no address', () => {
    expect(refusesAnthropicRequest({ api: 'openai-completions', apiKey: 'sk-ant-api03-x', sdkBaseUrls: ['https://api.anthropic.com/v1'] })).toBe(true)
    expect(refusesAnthropicRequest({ api: 'openai-completions', apiKey: 'plain', sdkBaseUrls: ['http://127.0.0.1:1/v1'] })).toBe(false)
    // A model's own address wins over the environment.
    expect(refusesAnthropicRequest({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'plain', sdkBaseUrls: ['https://api.anthropic.com/v1'] })).toBe(false)
  })
})

describe('guardProvider', () => {
  function recordingProvider(): { provider: Provider; calls: Array<{ api: string; options: Record<string, unknown> }> } {
    const calls: Array<{ api: string; options: Record<string, unknown> }> = []
    const streams = (api: string) => ({
      stream: ((m: Model<Api>, _c: unknown, options?: Record<string, unknown>) => {
        calls.push({ api, options: options ?? {} })
        return { result: async () => ({}) } as unknown as AssistantMessageEventStream
      }) as never,
      streamSimple: ((m: Model<Api>, _c: unknown, options?: Record<string, unknown>) => {
        calls.push({ api, options: options ?? {} })
        return { result: async () => ({}) } as unknown as AssistantMessageEventStream
      }) as never
    })
    const provider = createProvider({
      id: 'p',
      auth: { apiKey: { name: 'k', login: async () => ({ type: 'api_key' as const, key: 'x' }), resolve: async () => ({ auth: { apiKey: 'x' } }) } },
      models: [model('openai-completions'), model('anthropic-messages')],
      api: { 'openai-completions': streams('openai-completions'), 'anthropic-messages': streams('anthropic-messages') }
    })
    return { provider, calls }
  }

  it('checks every api the provider dispatches, forces maxRetries 0, and refuses before the stock stream', async () => {
    const { provider, calls } = recordingProvider()
    const guarded = guardProvider(provider)
    expect(isGuarded(guarded)).toBe(true)
    expect(guardProvider(guarded)).toBe(guarded)
    guarded.streamSimple(model('openai-completions', 'http://127.0.0.1:1'), { messages: [] }, { apiKey: 'plain', maxRetries: 3 })
    expect(calls).toEqual([{ api: 'openai-completions', options: expect.objectContaining({ apiKey: 'plain', maxRetries: 0 }) }])
    const refused = guarded.streamSimple(model('anthropic-messages', 'http://127.0.0.1:1'), { messages: [] }, { apiKey: 'sk-ant-oat01-x' })
    const message = await refused.result()
    expect(message).toMatchObject({ stopReason: 'error', errorMessage: ANTHROPIC_OAUTH_REFUSED })
    const viaStream = await guarded.stream(model('openai-completions', 'https://api.anthropic.com'), { messages: [] }, { apiKey: 'x' }).result()
    expect(viaStream).toMatchObject({ errorMessage: ANTHROPIC_OAUTH_REFUSED })
    expect(calls).toHaveLength(1)
    expect(guarded.getModels().map((entry) => entry.api)).toEqual(['openai-completions', 'anthropic-messages'])
  })

  it('refuses Pi’s own sign-in flows', async () => {
    const guarded = guardProvider(recordingProvider().provider)
    await expect(guarded.auth.apiKey!.login!({} as never)).rejects.toThrow(LOGIN_REFUSED)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import { streamSimple as piStreamSimple } from '@earendil-works/pi-ai/api/anthropic-messages'
import { LlmClient } from '../src/mms/orchestrator/LlmClient'
import { retryConnectionFailures } from '../src/mms/orchestrator/connectionRetry'
import { userMessage } from '../src/mms/orchestrator/nativeContext'
import { getDefaultSettings } from '../src/shared/settings'
import { fixtureModel, nativeClient, providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { retryContextOverflowOnce } from '../src/mms/orchestrator/OrchestratorService'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const success = () => providerResponse([{ type: 'text', text: 'recovered answer' }], 'stop')
function failingStream(events: Array<Record<string, unknown>> = []) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
      throw new Error('ECONNRESET')
    },
    result: async () => { throw new Error('result must not be consumed after stream failure') }
  }
}

describe('request-scoped provider retry safety', () => {
  it.each(['disconnected', 'missing-auth'] as const)('fails with a typed preflight error when provider is %s without starting a request', async (state) => {
    const settings = getDefaultSettings()
    settings.provider = { llmProvider: 'fixture-provider', model: 'fixture-model' }
    settings.integrations.skills.enabled = false
    const getAuth = vi.fn(async () => state === 'missing-auth' ? undefined : { apiKey: 'fixture' })
    const streamSimple = vi.fn(() => streamOf(success()))
    const models = { getModel: fixtureModel, getAuth, streamSimple }
    const client = new LlmClient({ get: () => settings } as never, {
      has: () => state !== 'disconnected', credentials: { listProviderIds: () => ['fixture-provider'] }, models
    } as never)
    const onRetry = vi.fn()
    await expect(client.chat([userMessage('start')], undefined, { retryDelayMs: 0, onRetry }))
      .rejects.toMatchObject({ code: 'provider_not_connected', errorInfo: { category: 'denied', retryable: false }, details: { provider: 'fixture-provider' } })
    expect(getAuth).toHaveBeenCalledTimes(state === 'disconnected' ? 0 : 1)
    expect(streamSimple).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('does not compact or replay context overflow when the owner denies retry', async () => {
    const failure = new Error('maximum context length exceeded')
    const operation = vi.fn(async () => { throw failure })
    const compact = vi.fn(() => true)
    await expect(retryContextOverflowOnce(operation, compact, () => false)).rejects.toBe(failure)
    expect(operation).toHaveBeenCalledOnce()
    expect(compact).not.toHaveBeenCalled()
  })
  it('retries a start-only failure before output and keeps the request context unchanged', async () => {
    const captured: Context[] = []
    let calls = 0
    const client = nativeClient([], captured, { streamSimple: () => ++calls === 1
      ? failingStream([{ type: 'start', partial: providerResponse([], 'stop') }]) : streamOf(success()) })
    const onRetry = vi.fn()
    const result = await client.chat([userMessage('start')], undefined, { retryDelayMs: 0, onRetry })
    expect(result.text).toBe('recovered answer')
    expect(calls).toBe(2)
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(1)
    expect(captured[1]).toEqual(captured[0])
  })

  it.each(['text_start', 'thinking_start', 'toolcall_start'])('never retries after %s progress even without display callbacks', async (type) => {
    const captured: Context[] = []
    const stream = vi.fn(() => failingStream([{ type, contentIndex: 0, partial: providerResponse([], 'error') }]))
    const client = nativeClient([], captured, { streamSimple: stream })
    const onRetry = vi.fn()
    await expect(client.chat([userMessage('start')], undefined, { retryDelayMs: 0, onRetry })).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(stream).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('does not replay a failed result containing partial content without stream events', async () => {
    const captured: Context[] = []
    const stream = vi.fn(() => streamOf(providerResponse([{ type: 'text', text: 'partial output' }], 'error', 4, 0, { errorMessage: 'ECONNRESET' })))
    const client = nativeClient([], captured, { streamSimple: stream })
    await expect(client.chat([userMessage('start')], undefined, { retryDelayMs: 0 })).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(stream).toHaveBeenCalledOnce()
  })

  it('preserves an earlier completed tool batch and executes it once when the next request reconnects', async () => {
    const settings = getDefaultSettings()
    settings.provider = { llmProvider: 'fixture-provider', model: 'fixture-model' }
    settings.integrations.skills.enabled = false
    const captured: Context[] = []
    const signals: AbortSignal[] = []
    let calls = 0
    const models = {
      getModel: fixtureModel, getAuth: async () => ({ apiKey: 'fixture' }),
      streamSimple: (_model: unknown, context: Context, options: { signal: AbortSignal }) => {
        captured.push(structuredClone(context)); signals.push(options.signal); calls += 1
        if (calls === 1) return streamOf(providerResponse([{ type: 'toolCall', id: 'effect-1', name: 'mcp_write', arguments: { value: 'one' } }], 'toolUse'))
        if (calls === 2) return failingStream()
        return streamOf(success())
      }
    }
    const callTool = vi.fn(async () => ({ text: 'effect completed', isError: false }))
    const mcp = { getEnabledTools: async () => [{ id: 'mcp', serverId: 'server', serverName: 'fixture', toolName: 'write', providerName: 'mcp_write', inputSchema: { type: 'object' } }], callTool }
    const client = new LlmClient({ get: () => settings } as never,
      { has: () => true, credentials: { listProviderIds: () => ['fixture-provider'] }, models } as never, mcp as never)
    const result = await client.chat([userMessage('start')], undefined, { retryDelayMs: 0 })
    expect(result.text).toBe('recovered answer')
    expect(callTool).toHaveBeenCalledOnce()
    expect(captured).toHaveLength(3)
    expect(captured[2]).toEqual(captured[1])
    expect(captured[2]!.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'toolResult', toolCallId: 'effect-1', content: [{ type: 'text', text: 'effect completed' }] })]))
    expect(signals[2]).not.toBe(signals[1])
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it('counts billable failed response usage while retrying only its empty request', async () => {
    const captured: Context[] = []
    const outputs = [providerResponse([], 'error', 8, 0.25, { errorMessage: 'ECONNRESET' }), providerResponse([{ type: 'text', text: 'success' }], 'stop', 4, 0.5)]
    const client = nativeClient(outputs, captured)
    const result = await client.chat([userMessage('start')], undefined, { retryDelayMs: 0 })
    // Non-agent usage stays the final request's context measurement; this field
    // is the public aggregate processed-token measurement across attempts.
    expect(result.totalTokensUsed).toBe(12)
    expect(result.nativeMessages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    expect(captured[1]!.messages).toEqual(captured[0]!.messages)
  })

  it('includes failed usage and cost in trusted execution accounting', async () => {
    const captured: Context[] = []
    const outputs = [providerResponse([], 'error', 8, 0.25, { errorMessage: 'ECONNRESET' }), providerResponse([{ type: 'text', text: 'success' }], 'stop', 4, 0.5)]
    const client = nativeClient(outputs, captured)
    const result = await client.chat([userMessage('start')], undefined, { retryDelayMs: 0, trustedAgent: {
      systemPrompt: 'Fixture', grants: { skills: [], mcpTools: [], builtinTools: [], denied: [] },
      budget: { maxTurns: 5, maxToolCalls: 5, maxElapsedMs: 5000, maxCostUsd: 1 }
    } })
    expect(result.usage.totalTokens).toBe(12)
    expect(result.usage.cost.total).toBe(0.75)
  })

  it('stops instead of retrying after a billable failed response exceeds the trusted budget', async () => {
    const captured: Context[] = []
    const outputs = [providerResponse([], 'error', 8, 0.25, { errorMessage: 'ECONNRESET' }), success()]
    const client = nativeClient(outputs, captured)
    const onRetry = vi.fn()
    const result = await client.chat([userMessage('start')], undefined, { retryDelayMs: 0, onRetry, trustedAgent: {
      systemPrompt: 'Fixture', grants: { skills: [], mcpTools: [], builtinTools: [], denied: [] },
      budget: { maxTurns: 5, maxToolCalls: 5, maxElapsedMs: 5000, maxCostUsd: 0.1 }
    } })
    expect(result.limitExceeded).toMatchObject({ kind: 'cost_usd', limit: 0.1, actual: 0.25 })
    expect(captured).toHaveLength(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('cancels retry waiting without starting another request', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const operation = vi.fn(async () => { throw new Error('fetch failed') })
    const onRetry = vi.fn()
    const waiting = retryConnectionFailures(operation, onRetry, { signal: controller.signal })
    const assertion = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(onRetry).toHaveBeenCalledOnce())
    controller.abort()
    await assertion
    expect(operation).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops after five retries with a typed exhaustion result', async () => {
    const captured: Context[] = []
    const stream = vi.fn(() => failingStream())
    const client = nativeClient([], captured, { streamSimple: stream })
    const retries: number[] = []
    await expect(client.chat([userMessage('start')], undefined, { retryDelayMs: 0, onRetry: (attempt) => retries.push(attempt) }))
      .rejects.toMatchObject({ code: 'provider_retry_exhausted', errorInfo: { retryable: false } })
    expect(stream).toHaveBeenCalledTimes(6)
    expect(retries).toEqual([1, 2, 3, 4, 5])
  })

  it.each([
    [429, 'rate_limit_error', 'provider_rate_limited'],
    [503, 'overloaded_error', 'provider_unavailable']
  ] as const)('preserves long Retry-After from actual pi Anthropic HTTP %i before SDK stringification', async (status, errorType, code) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: errorType, message: 'Slow down sk-privateFixture' } }), {
      status, headers: { 'Retry-After': '60', 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetch)
    const settings = getDefaultSettings()
    settings.provider = { llmProvider: 'anthropic', model: 'fixture-model' }
    settings.integrations.skills.enabled = false
    const streamSimple = vi.fn((model, context, options) => piStreamSimple(model, context, { ...options, apiKey: 'fixture-key' }))
    const models = { getModel: (provider: string, id: string) => ({ ...fixtureModel(provider, id), baseUrl: 'https://api.anthropic.com' }), getAuth: async () => ({ apiKey: 'fixture-key' }), streamSimple }
    const client = new LlmClient({ get: () => settings } as never, { has: () => true, credentials: { listProviderIds: () => ['anthropic'] }, models } as never)
    const onRetry = vi.fn()
    const failure = await client.chat([userMessage('start')], undefined, { retryDelayMs: 0, onRetry }).catch((error) => error)
    expect(fetch, String(failure.cause?.message ?? failure.cause ?? '')).toHaveBeenCalledOnce()
    expect(failure).toMatchObject({ code, errorInfo: { retryable: false } })
    expect(failure.message).not.toContain('privateFixture')
    expect(failure.details).toEqual({ provider: 'anthropic', status })
    expect(streamSimple).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it.each([
    ['rate_limit_error', 'Temporary fixture problem'],
    ['overloaded_error', 'Temporary fixture problem'],
    ['rate_limit_error', 'Rate limit exceeded for 400,000 tokens']
  ])('retries actual Pi Anthropic HTTP200 SSE %s before output (%s)', async (errorType, message) => {
    const sse = (events: Array<[string, unknown]>) => events.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join('')
    const failure = sse([['error', { type: 'error', error: { type: errorType, message } }]])
    const recovered = sse([
      ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'fixture-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'recovered answer' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
      ['message_stop', { type: 'message_stop' }]
    ])
    let calls = 0
    const fetch = vi.fn(async () => new Response(++calls === 1 ? failure : recovered, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetch)
    const settings = getDefaultSettings()
    settings.provider = { llmProvider: 'anthropic', model: 'fixture-model' }
    settings.integrations.skills.enabled = false
    const streamSimple = vi.fn((model, context, options) => piStreamSimple(model, context, { ...options, apiKey: 'fixture-key' }))
    const models = { getModel: (provider: string, id: string) => ({ ...fixtureModel(provider, id), baseUrl: 'https://api.anthropic.com' }), getAuth: async () => ({ apiKey: 'fixture-key' }), streamSimple }
    const client = new LlmClient({ get: () => settings } as never, { has: () => true, credentials: { listProviderIds: () => ['anthropic'] }, models } as never)
    const onRetry = vi.fn()
    const result = await client.chat([userMessage('start')], undefined, { retryDelayMs: 0, onRetry })
    expect(result.text).toBe('recovered answer')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(streamSimple).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('uses per-attempt onResponse headers to honor a short retry-after delay', async () => {
    const settings = getDefaultSettings()
    settings.provider = { llmProvider: 'fixture-provider', model: 'fixture-model' }
    settings.integrations.skills.enabled = false
    let calls = 0
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const models = {
      getModel: fixtureModel, getAuth: async () => ({ apiKey: 'fixture' }),
      streamSimple: (_model: unknown, _context: Context, options: { maxRetries: number; onResponse: (response: { status: number; headers: Record<string, string> }) => void }) => {
        expect(options.maxRetries).toBe(0)
        calls += 1
        if (calls === 1) {
          options.onResponse({ status: 429, headers: { 'Retry-After': '0.012' } })
          return streamOf(providerResponse([], 'error', 4, 0, { errorMessage: 'rate limit' }))
        }
        return streamOf(success())
      }
    }
    const client = new LlmClient({ get: () => settings } as never, { has: () => true, credentials: { listProviderIds: () => ['fixture-provider'] }, models } as never)
    const onRetry = vi.fn()
    expect((await client.chat([userMessage('start')], undefined, { retryDelayMs: 0, onRetry })).text).toBe('recovered answer')
    expect(calls).toBe(2)
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(1)
    expect(timer.mock.calls.some((call) => call[1] === 12)).toBe(true)
  })
})

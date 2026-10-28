/**
 * PR 4 §4 `HarnessGateway.oneShot`: one model request with no tools (chat titles), resolved like a
 * turn for its purpose. The pi driver makes one pi-ai request in Mousse's process; the gateway owns
 * a 60 s inactivity timeout and never retries; hidden models, turned-off instances and agent runtimes
 * (`oneShot` absent) are refused with their typed errors.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ONE_SHOT_INACTIVITY_MS, type Harness, type OneShotRequest } from '../../src/mms/harness/gateway'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { runPiOneShot } from '../../src/mms/harness/drivers/pi/oneShot'
import { streamSimple as bedrockStreamSimple } from '@earendil-works/pi-ai/api/bedrock-converse-stream'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { CODEX_CAPABILITIES } from '../../src/mms/harness/drivers/codex/adapter'
import type { ProviderAdapter } from '../../src/mms/harness/adapter'
import { testHarness } from '../../src/mms/run/testkit/harness'

const homes: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const MODEL = { id: 'gpt-x', name: 'GPT X', api: 'openai-responses', provider: 'openai', baseUrl: 'http://127.0.0.1:1', reasoning: true, input: ['text'], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as unknown as Model<'openai-responses'>

const reply = (text: string): AssistantMessage => ({
  role: 'assistant', api: MODEL.api, provider: MODEL.provider, model: MODEL.id, content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
})

/** pi-ai models whose `streamSimple` is scripted per test; every request is recorded. */
function piModels() {
  const requests: Array<{ model: Model<never>; context: Context; options: Record<string, unknown> }> = []
  let script: (stream: AssistantMessageEventStream, signal?: AbortSignal) => void = (stream) => {
    const message = reply('A clear title')
    stream.push({ type: 'text_delta', contentIndex: 0, delta: 'A clear title', partial: message })
    stream.push({ type: 'done', reason: 'stop', message })
    stream.end(message)
  }
  const models = {
    getModel: (provider: string, id: string) => (provider === 'openai' && id === MODEL.id ? MODEL : undefined),
    getModels: () => [MODEL],
    getAuth: async () => ({ apiKey: 'sk-test' }),
    stream: vi.fn(),
    streamSimple: vi.fn((model: Model<never>, context: Context, options: Record<string, unknown>) => {
      requests.push({ model, context, options })
      const stream = createAssistantMessageEventStream()
      queueMicrotask(() => script(stream, options.signal as AbortSignal | undefined))
      return stream
    })
  }
  return { models, requests, respond: (next: typeof script) => { script = next } }
}

/** A Codex-like agent runtime: runs turns only. */
const agent: ProviderAdapter = {
  driver: 'codex',
  capabilities: { ...CODEX_CAPABILITIES },
  configured: () => true,
  startTurn: async () => { throw new Error('unused') },
  interrupt: async () => 'not_active'
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mousse-one-shot-'))
  homes.push(home)
  const pi = piModels()
  const credentials = {
    has: () => true,
    getConfiguredProviders: () => [{ id: 'openai', label: 'OpenAI', authType: 'api_key' as const }],
    getConfiguredLlmProviders: () => [{ id: 'openai', label: 'OpenAI', models: [{ id: MODEL.id, label: 'GPT X' }] }],
    models: pi.models
  }
  let stored: unknown = { 'pi:openai': { driver: 'pi', enabled: true }, codex: { driver: 'codex', enabled: true } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({
    adapters: [agent],
    drivers: [piDriver({ credentials: () => credentials as never })],
    instances,
    profileHome: home
  })
  harnesses.push(harness)
  const request = (patch: Partial<OneShotRequest> = {}): OneShotRequest => ({
    selection: { instanceId: 'pi:openai', llmProvider: 'openai', model: `${MODEL.id}:low` },
    purpose: 'title',
    system: 'You name chats.',
    prompt: 'User request: fix the login bug',
    maxChars: 80,
    sessionKey: 'thread-1',
    ...patch
  })
  return { harness, pi, request }
}

describe('gateway.oneShot on the pi driver', () => {
  it('makes one pi-ai request with no tools and returns its text', async () => {
    const s = setup()
    expect(await s.harness.oneShot(s.request())).toEqual({ text: 'A clear title' })
    expect(s.pi.requests).toHaveLength(1)
    const [sent] = s.pi.requests
    expect(sent.model.id).toBe(MODEL.id)
    expect(sent.context).toEqual({ systemPrompt: 'You name chats.', messages: [expect.objectContaining({ role: 'user', content: 'User request: fix the login bug' })] })
    expect(sent.context.tools).toBeUndefined()
    // The effort suffix becomes the reasoning level; the thread id reaches the provider only hashed.
    expect(sent.options).toMatchObject({ reasoning: 'low', sessionId: expect.stringMatching(/^mousse-[0-9a-f]{48}$/) })
    expect(JSON.stringify(sent.options)).not.toContain('thread-1')
  })

  it('cuts the text to maxChars', async () => {
    const s = setup()
    expect(await s.harness.oneShot(s.request({ maxChars: 7 }))).toEqual({ text: 'A clear' })
  })

  it('reports a provider failure and does not retry', async () => {
    const s = setup()
    s.pi.respond((stream) => {
      const failed = { ...reply(''), stopReason: 'error' as const, errorMessage: '401 invalid api key' }
      stream.push({ type: 'error', reason: 'error', error: failed })
      stream.end(failed)
    })
    await expect(s.harness.oneShot(s.request())).rejects.toThrow()
    expect(s.pi.requests).toHaveLength(1)
  })

  it('ends with `timeout` after 60 s without a provider event, and aborts the request', async () => {
    vi.useFakeTimers()
    const s = setup()
    let aborted = false
    s.pi.respond((_stream, signal) => signal?.addEventListener('abort', () => { aborted = true }))
    const pending = s.harness.oneShot(s.request())
    const settled = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(ONE_SHOT_INACTIVITY_MS - 1)
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(aborted).toBe(true)
    expect(ONE_SHOT_INACTIVITY_MS).toBe(60_000)
    expect(s.pi.requests).toHaveLength(1)
  })

  it('bounds the credential read too: a refresh that hangs ends with `timeout` and sends nothing', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.pi.models.getAuth = () => new Promise(() => {})
    const pending = s.harness.oneShot(s.request())
    const settled = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(ONE_SHOT_INACTIVITY_MS)
    await settled
    expect(s.pi.requests).toHaveLength(0)
  })

  it('restarts the timeout on every provider event', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.pi.respond((stream) => {
      const message = reply('Slow title')
      setTimeout(() => stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Slow', partial: message }), 50_000)
      setTimeout(() => {
        stream.push({ type: 'done', reason: 'stop', message })
        stream.end(message)
      }, 100_000)
    })
    const pending = s.harness.oneShot(s.request())
    await vi.advanceTimersByTimeAsync(100_000)
    await expect(pending).resolves.toEqual({ text: 'Slow title' })
  })

  it('a caller stop is not reported as a timeout', async () => {
    const s = setup()
    s.pi.respond(() => {})
    const stop = new AbortController()
    const pending = s.harness.oneShot(s.request({ signal: stop.signal }))
    await Promise.resolve()
    stop.abort()
    await expect(pending).rejects.not.toMatchObject({ code: 'timeout' })
  })
})

describe('gateway.oneShot refusals', () => {
  it('refuses a hidden model', async () => {
    const s = setup()
    await s.harness.instances.setModelPrefs('pi:openai', { hide: [MODEL.id] })
    await expect(s.harness.oneShot(s.request())).rejects.toMatchObject({ code: 'model_hidden' })
    expect(s.pi.requests).toHaveLength(0)
  })

  it('refuses an instance turned off on the device or for the project', async () => {
    const s = setup()
    await s.harness.instances.setEnabled('pi:openai', { kind: 'project', projectId: 'p1' }, false)
    await expect(s.harness.oneShot(s.request({ scope: { kind: 'project', projectId: 'p1' } }))).rejects.toMatchObject({ code: 'instance_disabled' })
    await s.harness.instances.setEnabled('pi:openai', { kind: 'device' }, false)
    await expect(s.harness.oneShot(s.request())).rejects.toMatchObject({ code: 'instance_disabled' })
    expect(s.pi.requests).toHaveLength(0)
  })

  it('refuses an agent runtime (`oneShot` absent) with `unsupported`', async () => {
    const s = setup()
    await expect(s.harness.oneShot(s.request({ selection: { instanceId: 'codex', llmProvider: 'codex', model: 'gpt-5' } }))).rejects.toMatchObject({ code: 'unsupported' })
    expect(s.pi.requests).toHaveLength(0)
  })
})

describe('Bedrock one-shots', () => {
  it('are refused as unsupported with zero HTTP requests, and the process environment is untouched', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.writeHead(503, { 'content-type': 'application/json', 'x-amzn-errortype': 'ServiceUnavailableException' })
      response.end(JSON.stringify({ message: 'offline recorder' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    vi.stubEnv('AWS_MAX_ATTEMPTS', '3')
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) vi.stubEnv(name, '')
    const model = { id: 'anthropic.claude-3-haiku-20240307-v1:0', name: 'Recorder', provider: 'amazon-bedrock', api: 'bedrock-converse-stream', baseUrl: `http://127.0.0.1:${port}`, reasoning: false, input: ['text'], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 100 } as unknown as Model<'bedrock-converse-stream'>
    const streamSimple = vi.fn((target: Model<'bedrock-converse-stream'>, context: Context, options: Record<string, unknown>) =>
      // The real pinned Bedrock transport, pointed at the recorder with no AWS sign-in.
      bedrockStreamSimple(target, context, { ...options, env: { AWS_BEDROCK_SKIP_AUTH: '1', AWS_BEDROCK_FORCE_HTTP1: '1', AWS_REGION: 'us-east-1' } } as never))
    const models = { getModel: () => model, getModels: () => [model], getAuth: async () => ({ apiKey: 'fake' }), stream: () => { throw new Error('unused') }, streamSimple }
    try {
      await expect(runPiOneShot(models as never, 'amazon-bedrock', { model: model.id, system: 'Name chats.', prompt: 'hi', onActivity: () => {} }, AbortSignal.timeout(20_000)))
        .rejects.toMatchObject({ code: 'unsupported' })
      expect(streamSimple).not.toHaveBeenCalled()
      expect(requests).toBe(0)
      expect(process.env.AWS_MAX_ATTEMPTS).toBe('3')
    } finally {
      vi.unstubAllEnvs()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('the refusal names what the request was for', async () => {
    const model = { id: 'anthropic.claude', provider: 'amazon-bedrock', api: 'bedrock-converse-stream' }
    const models = { getModel: () => model, getModels: () => [model], getAuth: vi.fn(), stream: vi.fn(), streamSimple: vi.fn() }
    const refusal = (task?: 'title' | 'pull_request' | 'commit_message') =>
      runPiOneShot(models as never, 'amazon-bedrock', { model: model.id, system: '', prompt: '', onActivity: () => {}, ...(task ? { task } : {}) }, AbortSignal.timeout(5_000)).catch((error: Error) => error.message)
    expect(await refusal()).toMatch(/^Bedrock models cannot name chats yet\./)
    expect(await refusal('pull_request')).toMatch(/^Bedrock models cannot draft pull requests yet\./)
    expect(await refusal('commit_message')).toMatch(/^Bedrock models cannot write commit messages yet\./)
    expect(models.getAuth).not.toHaveBeenCalled()
  })
})

describe('runPiOneShot cancellation', () => {
  it('a pre-cancelled one-shot never starts the credential read, so its failure cannot go unhandled', async () => {
    const getAuth = vi.fn(async () => { throw new Error('offline credential refresh failed') })
    const model = { id: 'offline', provider: 'openai', api: 'openai-responses' }
    const models = { getModel: () => model, getModels: () => [model], getAuth, stream: vi.fn(), streamSimple: vi.fn() }
    await expect(runPiOneShot(models as never, 'openai', { model: model.id, system: '', prompt: '', onActivity: () => {} }, AbortSignal.abort()))
      .rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(getAuth).not.toHaveBeenCalled()
    expect(models.streamSimple).not.toHaveBeenCalled()
  })

  it('a credential read that fails after a stop is handled', async () => {
    let fail: (error: Error) => void = () => {}
    const getAuth = vi.fn(() => new Promise((_resolve, reject) => { fail = reject }))
    const model = { id: 'offline', provider: 'openai', api: 'openai-responses' }
    const models = { getModel: () => model, getModels: () => [model], getAuth, stream: vi.fn(), streamSimple: vi.fn() }
    const stop = new AbortController()
    const pending = runPiOneShot(models as never, 'openai', { model: model.id, system: '', prompt: '', onActivity: () => {} }, stop.signal)
    stop.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    fail(new Error('offline credential refresh failed'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(models.streamSimple).not.toHaveBeenCalled()
  })
})

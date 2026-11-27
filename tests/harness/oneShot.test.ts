/**
 * PR 4 §4 `HarnessGateway.oneShot`: one model request with no tools (chat titles), resolved like a
 * turn for its purpose. The pi driver makes one pi-ai request in Mousse's process; the gateway owns
 * a 60 s inactivity timeout and never retries; hidden models, turned-off instances and drivers without
 * one-shots (`oneShot` absent) are refused with their typed errors. Claude Code and Codex run one-shots
 * through their own runtimes (covered in their provider tests).
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
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { runPiOneShot } from '../../src/mms/harness/drivers/pi/oneShot'
import { streamSimple as bedrockStreamSimple } from '@earendil-works/pi-ai/api/bedrock-converse-stream'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { CODEX_CAPABILITIES } from '../../src/mms/harness/drivers/codex/adapter'
import type { ProviderAdapter } from '../../src/mms/harness/adapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { legacyOneShotRoute } from '../../src/mms/harness/oneShot/routes'
import { botDigestOneShot, botNameOneShot } from '../../src/mms/bots/botOneShots'

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

/** An agent runtime without one-shots (the test kit's driver for it declares none): runs turns only. */
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

  it('refuses an instance turned off on the device', async () => {
    const s = setup()
    await s.harness.instances.setEnabled('pi:openai', false)
    await expect(s.harness.oneShot(s.request())).rejects.toMatchObject({ code: 'instance_disabled' })
    expect(s.pi.requests).toHaveLength(0)
  })

  it('Claude Code and Codex declare one-shots, so their models are offered for titles', () => {
    expect(claudeCodeDriver().oneShotRoute).toBeDefined()
    expect(codexDriver({ builtIn: () => { throw new Error('unused') } }).oneShotRoute).toBeDefined()
  })

  it('refuses an agent runtime without one-shots (`oneShot` absent) with `unsupported`', async () => {
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

describe('a local server model through the gateway', () => {
  const LOCAL = { ...MODEL, id: 'phi3:medium', name: 'phi3:medium', provider: 'local-ollama', reasoning: false } as unknown as Model<'openai-responses'>
  function localSetup() {
    const home = mkdtempSync(join(tmpdir(), 'mousse-one-shot-local-'))
    homes.push(home)
    const pi = piModels()
    pi.models.getModel = (provider: string, id: string) => (provider === 'local-ollama' && id === 'phi3:medium' ? LOCAL : undefined)
    const credentials = {
      has: () => true,
      getConfiguredProviders: () => [{ id: 'local-ollama', label: 'Ollama', authType: 'api_key' as const }],
      // The server lists only the literal id, which ends like a reasoning level.
      getConfiguredLlmProviders: () => [{ id: 'local-ollama', label: 'Ollama', models: [{ id: 'phi3:medium', label: 'phi3:medium', local: { tools: 'reported', images: false, loaded: true } }] }],
      models: pi.models
    }
    let stored: unknown = { 'pi:local-ollama': { driver: 'pi', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({ drivers: [piDriver({ credentials: () => credentials as never })], instances, profileHome: home })
    harnesses.push(harness)
    return { harness, pi }
  }

  it("names its own thread with the exact id it lists, though the id ends like a level; another thread's request is refused", async () => {
    const s = localSetup()
    const request = { selection: { instanceId: 'pi:local-ollama', llmProvider: 'local-ollama', model: 'phi3:medium' }, purpose: 'title' as const, system: 'You name chats.', prompt: 'fix the login bug', maxChars: 80 }
    expect(await s.harness.oneShot({ ...request, localThread: { resident: true } })).toEqual({ text: 'A clear title' })
    expect(s.pi.requests.map((sent) => sent.model.id)).toEqual(['phi3:medium'])
    await expect(s.harness.oneShot(request)).rejects.toMatchObject({ code: 'unsupported' })
    expect(s.pi.requests).toHaveLength(1)
  })
})

describe('pi:direct sends one request on the wire', () => {
  // A Codex model on a loopback server that refuses every request: the pinned pi-ai's own Codex transport, unchanged.
  it.each([429, 503])('a Codex model answered %i is asked once: no WebSocket attempt, no HTTP fallback, no retry', async (status) => {
    const { streamSimple: codexStreamSimple } = await import('@earendil-works/pi-ai/api/openai-codex-responses')
    const contacts: string[] = []
    const server = createServer((req, res) => {
      contacts.push(`${req.method} ${req.url}`)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'busy' } }))
    })
    server.on('upgrade', (req, socket) => { contacts.push(`UPGRADE ${req.url}`); socket.destroy() })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const codex = { ...MODEL, id: 'gpt-codex', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: `http://127.0.0.1:${port}` } as unknown as Model<never>
      const claim = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } })).toString('base64url')
      const token = `e30.${claim}.sig`
      const models = {
        getModel: (_provider: string, id: string) => (id === 'gpt-codex' ? codex : undefined),
        getModels: () => [codex],
        getAuth: async () => ({ apiKey: token }),
        stream: vi.fn(),
        streamSimple: (model: Model<never>, context: Context, options: Record<string, unknown>) => codexStreamSimple(model as never, context, { ...options, apiKey: token } as never)
      }
      await expect(runPiOneShot(models as never, 'openai-codex', { model: 'gpt-codex', system: 'You name chats.', prompt: 'fix the login bug', onActivity: () => {} }, new AbortController().signal)).rejects.toThrow()
      expect(contacts).toEqual(['POST /codex/responses'])
    } finally {
      server.close()
    }
  })
})

describe('pi:direct streams its answer to the runner', () => {
  it('an answer past the streaming cap ends the request while it streams, not once it is all buffered', async () => {
    const s = setup()
    let pushed = 0
    s.pi.respond((stream, signal) => {
      const message = reply('')
      // Streams 1,000-character parts until stopped; it never finishes on its own.
      const push = () => {
        if (signal?.aborted || pushed > 500) return
        pushed++
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(1_000), partial: message })
        setImmediate(push)
      }
      push()
    })
    await expect(s.harness.oneShot(s.request())).rejects.toMatchObject({ code: 'protocol', message: expect.stringContaining('more than') })
    expect(pushed).toBeLessThan(200)
  })
})

describe('pi:direct checks the entry again once its credential is read', () => {
  it('a sign-in that changed while the credential was read stops the request before it is sent', async () => {
    const s = setup()
    const getAuth = s.pi.models.getAuth
    s.pi.models.getAuth = async (...args: Parameters<typeof getAuth>) => {
      // Another sign-in lands on the entry while its credential is read.
      ;(s.harness as unknown as { counters: { bumpAccount(id: string): void } }).counters.bumpAccount('pi:openai')
      return getAuth(...args)
    }
    await expect(s.harness.oneShot(s.request())).rejects.toMatchObject({ code: 'binding_stale' })
    expect(s.pi.requests).toHaveLength(0)
  })
})

describe('the gateway admits from cached state', () => {
  function entrySetup(options: { config?: Record<string, unknown>; auth?: 'signed_out'; enabled?: false } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'mousse-one-shot-entry-'))
    homes.push(home)
    const oneShot = vi.fn(async () => ({ text: 'An answer' }))
    const base = adapterDriver(agent, {
      runtime: {
        oneShot,
        llmProvider: () => ({ id: 'codex', label: 'Codex', models: [{ id: 'gpt-5', label: 'GPT-5' }] }),
        models: () => [{ id: 'gpt-5', label: 'GPT-5' }],
        ...(options.auth ? { auth: async () => ({ state: options.auth! }) } : {})
      }
    })
    const driver = { ...base, oneShotRoute: legacyOneShotRoute('codex'), ...(options.config ? { decodeConfig: () => ({ ...options.config }) } : {}) }
    let stored: unknown = { codex: { driver: 'codex', enabled: options.enabled ?? true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({ drivers: [driver], instances, profileHome: home })
    harnesses.push(harness)
    return { harness, oneShot }
  }
  const selection = { instanceId: 'codex', model: 'gpt-5' }

  it("a bot-only entry runs its bots' name and digest through the bots' own callbacks, and refuses a thread's title", async () => {
    const s = entrySetup({ config: { profile: 'locked', home: 'private' } })
    expect(await botNameOneShot(s.harness, { selection, prompt: 'Watches the build.' })).toBe('An answer')
    expect(await botDigestOneShot(s.harness, { selection, system: 'Summarise.', prompt: 'The chat.' })).toBe('An answer')
    await expect(s.harness.oneShot({ selection: { ...selection, llmProvider: 'codex' }, purpose: 'title', system: 's', prompt: 'p', maxChars: 80 })).rejects.toMatchObject({ code: 'unsupported' })
    expect(s.oneShot).toHaveBeenCalledTimes(2)
  })

  it('a turned-off entry is listed for titles with each of its models and why it cannot name threads', () => {
    const s = entrySetup({ enabled: false })
    const entry = s.harness.titleListing({ instanceId: 'codex', llmProvider: 'codex', model: 'gpt-5' })
    expect(entry.entries.find((each) => each.instanceId === 'codex')?.models).toEqual([expect.objectContaining({ id: 'gpt-5', state: 'unavailable', reason: expect.stringContaining('turned off') })])
    expect(entry.saved).toMatchObject({ instanceId: 'codex', state: 'unavailable' })
  })

  it('an entry its provider reported signed out is not sent to, once its check has read that', async () => {
    const s = entrySetup({ auth: 'signed_out' })
    await s.harness.llmProviders({ kind: 'device' })
    await expect(s.harness.oneShot({ selection: { ...selection, llmProvider: 'codex' }, purpose: 'title', system: 's', prompt: 'p', maxChars: 80 })).rejects.toMatchObject({ code: 'signed_out' })
    expect(s.oneShot).not.toHaveBeenCalled()
  })
})

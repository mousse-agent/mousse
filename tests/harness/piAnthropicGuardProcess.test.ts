import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PiBridge } from '../../src/mms/harness/pi/bridge'
import type { PiCatalogProvider, PiCatalogResponse, PiReadyRequest } from '../../src/mms/harness/pi/extension/protocol'
import { launchPi, scratchDir, startRecorder, testExtension, testSettings, type PiChild } from './piRpcFixture'

// The guarded provider wrapper inside the real pinned Pi child (PR 2 §4 "Spike", `piAnthropicGuard`):
// every model Pi offers is guarded and streams through the wrapper. Local recorders and fake keys
// only; a model whose request could leave this machine is never prompted.

const APIS = [
  'anthropic-messages', 'openai-completions', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses',
  'google-generative-ai', 'google-vertex', 'mistral-conversations', 'bedrock-converse-stream', 'pi-messages'
]

function model(provider: string, api: string, baseUrl: string) {
  return {
    id: `spike-${api}`, name: `Spike ${api}`, api, provider, baseUrl: `${baseUrl}/${api}`,
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096
  }
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface RunOptions {
  key: string
  copilotToken: (port: number) => string
  /** The instance provider (default: a custom provider with one model per API at the recorder). */
  provider?: (recorderUrl: string) => PiCatalogProvider
  /** Ask for a compaction after the prompts (a summarization request through the same path). */
  compact?: boolean
}

async function run(options: RunOptions) {
  const scratch = scratchDir()
  cleanups.push(() => scratch.cleanup())
  const recorder = await startRecorder()
  cleanups.push(() => recorder.close())
  const bridge = new PiBridge()
  await bridge.start()
  cleanups.push(() => bridge.stop())
  const ready: PiReadyRequest[] = []
  const provider = options.provider?.(recorder.url) ?? { id: 'mousse-spike', builtin: false, models: APIS.map((api) => model('mousse-spike', api, recorder.url)) as never }
  const catalog: PiCatalogResponse = { provider, apiKey: options.key, catalogRevision: 1 }
  const registration = bridge.register({
    catalog: async (first) => (first ? catalog : { ...catalog, apiKey: undefined }),
    ready: (request) => void ready.push(request),
    turn: async () => ({ attemptToken: 'a1', sessionInstructions: '', tools: [], activeBuiltins: [], mcp: null, catalogRevision: 1 }),
    gate: async () => ({ allow: false, reason: 'spike' }),
    quiesce: async () => ({ ok: false, reason: 'spike' }),
    fatal: () => {}
  })
  const extension = await testExtension(scratch.dir)
  const guardLog = join(scratch.dir, 'guard.log')
  const child: PiChild = launchPi({
    dir: scratch.dir, provider: provider.id, model: provider.models[0]!.id, extension, bridge: registration.address,
    homeFiles: {
      'settings.json': testSettings(),
      // A Copilot sign-in with a fake token whose proxy endpoint is the recorder.
      'auth.json': { 'github-copilot': { type: 'oauth', access: options.copilotToken(recorder.port), refresh: 'fake-refresh', expires: Date.now() + 86_400_000 } }
    },
    // No AWS credentials: the built-in Bedrock provider stays unavailable (it would reach AWS).
    env: { AWS_REGION: 'us-east-1' },
    engineEnv: { MOUSSE_PI_TEST_GUARD_LOG: guardLog }
  })
  cleanups.push(() => child.kill())
  await child.process.client.send({ type: 'get_state' }).catch((error) => { throw new Error(`${error.message}\n${child.process.stderr()}`) })
  expect(ready.length).toBeGreaterThan(0)
  const { models } = await child.process.client.send({ type: 'get_available_models' })
  const guarded = new Set(ready.at(-1)!.guarded)
  const admissions = () => (existsSync(guardLog) ? readFileSync(guardLog, 'utf8').split('\n').filter(Boolean).length : 0)
  const results: Array<{ provider: string; id: string; api: string; error?: string; connections: number; admitted: number; retried: boolean }> = []
  // Prompted: only models whose requests stay here (the recorder, or Copilot at the fake token's 127.0.0.1).
  const local = models.filter((entry) => entry.provider === 'github-copilot' || /^http:\/\/127\.0\.0\.1:/.test(entry.baseUrl ?? ''))
  for (const entry of local) {
    const before = recorder.connections()
    const logBefore = admissions()
    await child.process.client.send({ type: 'set_model', provider: entry.provider, modelId: entry.id })
    const from = child.events.length
    await child.process.client.send({ type: 'prompt', message: 'hello' })
    await child.next((event) => event.type === 'agent_settled', from)
    const events = child.events.slice(from)
    const end = events.filter((event) => event.type === 'message_end' && (event.message as { role?: string }).role === 'assistant').at(-1)
    results.push({
      provider: entry.provider, id: entry.id, api: entry.api,
      error: (end?.message as { errorMessage?: string } | undefined)?.errorMessage?.slice(0, 120),
      connections: recorder.connections() - before, admitted: admissions() - logBefore,
      retried: events.some((event) => event.type === 'auto_retry_start')
    })
  }
  let compaction: { error?: string; connections: number } | undefined
  if (options.compact) {
    const before = recorder.connections()
    const error = await child.process.client.send({ type: 'compact' }).then(() => undefined, (caught: Error) => caught.message)
    compaction = { error, connections: recorder.connections() - before }
  }
  return { models, local, guarded, results, recorder, compaction }
}

const OAT = 'sk-ant-oat01-fake'

describe('the guarded provider wrapper in the real Pi child', () => {
  it('guards every available model and refuses an Anthropic OAuth token on every API, with no retry and no request', async () => {
    const { models, local, guarded, results, recorder, compaction } = await run({ key: OAT, copilotToken: (port) => `${OAT};proxy-ep=127.0.0.1:${port};`, compact: true })
    for (const entry of models) expect(guarded.has(entry.provider), entry.provider).toBe(true)
    // Every API of the custom provider and Copilot's own APIs.
    expect(new Set(local.filter((entry) => entry.provider === 'mousse-spike').map((entry) => entry.api))).toEqual(new Set(APIS))
    expect(new Set(local.filter((entry) => entry.provider === 'github-copilot').map((entry) => entry.api))).toEqual(new Set(['anthropic-messages', 'openai-completions', 'openai-responses']))
    for (const result of results) {
      expect(result.error, `${result.provider}/${result.id}`).toBe('mousse_anthropic_oauth_refused')
      expect(result.retried, `${result.provider}/${result.id}`).toBe(false)
    }
    // A compaction with the planted token sends nothing either.
    expect(compaction?.connections).toBe(0)
    expect(recorder.connections()).toBe(0)
  }, 180_000)

  it('refuses an Anthropic-Messages model under openrouter with an OAuth token', async () => {
    const { local, results, recorder } = await run({
      key: OAT,
      copilotToken: (port) => `tid=fake;proxy-ep=127.0.0.1:${port};`,
      provider: (url) => ({ id: 'openrouter', builtin: true, models: [model('openrouter', 'anthropic-messages', url)] as never })
    })
    const own = results.filter((result) => result.provider === 'openrouter')
    expect(local.some((entry) => entry.provider === 'openrouter' && entry.api === 'anthropic-messages')).toBe(true)
    expect(own.map((result) => result.error)).toEqual(['mousse_anthropic_oauth_refused'])
    expect(own[0].connections).toBe(0)
    void recorder
  }, 180_000)

  it('lets a plain key through the wrapper once per request, on every API', async () => {
    const { results } = await run({ key: 'fake-plain-key', copilotToken: (port) => `tid=fake;proxy-ep=127.0.0.1:${port};` })
    for (const result of results) expect(result.admitted, `${result.provider}/${result.api}`).toBeGreaterThan(0)
    // An admitted request reaches the recorder (HTTP, or a TLS attempt for Copilot), at most once per admission.
    for (const result of results) expect(result.connections, `${result.provider}/${result.api}`).toBeLessThanOrEqual(result.admitted)
  }, 180_000)
})

import { rmSync } from 'node:fs'
import { createServer, type Http2Server } from 'node:http2'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { PiBridge } from '../../src/mms/harness/pi/bridge'
import type { PiCatalogResponse } from '../../src/mms/harness/pi/extension/protocol'
import { launchPi, scratchDir, testExtension, testSettings } from './piRpcFixture'

// Bedrock's AWS SDK retries below Pi's request guard unless the launcher pins it to one attempt
// (PR 2 v5 change 1). A local cleartext HTTP/2 recorder counts every request the SDK sends.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** How the recorder fails every request, as Bedrock sends each error. */
const FAILURES = {
  unavailable: { status: 503, type: 'ServiceUnavailableException', message: 'Service unavailable' },
  throttled: { status: 429, type: 'ThrottlingException', message: 'Too many requests, please wait before trying again.' }
} as const

/** Always fails with `failure` (default: 503 ServiceUnavailableException). */
async function bedrockRecorder(failure: (typeof FAILURES)[keyof typeof FAILURES] = FAILURES.unavailable): Promise<{ url: string; requests: () => number }> {
  let requests = 0
  const server: Http2Server = createServer((_req, res) => {
    requests += 1
    res.writeHead(failure.status, { 'content-type': 'application/json', 'x-amzn-errortype': failure.type })
    res.end(JSON.stringify({ message: failure.message }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => requests }
}

interface AttemptOptions {
  failure?: (typeof FAILURES)[keyof typeof FAILURES]
  /** Pi's own retry (off by default). */
  retries?: number
  /** `/pi/request` refuses once this many requests were admitted (as a run's `maxTurns`). */
  maxTurns?: number
}

async function oneAttempt(adjustEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv, options: AttemptOptions = {}): Promise<{ requests: number; error?: string; admitted: number; asked: number; retries: number }> {
  const scratch = scratchDir()
  cleanups.push(() => scratch.cleanup())
  const recorder = await bedrockRecorder(options.failure)
  const bridge = new PiBridge()
  await bridge.start()
  cleanups.push(() => bridge.stop())
  const catalog: PiCatalogResponse = {
    provider: {
      id: 'bedrock-mock', builtin: false,
      models: [{ id: 'anthropic.claude-mock', name: 'Mock', api: 'bedrock-converse-stream', provider: 'bedrock-mock', baseUrl: recorder.url, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] as never
    },
    apiKey: 'fake-bedrock-bearer',
    catalogRevision: 1
  }
  let asked = 0
  const registration = bridge.register({
    catalog: async () => catalog, ready: () => {},
    turn: async () => ({ attemptToken: 'a', sessionInstructions: '', tools: [], activeBuiltins: [], mcp: null, catalogRevision: 1 }),
    gate: async () => ({ allow: false, reason: 'x' }),
    request: async () => {
      asked += 1
      return options.maxTurns !== undefined && asked > options.maxTurns ? { ok: false, reason: 'mousse_budget_exhausted' } : { ok: true }
    },
    quiesce: async () => ({ ok: false, reason: 'x' }), fatal: () => {}
  })
  const extension = await testExtension(scratch.dir)
  const log = `${scratch.dir}/guard.log`
  const child = launchPi({
    dir: scratch.dir, provider: 'bedrock-mock', model: 'anthropic.claude-mock', extension, bridge: registration.address,
    homeFiles: { 'settings.json': testSettings(options.retries ? { retry: { enabled: true, maxRetries: options.retries, baseDelayMs: 10, provider: { maxRetries: 0 } } } : {}) },
    env: { AWS_REGION: 'us-east-1' },
    engineEnv: { MOUSSE_PI_TEST_GUARD_LOG: log },
    ...(adjustEnv ? { adjustEnv } : {})
  })
  cleanups.push(() => child.kill())
  await child.process.client.send({ type: 'get_state' })
  const from = child.events.length
  await child.process.client.send({ type: 'prompt', message: 'hello' })
  await child.next((event) => event.type === 'agent_settled', from)
  const end = child.events.slice(from).filter((event) => event.type === 'message_end' && (event.message as { role?: string }).role === 'assistant').at(-1)
  const { existsSync, readFileSync } = await import('node:fs')
  const admitted = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
  const retries = child.events.slice(from).filter((event) => event.type === 'auto_retry_start').length
  return { requests: recorder.requests(), error: (end?.message as { errorMessage?: string } | undefined)?.errorMessage, admitted, asked, retries }
}

describe('Bedrock below the guard', () => {
  it('sends one HTTP request per guard admission with the launcher’s AWS pins', async () => {
    const pinned = await oneAttempt()
    expect(pinned.admitted).toBe(1)
    expect(pinned.requests).toBe(1)
  }, 60_000)

  it('a profile’s max_attempts and retry_mode in the AWS config file change nothing', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(`${tmpdir()}/mousse-aws-`)
    const config = `${dir}/config`
    writeFileSync(config, ['[default]', 'max_attempts = 5', 'retry_mode = adaptive', ''].join('\n'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const withFile = await oneAttempt((env) => ({ ...env, AWS_CONFIG_FILE: config }))
    expect(withFile.requests).toBe(1)
  }, 60_000)

  it('negative control: without AWS_MAX_ATTEMPTS the SDK retries below the guard', async () => {
    const unpinned = await oneAttempt((env) => {
      const next = { ...env }
      delete next.AWS_MAX_ATTEMPTS
      delete next.AWS_RETRY_MODE
      return next
    })
    expect(unpinned.admitted).toBe(1)
    expect(unpinned.requests).toBe(3)
  }, 60_000)

  for (const [name, failure] of Object.entries(FAILURES)) {
    it(`always ${failure.status} (${failure.type}): one HTTP request per /pi/request admission and per guard pass, on every agent attempt`, async () => {
      const counted = await oneAttempt(undefined, { failure, retries: 2 })
      // The first attempt and Pi's two retries, each one HTTP request.
      expect(counted.retries, name).toBe(2)
      expect(counted.requests, name).toBe(3)
      expect(counted.asked, name).toBe(3)
      expect(counted.admitted, name).toBe(3)
    }, 60_000)

    it(`always ${failure.status} (${failure.type}) with maxTurns 2: the third attempt is refused with nothing more sent`, async () => {
      const limited = await oneAttempt(undefined, { failure, retries: 3, maxTurns: 2 })
      expect(limited.requests, name).toBe(2)
      expect(limited.admitted, name).toBe(2)
      expect(limited.asked, name).toBe(3)
      expect(limited.error, name).toBe('mousse_budget_exhausted')
      // The refusal itself is not retried.
      expect(limited.retries, name).toBe(2)
    }, 60_000)
  }
})

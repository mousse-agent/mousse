/**
 * A Codex entry on the model provider its own config.toml selects (docs/plans/codex-own-provider.md),
 * on the wire: the pinned Codex binary (`npm run codex:pin`) run by Mousse's real
 * `CodexProviderService`, the built token helper (`npm run build:cli`) and the broker, against a
 * fake Responses server on 127.0.0.1 standing in for the person's provider.
 *
 * Skips as `codexManagedWire.test.ts` does: without the pin or the helper, unless
 * `MOUSSE_CODEX_WIRE=required`; always with `MOUSSE_CODEX_WIRE=skip`.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ChatGptTokenBroker } from '../../src/mms/harness/vendors/codex/broker'
import { CodexInstallation } from '../../src/mms/harness/vendors/codex/installation'
import { MANAGED_OFFLINE_OVERRIDES } from '../../src/mms/harness/vendors/codex/managedRuntime'
import { spawnCodexAppServer, type CodexLaunch } from '../../src/mms/harness/vendors/codex/CodexAppServerClient'
import { CodexProviderService } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import { CUSTOM_MODEL_PROVIDER } from '../../src/mms/harness/vendors/codex/providerRoute'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import type { CodexModelRoute } from '../../src/shared/harness/modelRoute'

const root = resolve(__dirname, '..', '..')
const pinHome = join(root, '.cache', 'codex-pin')
const helperScript = join(root, 'out', 'cli', 'chatgpt-token.js')
const required = process.env.MOUSSE_CODEX_WIRE === 'required'
const missing = !new CodexInstallation({ installationHome: pinHome }).installed() || !existsSync(helperScript)
const skip = process.env.MOUSSE_CODEX_WIRE === 'skip' || (missing && !required)

const KEY = 'sk-wire-route-7f3a'

interface Recorded {
  path: string
  authorization?: string
  headers: IncomingMessage['headers']
  url: string
  body?: Record<string, unknown>
}

/** A request body as Codex sent it (zstd or gzip when it compresses). */
function decodeBody(raw: Buffer, encoding: string | undefined): Record<string, unknown> | undefined {
  try {
    const bytes = encoding === 'zstd' ? zstdDecompressSync(raw) : encoding === 'gzip' ? gunzipSync(raw) : raw
    return bytes.length ? (JSON.parse(bytes.toString('utf8')) as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function reply(text: string): string {
  const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  return sse([
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 12 } } }
  ])
}

/** The person's provider: a Responses endpoint and a model list, recording every request. */
class FakeProvider {
  base = ''
  readonly requests: Recorded[] = []
  private server!: Server

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const url = request.url ?? '/'
        const path = new URL(url, 'http://x').pathname
        const encoding = request.headers['content-encoding']
        const body = decodeBody(Buffer.concat(chunks), typeof encoding === 'string' ? encoding : undefined)
        this.requests.push({ path, url, headers: request.headers, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), ...(body ? { body } : {}) })
        if (path.endsWith('/models')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-wire', object: 'model' }] }))
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(reply('Hello from my provider.'))
      })
    })
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`
    return this
  }

  responses(): Recorded[] {
    return this.requests.filter((entry) => entry.path.endsWith('/responses'))
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((done) => this.server.close(() => done()))
  }
}

/** A TOML literal string: Windows paths keep their backslashes. */
function literal(text: string): string {
  return `'${text}'`
}

describe.skipIf(skip)('Codex on its own model provider (pinned binary, fake provider)', { timeout: 120_000 }, () => {
  let provider: FakeProvider
  const dirs: string[] = []
  const stops: Array<() => Promise<void>> = []

  beforeAll(async () => {
    if (!new CodexInstallation({ installationHome: pinHome }).installed()) throw new Error('The pinned Codex is missing: run `npm run codex:pin`.')
    if (!existsSync(helperScript)) throw new Error('The token helper is not built: run `npm run build:cli`.')
    provider = await new FakeProvider().start()
  })
  afterAll(async () => {
    await provider?.stop()
  })
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()))
    provider.requests.length = 0
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      } catch {
        // A Codex child on Windows may still hold a file.
      }
    }
  })

  /** The person's own Codex home with a custom provider and its key, and a trusted project folder. */
  function setup() {
    // Codex refuses its helper aliases under the system temp folder; the runs live beside the pin.
    mkdirSync(join(root, '.cache', 'wire-runs'), { recursive: true })
    const dir = mkdtempSync(join(root, '.cache', 'wire-runs', 'route-'))
    dirs.push(dir)
    const userHome = join(dir, 'user')
    const codexHome = join(userHome, '.codex')
    const workspace = join(dir, 'work')
    mkdirSync(codexHome, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    const writeConfig = (baseUrl: string) => writeFileSync(join(codexHome, 'config.toml'), [
      'model_provider = "mine"',
      '[model_providers.mine]',
      'name = "My provider"',
      `base_url = "${baseUrl}"`,
      'wire_api = "responses"',
      `experimental_bearer_token = "${KEY}"`,
      // The project is trusted, so its own .codex/config.toml is loaded as Codex would load it.
      `[projects.${literal(workspace)}]`,
      'trust_level = "trusted"'
    ].join('\n'))
    writeConfig(provider.base)
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/_proxy$|^(?:OPENAI_|CODEX_)/i.test(key))),
      NO_PROXY: '127.0.0.1,localhost',
      HOME: userHome,
      USERPROFILE: userHome,
      CODEX_HOME: codexHome
    }
    const route: { current: CodexModelRoute | undefined } = { current: { kind: 'custom', table: 'mine', baseUrl: provider.base } }
    const launches: CodexLaunch[] = []
    const broker = new ChatGptTokenBroker()
    const questions = new UserQuestionService()
    const profileHome = join(dir, 'profile')
    const service = new CodexProviderService(profileHome, questions, {
      launch: (spec) => {
        launches.push(spec)
        return spawnCodexAppServer(spec)
      },
      tokenBroker: broker,
      tokenHelper: (endpoint, leaseId) => ({ command: process.execPath, args: [helperScript, endpoint, leaseId], env: {} }),
      requestTimeoutMs: 60_000
    }, {
      launch: () => ({
        binaryPath: new CodexInstallation({ installationHome: pinHome }).installed()!.path,
        args: [...MANAGED_OFFLINE_OVERRIDES, 'analytics.enabled=false'].flatMap((override) => ['-c', override])
      }),
      env: () => env,
      modelRoute: () => route.current
    })
    stops.push(async () => {
      try {
        await service.stop()
      } finally {
        questions.shutdown()
        await broker.close()
      }
    })
    const turn = (threadId: string) => {
      const text: string[] = []
      return service
        .chat({ threadId, cwd: workspace, model: 'gpt-wire', prompt: 'Say hello.', mcp: null, onText: (delta) => text.push(delta) })
        .then(() => text.join(''))
    }
    return { service, route, launches, broker, turn, workspace, codexHome, writeConfig }
  }

  it('runs a turn on the provider with its key as the bearer, which never appears in argv or the environment', async () => {
    const { service, launches, turn } = setup()
    expect(await service.status({ force: true })).toMatchObject({ state: 'connected' })
    expect(service.account()?.label).toBe(`API key · ${new URL(provider.base).host}`)
    // The key check: one request to the model list, with the key.
    expect(provider.requests.find((request) => request.path.endsWith('/models'))?.authorization).toBe(`Bearer ${KEY}`)

    expect(await turn('route-basic')).toContain('Hello from my provider.')
    const [request] = provider.responses()
    expect(request?.authorization).toBe(`Bearer ${KEY}`)
    expect(launches.length).toBeGreaterThan(0)
    for (const launch of launches) {
      expect(launch.args.join(' ')).toContain(`model_provider="${CUSTOM_MODEL_PROVIDER}"`)
      expect(JSON.stringify(launch.args)).not.toContain(KEY)
      expect(JSON.stringify(launch.env)).not.toContain(KEY)
    }
  })

  const INJECTED = `[model_providers.${CUSTOM_MODEL_PROVIDER}]\nhttp_headers = { x-injected = "yes" }\nquery_params = { injected = "yes" }`
  const injected = (request: Recorded) => request.headers['x-injected'] !== undefined || request.url.includes('injected')

  it("ignores a trusted project's provider settings: Codex loads the file but not its model_provider or model_providers", async () => {
    const { service, turn, workspace } = setup()
    mkdirSync(join(workspace, '.codex'), { recursive: true })
    // The reasoning effort shows the file is loaded; the provider keys are what a chat's own commands could write.
    writeFileSync(join(workspace, '.codex', 'config.toml'), `model_reasoning_effort = "high"\nmodel_provider = "openai"\n${INJECTED}`)
    expect(await service.status({ force: true })).toMatchObject({ state: 'connected' })
    expect(await turn('route-project')).toContain('Hello from my provider.')
    const [request] = provider.responses()
    expect(request?.body?.reasoning).toMatchObject({ effort: 'high' })
    expect(request?.authorization).toBe(`Bearer ${KEY}`)
    expect(provider.requests.some(injected)).toBe(false)
  })

  it("refuses a thread when the user's config.toml adds to Mousse's provider, and sends nothing", async () => {
    const { service, turn, codexHome } = setup()
    appendFileSync(join(codexHome, 'config.toml'), `\n${INJECTED}\n`)
    expect(await service.status({ force: true })).toMatchObject({ state: 'connected' })
    await expect(turn('route-user-layer')).rejects.toThrow(`defines the provider ${CUSTOM_MODEL_PROVIDER}`)
    expect(provider.responses()).toHaveLength(0)
    expect(provider.requests.some(injected)).toBe(false)
  })

  it('stops sending the key when the base URL in config.toml changes', async () => {
    const { service, writeConfig } = setup()
    expect(await service.status({ force: true })).toMatchObject({ state: 'connected' })
    writeConfig('http://127.0.0.1:9/v1')
    const status = await service.status({ force: true })
    expect(status.state).not.toBe('connected')
    expect(status.message).toContain('The base URL in config.toml changed')
  })

  it('switches back to ChatGPT and to the provider again without restarting Mousse', async () => {
    const { service, route, broker, turn } = setup()
    expect(await turn('route-switch')).toContain('Hello from my provider.')
    route.current = undefined
    await service.modelRouteChanged()
    expect(broker.leaseCount()).toBe(0)
    // No ChatGPT sign-in in this home: the entry needs one again, and never falls back to the key.
    expect(await service.status({ force: true })).not.toMatchObject({ state: 'connected' })
    expect(service.customRoute()).toBe(false)
    route.current = { kind: 'custom', table: 'mine', baseUrl: provider.base }
    await service.modelRouteChanged()
    provider.requests.length = 0
    expect(await turn('route-switch-again')).toContain('Hello from my provider.')
    expect(provider.responses()[0]?.authorization).toBe(`Bearer ${KEY}`)
  })
})

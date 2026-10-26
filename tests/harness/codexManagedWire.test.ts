/**
 * The managed-Codex wire gate: the pinned Codex binary (`npm run codex:pin`) run by Mousse's real
 * `CodexProviderService` and `CodexAdapter` mapping, the built token helper (`npm run build:cli`)
 * and the broker, against a fake ChatGPT issuer and a fake Responses server on 127.0.0.1. Nothing
 * reaches OpenAI: the base URL is the fake's, set only here. `MOUSSE_CODEX_WIRE=skip` skips it
 * (hosted CI); otherwise a missing binary or helper fails.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { zstdDecompressSync, gunzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ChatGptAuth } from '../../src/mms/harness/chatgpt/chatgptAuth'
import { ChatGptTokenBroker } from '../../src/mms/harness/codex/broker'
import { CodexInstallation } from '../../src/mms/harness/codex/installation'
import { createManagedCodexRuntime, MANAGED_MODEL_PROVIDER } from '../../src/mms/harness/codex/managedRuntime'
import type { DriverContext, DriverRuntime } from '../../src/mms/harness/driver'
import { instanceEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { spawnCodexAppServer, type CodexLaunch } from '../../src/mms/providers/codex/CodexAppServerClient'
import { CodexTurnFailure, type CodexProviderService } from '../../src/mms/providers/codex/CodexProviderService'
import { codexHarnessError } from '../../src/mms/run/adapters/codex/CodexAdapter'
import { FakeIssuer, plainCodec } from './chatgpt/fakeIssuer'
import { signIn } from './chatgpt/signInFlow'

const root = resolve(__dirname, '..', '..')
const skip = process.env.MOUSSE_CODEX_WIRE === 'skip'
const pinHome = join(root, '.cache', 'codex-pin')
const helperScript = join(root, 'out', 'cli', 'chatgpt-token.js')

interface Recorded {
  at?: string
  path: string
  authorization?: string
  encoding?: string
  body?: Record<string, unknown>
}

type Answer = (request: Recorded, index: number) => { status: number; body?: unknown; sse?: string[]; headers?: Record<string, string> }

function sse(events: Array<Record<string, unknown>>): string[] {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
}

/** A complete streamed answer saying `text`. */
function reply(text: string, id = 'resp_1'): string[] {
  const item = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  return sse([
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 12 } } }
  ])
}

/** The fake Responses and models API. */
class FakeOpenAi {
  base = ''
  readonly requests: Recorded[] = []
  answer: Answer = () => ({ status: 200, sse: reply('Hello from the plan.') })
  private server!: Server

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      void this.read(request).then((recorded) => {
        this.requests.push(recorded)
        if (recorded.path.endsWith('/models')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ models: [{ slug: 'gpt-wire', display_name: 'GPT Wire', visibility: 'list', supported_in_api: true, priority: 1 }] }))
          return
        }
        const answer = this.answer(recorded, this.requests.filter((entry) => entry.path.endsWith('/responses')).length - 1)
        if (answer.sse) {
          response.writeHead(answer.status, { 'content-type': 'text/event-stream', ...answer.headers })
          for (const chunk of answer.sse) response.write(chunk)
          response.end()
          return
        }
        response.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers })
        response.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
      })
    })
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`
    return this
  }

  private async read(request: IncomingMessage): Promise<Recorded> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    let raw = Buffer.concat(chunks)
    const encoding = request.headers['content-encoding']
    if (encoding === 'zstd') raw = zstdDecompressSync(raw)
    else if (encoding === 'gzip') raw = gunzipSync(raw)
    let body: Record<string, unknown> | undefined
    try {
      body = raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : undefined
    } catch {
      body = undefined
    }
    return {
      at: new Date().toISOString(),
      path: new URL(request.url ?? '/', 'http://x').pathname,
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(typeof encoding === 'string' ? { encoding } : {}),
      ...(body ? { body } : {})
    }
  }

  responses(): Recorded[] {
    return this.requests.filter((entry) => entry.path.endsWith('/responses'))
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((done) => this.server.close(() => done()))
  }
}

/**
 * A proxy that refuses every request and records where it was meant to go: Codex's traffic to any
 * host other than the fakes on 127.0.0.1 ends here, so nothing reaches OpenAI.
 */
class RefusingProxy {
  readonly targets: string[] = []
  url = ''
  private server!: Server

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      this.targets.push(request.headers.host ?? request.url ?? '?')
      response.writeHead(403)
      response.end()
    })
    this.server.on('connect', (request: IncomingMessage, socket: import('node:net').Socket) => {
      this.targets.push(request.url ?? '?')
      socket.end(`HTTP/1.1 403 Forbidden${'\r\n'.repeat(2)}`)
    })
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((done) => this.server.close(() => done()))
  }
}

/** The JSON body of an upstream error, as the ChatGPT plan answers. */
function upstream(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, type: 'invalid_request_error', ...extra } }
}

describe.skipIf(skip)('managed Codex on the wire (pinned binary, fake ChatGPT)', { timeout: 120_000 }, () => {
  let issuer: FakeIssuer
  let openai: FakeOpenAi
  let proxy: RefusingProxy
  let broker: ChatGptTokenBroker
  let dirs: string[] = []
  const stops: Array<() => void> = []

  beforeAll(async () => {
    if (!new CodexInstallation({ installationHome: pinHome }).installed()) throw new Error('The pinned Codex is missing: run `npm run codex:pin`.')
    if (!existsSync(helperScript)) throw new Error('The token helper is not built: run `npm run build:cli`.')
    issuer = await new FakeIssuer().start()
    openai = await new FakeOpenAi().start()
    proxy = await new RefusingProxy().start()
  })
  afterAll(async () => {
    // Every host Codex tried besides the fakes; none of them was reached.
    if (process.env.MOUSSE_CODEX_WIRE_LOG) writeFileSync(`${process.env.MOUSSE_CODEX_WIRE_LOG}.proxy.json`, JSON.stringify(proxy?.targets ?? []))
    await proxy?.stop()
    await issuer?.stop()
    await openai?.stop()
  })
  afterEach(async () => {
    // Codex reached no host but the fakes (Mousse's config turns off what would call out).
    const outside = proxy.targets.splice(0)
    if (outside.length) throw new Error(`Codex tried to reach ${[...new Set(outside)].join(', ')}`)
    if (process.env.MOUSSE_CODEX_WIRE_LOG) writeFileSync(`${process.env.MOUSSE_CODEX_WIRE_LOG}.requests.json`, JSON.stringify(openai.requests, null, 2))
    for (const stop of stops.splice(0)) stop()
    await broker?.close()
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      } catch {
        // A Codex child on Windows may still hold a file; the run folder under .cache is left.
      }
    }
    openai.requests.length = 0
    openai.answer = () => ({ status: 200, sse: reply('Hello from the plan.') })
    issuer.onToken = undefined
  })

  /** A signed-in managed entry whose Codex runs with `extraArgs` after Mousse's own. */
  async function setup(options: { extraArgs?: string[]; shortTokens?: boolean } = {}) {
    // Codex refuses its helper aliases under the system temp folder; the runs live beside the pin.
    mkdirSync(join(root, '.cache', 'wire-runs'), { recursive: true })
    const dir = mkdtempSync(join(root, '.cache', 'wire-runs', 'run-'))
    dirs.push(dir)
    const profileHome = join(dir, 'profile')
    const userHome = join(dir, 'user')
    mkdirSync(userHome, { recursive: true })
    const instanceId = 'codex:wire'
    const stateDir = join(profileHome, 'harness', 'codex-wire')
    // The user's real home is never visible to this Codex.
    const outside = { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, ALL_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost' }
    const base: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/_proxy$/i.test(key))),
      ...outside,
      ...Object.fromEntries(Object.entries(outside).map(([key, value]) => [key.toLowerCase(), value])),
      HOME: userHome,
      USERPROFILE: userHome,
      CODEX_HOME: join(userHome, '.codex')
    }
    const env = instanceEnv({ instanceId, driver: 'codex', configRevision: 0, home: join(stateDir, 'home'), searchPath: [], base })
    const questions = new UserQuestionService()
    const context: DriverContext = {
      instanceId, builtIn: false, config: { home: 'private', setup: 'managed' }, env, profileHome,
      installationHome: pinHome, stateDir, questions, findBinary: () => undefined, changed: () => {}
    }
    if (options.shortTokens) {
      // Every token lives under the refresh margin, so every helper call renews it.
      issuer.onToken = async (form) => {
        const answer = await issuer.defaultToken(form)
        if (answer.status === 200 && answer.body && typeof answer.body === 'object') (answer.body as Record<string, unknown>).expires_in = 60
        return answer
      }
    }
    broker = new ChatGptTokenBroker()
    const launches: CodexLaunch[] = []
    let auth!: ChatGptAuth
    const runtime = createManagedCodexRuntime(context, {
      installation: new CodexInstallation({ installationHome: pinHome }),
      broker,
      auth: (authOptions) => (auth = new ChatGptAuth({ ...authOptions, endpoints: issuer.endpoints, codec: plainCodec })),
      baseUrl: openai.base,
      helper: (endpoint, leaseId) => ({ command: process.execPath, args: [helperScript, endpoint, leaseId], env: {} }),
      service: {
        launch: (launch) => {
          const spec = { ...launch, args: [...launch.args, ...(options.extraArgs ?? [])] }
          launches.push(spec)
          const child = spawnCodexAppServer(spec)
          if (process.env.MOUSSE_CODEX_WIRE_LOG) child.stderr?.on('data', (chunk: Buffer) => appendFileSync(process.env.MOUSSE_CODEX_WIRE_LOG!, chunk))
          return child
        },
        requestTimeoutMs: 60_000
      }
    })
    stops.push(() => {
      runtime.stop()
      questions.shutdown()
    })
    const service = (runtime.adapter as unknown as { service: () => CodexProviderService }).service()
    await signIn(issuer, auth, { subject: 'wire-user', email: 'wire@example.com' }, { method: 'chatgpt-new-account' })
    const workspace = join(dir, 'work')
    mkdirSync(workspace, { recursive: true })
    const turn = (threadId: string, prompt: string, options: { model?: string; history?: string } = {}) => {
      const text: string[] = []
      return service
        .chat({ threadId, instanceId, cwd: workspace, model: options.model ?? 'gpt-wire', prompt, mcp: null, ...(options.history ? { history: options.history } : {}), onText: (delta) => text.push(delta) })
        .then((result) => ({ result, text: text.join('') }))
    }
    return { runtime, service, auth, launches, turn, instanceId }
  }

  /** What a failed turn carries, and the harness error a managed entry maps it to. */
  async function failure(run: Promise<unknown>, instanceId: string) {
    const error = await run.then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(CodexTurnFailure)
    const turn = error as CodexTurnFailure
    const mapped = codexHarnessError(turn, instanceId) as { code?: string; message?: string }
    // The fakes' port and the local Node path change from run to run.
    const message = turn.message.split(openai.base).join('<base>').split(process.execPath).join('<node>')
    return { message, codexErrorInfo: turn.codexErrorInfo ?? null, additionalDetails: turn.additionalDetails, httpStatus: turn.httpStatus ?? null, mapped: mapped.code ?? null }
  }

  it('a turn carries the helper\'s bearer and none of the fields ChatGPT plan use omits', async () => {
    const { turn, launches } = await setup()
    const { result, text } = await turn('wire-basic', 'Say hello.')
    expect(text).toContain('Hello from the plan.')
    expect(launches[0]!.args.join(' ')).toContain(`model_provider="${MANAGED_MODEL_PROVIDER}"`)
    const [request] = openai.responses()
    expect(request?.authorization).toMatch(/^Bearer at-\d+$/)
    const body = request!.body!
    expect(body).toMatchObject({ model: 'gpt-wire', store: false, stream: true })
    for (const omitted of ['prompt_cache_retention', 'max_output_tokens', 'service_tier', 'previous_response_id', 'background', 'metadata'])
      expect(body, omitted).not.toHaveProperty(omitted)
    const tools = (body.tools as Array<{ type?: string; name?: string }> | undefined) ?? []
    expect(tools.some((tool) => tool.type === 'tool_search' || tool.name === 'tool_search')).toBe(false)
    const input = body.input as Array<{ role?: string }>
    expect(input.some((item) => item.role === 'system')).toBe(false)
    expect({ keys: Object.keys(body).sort(), toolTypes: [...new Set(tools.map((tool) => tool.type))].sort(), encoding: request!.encoding ?? null, model: result.model }).toMatchSnapshot()
  })

  it('a thread restarts on a new process and resumes on the plan provider', async () => {
    const { turn, service } = await setup()
    const first = await turn('wire-resume', 'Remember the word lantern.')
    // The turn is committed with the history it leaves, as the run engine does.
    const history = `user: Remember the word lantern.\nassistant: ${first.text}`
    service.commitConversation('wire-resume', history)
    await service.stopAll('test restart')
    openai.answer = () => ({ status: 200, sse: reply('You said lantern.', 'resp_2') })
    const second = await turn('wire-resume', 'Which word?', { history })
    expect(second.result.codexThreadId).toBe(first.result.codexThreadId)
    const resumed = JSON.stringify(openai.responses().at(-1)!.body!.input)
    expect(resumed).toContain('lantern')
  })

  it('a 401 runs the helper again, the broker renews the token, and the retry carries the new one', async () => {
    const { turn } = await setup({ shortTokens: true })
    const refused = new Set<string>()
    openai.answer = (request, index) => {
      if (index === 0) {
        refused.add(request.authorization ?? '')
        return { status: 401, body: upstream('token_expired', 'The access token expired.') }
      }
      return { status: 200, sse: reply('Renewed.') }
    }
    const { text } = await turn('wire-renew', 'Hi.')
    expect(text).toContain('Renewed.')
    const bearers = openai.responses().map((request) => request.authorization)
    expect(bearers.length).toBeGreaterThanOrEqual(2)
    expect(refused.has(bearers.at(-1)!)).toBe(false)
    expect(issuer.tokenRequests.some((form) => form.grant_type === 'refresh_token')).toBe(true)
  })

  it('records what Codex reports for each upstream failure', async () => {
    const { turn, instanceId } = await setup()
    const cases: Record<string, Answer> = {
      invalid_user_401: () => ({ status: 401, body: upstream('subscription_sharing_invalid_user', 'This ChatGPT account cannot be used here.') }),
      not_eligible_403: () => ({ status: 403, body: upstream('subscription_sharing_not_eligible', 'This plan cannot use ChatGPT sign-in for this app.') }),
      unsupported_capability_403: () => ({ status: 403, body: upstream('subscription_sharing_unsupported_capability', 'This capability is not supported.', { param: 'tools[0].type' }) }),
      usage_limit_429: () => ({ status: 429, body: { error: { type: 'usage_limit_reached', code: 'usage_limit_reached', message: 'You have reached your usage limit.', plan_type: 'plus', resets_in_seconds: 3600 } } }),
      unavailable_503: () => ({ status: 503, body: upstream('server_overloaded', 'The service is overloaded.') }),
      failed_after_deltas: () => ({
        status: 200,
        sse: [
          ...sse([
            { type: 'response.created', response: { id: 'resp_f' } },
            { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_f', role: 'assistant', status: 'in_progress', content: [] } },
            { type: 'response.output_text.delta', item_id: 'msg_f', output_index: 0, content_index: 0, delta: 'Partial ' }
          ]),
          ...sse([{ type: 'response.failed', response: { id: 'resp_f', error: { code: 'subscription_sharing_route_not_supported', message: 'This route is not supported.' } } }])
        ]
      })
    }
    const recorded: Record<string, unknown> = {}
    for (const [name, answer] of Object.entries(cases)) {
      openai.answer = answer
      recorded[name] = await failure(turn(`wire-${name}`, 'Hi.'), instanceId)
    }
    expect(recorded).toMatchSnapshot()
  }, 180_000)

  it('a helper that cannot get a token fails the turn', async () => {
    const { turn, instanceId, runtime } = await setup()
    await turn('wire-helper', 'Hi.')
    // Every lease of the entry is dropped while its process runs: the next token request fails.
    broker.revokeInstance(instanceId)
    // As the real API: a request without a bearer is refused.
    openai.answer = (request) => (request.authorization ? { status: 200, sse: reply('Never.') } : { status: 401, body: upstream('missing_authorization', 'No bearer.') })
    const result = await failure(turn('wire-helper', 'Again.'), instanceId)
    expect(result).toMatchSnapshot()
    expect(runtime).toBeDefined()
  }, 120_000)

  it('model discovery: a turn on an explicit model, with and without the catalog URL and api_key_model_discovery', async () => {
    const observed: Record<string, unknown> = {}
    for (const [name, extraArgs] of Object.entries({
      plain: [],
      catalog: ['-c', `model_providers.${MANAGED_MODEL_PROVIDER}.model_catalog_url="${openai.base}/models"`],
      discovery: ['-c', 'features.api_key_model_discovery=true']
    })) {
      const { turn } = await setup({ extraArgs })
      const { text } = await turn(`wire-models-${name}`, 'Hi.')
      const models = openai.requests.filter((request) => request.path.endsWith('/models'))
      observed[name] = { answered: text.includes('Hello'), modelRequests: models.length, modelBearer: models.map((request) => /^Bearer at-\d+$/.test(request.authorization ?? '')) }
      for (const stop of stops.splice(0)) stop()
      await broker.close()
      openai.requests.length = 0
    }
    expect(observed).toMatchSnapshot()
  }, 180_000)
})

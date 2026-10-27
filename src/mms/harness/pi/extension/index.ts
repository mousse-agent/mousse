import { request as httpRequest } from 'node:http'
import type { Api, ImageContent, Model, Provider, ProviderStreams, TextContent } from '@earendil-works/pi-ai'
import {
  anthropicMessagesApi,
  azureOpenAIResponsesApi,
  bedrockConverseStreamApi,
  createProvider,
  getApiProviders,
  googleGenerativeAIApi,
  googleVertexApi,
  mistralConversationsApi,
  openAICodexResponsesApi,
  openAICompletionsApi,
  openAIResponsesApi,
  piMessagesApi,
  registerApiProvider,
  registerBuiltInApiProviders
} from '@earendil-works/pi-ai/compat'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { createBashToolDefinition, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { guardProvider, guardStreams, isGuarded, type GuardObserver, type RequestGate } from './guard'
import { BUDGET_EXHAUSTED, GATE_REFUSALS, GATE_UNAVAILABLE, REQUEST_REFUSED } from './messages'
import { capHonouring, inputBound, sizedMaxTokens, wirePlan, type PiReasoning, type ThinkingBudgets } from '../reservation'
import { containedBashOperations } from './shell'

/** The input key the app-tool registry reads a `per_call` runtime's turn token from (`registry.ts`). */
const TURN_TOKEN_KEY = '_mousse_turn'
import {
  PI_BRIDGE_ENV,
  type PiBridgeAddress,
  type PiCatalogResponse,
  type PiFatalRequest,
  type PiGateRequest,
  type PiGateResponse,
  type PiQuiesceResponse,
  type PiReadyRequest,
  type PiRequestRequest,
  type PiRequestResponse,
  type PiSettleRequest,
  type PiSpendRequest,
  type PiTurnResponse,
  type PiTurnTool
} from './protocol'

/**
 * Mousse's extension for Pi's agent: the only extension a Mousse-started Pi loads (`-e`), besides
 * Pi's hidden built-in llama.cpp one. It is bundled on its own into
 * `out/pi-runtime/mousse-extension.mjs` and imports only Node built-ins and the modules Pi provides
 * to extensions, which resolve to the runtime's own copies.
 *
 * - **Providers (PR 2 §4).** The factory registers every pi-ai built-in provider and the instance's
 *   provider (with Mousse's catalogue and key) in the native form, each with its stream functions
 *   guarded (`guard.ts`), and wraps the global api registry too. At every `session_start` it
 *   guards whatever else is registered (Pi's llama.cpp provider), then reports the guarded set to
 *   `/pi/ready`. A registration that fails after bind is reported to `/pi/fatal` and rethrown.
 * - **Turns.** `before_agent_start` fetches the turn from `/pi/turn`: Mousse's tools (registered
 *   per turn, delegation tools sequential), the active built-ins, the session instructions.
 * - **Gate.** Every `tool_call` is allowed only by `/pi/gate` for the turn's attempt token; an
 *   unreachable gate blocks.
 * - **Requests (PR 4 §5a).** Every model request the guard admits, compactions, summaries and Pi's
 *   own retries included, is charged first through `/pi/request`; a refusal or an unreachable
 *   endpoint ends it with a fixed text Pi does not retry, before any network I/O. When the turn
 *   has token or USD limits (PR 4 §5b), the charge carries the request's input bound and final
 *   wire cap (`reservation.ts`), and the grant sizes it (`guard.ts`); `/pi/settle` ends it.
 */

/**
 * A command that does nothing: `get_commands` lists it with this file as its source, which is how
 * the runtime check and tests see that Pi loaded the extension (a failed load is only a startup
 * warning, and Pi answers without it).
 */
export const MOUSSE_EXTENSION_MARKER = 'mousse-extension'

/** Set by test builds only (esbuild `define`); production builds drop the code it guards. */
declare const __MOUSSE_PI_TEST__: boolean | undefined

/** The stock implementations of every API pi-ai ships, for a Mousse custom provider. */
function stockApis(): Record<string, ProviderStreams> {
  return {
    'anthropic-messages': anthropicMessagesApi(),
    'azure-openai-responses': azureOpenAIResponsesApi(),
    'bedrock-converse-stream': bedrockConverseStreamApi(),
    'google-generative-ai': googleGenerativeAIApi(),
    'google-vertex': googleVertexApi(),
    'mistral-conversations': mistralConversationsApi(),
    'openai-codex-responses': openAICodexResponsesApi(),
    'openai-completions': openAICompletionsApi(),
    'openai-responses': openAIResponsesApi(),
    'pi-messages': piMessagesApi()
  }
}

/** Reads the bridge address and removes it from the environment, so nothing Pi starts inherits it. */
function takeBridge(): PiBridgeAddress {
  const raw = process.env[PI_BRIDGE_ENV]
  delete process.env[PI_BRIDGE_ENV]
  if (!raw) throw new Error(`${PI_BRIDGE_ENV} is not set; Mousse's extension runs only under Mousse`)
  const parsed = JSON.parse(raw) as Partial<PiBridgeAddress>
  if (typeof parsed.url !== 'string' || typeof parsed.token !== 'string') throw new Error(`${PI_BRIDGE_ENV} is malformed`)
  return { url: parsed.url, token: parsed.token }
}

/**
 * POSTs JSON to a local address with `node:http`, never `fetch`: Pi installs a global dispatcher
 * that follows the user's proxy settings, and the bridge is on loopback.
 */
function postJson<T>(url: string, token: string, body: unknown, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const payload = JSON.stringify(body ?? {})
    const req = httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${token}`, ...headers },
      ...(signal ? { signal } : {})
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!res.statusCode || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`))
        try {
          resolve((text ? JSON.parse(text) : {}) as T)
        } catch (error) {
          reject(error)
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/** The instance's provider: the stock one with Mousse's catalogue and key, or a custom one on the stock APIs. */
function instanceProvider(catalog: PiCatalogResponse, builtins: Map<string, Provider>): Provider {
  const spec = catalog.provider
  const models = spec.models.map((model) => ({ ...model, provider: spec.id }))
  const stock = spec.builtin ? builtins.get(spec.id) : undefined
  const key = catalog.apiKey
  if (!stock) {
    return createProvider({
      id: spec.id,
      ...(spec.name ? { name: spec.name } : {}),
      ...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}),
      ...(spec.headers ? { headers: spec.headers } : {}),
      auth: { apiKey: { name: `${spec.name ?? spec.id} API key`, resolve: async () => ({ auth: { apiKey: key ?? '' }, source: 'Mousse' }) } },
      models,
      api: stockApis()
    })
  }
  const stockModels = stock.getModels()
  const merged = [...models, ...stockModels.filter((model) => !models.some((entry) => entry.id === model.id))]
  const auth = key && stock.auth.apiKey
    ? { ...stock.auth, apiKey: Object.assign(Object.create(Object.getPrototypeOf(stock.auth.apiKey) as object) as NonNullable<Provider['auth']['apiKey']>, stock.auth.apiKey, {
        resolve: async (input: Parameters<NonNullable<Provider['auth']['apiKey']>['resolve']>[0]) => {
          const resolved = await stock.auth.apiKey!.resolve(input).catch(() => undefined)
          return { ...(resolved ?? {}), auth: { ...(resolved?.auth ?? {}), apiKey: key }, source: 'Mousse' }
        },
        check: async () => ({ type: 'api_key' as const, source: 'Mousse' })
      }) }
    : stock.auth
  return Object.assign(Object.create(Object.getPrototypeOf(stock) as object) as Provider, stock, {
    auth,
    getModels: () => merged as readonly Model<Api>[],
    // The catalogue is Mousse's: Pi runs offline and never refreshes it.
    refreshModels: undefined
  })
}

/** A tool result for Pi from an MCP `tools/call` result. */
function toolContent(result: { content?: Array<Record<string, unknown>> }): (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = []
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text })
    else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string')
      content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
  }
  return content.length ? content : [{ type: 'text', text: '(empty tool result)' }]
}

export default async function mousseExtension(pi: ExtensionAPI): Promise<void> {
  const bridge = takeBridge()
  const call = <T>(name: string, body: unknown, signal?: AbortSignal): Promise<T> => postJson<T>(`${bridge.url}/pi/${name}`, bridge.token, body, signal)

  // Test builds record each request the guard let through, beside the recorder's own count, and can
  // force a provider registration to fail (`factory`, or `revision` on a new catalogue revision).
  let observer: GuardObserver | undefined
  let failRegistration: string | undefined
  if (typeof __MOUSSE_PI_TEST__ !== 'undefined' && __MOUSSE_PI_TEST__) {
    const { appendFileSync } = await import('node:fs')
    const log = process.env.MOUSSE_PI_TEST_GUARD_LOG
    failRegistration = process.env.MOUSSE_PI_TEST_FAIL_REGISTRATION
    delete process.env.MOUSSE_PI_TEST_GUARD_LOG
    delete process.env.MOUSSE_PI_TEST_FAIL_REGISTRATION
    if (log) observer = { admitted: (model) => appendFileSync(log, `${JSON.stringify({ provider: model.provider, id: model.id, api: model.api })}\n`) }
    // The final hook parameters of each reserved request, as `onPayload` saw them after Mousse's check.
    const payloads = process.env.MOUSSE_PI_TEST_PAYLOAD_LOG
    delete process.env.MOUSSE_PI_TEST_PAYLOAD_LOG
    if (payloads) observer = { ...observer, payload: (model, params, grant) => appendFileSync(payloads, `${JSON.stringify({ api: model.api, id: model.id, cap: grant.cap, params })}\n`) }
  }

  // Linux and macOS: every shell runs in a process group the engine recorded first (`shell.ts`).
  if (process.platform !== 'win32')
    pi.registerTool(createBashToolDefinition(process.cwd(), { operations: containedBashOperations({ report: (pgid, signal) => call('group', { pgid }, signal), ended: (pgid) => call('group', { pgid, ended: true }) }) }) as never)

  pi.registerCommand(MOUSSE_EXTENSION_MARKER, { description: "Mousse's extension is loaded (does nothing)", handler: async () => {} })

  // The turn fetched last (`before_agent_start`); its token goes with each request charge.
  let turn: PiTurnResponse | undefined
  // Mousse charges every request to the live turn before it goes, or refuses it. The text thrown
  // is always one of the fixed ones, never the transport's (Pi would retry "fetch failed").
  // A reserved turn's request carries what it would spend; only `streamSimple` (every request Pi's
  // agent, compactions and summaries make) can be sized, so anything else is refused there.
  const gate: RequestGate = {
    request: async (model, context, options, fn) => {
      let spend: PiSpendRequest | undefined
      let thinkingBudget = 0
      if (turn?.reserve) {
        if (fn !== 'streamSimple') throw new Error(REQUEST_REFUSED)
        const typed = context as Parameters<typeof wirePlan>[1]
        const plan = wirePlan(model, typed, typeof options.maxTokens === 'number' ? options.maxTokens : undefined, options.reasoning as PiReasoning | undefined, options.thinkingBudgets as ThinkingBudgets | undefined)
        thinkingBudget = plan.thinkingBudget
        const cost = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        spend = {
          inputBound: inputBound(typed, model.api) ?? null,
          wireCap: plan.wireCap ?? null,
          thinkingBudget,
          model: { provider: model.provider, id: model.id, api: model.api, capHonouring: capHonouring(model), cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite } }
        }
      }
      const body: PiRequestRequest = { attemptToken: turn?.attemptToken ?? '', kind: 'request', ...(spend ? { spend } : {}) }
      let answer: PiRequestResponse
      try {
        answer = await call<PiRequestResponse>('request', body)
      } catch {
        throw new Error(GATE_UNAVAILABLE)
      }
      if (answer?.ok === true) {
        if (!spend) return undefined
        const reservation = answer.reservation
        if (!reservation || typeof reservation.cap !== 'number') throw new Error(REQUEST_REFUSED)
        return { id: reservation.id, cap: reservation.cap, maxTokens: sizedMaxTokens(reservation.cap, { thinkingBudget }) }
      }
      throw new Error(answer?.ok === false && answer.reason === BUDGET_EXHAUSTED ? BUDGET_EXHAUSTED : REQUEST_REFUSED)
    },
    settle: async (grant, outcome) => {
      const body: PiSettleRequest = { reservationId: grant.id, outcome }
      await call('settle', body).catch(() => undefined)
    }
  }

  // The global api registry, for any composition that falls through to it (and Pi's llama.cpp
  // provider, which streams through it).
  registerBuiltInApiProviders()
  for (const entry of getApiProviders()) registerApiProvider(guardStreams({ api: entry.api, stream: entry.stream, streamSimple: entry.streamSimple }, undefined, observer, gate) as never)

  let catalog = await call<PiCatalogResponse>('catalog', {})
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]))
  // Every built-in, guarded; the instance's provider with Mousse's catalogue and key. Queued now and
  // flushed before the session's options resolve, so `--model` finds Mousse's model.
  for (const provider of builtins.values()) if (provider.id !== catalog.provider.id) pi.registerProvider(guardProvider(provider, observer, gate))
  pi.registerProvider(guardProvider(instanceProvider(catalog, builtins), observer, gate))
  /** An invalid registration (an empty id), for the failure tests only. */
  const broken = (provider: Provider): Provider => Object.assign(Object.create(provider) as Provider, { id: '' })
  if (failRegistration === 'factory') pi.registerProvider(broken(guardProvider(instanceProvider(catalog, builtins), observer, gate)))
  const key = catalog.apiKey

  const fatal = async (body: PiFatalRequest): Promise<void> => {
    await call('fatal', body).catch(() => undefined)
  }
  /** A registration after bind: applied at once; a failure is fatal to the process. */
  const registerNow = async (provider: Provider): Promise<void> => {
    try {
      pi.registerProvider(provider)
    } catch (error) {
      await fatal({ reason: 'register_provider', message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  pi.on('session_start', async (event, ctx: ExtensionContext) => {
    // Whatever another extension registered (Pi's llama.cpp provider) is guarded too.
    const registry = ctx.modelRegistry
    const ids = new Set<string>([...builtins.keys(), ...registry.getRegisteredProviderIds(), ...registry.getAll().map((model) => model.provider)])
    for (const id of ids) {
      if (isGuarded(registry.getRegisteredNativeProvider(id))) continue
      const current = registry.getProvider(id)
      if (current) await registerNow(guardProvider(current, observer, gate))
    }
    const guarded = [...ids].filter((id) => isGuarded(registry.getRegisteredNativeProvider(id)))
    const ready: PiReadyRequest = {
      guarded,
      aws: { maxAttempts: process.env.AWS_MAX_ATTEMPTS ?? null, retryMode: process.env.AWS_RETRY_MODE ?? null },
      reason: (event as { reason?: string }).reason ?? 'startup'
    }
    await call('ready', ready)
  })

  // The turn's tools, registered when new or changed.
  const registered = new Map<string, string>()
  const registerTool = (tool: PiTurnTool): void => {
    const signature = JSON.stringify([tool.description, tool.parameters, tool.class])
    if (registered.get(tool.name) === signature) return
    registered.set(tool.name, signature)
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters as never,
      // A batch with a delegation runs one tool at a time, in order (the writer barrier's first layer).
      ...(tool.class === 'delegation' ? { executionMode: 'sequential' as const } : {}),
      execute: async (toolCallId, params, signal) => {
        const current = turn
        if (!current?.mcp) throw new Error(`${tool.name} is not available in this turn`)
        if (tool.class === 'delegation') {
          const quiet = await call<PiQuiesceResponse>('quiesce', { attemptToken: current.attemptToken, toolCallId }, signal)
          if (!quiet.ok) throw new Error(quiet.reason)
        }
        const response = await postJson<{ result?: { content?: Array<Record<string, unknown>>; isError?: boolean }; error?: { message?: string } }>(
          current.mcp.url,
          current.mcp.token,
          { jsonrpc: '2.0', id: toolCallId, method: 'tools/call', params: { name: tool.name, arguments: { ...(params as Record<string, unknown>), clientRequestId: toolCallId, [TURN_TOKEN_KEY]: current.attemptToken } } },
          signal,
          { accept: 'application/json, text/event-stream' }
        )
        if (response.error) throw new Error(response.error.message ?? `${tool.name} failed`)
        const content = toolContent(response.result ?? {})
        if (response.result?.isError) throw new Error(content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'))
        return { content, details: undefined }
      }
    })
  }

  pi.on('before_agent_start', async (event) => {
    turn = await call<PiTurnResponse>('turn', {})
    if (turn.catalogRevision !== catalog.catalogRevision) {
      // A new catalogue: the instance's provider is registered again in full, never one model.
      const next = await call<PiCatalogResponse>('catalog', {})
      catalog = { ...next, apiKey: next.apiKey ?? key }
      const provider = guardProvider(instanceProvider(catalog, builtins), observer, gate)
      await registerNow(failRegistration === 'revision' ? broken(provider) : provider)
    }
    for (const tool of turn.tools) registerTool(tool)
    pi.setActiveTools([...turn.activeBuiltins, ...turn.tools.map((tool) => tool.name)])
    return turn.sessionInstructions ? { systemPrompt: `${event.systemPrompt}\n\n${turn.sessionInstructions}` } : undefined
  })

  // Default deny: only what the gate allows for this attempt runs.
  pi.on('tool_call', async (event) => {
    const current = turn
    if (!current) return { block: true, reason: GATE_REFUSALS.denied }
    const body: PiGateRequest = { attemptToken: current.attemptToken, toolCallId: event.toolCallId, toolName: event.toolName, input: event.input as Record<string, unknown> }
    try {
      const decision = await call<PiGateResponse>('gate', body)
      if (decision.allow !== true) return { block: true, reason: decision.reason || GATE_REFUSALS.denied }
      // The arguments the gate checked are the ones the tool runs with.
      if (decision.input) Object.assign(event.input as Record<string, unknown>, decision.input)
      return undefined
    } catch {
      return { block: true, reason: GATE_REFUSALS.unreachable }
    }
  })

  // A second layer only: the request wrapper is what refuses.
  pi.on('before_provider_headers', (event) => {
    for (const [name, value] of Object.entries(event.headers)) {
      if (typeof value !== 'string') continue
      if (value.includes('sk-ant-oat') || value.includes('sk-ant-ort') || value.toLowerCase().includes('oauth-2025-04-20')) event.headers[name] = null
    }
  })
}

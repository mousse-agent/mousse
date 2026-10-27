import { createAssistantMessageEventStream, lazyStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model, type Provider, type ProviderStreams } from '@earendil-works/pi-ai'
import { hookCandidates, hookCap } from '../reservation'
import { ANTHROPIC_OAUTH_REFUSED, LOGIN_REFUSED, SPEND_CAP_MISMATCH } from './messages'

/**
 * The fail-closed Anthropic guard of Mousse's Pi extension (PR 2 §4 "Anthropic guard").
 *
 * Every provider the extension registers is wrapped here, so every request Pi sends passes this
 * check after `prepareRequest` (`ModelRuntime`: final key, headers after `before_provider_headers`,
 * the auth's `baseUrl`) and before the stock stream function, whatever API the provider dispatches
 * the model to. A refused request becomes an error stream with a fixed text Pi does not retry.
 *
 * The wrapper also forces `options.maxRetries = 0`: SDK retries run inside the stream function,
 * below this check, so one check would otherwise cover several HTTP requests. (Bedrock's AWS SDK
 * ignores it; the launcher pins `AWS_MAX_ATTEMPTS=1` for it.) Pi's own retry re-enters the wrapper.
 *
 * With a request gate (PR 4 §5a, the extension's `/pi/request`), every request the guard admits is
 * then charged to the live turn before any network I/O; a refusal, or a gate that cannot be asked,
 * ends the stream with a fixed text Pi does not retry, and nothing is sent. When the turn reserves
 * spend (PR 4 §5b), the gate's grant sets the request's `maxTokens` so its wire cap equals the
 * reservation, Mousse's own `onPayload` (after any other) refuses a final payload whose cap is
 * missing or above it, and the reservation is settled before the request's last event is passed on.
 */

/** Subscription tokens of Claude.ai accounts (access and refresh). */
const OAUTH_TOKEN_MARKERS = ['sk-ant-oat', 'sk-ant-ort']
/** The beta header value Anthropic's OAuth access needs. */
const OAUTH_BETA = 'oauth-2025-04-20'
/** Anthropic's hosts: only an API key on the Messages API may reach them. */
const ANTHROPIC_DOMAINS = ['anthropic.com', 'claude.ai']
/** Where `anthropic-messages` goes when a model names no address. */
const ANTHROPIC_DEFAULT_HOST = 'api.anthropic.com'

/** What one request carries, as the wrapper sees it. */
export interface GuardedRequest {
  api: string
  baseUrl?: string
  apiKey?: unknown
  headers?: Record<string, unknown>
  env?: Record<string, unknown>
  /**
   * Addresses an SDK takes from its environment when the model names none (`OPENAI_BASE_URL`,
   * `ANTHROPIC_BASE_URL`): each one is held to the same host rule.
   */
  sdkBaseUrls?: string[]
}

/** SDK variables that point a request elsewhere when the model has no address. */
const SDK_BASE_URL_VARIABLES = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'AZURE_OPENAI_BASE_URL']

function strings(values: Iterable<unknown>): string[] {
  return [...values].filter((value): value is string => typeof value === 'string')
}

/** The request's host; `null` when its address cannot be read (refused: fail closed). */
function hostOf(request: GuardedRequest): string | null | undefined {
  const raw = request.baseUrl?.trim()
  if (!raw) return request.api === 'anthropic-messages' ? ANTHROPIC_DEFAULT_HOST : undefined
  for (const candidate of [raw, `http://${raw}`]) {
    try {
      const url = new URL(candidate)
      if (url.hostname) return url.hostname.toLowerCase().replace(/\.$/, '')
    } catch {
      // Try the next reading.
    }
  }
  return null
}

function isAnthropicHost(host: string): boolean {
  return ANTHROPIC_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

/**
 * Whether a request must be refused: an Anthropic subscription token in any key, header or
 * provider env value; the OAuth beta in any header; or an Anthropic host reached by anything but
 * `anthropic-messages` with an `sk-ant-api` key and no `Authorization` header.
 */
export function refusesAnthropicRequest(request: GuardedRequest): boolean {
  const headers = Object.entries(request.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  const values = [...strings([request.apiKey]), ...headers.map(([, value]) => value), ...strings(Object.values(request.env ?? {}))]
  if (values.some((value) => OAUTH_TOKEN_MARKERS.some((marker) => value.includes(marker)))) return true
  if (headers.some(([, value]) => value.toLowerCase().includes(OAUTH_BETA))) return true
  const hosts = [hostOf(request), ...(request.baseUrl?.trim() ? [] : (request.sdkBaseUrls ?? []).map((baseUrl) => hostOf({ api: '', baseUrl })))]
  if (hosts.includes(null)) return true
  if (hosts.some((host) => host && isAnthropicHost(host))) {
    const authorization = headers.some(([name]) => name.toLowerCase() === 'authorization')
    const apiKey = typeof request.apiKey === 'string' && request.apiKey.startsWith('sk-ant-api')
    if (request.api !== 'anthropic-messages' || !apiKey || authorization) return true
  }
  return false
}

/** The SDK base-URL variables set in the provider env or this process's environment. */
function sdkBaseUrls(env: Record<string, unknown> | undefined): string[] {
  const values: string[] = []
  for (const name of SDK_BASE_URL_VARIABLES)
    for (const value of [env?.[name], typeof process === 'undefined' ? undefined : process.env[name]])
      if (typeof value === 'string' && value.trim()) values.push(value)
  return values
}

/** Test seam: told of every request the guard let through (only in test builds of the extension). */
export interface GuardObserver {
  admitted?(model: Model<Api>): void
  /** A reserved request's final hook parameters, after Mousse's cap check passed. */
  payload?(model: Model<Api>, params: unknown, grant: RequestGrant): void
}

/** A reserved request: it must reach the wire with `cap`, which `maxTokens` produces. */
export interface RequestGrant {
  id: string
  cap: number
  maxTokens: number
  /** The thinking budget pi-ai adds to the cap at the request's effort (0 when none). */
  thinkingBudget: number
}

/** How a reserved request ended (`/pi/settle`). */
export type RequestOutcome = { kind: 'released' } | { kind: 'used'; input: number; output: number; usd: number; partial?: boolean }

/**
 * Asked before every admitted request (`/pi/request`): resolves when Mousse lets it go (with a grant
 * when the turn reserves spend), throws one of the fixed request-path texts otherwise. It runs
 * before the stock stream function, so before any network I/O.
 */
export interface RequestGate {
  request(model: Model<Api>, context: unknown, options: Record<string, unknown>, fn: 'stream' | 'streamSimple' | 'fetchDeferred'): Promise<RequestGrant | undefined>
  /** Ends a reservation; never throws (an unsettled reservation stays charged). */
  settle(grant: RequestGrant, outcome: RequestOutcome): Promise<void>
}

/**
 * Marks options a gate already charged: a provider that dispatches through the (also guarded)
 * global api registry reaches a second wrapper with them, which checks again but does not charge
 * the same request twice.
 */
const CHARGED = Symbol.for('mousse.pi.requestCharged')

const GUARDED = new WeakSet<object>()

/** Whether `provider` is a guarded registration (made by `guardProvider`). */
export function isGuarded(provider: unknown): boolean {
  return typeof provider === 'object' && provider !== null && GUARDED.has(provider)
}

type PayloadHook = (params: unknown, model: Model<Api>) => unknown
type ResponseHook = (response: { status: number; headers: Record<string, string> }, model: Model<Api>) => unknown
type FetchFunction = (input: unknown, init?: unknown) => Promise<{ status: number }>
type RequestOptions = { apiKey?: unknown; headers?: Record<string, unknown>; env?: Record<string, unknown>; maxRetries?: number; maxTokens?: number; onPayload?: PayloadHook; onResponse?: ResponseHook; fetch?: FetchFunction; [CHARGED]?: true }

/**
 * APIs whose SDK client takes `options.fetch`, so the response status is seen for every answer.
 * Bedrock reports error statuses through `onResponse`; Google reports none, so a failed Google
 * request keeps its reservation.
 */
const FETCH_APIS = new Set(['anthropic-messages', 'openai-completions', 'openai-responses'])

/** Checks one request; returns the options it may go out with (`maxRetries: 0`), or null when refused. */
function admit(model: Model<Api>, providerHeaders: Record<string, unknown> | undefined, options: RequestOptions | undefined): RequestOptions | null {
  const request: GuardedRequest = {
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey: options?.apiKey,
    headers: { ...(providerHeaders ?? {}), ...(model.headers ?? {}), ...(options?.headers ?? {}) },
    env: options?.env,
    sdkBaseUrls: sdkBaseUrls(options?.env)
  }
  if (refusesAnthropicRequest(request)) return null
  return { ...(options ?? {}), maxRetries: 0 }
}

function refused(model: Model<Api>): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    throw new Error(ANTHROPIC_OAUTH_REFUSED)
  })
}

/**
 * How a reserved request ended; never less than it may have been billed.
 * - Nothing sent (the payload check refused it, or setup failed): released.
 * - The provider answered with an error status (a non-2xx response was seen): released.
 * - A complete reply with its usage: that usage.
 * - Anything else (a failure, a stop, a dropped stream, a reply without usage): its usage, but at
 *   least the reservation, since what the provider billed is not known.
 */
function outcomeOf(message: AssistantMessage | undefined, sent: boolean, status: number | undefined): RequestOutcome {
  if (!sent) return { kind: 'released' }
  if (status !== undefined && (status < 200 || status >= 300)) return { kind: 'released' }
  const usage = message?.usage
  const input = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)
  const output = usage?.output ?? 0
  const complete = (message?.stopReason === 'stop' || message?.stopReason === 'length' || message?.stopReason === 'toolUse') && input > 0 && output > 0
  return { kind: 'used', input, output, usd: usage?.cost?.total ?? 0, ...(complete ? {} : { partial: true }) }
}

/** A stream that ends at once with `message`'s error (the forwarding itself failed). */
function failedMessage(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error', errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now()
  } as AssistantMessage
}

/**
 * A reserved request: `maxTokens` sized to the grant, Mousse's cap check chained after any
 * `onPayload` (the SDK's runs `before_provider_request`), and the reservation settled before the
 * last event goes on, so the next request sees the run's ledger up to date.
 */
function reservedStream(original: (model: Model<Api>, input: unknown, options?: RequestOptions) => AssistantMessageEventStream, model: Model<Api>, input: unknown, options: RequestOptions, grant: RequestGrant, gate: RequestGate, observer?: GuardObserver): AssistantMessageEventStream {
  let sent = false
  // The HTTP status, where it can be seen: every answer through `fetch`, a success through `onResponse`.
  let status: number | undefined
  const before = options.onPayload
  const afterResponse = options.onResponse
  const priorFetch = options.fetch
  const inner = original(model, input, {
    ...options,
    maxTokens: grant.maxTokens,
    onPayload: async (params, payloadModel) => {
      let next = params
      const chained = before ? await before(params, payloadModel) : undefined
      if (chained !== undefined) next = chained
      const cap = hookCap(model.api, next)
      // One completion per request: each candidate is capped separately.
      if (cap === undefined || cap > grant.cap || hookCandidates(model.api, next) !== 1) throw new Error(SPEND_CAP_MISMATCH)
      observer?.payload?.(model, next, grant)
      sent = true
      return next
    },
    onResponse: async (response, responseModel) => {
      status = response.status
      await afterResponse?.(response, responseModel)
    },
    ...(FETCH_APIS.has(model.api)
      ? {
          fetch: async (request: unknown, init?: unknown) => {
            const response = await (priorFetch ?? (globalThis.fetch as unknown as FetchFunction))(request, init)
            status = response.status
            return response
          }
        }
      : {})
  })
  const outer = createAssistantMessageEventStream()
  void (async () => {
    let settled = false
    const settle = async (message: AssistantMessage | undefined) => {
      if (settled) return
      settled = true
      await gate.settle(grant, outcomeOf(message, sent, status))
    }
    try {
      for await (const event of inner) {
        if (event.type === 'done' || event.type === 'error') await settle(event.type === 'done' ? event.message : event.error)
        outer.push(event)
      }
      const result = await inner.result()
      await settle(result)
      outer.end(result)
    } catch (error) {
      const message = failedMessage(model, error)
      await settle(message)
      outer.push({ type: 'error', reason: 'error', error: message })
      outer.end(message)
    }
  })()
  return outer
}

/**
 * Stream functions with the guard in front (the provider's own, or the global api registry's):
 * the Anthropic rule, then the request gate when there is one. A cancellation of a deferred
 * response is checked but never charged: it is not a model request.
 */
export function guardStreams<T extends Partial<ProviderStreams>>(streams: T, providerHeaders: Record<string, unknown> | undefined, observer?: GuardObserver, gate?: RequestGate): T {
  const wrapped: Record<string, unknown> = {}
  for (const name of ['stream', 'streamSimple', 'fetchDeferred'] as const) {
    const original = streams[name] as ((model: Model<Api>, input: unknown, options?: RequestOptions) => AssistantMessageEventStream) | undefined
    if (!original) continue
    wrapped[name] = (model: Model<Api>, input: unknown, options?: RequestOptions) => {
      const admitted = admit(model, providerHeaders, options)
      if (!admitted) return refused(model)
      if (!gate || admitted[CHARGED]) {
        observer?.admitted?.(model)
        return original(model, input, admitted)
      }
      return lazyStream(model, async () => {
        const grant = await gate.request(model, input, admitted as Record<string, unknown>, name)
        observer?.admitted?.(model)
        const charged: RequestOptions = { ...admitted, [CHARGED]: true }
        return grant ? reservedStream(original, model, input, charged, grant, gate, observer) : original(model, input, charged)
      })
    }
  }
  const cancel = streams.cancelDeferred as ((model: Model<Api>, handle: unknown, options?: RequestOptions) => Promise<void>) | undefined
  if (cancel)
    wrapped.cancelDeferred = async (model: Model<Api>, handle: unknown, options?: RequestOptions) => {
      const admitted = admit(model, providerHeaders, options)
      if (!admitted) throw new Error(ANTHROPIC_OAUTH_REFUSED)
      return cancel(model, handle, admitted)
    }
  return { ...streams, ...wrapped }
}

const refuseLogin = async (): Promise<never> => {
  throw new Error(LOGIN_REFUSED)
}

/** A copy of `value` (own fields and prototype, so class methods survive) with `patch` over it. */
function override<T extends object>(value: T, patch: Partial<T>): T {
  return Object.assign(Object.create(Object.getPrototypeOf(value) as object) as T, value, patch)
}

/**
 * `provider` with its stream functions guarded and its sign-in flows refused (Mousse signs in;
 * Pi never does). Everything else, OAuth `toAuth` and `refresh` included, is the provider's own.
 */
export function guardProvider(provider: Provider, observer?: GuardObserver, gate?: RequestGate): Provider {
  if (isGuarded(provider)) return provider
  const auth = provider.auth
  const guarded = override(provider, {
    ...guardStreams({
      stream: provider.stream.bind(provider),
      streamSimple: provider.streamSimple.bind(provider),
      ...(provider.fetchDeferred ? { fetchDeferred: provider.fetchDeferred.bind(provider) } : {}),
      ...(provider.cancelDeferred ? { cancelDeferred: provider.cancelDeferred.bind(provider) } : {})
    }, provider.headers, observer, gate),
    auth: {
      ...(auth.apiKey ? { apiKey: auth.apiKey.login ? override(auth.apiKey, { login: refuseLogin }) : auth.apiKey } : {}),
      ...(auth.oauth ? { oauth: override(auth.oauth, { login: refuseLogin }) } : {})
    }
  })
  GUARDED.add(guarded)
  return guarded
}

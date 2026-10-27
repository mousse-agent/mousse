import { lazyStream, type Api, type AssistantMessageEventStream, type Model, type Provider, type ProviderStreams } from '@earendil-works/pi-ai'
import { ANTHROPIC_OAUTH_REFUSED, LOGIN_REFUSED } from './messages'

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
}

const GUARDED = new WeakSet<object>()

/** Whether `provider` is a guarded registration (made by `guardProvider`). */
export function isGuarded(provider: unknown): boolean {
  return typeof provider === 'object' && provider !== null && GUARDED.has(provider)
}

type RequestOptions = { apiKey?: unknown; headers?: Record<string, unknown>; env?: Record<string, unknown>; maxRetries?: number }

/** Checks one request; returns the options it may go out with (`maxRetries: 0`), or null when refused. */
function admit(model: Model<Api>, providerHeaders: Record<string, unknown> | undefined, options: RequestOptions | undefined, observer?: GuardObserver): RequestOptions | null {
  const request: GuardedRequest = {
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey: options?.apiKey,
    headers: { ...(providerHeaders ?? {}), ...(model.headers ?? {}), ...(options?.headers ?? {}) },
    env: options?.env,
    sdkBaseUrls: sdkBaseUrls(options?.env)
  }
  if (refusesAnthropicRequest(request)) return null
  observer?.admitted?.(model)
  return { ...(options ?? {}), maxRetries: 0 }
}

function refused(model: Model<Api>): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    throw new Error(ANTHROPIC_OAUTH_REFUSED)
  })
}

/** Stream functions with the guard in front (the provider's own, or the global api registry's). */
export function guardStreams<T extends Partial<ProviderStreams>>(streams: T, providerHeaders: Record<string, unknown> | undefined, observer?: GuardObserver): T {
  const wrapped: Record<string, unknown> = {}
  for (const name of ['stream', 'streamSimple', 'fetchDeferred'] as const) {
    const original = streams[name] as ((model: Model<Api>, input: unknown, options?: RequestOptions) => AssistantMessageEventStream) | undefined
    if (!original) continue
    wrapped[name] = (model: Model<Api>, input: unknown, options?: RequestOptions) => {
      const admitted = admit(model, providerHeaders, options, observer)
      return admitted ? original(model, input, admitted) : refused(model)
    }
  }
  const cancel = streams.cancelDeferred as ((model: Model<Api>, handle: unknown, options?: RequestOptions) => Promise<void>) | undefined
  if (cancel)
    wrapped.cancelDeferred = async (model: Model<Api>, handle: unknown, options?: RequestOptions) => {
      const admitted = admit(model, providerHeaders, options, observer)
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
export function guardProvider(provider: Provider, observer?: GuardObserver): Provider {
  if (isGuarded(provider)) return provider
  const auth = provider.auth
  const guarded = override(provider, {
    ...guardStreams({
      stream: provider.stream.bind(provider),
      streamSimple: provider.streamSimple.bind(provider),
      ...(provider.fetchDeferred ? { fetchDeferred: provider.fetchDeferred.bind(provider) } : {}),
      ...(provider.cancelDeferred ? { cancelDeferred: provider.cancelDeferred.bind(provider) } : {})
    }, provider.headers, observer),
    auth: {
      ...(auth.apiKey ? { apiKey: auth.apiKey.login ? override(auth.apiKey, { login: refuseLogin }) : auth.apiKey } : {}),
      ...(auth.oauth ? { oauth: override(auth.oauth, { login: refuseLogin }) } : {})
    }
  })
  GUARDED.add(guarded)
  return guarded
}

/**
 * Requests to a local model server. Every request goes only to the connection's saved origin and never follows a
 * redirect: a redirect could carry a prompt, or the server's key, somewhere else. Imported by the Pi extension
 * bundle too (`harness/pi/extension/index.ts`), so it uses only the global `fetch` and nothing else of Mousse's.
 */

/** pi-ai's `StreamOptions.fetch`: what the OpenAI client calls. */
export type LocalFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** How a connection's requests are pinned (`PiCatalogProvider.pin`). */
export interface LocalPin {
  /** `http://127.0.0.1:11434`: the only origin requests may go to. */
  origin: string
  /** No key: the placeholder pi-ai needs is never sent (`Authorization` is dropped). */
  keyless: boolean
  /** Fields added to every chat request body (Unsloth Studio's `enable_tools: false`). */
  extraBody?: Record<string, unknown>
}

export class LocalRequestRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalRequestRefused'
  }
}

function urlOf(input: string | URL | Request): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  return new URL(input.url)
}

/**
 * A `fetch` held to `pin`: another origin is refused before anything is sent, a redirect is an error (never
 * followed), a keyless connection's `Authorization` is removed, and `extraBody` is merged into JSON chat bodies.
 */
export function pinnedFetch(pin: LocalPin, base: LocalFetch = (input, init) => globalThis.fetch(input, init)): LocalFetch {
  const origin = new URL(pin.origin).origin
  return async (input, init) => {
    const url = urlOf(input)
    if (url.origin !== origin) throw new LocalRequestRefused(`Mousse sends this model's requests only to ${origin}.`)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (pin.keyless) headers.delete('authorization')
    let body = init?.body ?? undefined
    if (pin.extraBody && typeof body === 'string' && /\/chat\/completions$/.test(url.pathname)) {
      try {
        const parsed = JSON.parse(body) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = JSON.stringify({ ...(parsed as Record<string, unknown>), ...pin.extraBody })
      } catch {
        // Not JSON: sent as it is.
      }
    }
    const response = await base(url.href, { ...init, ...(body !== undefined ? { body } : {}), headers, redirect: 'manual' })
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined)
      throw new LocalRequestRefused(`${origin} answered with a redirect; Mousse does not follow it.`)
    }
    return response
  }
}

/** One JSON read of a local server: its status and parsed body (undefined when not JSON or too big). */
export interface LocalReply {
  status: number
  json?: unknown
}

/** The largest body a metadata read accepts. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * A GET (or a read-only POST such as Ollama's `/api/show`) to `root` + `path` (`root` may carry a reverse-proxy
 * prefix), bounded by `timeoutMs` and `signal`. Throws only when nothing answered (refused, timed out, stopped);
 * any HTTP status is a reply.
 */
export async function localRequest(
  root: string,
  path: string,
  options: { timeoutMs: number; signal?: AbortSignal; apiKey?: string; body?: unknown; fetchImpl?: LocalFetch }
): Promise<LocalReply> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs)
  const origin = new URL(root).origin
  const fetchImpl = pinnedFetch({ origin, keyless: !options.apiKey }, options.fetchImpl)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await fetchImpl(`${root.replace(/\/+$/, '')}${path}`, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal
    })
  } catch (error) {
    // A redirect is an answer: not a model server Mousse uses.
    if (error instanceof LocalRequestRefused) return { status: 310 }
    throw error
  }
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return { status: response.status }
  }
  const text = await response.text().catch(() => '')
  if (text.length > MAX_BODY_BYTES) return { status: response.status }
  try {
    return { status: response.status, json: text ? (JSON.parse(text) as unknown) : undefined }
  } catch {
    return { status: response.status }
  }
}

/** Whether `host` is this computer (loopback), where plain http needs no consent. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  return bare === 'localhost' || bare === '::1' || /^127(?:\.\d{1,3}){3}$/.test(bare)
}

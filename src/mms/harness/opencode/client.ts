/**
 * A small client of OpenCode's v2 server API (`opencode serve`), written against the routes OpenCode 2.0 serves
 * (`packages/protocol/src/groups/*`): JSON over HTTP on loopback with the server's password, and the event stream.
 * Only what Mousse uses is here; every reply is read leniently, and an error reply keeps OpenCode's own `_tag`, so a
 * caller can tell a missing session or a busy one from a failure.
 */

/** Where a server listens and how to reach it. */
export interface OpencodeEndpoint {
  /** `http://127.0.0.1:<port>`. */
  url: string
  /** The server's password (`OPENCODE_SERVER_PASSWORD`); sent as HTTP basic auth. */
  password: string
  /** The user name basic auth carries. */
  username?: string
}

/** An error reply of the server: its HTTP status, OpenCode's error tag and its words. */
export class OpencodeApiError extends Error {
  constructor(readonly status: number, readonly tag: string | undefined, message: string, readonly body?: unknown) {
    super(message)
    this.name = 'OpencodeApiError'
  }
}

/** Whether `error` says the session (or the request in it) does not exist on this server. */
export function isNotFound(error: unknown): boolean {
  return error instanceof OpencodeApiError && (error.status === 404 || /NotFound/.test(error.tag ?? ''))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** `location[directory]=...` (OpenCode reads `location` as a deep object). */
function query(params: { directory?: string; extra?: Record<string, string | undefined> }): string {
  const search = new URLSearchParams()
  if (params.directory) search.set('location[directory]', params.directory)
  for (const [key, value] of Object.entries(params.extra ?? {})) if (value !== undefined) search.set(key, value)
  const text = search.toString()
  return text ? `?${text}` : ''
}

export interface RequestOptions {
  directory?: string
  query?: Record<string, string | undefined>
  body?: unknown
  signal?: AbortSignal
}

export class OpencodeClient {
  private readonly authorization: string

  constructor(readonly endpoint: OpencodeEndpoint, private readonly fetchImpl: typeof fetch = fetch) {
    this.authorization = `Basic ${Buffer.from(`${endpoint.username ?? 'opencode'}:${endpoint.password}`).toString('base64')}`
  }

  /** One request; resolves the reply's JSON (undefined for an empty reply), throws `OpencodeApiError` on an error reply. */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.endpoint.url}${path}${query({ directory: options.directory, extra: options.query })}`, {
      method,
      headers: {
        authorization: this.authorization,
        accept: 'application/json',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    if (!response.ok) {
      const tag = isRecord(parsed) && typeof parsed._tag === 'string' ? parsed._tag : undefined
      const message = isRecord(parsed) && typeof parsed.message === 'string' && parsed.message
        ? parsed.message
        : `OpenCode answered ${response.status}${tag ? ` (${tag})` : ''}`
      throw new OpencodeApiError(response.status, tag, message, parsed)
    }
    return parsed
  }

  /** A reply's `data` (`{ data }`, `{ location, data }`, `{ data, cursor }`), or the reply itself. */
  async data(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const reply = await this.request(method, path, options)
    return isRecord(reply) && 'data' in reply && Object.keys(reply).every((key) => key === 'data' || key === 'location' || key === 'cursor') ? reply.data : reply
  }

  /**
   * The server's event stream (`GET /api/event`, server-sent events): every event's JSON, until `signal` aborts or
   * the stream ends. `onOpen` runs once the server accepted the stream, before any event.
   */
  async events(onEvent: (event: Record<string, unknown>) => void, options: { signal: AbortSignal; directory?: string; onOpen?: () => void }): Promise<void> {
    const response = await this.fetchImpl(`${this.endpoint.url}/api/event${query({ directory: options.directory })}`, {
      headers: { authorization: this.authorization, accept: 'text/event-stream' },
      signal: options.signal
    })
    if (!response.ok || !response.body) throw new OpencodeApiError(response.status, undefined, `OpenCode refused its event stream (${response.status})`)
    options.onOpen?.()
    const decoder = new TextDecoder()
    let buffer = ''
    let data: string[] = []
    const dispatch = () => {
      if (!data.length) return
      const text = data.join('\n')
      data = []
      try {
        const parsed = JSON.parse(text) as unknown
        if (isRecord(parsed)) onEvent(parsed)
      } catch {
        // Not JSON: nothing Mousse reads.
      }
    }
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          if (line === '') dispatch()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
      }
      dispatch()
    } finally {
      reader.releaseLock()
    }
  }
}

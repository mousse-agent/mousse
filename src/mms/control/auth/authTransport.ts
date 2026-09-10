export type AuthFetch = typeof fetch

export function authUrl(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid authentication URL')
  return url.toString()
}

export async function authRequest(fetcher: AuthFetch, url: string, body: unknown, signal: AbortSignal, headers: Record<string, string> = {}): Promise<Response> {
  signal.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Authentication request timed out')), 30_000)
  try {
    const response = await fetcher(authUrl(url), {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: controller.signal
    })
    signal.throwIfAborted()
    // Keep the deadline active through the body, not just response headers.
    // Authentication responses are small JSON; never buffer an unbounded body.
    if (!response.body) return response
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        controller.signal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 256 * 1024) throw new Error('Authentication response is too large')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    signal.throwIfAborted()
    controller.signal.throwIfAborted()
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

export function authRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid authentication response')
  return value as Record<string, unknown>
}

export function authString(value: unknown, field: string, optional = false): string | undefined {
  if ((value === undefined || value === null) && optional) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) throw new Error('Invalid authentication response: ' + field)
  return value
}

export function authDuration(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Invalid authentication expiry or polling interval')
  return Math.min(value, maximum)
}

export function authDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Login cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function escapeAuthHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

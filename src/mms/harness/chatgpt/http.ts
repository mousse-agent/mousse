/** Small HTTP helpers for the OpenAI auth and API endpoints. Bodies are never logged. */

export interface JsonResponse {
  status: number
  ok: boolean
  /** The parsed body, or undefined when it was empty or not JSON. */
  body: unknown
  /** The `Retry-After` header, when present. */
  retryAfter?: string
}

async function answer(response: Response): Promise<JsonResponse> {
  const retryAfter = response.headers.get('retry-after')
  return { status: response.status, ok: response.ok, body: await readJson(response), ...(retryAfter ? { retryAfter } : {}) }
}

/** `Retry-After` (seconds or an HTTP date) as an ISO time, when it parses. */
export function retryAt(header: string | undefined, now = Date.now()): string | undefined {
  if (!header) return undefined
  const seconds = /^\d+$/.test(header.trim()) ? Number(header.trim()) : NaN
  const time = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(header)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function getJson(url: string, options: { timeoutMs: number; headers?: Record<string, string>; signal?: AbortSignal }): Promise<JsonResponse> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs)
  const response = await fetch(url, { headers: { accept: 'application/json', ...options.headers }, signal, redirect: 'error' })
  return answer(response)
}

export async function postForm(url: string, form: Record<string, string>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<JsonResponse> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs)
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal,
    redirect: 'error'
  })
  return answer(response)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The OAuth `error` code of a failed token response, when it carries one. */
export function oauthErrorCode(body: unknown): string | undefined {
  return isRecord(body) && typeof body.error === 'string' ? body.error : undefined
}

/** Waits for `promise`, rejecting with the signal's reason if it aborts first. The promise keeps running. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

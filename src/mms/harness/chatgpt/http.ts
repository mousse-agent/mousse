/** Small HTTP helpers for the OpenAI auth and API endpoints. Bodies are never logged. */

export interface JsonResponse {
  status: number
  ok: boolean
  /** The parsed body, or undefined when it was empty or not JSON. */
  body: unknown
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
  return { status: response.status, ok: response.ok, body: await readJson(response) }
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
  return { status: response.status, ok: response.ok, body: await readJson(response) }
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

export const CONNECTION_RETRY_COUNT = 5
export const CONNECTION_RETRY_DELAY_MS = 10_000

export class ConnectionRetriesExhaustedError extends Error {
  constructor(public readonly cause: unknown) {
    super('Connection retries exhausted')
    this.name = 'ConnectionRetriesExhaustedError'
  }
}

/**
 * Transient transport/provider failures that are safe to retry.
 * Keep authentication, permission, invalid-request, and unknown-model errors fail-fast.
 */
export function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /(?:fetch failed|network(?:\s+error)?|connection|econn(?:reset|refused|aborted)|enotfound|eai_again|etimedout|timeout|socket hang up|unable to connect|internal server error|service temporarily unavailable|temporarily unavailable|provider (?:is )?overloaded|upstream (?:service )?error|codex error:.*(?:retry your request|request id))/i.test(
    message
  )
}

export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(done, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      done(new DOMException('Aborted', 'AbortError'))
    }
    function done(error?: Error): void {
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function retryConnectionFailures<T>(
  operation: () => Promise<T>,
  onRetry: (attempt: number) => void,
  options: { retries?: number; delayMs?: number; signal?: AbortSignal; wait?: typeof waitForRetry } = {}
): Promise<T> {
  const retries = options.retries ?? CONNECTION_RETRY_COUNT
  const wait = options.wait ?? waitForRetry
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (!isConnectionFailure(error)) throw error
      if (attempt >= retries) throw new ConnectionRetriesExhaustedError(error)
      onRetry(attempt + 1)
      await wait(options.delayMs ?? CONNECTION_RETRY_DELAY_MS, options.signal)
    }
  }
}

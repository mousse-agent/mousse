import { AppError } from '../../shared/errors'
import { normalizeProviderError, providerErrors } from './providerErrors'
export const CONNECTION_RETRY_COUNT = 5
export const CONNECTION_RETRY_DELAY_MS = 10_000

export class ConnectionRetriesExhaustedError extends AppError {
  constructor(cause: unknown) {
    const error = providerErrors.create('provider_retry_exhausted', cause)
    super(error, cause)
    this.name = 'ConnectionRetriesExhaustedError'
  }
}

export function isConnectionFailure(error: unknown): boolean {
  return normalizeProviderError(error).errorInfo.retryable
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
  options: { retries?: number; delayMs?: number; signal?: AbortSignal; wait?: typeof waitForRetry; canRetry?: () => boolean } = {}
): Promise<T> {
  const retries = options.retries ?? CONNECTION_RETRY_COUNT
  const wait = options.wait ?? waitForRetry
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await operation()
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (!isConnectionFailure(error) || options.canRetry?.() === false) throw error
      if (attempt >= retries) throw new ConnectionRetriesExhaustedError(error)
      onRetry(attempt + 1)
      const retryAfter = normalizeProviderError(error).errorInfo.retryAfterMs ?? 0
      await wait(Math.max(options.delayMs ?? CONNECTION_RETRY_DELAY_MS, retryAfter), options.signal)
    }
  }
}

export class TimeoutError extends Error {
  readonly timeout = true
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

export async function withAbortTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  external?: AbortSignal
): Promise<T> {
  if (external?.aborted) {
    throw abortError(external.reason)
  }
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort(external?.reason ?? new Error('Cancelled'))
  external?.addEventListener('abort', onExternalAbort)
  const timeout = setTimeout(() => controller.abort(new TimeoutError(message)), timeoutMs)
  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError(controller.signal.reason))
      if (controller.signal.aborted) {
        onAbort()
        return
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      run(controller.signal).then(resolve, reject).finally(() => {
        controller.signal.removeEventListener('abort', onAbort)
      })
    })
  } finally {
    clearTimeout(timeout)
    external?.removeEventListener('abort', onExternalAbort)
  }
}

export function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error(reason == null ? 'Cancelled' : String(reason))
  error.name = 'AbortError'
  return error
}

export function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

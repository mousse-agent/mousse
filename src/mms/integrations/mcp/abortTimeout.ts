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

/**
 * A signal that aborts when any of `signals` does, with that signal's reason. The sources hold it weakly, so one made
 * for a single call or HTTP request is freed with it even when a source (a connection's or the manager's lifetime)
 * lives on; a listener added to such a source would keep it until the source ends.
 */
export function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal !== undefined))
}

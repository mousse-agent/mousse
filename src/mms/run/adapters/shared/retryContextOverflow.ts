/** A provider rejected the request because the prompt exceeded the model's context window. */
export function isContextOverflowError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error)
    return error.code === 'provider_context_overflow'
  const message = error instanceof Error ? error.message : String(error)
  return /context(?:_|\s|-)*(?:length|window|limit)|too many tokens|maximum context/i.test(message)
}

/**
 * Runs a provider call and, after a context-overflow failure, compacts once and retries.
 * `canRetry` is checked first: a call that already produced output or ran tools is not replayed.
 * `compact` returns false when compaction changed nothing; the original error is rethrown.
 */
export async function retryContextOverflowOnce<T>(
  run: () => Promise<T>,
  compact: () => boolean,
  canRetry: () => boolean = () => true
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!canRetry() || !isContextOverflowError(error) || !compact()) throw error
    return run()
  }
}

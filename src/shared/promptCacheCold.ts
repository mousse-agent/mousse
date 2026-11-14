/** Without a lifetime from the provider, a thread idle this long is treated as cold. */
export const IDLE_COLD_MS = 60 * 60_000

/**
 * Whether a thread's prompt cache has gone cold by `now`: its reported lifetime ran out, or, with none reported,
 * an hour passed since its last request. Undefined when nothing is known about it (no request recorded).
 */
export function promptCacheGoneCold(cache: { lastRequestAt: number; ttlMs?: number } | undefined, now: number): boolean | undefined {
  if (!cache || !Number.isFinite(cache.lastRequestAt) || cache.lastRequestAt <= 0) return undefined
  const idleMs = Math.max(0, now - cache.lastRequestAt)
  return idleMs >= (cache.ttlMs ?? IDLE_COLD_MS)
}

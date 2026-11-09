/** Anthropic's two prompt cache lifetimes (`cache_control.ttl`). */
export const PROMPT_CACHE_5M_MS = 5 * 60_000
export const PROMPT_CACHE_1H_MS = 60 * 60_000

const tokens = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/**
 * The lifetime of what one request wrote to the cache: one hour when any tokens were written with
 * one-hour retention, five minutes when any were written with the default; undefined when it wrote none
 * (it only read the cache, or the provider reports no breakdown).
 */
export function writtenCacheTtl(write: { oneHour?: unknown; fiveMinute?: unknown }): number | undefined {
  if (tokens(write.oneHour) > 0) return PROMPT_CACHE_1H_MS
  if (tokens(write.fiveMinute) > 0) return PROMPT_CACHE_5M_MS
  return undefined
}

/** The longer of two lifetimes; the longest one written in a turn is the one that applies after it. */
export function longerTtl(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

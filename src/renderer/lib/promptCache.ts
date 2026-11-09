import { useEffect, useState } from 'react'
import type { IdleCompactionSetting } from '../../shared/settings'
import { CONTEXT_DRAFT_CATEGORY, type ContextPromptCache, type ContextUsageSnapshot } from '../../shared/types'

/** Without a lifetime from the provider, a thread idle this long is treated as cold. */
export const IDLE_COLD_MS = 60 * 60_000
/** Below this, compacting saves too little to suggest. */
export const IDLE_COMPACTION_MIN_TOKENS = 40_000

/** The provider's cache of this thread now: warm for a while yet, expired, or (no lifetime reported) idle. */
export type PromptCacheState =
  | { kind: 'warm'; leftMs: number }
  | { kind: 'expired'; agoMs: number }
  | { kind: 'idle'; idleMs: number }

export function promptCacheState(cache: ContextPromptCache, now: number): PromptCacheState {
  const idleMs = Math.max(0, now - cache.lastRequestAt)
  if (!cache.ttlMs) return { kind: 'idle', idleMs }
  return idleMs < cache.ttlMs
    ? { kind: 'warm', leftMs: cache.ttlMs - idleMs }
    : { kind: 'expired', agoMs: idleMs - cache.ttlMs }
}

/** The next send re-reads the whole history uncached: the cache expired, or an hour passed with no lifetime known. */
export function cacheGoneCold(state: PromptCacheState): boolean {
  return state.kind === 'expired' || (state.kind === 'idle' && state.idleMs >= IDLE_COLD_MS)
}

/** "2d 3h", "1h 12m", "1h", "4m", "<1m". Elapsed time rounds down; time left rounds up. */
export function shortDuration(ms: number, round: 'down' | 'up' = 'down'): string {
  const minutes = round === 'up' ? Math.ceil(ms / 60_000) : Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
  }
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

/** "Cache warm · 4m left", "Cache expired 1h 12m ago", "Idle 1h 12m". */
export function promptCacheText(state: PromptCacheState): string {
  if (state.kind === 'warm') return `Cache warm · ${shortDuration(state.leftMs, 'up')} left`
  if (state.kind === 'expired') return `Cache expired ${shortDuration(state.agoMs)} ago`
  return `Idle ${shortDuration(state.idleMs)}`
}

/** The context the next send carries, without the unsent draft. */
export function contextTokens(usage: ContextUsageSnapshot): number {
  return usage.categories.reduce((sum, category) => sum + (category.label === CONTEXT_DRAFT_CATEGORY ? 0 : category.tokens), 0)
}

/** "182K", "1.2M". */
export function shortTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(tokens)
}

/** "≈$0.91" for re-reading `tokens` uncached, when the thread pays per token; undefined otherwise. */
export function uncachedCostText(cache: ContextPromptCache, tokens: number): string | undefined {
  if (!cache.uncachedUsdPerMTok) return undefined
  const usd = (tokens * cache.uncachedUsdPerMTok) / 1_000_000
  return usd < 0.01 ? '<$0.01' : `≈$${usd.toFixed(2)}`
}

/** Compacting is offered: the setting allows it, and the cache has gone cold. */
export function suggestsCompaction(usage: ContextUsageSnapshot, now: number, setting: IdleCompactionSetting): boolean {
  return setting !== 'off' && Boolean(usage.promptCache) && cacheGoneCold(promptCacheState(usage.promptCache!, now))
}

/**
 * What the composer's chip shows: "Compacting…" while a compaction runs; the Full/Compact choice when the
 * cache has gone cold on a long thread with no run going; nothing otherwise, and nothing at all with the
 * suggestion turned off or where the thread cannot be compacted from here.
 */
export function idleCompactionChip(input: {
  usage: ContextUsageSnapshot
  now: number
  setting: IdleCompactionSetting
  canCompact: boolean
  runActive: boolean
  compacting: boolean
}): 'compacting' | 'suggest' | null {
  if (!input.canCompact || input.setting === 'off') return null
  if (input.compacting) return 'compacting'
  if (input.runActive || contextTokens(input.usage) < IDLE_COMPACTION_MIN_TOKENS) return null
  return suggestsCompaction(input.usage, input.now, input.setting) ? 'suggest' : null
}

/**
 * The time now, renewed every minute while `enabled` (and whenever `since` changes), so cache lines count
 * down without a new snapshot.
 */
export function useMinuteClock(enabled: boolean, since?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [enabled, since])
  return now
}

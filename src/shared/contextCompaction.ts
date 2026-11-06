/** Room compaction keeps free for the reply. */
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384
/** Without a smaller size set, the context compacts at this share of the model's window. */
export const EXACT_COMPACTION_USAGE_RATIO = 0.95

/**
 * The active context size, in tokens, at which a context with this window compacts: the smallest of
 * 95% of the window, the configured size (capped by the window) and the window less the reply
 * reserve. Undefined when the window is not a positive number.
 */
export function compactionThreshold(
  contextWindow: number,
  configuredThreshold?: number,
  reserveTokens = DEFAULT_COMPACTION_RESERVE_TOKENS
): number | undefined {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  const requestedReserve = Math.max(0, Math.min(reserveTokens, contextWindow - 1))
  const reserve = contextWindow > requestedReserve * 2 ? requestedReserve : 0
  const watermark = Math.floor(contextWindow * EXACT_COMPACTION_USAGE_RATIO)
  const configured = configuredThreshold && configuredThreshold > 0
    ? Math.min(configuredThreshold, contextWindow)
    : watermark
  return Math.min(watermark, configured, contextWindow - reserve)
}

/** The Compact context setting (`settings.context`). */
export interface CompactionSetting {
  compactionEnabled: boolean
  compactionTokens: number | 'model-max'
}

/**
 * Where Mousse compacts a context under the Compact context setting. A size compacts there, capped
 * by the model's window when it is known; Model maximum compacts near the window, and only once the
 * window is known. Undefined when compaction is off or the point is not known yet.
 */
export function contextCompactionPoint(setting: CompactionSetting, knownWindow?: number): number | undefined {
  if (!setting.compactionEnabled) return undefined
  const threshold = typeof setting.compactionTokens === 'number' ? setting.compactionTokens : knownWindow
  if (threshold === undefined) return undefined
  return compactionThreshold(knownWindow ?? threshold, threshold)
}

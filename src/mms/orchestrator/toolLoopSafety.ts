import type { Message, Usage } from '@earendil-works/pi-ai'
import type { InlineCompactionResult } from './nativeContext'

/** Match the product's audited proactive compaction watermark. */
export const TOOL_LOOP_COMPACTION_USAGE_RATIO = 0.95

/**
 * Accumulated provider usage for one tool-loop turn.
 *
 * `processedTokens` is the sum of provider `usage.totalTokens` across model
 * calls. It is telemetry, not context occupancy, and never limits loop lifetime.
 */
export interface ToolLoopAccumulatedUsage {
  processedTokens: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Optional long-running loop maintenance. Tool loops have no cumulative token
 * or model-call cap; they end only when the model finishes, the caller aborts,
 * or an actual provider/tool error occurs.
 */
export interface ToolLoopSafetyOptions {
  /**
   * Active-input threshold. Aggregate processed usage is telemetry and must not
   * trigger context mutation.
   */
  compactionThresholdTokens?: number

  /**
   * Optional async compaction hook. Called only at the configured active-input
   * threshold or audited occupancy watermark, never from cumulative processed
   * usage. It receives a clone of the transcript; failure or an invalid result
   * leaves the live transcript unchanged.
   */
  compactNativeMessages?: (messages: Message[]) => InlineCompactionResult | Promise<InlineCompactionResult>
}

export function emptyAccumulatedUsage(): ToolLoopAccumulatedUsage {
  return {
    processedTokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0
  }
}

/** Fold one provider Usage into aggregate telemetry for the turn. */
export function accumulateProviderUsage(
  accumulated: ToolLoopAccumulatedUsage,
  usage: Usage
): ToolLoopAccumulatedUsage {
  return {
    processedTokens: accumulated.processedTokens + (usage.totalTokens || 0),
    input: accumulated.input + (usage.input || 0),
    output: accumulated.output + (usage.output || 0),
    cacheRead: accumulated.cacheRead + (usage.cacheRead || 0),
    cacheWrite: accumulated.cacheWrite + (usage.cacheWrite || 0)
  }
}

/** Apply caller compaction only at the occupancy watermark; never mutate on failure. */
export async function applySafeBoundaryCompaction(
  messages: Message[],
  options: ToolLoopSafetyOptions | undefined,
  activeContextTokens?: number,
  contextWindowTokens?: number
): Promise<InlineCompactionResult> {
  const compact = options?.compactNativeMessages
  const threshold = options?.compactionThresholdTokens
  const thresholdDue = threshold != null && activeContextTokens != null && activeContextTokens >= threshold
  const occupancyDue =
    activeContextTokens != null &&
    contextWindowTokens != null &&
    Number.isFinite(activeContextTokens) &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0 &&
    activeContextTokens / contextWindowTokens >= TOOL_LOOP_COMPACTION_USAGE_RATIO
  if (!compact || (!thresholdDue && !occupancyDue)) {
    return { messages, changed: false, reason: 'no-safe-boundary' }
  }

  const snapshot = structuredClone(messages)
  try {
    const result = await compact(snapshot)
    if (
      !result || !Array.isArray(result.messages) ||
      typeof result.changed !== 'boolean' ||
      (result.changed && (!result.checkpoint || result.messages.length === 0))
    ) {
      return { messages, changed: false, reason: 'no-safe-boundary' }
    }
    return result
  } catch {
    return { messages, changed: false, reason: 'no-safe-boundary' }
  }
}

import type { Message, Usage } from '@earendil-works/pi-ai'

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
   * Run context compaction at safe tool-batch boundaries after each additional
   * interval of aggregate processed usage. This is a maintenance trigger, not
   * a spending or lifetime limit.
   */
  compactionThresholdTokens?: number

  /**
   * Optional async compaction hook. It receives a clone of the transcript.
   * Failure or an invalid result leaves the live transcript unchanged.
   */
  compactNativeMessages?: (messages: Message[]) => Message[] | Promise<Message[]>
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

/** Apply caller compaction only at a safe boundary and never mutate on failure. */
export async function applySafeBoundaryCompaction(
  messages: Message[],
  options: ToolLoopSafetyOptions | undefined,
  processedTokens: number
): Promise<Message[]> {
  const compact = options?.compactNativeMessages
  const threshold = options?.compactionThresholdTokens
  if (!compact || threshold == null || processedTokens < threshold) return messages

  const snapshot = structuredClone(messages)
  try {
    const result = await compact(snapshot)
    return Array.isArray(result) ? result : messages
  } catch {
    return messages
  }
}

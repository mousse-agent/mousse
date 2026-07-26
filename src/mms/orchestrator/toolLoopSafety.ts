import type { Message, Usage } from '@earendil-works/pi-ai'

/**
 * Default max model requests per turn for ordinary main-agent calls.
 * Subagent callers should pass a lower override via ToolLoopSafetyOptions.
 */
export const DEFAULT_MAX_MODEL_CALLS = 24

/**
 * Absolute cap on aggregate processed tokens (sum of provider usage.totalTokens
 * across model calls in one turn). This is not context occupancy and does not
 * scale with model.contextWindow — large-context models must not auto-spend
 * millions of tokens.
 */
export const DEFAULT_MAX_PROCESSED_TOKENS = 512_000

/**
 * Suggested lower processed-token budget for Mousse subagent callers.
 * Not applied automatically; the integrating service must opt in.
 */
export const SUBAGENT_DEFAULT_MAX_PROCESSED_TOKENS = 256_000

/**
 * Suggested lower model-call cap for Mousse subagent callers.
 * Not applied automatically; the integrating service must opt in.
 */
export const SUBAGENT_DEFAULT_MAX_MODEL_CALLS = 16

/** Default fractions of either budget at which to emit warnings. */
export const DEFAULT_BUDGET_WARNING_THRESHOLDS = [0.5, 0.75] as const

/** @deprecated Prefer DEFAULT_MAX_MODEL_CALLS. */
export const MAX_TOOL_LOOP_ITERATIONS = DEFAULT_MAX_MODEL_CALLS

export type ToolLoopSafetyReason = 'model_calls' | 'token_budget'

/**
 * Accumulated provider usage for one tool-loop turn.
 *
 * `processedTokens` is the sum of provider `usage.totalTokens` across model
 * calls — aggregate processed usage, not context occupancy and not cost.
 */
export interface ToolLoopAccumulatedUsage {
  processedTokens: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ToolLoopSafetyLimits {
  maxModelCalls: number
  /** Absolute processed-token budget (aggregate provider totalTokens). */
  maxProcessedTokens: number
}

export interface ToolLoopBudgetWarning {
  kind: 'model_calls' | 'processed_tokens'
  /** Crossed fraction of the relevant limit (e.g. 0.5, 0.75). */
  fraction: number
  current: number
  limit: number
  modelCalls: number
  accumulatedUsage: ToolLoopAccumulatedUsage
}

/**
 * Configurable tool-loop safety options. Defaults are safe for main-agent turns;
 * subagent callers can pass lower absolute budgets and enable boundary compaction.
 */
export interface ToolLoopSafetyOptions {
  /** Cap on model requests in this turn. Default: DEFAULT_MAX_MODEL_CALLS (24). */
  maxModelCalls?: number

  /**
   * Cap on aggregate processed tokens (sum of provider totalTokens).
   * Default: DEFAULT_MAX_PROCESSED_TOKENS (512_000). Absolute — does not
   * scale with contextWindow.
   */
  maxProcessedTokens?: number

  /**
   * Fractions of either budget at which to emit warnings.
   * Default: [0.5, 0.75].
   */
  warningThresholds?: number[]

  /** Telemetry/UI callback for budget-fraction warnings. */
  onBudgetWarning?: (warning: ToolLoopBudgetWarning) => void

  /**
   * When set with `compactNativeMessages`, compaction may run only at a safe
   * boundary (after a completed tool batch, before the next model request)
   * once processed tokens reach this threshold. Choose a value below
   * `maxProcessedTokens` so compaction can free room before the hard stop.
   */
  compactionThresholdTokens?: number

  /**
   * Optional async-capable compaction hook. Receives a structuredClone of the
   * transcript and must return a new message array. The tool loop never mutates
   * the live transcript when the hook throws or returns a non-array.
   * Must preserve complete assistant/tool-result batches.
   */
  compactNativeMessages?: (messages: Message[]) => Message[] | Promise<Message[]>
}

/**
 * Typed safety error thrown when the tool loop hits a hard limit.
 * Carries a structuredClone-safe partial native transcript so callers can
 * retain completed assistant/tool-result work.
 */
export class ToolLoopSafetyError extends Error {
  readonly name = 'ToolLoopSafetyError'
  readonly reason: ToolLoopSafetyReason
  readonly modelCalls: number
  readonly accumulatedUsage: ToolLoopAccumulatedUsage
  readonly budget: ToolLoopSafetyLimits
  /** structuredClone-safe partial native transcript. */
  readonly partialNativeMessages: Message[]

  constructor(params: {
    reason: ToolLoopSafetyReason
    modelCalls: number
    accumulatedUsage: ToolLoopAccumulatedUsage
    budget: ToolLoopSafetyLimits
    partialNativeMessages: Message[]
  }) {
    const { reason, modelCalls, accumulatedUsage, budget, partialNativeMessages } = params
    const message =
      reason === 'model_calls'
        ? `Agent stopped before producing a final response: tool loop reached its safety limit of ${budget.maxModelCalls} model calls.`
        : `Agent stopped before producing a final response: tool loop used ${accumulatedUsage.processedTokens.toLocaleString()} processed tokens, exceeding its ${budget.maxProcessedTokens.toLocaleString()}-token safety budget.`
    super(message)
    this.reason = reason
    this.modelCalls = modelCalls
    this.accumulatedUsage = { ...accumulatedUsage }
    this.budget = { ...budget }
    this.partialNativeMessages = structuredClone(partialNativeMessages)
  }
}

export function isToolLoopSafetyError(error: unknown): error is ToolLoopSafetyError {
  return error instanceof ToolLoopSafetyError
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

/** Fold one provider Usage into aggregate processed usage for the turn. */
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

export function resolveToolLoopSafetyLimits(
  options?: ToolLoopSafetyOptions | null
): ToolLoopSafetyLimits {
  const maxModelCalls = options?.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS
  const maxProcessedTokens = options?.maxProcessedTokens ?? DEFAULT_MAX_PROCESSED_TOKENS
  return {
    maxModelCalls: Math.max(1, Math.floor(maxModelCalls)),
    maxProcessedTokens: Math.max(1, Math.floor(maxProcessedTokens))
  }
}

export function resolveWarningThresholds(options?: ToolLoopSafetyOptions | null): number[] {
  const raw = options?.warningThresholds ?? [...DEFAULT_BUDGET_WARNING_THRESHOLDS]
  return raw
    .filter((value) => Number.isFinite(value) && value > 0 && value < 1)
    .sort((a, b) => a - b)
}

/**
 * Returns budget fractions that were not yet reached before `previous` but are
 * reached at `current` (exclusive previous, inclusive current).
 */
export function crossedBudgetFractions(
  previous: number,
  current: number,
  limit: number,
  thresholds: number[]
): number[] {
  if (limit <= 0 || current <= previous) return []
  const crossed: number[] = []
  for (const fraction of thresholds) {
    const boundary = limit * fraction
    if (previous < boundary && current >= boundary) {
      crossed.push(fraction)
    }
  }
  return crossed
}

export function emitToolLoopBudgetWarnings(params: {
  previousUsage: ToolLoopAccumulatedUsage
  currentUsage: ToolLoopAccumulatedUsage
  previousModelCalls: number
  modelCalls: number
  limits: ToolLoopSafetyLimits
  thresholds: number[]
  warnedKeys: Set<string>
  onBudgetWarning?: (warning: ToolLoopBudgetWarning) => void
}): void {
  const {
    previousUsage,
    currentUsage,
    previousModelCalls,
    modelCalls,
    limits,
    thresholds,
    warnedKeys,
    onBudgetWarning
  } = params
  if (!onBudgetWarning || thresholds.length === 0) return

  for (const fraction of crossedBudgetFractions(
    previousUsage.processedTokens,
    currentUsage.processedTokens,
    limits.maxProcessedTokens,
    thresholds
  )) {
    const key = `processed_tokens:${fraction}`
    if (warnedKeys.has(key)) continue
    warnedKeys.add(key)
    onBudgetWarning({
      kind: 'processed_tokens',
      fraction,
      current: currentUsage.processedTokens,
      limit: limits.maxProcessedTokens,
      modelCalls,
      accumulatedUsage: { ...currentUsage }
    })
  }

  for (const fraction of crossedBudgetFractions(
    previousModelCalls,
    modelCalls,
    limits.maxModelCalls,
    thresholds
  )) {
    const key = `model_calls:${fraction}`
    if (warnedKeys.has(key)) continue
    warnedKeys.add(key)
    onBudgetWarning({
      kind: 'model_calls',
      fraction,
      current: modelCalls,
      limit: limits.maxModelCalls,
      modelCalls,
      accumulatedUsage: { ...currentUsage }
    })
  }
}

export function assertWithinModelCallBudget(params: {
  modelCalls: number
  limits: ToolLoopSafetyLimits
  accumulatedUsage: ToolLoopAccumulatedUsage
  partialNativeMessages: Message[]
}): void {
  const { modelCalls, limits, accumulatedUsage, partialNativeMessages } = params
  if (modelCalls >= limits.maxModelCalls) {
    throw new ToolLoopSafetyError({
      reason: 'model_calls',
      modelCalls,
      accumulatedUsage,
      budget: limits,
      partialNativeMessages
    })
  }
}

export function assertWithinProcessedTokenBudget(params: {
  modelCalls: number
  limits: ToolLoopSafetyLimits
  accumulatedUsage: ToolLoopAccumulatedUsage
  partialNativeMessages: Message[]
}): void {
  const { modelCalls, limits, accumulatedUsage, partialNativeMessages } = params
  if (accumulatedUsage.processedTokens > limits.maxProcessedTokens) {
    throw new ToolLoopSafetyError({
      reason: 'token_budget',
      modelCalls,
      accumulatedUsage,
      budget: limits,
      partialNativeMessages
    })
  }
}

/**
 * After the loop exits while the last stopReason is still toolUse, raise a
 * typed model-call safety error with the partial transcript.
 */
export function assertToolLoopFinished(params: {
  stopReason: string | undefined
  modelCalls: number
  limits: ToolLoopSafetyLimits
  accumulatedUsage: ToolLoopAccumulatedUsage
  partialNativeMessages: Message[]
}): void {
  if (params.stopReason === 'toolUse') {
    throw new ToolLoopSafetyError({
      reason: 'model_calls',
      modelCalls: params.modelCalls,
      accumulatedUsage: params.accumulatedUsage,
      budget: params.limits,
      partialNativeMessages: params.partialNativeMessages
    })
  }
}

/**
 * Apply caller compaction only at a safe boundary. Always operates on a clone;
 * on hook failure the original transcript is returned unchanged.
 */
export async function applySafeBoundaryCompaction(
  messages: Message[],
  options: ToolLoopSafetyOptions | undefined,
  processedTokens: number
): Promise<Message[]> {
  const compact = options?.compactNativeMessages
  const threshold = options?.compactionThresholdTokens
  if (!compact || threshold == null || processedTokens < threshold) {
    return messages
  }

  const snapshot = structuredClone(messages)
  try {
    const result = await compact(snapshot)
    if (!Array.isArray(result)) return messages
    return result
  } catch {
    return messages
  }
}

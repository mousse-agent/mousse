import type {
  AgentExecutionBudget,
  AgentRuntimeAttemptUsage,
  AgentRuntimeFallbackPolicy
} from '../../shared/agents/execution'
import type { AgentFallbackRetryCategory, AgentModelCapabilityProfile } from '../../shared/agents/types'

export function emptyAttemptUsage(): AgentRuntimeAttemptUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, toolCalls: 0 }
}

export function addAttemptUsage(
  total: AgentRuntimeAttemptUsage,
  next: AgentRuntimeAttemptUsage | undefined
): AgentRuntimeAttemptUsage {
  if (!next) return total
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    costUsd: total.costUsd + next.costUsd,
    turns: total.turns + next.turns,
    toolCalls: total.toolCalls + next.toolCalls
  }
}

export function remainingBudget(
  budget: AgentExecutionBudget,
  used: AgentRuntimeAttemptUsage,
  elapsedMs: number
): AgentExecutionBudget {
  const remaining: AgentExecutionBudget = {
    maxTurns: Math.max(0, budget.maxTurns - used.turns),
    maxToolCalls: Math.max(0, budget.maxToolCalls - used.toolCalls),
    maxElapsedMs: budget.maxElapsedMs > 0 ? Math.max(0, budget.maxElapsedMs - elapsedMs) : 0
  }
  if (budget.maxInputTokens !== undefined) {
    remaining.maxInputTokens = Math.max(0, budget.maxInputTokens - used.inputTokens)
  }
  if (budget.maxOutputTokens !== undefined) {
    remaining.maxOutputTokens = Math.max(0, budget.maxOutputTokens - used.outputTokens)
  }
  if (budget.maxCostUsd !== undefined) {
    remaining.maxCostUsd = Math.max(0, budget.maxCostUsd - used.costUsd)
  }
  return remaining
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

export function classifyProviderFailure(error: unknown): AgentFallbackRetryCategory | undefined {
  if (isAbortError(error)) return undefined
  const text = errorText(error).toLowerCase()
  if (/content[_\s-]?filter|safety|refused/.test(text)) return 'content_filter'
  if (/rate.?limit|too many requests|429/.test(text)) return 'rate_limit'
  if (/timeout|timed out|inactiv/.test(text)) return 'timeout'
  if (
    /unknown model|not connected|not configured|does not support|unavailable|econnreset|socket hang up|network|enotfound|eai_again|provider/.test(
      text
    )
  ) {
    return 'unavailable'
  }
  return undefined
}

export function canFallbackOrRetry(input: {
  error: unknown
  signal?: AbortSignal
  dispatched: boolean
  policy: AgentRuntimeFallbackPolicy
  sameModel: boolean
}): boolean {
  if (input.dispatched) return false
  if (isAbortError(input.error, input.signal)) return false
  const category = classifyProviderFailure(input.error)
  if (!category) return false
  const retryOn = input.policy.retryOn
  if (retryOn.length > 0) return retryOn.includes(category)
  if (category === 'content_filter') return false
  if (input.sameModel) return input.policy.retryCount > 0
  return input.policy.enabled
}

export function orderedFallbackModels(
  primary: AgentModelCapabilityProfile,
  fallbacks: AgentModelCapabilityProfile[],
  enabled: boolean
): AgentModelCapabilityProfile[] {
  const models = [primary]
  if (!enabled) return models
  for (const candidate of fallbacks) {
    if (
      candidate.ref.providerId === primary.ref.providerId &&
      candidate.ref.modelId === primary.ref.modelId &&
      candidate.ref.effort === primary.ref.effort
    ) {
      continue
    }
    models.push(candidate)
  }
  return models
}

export async function waitBackoff(backoffMs: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(backoffMs) || backoffMs <= 0) return
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, backoffMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

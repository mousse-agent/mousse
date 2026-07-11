import { ORCHESTRATOR_SYSTEM_PROMPT } from './systemPrompt'
import type { LlmMessage } from './LlmClient'
import type { ContextUsageSnapshot } from '../../shared/types'

const MESSAGE_OVERHEAD = 4

export const CONTEXT_CATEGORY_COLORS = {
  systemPrompt: '#6b7280',
  conversation: '#06b6d4',
  draft: '#8b5cf6',
  cacheRead: '#22c55e'
} as const

function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

function estimateHistoryTokens(history: LlmMessage[]): number {
  return history.reduce(
    (sum, message) => sum + estimateTokens(message.content) + MESSAGE_OVERHEAD,
    0
  )
}

export interface ComputeContextUsageParams {
  history: LlmMessage[]
  draftInput: string
  contextLimit: number
  modelName: string | null
  lastMeasuredInput: number | null
  lastMeasuredCacheRead: number | null
  measuredAtHistoryLength: number
  systemPromptText?: string
}

export function computeContextUsage(params: ComputeContextUsageParams): ContextUsageSnapshot {
  const {
    history,
    draftInput,
    contextLimit,
    modelName,
    lastMeasuredInput,
    lastMeasuredCacheRead,
    measuredAtHistoryLength,
    systemPromptText = ORCHESTRATOR_SYSTEM_PROMPT
  } = params

  const systemTokens = estimateTokens(systemPromptText)
  const draftTokens = draftInput.trim()
    ? estimateTokens(draftInput.trim()) + MESSAGE_OVERHEAD
    : 0

  const hasFreshMeasurement =
    lastMeasuredInput !== null && measuredAtHistoryLength === history.length

  let conversationTokens: number
  let cacheReadTokens = 0
  let source: ContextUsageSnapshot['source']

  if (hasFreshMeasurement) {
    cacheReadTokens = lastMeasuredCacheRead ?? 0
    conversationTokens = Math.max(0, lastMeasuredInput - systemTokens)
    source = 'measured'
  } else {
    conversationTokens = estimateHistoryTokens(history)
    source = 'estimated'
  }

  const categories: ContextUsageSnapshot['categories'] = [
    {
      label: 'System prompt',
      color: CONTEXT_CATEGORY_COLORS.systemPrompt,
      tokens: systemTokens
    },
    {
      label: 'Conversation',
      color: CONTEXT_CATEGORY_COLORS.conversation,
      tokens: conversationTokens
    }
  ]

  if (cacheReadTokens > 0) {
    categories.push({
      label: 'Prompt cache',
      color: CONTEXT_CATEGORY_COLORS.cacheRead,
      tokens: cacheReadTokens
    })
  }

  if (draftTokens > 0) {
    categories.push({
      label: 'Draft message',
      color: CONTEXT_CATEGORY_COLORS.draft,
      tokens: draftTokens
    })
  }

  const used = categories.reduce((sum, category) => sum + category.tokens, 0)
  const limit = contextLimit > 0 ? contextLimit : 128_000
  const percent = Math.min(100, Math.round((used / limit) * 100))

  return {
    percent,
    used,
    limit,
    modelName,
    source,
    categories
  }
}

export { estimateTokens, ORCHESTRATOR_SYSTEM_PROMPT }

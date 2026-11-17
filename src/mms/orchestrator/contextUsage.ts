import type { Message } from '../../shared/transcript'
import { CONTEXT_DRAFT_CATEGORY, type ContextUsageSnapshot } from '../../shared/types'
import { estimateMessage, estimateTokens, MESSAGE_OVERHEAD, type MessageEstimate } from './contextEstimate'

export { estimateTokens } from './contextEstimate'

export const CONTEXT_CATEGORY_COLORS = {
  systemPrompt: '#6b7280', mcpTools: '#f59e0b', otherTools: '#ec4899',
  conversation: '#06b6d4', thinking: '#3b82f6', toolData: '#14b8a6',
  summary: '#f97316', draft: '#8b5cf6', cacheRead: '#22c55e', newMessages: '#818cf8'
} as const

export interface ComputeContextUsageParams {
  messages?: Message[]
  /**
   * The messages' estimates (`estimateMessage`), when they were made elsewhere: the read worker makes them for a
   * thread with no session. Used instead of `messages`.
   */
  messageEstimates?: MessageEstimate[]
  /** @deprecated compatibility for callers predating native Pi transcripts. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  draftInput: string
  contextLimit: number
  modelName: string | null
  lastMeasuredInput: number | null
  lastMeasuredCacheRead: number | null
  lastMeasuredCacheWrite: number | null
  /**
   * Without a measurement for the history as it is now (a turn runs, it was stopped, or the history changed): what
   * the last measured request carried beyond its messages (`contextBaseTokens`). Counted with the messages'
   * estimate, so the gauge never drops to the messages alone.
   */
  baseTokens?: number | null
  measuredAtMessageLength?: number
  /** @deprecated use measuredAtMessageLength. */
  measuredAtHistoryLength?: number
  legacyEstimated?: boolean
  summaryText?: string
  systemPromptText?: string
  mcpToolsText?: string
  otherToolsText?: string
}

export function computeContextUsage(params: ComputeContextUsageParams): ContextUsageSnapshot {
  const {
    draftInput, contextLimit, modelName, lastMeasuredInput,
    lastMeasuredCacheRead, lastMeasuredCacheWrite,
    legacyEstimated = false, systemPromptText = '',
    mcpToolsText = '', otherToolsText = ''
  } = params
  const given = params.messageEstimates
  const messages: Message[] = given ? [] : params.messages ?? (params.history ?? []).map((message) => ({
    role: 'user' as const,
    content: `${message.role === 'assistant' ? 'Assistant: ' : ''}${message.content}`,
    timestamp: 0
  }))
  const messageCount = given ? given.length : messages.length
  // Only the messages a figure needs are estimated: with a measurement, those after it.
  const estimatesFrom = (start: number): MessageEstimate[] => given ? given.slice(start) : messages.slice(start).map((message) => estimateMessage(message))
  const measuredAtMessageLength = params.measuredAtMessageLength ?? params.measuredAtHistoryLength ?? 0
  const draftTokens = draftInput.trim() ? estimateTokens(draftInput.trim()) + MESSAGE_OVERHEAD : 0
  const hasMeasurement = lastMeasuredInput !== null &&
    lastMeasuredInput + (lastMeasuredCacheRead ?? 0) + (lastMeasuredCacheWrite ?? 0) > 0 &&
    measuredAtMessageLength >= 0 && measuredAtMessageLength <= messageCount
  const categories: ContextUsageSnapshot['categories'] = []

  let request: ContextUsageSnapshot['request']
  if (hasMeasurement) {
    // The whole last request: what it read from the cache, what it wrote to it, and the rest sent uncached.
    const read = Math.max(0, lastMeasuredCacheRead ?? 0)
    const written = Math.max(0, lastMeasuredCacheWrite ?? 0)
    const uncached = Math.max(0, lastMeasuredInput ?? 0)
    request = { cached: read, uncached: written + uncached }
    if (read) categories.push({ label: CONTEXT_CACHE_READ_CATEGORY, color: CONTEXT_CATEGORY_COLORS.cacheRead, tokens: read })
    if (written) categories.push({ label: CONTEXT_CACHE_WRITE_CATEGORY, color: CONTEXT_CATEGORY_COLORS.mcpTools, tokens: written })
    if (uncached) categories.push({ label: CONTEXT_UNCACHED_CATEGORY, color: CONTEXT_CATEGORY_COLORS.conversation, tokens: uncached })
    const trailing = estimatesFrom(measuredAtMessageLength).reduce((sum, estimate) => sum + estimate[0], 0)
    if (trailing) categories.push({ label: 'New conversation', color: CONTEXT_CATEGORY_COLORS.newMessages, tokens: trailing })
  } else {
    const base = Math.max(0, Math.round(params.baseTokens ?? 0))
    if (base) categories.push({ label: CONTEXT_BASE_CATEGORY, color: CONTEXT_CATEGORY_COLORS.systemPrompt, tokens: base })
    const system = estimateTokens(systemPromptText)
    if (system) categories.push({ label: 'System prompt & skills', color: CONTEXT_CATEGORY_COLORS.systemPrompt, tokens: system })
    const mcp = estimateTokens(mcpToolsText)
    if (mcp) categories.push({ label: 'MCP tools', color: CONTEXT_CATEGORY_COLORS.mcpTools, tokens: mcp })
    const other = estimateTokens(otherToolsText)
    if (other) categories.push({ label: 'Other tools', color: CONTEXT_CATEGORY_COLORS.otherTools, tokens: other })
    const summary = estimateTokens(params.summaryText ?? '')
    if (summary) categories.push({ label: 'Compaction summary', color: CONTEXT_CATEGORY_COLORS.summary, tokens: summary })
    const parts = partitionMessages(estimatesFrom(0))
    for (const part of parts) if (part.tokens) categories.push(part)
  }
  if (draftTokens) categories.push({ label: CONTEXT_DRAFT_CATEGORY, color: CONTEXT_CATEGORY_COLORS.draft, tokens: draftTokens })
  const used = categories.reduce((sum, category) => sum + category.tokens, 0)
  // An unknown window stays 0 (and the share 0), never a guessed capacity: the ring then shows nothing.
  const limit = contextLimit > 0 ? contextLimit : 0
  return {
    percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0, used, limit, modelName,
    source: hasMeasurement ? 'measured' : legacyEstimated ? 'legacy-estimated' : 'estimated', categories,
    ...(request ? { request } : {})
  }
}

/** The measured request's parts in the gauge's breakdown. */
export const CONTEXT_CACHE_READ_CATEGORY = 'Read from cache'
export const CONTEXT_CACHE_WRITE_CATEGORY = 'Written to cache'
export const CONTEXT_UNCACHED_CATEGORY = 'Sent uncached'
/** Without a fresh measurement: the system prompt, tools and added instructions, as last measured. */
export const CONTEXT_BASE_CATEGORY = 'System, tools & instructions'

/**
 * What a measured request carried beyond the messages it was sent: the runtime's system prompt and tool
 * definitions, the instructions the runtime and Mousse add, and whatever the messages' estimate misses. It is
 * the measured size less the estimate the gauge would show for the same messages (`summaryText` and each
 * message's split), so a later estimate of base plus messages starts where the measurement left off.
 */
export function contextBaseTokens(measured: number, estimates: MessageEstimate[], summaryText = ''): number {
  const messages = estimates.reduce((sum, estimate) => sum + estimate[1] + estimate[2] + estimate[3] + estimate[4], 0)
  return Math.max(0, Math.round(measured - messages - estimateTokens(summaryText)))
}

function partitionMessages(estimates: MessageEstimate[]): ContextUsageSnapshot['categories'] {
  let conversation = 0, thinking = 0, toolData = 0, summary = 0
  for (const estimate of estimates) {
    conversation += estimate[1]
    thinking += estimate[2]
    toolData += estimate[3]
    summary += estimate[4]
  }
  return [
    { label: 'Prompts & responses', color: CONTEXT_CATEGORY_COLORS.conversation, tokens: conversation },
    { label: 'Thinking', color: CONTEXT_CATEGORY_COLORS.thinking, tokens: thinking },
    { label: 'Tool calls & results', color: CONTEXT_CATEGORY_COLORS.toolData, tokens: toolData },
    { label: 'Compaction summary', color: CONTEXT_CATEGORY_COLORS.summary, tokens: summary }
  ]
}

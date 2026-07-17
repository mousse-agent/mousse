import type { Message } from '@earendil-works/pi-ai'
import { ORCHESTRATOR_SYSTEM_PROMPT } from './systemPrompt'
import type { ContextUsageSnapshot } from '../../shared/types'
import { estimateMessageTokens } from './nativeContext'

const MESSAGE_OVERHEAD = 4

export const CONTEXT_CATEGORY_COLORS = {
  systemPrompt: '#6b7280', mcpTools: '#f59e0b', otherTools: '#ec4899',
  conversation: '#06b6d4', thinking: '#3b82f6', toolData: '#14b8a6',
  summary: '#f97316', draft: '#8b5cf6', cacheRead: '#22c55e'
} as const

export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

export interface ComputeContextUsageParams {
  messages?: Message[]
  /** @deprecated compatibility for callers predating native Pi transcripts. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  draftInput: string
  contextLimit: number
  modelName: string | null
  lastMeasuredInput: number | null
  lastMeasuredCacheRead: number | null
  lastMeasuredCacheWrite: number | null
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
    legacyEstimated = false, systemPromptText = ORCHESTRATOR_SYSTEM_PROMPT,
    mcpToolsText = '', otherToolsText = ''
  } = params
  const messages: Message[] = params.messages ?? (params.history ?? []).map((message) => ({
    role: 'user' as const,
    content: `${message.role === 'assistant' ? 'Assistant: ' : ''}${message.content}`,
    timestamp: 0
  }))
  const measuredAtMessageLength = params.measuredAtMessageLength ?? params.measuredAtHistoryLength ?? 0
  const draftTokens = draftInput.trim() ? estimateTokens(draftInput.trim()) + MESSAGE_OVERHEAD : 0
  const hasMeasurement = !legacyEstimated && lastMeasuredInput !== null &&
    lastMeasuredInput + (lastMeasuredCacheRead ?? 0) + (lastMeasuredCacheWrite ?? 0) > 0 &&
    measuredAtMessageLength >= 0 && measuredAtMessageLength <= messages.length
  const categories: ContextUsageSnapshot['categories'] = []

  if (hasMeasurement) {
    const uncached = Math.max(0, lastMeasuredInput ?? 0)
    const cached = Math.max(0, (lastMeasuredCacheRead ?? 0) + (lastMeasuredCacheWrite ?? 0))
    if (uncached) categories.push({ label: 'Prompt (uncached)', color: CONTEXT_CATEGORY_COLORS.conversation, tokens: uncached })
    if (cached) categories.push({ label: 'Prompt cache', color: CONTEXT_CATEGORY_COLORS.cacheRead, tokens: cached })
    const trailing = messages.slice(measuredAtMessageLength).reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    if (trailing) categories.push({ label: 'New conversation', color: CONTEXT_CATEGORY_COLORS.conversation, tokens: trailing })
  } else {
    const system = estimateTokens(systemPromptText)
    if (system) categories.push({ label: 'System prompt & skills', color: CONTEXT_CATEGORY_COLORS.systemPrompt, tokens: system })
    const mcp = estimateTokens(mcpToolsText)
    if (mcp) categories.push({ label: 'MCP tools', color: CONTEXT_CATEGORY_COLORS.mcpTools, tokens: mcp })
    const other = estimateTokens(otherToolsText)
    if (other) categories.push({ label: 'Other tools', color: CONTEXT_CATEGORY_COLORS.otherTools, tokens: other })
    const parts = partitionMessages(messages)
    for (const part of parts) if (part.tokens) categories.push(part)
  }
  if (draftTokens) categories.push({ label: 'Draft message', color: CONTEXT_CATEGORY_COLORS.draft, tokens: draftTokens })
  const used = categories.reduce((sum, category) => sum + category.tokens, 0)
  const limit = contextLimit > 0 ? contextLimit : 128_000
  return {
    percent: Math.min(100, Math.round((used / limit) * 100)), used, limit, modelName,
    source: legacyEstimated ? 'legacy-estimated' : hasMeasurement ? 'measured' : 'estimated', categories
  }
}

function partitionMessages(messages: Message[]): ContextUsageSnapshot['categories'] {
  let conversation = 0, thinking = 0, toolData = 0, summary = 0
  for (const message of messages) {
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      const tokens = estimateMessageTokens(message)
      if (text.startsWith('[Compacted conversation summary]')) summary += tokens
      else conversation += tokens
    } else if (message.role === 'toolResult') toolData += estimateMessageTokens(message)
    else {
      for (const block of message.content) {
        if (block.type === 'thinking') thinking += estimateTokens(block.thinking)
        else if (block.type === 'toolCall') toolData += estimateTokens(block.name + block.id + JSON.stringify(block.arguments))
        else conversation += estimateTokens(block.text)
      }
      conversation += MESSAGE_OVERHEAD
    }
  }
  return [
    { label: 'Prompts & responses', color: CONTEXT_CATEGORY_COLORS.conversation, tokens: conversation },
    { label: 'Thinking', color: CONTEXT_CATEGORY_COLORS.thinking, tokens: thinking },
    { label: 'Tool calls & results', color: CONTEXT_CATEGORY_COLORS.toolData, tokens: toolData },
    { label: 'Compaction summary', color: CONTEXT_CATEGORY_COLORS.summary, tokens: summary }
  ]
}

export { ORCHESTRATOR_SYSTEM_PROMPT }

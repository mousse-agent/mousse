import type { ChatMessage } from '../../shared/types'
import { isToolTimelineMessage } from '../../shared/types'

/** Action controls belong only to completed, user-visible assistant replies. */
export function canShowAssistantMessageActions(
  message: Pick<ChatMessage, 'role' | 'kind' | 'streaming' | 'incomplete'>
): boolean {
  return (
    message.role === 'assistant' &&
    message.kind !== 'thinking' &&
    !isToolTimelineMessage(message) &&
    !message.incomplete &&
    !message.streaming
  )
}

export function formatResponseTime(milliseconds?: number): string {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return 'Unavailable'
  }
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 0 : 1)} s`
}

export function formatTokens(tokens?: number): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return 'Unavailable'
  return new Intl.NumberFormat().format(Math.round(tokens))
}

/** Format the TPS measured by the LLM client from provider-reported output usage. */
export function formatTokensPerSecond(tokensPerSecond?: number): string {
  if (
    typeof tokensPerSecond !== 'number' ||
    !Number.isFinite(tokensPerSecond) ||
    tokensPerSecond < 0
  ) {
    return 'Unavailable'
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(tokensPerSecond)
}

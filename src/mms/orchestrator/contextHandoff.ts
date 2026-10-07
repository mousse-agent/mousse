import { parseThinkingSuffixFromModelId } from '../../shared/modelVariants'
import type { ChatMessage, NativeLlmContext } from '../../shared/types'

type Selection = NonNullable<ChatMessage['modelSelection']>

/** Find the last admitted selection; native assistant identity supports older threads. */
export function previousTurnModel(messages: ChatMessage[], context: NativeLlmContext): Selection | undefined {
  for (const message of [...messages].reverse()) {
    if (!message.hidden && message.role === 'user' && message.modelSelection) return message.modelSelection
  }
  for (const message of [...context.messages].reverse()) {
    if (message.role === 'assistant' && message.model !== 'legacy-text-only') return { provider: message.provider, model: message.model }
  }
  return undefined
}

export function contextHandoff(previous: Selection | undefined, next: Selection): ChatMessage['contextHandoff'] {
  return previous && (previous.provider !== next.provider || parseThinkingSuffixFromModelId(previous.model).baseId !== parseThinkingSuffixFromModelId(next.model).baseId)
    ? { from: { ...previous }, to: { ...next } } : undefined
}

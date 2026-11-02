import { upgradeSelection } from '../../shared/modelSelection'
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

/** A switch of provider or model; a change of reasoning level alone is none. */
export function contextHandoff(previous: Selection | undefined, next: Selection): ChatMessage['contextHandoff'] {
  if (!previous) return undefined
  const from = upgradeSelection({ ...previous })
  const to = upgradeSelection({ ...next })
  return from.provider !== to.provider || from.model !== to.model ? { from, to } : undefined
}

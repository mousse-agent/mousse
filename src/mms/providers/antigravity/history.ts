import type { AssistantMessage } from '@earendil-works/pi-ai'
import { nativeAgentAssistantMessage } from '../nativeAgentHistory'
export { nativeAgentHistory as antigravityHistory } from '../nativeAgentHistory'

export function antigravityAssistantMessage(text: string, model: string): AssistantMessage {
  return nativeAgentAssistantMessage(text, model, 'antigravity')
}

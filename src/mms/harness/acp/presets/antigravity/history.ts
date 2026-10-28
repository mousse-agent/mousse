import type { AssistantMessage } from '../../../../../shared/transcript'
import { nativeAgentAssistantMessage } from '../../../../providers/nativeAgentHistory'
export { nativeAgentHistory as antigravityHistory } from '../../../../providers/nativeAgentHistory'

export function antigravityAssistantMessage(text: string, model: string): AssistantMessage {
  return nativeAgentAssistantMessage(text, model, 'antigravity')
}

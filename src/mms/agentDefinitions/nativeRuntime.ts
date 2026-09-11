import type { Message } from '@earendil-works/pi-ai'
import type { AgentRuntimeResult, AgentRuntimeInput, AgentExecutionHistoryEntry, NativeAgentRuntimePort } from '../../shared/agents/execution'
import type { LlmClient } from '../orchestrator/LlmClient'
import { userMessage } from '../orchestrator/nativeContext'

function messageText(message: Message): string {
  const content = message.content
  if (typeof content === 'string') return content
  return content.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'toolCall') return `${block.name}(${JSON.stringify(block.arguments)})`
    if (block.type === 'image') return '[image]'
    return 'text' in block ? String(block.text) : ''
  }).join('')
}

function toHistory(messages: Message[]): AgentExecutionHistoryEntry[] {
  const history: AgentExecutionHistoryEntry[] = []
  for (const message of messages) {
    if (message.role === 'user') history.push({ role: 'user', content: messageText(message), at: new Date(message.timestamp).toISOString() })
    else if (message.role === 'assistant') history.push({ role: 'assistant', content: messageText(message), at: new Date(message.timestamp).toISOString() })
    else if (message.role === 'toolResult') history.push({ role: 'tool', content: messageText(message), name: message.toolName, at: new Date(message.timestamp).toISOString() })
  }
  return history
}

/** Adapter over the existing LlmClient/provider stream and tool loop. */
export function createNativeAgentRuntime(llm: LlmClient): NativeAgentRuntimePort {
  return {
    async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
      const modelRef = input.model.primary.ref
      const result = await llm.chat(
        [userMessage(input.userMessage)],
        undefined,
        {
          mode: 'agent',
          llmProvider: modelRef.providerId,
          model: modelRef.modelId,
          effort: modelRef.effort,
          projectPath: input.projectPath,
          threadId: input.threadId,
          signal: input.signal,
          trustedAgent: {
            systemPrompt: input.systemPrompt,
            grants: input.grants,
            budget: input.budget
          }
        }
      )
      return {
        text: result.text,
        history: toHistory(result.nativeMessages),
        usage: {
          inputTokens: result.usage.input,
          outputTokens: result.usage.output,
          totalTokens: result.totalTokensUsed,
          costUsd: result.usage.cost.total,
          elapsedMs: result.totalResponseTimeMs
        },
        limit: result.limitExceeded
      }
    }
  }
}

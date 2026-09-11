import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type {
  AgentExecutionBudget,
  AgentExecutionHistoryEntry,
  AgentRuntimeInput,
  AgentRuntimeResult,
  NativeAgentRuntimePort
} from '../../shared/agents/execution'
import type { AgentModelCapabilityProfile } from '../../shared/agents/types'
import type { LlmClient } from '../orchestrator/LlmClient'
import { userMessage } from '../orchestrator/nativeContext'
import {
  addAttemptUsage,
  canFallbackOrRetry,
  emptyAttemptUsage,
  errorText,
  isAbortError,
  orderedFallbackModels,
  remainingBudget,
  waitBackoff
} from './runtimeFallback'

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

function historyAssistant(content: string, at: string): AssistantMessage {
  const timestamp = Date.parse(at) || Date.now()
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    api: 'openai-completions',
    provider: 'history',
    model: 'history',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp
  }
}

function toMessages(conversation: AgentExecutionHistoryEntry[] | undefined, user: string): Message[] {
  const messages: Message[] = []
  for (const entry of conversation ?? []) {
    if (entry.role === 'user') messages.push(userMessage(entry.content))
    else if (entry.role === 'assistant') messages.push(historyAssistant(entry.content, entry.at))
    else if (entry.role === 'tool') messages.push(userMessage(`Previous tool ${entry.name ?? 'result'}: ${entry.content}`))
  }
  messages.push(userMessage(user))
  return messages
}

function exhaustedBeforeAttempt(
  remaining: AgentExecutionBudget,
  original: AgentExecutionBudget,
  used: ReturnType<typeof emptyAttemptUsage>
): AgentRuntimeResult['limit'] {
  if (original.maxElapsedMs > 0 && remaining.maxElapsedMs <= 0) return { kind: 'elapsed_ms', limit: original.maxElapsedMs }
  if (remaining.maxTurns <= 0) return { kind: 'turns', limit: original.maxTurns, actual: used.turns }
  if (original.maxInputTokens !== undefined && remaining.maxInputTokens! <= 0) return { kind: 'input_tokens', limit: original.maxInputTokens, actual: used.inputTokens }
  if (original.maxOutputTokens !== undefined && remaining.maxOutputTokens! <= 0) return { kind: 'output_tokens', limit: original.maxOutputTokens, actual: used.outputTokens }
  if (original.maxCostUsd !== undefined && remaining.maxCostUsd! <= 0) return { kind: 'cost_usd', limit: original.maxCostUsd, actual: used.costUsd }
  return undefined
}

/** Adapter over the existing LlmClient/provider stream and tool loop. Does not add a second agent loop. */
export function createNativeAgentRuntime(llm: LlmClient): NativeAgentRuntimePort {
  return {
    async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
      const started = Date.now()
      const effects = input.effects ?? { dispatched: false, attemptUsage: emptyAttemptUsage() }
      effects.dispatched = false
      effects.attemptUsage = emptyAttemptUsage()
      const policy = input.policy
      const fallbackPolicy = policy?.fallbacks ?? {
        enabled: input.fallbacks?.enabled === true,
        retryOn: input.fallbacks?.retryOn ?? [],
        allowHigherCost: input.fallbacks?.allowHigherCost === true,
        retryCount: 0,
        backoffMs: 0
      }
      const models = orderedFallbackModels(
        input.model.primary,
        policy?.fallbackModels ?? input.model.fallbacks,
        fallbackPolicy.enabled
      )
      const messages = toMessages(input.conversation, input.userMessage)
      let used = emptyAttemptUsage()
      let lastError: unknown
      let sameModelRetries = 0

      for (let index = 0; index < models.length; ) {
        if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if (effects.dispatched) break
        const model = models[index]!
        const elapsedMs = Date.now() - started
        const budget = remainingBudget(input.budget, used, elapsedMs)
        const exhausted = exhaustedBeforeAttempt(budget, input.budget, used)
        if (exhausted) {
          return {
            text: '',
            history: [],
            usage: {
              inputTokens: used.inputTokens,
              outputTokens: used.outputTokens,
              totalTokens: used.inputTokens + used.outputTokens,
              costUsd: used.costUsd,
              elapsedMs
            },
            limit: exhausted
          }
        }
        effects.attemptUsage = emptyAttemptUsage()
        try {
          const result = await llm.chat(
            structuredClone(messages),
            undefined,
            {
              mode: 'agent',
              llmProvider: model.ref.providerId,
              model: model.ref.modelId,
              effort: model.ref.effort,
              projectPath: input.projectPath,
              threadId: input.threadId,
              signal: input.signal,
              actor: {
                kind: 'agent',
                agentType: 'mousse',
                skillIds: input.grants.skills.map((grant) => grant.id),
                mcpServerIds: [...new Set(input.grants.mcpTools.map((grant) => grant.serverId))],
                mcpToolIds: input.grants.mcpTools.map((grant) => grant.id)
              },
              trustedAgent: {
                systemPrompt: input.systemPrompt,
                grants: input.grants,
                budget,
                policy,
                approveToolRequest: input.approveToolRequest,
                effects
              }
            }
          )
          used = addAttemptUsage(used, effects.attemptUsage)
          return {
            text: result.text,
            history: toHistory(result.nativeMessages),
            usage: {
              inputTokens: used.inputTokens,
              outputTokens: used.outputTokens,
              totalTokens: used.inputTokens + used.outputTokens,
              costUsd: used.costUsd,
              elapsedMs: Date.now() - started
            },
            limit: result.limitExceeded
          }
        } catch (error) {
          used = addAttemptUsage(used, effects.attemptUsage)
          lastError = error
          if (isAbortError(error, input.signal) || effects.dispatched) throw error
          const sameModel = sameModelRetries < fallbackPolicy.retryCount
          const retrySame = canFallbackOrRetry({
            error,
            signal: input.signal,
            dispatched: effects.dispatched,
            policy: fallbackPolicy,
            sameModel: true
          }) && sameModel
          if (retrySame) {
            sameModelRetries += 1
            await waitBackoff(fallbackPolicy.backoffMs, input.signal)
            continue
          }
          const nextIndex = index + 1
          const retryNext = nextIndex < models.length && canFallbackOrRetry({
            error,
            signal: input.signal,
            dispatched: effects.dispatched,
            policy: fallbackPolicy,
            sameModel: false
          })
          if (!retryNext) throw error
          sameModelRetries = 0
          index = nextIndex
          await waitBackoff(fallbackPolicy.backoffMs, input.signal)
          continue
        }
      }
      throw lastError instanceof Error ? lastError : new Error(errorText(lastError ?? 'Native runtime failed.'))
    }
  }
}

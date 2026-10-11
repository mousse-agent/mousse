import { realpath } from 'node:fs/promises'
import { NetError } from '../../../shared/net'
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRuntimeHostBindings
} from '../../../shared/agents/execution'
import type { ResolvedAgentDefinition } from '../../../shared/agents/types'
import type { ChatMessage } from '../../../shared/types'
import type { DispatchRuntime } from './types'

/** Concrete existing MMS execution lifecycle; host approval stays local to the target. */
export function mmsDispatchRuntime(options: {
  profileId: string
  resolveAgent(id: string): Promise<ResolvedAgentDefinition>
  orchestrator: {
    runAgentDefinition(request: AgentExecutionRequest): Promise<AgentExecutionResult>
    recordAgentDefinitionMessages(threadId: string, messages: ChatMessage[]): void
  }
  approveToolRequest: NonNullable<AgentRuntimeHostBindings['approveToolRequest']>
}): DispatchRuntime {
  return {
    resolveAgent: async (id) => {
      const definition = structuredClone(await options.resolveAgent(id))
      if (definition.profileId !== options.profileId || definition.runtimeKind !== 'mousse')
        throw new NetError('profile_unsupported')
      if (!['thread', 'off'].includes(definition.settings.memory.scope))
        throw new NetError('profile_unsupported')
      return definition
    },
    run: async (request) => {
      const canonical = await realpath(request.worktreePath)
      if (canonical !== request.worktreePath || request.definition.profileId !== options.profileId)
        throw new NetError('forbidden')
      options.orchestrator.recordAgentDefinitionMessages(request.threadId, [
        {
          id: `${request.executionId}:user`,
          role: 'user',
          content: request.prompt,
          timestamp: new Date().toISOString(),
          turnId: request.executionId
        }
      ])
      const result = await options.orchestrator.runAgentDefinition({
        profileId: options.profileId,
        resolved: request.definition,
        threadId: request.threadId,
        projectPath: canonical,
        input: request.prompt,
        runId: request.executionId,
        source: 'cli',
        signal: request.signal,
        budget: request.limits,
        host: {
          workspaceRoots: [canonical],
          dedicatedWorktreeRoot: canonical,
          approveToolRequest: options.approveToolRequest
        },
        context: {
          profileId: options.profileId,
          threadId: request.threadId,
          definitionId: request.definition.definitionId,
          history: [],
          attachments: [],
          selectedFiles: [],
          memory: { scope: request.definition.settings.memory.scope, entries: [] }
        }
      })
      const messages: ChatMessage[] = result.history
        .filter((entry) => entry.role !== 'user')
        .map((entry, index) => ({
          id: `${request.executionId}:history:${index}`,
          role: entry.role === 'assistant' ? 'assistant' : 'system',
          content: entry.name ? `${entry.name}: ${entry.content}` : entry.content,
          timestamp: entry.at,
          turnId: request.executionId
        }))
      if (!messages.length && result.text)
        messages.push({
          id: `${request.executionId}:assistant`,
          role: 'assistant',
          content: result.text,
          timestamp: new Date().toISOString(),
          turnId: request.executionId
        })
      options.orchestrator.recordAgentDefinitionMessages(request.threadId, messages)
      return result
    }
  }
}

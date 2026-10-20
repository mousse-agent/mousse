import { describe, expect, it } from 'vitest'
import { buildOrchestratorSystemPrompt, DELEGATION_PROMPT } from '../src/mms/orchestrator/systemPrompt'
import { MousseAgentService } from '../src/mms/agents/MousseAgentService'

describe('Mousse agent settings', () => {
  // spawn_agents (cliType assignments) is retired (SPEC §14.5); delegation is delegate_task.
  it('describes delegation as delegate_task child threads', () => {
    expect(DELEGATION_PROMPT).toContain('delegate_task')
    expect(DELEGATION_PROMPT).toContain('child thread')
    expect(buildOrchestratorSystemPrompt({ mode: 'agent' })).not.toContain('"cliType"')
  })

  it('defaults delegated children to the current connected model', () => {
    expect(DELEGATION_PROMPT).toContain('provider and model default to yours')
    expect(DELEGATION_PROMPT).toContain('explicitly requests an override')
    expect(DELEGATION_PROMPT).toContain('Never copy example or guessed model identifiers')
  })

  it('passes assignment overrides to the Mousse subagent LLM launch', async () => {
    let receivedOptions: Record<string, unknown> | undefined
    const llm = {
      chat: async (_history: unknown, _tools: unknown, options: Record<string, unknown>) => {
        receivedOptions = options
        return { text: 'Done.', aborted: false }
      }
    }
    const service = new MousseAgentService(llm as never, {
      completeAgent: async () => undefined
    })

    service.start('agent-1', 'Implement it', '/tmp/project', {
      provider: 'openai',
      model: 'gpt-5.6-terra-medium',
      effort: 'medium'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(receivedOptions).toMatchObject({
      mode: 'build',
      subagent: true,
      llmProvider: 'openai',
      model: 'gpt-5.6-terra-medium',
      effort: 'medium'
    })
    const safety = receivedOptions?.toolLoopSafety as {
      compactNativeMessages?: unknown
      compactionThresholdTokens?: unknown
      maxModelCalls?: unknown
      maxProcessedTokens?: unknown
    }
    expect(safety.compactNativeMessages).toBeTypeOf('function')
    expect(safety.compactionThresholdTokens).toBe(128_000)
    expect(safety.maxModelCalls).toBeUndefined()
    expect(safety.maxProcessedTokens).toBeUndefined()
  })

  it('publishes thinking and tool lifecycle messages for the subagent conversation', async () => {
    const llm = {
      chat: async (
        _history: unknown,
        onTool: (event: Record<string, unknown>) => void,
        _options: unknown,
        onThinking: (event: Record<string, unknown>) => void
      ) => {
        onThinking({ phase: 'start', content: '' })
        onThinking({ phase: 'delta', content: 'Inspecting the project' })
        onThinking({ phase: 'complete', content: 'Found the relevant file' })
        onTool({
          phase: 'start',
          callId: 'tool-1',
          kind: 'build_tool_call',
          title: 'Read file',
          summary: 'Reading app.ts',
          details: ['app.ts']
        })
        onTool({
          phase: 'complete',
          callId: 'tool-1',
          kind: 'build_tool_result',
          title: 'Read file',
          summary: 'Read app.ts',
          details: ['app.ts'],
          response: 'contents'
        })
        return {
          text: 'Done.',
          aborted: false,
          nativeMessages: [],
          modelName: 'test',
          totalResponseTimeMs: 1,
          totalTokensUsed: 1,
          tokensPerSecond: 1
        }
      }
    }
    const service = new MousseAgentService(llm as never, {
      completeAgent: async () => undefined
    })

    service.start('agent-events', 'Implement it', '/tmp/project')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = service.getMessages('agent-events')
    const thinking = messages.find((entry) => entry.kind === 'thinking')
    const tool = messages.find((entry) => entry.toolCall)
    expect(thinking?.thinking).toEqual({ content: 'Found the relevant file', status: 'complete' })
    expect(tool).toMatchObject({
      kind: 'mcp_tool_call',
      toolCall: { summary: 'Read app.ts', response: 'contents', status: 'complete' }
    })
  })
})

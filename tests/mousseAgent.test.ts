import { describe, expect, it } from 'vitest'
import { getDefaultSettings, AGENT_TYPES } from '../src/shared/settings'
import { buildOrchestratorSystemPrompt } from '../src/mms/orchestrator/systemPrompt'
import { MousseAgentService } from '../src/mms/agents/MousseAgentService'
import { validateSubagentAssignment } from '../src/mms/orchestrator/OrchestratorService'

describe('Mousse agent settings', () => {
  it('lists Mousse first and enabled by default', () => {
    expect(AGENT_TYPES[0]?.id).toBe('mousse')
    const settings = getDefaultSettings()
    expect(settings.agents.enabled.mousse).toBe(true)
    expect(settings.agents.headless.mousse).toBe(false)
  })

  it('mentions mousse as preferred spawn target in agent prompt', () => {
    const prompt = buildOrchestratorSystemPrompt({ mode: 'agent' })
    expect(prompt).toContain('"cliType": "mousse"')
    expect(prompt).toContain('preferred')
  })

  it('subagent prompt forbids spawn_agents and requires direct implementation', () => {
    const prompt = buildOrchestratorSystemPrompt({ mode: 'build', subagent: true })
    expect(prompt).toContain('Do NOT spawn agents')
    expect(prompt).toContain('task progress protocol')
    expect(prompt).toContain('exactly one')
    expect(prompt).not.toContain('"type": "spawn_agents"')
    expect(prompt).not.toContain('"type": "complete_task"')
  })

  it('defaults Mousse spawn actions to the current connected model', () => {
    const prompt = buildOrchestratorSystemPrompt({ mode: 'agent' })
    const spawnExample = prompt.match(/### Spawn agents[\s\S]*?```json([\s\S]*?)```/)?.[1]

    expect(spawnExample).toBeDefined()
    expect(spawnExample).toContain('"cliType": "mousse"')
    expect(spawnExample).not.toContain('"provider"')
    expect(spawnExample).not.toContain('"model"')
    expect(spawnExample).not.toContain('"effort"')
    expect(prompt).toContain('inherit the current connected provider')
    expect(prompt).toContain('unless the user explicitly requests an override')
    expect(prompt).toContain('Never copy example or guessed model identifiers')
  })

  it('validates subagent assignment overrides without changing legacy assignments', () => {
    expect(validateSubagentAssignment({ cliType: 'mousse', task: 'Implement the login form component' })).toBeUndefined()
    expect(validateSubagentAssignment({ cliType: 'mousse', task: 'Implement the login form component', provider: 'openai' }))
      .toContain('provider and model')
    expect(validateSubagentAssignment({ cliType: 'codex', task: 'Implement the login form component', effort: 'high' }))
      .toContain('only supported by Mousse')
    expect(validateSubagentAssignment({ cliType: 'mousse', task: 'Implement the login form component', effort: 'turbo' }))
      .toContain('Unknown subagent reasoning effort')
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
      spawnAgents: async () => [],
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
      effort: 'medium',
      toolLoopSafety: {
        compactionThresholdTokens: 128_000
      }
    })
    const safety = receivedOptions?.toolLoopSafety as {
      compactNativeMessages?: unknown
      maxModelCalls?: unknown
      maxProcessedTokens?: unknown
    }
    expect(safety.compactNativeMessages).toBeTypeOf('function')
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
      spawnAgents: async () => [],
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

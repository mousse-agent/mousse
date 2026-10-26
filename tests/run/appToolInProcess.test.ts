/**
 * The `trusted` in-process authority (PR 2 §2): a definition run (`trustedAgent`) with no run engine
 * turn and no `runId` runs its granted app tools through the registry, marks its effects, is refused
 * an ungranted one before any handler runs, and keeps its turn and tool-call budgets.
 */
import type { AssistantMessage, Message, Tool, ToolResultMessage } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { LlmClient, type LlmChatOptions, type StreamingLlmToolEvent, type TrustedAgentExecutionOptions } from '../../src/mms/orchestrator/LlmClient'
import { userMessage } from '../../src/mms/orchestrator/nativeContext'
import { createAppToolRegistry, type AppToolTurn } from '../../src/mms/run/mcp/appTools'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import type { AgentExecutionBudget, AgentRuntimeEffectTracker } from '../../src/shared/agents/execution'
import type { EffectiveAgentGrants } from '../../src/shared/agents/types'
import { getDefaultSettings } from '../../src/shared/settings'
import { appTurn, fakeAppToolHost } from './appToolsFixture'

const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

function response(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'anthropic-model',
    content,
    stopReason,
    timestamp: Date.now(),
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: emptyCost }
  } as AssistantMessage
}

const toolUse = (...calls: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>): AssistantMessage =>
  response(calls.map((call, index) => ({ type: 'toolCall', id: call.id ?? `call-${index + 1}`, name: call.name, arguments: call.arguments ?? {} })), 'toolUse')
const done = (): AssistantMessage => response([{ type: 'text', text: 'done' }], 'stop')

function harness(outputs: AssistantMessage[], extra: { onPresentPlan?: (payload: { title: string; markdown: string }, threadId?: string) => void; questions?: unknown } = {}) {
  const settings = getDefaultSettings()
  settings.provider = { llmProvider: 'anthropic', model: 'claude-test' }
  const script = [...outputs]
  const requests: Tool[][] = []
  const models = {
    getModel: (provider: string, id: string) => ({
      id,
      name: id,
      api: 'anthropic-messages',
      provider,
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      cost: emptyCost,
      contextWindow: 128_000,
      maxTokens: 8_000
    }),
    getAuth: async () => ({ apiKey: 'test' }),
    streamSimple: (_model: unknown, context: { tools?: Tool[] }) => {
      requests.push([...(context.tools ?? [])])
      const message = script.shift() ?? done()
      return { async *[Symbol.asyncIterator]() {}, result: async () => message }
    }
  }
  const tasks = new TaskQueue()
  const client = new LlmClient(
    { get: () => settings } as never,
    { has: () => true, credentials: { listProviderIds: () => ['anthropic'] }, models } as never,
    { getEnabledTools: async () => [] } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    tasks,
    undefined,
    extra.onPresentPlan,
    extra.questions ? { questions: extra.questions as never } : undefined
  )
  const events: StreamingLlmToolEvent[] = []
  const chat = (options: LlmChatOptions) => client.chat([userMessage('go')], (event) => events.push(event), { mode: 'agent', threadId: 'thread-1', ...options })
  return { chat, tasks, requests, events }
}

function grants(...builtinTools: string[]): EffectiveAgentGrants {
  return { skills: [], mcpTools: [], builtinTools: builtinTools.map((id) => ({ id, source: 'explicit' })), denied: [] }
}

function trusted(input: { grants: EffectiveAgentGrants; budget?: Partial<AgentExecutionBudget>; policy?: unknown }): TrustedAgentExecutionOptions & { effects: AgentRuntimeEffectTracker } {
  return {
    systemPrompt: 'You are a definition.',
    grants: input.grants,
    // maxElapsedMs 0: no elapsed-time deadline, so nothing here depends on the clock.
    budget: { maxTurns: 10, maxToolCalls: 10, maxElapsedMs: 0, ...input.budget },
    ...(input.policy ? { policy: input.policy as never } : {}),
    effects: { dispatched: false, attemptUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, toolCalls: 0 } }
  }
}

function toolResults(messages: Message[]): ToolResultMessage[] {
  return messages.filter((message): message is ToolResultMessage => message.role === 'toolResult')
}

const text = (message: ToolResultMessage): string => message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')

describe('a trusted definition run calls app tools in process', () => {
  it('runs a granted app tool with no run engine and no runId, and marks the effect dispatched', async () => {
    const h = harness([toolUse({ name: 'create_task', arguments: { description: 'From a definition' } }), done()])
    const agent = trusted({ grants: grants('list_tasks', 'create_task', 'present_plan') })
    const result = await h.chat({ trustedAgent: agent })
    // Only the granted tools are offered, in the legacy order.
    expect(h.requests[0]!.map((tool) => tool.name)).toEqual(['present_plan', 'list_tasks', 'create_task'])
    expect(h.tasks.list().map((task) => task.description)).toEqual(['From a definition'])
    const [toolResult] = toolResults(result.nativeMessages)
    expect(toolResult!.isError).toBe(false)
    expect(agent.effects.dispatched).toBe(true)
    expect(h.events.map((event) => [event.phase, event.title])).toEqual([['start', 'Task tool create_task'], ['complete', 'Task tool create_task']])
    expect(result.limitExceeded).toBeUndefined()
  })

  it('a read-only granted app tool (list_tasks) also runs and marks the effect, as before', async () => {
    const h = harness([toolUse({ name: 'list_tasks' }), done()])
    const agent = trusted({ grants: grants('list_tasks') })
    const result = await h.chat({ trustedAgent: agent })
    expect(text(toolResults(result.nativeMessages)[0]!)).toBe('[]')
    expect(agent.effects.dispatched).toBe(true)
  })

  it('refuses an ungranted app tool with the not-granted text; its handler never runs', async () => {
    const onPresentPlan = vi.fn()
    const h = harness([
      toolUse({ name: 'present_plan', arguments: { title: 'T', markdown: 'plan' } }, { id: 'call-2', name: 'create_task', arguments: { description: 'x' } }),
      done()
    ], { onPresentPlan })
    const createTask = vi.spyOn(h.tasks, 'createTask')
    const agent = trusted({ grants: grants('list_tasks') })
    const result = await h.chat({ trustedAgent: agent })
    expect(h.requests[0]!.map((tool) => tool.name)).toEqual(['list_tasks'])
    expect(toolResults(result.nativeMessages).map((message) => [message.toolName, message.isError, text(message)])).toEqual([
      ['present_plan', true, 'Tool "present_plan" is not granted to this agent definition.'],
      ['create_task', true, 'Tool "create_task" is not granted to this agent definition.']
    ])
    expect(onPresentPlan).not.toHaveBeenCalled()
    expect(createTask).not.toHaveBeenCalled()
    expect(h.tasks.list()).toEqual([])
    expect(agent.effects.dispatched).toBe(false)
    expect(h.events).toEqual([])
  })

  it('applies the definition policy before dispatch: ask_user under approval.askUser false never asks', async () => {
    const questions = { requestAnswers: vi.fn(async () => ({ q1: 'a' })), dismissAllForThread: vi.fn() }
    const h = harness([
      toolUse({ name: 'ask_user', arguments: { questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }] } }),
      done()
    ], { questions })
    const policy = { approval: { askUser: false }, workspace: { mode: 'read_write' }, script: { enabled: false, allowFilesystem: false } }
    const agent = trusted({ grants: grants('ask_user'), policy })
    const result = await h.chat({ trustedAgent: agent })
    expect(h.requests[0]!.map((tool) => tool.name)).toEqual([])
    const [toolResult] = toolResults(result.nativeMessages)
    expect(toolResult!.isError).toBe(true)
    expect(text(toolResult!)).toBe('ask_user is disabled by /settings/approval/askUser.')
    expect(questions.requestAnswers).not.toHaveBeenCalled()
    expect(agent.effects.dispatched).toBe(false)
  })
})

describe('a trusted definition run keeps its budgets with app tools in the batch', () => {
  it('maxTurns stops before the next model request', async () => {
    const h = harness([toolUse({ name: 'create_task', arguments: { description: 'one' } }), toolUse({ name: 'list_tasks' }), done()])
    const agent = trusted({ grants: grants('list_tasks', 'create_task'), budget: { maxTurns: 1 } })
    const result = await h.chat({ trustedAgent: agent })
    expect(h.requests).toHaveLength(1)
    expect(h.tasks.list()).toHaveLength(1)
    expect(result.limitExceeded).toEqual({ kind: 'turns', limit: 1, actual: 1 })
  })

  it('maxToolCalls stops before the next tool; the rest of the batch is answered as skipped', async () => {
    const h = harness([
      toolUse(
        { id: 'call-1', name: 'create_task', arguments: { description: 'first' } },
        { id: 'call-2', name: 'create_task', arguments: { description: 'second' } },
        { id: 'call-3', name: 'list_tasks' }
      ),
      done()
    ])
    const agent = trusted({ grants: grants('list_tasks', 'create_task'), budget: { maxToolCalls: 1 } })
    const result = await h.chat({ trustedAgent: agent })
    expect(h.tasks.list().map((task) => task.description)).toEqual(['first'])
    expect(h.requests).toHaveLength(1)
    expect(result.limitExceeded).toEqual({ kind: 'tool_calls', limit: 1, actual: 1 })
    expect(toolResults(result.nativeMessages).map((message) => [message.toolCallId, message.isError, text(message).startsWith('Tool call budget exhausted')])).toEqual([
      ['call-1', false, false],
      ['call-2', true, true],
      ['call-3', true, true]
    ])
    expect(agent.effects.attemptUsage.toolCalls).toBe(1)
  })
})

describe('the run authority through the pi loop', () => {
  it('an app tool call after the run stopped being the thread\'s active run is refused before its handler', async () => {
    let active = true
    const h = harness([
      toolUse({ id: 'call-1', name: 'create_task', arguments: { description: 'while active' } }),
      toolUse({ id: 'call-2', name: 'create_task', arguments: { description: 'after the run ended' } })
    ])
    // The second request is made after the host says the run is no longer active.
    const result = await h.chat({
      runId: 'run-1',
      runActive: () => {
        const now = active
        active = false
        return now
      }
    })
    expect(h.tasks.list().map((task) => task.description)).toEqual(['while active'])
    const results = toolResults(result.nativeMessages)
    expect(results.map((message) => [message.toolCallId, message.isError])).toEqual([['call-1', false], ['call-2', true]])
    expect(text(results[1])).toContain('Run run-1 is no longer the active run of thread thread-1.')
  })
})

describe('callInProcess authorities', () => {
  it('trusted runs whatever run the thread has; run refuses when another run is active; neither writes a ledger row', async () => {
    const fixture = fakeAppToolHost()
    const toolLedger = vi.fn()
    const { registry } = createAppToolRegistry({
      host: { ...fixture.host, toolLedger },
      options: { activeRunId: () => 'run-other' }
    })
    const turn = { ...appTurn({ threadId: 'thread-1', runId: '', trusted: true }), turnToken: '' } as AppToolTurn
    const call = { turn, toolCallId: 'call-1', signal: new AbortController().signal }
    const trustedOutcome = await registry.callInProcess('create_task', { description: 'trusted' }, { kind: 'trusted' }, call)
    expect(trustedOutcome.isError).toBe(false)
    const runOutcome = await registry.callInProcess('create_task', { description: 'stale' }, { kind: 'run', runId: 'run-mine' }, call)
    expect(runOutcome.isError).toBe(true)
    expect(runOutcome.text).toContain('Run run-mine is no longer the active run of thread thread-1.')
    expect(fixture.tasks.list().map((task) => task.description)).toEqual(['trusted'])
    expect(toolLedger).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmToolEvent, StreamingLlmToolEvent } from '../src/mms/harness/turnEvents'
import { executeDelegationTool, type DelegationToolHost } from '../src/mms/run/mcp/appTools/delegation'
import { runtimeToolEvent } from '../src/mms/run/adapters/shared/promptRuntime'
import { TranscriptAssembler, type TranscriptHooks, type TranscriptStreamState } from '../src/mms/run/adapters/shared/TranscriptAssembler'
import { mousseToUIMessages } from '../src/renderer/chat/adapters/mousseToUI'
import { collectSubagentCalls, joinSubagentCards } from '../src/renderer/chat/adapters/subagentCards'
import { recordSubagentCall, toolResultText } from '../src/shared/subagentTools'
import type { SubagentSummary, SubagentTaskSummary } from '../src/shared/subagents'
import type { ChatMessage } from '../src/shared/types'

describe('recordSubagentCall', () => {
  it('keeps only the fields that name the subagent and the task, clipped', () => {
    const record = recordSubagentCall(
      'mcp__mousse__delegate_task',
      { title: `  API   reviewer ${'x'.repeat(400)}`, prompt: 'SECRET PROMPT', workspace: 'shared', model: 'm' },
      { text: JSON.stringify({ delegationId: 'd1', childThreadId: 't1', childRunId: 'r1', title: 'API reviewer', note: 'Started. LONG NOTE', status: 'started' }) }
    )!
    expect(record.failed).toBe(false)
    expect((record.input.title as string).length).toBe(200)
    expect(record.input).toEqual({ recordVersion: 1, title: expect.any(String) })
    expect(JSON.parse(record.response!)).toEqual({ delegationId: 'd1', childThreadId: 't1', title: 'API reviewer', status: 'started' })
    expect(JSON.stringify(record)).not.toMatch(/SECRET PROMPT|LONG NOTE|childRunId/)
  })

  it('keeps the code and message of a refusal, and the message of an error', () => {
    const refused = recordSubagentCall('delegate_task', { title: 'A' }, { text: JSON.stringify({ started: false, code: 'title_taken', message: 'taken', existing: [1, 2, 3] }) })!
    expect(JSON.parse(refused.response!)).toEqual({ code: 'title_taken', started: false, message: 'taken' })
    const errored = recordSubagentCall('task_cancel', { subagent: 'A' }, { text: 'Unknown delegation d9', isError: true })!
    expect(errored).toMatchObject({ failed: true, input: { subagent: 'A' } })
    expect(JSON.parse(errored.response!)).toEqual({ message: 'Unknown delegation d9' })
  })

  it('records nothing for another tool, another server or a result that is not JSON', () => {
    expect(recordSubagentCall('Read', { file_path: 'a' }, { text: 'x' })).toBeNull()
    expect(recordSubagentCall('mcp__other__delegate_task', { title: 'A' }, {})).toBeNull()
    expect(recordSubagentCall('create_subagents', { agents: [] }, {})).toBeNull()
    expect(recordSubagentCall('delegate_task', { title: 'A' }, { text: 'plain words' })!.response).toBeUndefined()
  })

  it('reads a result given as a string or as MCP content blocks', () => {
    expect(toolResultText('abc')).toBe('abc')
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(toolResultText(undefined)).toBeUndefined()
  })
})

type Call = Parameters<typeof executeDelegationTool>[1]
const call = (name: string, args: Record<string, unknown>, id = 'call-1'): Call => ({ type: 'toolCall', id, name, arguments: args }) as Call

describe('the pi loop writes subagent tools to the timeline', () => {
  const host = (overrides: Partial<DelegationToolHost> = {}): DelegationToolHost =>
    ({
      delegateTask: async () => ({ delegationId: 'd1', childThreadId: 't1', childRunId: 'r1', title: 'API reviewer', note: 'Started.' }),
      listSubagents: () => [],
      ...overrides
    }) as unknown as DelegationToolHost

  it('emits a start with the title and a complete with the delegation id, as an MCP call of the Mousse server', async () => {
    const events: StreamingLlmToolEvent[] = []
    const log: LlmToolEvent[] = []
    const result = await executeDelegationTool(host(), call('delegate_task', { prompt: 'SECRET', title: 'API reviewer', workspace: 'shared' }), log, (event) => events.push(event))
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ delegationId: 'd1' })
    expect(events.map((event) => [event.phase, event.callId, event.kind, event.details])).toEqual([
      ['start', 'call-1', 'mcp_tool_call', ['Server: mousse', 'Tool: delegate_task']],
      ['complete', 'call-1', 'mcp_tool_result', ['Server: mousse', 'Tool: delegate_task']]
    ])
    expect(events[0]!.input).toEqual({ recordVersion: 1, title: 'API reviewer' })
    expect(JSON.parse(events[1]!.response!)).toEqual({ delegationId: 'd1', childThreadId: 't1', title: 'API reviewer' })
    expect(JSON.stringify(events)).not.toContain('SECRET')
    expect(log).toHaveLength(2)
  })

  it('marks the row failed and still throws, so the caller makes the usual error result', async () => {
    const events: StreamingLlmToolEvent[] = []
    await expect(
      executeDelegationTool(host({ delegateTask: async () => { throw new Error('boom') } }), call('delegate_task', { prompt: 'x', title: 'A', workspace: 'shared' }), [], (event) => events.push(event))
    ).rejects.toThrow('boom')
    expect(events[1]).toMatchObject({ phase: 'complete', summary: 'The MCP tool returned an error.' })
    expect(JSON.parse(events[1]!.response!)).toEqual({ message: 'boom' })
  })

  it('writes the batch call as a plain row with no record', async () => {
    const events: StreamingLlmToolEvent[] = []
    const batch = host({ named: { createBatch: async () => ({ results: [] }) } } as never)
    await executeDelegationTool(batch, call('create_subagents', { agents: [{ name: 'a', task: 'SECRET' }] }), [], (event) => events.push(event))
    expect(events[0]!.input).toBeUndefined()
    expect(events[1]!.response).toBeUndefined()
  })
})

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 25, 12, 0, seconds)).toISOString()

const task = (delegationId: string, seconds: number): SubagentTaskSummary => ({
  delegationId,
  childRunId: `run-${delegationId}`,
  outcome: 'running',
  unread: false,
  continued: false,
  createdAt: at(seconds),
  completedAt: null
})

const subagent = (id: string, title: string, tasks: SubagentTaskSummary[]): SubagentSummary => ({
  childThreadId: id,
  title,
  activity: 'working',
  state: 'working',
  latestDelegationId: tasks.at(-1)!.delegationId,
  unread: false,
  provider: null,
  model: null,
  workspace: 'shared',
  role: null,
  createdAt: tasks[0]!.createdAt,
  updatedAt: tasks.at(-1)!.createdAt,
  waitingOn: [],
  tasks
})

/** Feeds tool events through the transcript assembler the way an adapter's sink does. */
function assemble(events: StreamingLlmToolEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  const state: TranscriptStreamState = { activeAssistantMessageId: null, activeThinkingMessageId: null, activeToolCallMessageIds: new Map() }
  const hooks: TranscriptHooks = {
    getMessage: (id) => messages.find((message) => message.id === id),
    addMessage: (message) => void messages.push(message),
    updateMessage: (message) => void (messages[messages.findIndex((entry) => entry.id === message.id)] = message),
    removeMessage: () => undefined,
    emitAdded: () => undefined,
    emitUpdated: () => undefined,
    persist: () => undefined,
    setPhase: () => undefined
  }
  const assembler = new TranscriptAssembler(hooks, state)
  for (const event of events) assembler.tool(event)
  return messages
}

describe('two subagent calls started in the same instant', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(at(5)))
  })
  afterEach(() => vi.useRealTimers())

  // Both calls start at once and the daemon happens to record the second task first.
  const subagents = [subagent('t-docs', 'Docs', [task('d-docs', 6)]), subagent('t-api', 'API reviewer', [task('d-api', 7)])]
  const claude = (id: string, title: string, delegationId: string, childThreadId: string): StreamingLlmToolEvent[] => [
    runtimeToolEvent({ phase: 'start', callId: id, title: 'mcp__mousse__delegate_task', toolName: 'mcp__mousse__delegate_task' }),
    runtimeToolEvent({
      phase: 'complete',
      callId: id,
      title: 'mcp__mousse__delegate_task',
      record: { input: { title }, response: JSON.stringify({ delegationId, childThreadId, title }), failed: false }
    })
  ]

  it('join exactly, for Claude and Codex rows, by the delegation id the row recorded', () => {
    const messages = assemble([
      runtimeToolEvent({ phase: 'start', callId: 'first', title: 'mcp__mousse__delegate_task', toolName: 'mcp__mousse__delegate_task' }),
      runtimeToolEvent({ phase: 'start', callId: 'second', title: 'mcp__mousse__delegate_task', toolName: 'mcp__mousse__delegate_task' }),
      runtimeToolEvent({ phase: 'complete', callId: 'first', title: 'mcp__mousse__delegate_task', record: { input: { title: 'API reviewer' }, response: JSON.stringify({ delegationId: 'd-api', childThreadId: 't-api' }), failed: false } }),
      runtimeToolEvent({ phase: 'complete', callId: 'second', title: 'mcp__mousse__delegate_task', record: { input: { title: 'Docs' }, response: JSON.stringify({ delegationId: 'd-docs', childThreadId: 't-docs' }), failed: false } })
    ])
    const calls = collectSubagentCalls(mousseToUIMessages(messages))
    expect(calls).toHaveLength(2)
    expect(new Set(calls.map((entry) => entry.startedAt)).size).toBe(1)
    const cards = joinSubagentCards(calls, subagents, { loaded: true })
    const ids = messages.map((message) => message.id)
    // The first call is the API reviewer even though its task was recorded after the Docs task.
    expect(cards.get(ids[0]!)).toMatchObject({ delegationId: 'd-api', title: 'API reviewer' })
    expect(cards.get(ids[1]!)).toMatchObject({ delegationId: 'd-docs', title: 'Docs' })
  })

  it('join exactly by title when only the input was recorded', () => {
    const messages = assemble([
      ...claude('a', 'API reviewer', 'x', 'x').map((event) => ({ ...event, response: undefined })),
      ...claude('b', 'Docs', 'x', 'x').map((event) => ({ ...event, response: undefined }))
    ])
    const calls = collectSubagentCalls(mousseToUIMessages(messages))
    expect(calls.map((entry) => entry.input)).toEqual([{ title: 'API reviewer' }, { title: 'Docs' }])
    const cards = joinSubagentCards(calls, subagents, { loaded: true })
    expect([...cards.values()].map((card) => card.delegationId)).toEqual(['d-api', 'd-docs'])
  })

  it('never show each other`s child while live Claude calls start, learn their input and return', () => {
    const name = 'mcp__mousse__delegate_task'
    const event = (phase: 'start' | 'complete', callId: string, record?: ReturnType<typeof recordSubagentCall>) =>
      runtimeToolEvent({ phase, callId, title: name, toolName: phase === 'start' ? name : undefined, ...(record ? { record } : {}) })
    const events: StreamingLlmToolEvent[] = []
    const messages: ChatMessage[] = []
    const state: TranscriptStreamState = { activeAssistantMessageId: null, activeThinkingMessageId: null, activeToolCallMessageIds: new Map() }
    const assembler = new TranscriptAssembler(
      {
        getMessage: (id) => messages.find((message) => message.id === id),
        addMessage: (message) => void messages.push(message),
        updateMessage: (message) => void (messages[messages.findIndex((entry) => entry.id === message.id)] = message),
        removeMessage: () => undefined,
        emitAdded: () => undefined,
        emitUpdated: () => undefined,
        persist: () => undefined,
        setPhase: () => undefined
      },
      state
    )
    const feed = (next: StreamingLlmToolEvent) => {
      events.push(next)
      assembler.tool(next)
    }
    const children = () => {
      const cards = joinSubagentCards(collectSubagentCalls(mousseToUIMessages(messages)), subagents, { loaded: true })
      return messages.map((message) => cards.get(message.id))
    }
    const api = { title: 'API reviewer' }
    const docs = { title: 'Docs' }

    // Both calls start; the model's arguments are still streaming.
    feed(event('start', 'first', recordSubagentCall(name, undefined, {})))
    feed(event('start', 'second', recordSubagentCall(name, undefined, {})))
    expect(messages).toHaveLength(2)
    expect(children().map((card) => [card?.pending, card?.childThreadId])).toEqual([[true, null], [true, null]])

    // The arguments are complete: each row names its subagent, and no row is added.
    feed(event('start', 'first', recordSubagentCall(name, { ...api, prompt: 'p' }, {})))
    feed(event('start', 'second', recordSubagentCall(name, { ...docs, prompt: 'p' }, {})))
    expect(messages).toHaveLength(2)
    expect(children().map((card) => card?.childThreadId)).toEqual(['t-api', 't-docs'])

    // Results arrive, the second call's first.
    feed(event('complete', 'second', recordSubagentCall(name, docs, { text: JSON.stringify({ delegationId: 'd-docs', childThreadId: 't-docs' }) })))
    expect(children().map((card) => card?.childThreadId)).toEqual(['t-api', 't-docs'])
    feed(event('complete', 'first', recordSubagentCall(name, api, { text: JSON.stringify({ delegationId: 'd-api', childThreadId: 't-api' }) })))
    expect(children().map((card) => card?.childThreadId)).toEqual(['t-api', 't-docs'])
    expect(messages.map((message) => message.toolCall?.status)).toEqual(['complete', 'complete'])
    expect(messages[0]!.toolCall!.input).toEqual({ recordVersion: 1, title: 'API reviewer' })
  })

  it('keep the pi row shape: input and result recorded through the same row type', async () => {
    const events: StreamingLlmToolEvent[] = []
    const piHost = (title: string, id: string) => ({ delegateTask: async () => ({ delegationId: id, childThreadId: `t-${id}`, title }) }) as unknown as DelegationToolHost
    await Promise.all([
      executeDelegationTool(piHost('API reviewer', 'd-api'), call('delegate_task', { prompt: 'p', title: 'API reviewer', workspace: 'shared' }, 'pi-1'), [], (event) => events.push(event)),
      executeDelegationTool(piHost('Docs', 'd-docs'), call('delegate_task', { prompt: 'p', title: 'Docs', workspace: 'shared' }, 'pi-2'), [], (event) => events.push(event))
    ])
    const messages = assemble(events)
    const calls = collectSubagentCalls(mousseToUIMessages(messages))
    expect(calls).toHaveLength(2)
    const cards = joinSubagentCards(calls, subagents, { loaded: true })
    expect([...cards.values()].map((card) => card.delegationId).sort()).toEqual(['d-api', 'd-docs'])
    for (const card of cards.values()) expect(card.childThreadId).toBe(subagents.find((entry) => entry.tasks[0]!.delegationId === card.delegationId)!.childThreadId)
  })

  it('a failed Claude call keeps its raw row with the reason', () => {
    const messages = assemble([
      runtimeToolEvent({ phase: 'start', callId: 'bad', title: 'mcp__mousse__delegate_task', toolName: 'mcp__mousse__delegate_task' }),
      runtimeToolEvent({ phase: 'complete', callId: 'bad', title: 'mcp__mousse__delegate_task', record: { input: { title: 'Docs' }, response: JSON.stringify({ started: false, code: 'title_taken', message: 'taken' }), failed: false } })
    ])
    const [call] = collectSubagentCalls(mousseToUIMessages(messages))
    expect(call!.failed).toBe(true)
    expect(joinSubagentCards([call!], subagents, { loaded: true }).size).toBe(0)
  })
})

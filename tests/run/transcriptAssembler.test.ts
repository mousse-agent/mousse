import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TranscriptAssembler,
  type TranscriptHooks,
  type TranscriptStreamState,
  type TranscriptTextMode
} from '../../src/mms/run/adapters/shared/TranscriptAssembler'
import { ACTIVITY_CHECKPOINT_MS, type AgentActivityItem } from '../../src/shared/agentActivity'
import type { StreamingLlmToolEvent } from '../../src/mms/orchestrator/LlmClient'
import type { ChatMessage, TurnPhase } from '../../src/shared/types'

function harness(mode: TranscriptTextMode = 'replace') {
  const messages: ChatMessage[] = []
  const log: string[] = []
  const phases: Array<{ phase: TurnPhase; activeMessageId?: string }> = []
  const state: TranscriptStreamState = {
    activeAssistantMessageId: null,
    activeThinkingMessageId: null,
    activeToolCallMessageIds: new Map(),
    callToMessage: new Map(),
    lastCompletedAssistantMessageId: null,
    lastCompletedAssistantContent: ''
  }
  const hooks: TranscriptHooks = {
    getMessage: (id) => messages.find((message) => message.id === id),
    addMessage: (message) => {
      messages.push(message)
    },
    updateMessage: (message) => {
      const index = messages.findIndex((entry) => entry.id === message.id)
      if (index !== -1) messages[index] = message
    },
    removeMessage: (id) => {
      const index = messages.findIndex((entry) => entry.id === id)
      if (index !== -1) messages.splice(index, 1)
      log.push(`remove:${id}`)
    },
    emitAdded: (message) => log.push(`added:${message.kind ?? message.role}`),
    emitUpdated: (message) => log.push(`updated:${message.kind ?? message.role}`),
    persist: (force) => log.push(force ? 'persist!' : 'persist'),
    currentRunId: () => 'run-1',
    setPhase: (phase, patch) => {
      phases.push({ phase, ...patch })
    }
  }
  return { messages, log, phases, state, assembler: new TranscriptAssembler(hooks, state, mode) }
}

describe('TranscriptAssembler', () => {
  it('streams text start, deltas and complete into one assistant reply', () => {
    const { messages, log, phases, state, assembler } = harness()
    assembler.text({ phase: 'start', content: '', contentIndex: 0 })
    const id = state.activeAssistantMessageId!
    expect(messages).toEqual([expect.objectContaining({ id, role: 'assistant', content: '', streaming: true })])
    expect(phases).toEqual([{ phase: 'streaming', activeMessageId: id }])

    assembler.text({ phase: 'start', content: '', contentIndex: 0 })
    assembler.text({ phase: 'delta', content: 'Hel', contentIndex: 0 })
    assembler.text({ phase: 'delta', content: 'Hello', contentIndex: 0 })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ content: 'Hello', streaming: true })

    assembler.text({ phase: 'complete', content: 'Hello there', contentIndex: 0 })
    expect(messages[0]).toMatchObject({ content: 'Hello there', streaming: false })
    expect(state).toMatchObject({
      activeAssistantMessageId: null,
      lastCompletedAssistantMessageId: id,
      lastCompletedAssistantContent: 'Hello there'
    })
    // Streaming updates are debounced; the completed reply is written at once.
    expect(log).toEqual([
      'added:assistant',
      'persist',
      'updated:assistant',
      'persist',
      'updated:assistant',
      'persist',
      'updated:assistant',
      'persist!'
    ])
    // Deltas without an open reply are ignored.
    assembler.text({ phase: 'delta', content: 'stray', contentIndex: 0 })
    expect(messages).toHaveLength(1)
  })

  it('appends deltas to completed segments in append mode and keeps the reply open', () => {
    const { messages, state, assembler } = harness('append')
    assembler.text({ phase: 'start', content: '', contentIndex: 0 })
    assembler.text({ phase: 'delta', content: 'First', contentIndex: 0 })
    assembler.text({ phase: 'complete', content: 'First.', contentIndex: 0 })
    assembler.text({ phase: 'delta', content: ' Second', contentIndex: 1 })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ content: 'First. Second', streaming: true })
    expect(state.activeAssistantMessageId).toBe(messages[0].id)
    expect(state.assistantStreamBase).toBe('First.')
  })

  it('runs the thinking lifecycle on its own message', () => {
    const { messages, log, phases, state, assembler } = harness()
    assembler.thinking({ phase: 'start', content: '' })
    expect(phases).toEqual([{ phase: 'thinking' }])
    assembler.thinking({ phase: 'delta', content: 'Consider' })
    expect(messages[0]).toMatchObject({
      role: 'system',
      kind: 'thinking',
      thinking: { content: 'Consider', status: 'processing' }
    })
    assembler.thinking({ phase: 'complete', content: 'Considered' })
    expect(messages[0].thinking).toEqual({ content: 'Considered', status: 'complete' })
    expect(state.activeThinkingMessageId).toBeNull()
    expect(log.at(-1)).toBe('persist!')
    assembler.thinking({ phase: 'delta', content: 'ignored' })
    expect(messages[0].thinking?.content).toBe('Considered')
  })

  it('tracks tool calls by call id, folds build tools into MCP calls and falls back the phase', () => {
    const { messages, phases, state, assembler } = harness()
    assembler.tool({
      kind: 'build_tool_call',
      phase: 'start',
      callId: 'call-1',
      title: 'Write',
      summary: 'write file',
      details: []
    })
    expect(messages[0]).toMatchObject({
      kind: 'mcp_tool_call',
      toolCall: { title: 'Write', status: 'processing' }
    })
    expect(state.activeToolCallMessageIds.get('call-1')).toBe(messages[0].id)
    expect(phases.at(-1)).toEqual({ phase: 'tool_running' })

    assembler.tool({
      kind: 'build_tool_call',
      phase: 'complete',
      callId: 'call-1',
      title: 'Write',
      summary: 'wrote file',
      details: ['ok']
    })
    expect(messages).toHaveLength(1)
    expect(messages[0].toolCall).toMatchObject({ summary: 'wrote file', details: ['ok'], status: 'complete' })
    expect(state.activeToolCallMessageIds.size).toBe(0)
    // No reply open: back to thinking.
    expect(phases.at(-1)).toEqual({ phase: 'thinking' })

    assembler.text({ phase: 'start', content: '', contentIndex: 0 })
    assembler.tool({ kind: 'mcp_tool_call', phase: 'start', callId: 'call-2', title: 'Read', summary: '', details: [] })
    assembler.tool({ kind: 'mcp_tool_call', phase: 'complete', callId: 'call-2', title: 'Read', summary: '', details: [] })
    // A reply is open: back to streaming.
    expect(phases.at(-1)).toEqual({ phase: 'streaming' })

    assembler.tool({ kind: 'build_tool_result', phase: 'start', title: 'Result', summary: 'r', details: [] })
    expect(messages.at(-1)).toMatchObject({ kind: 'mcp_tool_result', toolCall: { status: 'complete' } })
  })

  it('marks the tool phase blocked on wait only while every running call is a wait tool', () => {
    const { phases, assembler } = harness()
    const call = (phase: 'start' | 'complete', callId: string, title: string) =>
      assembler.tool({ kind: 'mcp_tool_call', phase, callId, title, summary: title, details: [] })

    // A wait tool alone blocks the turn on waiting.
    call('start', 'wait-1', 'TaskOutput')
    expect(phases.at(-1)).toEqual({ phase: 'tool_running', blockedOnWait: true })

    // A command alongside it is real work.
    call('start', 'bash-1', 'Bash')
    expect(phases.at(-1)).toEqual({ phase: 'tool_running' })

    // Once the command finishes only the wait remains.
    call('complete', 'bash-1', 'Bash')
    expect(phases.at(-1)).toEqual({ phase: 'tool_running', blockedOnWait: true })

    const count = phases.length
    call('complete', 'wait-1', 'TaskOutput')
    expect(phases.length).toBe(count + 1)
    expect(phases.at(-1)).toEqual({ phase: 'thinking' })
  })

  it('reads the pi loop tool name from the call details', () => {
    const { phases, assembler } = harness()
    assembler.tool({ kind: 'mcp_tool_call', phase: 'start', callId: 'c', title: 'Waiting', summary: '', details: ['Tool: TaskOutput'] })
    expect(phases.at(-1)).toEqual({ phase: 'tool_running', blockedOnWait: true })
    assembler.tool({ kind: 'mcp_tool_call', phase: 'start', callId: 'd', title: 'TaskOutput', summary: '', details: ['Tool: run_command'] })
    expect(phases.at(-1)).toEqual({ phase: 'tool_running' })
  })

  it('records a complete for an unknown call as a finished call', () => {
    const { messages, state, assembler } = harness()
    assembler.tool({ kind: 'mcp_tool_call', phase: 'complete', callId: 'never-started', title: 'Bash', summary: 'ls', details: [] })
    expect(messages).toEqual([
      expect.objectContaining({ kind: 'mcp_tool_call', toolCall: expect.objectContaining({ title: 'Bash', status: 'complete' }) })
    ])
    expect(state.activeToolCallMessageIds.size).toBe(0)
  })

  it('closes a dangling thinking message after the turn', () => {
    const { messages, state, assembler } = harness()
    assembler.thinking({ phase: 'start', content: '' })
    assembler.thinking({ phase: 'delta', content: 'half a thought' })
    assembler.closeThinking()
    expect(messages[0].thinking).toEqual({ content: 'half a thought', status: 'complete' })
    expect(state.activeThinkingMessageId).toBeNull()
    assembler.closeThinking()
    expect(messages).toHaveLength(1)
  })

  it('keeps an interrupted reply as incomplete, or removes it when empty', () => {
    const kept = harness()
    kept.assembler.text({ phase: 'start', content: '', contentIndex: 0 })
    kept.assembler.text({ phase: 'delta', content: 'partial', contentIndex: 0 })
    expect(kept.assembler.openAssistantContent()).toBe('partial')
    expect(kept.assembler.abandonAssistant('partial', true)).toBe(true)
    expect(kept.messages[0]).toMatchObject({ content: 'partial', streaming: false, incomplete: true })
    expect(kept.state.activeAssistantMessageId).toBeNull()
    expect(kept.assembler.openAssistantContent()).toBeUndefined()
    expect(kept.assembler.abandonAssistant('again', true)).toBe(false)

    const removed = harness()
    removed.assembler.text({ phase: 'start', content: '', contentIndex: 0 })
    const id = removed.state.activeAssistantMessageId!
    expect(removed.assembler.abandonAssistant('', true)).toBe(true)
    expect(removed.messages).toEqual([])
    expect(removed.log.at(-1)).toBe(`remove:${id}`)

    const failed = harness()
    failed.assembler.text({ phase: 'start', content: '', contentIndex: 0 })
    failed.assembler.abandonAssistant('', false)
    expect(failed.messages[0]).toMatchObject({ content: '', streaming: false, incomplete: true })
  })

  it('forgets the previous turn on reset', () => {
    const { state, assembler } = harness()
    assembler.text({ phase: 'start', content: '', contentIndex: 0 })
    assembler.thinking({ phase: 'start', content: '' })
    assembler.tool({ kind: 'mcp_tool_call', phase: 'start', callId: 'c', title: 't', summary: '', details: [] })
    assembler.reset()
    expect(state).toMatchObject({
      activeAssistantMessageId: null,
      activeThinkingMessageId: null,
      lastCompletedAssistantMessageId: null,
      lastCompletedAssistantContent: ''
    })
    expect(state.activeToolCallMessageIds.size).toBe(0)
    expect(state.callToMessage?.size).toBe(0)
  })
})

/** A pi loop tool event: the tool in the details, the arguments JSON as the start response. */
const piStart = (callId: string, tool: string, args: unknown): StreamingLlmToolEvent => ({
  kind: 'build_tool_call',
  phase: 'start',
  callId,
  title: `Tool ${tool}`,
  summary: 'Called a local project tool (Pi coding-agent SDK).',
  details: [`Tool: ${tool}`],
  response: JSON.stringify(args)
})
const piResult = (callId: string, tool: string, text: string, isError = false): StreamingLlmToolEvent => ({
  kind: 'build_tool_result',
  phase: 'complete',
  callId,
  title: `Tool ${tool}`,
  summary: isError ? 'The tool returned an error.' : 'The tool returned successfully.',
  details: [`Tool: ${tool}`],
  response: text
})
/** A vendor runtime event, as `runtimeToolEvent` builds it. */
const vendor = (
  phase: 'start' | 'update' | 'complete',
  callId: string,
  toolName: string,
  extra: Partial<StreamingLlmToolEvent> = {}
): StreamingLlmToolEvent => ({
  kind: 'mcp_tool_call',
  phase,
  callId,
  title: toolName,
  summary: toolName,
  details: [],
  ...extra,
  activity: { toolName, ...extra.activity }
})
const activityOf = (message: ChatMessage | undefined): AgentActivityItem => message!.activity!

describe('TranscriptAssembler typed activity', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds one item per call, with the message id as its id', () => {
    const { messages, state, assembler } = harness()
    assembler.tool(piStart('call_abc', 'bash', { command: 'npm test', cwd: '/repo' }))
    expect(messages).toHaveLength(1)
    const message = messages[0]!
    expect(activityOf(message)).toMatchObject({
      id: message.id,
      callId: 'call_abc',
      kind: 'command',
      command: 'npm test',
      cwd: '/repo',
      status: 'running',
      toolName: 'bash',
      runId: 'run-1'
    })
    expect(Date.parse(activityOf(message).startedAt)).not.toBeNaN()

    assembler.tool({ ...piResult('call_abc', 'bash', 'all green\n'), phase: 'update', activity: { kind: 'command', output: 'running…\n' } })
    expect(activityOf(messages[0])).toMatchObject({ status: 'running', output: 'running…\n' })
    assembler.tool(piResult('call_abc', 'bash', 'all green\n'))
    expect(messages).toHaveLength(1)
    expect(activityOf(messages[0])).toMatchObject({
      id: message.id,
      status: 'done',
      output: 'all green\n',
      outputBytes: 10
    })
    expect(activityOf(messages[0]).endedAt).toBeDefined()
    expect(messages[0]!.toolCall).toMatchObject({ toolName: 'bash', status: 'complete' })
    expect(state.activeToolCallMessageIds.size).toBe(0)
    expect(state.callToMessage?.get('call_abc')).toBe(message.id)
  })

  it('marks a result the provider flagged as an error failed', () => {
    const { messages, assembler } = harness()
    assembler.tool(piStart('c1', 'bash', { command: 'false' }))
    assembler.tool(piResult('c1', 'bash', 'boom', true))
    expect(activityOf(messages[0])).toMatchObject({ status: 'failed', output: 'boom' })
  })

  it('translates a provider parent id to the parent row, also after the parent completed', () => {
    const { messages, assembler } = harness()
    assembler.tool(vendor('start', 'toolu_01PARENT', 'Agent', { activity: { kind: 'subagent' } }))
    assembler.tool(vendor('start', 'toolu_01CHILD', 'Bash', { parentCallId: 'toolu_01PARENT', input: { command: 'ls' } }))
    assembler.tool(vendor('complete', 'toolu_01CHILD', 'Bash', { parentCallId: 'toolu_01PARENT' }))
    assembler.tool(vendor('complete', 'toolu_01PARENT', 'Agent'))
    // A grandchild that starts after its parent finished still finds the parent's row.
    assembler.tool(vendor('start', 'toolu_01LATE', 'Read', { parentCallId: 'toolu_01PARENT' }))
    const [parent, child, late] = messages
    expect(activityOf(child).parentId).toBe(parent!.id)
    expect(activityOf(late).parentId).toBe(parent!.id)
    expect(activityOf(parent).parentId).toBeUndefined()
    expect(JSON.stringify(activityOf(child))).not.toContain('toolu_01PARENT')
  })

  it('leaves a child flat when its parent is unknown', () => {
    const { messages, assembler } = harness()
    assembler.tool(vendor('start', 'toolu_C', 'Bash', { parentCallId: 'toolu_missing' }))
    expect(activityOf(messages[0]).parentId).toBeUndefined()
  })

  it('bounds the emits and the saves of a command streaming for a minute', () => {
    vi.useFakeTimers()
    const { messages, log, assembler } = harness()
    assembler.tool(piStart('c1', 'bash', { command: 'make' }))
    const before = log.length
    for (let index = 0; index < 1000; index += 1) {
      vi.advanceTimersByTime(60)
      assembler.tool(vendor('update', 'c1', 'bash', { activity: { kind: 'command', output: `line ${index}\n` } }))
    }
    const emitsWithin = (entries: string[]) => entries.filter((entry) => entry === 'updated:mcp_tool_call').length
    expect(emitsWithin(log.slice(before))).toBeLessThanOrEqual(60_000 / 100)
    // The last deltas still reach clients through one trailing emit.
    vi.advanceTimersByTime(1000)
    const streamed = log.slice(before)
    expect(emitsWithin(streamed)).toBeLessThanOrEqual(60_000 / 100 + 1)
    expect(streamed.filter((entry) => entry === 'persist').length).toBeLessThanOrEqual(Math.ceil(60_000 / ACTIVITY_CHECKPOINT_MS) + 1)
    expect(streamed).not.toContain('persist!')
    // Every delta is in memory even though few were emitted.
    const item = activityOf(messages[0]) as Extract<AgentActivityItem, { kind: 'command' }>
    expect(item.output).toContain('line 999\n')
    expect(item.outputBytes).toBeGreaterThan(5000)

    const lengthBefore = log.length
    assembler.tool(piResult('c1', 'bash', 'done'))
    expect(log.slice(lengthBefore)).toEqual(['updated:mcp_tool_call', 'persist!'])
    // The pending trailing emit is gone once the call completed.
    vi.advanceTimersByTime(1000)
    expect(log.length).toBe(lengthBefore + 2)
  })

  it('keeps the tail of streamed output within the cap and counts what was cut', () => {
    const { messages, assembler } = harness()
    assembler.tool(piStart('c1', 'bash', { command: 'yes' }))
    const chunk = `${'y'.repeat(99)}\n`.repeat(100)
    for (let index = 0; index < 20; index += 1) {
      assembler.tool(vendor('update', 'c1', 'bash', { activity: { kind: 'command', output: chunk } }))
    }
    const item = activityOf(messages[0]) as Extract<AgentActivityItem, { kind: 'command' }>
    expect(item.outputTruncated).toBe(true)
    expect(item.outputBytes).toBe(chunk.length * 20)
    expect(new TextEncoder().encode(item.output!).length).toBeLessThanOrEqual(64 * 1024)
  })

  it('applies the provider-closer result as is, except for background work that settled', () => {
    const closed = (extra: Partial<AgentActivityItem>) => ({ status: 'interrupted' as const, ...extra }) as Partial<AgentActivityItem>
    const settle = (activity: Partial<AgentActivityItem>, start: Partial<AgentActivityItem> & { kind: AgentActivityItem['kind'] }) => {
      const { messages, assembler } = harness()
      assembler.tool(vendor('start', 'c1', 'Thing', { activity: start }))
      assembler.tool(vendor('complete', 'c1', 'Thing', { activity: activity as never }))
      return activityOf(messages[0])
    }
    const noResult = closed({ interruptedBy: 'no_result', summary: 'No result reported' })
    expect(settle(noResult, { kind: 'command', command: 'sleep 9' } as never)).toMatchObject({ status: 'interrupted', interruptedBy: 'no_result', summary: 'No result reported' })
    expect(settle(noResult, { kind: 'subagent', background: true } as never)).toMatchObject({ status: 'done', summary: 'Running in the background' })
    expect(settle(noResult, { kind: 'subagent' } as never)).toMatchObject({ status: 'interrupted', interruptedBy: 'no_result' })
    expect(settle(noResult, { kind: 'plan', text: 'x' } as never)).toMatchObject({ status: 'done' })
    // The closer's wording belongs to an interrupted item only.
    expect(settle(noResult, { kind: 'plan', text: 'x' } as never).summary).toBeUndefined()
    for (const by of ['stop', 'daemon_restart'] as const) {
      const closer = closed({ interruptedBy: by, summary: by === 'stop' ? 'Stopped' : 'Cut off by a Mousse restart' })
      expect(settle(closer, { kind: 'subagent', background: true } as never)).toMatchObject({ status: 'interrupted', interruptedBy: by })
      expect(settle(closer, { kind: 'plan', text: 'x' } as never)).toMatchObject({ status: 'interrupted', interruptedBy: by })
      expect(settle(closer, { kind: 'command', command: 'ls' } as never)).toMatchObject({ status: 'interrupted', interruptedBy: by })
    }
    // A provider that reports a failed call says so.
    expect(settle({ status: 'failed' }, { kind: 'command', command: 'ls' } as never)).toMatchObject({ status: 'failed' })
    // A bare complete means the provider reported a result.
    expect(settle({}, { kind: 'command', command: 'ls' } as never)).toMatchObject({ status: 'done' })
    expect(settle({}, { kind: 'subagent', background: true } as never)).toMatchObject({ status: 'done' })
  })

  it.each([
    ['stop', 'Stopped'],
    ['no_result', 'No result reported'],
    ['daemon_restart', 'Cut off by a Mousse restart']
  ] as const)('closes every open call as interrupted (%s)', (reason, summary) => {
    const { messages, log, state, assembler } = harness()
    assembler.tool(piStart('done-1', 'bash', { command: 'echo ok' }))
    assembler.tool(piResult('done-1', 'bash', 'ok'))
    assembler.tool(piStart('open-1', 'bash', { command: 'sleep 99' }))
    assembler.tool(vendor('start', 'open-2', 'Agent', { activity: { kind: 'subagent', background: true } }))
    assembler.tool(vendor('start', 'open-3', 'ExitPlanMode', { activity: { kind: 'plan', text: 'p' } }))
    const forced = log.filter((entry) => entry === 'persist!').length
    assembler.closeOpenTools(reason)
    expect(log.filter((entry) => entry === 'persist!').length).toBe(forced + 1)
    expect(activityOf(messages[0])).toMatchObject({ status: 'done' })
    expect(activityOf(messages[1])).toMatchObject({ status: 'interrupted', interruptedBy: reason, summary })
    expect(messages[1]!.toolCall?.status).toBe('complete')
    expect(activityOf(messages[1]).endedAt).toBeDefined()
    const settled = reason === 'no_result'
    expect(activityOf(messages[2])).toMatchObject(settled ? { status: 'done', summary: 'Running in the background' } : { status: 'interrupted', interruptedBy: reason })
    expect(activityOf(messages[3])).toMatchObject(settled ? { status: 'done' } : { status: 'interrupted', interruptedBy: reason })
    expect(state.activeToolCallMessageIds.size).toBe(0)
    // Nothing is left to close.
    assembler.closeOpenTools('stop')
    expect(log.filter((entry) => entry === 'persist!').length).toBe(forced + 1)
  })

  it('closes calls a new turn finds still open as stopped', () => {
    const { messages, assembler } = harness()
    assembler.tool(piStart('c1', 'bash', { command: 'sleep 9' }))
    assembler.reset()
    expect(activityOf(messages[0])).toMatchObject({ status: 'interrupted', interruptedBy: 'stop' })
  })

  it('records a result for a call it never saw start as a finished item', () => {
    const { messages, state, assembler } = harness()
    assembler.tool(piResult('late', 'bash', 'ls output'))
    expect(messages).toHaveLength(1)
    expect(activityOf(messages[0])).toMatchObject({ callId: 'late', status: 'done', id: messages[0]!.id })
    expect(state.callToMessage?.get('late')).toBe(messages[0]!.id)
  })

  it('fills the open row when a start repeats with typed fields', () => {
    const { messages, assembler } = harness()
    assembler.tool(vendor('start', 'toolu_1', 'Bash'))
    expect(activityOf(messages[0])).toMatchObject({ kind: 'generic', toolName: 'Bash' })
    assembler.tool(vendor('start', 'toolu_1', 'Bash', { activity: { kind: 'command', command: 'ls -la', toolName: 'Bash' } as never }))
    expect(messages).toHaveLength(1)
    expect(activityOf(messages[0])).toMatchObject({ kind: 'command', command: 'ls -la', id: messages[0]!.id, callId: 'toolu_1' })
  })

  it('replaces streamed output with the whole output a completing event carries', () => {
    const { messages, assembler } = harness()
    assembler.tool(vendor('start', 'c', 'shell', { activity: { kind: 'command', command: 'ls' } as never }))
    assembler.tool(vendor('update', 'c', 'shell', { activity: { kind: 'command', output: 'a\n' } }))
    assembler.tool(vendor('complete', 'c', 'shell', { activity: { kind: 'command', output: 'a\nb\n', exitCode: 1 } as never }))
    expect(activityOf(messages[0])).toMatchObject({ status: 'done', output: 'a\nb\n', exitCode: 1 })
  })

  it('ignores a result that arrives after the turn closed the call, and a repeated one', () => {
    const { messages, assembler } = harness()
    assembler.tool(piStart('c1', 'bash', { command: 'sleep 9' }))
    assembler.closeOpenTools('stop')
    assembler.tool(piResult('c1', 'bash', 'late output'))
    expect(messages).toHaveLength(1)
    expect(activityOf(messages[0])).toMatchObject({ status: 'interrupted', interruptedBy: 'stop', summary: 'Stopped' })

    assembler.tool(piStart('c2', 'bash', { command: 'ls' }))
    assembler.tool(piResult('c2', 'bash', 'a'))
    assembler.tool(piResult('c2', 'bash', 'a'))
    expect(messages).toHaveLength(2)
    expect(activityOf(messages[1])).toMatchObject({ status: 'done', output: 'a' })
  })

  it('does not let a provider patch set its own identity, and finds a parent named on a repeated start', () => {
    const { messages, assembler } = harness()
    assembler.tool(vendor('start', 'toolu_P', 'Agent', { activity: { kind: 'subagent' } }))
    assembler.tool(vendor('start', 'toolu_K', 'Bash', { activity: { kind: 'command', command: 'ls', parentId: 'toolu_P', runId: 'other' } as never }))
    expect(activityOf(messages[1]).parentId).toBeUndefined()
    expect(activityOf(messages[1]).runId).toBe('run-1')
    assembler.tool(vendor('start', 'toolu_K', 'Bash', { parentCallId: 'toolu_P' }))
    expect(messages).toHaveLength(2)
    expect(activityOf(messages[1]).parentId).toBe(messages[0]!.id)
  })

  it('reads the wait tool from the item', () => {
    const { phases, assembler } = harness()
    assembler.tool(vendor('start', 'w', 'TaskOutput'))
    expect(phases.at(-1)).toEqual({ phase: 'tool_running', blockedOnWait: true })
  })

  describe('what a row saves', () => {
    const size = (message: ChatMessage) => JSON.stringify(message).length

    it('keeps a pi write with a 3 MB argument JSON small', () => {
      const { messages, assembler } = harness()
      const content = 'x'.repeat(3 * 1024 * 1024)
      assembler.tool(piStart('w1', 'write', { path: 'src/big.ts', content }))
      expect(activityOf(messages[0])).toMatchObject({
        kind: 'file_change',
        changes: [{ path: 'src/big.ts', diffUnavailable: true, linesWritten: 1 }]
      })
      assembler.tool(piResult('w1', 'write', 'Wrote 3145728 bytes'))
      const message = messages[0]!
      expect(size(message)).toBeLessThan(100_000)
      expect(message.toolCall?.response).toBeUndefined()
      expect(message.toolCall?.input).toBeUndefined()
    })

    it('keeps a pi bash heredoc that writes a whole file small', () => {
      const { messages, assembler } = harness()
      const command = `cat > big.ts <<'EOF'\n${'const x = 1\n'.repeat(300_000)}EOF`
      assembler.tool(piStart('b1', 'bash', { command }))
      assembler.tool(piResult('b1', 'bash', ''))
      const message = messages[0]!
      expect(size(message)).toBeLessThan(100_000)
      expect(activityOf(message)).toMatchObject({ kind: 'command', status: 'done' })
      expect((activityOf(message) as { command: string }).command).toMatch(/^cat > big.ts/)
      expect((activityOf(message) as { command: string }).command).toMatch(/\[command truncated\]$/)
    })

    it('holds the fields a provider supplies to their caps', () => {
      const { messages, assembler } = harness()
      const huge = 'y'.repeat(3 * 1024 * 1024)
      assembler.tool(vendor('start', 'e1', 'Edit', { activity: { kind: 'file_change', changes: [{ path: 'a.ts', change: 'update', diff: huge }] } as never }))
      assembler.tool(vendor('start', 'g2', 'mcp__srv__tool', { activity: { kind: 'generic', input: { blob: huge } } as never }))
      assembler.tool(vendor('start', 'a1', 'Agent', { activity: { kind: 'subagent', description: huge } as never }))
      assembler.tool(vendor('start', 'p1', 'ExitPlanMode', { activity: { kind: 'plan', text: huge } as never }))
      for (const message of messages) expect(size(message)).toBeLessThan(100_000)
      expect(activityOf(messages[0])).toMatchObject({ changes: [{ path: 'a.ts', diffTruncated: true }] })
      expect(activityOf(messages[1])).toMatchObject({ input: { truncated: true } })
      expect((activityOf(messages[2]) as { description: string }).description.length).toBeLessThanOrEqual(200)
    })

    it('keeps a generic tool with 3 MB of arguments and result small', () => {
      const { messages, assembler } = harness()
      const blob = 'z'.repeat(3 * 1024 * 1024)
      assembler.tool(piStart('g1', 'custom_tool', { blob }))
      assembler.tool(piResult('g1', 'custom_tool', blob))
      const message = messages[0]!
      expect(size(message)).toBeLessThan(100_000)
      expect(message.toolCall?.response).toBeUndefined()
      expect(message.toolCall?.input).toBeUndefined()
      expect(activityOf(message)).toMatchObject({ kind: 'generic', input: { truncated: true } })
    })

    it('keeps only the bounded record of a delegation row, and never the prompt', () => {
      const { messages, assembler } = harness()
      const record = { recordVersion: 1, title: 'Research', subagent: 'scout' }
      assembler.tool({
        kind: 'mcp_tool_call',
        phase: 'start',
        callId: 'd1',
        title: 'Called mousse.delegate_task',
        summary: 'The orchestrator called a Mousse tool.',
        details: ['Server: mousse', 'Tool: delegate_task'],
        input: record
      })
      assembler.tool({
        kind: 'mcp_tool_result',
        phase: 'complete',
        callId: 'd1',
        title: 'Called mousse.delegate_task',
        summary: 'The MCP tool returned successfully.',
        details: ['Server: mousse', 'Tool: delegate_task'],
        response: JSON.stringify({ delegationId: 'del-1', status: 'running' }),
        input: record
      })
      const message = messages[0]!
      expect(message.toolCall?.input).toEqual(record)
      expect(message.toolCall?.response).toBeUndefined()
      expect(activityOf(message)).toMatchObject({ kind: 'generic', output: JSON.stringify({ delegationId: 'del-1', status: 'running' }) })
      expect(size(message)).toBeLessThan(5000)
    })
  })
})

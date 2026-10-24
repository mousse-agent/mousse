import { describe, expect, it } from 'vitest'
import {
  TranscriptAssembler,
  type TranscriptHooks,
  type TranscriptStreamState,
  type TranscriptTextMode
} from '../../src/mms/run/adapters/shared/TranscriptAssembler'
import type { ChatMessage, TurnPhase } from '../../src/shared/types'

function harness(mode: TranscriptTextMode = 'replace') {
  const messages: ChatMessage[] = []
  const log: string[] = []
  const phases: Array<{ phase: TurnPhase; activeMessageId?: string }> = []
  const state: TranscriptStreamState = {
    activeAssistantMessageId: null,
    activeThinkingMessageId: null,
    activeToolCallMessageIds: new Map(),
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
  })
})

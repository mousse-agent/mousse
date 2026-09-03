import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import { mousseToUIMessages } from '../src/renderer/chat/adapters/mousseToUI'

const base = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  role: 'system',
  content: '',
  timestamp: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('mousseToUIMessages standardize layer', () => {
  it('uses structured provider toolName/input instead of title string-matching', () => {
    const out = mousseToUIMessages([
      base({
        id: 'tool-1',
        kind: 'build_tool_call',
        toolCall: {
          title: 'Tool Bash',
          summary: 'Called a local project tool (Pi coding-agent SDK).',
          details: ['Tool: Bash'],
          response: JSON.stringify({ command: 'npm test', description: 'run tests' }),
          status: 'processing',
          toolName: 'Bash',
          input: { command: 'npm test', description: 'run tests' },
        },
      }),
    ])
    expect(out).toHaveLength(1)
    // System tool messages map to assistant so MessageList turn grouping keeps them.
    expect(out[0].role).toBe('assistant')
    const part = out[0].parts[0] as unknown as Record<string, unknown>
    expect(part.type).toBe('tool-Bash')
    expect(part.input).toMatchObject({ command: 'npm test' })
    expect(part.state).toBe('input-available')
    expect(part.output).toBeUndefined()
  })

  it('preserves start-phase args on complete (result text becomes output, not input)', () => {
    const out = mousseToUIMessages([
      base({
        id: 'tool-2',
        kind: 'build_tool_result',
        toolCall: {
          title: 'Tool Bash',
          summary: 'The tool returned successfully.',
          details: ['Tool: Bash'],
          response: 'ok output',
          status: 'complete',
          toolName: 'Bash',
          input: { command: 'npm test' },
        },
      }),
    ])
    const part = out[0].parts[0] as unknown as Record<string, unknown>
    expect(part.type).toBe('tool-Bash')
    expect(part.input).toMatchObject({ command: 'npm test' })
    expect(part.output).toBe('ok output')
    expect(part.state).toBe('output-available')
  })

  it('falls back to legacy string fields for pre-structured transcripts', () => {
    const out = mousseToUIMessages([
      base({
        id: 'tool-3',
        kind: 'build_tool_call',
        toolCall: {
          title: 'Tool read',
          summary: 'read a file',
          details: ['Tool: read'],
          response: JSON.stringify({ file_path: 'src/a.ts' }),
          status: 'processing',
        },
      }),
    ])
    const part = out[0].parts[0] as unknown as Record<string, unknown>
    expect(part.type).toBe('tool-Read')
    expect(part.input).toMatchObject({ file_path: 'src/a.ts' })
  })

  it('emits MCP registry types the ToolRenderer can dispatch', () => {
    const out = mousseToUIMessages([
      base({
        id: 'tool-4',
        kind: 'mcp_tool_call',
        toolCall: {
          title: 'Called myserver.my_tool',
          summary: 'The orchestrator called an MCP tool.',
          details: ['Server: myserver', 'Tool: my_tool'],
          response: JSON.stringify({ q: 'x' }),
          status: 'processing',
          toolName: 'my_tool',
          input: { q: 'x' },
        },
      }),
    ])
    const part = out[0].parts[0] as unknown as Record<string, unknown>
    expect(part.type).toBe('tool-mcp__myserver__my_tool')
  })

  it('routes Pi/build tools with rewritten mcp kinds to rich cards', () => {
    // OrchestratorService rewrites build_tool_* kinds to mcp_tool_* for the
    // timeline, but Pi tools carry no Server detail — unlike true MCP tools.
    const out = mousseToUIMessages([
      base({
        id: 'tool-7',
        kind: 'mcp_tool_call',
        toolCall: {
          title: 'Tool Bash',
          summary: 'Called a local project tool (Pi coding-agent SDK).',
          details: ['Tool: bash'],
          response: JSON.stringify({ command: 'npm run dev' }),
          status: 'processing',
        },
      }),
      base({
        id: 'tool-8',
        kind: 'mcp_tool_result',
        toolCall: {
          title: 'Tool read',
          summary: 'The tool returned successfully.',
          details: ['Tool: read'],
          response: 'file text',
          status: 'complete',
        },
      }),
      base({
        id: 'tool-9',
        kind: 'mcp_tool_result',
        toolCall: {
          title: 'Tool list_tasks',
          summary: 'The tool returned successfully.',
          details: ['Tool: list_tasks'],
          response: 'tasks',
          status: 'complete',
        },
      }),
    ])
    expect(
      (out[0].parts[0] as unknown as Record<string, unknown>).type
    ).toBe('tool-Bash')
    expect(
      (out[1].parts[0] as unknown as Record<string, unknown>).type
    ).toBe('tool-Read')
    // Unknown names without a Server detail stay generic MCP rows.
    expect(
      (out[2].parts[0] as unknown as Record<string, unknown>).type
    ).toBe('tool-mcp__custom__list_tasks')
  })

  it('leaves unknown Bash commands empty instead of faking them', () => {
    // Regression: the adapter used to synthesize input.command from the
    // summary, producing fake "Ran command: The tool returned..." headers.
    // Unknown commands stay empty so cards show bare Ran/Failed labels.
    const out = mousseToUIMessages([
      base({
        id: 'tool-0',
        kind: 'build_tool_result',
        toolCall: {
          title: 'Tool Bash',
          summary: 'The tool returned an error.',
          details: ['Tool: Bash'],
          response: 'boom',
          status: 'complete',
        },
      }),
    ])
    expect(
      (out[0].parts[0] as unknown as Record<string, unknown>).input
    ).toMatchObject({ command: '' })
  })

  it('marks failed tool results as output-error so cards render red', () => {
    const out = mousseToUIMessages([
      base({
        id: 'tool-5',
        kind: 'build_tool_result',
        toolCall: {
          title: 'Tool Bash',
          summary: 'The tool returned an error.',
          details: ['Tool: Bash'],
          response: 'command not found: foo',
          status: 'complete',
          toolName: 'Bash',
          input: { command: 'foo' },
        },
      }),
      base({
        id: 'tool-6',
        kind: 'build_tool_result',
        toolCall: {
          title: 'Tool Bash',
          summary: 'The tool returned successfully.',
          details: ['Tool: Bash'],
          response: 'ok',
          status: 'complete',
          toolName: 'Bash',
          input: { command: 'true' },
        },
      }),
    ])
    expect(
      (out[0].parts[0] as unknown as Record<string, unknown>).state
    ).toBe('output-error')
    expect(
      (out[1].parts[0] as unknown as Record<string, unknown>).state
    ).toBe('output-available')
  })

  it('merges consecutive Thought rows into one', () => {
    const thinking = (id: string, content: string, status: 'processing' | 'complete' = 'complete'): ChatMessage => ({
      id,
      role: 'system',
      content: '',
      timestamp: '2026-01-01T00:00:00.000Z',
      kind: 'thinking',
      thinking: { content, status },
    })
    const out = mousseToUIMessages([
      thinking('t1', ''),
      thinking('t2', ''),
      thinking('t3', 'Considering edge cases'),
      {
        id: 'a1',
        role: 'assistant',
        content: 'Working on it',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      thinking('t4', 'Later thought'),
    ])
    // Three back-to-back thoughts (two empty) become one row keeping the
    // first id; the thought after assistant text stays separate.
    expect(out.map((m) => m.id)).toEqual(['t1', 'a1', 't4'])
    const merged = out[0].parts[0] as unknown as Record<string, Record<string, string>>
    expect(merged.input.thought).toBe('Considering edge cases')
  })

  it('keeps a streaming Thought merged row pending', () => {
    const out = mousseToUIMessages([
      {
        id: 't1',
        role: 'system',
        content: '',
        timestamp: '2026-01-01T00:00:00.000Z',
        kind: 'thinking',
        thinking: { content: 'Hmm', status: 'complete' },
      },
      {
        id: 't2',
        role: 'system',
        content: '',
        timestamp: '2026-01-01T00:00:00.000Z',
        kind: 'thinking',
        thinking: { content: '', status: 'processing' },
      },
    ])
    expect(out).toHaveLength(1)
    expect(
      (out[0].parts[0] as unknown as Record<string, unknown>).state
    ).toBe('input-available')
  })

  it('folds exact-duplicate consecutive assistant text (provider double-add)', () => {
    const textMsg = (id: string, content: string, streaming = false): ChatMessage => ({
      id,
      role: 'assistant',
      content,
      timestamp: '2026-01-01T00:00:00.000Z',
      ...(streaming ? { streaming: true } : {}),
    })
    // Twin with only whitespace difference (raw stream vs stripped final).
    const folded = mousseToUIMessages([
      textMsg('a1', 'Hello world.\n'),
      textMsg('a2', 'Hello world.'),
    ])
    expect(folded.map((m) => m.id)).toEqual(['a1'])
    // Distinct texts are kept.
    const kept = mousseToUIMessages([textMsg('a1', 'Hello.'), textMsg('a2', 'World.')])
    expect(kept.map((m) => m.id)).toEqual(['a1', 'a2'])
    // Streaming messages are exempt from folding.
    const streaming = mousseToUIMessages([
      textMsg('a1', 'Hello.', true),
      textMsg('a2', 'Hello.'),
    ])
    expect(streaming.map((m) => m.id)).toEqual(['a1', 'a2'])
    // User echoes are never folded.
    const echo = mousseToUIMessages([
      { ...textMsg('u1', 'hi'), role: 'user' },
      { ...textMsg('u2', 'hi'), role: 'user' },
    ])
    expect(echo.map((m) => m.id)).toEqual(['u1', 'u2'])
  })

  it('passes full responseMetadata through for the toolbar metadata popup', () => {    const out = mousseToUIMessages([
      base({
        id: 'a1',
        role: 'assistant',
        content: 'Hello.',
        responseMetadata: {
          modelName: 'test-model',
          totalResponseTimeMs: 1234,
          tokensUsed: 56,
          tokensPerSecond: 45.6,
        },
      }),
    ])
    expect(out).toHaveLength(1)
    expect((out[0] as unknown as { metadata: unknown }).metadata).toMatchObject({
      modelName: 'test-model',
      totalResponseTimeMs: 1234,
      tokensUsed: 56,
      tokensPerSecond: 45.6,
    })
  })

  it('routes timeline-rewritten quick-action calls to the rich card, not the MCP fallback', () => {
    // OrchestratorService rewrites build_tool_* to mcp_tool_* with no Server
    // detail; without RICH membership this rendered as "Created Quick Action".
    const out = mousseToUIMessages([
      base({
        id: 'tool-qa-1',
        kind: 'mcp_tool_call',
        toolCall: {
          title: 'Quick action create_quick_action',
          summary: 'The orchestrator is creating a chat header quick action.',
          details: ['Tool: create_quick_action'],
          response: JSON.stringify({ label: 'Test Action', kind: 'send-current', payload: 'hi' }),
          status: 'processing',
          toolName: 'create_quick_action',
          input: { label: 'Test Action', kind: 'send-current', payload: 'hi' },
        },
      }),
    ])
    const part = out[0].parts[0] as unknown as Record<string, unknown>
    expect(part.type).toBe('tool-QuickAction')
    expect(part.input).toMatchObject({ label: 'Test Action' })
  })

  it('keeps rejected quick-action results as output on the rich card', () => {
    const out = mousseToUIMessages([
      base({
        id: 'tool-qa-2',
        kind: 'mcp_tool_result',
        toolCall: {
          title: 'Quick action create_quick_action',
          summary: 'The quick-action tool returned successfully.',
          details: ['Tool: create_quick_action'],
          response: 'Quick action "Test Action" was not created — the user rejected it.',
          status: 'complete',
          toolName: 'create_quick_action',
          input: { label: 'Test Action', kind: 'send-current', payload: 'hi' },
        },
      }),
    ])
    const part = out[0].parts[0] as unknown as Record<string, unknown>
    expect(part.type).toBe('tool-QuickAction')
    expect(part.output).toContain('was not created')
    expect(part.state).toBe('output-available')
  })
})

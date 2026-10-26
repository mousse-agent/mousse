import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { ChatMessage } from '../src/shared/types'
import type { AgentActivityItem } from '../src/shared/agentActivity'
import type { StreamingLlmToolEvent } from '../src/mms/orchestrator/LlmClient'
import { TranscriptAssembler } from '../src/mms/run/adapters/shared/TranscriptAssembler'
import { getToolStatus } from '../src/renderer/chat/components/agent-elements/utils/format-tool'
import { mousseToUIMessages } from '../src/renderer/chat/adapters/mousseToUI'

const base = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  role: 'system',
  content: '',
  timestamp: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('mousseToUIMessages standardize layer', () => {
  it('maps plan_card to an inline tool-PlanWrite approval card, not plain text', () => {
    const out = mousseToUIMessages([
      base({
        id: 'plan-1',
        role: 'assistant',
        kind: 'plan_card',
        content: '',
        planCard: {
          originalRequest: 'Build a login form',
          planMarkdown: '# Implementation Plan\n\n1. Add form',
        },
      }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('assistant')
    const part = out[0].parts[0] as unknown as Record<string, any>
    expect(part.type).toBe('tool-PlanWrite')
    expect(part.toolCallId).toBe('plan-1')
    expect(part.state).toBe('output-available')
    expect(part.input?.plan?.title).toBe('Build a login form')
    expect(part.input?.plan?.summary).toBe('# Implementation Plan\n\n1. Add form')
  })

  it('falls back to message content when planMarkdown is empty', () => {
    const out = mousseToUIMessages([
      base({
        id: 'plan-2',
        role: 'assistant',
        kind: 'plan_card',
        content: '# From content',
        planCard: { originalRequest: 'ship it', planMarkdown: '' },
      }),
    ])
    const part = out[0].parts[0] as unknown as Record<string, any>
    expect(part.type).toBe('tool-PlanWrite')
    expect(part.input?.plan?.summary).toBe('# From content')
  })

  it('routes present_plan tool calls to the PlanWrite card', () => {
    const out = mousseToUIMessages([
      base({
        id: 'tool-plan-1',
        kind: 'build_tool_call',
        toolCall: {
          title: 'Plan tool present_plan',
          summary: 'The assistant called a plan tool.',
          details: ['Tool: present_plan'],
          response: JSON.stringify({ title: 'Auth plan', markdown: '# Plan' }),
          status: 'processing',
          toolName: 'present_plan',
          input: { title: 'Auth plan', markdown: '# Plan' },
        },
      }),
    ])
    const part = out[0].parts[0] as unknown as Record<string, unknown>
    expect(part.type).toBe('tool-PlanWrite')
  })
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

  it('settles a merged Thought row when the latest segment completes', () => {
    // Live path: complete thought, then a processing segment that later
    // finishes. The intermediate merge must not leave the row stuck pending.
    const out = mousseToUIMessages([
      {
        id: 't1',
        role: 'system',
        content: '',
        timestamp: '2026-01-01T00:00:00.000Z',
        kind: 'thinking',
        thinking: { content: 'First pass', status: 'complete' },
      },
      {
        id: 't2',
        role: 'system',
        content: '',
        timestamp: '2026-01-01T00:00:00.000Z',
        kind: 'thinking',
        thinking: { content: 'Second pass', status: 'complete' },
      },
    ])
    expect(out).toHaveLength(1)
    const part = out[0].parts[0] as unknown as Record<string, unknown>
    expect(part.state).toBe('output-available')
    expect((part.input as { thought?: string }).thought).toBe(
      'First pass\n\nSecond pass',
    )
  })

  it('re-opens then settles Thought when processing becomes complete', () => {
    // Simulate the two-step update: complete + processing, then both complete.
    const pending = mousseToUIMessages([
      {
        id: 't1',
        role: 'system',
        content: '',
        timestamp: '2026-01-01T00:00:00.000Z',
        kind: 'thinking',
        thinking: { content: 'Done bit', status: 'complete' },
      },
      {
        id: 't2',
        role: 'system',
        content: '',
        timestamp: '2026-01-01T00:00:00.000Z',
        kind: 'thinking',
        thinking: { content: 'Still…', status: 'processing' },
      },
    ])
    expect(pending).toHaveLength(1)
    expect(
      (pending[0].parts[0] as unknown as Record<string, unknown>).state,
    ).toBe('input-available')

    const settled = mousseToUIMessages([
      {
        id: 't1',
        role: 'system',
        content: '',
        timestamp: '2026-01-01T00:00:00.000Z',
        kind: 'thinking',
        thinking: { content: 'Done bit', status: 'complete' },
      },
      {
        id: 't2',
        role: 'system',
        content: '',
        timestamp: '2026-01-01T00:00:00.000Z',
        kind: 'thinking',
        thinking: { content: 'Still… now done', status: 'complete' },
      },
    ])
    expect(
      (settled[0].parts[0] as unknown as Record<string, unknown>).state,
    ).toBe('output-available')
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

  it('strips [Attached files:] markers from user text (images already render as previews)', () => {
    const out = mousseToUIMessages([
      base({
        id: 'u1',
        role: 'user',
        content: 'look at this\n[Attached files: pasted-image-1.png]',
        images: [{ name: 'pasted-image-1.png', mimeType: 'image/png', data: 'abc' }],
      }),
    ])
    expect(out).toHaveLength(1)
    const texts = (out[0].parts as unknown as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0].text).toBe('look at this')
    expect(JSON.stringify(out[0].parts)).not.toContain('[Attached files:')
  })

  it('keeps non-image attachments as file pills instead of raw marker text', () => {
    const out = mousseToUIMessages([
      base({
        id: 'u2',
        role: 'user',
        content: 'review\n[Attached files: notes.md]',
      }),
    ])
    expect(out).toHaveLength(1)
    const texts = (out[0].parts as unknown as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text')
    expect(texts[0]?.text).toBe('review')
    const files = out[0].parts as unknown as Array<{ type: string; filename?: string }>
    expect(files.some((p) => p.type === 'file' && p.filename === 'notes.md')).toBe(true)
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
          summary: 'The orchestrator is creating a quick action.',
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

describe('durable applet presentation', () => {
  const reference = { appletId: 'chart', revisionId: 'rev1', sourceHash: 'hash', title: 'Costs', description: 'A comparison' }
  const presentationParts: ChatMessage['presentationParts'] = [{ type: 'text', text: 'Before' }, { type: 'applet', reference }, { type: 'text', text: 'After' }]
  it('preserves text and applet ordering without displaying source twice', () => {
    const out = mousseToUIMessages([base({ role: 'assistant', content: 'raw source', presentationParts })])
    expect(out[0].parts).toEqual([{ type: 'text', text: 'Before' }, { type: 'data-applet', data: reference }, { type: 'text', text: 'After' }])
  })
  it.each([{ streaming: true }, { incomplete: true }, { role: 'user' as const }, { role: 'system' as const }])('keeps unpublished or nonassistant references inert: %j', flags => {
    const out = mousseToUIMessages([base({ role: 'assistant', content: '<html>example</html>', presentationParts, ...flags })])
    expect(out.flatMap(message => message.parts).some(part => part.type === 'data-applet')).toBe(false)
  })
  it('does not deduplicate distinct applet-only revisions', () => {
    const out = mousseToUIMessages([base({ id: 'one', role: 'assistant', presentationParts: [{ type: 'applet', reference }] }), base({ id: 'two', role: 'assistant', presentationParts: [{ type: 'applet', reference: { ...reference, revisionId: 'rev2' } }] })])
    expect(out.map(message => message.id)).toEqual(['one', 'two'])
  })
})

describe('streaming applet placeholders', () => {
  it('shows a stable inert placeholder while explicit applet source streams', () => {
    const out = mousseToUIMessages([base({role:'assistant',streaming:true,content:'Explanation\n```mousse-applet\n{"html":"large partial source'})])
    expect(out[0].parts).toEqual([{type:'text',text:'Explanation\n'},{type:'data-applet-pending',data:{}}])
  })
  it('keeps applet-looking fences inside ordinary code examples inert text', () => {
    const content = '````markdown\n```mousse-applet\n{}\n```\n````'
    const out = mousseToUIMessages([base({role:'assistant',streaming:true,content})])
    expect(out[0].parts).toEqual([{type:'text',text:content}])
  })
  it('preserves explanatory text after a streamed completed fence without executing it', () => {
    const out = mousseToUIMessages([base({role:'assistant',streaming:true,content:'~~~mousse-applet\n{}\n~~~\nAfter'})])
    expect(out[0].parts).toEqual([{type:'data-applet-pending',data:{}},{type:'text',text:'After'}])
  })
})

const activityBase = { startedAt: '2026-01-01T00:00:00.000Z', status: 'done' as const }
const row = (id: string, activity: AgentActivityItem, extra: Partial<ChatMessage> = {}): ChatMessage =>
  base({
    id,
    kind: 'mcp_tool_call',
    toolCall: { title: activity.toolName, summary: activity.toolName, details: [], status: activity.status === 'running' ? 'processing' : 'complete' },
    activity,
    ...extra,
  })
const partOf = (message: UIMessage, index = 0) => message.parts[index] as unknown as Record<string, any>

describe('typed activity items', () => {
  it('maps a command to the Bash card with the output, exit code and duration', () => {
    const out = mousseToUIMessages([
      row('c1', {
        ...activityBase,
        id: 'c1',
        callId: 'x',
        toolName: 'bash',
        kind: 'command',
        command: "bash -lc 'npm test'",
        cwd: '/repo',
        output: 'ok\n',
        outputTruncated: true,
        outputBytes: 70000,
        exitCode: 1,
        durationMs: 1200,
      }),
    ])
    const part = partOf(out[0]!)
    expect(part).toMatchObject({
      type: 'tool-Bash',
      toolCallId: 'c1',
      state: 'output-available',
      input: { command: "bash -lc 'npm test'", cwd: '/repo', label: 'npm test' },
      output: { stdout: 'ok\n', exitCode: 1, durationMs: 1200, truncated: true, bytes: 70000 },
    })
    expect(part.output.interrupted).toBeUndefined()
  })

  it('shows the output of a running command as it arrives', () => {
    const running = row('c1', { ...activityBase, status: 'running', id: 'c1', callId: 'x', toolName: 'bash', kind: 'command', command: 'make', output: 'building\n' })
    const part = partOf(mousseToUIMessages([running])[0]!)
    expect(part).toMatchObject({ state: 'input-available', output: { stdout: 'building\n' } })
    const quiet = row('c2', { ...activityBase, status: 'running', id: 'c2', callId: 'y', toolName: 'bash', kind: 'command', command: 'make' })
    expect(partOf(mousseToUIMessages([quiet])[0]!).output).toBeUndefined()
  })

  it('maps file changes to Edit, or Write when every change adds a file', () => {
    const item = (changes: Extract<AgentActivityItem, { kind: 'file_change' }>['changes']): AgentActivityItem => ({
      ...activityBase,
      id: 'f',
      callId: 'f',
      toolName: 'edit',
      kind: 'file_change',
      changes,
    })
    const edit = partOf(mousseToUIMessages([row('f', item([{ path: 'a.ts', change: 'update', diff: '@@ -1 +1 @@\n-a\n+b\n', added: 1, removed: 1 }]))])[0]!)
    expect(edit).toMatchObject({ type: 'tool-Edit', input: { file_path: 'a.ts' }, output: { changes: [{ path: 'a.ts', added: 1, removed: 1 }] } })
    const write = partOf(mousseToUIMessages([row('f', item([{ path: 'n.ts', change: 'add', added: 2 }]))])[0]!)
    expect(write.type).toBe('tool-Write')
    const mixed = partOf(mousseToUIMessages([row('f', item([{ path: 'n.ts', change: 'add' }, { path: 'a.ts', change: 'update' }]))])[0]!)
    expect(mixed.type).toBe('tool-Edit')
  })

  it('shows a failed edit as an error with the edit error in the changes', () => {
    const failed = row('f', {
      ...activityBase,
      status: 'failed',
      id: 'f',
      callId: 'f',
      toolName: 'edit',
      kind: 'file_change',
      changes: [{ path: 'a.ts', change: 'update', error: 'old text not found' }],
    })
    const part = partOf(mousseToUIMessages([failed])[0]!)
    expect(part).toMatchObject({ state: 'output-error', output: { changes: [{ error: 'old text not found' }] } })
  })

  it('carries a write whose diff is unknown without inventing one', () => {
    const write = row('w', {
      ...activityBase,
      id: 'w',
      callId: 'w',
      toolName: 'write',
      kind: 'file_change',
      changes: [{ path: 'a.ts', change: 'update', diffUnavailable: true, linesWritten: 12 }],
    })
    const part = partOf(mousseToUIMessages([write])[0]!)
    expect(part.output.changes[0]).toEqual({ path: 'a.ts', change: 'update', diffUnavailable: true, linesWritten: 12 })
  })

  it('maps searches, web searches, todos, plans and subagents to their cards', () => {
    const at = (id: string, rest: Record<string, unknown>) => row(id, { ...activityBase, id, callId: id, toolName: 'tool', ...rest } as AgentActivityItem)
    const out = mousseToUIMessages([
      at('s1', { kind: 'search', scope: 'code', query: 'foo', path: 'src', resultCount: 3 }),
      at('s2', { kind: 'search', scope: 'files', query: '*.ts' }),
      at('w1', { kind: 'web_search', query: 'vitest' }),
      at('t1', { kind: 'todo', items: [{ content: 'a', status: 'pending' }] }),
      at('p1', { kind: 'plan', text: '# Ship it\n- step' }),
      at('a1', { kind: 'subagent', agentType: 'Explore', description: 'look', durationMs: 4000, summary: 'Running in the background' }),
    ])
    const parts = out.map((message) => partOf(message))
    expect(parts[0]).toMatchObject({ type: 'tool-Grep', input: { pattern: 'foo', query: 'foo', path: 'src' }, output: { numFiles: 3 } })
    expect(parts[1]).toMatchObject({ type: 'tool-Glob', input: { pattern: '*.ts' } })
    expect(parts[2]).toMatchObject({ type: 'tool-WebSearch', input: { query: 'vitest' } })
    expect(parts[3]).toMatchObject({ type: 'tool-TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] } })
    expect(parts[4]).toMatchObject({ type: 'tool-PlanWrite', input: { plan: { title: 'Ship it', summary: '# Ship it\n- step' } } })
    expect(parts[5]).toMatchObject({
      type: 'tool-Agent',
      input: { subagent_type: 'Explore', description: 'look' },
      output: { totalDurationMs: 4000, summary: 'Running in the background' },
    })
  })

  it('lists the results a web search saved in the shape the search card reads', () => {
    const search = (status: AgentActivityItem['status'], results?: Array<{ title: string; url: string }>) =>
      partOf(
        mousseToUIMessages([
          row('w', { ...activityBase, status, id: 'w', callId: 'w', toolName: 'web_search', kind: 'web_search', query: 'vitest', ...(results ? { results } : {}), summary: 'Stopped' } as AgentActivityItem),
        ])[0]!
      )
    const results = [
      { title: 'Vitest', url: 'https://vitest.dev/guide' },
      { title: 'Odd', url: 'not a url' },
    ]
    expect(search('done', results).output).toEqual({
      results: [
        { source: 'google', title: 'Vitest', date: 'vitest.dev' },
        { source: 'google', title: 'Odd', date: 'not a url' },
      ],
    })
    expect(search('done').output).toBeUndefined()
    expect(search('running', results).output).toBeUndefined()
    // An interrupted search keeps what it found and says it did not finish.
    expect(search('interrupted', results).output).toMatchObject({ interrupted: true, summary: 'Stopped', results: [{ title: 'Vitest' }, { title: 'Odd' }] })
  })

  it('maps the status: running, done, failed and interrupted', () => {
    const at = (status: AgentActivityItem['status']) =>
      partOf(
        mousseToUIMessages([row('c', { ...activityBase, status, id: 'c', callId: 'c', toolName: 'bash', kind: 'command', command: 'ls', summary: 'Stopped' })])[0]!
      )
    expect(at('running').state).toBe('input-available')
    expect(at('done').state).toBe('output-available')
    expect(at('failed').state).toBe('output-error')
    const interrupted = at('interrupted')
    expect(interrupted.state).toBe('output-available')
    expect(interrupted.output).toMatchObject({ interrupted: true, summary: 'Stopped' })
    expect(getToolStatus(interrupted, 'ready')).toMatchObject({ isInterrupted: true, isSuccess: false, isPending: false })
  })

  it('marks an interrupted generic row interrupted in its output', () => {
    const generic = row('g', { ...activityBase, status: 'interrupted', summary: 'No result reported', id: 'g', callId: 'g', toolName: 'my_tool', kind: 'generic', output: 'half' })
    expect(partOf(mousseToUIMessages([generic])[0]!).output).toMatchObject({ interrupted: true, summary: 'No result reported', text: 'half' })
  })

  it('renders a generic item by its tool name, as a row without an item does', () => {
    const generic = row(
      'g',
      { ...activityBase, id: 'g', callId: 'g', toolName: 'read', kind: 'generic', input: { path: 'src/a.ts' }, output: 'file text' },
      { toolCall: { title: 'Tool read', summary: 'ok', details: ['Tool: read'], status: 'complete', toolName: 'read' } }
    )
    expect(partOf(mousseToUIMessages([generic])[0]!)).toMatchObject({
      type: 'tool-Read',
      state: 'output-available',
      input: { path: 'src/a.ts' },
      output: 'file text',
    })
    const mcp = row(
      'm',
      { ...activityBase, id: 'm', callId: 'm', toolName: 'my_tool', kind: 'generic', server: 'myserver', output: 'result' },
      { toolCall: { title: 'Called myserver.my_tool', summary: 'ok', details: ['Server: myserver', 'Tool: my_tool'], status: 'complete', toolName: 'my_tool' } }
    )
    expect(partOf(mousseToUIMessages([mcp])[0]!).type).toBe('tool-mcp__myserver__my_tool')
  })

  it('treats an unknown kind as generic and never throws', () => {
    const future = row(
      'x',
      { ...activityBase, id: 'x', callId: 'x', toolName: 'hologram', kind: 'hologram', beam: 1 } as unknown as AgentActivityItem,
      { toolCall: { title: 'hologram', summary: 'hologram', details: [], status: 'complete', toolName: 'hologram' } }
    )
    expect(partOf(mousseToUIMessages([future])[0]!)).toMatchObject({ type: 'tool-mcp__custom__hologram', state: 'output-available' })
  })

  it('keeps a Mousse delegation on the subagent card path and reads its result from the item', () => {
    const delegation = row(
      'd',
      { ...activityBase, id: 'd', callId: 'd', toolName: 'delegate_task', kind: 'generic', input: { recordVersion: 1, title: 'R' }, output: '{"delegationId":"del-1"}' },
      {
        toolCall: {
          title: 'Called mousse.delegate_task',
          summary: 'ok',
          details: ['Server: mousse', 'Tool: delegate_task'],
          status: 'complete',
          toolName: 'delegate_task',
          input: { recordVersion: 1, title: 'R' },
        },
      }
    )
    expect(partOf(mousseToUIMessages([delegation])[0]!)).toMatchObject({
      type: 'tool-Subagent',
      subagentTool: 'delegate_task',
      output: '{"delegationId":"del-1"}',
    })
  })

  it('folds work a subagent started under its row with the <parent>:<child> id', () => {
    const agent = row('agent-1', { ...activityBase, id: 'agent-1', callId: 'toolu_a', toolName: 'Agent', kind: 'subagent', agentType: 'Explore' })
    const child = row('child-1', { ...activityBase, id: 'child-1', callId: 'toolu_b', parentId: 'agent-1', toolName: 'Bash', kind: 'command', command: 'ls' })
    const grandchild = row('grand-1', { ...activityBase, id: 'grand-1', callId: 'toolu_c', parentId: 'child-1', toolName: 'Read', kind: 'generic' })
    const nestedAgent = row('agent-2', { ...activityBase, id: 'agent-2', callId: 'toolu_d', parentId: 'agent-1', toolName: 'Agent', kind: 'subagent' })
    const deep = row('deep-1', { ...activityBase, id: 'deep-1', callId: 'toolu_e', parentId: 'agent-2', toolName: 'Grep', kind: 'search', scope: 'code', query: 'x' })
    const orphan = row('flat-1', { ...activityBase, id: 'flat-1', callId: 'toolu_f', parentId: 'unknown-message', toolName: 'Bash', kind: 'command', command: 'pwd' })
    const out = mousseToUIMessages([agent, child, grandchild, nestedAgent, deep, orphan])
    expect(out.map((message) => message.id)).toEqual(['agent-1', 'flat-1'])
    expect(out[0]!.parts.map((part) => (part as unknown as { toolCallId: string }).toolCallId)).toEqual([
      'agent-1',
      'agent-1:child-1',
      'agent-1:grand-1',
      'agent-1:agent-2',
      'agent-1:deep-1',
    ])
    expect(partOf(out[0]!, 1).type).toBe('tool-Bash')
    expect(partOf(out[1]!).toolCallId).toBe('flat-1')
  })

  it('renders a row saved before typed items as it did', () => {
    const out = mousseToUIMessages([
      base({
        id: 'old',
        kind: 'build_tool_result',
        toolCall: { title: 'Tool Bash', summary: 'The tool returned an error.', details: ['Tool: Bash'], response: 'boom', status: 'complete', toolName: 'Bash', input: { command: 'foo' } },
      }),
    ])
    expect(partOf(out[0]!)).toMatchObject({ type: 'tool-Bash', state: 'output-error', input: { command: 'foo' }, output: 'boom' })
  })
})

describe('provider events through the assembler into the cards', () => {
  function replay(events: StreamingLlmToolEvent[], closeAs?: 'stop' | 'no_result' | 'daemon_restart') {
    const messages: ChatMessage[] = []
    const state = { activeAssistantMessageId: null, activeThinkingMessageId: null, activeToolCallMessageIds: new Map<string, string>(), callToMessage: new Map<string, string>() }
    const assembler = new TranscriptAssembler(
      {
        getMessage: (id) => messages.find((message) => message.id === id),
        addMessage: (message) => void messages.push(message),
        updateMessage: (message) => {
          const index = messages.findIndex((entry) => entry.id === message.id)
          if (index !== -1) messages[index] = message
        },
        removeMessage: () => {},
        emitAdded: () => {},
        emitUpdated: () => {},
        persist: () => {},
        setPhase: () => {},
      },
      state
    )
    for (const event of events) assembler.tool(event)
    if (closeAs) assembler.closeOpenTools(closeAs)
    return messages
  }
  const event = (phase: 'start' | 'complete', callId: string, toolName: string, extra: Partial<StreamingLlmToolEvent> = {}): StreamingLlmToolEvent => ({
    kind: 'mcp_tool_call',
    phase,
    callId,
    title: toolName,
    summary: toolName,
    details: [],
    ...extra,
    activity: { toolName, ...extra.activity },
  })

  it('nests children under their parent by message id, whatever the provider call ids look like', () => {
    const messages = replay([
      event('start', 'toolu_01ABC', 'Agent', { activity: { kind: 'subagent' } }),
      event('start', 'call_abc', 'Bash', { parentCallId: 'toolu_01ABC', input: { command: 'ls' } }),
      event('complete', 'call_abc', 'Bash', { parentCallId: 'toolu_01ABC' }),
      event('start', 'thr-1:item-2', 'Read', { parentCallId: 'call_abc' }),
      event('complete', 'thr-1:item-2', 'Read'),
      event('complete', 'toolu_01ABC', 'Agent'),
    ])
    const ui = mousseToUIMessages(messages)
    expect(ui).toHaveLength(1)
    const ids = ui[0]!.parts.map((part) => (part as unknown as { toolCallId: string }).toolCallId)
    const [parent, child, grandchild] = messages
    expect(ids).toEqual([parent!.id, `${parent!.id}:${child!.id}`, `${parent!.id}:${grandchild!.id}`])
    for (const id of ids) {
      expect(id).not.toContain('toolu_')
      expect(id).not.toContain('call_abc')
      expect(id).not.toContain('thr-1')
    }
  })

  it('shows a call the turn never closed as interrupted', () => {
    const messages = replay([event('start', 'toolu_01OPEN', 'Bash', { input: { command: 'sleep 99' } })], 'stop')
    const part = partOf(mousseToUIMessages(messages)[0]!)
    expect(getToolStatus(part, 'ready').isInterrupted).toBe(true)
    expect(getToolStatus(part, 'streaming')).toMatchObject({ isInterrupted: true, isPending: false })
    expect(part.output).toMatchObject({ interrupted: true, summary: 'Stopped' })
  })
})

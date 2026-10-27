/**
 * Issue #172: Claude's tool calls become typed activity items. A hand-authored SDK stream
 * (`run/fixtures/activity/claude-subscription.ndjson`) runs through the frame reader on its own, the
 * one-shot query path and the live session (the same `onTool` sequence each time), and the events
 * go through a real `TranscriptAssembler` to show what the saved rows say.
 */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { claudeActivityComplete, claudeActivityStart, claudeCallContext } from '../src/mms/providers/claudeSubscription/claudeActivity'
import { ClaudeMetricsCollector } from '../src/mms/providers/claudeSubscription/metrics'
import { TurnFrames } from '../src/mms/providers/claudeSubscription/turnFrames'
import { TranscriptAssembler, type TranscriptStreamState } from '../src/mms/run/transcript/TranscriptAssembler'
import { runtimeToolEvent } from '../src/mms/run/transcript/promptRuntime'
import type { AgentActivityItem, ProviderToolEvent } from '../src/shared/agentActivity'
import type { ChatMessage } from '../src/shared/types'
import { FakeClaudeCli, SESSION, resultFrame, type Frame } from './run/fakeClaudeCli'

const FIXTURE = join(__dirname, 'run', 'fixtures', 'activity', 'claude-subscription.ndjson')

/** The SDK messages of the fixture's turn (the `in` frames, without its result). */
function fixtureFrames(): Frame[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { dir?: string; frame?: Frame })
    .filter((entry) => entry.dir === 'in' && entry.frame && entry.frame.type !== 'result')
    .map((entry) => entry.frame!)
}

function frameReader(events: ProviderToolEvent[]): TurnFrames {
  return new TurnFrames({ onText: () => undefined, onTool: (event) => events.push(event) }, new ClaudeMetricsCollector())
}

function readFrames(frames: Frame[], closeAs?: 'stop' | 'no_result'): ProviderToolEvent[] {
  const events: ProviderToolEvent[] = []
  const reader = frameReader(events)
  for (const frame of frames) reader.observe(frame as unknown as SDKMessage)
  if (closeAs) reader.closeTools(closeAs)
  return events
}

const of = (events: ProviderToolEvent[], callId: string) => events.filter((event) => event.callId === callId)
const completeOf = (events: ProviderToolEvent[], callId: string) => of(events, callId).find((event) => event.phase === 'complete')
const lastStartOf = (events: ProviderToolEvent[], callId: string) => of(events, callId).filter((event) => event.phase === 'start').at(-1)

/** The saved rows of a run of events, through a real assembler. */
function saved(events: ProviderToolEvent[]): { rows: ChatMessage[]; byCall: (callId: string) => AgentActivityItem } {
  const rows: ChatMessage[] = []
  const state: TranscriptStreamState = {
    activeAssistantMessageId: null,
    activeThinkingMessageId: null,
    activeToolCallMessageIds: new Map(),
    callToMessage: new Map()
  }
  const assembler = new TranscriptAssembler(
    {
      getMessage: (id) => rows.find((row) => row.id === id),
      addMessage: (row) => void rows.push(row),
      updateMessage: (row) => {
        const index = rows.findIndex((entry) => entry.id === row.id)
        if (index !== -1) rows[index] = row
      },
      removeMessage: () => undefined,
      emitAdded: () => undefined,
      emitUpdated: () => undefined,
      persist: () => undefined,
      setPhase: () => undefined
    },
    state
  )
  for (const event of events) assembler.tool(runtimeToolEvent(event))
  return {
    rows,
    byCall: (callId) => {
      const row = rows.find((entry) => entry.activity?.callId === callId)
      if (!row?.activity) throw new Error(`no item for ${callId}`)
      return row.activity
    }
  }
}

const complete = (name: string, input: unknown, structured: unknown, text: string, isError = false) =>
  claudeActivityComplete(claudeCallContext(name, input, true), structured, text, isError)

describe('claudeActivityStart and claudeActivityComplete', () => {
  it('types each tool from its arguments, and a call with unusable arguments is generic', () => {
    expect(claudeActivityStart('Bash', { command: 'ls' }, true)).toEqual({ kind: 'command', command: 'ls' })
    expect(claudeActivityStart('Bash', { cmd: 'ls' }, true)).toMatchObject({ kind: 'generic' })
    expect(claudeActivityStart('Glob', { pattern: '*.ts' }, true)).toEqual({ kind: 'search', scope: 'files', query: '*.ts' })
    expect(claudeActivityStart('WebFetch', { url: 'https://a.test' }, true)).toEqual({ kind: 'web_search', query: 'https://a.test' })
    expect(claudeActivityStart('ExitPlanMode', { plan: '# Plan' }, true)).toEqual({ kind: 'plan', text: '# Plan' })
    expect(claudeActivityStart('mcp__srv__tool', { a: 1 }, true)).toEqual({ kind: 'generic', server: 'srv', input: { a: 1 } })
    // Nothing is typed before the arguments are in, except a subagent call.
    expect(claudeActivityStart('Bash', undefined, true)).toBeUndefined()
    expect(claudeActivityStart('Agent', undefined, true)).toEqual({ kind: 'subagent' })
    // A Mousse delegation keeps its bounded record, not typed fields.
    expect(claudeActivityStart('mcp__mousse__delegate_task', { title: 'x', prompt: 'p' }, true)).toBeUndefined()
    expect(claudeActivityComplete(claudeCallContext('mcp__mousse__delegate_task', {}, true), undefined, 'x', false)).toEqual({ handedOff: false })
  })

  it('caps a generic call arguments and never keeps a huge one whole', () => {
    const patch = claudeActivityStart('mcp__srv__tool', { blob: 'x'.repeat(100_000) }, true)
    expect(JSON.stringify(patch).length).toBeLessThan(20_000)
  })

  it('reads a legacy JSON Bash result and a result that has only text', () => {
    expect(complete('Bash', { command: 'x' }, undefined, JSON.stringify({ stdout: 'out', stderr: 'err' })).activity).toMatchObject({ output: 'out\nerr' })
    expect(complete('Bash', { command: 'x' }, undefined, 'plain').activity).toMatchObject({ output: 'plain' })
  })

  it('a Bash result the user interrupted is interrupted, not done', () => {
    const completion = complete('Bash', { command: 'x' }, { stdout: 'partial', stderr: '', interrupted: true }, 'partial')
    expect(completion.activity).toMatchObject({ output: 'partial', status: 'interrupted', interruptedBy: 'stop' })
  })

  it('a backgrounded command says so and keeps its task id', () => {
    const completion = complete('Bash', { command: 'x', run_in_background: true }, { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, 'started')
    expect(completion.activity).toMatchObject({ nativeId: 'b1', summary: 'Running in the background' })
  })

  it('uses a structured result only when it answers one call', () => {
    const frames: Frame[] = [
      { type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'a', name: 'Bash' } } },
      { type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'b', name: 'Bash' } } },
      {
        type: 'user',
        session_id: SESSION,
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'first' }, { type: 'tool_result', tool_use_id: 'b', content: 'second' }] },
        tool_use_result: { stdout: 'WRONG', stderr: '', interrupted: false }
      }
    ]
    const events = readFrames(frames)
    expect(completeOf(events, 'a')?.activity).toMatchObject({ output: 'first' })
    expect(completeOf(events, 'b')?.activity).toMatchObject({ output: 'second' })
  })
})

describe('the activity fixture through the frame reader', () => {
  const events = readFrames(fixtureFrames(), 'no_result')

  it('commands: the command on start, stdout and stderr (or the text blocks) on completion', () => {
    expect(lastStartOf(events, 'bash1')?.activity).toEqual({ kind: 'command', command: 'npm test' })
    expect(completeOf(events, 'bash1')?.activity).toEqual({ kind: 'command', output: 'ok\nwarn\n' })
    // No tool_use_result: the content blocks are the output.
    expect(completeOf(events, 'bash2')?.activity).toEqual({ kind: 'command', output: 'a.ts\nb.ts\n' })
  })

  it('edits: the diff and counts come from the result patch, and a failed edit keeps its error', () => {
    const edit = completeOf(events, 'edit1')?.activity as { changes: Array<Record<string, unknown>> }
    expect(edit.changes).toHaveLength(1)
    expect(edit.changes[0]).toMatchObject({ path: '/w/a.ts', change: 'update', added: 1, removed: 1 })
    expect(edit.changes[0]!.diff).toContain('@@ -1,3 +1,3 @@')
    expect(edit.changes[0]!.diff).toContain('-a\n+b\n')
    const failed = completeOf(events, 'edit2')?.activity
    expect(failed).toMatchObject({ status: 'failed', kind: 'file_change', changes: [{ path: '/w/a.ts', change: 'update', error: 'String to replace not found in file.' }] })
    expect(JSON.stringify(failed)).not.toContain('"diff"')
  })

  it('writes: create is an add, an update with a patch keeps its removals, an unknown prior is not a diff', () => {
    const changeOf = (callId: string) => (completeOf(events, callId)?.activity as { changes: Array<Record<string, unknown>> }).changes[0]!
    expect(changeOf('write1')).toMatchObject({ path: '/w/new.ts', change: 'add', added: 2, removed: 0 })
    expect(changeOf('write2')).toMatchObject({ change: 'update', added: 1, removed: 2 })
    expect(changeOf('write2')!.diff).toContain('-old1\n-old2\n+new1')
    const unknown = changeOf('write3')
    expect(unknown).toEqual({ path: '/w/huge.ts', change: 'update', diffUnavailable: true, linesWritten: 3 })
  })

  it('searches: the pattern on start, the count and text on completion', () => {
    expect(lastStartOf(events, 'grep1')?.activity).toEqual({ kind: 'search', scope: 'code', query: 'foo', path: 'src' })
    expect(completeOf(events, 'grep1')?.activity).toEqual({ kind: 'search', output: 'Found 2 files\na.ts\nb.ts', resultCount: 2 })
  })

  it('to-dos: each root list is its own item, an empty one clears, a subagent list is a nested generic row', () => {
    const items = (callId: string) => (completeOf(events, callId)?.activity as { items?: unknown[] }).items
    expect(items('todo1')).toEqual([{ content: 'Write tests', status: 'pending' }, { content: 'Ship', status: 'pending' }])
    expect(items('todo2')).toEqual([{ content: 'Write tests', status: 'completed' }, { content: 'Ship', status: 'in_progress' }])
    expect(items('todo3')).toEqual([])
    expect(lastStartOf(events, 'todo4')?.activity).toMatchObject({ kind: 'generic' })
    expect(lastStartOf(events, 'todo4')?.parentCallId).toBe('agent1')
  })

  it('subagents: nested calls name their parent, two levels deep, and the prompt is never carried', () => {
    expect(of(events, 'read1')[0]?.parentCallId).toBe('agent1')
    expect(of(events, 'agent2')[0]?.parentCallId).toBe('agent1')
    expect(of(events, 'read2')[0]?.parentCallId).toBe('agent2')
    expect(of(events, 'bash3').filter((event) => event.phase === 'start').every((event) => event.parentCallId === 'agent1')).toBe(true)
    expect(lastStartOf(events, 'agent1')?.activity).toEqual({ kind: 'subagent', agentType: 'Explore', description: 'Explore the repo' })
    expect(completeOf(events, 'agent1')?.activity).toMatchObject({ kind: 'subagent', durationMs: 4200, agentType: 'Explore', nativeId: 'a1' })
    expect(JSON.stringify(events)).not.toContain('PROMPT TEXT')
  })

  it('a call with no result on a settled turn closes interrupted as no_result, a nested one too', () => {
    for (const callId of ['glob1', 'agent3', 'bash4']) {
      expect(completeOf(events, callId)?.activity).toEqual({ status: 'interrupted', interruptedBy: 'no_result', summary: 'No result reported' })
    }
    // Calls that returned are not touched again.
    expect(of(events, 'bash1').filter((event) => event.phase === 'complete')).toHaveLength(1)
  })

  it('the saved rows: nesting by message id and the closing status of each call', () => {
    const { byCall, rows } = saved(events)
    expect(byCall('bash1')).toMatchObject({ kind: 'command', status: 'done', output: 'ok\nwarn\n' })
    expect(byCall('edit2')).toMatchObject({ kind: 'file_change', status: 'failed' })
    expect(byCall('write3')).toMatchObject({ status: 'done', changes: [{ diffUnavailable: true }] })
    expect(byCall('read1').parentId).toBe(byCall('agent1').id)
    expect(byCall('agent2').parentId).toBe(byCall('agent1').id)
    expect(byCall('read2').parentId).toBe(byCall('agent2').id)
    expect(byCall('agent1')).toMatchObject({ kind: 'subagent', status: 'done', durationMs: 4200 })
    expect(byCall('glob1')).toMatchObject({ status: 'interrupted', interruptedBy: 'no_result' })
    expect(byCall('agent3')).toMatchObject({ status: 'interrupted', interruptedBy: 'no_result' })
    expect(byCall('bash4')).toMatchObject({ status: 'interrupted', interruptedBy: 'no_result', parentId: byCall('agent3').id })
    // The prompts are in no saved row.
    expect(JSON.stringify(rows)).not.toContain('PROMPT TEXT')
  })
})

describe('background agents, plans and stopped turns', () => {
  const stream = (id: string, name: string, parent: string | null = null): Frame => ({
    type: 'stream_event', session_id: SESSION, parent_tool_use_id: parent, event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name } }
  })
  const assistant = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null): Frame => ({
    type: 'assistant', session_id: SESSION, parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] }
  })
  const answer = (id: string, content: unknown, structured?: unknown): Frame => ({
    type: 'user', session_id: SESSION, parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
    ...(structured !== undefined ? { tool_use_result: structured } : {})
  })
  const started: Frame = { type: 'system', subtype: 'task_started', session_id: SESSION, task_id: 't9', tool_use_id: 'bg', description: 'Background', is_backgrounded: true }
  const notify = (status: string): Frame => ({
    type: 'system', subtype: 'task_notification', session_id: SESSION, task_id: 't9', tool_use_id: 'bg', status, summary: `Agent "Background" ${status}`, output_file: '', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 7000 }
  })
  const launch = [
    stream('bg', 'Agent'),
    assistant('bg', 'Agent', { description: 'Background', subagent_type: 'general', run_in_background: true, prompt: 'p' }),
    started,
    answer('bg', 'Async agent launched', { status: 'async_launched', agentId: 't9', description: 'Background', prompt: 'p', outputFile: '/tmp/x' })
  ]

  it('a backgrounded agent stays open through its launch placeholder and a notification in the same turn closes it with the summary', () => {
    const events = readFrames([...launch, notify('completed')])
    expect(of(events, 'bg').map((event) => event.phase)).toEqual(['start', 'start', 'update', 'update', 'complete'])
    expect(of(events, 'bg')[2]?.activity).toEqual({ kind: 'subagent', nativeId: 't9', background: true })
    expect(completeOf(events, 'bg')?.activity).toEqual({ status: 'done', summary: 'Agent "Background" completed', durationMs: 7000 })
    expect(saved(events).byCall('bg')).toMatchObject({ kind: 'subagent', status: 'done', background: true, nativeId: 't9', durationMs: 7000, summary: 'Agent "Background" completed' })
  })

  it('a failed or stopped notification closes the row failed or interrupted', () => {
    expect(saved(readFrames([...launch, notify('failed')])).byCall('bg')).toMatchObject({ status: 'failed' })
    expect(saved(readFrames([...launch, notify('stopped')])).byCall('bg')).toMatchObject({ status: 'interrupted', interruptedBy: 'stop' })
  })

  it('left open when the turn settles, it is done in the background; nothing closes it twice', () => {
    const reader: ProviderToolEvent[] = []
    const frames = frameReader(reader)
    for (const frame of launch) frames.observe(frame as unknown as SDKMessage)
    frames.closeTools('no_result')
    const settledCount = reader.length
    // The notification arrives after the turn settled: it belongs to the continuation, and nothing throws.
    expect(() => frames.observe(notify('completed') as unknown as SDKMessage)).not.toThrow()
    expect(reader).toHaveLength(settledCount)
    expect(saved(reader).byCall('bg')).toMatchObject({ kind: 'subagent', status: 'done', background: true, summary: 'Running in the background' })
  })

  it('stopping the turn interrupts a backgrounded agent and an open plan, and a running child with its parent', () => {
    const events = readFrames(
      [
        ...launch,
        stream('plan', 'ExitPlanMode'),
        assistant('plan', 'ExitPlanMode', { plan: '# The plan' }),
        stream('parent', 'Agent'),
        assistant('parent', 'Agent', { description: 'Parent', prompt: 'p' }),
        stream('child', 'Bash', 'parent'),
        assistant('child', 'Bash', { command: 'sleep 99' }, 'parent')
      ],
      'stop'
    )
    const { byCall } = saved(events)
    for (const callId of ['bg', 'plan', 'parent', 'child']) {
      expect(byCall(callId)).toMatchObject({ status: 'interrupted', interruptedBy: 'stop', summary: 'Stopped' })
    }
    expect(byCall('child').parentId).toBe(byCall('parent').id)
  })

  it('an open plan on a settled turn is done', () => {
    const events = readFrames([stream('plan', 'ExitPlanMode'), assistant('plan', 'ExitPlanMode', { plan: '# The plan' })], 'no_result')
    expect(saved(events).byCall('plan')).toMatchObject({ kind: 'plan', status: 'done' })
  })
})

describe('the provider service', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), 'claude-activity-test-'))
    homes.push(dir)
    const binary = join(dir, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    mkdirSync(join(dir, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(dir, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    return dir
  }
  const runAuth = vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
  const expected = () => readFrames(fixtureFrames(), 'no_result')

  it('the one-shot path emits the sequence the frame reader does', async () => {
    const dir = home()
    const frames = [...fixtureFrames(), resultFrame({ text: 'Done' })]
    const query = () => {
      const generator = (async function* () {
        for (const frame of frames) yield frame as unknown as SDKMessage
      })()
      return Object.assign(generator, { close: vi.fn(), interrupt: vi.fn(async () => undefined), supportedModels: vi.fn(async () => []) }) as unknown as Query
    }
    const service = new ClaudeSubscriptionProviderService(dir, new UserQuestionService(), { query, runAuth, live: false })
    const events: ProviderToolEvent[] = []
    await service.chat({ threadId: 'thread', cwd: dir, model: 'sonnet', prompt: 'go', onText: vi.fn(), onTool: (event) => events.push(event) })
    expect(events).toEqual(expected())
  })

  it('the live path emits the same sequence, and task frames after the turn settled change nothing', async () => {
    const dir = home()
    const cli = new FakeClaudeCli()
    const frames = fixtureFrames()
    cli.reply = (message, process) => {
      const uuid = String(message.uuid)
      // The first frame of a turn names the message it answers.
      process.emit({ ...frames[0]!, user_message_uuid: uuid, user_message_uuids: [uuid] }, ...frames.slice(1), resultFrame({ uuids: [uuid], text: 'Done' }))
    }
    const service = new ClaudeSubscriptionProviderService(dir, new UserQuestionService(), { query: cli.query, runAuth, live: { noticeDelayMs: 10 } })
    const events: ProviderToolEvent[] = []
    await service.chat({ threadId: 'thread', cwd: dir, model: 'sonnet', prompt: 'go', onText: vi.fn(), onTool: (event) => events.push(event) })
    expect(events).toEqual(expected())
    const settled = events.length
    cli.last.emit(
      { type: 'system', subtype: 'task_started', session_id: SESSION, task_id: 't1', tool_use_id: 'agent3', is_backgrounded: true, description: 'late' },
      { type: 'system', subtype: 'task_notification', session_id: SESSION, task_id: 't1', tool_use_id: 'agent3', status: 'completed', summary: 'late', output_file: '' }
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(events).toHaveLength(settled)
  })

  it('the live path shows a task frame on the row of the turn that is running', async () => {
    const dir = home()
    const cli = new FakeClaudeCli()
    const bg: Frame[] = [
      { type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'bg', name: 'Agent' } } },
      { type: 'assistant', session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'bg', name: 'Agent', input: { description: 'Background', run_in_background: true } }] } },
      { type: 'system', subtype: 'task_started', session_id: SESSION, task_id: 't9', tool_use_id: 'bg', is_backgrounded: true, description: 'Background' },
      { type: 'user', session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'bg', content: 'launched' }] }, tool_use_result: { status: 'async_launched', agentId: 't9' } },
      { type: 'system', subtype: 'task_notification', session_id: SESSION, task_id: 't9', tool_use_id: 'bg', status: 'completed', summary: 'Background finished', output_file: '' }
    ]
    cli.reply = (message, process) => {
      const uuid = String(message.uuid)
      process.emit({ ...bg[0]!, user_message_uuid: uuid, user_message_uuids: [uuid] }, ...bg.slice(1), resultFrame({ uuids: [uuid], text: 'Done' }))
    }
    const service = new ClaudeSubscriptionProviderService(dir, new UserQuestionService(), { query: cli.query, runAuth, live: { noticeDelayMs: 10 } })
    const events: ProviderToolEvent[] = []
    await service.chat({ threadId: 'thread', cwd: dir, model: 'sonnet', prompt: 'go', onText: vi.fn(), onTool: (event) => events.push(event) })
    expect(events).toEqual(readFrames(bg, 'no_result'))
    expect(completeOf(events, 'bg')?.activity).toMatchObject({ status: 'done', summary: 'Background finished' })
  })

  it('a task frame that reaches a later turn on the same process changes nothing in it', async () => {
    const dir = home()
    const cli = new FakeClaudeCli()
    const launch: Frame[] = [
      { type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'bg', name: 'Agent' } } },
      { type: 'assistant', session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'bg', name: 'Agent', input: { description: 'Worker', run_in_background: true } }] } },
      { type: 'user', session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'bg', content: 'launched' }] }, tool_use_result: { status: 'async_launched', agentId: 't9' } }
    ]
    cli.reply = (message, process) => {
      const uuid = String(message.uuid)
      process.emit({ ...launch[0]!, user_message_uuid: uuid, user_message_uuids: [uuid] }, ...launch.slice(1), resultFrame({ uuids: [uuid], text: 'Done' }))
    }
    const service = new ClaudeSubscriptionProviderService(dir, new UserQuestionService(), { query: cli.query, runAuth, live: { noticeDelayMs: 10 } })
    const chat = (onTool: (event: ProviderToolEvent) => void) =>
      service.chat({ threadId: 'thread', cwd: dir, model: 'sonnet', prompt: 'go', history: '', onText: vi.fn(), onTool })
    const first: ProviderToolEvent[] = []
    await chat((event) => first.push(event))
    service.commitConversation('thread', '')
    expect(saved(first).byCall('bg')).toMatchObject({ status: 'done', background: true })
    // The next turn is running when the earlier agent's task frames and calls arrive.
    cli.reply = (message, process) => {
      const uuid = String(message.uuid)
      process.emit(
        { type: 'system', subtype: 'task_started', session_id: SESSION, task_id: 't9', tool_use_id: 'bg', is_backgrounded: true, description: 'Worker', user_message_uuid: uuid, user_message_uuids: [uuid] },
        { type: 'assistant', session_id: SESSION, parent_tool_use_id: 'bg', message: { content: [{ type: 'tool_use', id: 'late', name: 'Read', input: { file_path: '/w/a.ts' } }] } },
        { type: 'system', subtype: 'task_notification', session_id: SESSION, task_id: 't9', tool_use_id: 'bg', status: 'completed', summary: 'Worker finished', output_file: '' },
        resultFrame({ uuids: [uuid], text: 'Second' })
      )
    }
    const second: ProviderToolEvent[] = []
    await chat((event) => second.push(event))
    expect(second).toEqual([])
  })

  it('a stopped turn closes its open calls as stop', async () => {
    const dir = home()
    let release: (() => void) | undefined
    const query = () => {
      const generator = (async function* () {
        yield { type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'open', name: 'Bash' } } } as unknown as SDKMessage
        await new Promise<void>((resolve) => {
          release = resolve
        })
      })()
      const unblock = () => release?.()
      return Object.assign(generator, { close: vi.fn(unblock), interrupt: vi.fn(async () => unblock()), supportedModels: vi.fn(async () => []) }) as unknown as Query
    }
    const service = new ClaudeSubscriptionProviderService(dir, new UserQuestionService(), { query, runAuth, live: false })
    const events: ProviderToolEvent[] = []
    const abort = new AbortController()
    const turn = service.chat({ threadId: 'thread', cwd: dir, model: 'sonnet', prompt: 'go', signal: abort.signal, onText: vi.fn(), onTool: (event) => events.push(event) })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    abort.abort()
    await expect(turn).rejects.toThrow()
    expect(completeOf(events, 'open')?.activity).toEqual({ status: 'interrupted', interruptedBy: 'stop', summary: 'Stopped' })
  })
})

describe('what the frame reader keeps of a call', () => {
  const stream = (id: string, name: string, parent: string | null = null): Frame => ({
    type: 'stream_event', session_id: SESSION, parent_tool_use_id: parent, event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name } }
  })
  const assistant = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null): Frame => ({
    type: 'assistant', session_id: SESSION, parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] }
  })
  const answer = (id: string, content: unknown, structured?: unknown, isError = false, parent: string | null = null): Frame => ({
    type: 'user', session_id: SESSION, parent_tool_use_id: parent,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
    ...(structured !== undefined ? { tool_use_result: structured } : {})
  })
  const system = (subtype: string, extra: Record<string, unknown>): Frame => ({ type: 'system', subtype, session_id: SESSION, ...extra })
  const big = 'line of code\n'.repeat(3000)

  it('a foreground command that ran long reports its task end before its result, and the result still settles the row', () => {
    const events = readFrames([
      stream('long', 'Bash'),
      assistant('long', 'Bash', { command: 'npm test' }),
      system('task_started', { task_id: 'b1', tool_use_id: 'long', description: 'Run tests', is_backgrounded: false }),
      system('task_notification', { task_id: 'b1', tool_use_id: 'long', status: 'completed', summary: 'Run tests', output_file: '' }),
      answer('long', 'out', { stdout: 'all green\n', stderr: '', interrupted: false })
    ])
    expect(of(events, 'long').map((event) => event.phase)).toEqual(['start', 'start', 'update', 'complete'])
    expect(completeOf(events, 'long')?.activity).toEqual({ kind: 'command', output: 'all green\n' })
    expect(saved(events).byCall('long')).toMatchObject({ kind: 'command', status: 'done', output: 'all green\n', nativeId: 'b1' })
  })

  it('a failed foreground command is failed by its result, not by the task end', () => {
    const events = readFrames([
      stream('long', 'Bash'),
      assistant('long', 'Bash', { command: 'npm test' }),
      system('task_started', { task_id: 'b1', tool_use_id: 'long', description: 'Run tests', is_backgrounded: false }),
      system('task_notification', { task_id: 'b1', tool_use_id: 'long', status: 'failed', summary: 'Run tests', output_file: '' }),
      answer('long', 'Exit code 1\nfailing test', undefined, true)
    ])
    expect(saved(events).byCall('long')).toMatchObject({ status: 'failed', output: 'Exit code 1\nfailing test' })
  })

  it('a foreground agent keeps its result the same way, with the notification before it', () => {
    const events = readFrames([
      stream('fg', 'Agent'),
      assistant('fg', 'Agent', { description: 'Look around', subagent_type: 'Explore', prompt: 'p' }),
      system('task_started', { task_id: 'a1', tool_use_id: 'fg', description: 'Look around', is_backgrounded: false }),
      system('task_notification', { task_id: 'a1', tool_use_id: 'fg', status: 'completed', summary: 'Agent "Look around" completed', output_file: '', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 5000 } }),
      answer('fg', [{ type: 'text', text: 'report' }], { status: 'completed', agentId: 'a1', agentType: 'Explore', totalDurationMs: 4800, content: [], prompt: 'p' })
    ])
    expect(saved(events).byCall('fg')).toMatchObject({ kind: 'subagent', status: 'done', durationMs: 4800, agentType: 'Explore' })
    expect(saved(events).byCall('fg').summary).toBeUndefined()
  })

  it('a background agent whose end comes before its launch placeholder still ends once the placeholder says it was handed off', () => {
    const events = readFrames([
      stream('bg', 'Agent'),
      assistant('bg', 'Agent', { description: 'Quick job', run_in_background: true, prompt: 'p' }),
      system('task_notification', { task_id: 't1', tool_use_id: 'bg', status: 'completed', summary: 'Quick job done', output_file: '' }),
      answer('bg', 'launched', { status: 'async_launched', agentId: 't1', prompt: 'p', outputFile: '/tmp/x' })
    ])
    expect(saved(events).byCall('bg')).toMatchObject({ status: 'done', summary: 'Quick job done', background: true })
  })

  it('a Write above the argument cap is still a file change from its result', () => {
    const content = big.repeat(2)
    expect(content.length).toBeGreaterThan(60_000)
    const events = readFrames([
      stream('w', 'Write'),
      assistant('w', 'Write', { file_path: '/w/big.ts', content }),
      answer('w', 'File created', { type: 'create', filePath: '/w/big.ts', content, structuredPatch: [], originalFile: null })
    ])
    expect(completeOf(events, 'w')?.activity).toMatchObject({ kind: 'file_change', changes: [{ path: '/w/big.ts', change: 'add', diffTruncated: true, added: 6000 }] })
    const item = saved(events).byCall('w')
    expect(item).toMatchObject({ kind: 'file_change', status: 'done', changes: [{ path: '/w/big.ts', change: 'add' }] })
    expect(JSON.stringify(item).length).toBeLessThan(100_000)
  })

  it('an Edit above the argument cap keeps its patch, and a failed one keeps its error and no diff', () => {
    const oldString = big
    const newString = big.replace('line', 'LINE')
    const input = { file_path: '/w/big.ts', old_string: oldString, new_string: newString }
    const patch = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-line of code', '+LINE of code', ' line of code'] }]
    const done = saved(readFrames([stream('e', 'Edit'), assistant('e', 'Edit', input), answer('e', 'updated', { filePath: '/w/big.ts', oldString, newString, originalFile: null, structuredPatch: patch })]))
    expect(done.byCall('e')).toMatchObject({ kind: 'file_change', status: 'done', changes: [{ path: '/w/big.ts', change: 'update', added: 1, removed: 1 }] })
    const failed = saved(readFrames([stream('f', 'Edit'), assistant('f', 'Edit', input), answer('f', 'String not found', undefined, true)])).byCall('f')
    expect(failed).toMatchObject({ kind: 'file_change', status: 'failed', changes: [{ path: '/w/big.ts', error: 'String not found' }] })
    expect(JSON.stringify(failed)).not.toContain('"diff"')
  })

  it('a long command and a long plan keep their kind through completion, and a Mousse delegation keeps its record', () => {
    const command = `cat > f <<'EOF'\n${big}EOF`
    const bash = saved(readFrames([stream('c', 'Bash'), assistant('c', 'Bash', { command }), answer('c', 'ok', { stdout: 'ok', stderr: '', interrupted: false })]))
    expect(bash.byCall('c')).toMatchObject({ kind: 'command', status: 'done', output: 'ok' })
    const plan = saved(readFrames([stream('p', 'ExitPlanMode'), assistant('p', 'ExitPlanMode', { plan: big }), answer('p', 'approved')]))
    expect(plan.byCall('p')).toMatchObject({ kind: 'plan', status: 'done' })
    const events = readFrames([
      stream('d', 'mcp__mousse__delegate_task'),
      assistant('d', 'mcp__mousse__delegate_task', { title: 'Reviewer', prompt: big + big }),
      answer('d', JSON.stringify({ started: true, delegationId: 'd-1', title: 'Reviewer' }))
    ])
    expect(completeOf(events, 'd')?.record?.input).toEqual({ recordVersion: 1, title: 'Reviewer' })
  })

  it('a call a background agent of an earlier turn makes opens nothing in this turn', () => {
    const events = readFrames([
      assistant('child', 'Read', { file_path: '/w/a.ts' }, 'agentFromLastTurn'),
      stream('child2', 'Bash', 'agentFromLastTurn'),
      assistant('child2', 'Bash', { command: 'ls' }, 'agentFromLastTurn'),
      answer('child2', 'out', { stdout: 'out', stderr: '', interrupted: false }, false, 'agentFromLastTurn')
    ], 'no_result')
    expect(events).toEqual([])
  })

  it('a call made under an agent this turn has open nests under it even when it streamed no start', () => {
    const events = readFrames([
      stream('bg', 'Agent'),
      assistant('bg', 'Agent', { description: 'Worker', run_in_background: true, prompt: 'p' }),
      answer('bg', 'launched', { status: 'async_launched', agentId: 't1', prompt: 'p', outputFile: '/tmp/x' }),
      assistant('inner', 'Read', { file_path: '/w/a.ts' }, 'bg'),
      answer('inner', 'contents', undefined, false, 'bg')
    ], 'no_result')
    expect(of(events, 'inner')[0]?.parentCallId).toBe('bg')
    const { byCall } = saved(events)
    expect(byCall('inner')).toMatchObject({ status: 'done', parentId: byCall('bg').id })
  })

  it('a detached web call is not left running, and a Read keeps no file contents', () => {
    const events = readFrames([
      stream('web', 'WebFetch'),
      assistant('web', 'WebFetch', { url: 'https://a.test', prompt: 'x' }),
      answer('web', 'stepped aside', { detachedToolCall: true }),
      stream('read', 'Read'),
      assistant('read', 'Read', { file_path: '/w/a.ts' }),
      answer('read', 'FILE CONTENTS')
    ])
    expect(saved(events).byCall('web')).toMatchObject({ kind: 'web_search', status: 'interrupted', interruptedBy: 'no_result', summary: 'Still running; the result comes in a later turn' })
    expect(JSON.stringify(saved(events).byCall('read'))).not.toContain('FILE CONTENTS')
  })

  it('a MultiEdit has no diff until its result brings a patch', () => {
    const patch = claudeActivityStart('MultiEdit', { file_path: '/w/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }, true)
    expect(patch).toEqual({ kind: 'file_change', changes: [{ path: '/w/a.ts', change: 'update', diffUnavailable: true }] })
  })
})
